#include "ts6dsp.h"
#include <math.h>
#include <stdatomic.h>
#include <stdlib.h>
#include <string.h>

#define MAX_CH 16
#define MAX_LOOKAHEAD_MS 20.0f
#define LEVELER_MIN_DB (-12.0f) /* ponytail: max cut fixed, not exposed */
#define DB2LOG2 0.16609640474f  /* dB -> log2 of amplitude */

struct ts6dsp {
    int sr, ch, D, L;           /* D = latency frames, L = D+1 = limiter window */
    /* params: written by control thread (seqlock), copied to p at block boundary */
    ts6dsp_params pend;
    atomic_uint seq;
    unsigned applied;
    ts6dsp_params p;
    /* derived coefficients */
    float a_ms, a_lu, a_ld, a_att, a_rel, a_mk, a_lrel, a_mix, dec_env;
    float ceil_lin, mix_t;
    /* state */
    float ms, lg, env, gr, mk, lr, mix;
    /* delay lines (raw and post-gain), ring of L frames */
    float *xd, *yd;
    int dpos;
    /* sliding min over gain, box average of it */
    float *dq_v; uint64_t *dq_i; int dq_cap, dq_head, dq_cnt;
    float *mnr; double msum; int mpos;
    uint64_t n;
    _Atomic float m_in, m_gr, m_lg;
};

static float clampf(float v, float lo, float hi) { return !(v >= lo) ? lo : v > hi ? hi : v; }

void ts6dsp_default_params(ts6dsp_params *p) {
    ts6dsp_params d = { 1, -20.f, 12.f, -50.f, -24.f, 3.f, 6.f, 5.f, 150.f, 4.f, 5.f, -1.f };
    *p = d;
}

static void sanitize(ts6dsp_params *p) {
    p->enabled = p->enabled != 0;
    p->target_db = clampf(p->target_db, -40, 0);
    p->max_gain_db = clampf(p->max_gain_db, 0, 24);
    p->gate_db = clampf(p->gate_db, -90, -20);
    p->threshold_db = clampf(p->threshold_db, -60, 0);
    p->ratio = clampf(p->ratio, 1, 20);
    p->knee_db = clampf(p->knee_db, 0, 24);
    p->attack_ms = clampf(p->attack_ms, 0.1f, 200);
    p->release_ms = clampf(p->release_ms, 5, 2000);
    p->makeup_db = clampf(p->makeup_db, -12, 24);
    p->lookahead_ms = clampf(p->lookahead_ms, 0, MAX_LOOKAHEAD_MS);
    p->ceiling_db = clampf(p->ceiling_db, -24, 0);
}

/* one-pole coefficient for time constant tau seconds */
static float coef(float tau, int sr) { return 1.0f - expf(-1.0f / (tau * (float)sr)); }

static void derive(ts6dsp *s) {
    const ts6dsp_params *p = &s->p;
    int sr = s->sr;
    s->a_ms = coef(0.3f, sr);           /* leveler RMS window */
    s->a_lu = coef(1.5f, sr);           /* leveler boost: slow */
    s->a_ld = coef(0.3f, sr);           /* leveler cut: faster */
    s->a_att = coef(p->attack_ms * 1e-3f, sr);
    s->a_rel = coef(p->release_ms * 1e-3f, sr);
    s->a_mk = coef(0.01f, sr);
    s->a_lrel = coef(0.05f, sr);        /* ponytail: limiter release fixed 50 ms, not exposed */
    s->a_mix = coef(0.01f, sr);
    s->dec_env = expf(-1.0f / (0.01f * (float)sr)); /* compressor detector decay 10 ms */
    s->ceil_lin = powf(10.0f, p->ceiling_db * 0.05f);
    s->mix_t = p->enabled ? 1.0f : 0.0f;
}

ts6dsp *ts6dsp_create(int sr, int ch, const ts6dsp_params *pp) {
    if (sr < 8000 || sr > 384000 || ch < 1 || ch > MAX_CH) return NULL;
    ts6dsp *s = calloc(1, sizeof *s);
    if (!s) return NULL;
    ts6dsp_params p;
    if (pp) p = *pp; else ts6dsp_default_params(&p);
    sanitize(&p);
    s->sr = sr; s->ch = ch;
    s->D = (int)lroundf(p.lookahead_ms * 1e-3f * (float)sr);
    s->L = s->D + 1;
    s->p = s->pend = p;
    s->dq_cap = s->L + 1;
    s->xd = calloc((size_t)s->L * (size_t)ch, sizeof(float));
    s->yd = calloc((size_t)s->L * (size_t)ch, sizeof(float));
    s->dq_v = calloc((size_t)s->dq_cap, sizeof(float));
    s->dq_i = calloc((size_t)s->dq_cap, sizeof(uint64_t));
    s->mnr = malloc((size_t)s->L * sizeof(float));
    if (!s->xd || !s->yd || !s->dq_v || !s->dq_i || !s->mnr) { ts6dsp_destroy(s); return NULL; }
    for (int i = 0; i < s->L; i++) s->mnr[i] = 1.0f;
    s->msum = s->L;
    s->ms = 1e-20f; s->lr = 1.0f;
    s->mk = p.makeup_db; s->mix = s->mix_t = p.enabled ? 1.0f : 0.0f;
    derive(s);
    s->mix = s->mix_t;
    atomic_init(&s->seq, 0);
    atomic_init(&s->m_in, -120.f); atomic_init(&s->m_gr, 0.f); atomic_init(&s->m_lg, 0.f);
    return s;
}

void ts6dsp_destroy(ts6dsp *s) {
    if (!s) return;
    free(s->xd); free(s->yd); free(s->dq_v); free(s->dq_i); free(s->mnr);
    free(s);
}

/* ponytail: seqlock with a plain memcpy; one writer thread assumed. A torn read is detected via the
 * counter and simply retried at the next block. */
void ts6dsp_set_params(ts6dsp *s, const ts6dsp_params *pp) {
    ts6dsp_params p = *pp;
    sanitize(&p);
    unsigned q = atomic_load_explicit(&s->seq, memory_order_relaxed);
    atomic_store_explicit(&s->seq, q + 1, memory_order_relaxed);
    atomic_thread_fence(memory_order_release);
    memcpy(&s->pend, &p, sizeof p);
    atomic_store_explicit(&s->seq, q + 2, memory_order_release);
}

static void poll_params(ts6dsp *s) {
    unsigned s1 = atomic_load_explicit(&s->seq, memory_order_acquire);
    if ((s1 & 1u) || s1 == s->applied) return;
    ts6dsp_params t;
    memcpy(&t, &s->pend, sizeof t);
    atomic_thread_fence(memory_order_acquire);
    if (atomic_load_explicit(&s->seq, memory_order_relaxed) != s1) return;
    t.lookahead_ms = s->p.lookahead_ms; /* latency fixed at create */
    s->p = t;
    s->applied = s1;
    derive(s);
}

int ts6dsp_latency_frames(const ts6dsp *s) { return s->D; }

void ts6dsp_get_meters(const ts6dsp *s, float *in_db, float *gr, float *lg) {
    if (in_db) *in_db = atomic_load_explicit(&s->m_in, memory_order_relaxed);
    if (gr) *gr = atomic_load_explicit(&s->m_gr, memory_order_relaxed);
    if (lg) *lg = atomic_load_explicit(&s->m_lg, memory_order_relaxed);
}

void ts6dsp_process_f32(ts6dsp *s, float *buf, int frames) {
    poll_params(s);
    const int ch = s->ch, L = s->L;
    const ts6dsp_params *p = &s->p;
    const float T = p->threshold_db, W = p->knee_db, invR = 1.0f / p->ratio;
    float ms = s->ms, lg = s->lg, env = s->env, gr = s->gr, mk = s->mk, lr = s->lr, mix = s->mix;
    float in_db = -120.f, gr_max = 0.f;

    for (int i = 0; i < frames; i++) {
        float *f = buf + (size_t)i * (size_t)ch;
        float pk = 0.f;
        for (int c = 0; c < ch; c++) {
            if (!isfinite(f[c]) || fabsf(f[c]) < 1e-30f) f[c] = 0.f; /* ponytail: NaN/Inf/denormal input -> silence */
            float a = fabsf(f[c]);
            if (a > pk) pk = a;
        }

        /* --- leveler: RMS (linked), slow gain in dB, frozen below gate --- */
        ms += s->a_ms * (pk * pk - ms);
        if (ms < 1e-20f) ms = 1e-20f;
        in_db = 10.0f * log10f(ms); /* ponytail: transcendental per sample, cheap enough for voice rates */
        if (in_db > p->gate_db) {
            float des = clampf(p->target_db - in_db, LEVELER_MIN_DB, p->max_gain_db);
            lg += (des - lg) * (des < lg ? s->a_ld : s->a_lu);
        } else if (lg > p->max_gain_db) {
            lg += (p->max_gain_db - lg) * s->a_ld; /* max_gain lowered at runtime */
        }

        /* --- compressor: peak detector -> soft-knee computer -> dB-domain attack/release --- */
        float pl = pk * exp2f(lg * DB2LOG2);
        env = pl > env ? pl : env * s->dec_env;
        if (env < 1e-9f) env = 0.f;
        float x = 20.0f * log10f(env > 1e-9f ? env : 1e-9f), d = x - T, grt;
        if (2.0f * d < -W) grt = 0.f;
        else if (2.0f * fabsf(d) <= W) { float k = d + W * 0.5f; grt = (1.0f - invR) * k * k / (2.0f * W); }
        else grt = d * (1.0f - invR);
        gr += (grt - gr) * (grt > gr ? s->a_att : s->a_rel);
        if (grt <= 0.f && gr < 1e-4f) gr = 0.f;
        mk += (p->makeup_db - mk) * s->a_mk;
        if (fabsf(p->makeup_db - mk) < 1e-4f) mk = p->makeup_db;
        float g1 = exp2f((lg - gr + mk) * DB2LOG2);

        /* --- limiter: required gain, release envelope, window min, box average --- */
        float py = pk * g1;
        float gl = py > s->ceil_lin ? s->ceil_lin / py : 1.0f;
        float rr = lr + (1.0f - lr) * s->a_lrel;
        if (rr > 0.9999f) rr = 1.0f; /* float one-pole stalls just below 1 otherwise; -80 dB step */
        lr = gl < rr ? gl : rr;
        while (s->dq_cnt && s->dq_v[(s->dq_head + s->dq_cnt - 1) % s->dq_cap] >= lr) s->dq_cnt--;
        int tail = (s->dq_head + s->dq_cnt) % s->dq_cap;
        s->dq_v[tail] = lr; s->dq_i[tail] = s->n; s->dq_cnt++;
        while (s->dq_i[s->dq_head] + (uint64_t)L <= s->n) { s->dq_head = (s->dq_head + 1) % s->dq_cap; s->dq_cnt--; }
        float mn = s->dq_v[s->dq_head];
        s->msum += (double)mn - (double)s->mnr[s->mpos];
        s->mnr[s->mpos] = mn;
        if (++s->mpos == L) s->mpos = 0;
        float g = (float)(s->msum / L); /* ponytail: double running sum, drift ~1e-12, clamped below */
        if (g > 1.0f) g = 1.0f;
        s->n++;

        /* --- delay lines (ring of L frames: write then read = D frames back) --- */
        float *xw = s->xd + (size_t)s->dpos * (size_t)ch, *yw = s->yd + (size_t)s->dpos * (size_t)ch;
        for (int c = 0; c < ch; c++) { xw[c] = f[c]; yw[c] = f[c] * g1; }
        s->dpos = (s->dpos + 1) % L;
        const float *xr = s->xd + (size_t)s->dpos * (size_t)ch, *yr = s->yd + (size_t)s->dpos * (size_t)ch;

        mix += (s->mix_t - mix) * s->a_mix;
        if (fabsf(s->mix_t - mix) < 1e-4f) mix = s->mix_t;
        for (int c = 0; c < ch; c++) {
            float w = yr[c] * g;
            if (w > s->ceil_lin) w = s->ceil_lin; /* last resort only; guarantee comes from g */
            else if (w < -s->ceil_lin) w = -s->ceil_lin;
            f[c] = mix >= 1.0f ? w : mix <= 0.0f ? xr[c] : xr[c] + (w - xr[c]) * mix;
        }

        if (gr - 20.0f * log10f(g) > gr_max) gr_max = gr - 20.0f * log10f(g);
    }
    s->ms = ms; s->lg = lg; s->env = env; s->gr = gr; s->mk = mk; s->lr = lr; s->mix = mix;
    if (frames > 0) {
        atomic_store_explicit(&s->m_in, in_db, memory_order_relaxed);
        atomic_store_explicit(&s->m_gr, gr_max, memory_order_relaxed);
        atomic_store_explicit(&s->m_lg, lg, memory_order_relaxed);
    }
}

void ts6dsp_process_s16(ts6dsp *s, int16_t *buf, int frames) {
    float tmp[2048];
    int chunk = 2048 / s->ch;
    while (frames > 0) {
        int nf = frames < chunk ? frames : chunk, ns = nf * s->ch;
        for (int i = 0; i < ns; i++) tmp[i] = (float)buf[i] * (1.0f / 32768.0f);
        ts6dsp_process_f32(s, tmp, nf);
        for (int i = 0; i < ns; i++) {
            float v = tmp[i] * 32768.0f;
            buf[i] = (int16_t)lrintf(v > 32767.f ? 32767.f : v < -32768.f ? -32768.f : v);
        }
        buf += ns; frames -= nf;
    }
}

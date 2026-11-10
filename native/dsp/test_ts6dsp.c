/* Self-test, no framework: CHECK() prints and counts failures, exit code != 0 on any. */
#include "ts6dsp.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>

#define SR 48000
#define PI 3.14159265358979f
static int fails;
#define CHECK(c, ...) do { if (!(c)) { fails++; printf("  FAIL %s:%d: ", __FILE__, __LINE__); printf(__VA_ARGS__); printf("\n"); } } while (0)

static unsigned rs = 12345;
static float rnd(void) { rs = rs * 1664525u + 1013904223u; return (float)(rs >> 8) / 8388608.0f - 1.0f; }
static float dbf(float db) { return powf(10.f, db / 20.f); }

static void test_burst(void) {
    float las[3] = { 0, 5, 20 };
    for (int k = 0; k < 3; k++) {
        for (int pre = 0; pre < 2; pre++) { /* pre=1: quiet speech first so the leveler is boosting */
            ts6dsp_params p; ts6dsp_default_params(&p);
            p.lookahead_ms = las[k]; p.comp_enabled = pre; /* both with and without the compressor */
            ts6dsp *s = ts6dsp_create(SR, 2, &p);
            float peak = 0;
            int n = SR * 6;
            float *b = calloc((size_t)n * 2, sizeof(float));
            for (int i = 0; i < n; i++) {
                float v = 0;
                if (pre && i < SR * 5) v = 0.02f * sinf(2 * PI * 200 * (float)i / SR);
                if (i >= SR * 5 + 100 && i < SR * 5 + 100 + 4800) v = (i / 3 % 2) ? 1.0f : -1.0f; /* full-scale square */
                if (i >= SR * 5 + 6000 && i < SR * 5 + 9000) v = rnd(); /* full-scale noise */
                b[2 * i] = v; b[2 * i + 1] = 0.5f * v;
            }
            for (int i = 0; i < n; i += 480) ts6dsp_process_f32(s, b + 2 * i, 480);
            for (int i = 0; i < n * 2; i++) if (fabsf(b[i]) > peak) peak = fabsf(b[i]);
            CHECK(peak <= dbf(p.ceiling_db) + 1e-6f, "lookahead %g ms pre=%d peak %.5f > ceiling %.5f", las[k], pre, peak, dbf(p.ceiling_db));
            printf("  burst lookahead %4.1f ms pre=%d: max out peak %.5f (ceiling %.5f)\n", las[k], pre, peak, dbf(p.ceiling_db));
            free(b); ts6dsp_destroy(s);
        }
    }
}

static float rms_db(const float *b, int n) { double a = 0; for (int i = 0; i < n; i++) a += (double)b[i] * b[i]; return 10.f * log10f((float)(a / n) + 1e-20f); }

static void test_leveler(void) {
    ts6dsp_params p; ts6dsp_default_params(&p);
    p.ratio = 1; p.makeup_db = 0; p.lookahead_ms = 0;
    float lev[2] = { -30, -40 };
    for (int k = 0; k < 2; k++) {
        ts6dsp *s = ts6dsp_create(SR, 1, &p);
        float want = fminf(p.target_db - lev[k], p.max_gain_db), amp = dbf(lev[k]) * 1.41421356f;
        float lg = 0, maxlg = 0, t90 = -1;
        for (int blk = 0; blk < 1000; blk++) { /* 10 s */
            float b[480];
            for (int i = 0; i < 480; i++) b[i] = amp * sinf(2 * PI * 300 * (float)(blk * 480 + i) / SR);
            ts6dsp_process_f32(s, b, 480);
            ts6dsp_get_meters(s, NULL, NULL, &lg);
            if (lg > maxlg) maxlg = lg;
            if (t90 < 0 && lg >= 0.9f * want) t90 = (float)(blk + 1) * 0.01f;
        }
        printf("  leveler input %g dBFS: wanted gain %.1f dB, 90%% reached after %.2f s, final %.2f dB, max %.2f dB\n", lev[k], want, t90, lg, maxlg);
        CHECK(t90 > 0 && t90 <= 5.0f, "no convergence within 5 s");
        CHECK(maxlg <= p.max_gain_db + 0.01f, "gain %.3f above max_gain", maxlg);
        CHECK(fabsf(lg - want) < 0.5f, "final gain %.2f vs wanted %.1f", lg, want);
        ts6dsp_destroy(s);
    }
    /* noise below gate must not be boosted */
    ts6dsp *s = ts6dsp_create(SR, 1, &p);
    float in_ms = 0, out_ms = 0, lg = 0;
    for (int blk = 0; blk < 1000; blk++) {
        float b[480], c[480];
        for (int i = 0; i < 480; i++) c[i] = b[i] = 0.001f * rnd(); /* about -64 dBFS rms */
        ts6dsp_process_f32(s, b, 480);
        if (blk >= 500) { in_ms += rms_db(c, 480); out_ms += rms_db(b, 480); }
    }
    ts6dsp_get_meters(s, NULL, NULL, &lg);
    printf("  gate: noise %.1f dB in, %.1f dB out, leveler gain %.3f dB\n", in_ms / 500, out_ms / 500, lg);
    CHECK(lg < 0.01f && fabsf(in_ms - out_ms) / 500 < 0.1f, "noise below gate was boosted");
    ts6dsp_destroy(s);
}

static void test_latency(void) {
    float las[3] = { 0, 5, 20 };
    for (int k = 0; k < 3; k++) {
        ts6dsp_params p; ts6dsp_default_params(&p);
        p.lookahead_ms = las[k];
        ts6dsp *s = ts6dsp_create(SR, 1, &p);
        int lat = ts6dsp_latency_frames(s), pos = -1;
        float b[4000] = { 0 }, best = 0;
        b[100] = 0.1f;
        ts6dsp_process_f32(s, b, 4000);
        for (int i = 0; i < 4000; i++) if (fabsf(b[i]) > best) { best = fabsf(b[i]); pos = i; }
        printf("  latency lookahead %4.1f ms: reported %d frames, observed %d frames\n", las[k], lat, pos - 100);
        CHECK(pos - 100 == lat, "observed %d != reported %d", pos - 100, lat);
        ts6dsp_destroy(s);
    }
}

static void test_denormal(void) {
    ts6dsp_params p; ts6dsp_default_params(&p);
    ts6dsp *s = ts6dsp_create(SR, 2, &p);
    float b[960]; int bad = 0, nonzero = 0;
    for (int blk = 0; blk < 60 * 50; blk++) { /* 60 s: loud burst, then silence/denormal input */
        for (int i = 0; i < 960; i++) b[i] = blk < 50 ? 0.9f * rnd() : (blk % 2 ? 1e-40f : 0.0f);
        ts6dsp_process_f32(s, b, 480);
        for (int i = 0; i < 960; i++) {
            int c = fpclassify(b[i]);
            if (c == FP_NAN || c == FP_INFINITE || c == FP_SUBNORMAL) bad++;
            if (blk > 100 && b[i] != 0.f) nonzero++;
        }
    }
    float in, gr, lg; ts6dsp_get_meters(s, &in, &gr, &lg);
    printf("  60 s silence: bad samples %d, nonzero tail samples %d, meters in=%.1f gr=%.4f lg=%.3f\n", bad, nonzero, in, gr, lg);
    CHECK(bad == 0, "%d NaN/Inf/subnormal samples", bad);
    CHECK(isfinite(in) && isfinite(gr) && isfinite(lg), "non-finite meter");
    ts6dsp_destroy(s);
    /* NaN / Inf input */
    s = ts6dsp_create(SR, 1, &p);
    float x[64]; for (int i = 0; i < 64; i++) x[i] = i % 3 ? NAN : INFINITY;
    ts6dsp_process_f32(s, x, 64);
    int nanout = 0; for (int i = 0; i < 64; i++) if (!isfinite(x[i])) nanout++;
    CHECK(nanout == 0, "NaN input leaked");
    ts6dsp_destroy(s);
}

static void test_click(void) {
    ts6dsp_params p; ts6dsp_default_params(&p);
    ts6dsp *s = ts6dsp_create(SR, 1, &p);
    float prev = 0, maxstep = 0, natural = 0;
    int n = SR * 4, step_at = SR * 2;
    for (int blk = 0; blk < n / 480; blk++) {
        if (blk * 480 == step_at) {
            p.comp_enabled = 1; p.threshold_db = -40; p.ratio = 8; p.makeup_db = 12; p.target_db = -30; p.ceiling_db = -3;
            ts6dsp_set_params(s, &p);
        }
        if (blk * 480 == step_at + SR / 2) { p.enabled = 0; ts6dsp_set_params(s, &p); }
        if (blk * 480 == step_at + SR) { p.enabled = 1; p.makeup_db = 0; ts6dsp_set_params(s, &p); }
        float b[480];
        for (int i = 0; i < 480; i++) b[i] = 0.3f * sinf(2 * PI * 200 * (float)(blk * 480 + i) / SR);
        ts6dsp_process_f32(s, b, 480);
        for (int i = 0; i < 480; i++) {
            if (blk > 10) { float d = fabsf(b[i] - prev); if (d > maxstep) maxstep = d; }
            prev = b[i];
        }
    }
    natural = 2 * PI * 200 / SR * 0.9f; /* peak slope of a sine at the loudest plausible output (0.9) */
    printf("  click: max sample step %.5f (natural sine slope at 0.9 amplitude %.5f)\n", maxstep, natural);
    CHECK(maxstep < 0.03f, "step %.5f suggests a click", maxstep);
    ts6dsp_destroy(s);
}

static void test_s16(void) {
    ts6dsp_params p; ts6dsp_default_params(&p);
    ts6dsp *s = ts6dsp_create(SR, 2, &p);
    static int16_t b[2 * 5000];
    for (int i = 0; i < 2 * 5000; i++) b[i] = (int16_t)((i / 2 / 7) % 2 ? 32767 : -32768);
    ts6dsp_process_s16(s, b, 5000);
    int pk = 0; for (int i = 0; i < 2 * 5000; i++) if (abs(b[i]) > pk) pk = abs(b[i]);
    printf("  s16 full-scale square: max |out| %d (ceiling %.0f)\n", pk, 32768 * dbf(p.ceiling_db));
    CHECK(pk <= (int)(32768 * dbf(p.ceiling_db)) + 1, "s16 peak %d", pk);
    ts6dsp_destroy(s);
}

/* compressor off: the stage must not touch the signal (no reduction, no make-up) even with extreme compressor values */
static void test_comp_bypass(void) {
    ts6dsp_params p; ts6dsp_default_params(&p);
    CHECK(p.comp_enabled == 0, "compressor must default to off");
    p.target_db = 0; p.max_gain_db = 0; p.ceiling_db = 0; p.lookahead_ms = 0;
    p.threshold_db = -60; p.ratio = 20; p.makeup_db = 12;
    float maxd[2] = { 0, 0 }, gr[2] = { 0, 0 };
    for (int on = 0; on < 2; on++) {
        p.comp_enabled = on;
        ts6dsp *s = ts6dsp_create(SR, 1, &p);
        for (int blk = 0; blk < 100; blk++) {
            float b[480], ref[480];
            for (int i = 0; i < 480; i++) ref[i] = b[i] = 0.1f * sinf(2 * PI * 300 * (float)(blk * 480 + i) / SR);
            ts6dsp_process_f32(s, b, 480);
            for (int i = 0; i < 480; i++) { float d = fabsf(b[i] - ref[i]); if (d > maxd[on]) maxd[on] = d; }
            ts6dsp_get_meters(s, NULL, &gr[on], NULL);
        }
        ts6dsp_destroy(s);
    }
    printf("  comp off: max deviation %.7f, gain reduction %.3f dB; comp on: deviation %.4f, gr %.2f dB\n", maxd[0], gr[0], maxd[1], gr[1]);
    CHECK(maxd[0] < 1e-5f, "compressor off changed the signal by %.7f", maxd[0]);
    CHECK(gr[0] == 0.f, "compressor off reports gain reduction %.3f", gr[0]);
    CHECK(maxd[1] > 0.05f, "compressor on should alter the signal (got %.4f)", maxd[1]);
}

#define RUN(t) do { int before = fails; printf("%s\n", #t); t(); printf("%s %s\n", fails == before ? "PASS" : "FAIL", #t); } while (0)

int main(void) {
    RUN(test_burst); RUN(test_leveler); RUN(test_latency); RUN(test_denormal); RUN(test_click); RUN(test_s16); RUN(test_comp_bypass);
    printf(fails ? "%d check(s) FAILED\n" : "all tests passed\n", fails);
    return fails != 0;
}

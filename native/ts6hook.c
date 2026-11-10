/* ts6hook - per-speaker voice dynamics via an inline hook of the client's per-sender PCM callback.
 * See ts6hook.h and superdoc/features/per-speaker-hook.md. Linux x86_64 only. */
#define _GNU_SOURCE
#include "ts6hook.h"
#include <math.h>
#include <pthread.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/mman.h>
#include <time.h>
#include <unistd.h>

/* ts6mod.c owns the log file; borrow its writer. */
extern void ts6mod_log(const char *fmt, ...);

/* ---- the function to hook ------------------------------------------------
 * playback_sender_data(void *sender, int16_t *pcm, int frames, int channels, int rate):
 * one sender's decoded block, int16 mono, 10 ms frames at the codec rate (48 kHz -> 480), before
 * resample+mix. Args SysV: rdi=sender, rsi=pcm, edx=frames, ecx=channels, r8=rate. The prologue
 * (push rbp/r15/r14/r13/r12/rbx; sub rsp,0x1a8) is 17 bytes, position-independent and relocatable
 * into the trampoline. The signature below includes enough of the body to be unique. */
static const unsigned char SIG[] = {
    0x55,0x41,0x57,0x41,0x56,0x41,0x55,0x41,0x54,0x53,0x48,0x81,0xEC,0xA8,0x01,0x00,0x00,
    0x4C,0x89,0x44,0x24,0x20,0x48,0x8B,0x07,0x0F,0xB6,0x80,0xE4,0x3B,0x00,0x00,0x83,0xF9,0x01
};
#define PROLOGUE_LEN 17
#define CID_OFFSET   0x30      /* uint32 clientId inside the sender object (confirmed at runtime: 2 for
                                * RigTalkerA, 3 for RigTalkerB; the object mirrors it at 0x120/0x140/0x190
                                * too. NOT 0x168 - that holds the sample rate 48000.) */
#define POOL_RATE    48000
#define POOL_CH      1
#define MAX_SPEAKERS 32
#define MAX_OV       64
#define RETIRE_MAX   64
#define RETIRE_AFTER_S 3

typedef long (*fn_t)(void *sender, int16_t *pcm, int frames, int channels, long rate);
static fn_t   g_trampoline;              /* original prologue + jmp back to target+17 */
static void  *g_target;                  /* runtime VA of the hooked function */
static _Atomic int g_installed;
static _Atomic int g_active;             /* 1 = detour runs the DSP; 0 = pure passthrough */
static float  g_pool_la = -1.f;          /* lookahead the pool DSPs were built with */

/* ---- per-speaker slots (audio thread claims/processes; control thread reads meters) ---- */
typedef struct {
    _Atomic uint32_t cid;                /* 0 = free */
    _Atomic int      schid;
    _Atomic(ts6dsp *) dsp;               /* preallocated pool instance (48 kHz mono) */
    _Atomic uint64_t frames, seen;       /* seen = LRU stamp */
    _Atomic int      proc;               /* run the DSP (g_active && override.enabled) */
    _Atomic int      ovflag;             /* an override exists for this cid (display) */
    _Atomic float    gain_lin, ceil_lin; /* extra output gain; DSP ceiling (for the post-gain clamp) */
    _Atomic float    in_db, gr_db, lg_db, out_peak; /* meters */
} speaker_t;
static speaker_t g_sp[MAX_SPEAKERS];
static _Atomic uint64_t g_seen_ctr;

/* ---- per-session override store (keyed by client_id), control-thread writes ---- */
typedef struct {
    uint32_t cid; int schid; int present;
    int enabled;                 /* default 1 */
    int has_gain; float gain_db;
    uint32_t mask; ts6dsp_params params;
    _Atomic unsigned seq;        /* seqlock: audio thread reads this entry when claiming a slot */
} ov_t;
static ov_t g_ov[MAX_OV];

/* ---- base params (whole config), seqlock so the audio thread can read on claim ---- */
static ts6dsp_params g_base;
static _Atomic unsigned g_base_seq;

/* control-side lock guarding g_ov / g_base writes and pool (re)build. ts6mod calls every entry
 * point on its control thread; this just orders ts6hook's own control-side state. */
static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;

/* ---- delayed free of retired DSP instances (never freed on the audio path) ---- */
static struct { ts6dsp *d; time_t t; } g_retire[RETIRE_MAX];
static void retire(ts6dsp *d) {          /* caller holds g_lock */
    if (!d) return;
    int oldest = 0;
    for (int i = 0; i < RETIRE_MAX; i++) {
        if (!g_retire[i].d) { g_retire[i].d = d; g_retire[i].t = time(0); return; }
        if (g_retire[i].t < g_retire[oldest].t) oldest = i;
    }
    ts6dsp_destroy(g_retire[oldest].d); g_retire[oldest].d = d; g_retire[oldest].t = time(0);
}
void ts6hook_sweep(void) {               /* called from ts6mod's control loop */
    pthread_mutex_lock(&g_lock);
    time_t now = time(0);
    for (int i = 0; i < RETIRE_MAX; i++)
        if (g_retire[i].d && now - g_retire[i].t >= RETIRE_AFTER_S) { ts6dsp_destroy(g_retire[i].d); g_retire[i].d = NULL; }
    pthread_mutex_unlock(&g_lock);
}

static float dbf(float db) { return powf(10.0f, db * 0.05f); }

/* ---- param resolution ------------------------------------------------- */
static void apply_mask(ts6dsp_params *p, const ov_t *o) {
    if (o->mask & TPM_TARGET)    p->target_db    = o->params.target_db;
    if (o->mask & TPM_MAXGAIN)   p->max_gain_db  = o->params.max_gain_db;
    if (o->mask & TPM_GATE)      p->gate_db      = o->params.gate_db;
    if (o->mask & TPM_THRESHOLD) p->threshold_db = o->params.threshold_db;
    if (o->mask & TPM_RATIO)     p->ratio        = o->params.ratio;
    if (o->mask & TPM_KNEE)      p->knee_db      = o->params.knee_db;
    if (o->mask & TPM_ATTACK)    p->attack_ms    = o->params.attack_ms;
    if (o->mask & TPM_RELEASE)   p->release_ms   = o->params.release_ms;
    if (o->mask & TPM_MAKEUP)    p->makeup_db    = o->params.makeup_db;
    if (o->mask & TPM_CEILING)   p->ceiling_db   = o->params.ceiling_db;
}

/* control-thread resolution (holds g_lock): base + override for cid. */
static void resolve_locked(uint32_t cid, ts6dsp_params *out, int *enabled, float *gain_db, int *has_ov) {
    *out = g_base; *enabled = 1; *gain_db = 0.f; *has_ov = 0;
    for (int i = 0; i < MAX_OV; i++) if (g_ov[i].present && g_ov[i].cid == cid) {
        *has_ov = 1; *enabled = g_ov[i].enabled;
        if (g_ov[i].has_gain) *gain_db = g_ov[i].gain_db;
        apply_mask(out, &g_ov[i]);
        break;
    }
    out->lookahead_ms = g_pool_la; out->enabled = 1;
}

/* audio-thread resolution (lock-free): base and the matching override via seqlocks. */
static void resolve_lf(uint32_t cid, ts6dsp_params *out, int *enabled, float *gain_db, int *has_ov) {
    for (int tries = 0; tries < 8; tries++) {
        unsigned s = atomic_load_explicit(&g_base_seq, memory_order_acquire);
        if (s & 1u) continue;
        ts6dsp_params b = g_base;
        atomic_thread_fence(memory_order_acquire);
        if (atomic_load_explicit(&g_base_seq, memory_order_relaxed) == s) { *out = b; goto base_ok; }
    }
    ts6dsp_default_params(out);
base_ok:
    *enabled = 1; *gain_db = 0.f; *has_ov = 0;
    for (int i = 0; i < MAX_OV; i++) {
        if (!g_ov[i].present || g_ov[i].cid != cid) continue;
        for (int tries = 0; tries < 8; tries++) {
            unsigned s = atomic_load_explicit(&g_ov[i].seq, memory_order_acquire);
            if (s & 1u) continue;
            ov_t o = g_ov[i];
            atomic_thread_fence(memory_order_acquire);
            if (atomic_load_explicit(&g_ov[i].seq, memory_order_relaxed) != s) continue;
            if (!o.present || o.cid != cid) break;
            *has_ov = 1; *enabled = o.enabled;
            if (o.has_gain) *gain_db = o.gain_db;
            apply_mask(out, &o);
            break;
        }
        break;
    }
    out->lookahead_ms = g_pool_la; out->enabled = 1;
}

/* ---- slot configuration ------------------------------------------------ */
static void config_slot(speaker_t *sp, const ts6dsp_params *p, int enabled, float gain_db, int has_ov) {
    ts6dsp *d = atomic_load_explicit(&sp->dsp, memory_order_acquire);
    if (d) ts6dsp_set_params(d, p);
    atomic_store(&sp->ceil_lin, dbf(p->ceiling_db));
    atomic_store(&sp->gain_lin, dbf(gain_db));
    atomic_store(&sp->proc, atomic_load(&g_active) && enabled);
    atomic_store(&sp->ovflag, has_ov);
}

/* control thread: re-apply base+override to one active slot. */
static void reapply_slot_locked(speaker_t *sp) {
    uint32_t cid = atomic_load(&sp->cid);
    if (!cid) return;
    ts6dsp_params p; int en, ov; float g;
    resolve_locked(cid, &p, &en, &g, &ov);
    config_slot(sp, &p, en, g, ov);
}

/* ---- audio-thread slot lookup / claim --------------------------------- */
static speaker_t *lookup(uint32_t cid) {
    for (int i = 0; i < MAX_SPEAKERS; i++)
        if (atomic_load_explicit(&g_sp[i].cid, memory_order_relaxed) == cid) return &g_sp[i];
    return NULL;
}
static speaker_t *claim(uint32_t cid, int schid) {
    speaker_t *sp = NULL;
    for (int i = 0; i < MAX_SPEAKERS; i++) {
        uint32_t z = 0;
        if (atomic_compare_exchange_strong(&g_sp[i].cid, &z, cid)) { sp = &g_sp[i]; break; }
    }
    if (!sp) {   /* LRU evict: least-recently-seen slot (its tail is lost, <= lookahead_ms) */
        int lru = 0; uint64_t best = UINT64_MAX;
        for (int i = 0; i < MAX_SPEAKERS; i++) {
            uint64_t s = atomic_load_explicit(&g_sp[i].seen, memory_order_relaxed);
            if (s < best) { best = s; lru = i; }
        }
        sp = &g_sp[lru];
        atomic_store(&sp->cid, cid);
    }
    atomic_store(&sp->schid, schid);
    atomic_store(&sp->frames, 0);
    atomic_store(&sp->in_db, -120.f); atomic_store(&sp->gr_db, 0.f);
    atomic_store(&sp->lg_db, 0.f); atomic_store(&sp->out_peak, 0.f);
    ts6dsp *d = atomic_load_explicit(&sp->dsp, memory_order_acquire);
    if (d) ts6dsp_reset(d);
    ts6dsp_params p; int en, ov; float g;
    resolve_lf(cid, &p, &en, &g, &ov);
    config_slot(sp, &p, en, g, ov);
    return sp;
}

/* env-gated probe (TS6HOOK_PROBE=1): dump, rate-limited and only during speech, the sender object's
 * small-integer uint32 fields so the clientId offset can be found after a client update. */
static _Atomic int g_probe = -1;
static void probe_dump(void *sender, pthread_t tid, int frames, int channels, long rate, float rms) {
    static _Thread_local time_t last;
    time_t now = time(0);
    if (now == last) return;
    last = now;
    char b[1024]; int n = snprintf(b, sizeof b, "PROBE tid=%lx sender=%p frames=%d ch=%d rate=%ld rms=%.1fdB ints:",
                                   (unsigned long)tid, sender, frames, channels, rate, rms > 1e-9f ? 20.0f * log10f(rms) : -120.f);
    for (int off = 0; off <= 0x800 && n < (int)sizeof b - 24; off += 4) {
        uint32_t v = *(volatile uint32_t *)((char *)sender + off);
        if (v >= 1 && v <= 64) n += snprintf(b + n, sizeof b - (size_t)n, " 0x%x=%u", off, v);
    }
    ts6mod_log("%s", b);
}

/* ---- the detour (runs on the client's audio/mix thread) --------------- */
static long detour(void *sender, int16_t *pcm, int frames, int channels, long rate) {
    if (!atomic_load_explicit(&g_active, memory_order_relaxed) || channels != POOL_CH ||
        frames <= 0 || !sender || !pcm || rate != POOL_RATE)
        return g_trampoline(sender, pcm, frames, channels, rate);
    if (atomic_load_explicit(&g_probe, memory_order_relaxed) == -1)
        atomic_store_explicit(&g_probe, getenv("TS6HOOK_PROBE") ? 1 : 0, memory_order_relaxed);
    if (atomic_load_explicit(&g_probe, memory_order_relaxed)) {
        double s = 0;
        for (int i = 0; i < frames; i++) { float a = (float)pcm[i] * (1.0f / 32768.0f); s += (double)a * a; }
        float rms = sqrtf((float)(s / (double)frames));
        if (rms > 0.01f) probe_dump(sender, pthread_self(), frames, channels, rate, rms);
    }
    uint32_t cid = *(volatile uint32_t *)((char *)sender + CID_OFFSET);
    if (!cid) return g_trampoline(sender, pcm, frames, channels, rate);

    speaker_t *sp = lookup(cid);
    if (!sp) sp = claim(cid, 0);
    ts6dsp *d = sp ? atomic_load_explicit(&sp->dsp, memory_order_acquire) : NULL;
    if (!sp || !d) return g_trampoline(sender, pcm, frames, channels, rate);

    atomic_store_explicit(&sp->seen, atomic_fetch_add_explicit(&g_seen_ctr, 1, memory_order_relaxed) + 1, memory_order_relaxed);
    atomic_fetch_add_explicit(&sp->frames, (uint64_t)frames, memory_order_relaxed);

    double sum = 0; float ipk = 0;
    for (int i = 0; i < frames; i++) { float a = (float)pcm[i] * (1.0f / 32768.0f); sum += (double)a * a; float f = fabsf(a); if (f > ipk) ipk = f; }
    float irms = sqrtf((float)(sum / (double)frames));
    atomic_store_explicit(&sp->in_db, irms > 1e-9f ? 20.0f * log10f(irms) : -120.0f, memory_order_relaxed);

    float gl = atomic_load_explicit(&sp->gain_lin, memory_order_relaxed);
    if (atomic_load_explicit(&sp->proc, memory_order_relaxed)) {
        ts6dsp_process_s16(d, pcm, frames);
        if (gl != 1.0f) {
            float cl = atomic_load_explicit(&sp->ceil_lin, memory_order_relaxed) * 32768.0f; /* keep the ceiling */
            for (int i = 0; i < frames; i++) { float v = (float)pcm[i] * gl; v = v > cl ? cl : v < -cl ? -cl : v; pcm[i] = (int16_t)lrintf(v); }
        }
        float opk = 0; for (int i = 0; i < frames; i++) { float a = fabsf((float)pcm[i]) * (1.0f / 32768.0f); if (a > opk) opk = a; }
        atomic_store_explicit(&sp->out_peak, opk, memory_order_relaxed);
        float a, b, c; ts6dsp_get_meters(d, &a, &b, &c);
        atomic_store_explicit(&sp->gr_db, b, memory_order_relaxed);
        atomic_store_explicit(&sp->lg_db, c, memory_order_relaxed);
    } else if (gl != 1.0f) {   /* DSP disabled for this speaker, but still boost it (no dynamics) */
        for (int i = 0; i < frames; i++) { float v = (float)pcm[i] * gl; v = v > 32767.0f ? 32767.0f : v < -32768.0f ? -32768.0f : v; pcm[i] = (int16_t)lrintf(v); }
        float opk = 0; for (int i = 0; i < frames; i++) { float a = fabsf((float)pcm[i]) * (1.0f / 32768.0f); if (a > opk) opk = a; }
        atomic_store_explicit(&sp->out_peak, opk, memory_order_relaxed);
        atomic_store_explicit(&sp->gr_db, 0.f, memory_order_relaxed);
        atomic_store_explicit(&sp->lg_db, 0.f, memory_order_relaxed);
    } else {
        atomic_store_explicit(&sp->out_peak, ipk, memory_order_relaxed);
        atomic_store_explicit(&sp->gr_db, 0.f, memory_order_relaxed);
        atomic_store_explicit(&sp->lg_db, 0.f, memory_order_relaxed);
    }
    return g_trampoline(sender, pcm, frames, channels, rate);
}

/* ---- install -------------------------------------------------------------- */
static int exe_path(char *out, size_t cap) {
    ssize_t k = readlink("/proc/self/exe", out, cap - 1);
    if (k <= 0) return 0;
    out[k] = 0; return 1;
}
/* scan the main executable's executable mappings for the unique signature. */
static int find_target(void **out) {
    char exe[512]; if (!exe_path(exe, sizeof exe)) return 0;
    FILE *f = fopen("/proc/self/maps", "r"); if (!f) return 0;
    char line[1024]; void *hit = NULL; int count = 0;
    while (fgets(line, sizeof line, f)) {
        unsigned long a, b; char perm[8], path[768] = "";
        if (sscanf(line, "%lx-%lx %7s %*x %*s %*u %767[^\n]", &a, &b, perm, path) < 3) continue;
        if (perm[2] != 'x') continue;
        char *p = path; while (*p == ' ') p++;
        if (strcmp(p, exe)) continue;
        const unsigned char *base = (const unsigned char *)a;
        size_t len = (size_t)(b - a);
        for (size_t i = 0; i + sizeof SIG <= len; i++) {
            if (base[i] == SIG[0] && !memcmp(base + i, SIG, sizeof SIG)) { hit = (void *)(base + i); count++; }
        }
    }
    fclose(f);
    if (count != 1) { ts6mod_log("per-speaker: signature matched %d times (need 1): not installing", count); return 0; }
    *out = hit; return 1;
}
static int install(void) {
    void *t; if (!find_target(&t)) return 0;
    long pg = sysconf(_SC_PAGESIZE);
    /* trampoline: relocated prologue + absolute jmp to target+PROLOGUE_LEN */
    unsigned char *tr = mmap(NULL, (size_t)pg, PROT_READ | PROT_WRITE | PROT_EXEC, MAP_PRIVATE | MAP_ANONYMOUS, -1, 0);
    if (tr == MAP_FAILED) { ts6mod_log("per-speaker: trampoline mmap failed"); return 0; }
    memcpy(tr, t, PROLOGUE_LEN);
    uint64_t back = (uint64_t)t + PROLOGUE_LEN;
    tr[PROLOGUE_LEN] = 0xFF; tr[PROLOGUE_LEN + 1] = 0x25; memset(tr + PROLOGUE_LEN + 2, 0, 4);
    memcpy(tr + PROLOGUE_LEN + 6, &back, 8);
    g_trampoline = (fn_t)tr;
    /* patch the target with a 14-byte absolute jmp to the detour (+2 nop = 16 bytes).
     * Write the tail first, then the leading qword in one atomic store: the FF25 opcode only becomes
     * visible once the full jump operand is already in place. */
    unsigned char patch[16] = { 0xFF, 0x25, 0, 0, 0, 0 };
    uint64_t det = (uint64_t)(void *)detour;
    memcpy(patch + 6, &det, 8); patch[14] = 0x90; patch[15] = 0x90;
    uintptr_t lo = (uintptr_t)t & ~((uintptr_t)pg - 1);
    uintptr_t hi = ((uintptr_t)t + 16 + (uintptr_t)pg - 1) & ~((uintptr_t)pg - 1);
    if (mprotect((void *)lo, hi - lo, PROT_READ | PROT_WRITE | PROT_EXEC)) { ts6mod_log("per-speaker: mprotect failed"); return 0; }
    memcpy((char *)t + 8, patch + 8, 8);
    atomic_thread_fence(memory_order_release);
    uint64_t head; memcpy(&head, patch, 8);
    __atomic_store_n((uint64_t *)t, head, __ATOMIC_SEQ_CST);
    mprotect((void *)lo, hi - lo, PROT_READ | PROT_EXEC);
    g_target = t;
    atomic_store(&g_installed, 1);
    ts6mod_log("per-speaker: hook installed at %p (trampoline %p)", t, (void *)tr);
    return 1;
}

/* (re)build the pool of DSP instances at a given lookahead; caller holds g_lock. */
static void pool_build(float la) {
    ts6dsp_params p = g_base; p.lookahead_ms = la; p.enabled = 1;
    for (int i = 0; i < MAX_SPEAKERS; i++) {
        ts6dsp *n = ts6dsp_create(POOL_RATE, POOL_CH, &p);
        if (!n) { ts6mod_log("per-speaker: ts6dsp_create failed for pool slot %d", i); continue; }
        retire(atomic_exchange(&g_sp[i].dsp, n));
    }
    g_pool_la = la;
}

/* ---- public API ------------------------------------------------------- */
void ts6hook_set_config(const ts6dsp_params *base, int per_speaker) {
    pthread_mutex_lock(&g_lock);
    unsigned q = atomic_load_explicit(&g_base_seq, memory_order_relaxed);
    atomic_store_explicit(&g_base_seq, q + 1, memory_order_relaxed);
    atomic_thread_fence(memory_order_release);
    g_base = *base;
    atomic_store_explicit(&g_base_seq, q + 2, memory_order_release);

    if (per_speaker) {
        if (!atomic_load(&g_installed)) {
            if (!install()) { pthread_mutex_unlock(&g_lock); return; }
            pool_build(base->lookahead_ms);
        } else if (g_pool_la != base->lookahead_ms) {
            atomic_store(&g_active, 0);          /* passthrough while the delay lines change size */
            pool_build(base->lookahead_ms);
        }
        atomic_store(&g_active, 1);
        for (int i = 0; i < MAX_SPEAKERS; i++) if (atomic_load(&g_sp[i].cid)) reapply_slot_locked(&g_sp[i]);
    } else {
        atomic_store(&g_active, 0);
        for (int i = 0; i < MAX_SPEAKERS; i++) atomic_store(&g_sp[i].proc, 0);
    }
    pthread_mutex_unlock(&g_lock);
}

void ts6hook_set_override(uint32_t cid, int schid, const ts6hook_override *in) {
    if (!cid) return;
    pthread_mutex_lock(&g_lock);
    int slot = -1, freeslot = -1;
    for (int i = 0; i < MAX_OV; i++) {
        if (g_ov[i].present && g_ov[i].cid == cid) { slot = i; break; }
        if (freeslot < 0 && !g_ov[i].present) freeslot = i;
    }
    if (in->clear) {
        if (slot >= 0) {
            unsigned q = atomic_load_explicit(&g_ov[slot].seq, memory_order_relaxed);
            atomic_store_explicit(&g_ov[slot].seq, q + 1, memory_order_relaxed);
            atomic_thread_fence(memory_order_release);
            g_ov[slot].present = 0; g_ov[slot].cid = 0;
            atomic_store_explicit(&g_ov[slot].seq, q + 2, memory_order_release);
        }
    } else {
        if (slot < 0) slot = freeslot;
        if (slot < 0) { ts6mod_log("per-speaker: override table full, dropping cid %u", cid); pthread_mutex_unlock(&g_lock); return; }
        ov_t nv = { 0 };
        nv.cid = cid; nv.schid = schid; nv.present = 1;
        nv.enabled = in->has_enabled ? in->enabled : 1;
        nv.has_gain = in->has_gain; nv.gain_db = in->gain_db;
        nv.mask = in->param_mask; nv.params = in->params;
        unsigned q = atomic_load_explicit(&g_ov[slot].seq, memory_order_relaxed);
        atomic_store_explicit(&g_ov[slot].seq, q + 1, memory_order_relaxed);
        atomic_thread_fence(memory_order_release);
        g_ov[slot].cid = nv.cid; g_ov[slot].schid = nv.schid; g_ov[slot].present = nv.present;
        g_ov[slot].enabled = nv.enabled; g_ov[slot].has_gain = nv.has_gain; g_ov[slot].gain_db = nv.gain_db;
        g_ov[slot].mask = nv.mask; g_ov[slot].params = nv.params;
        atomic_store_explicit(&g_ov[slot].seq, q + 2, memory_order_release);
    }
    /* push to a currently-active slot for this cid, if any */
    for (int i = 0; i < MAX_SPEAKERS; i++) if (atomic_load(&g_sp[i].cid) == cid) reapply_slot_locked(&g_sp[i]);
    pthread_mutex_unlock(&g_lock);
}

void ts6hook_status(int *installed, uint64_t *addr, int *active, int *count, float *lat) {
    if (installed) *installed = atomic_load(&g_installed);
    if (addr) *addr = (uint64_t)g_target;
    if (active) *active = atomic_load(&g_active);
    int n = 0;
    for (int i = 0; i < MAX_SPEAKERS; i++) if (atomic_load(&g_sp[i].cid)) n++;
    if (count) *count = n;
    if (lat) *lat = atomic_load(&g_active) ? g_pool_la : 0.f;
}

static float to_db(float lin) { return lin < 1e-6f ? -120.f : 20.0f * log10f(lin); }
int ts6hook_speakers_json(char *o, size_t cap) {
    int n = snprintf(o, cap, "[");
    int first = 1;
    for (int i = 0; i < MAX_SPEAKERS; i++) {
        uint32_t cid = atomic_load(&g_sp[i].cid);
        if (!cid) continue;
        speaker_t *sp = &g_sp[i];
        n += snprintf(o + n, n < (int)cap ? cap - (size_t)n : 0,
            "%s{\"client_id\":%u,\"schid\":%d,\"active\":%s,\"frames\":%llu,\"rate\":%d,\"channels\":%d,"
            "\"in_db\":%.1f,\"gain_reduction_db\":%.2f,\"leveler_gain_db\":%.2f,\"out_peak_db\":%.2f,\"override\":%s}",
            first ? "" : ",", cid, atomic_load(&sp->schid), atomic_load(&sp->proc) ? "true" : "false",
            (unsigned long long)atomic_load(&sp->frames), POOL_RATE, POOL_CH,
            atomic_load(&sp->in_db), atomic_load(&sp->gr_db), atomic_load(&sp->lg_db), to_db(atomic_load(&sp->out_peak)),
            atomic_load(&sp->ovflag) ? "true" : "false");
        first = 0;
    }
    n += snprintf(o + n, n < (int)cap ? cap - (size_t)n : 0, "]");
    return n;
}

/* ts6mod - LD_PRELOAD module for the TeamSpeak 6 client (main process only).
 *
 * 1. Interposes dlsym(): libpulse is dlopen'd by the client, so a plain preload definition of
 *    pa_stream_write would be bypassed. For a few playback symbols dlsym() returns our wrappers.
 * 2. The write wrappers run every playback stream through ts6dsp (leveler -> compressor -> limiter)
 *    while the mod is enabled. Disabled = the original call, untouched (exact passthrough, no latency).
 * 3. A loopback HTTP control API (config, meters, status) for the injected "Mods" settings page.
 * See superdoc/features/agc.md. Linux x86_64/glibc only. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <errno.h>
#include <fcntl.h>
#include <math.h>
#include <poll.h>
#include <pthread.h>
#include <stdarg.h>
#include <stdatomic.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/stat.h>
#include <netinet/in.h>
#include <arpa/inet.h>
#include <time.h>
#include <unistd.h>
#include "dsp/ts6dsp.h"

#define EXPORT __attribute__((visibility("default")))
#define VERSION "0.1.0"
#define MAX_STREAMS 16
#define BUF_BYTES (1u << 20)
#define MAX_SEEN 256
#define RETIRE_MAX 32
#define RETIRE_AFTER_S 3

/* pulse types we need (layout of pa_sample_spec) */
typedef struct { int format; uint32_t rate; uint8_t channels; } pa_spec;
enum { FMT_S16LE = 3, FMT_F32LE = 5 };
typedef void (*free_cb_t)(void *);

static void *(*real_dlsym)(void *, const char *);
static int (*real_connect_playback)(void *, const char *, const void *, int, const void *, void *);
static int (*real_write)(void *, const void *, size_t, free_cb_t, int64_t, int);
static int (*real_write_ext)(void *, const void *, size_t, free_cb_t, void *, int64_t, int);
static int (*real_begin_write)(void *, void **, size_t *);
static int (*real_cancel_write)(void *);
static int (*real_disconnect)(void *);
static const pa_spec *(*real_get_spec)(void *);

static _Atomic int g_active;      /* 1 only in the TeamSpeak main process */
static _Atomic int g_enabled;     /* mod switch, read on the audio path */
static char g_logpath[512], g_cfgpath[512];

/* ---------- logging (never on the audio path) ---------- */
static void logf_(const char *fmt, ...) {
    if (!g_logpath[0]) return;
    char b[640]; struct timespec ts; clock_gettime(CLOCK_REALTIME, &ts);
    struct tm tm; localtime_r(&ts.tv_sec, &tm);
    int n = snprintf(b, sizeof b, "%02d:%02d:%02d.%03ld pid=%d ", tm.tm_hour, tm.tm_min, tm.tm_sec, ts.tv_nsec / 1000000, getpid());
    va_list ap; va_start(ap, fmt);
    n += vsnprintf(b + n, sizeof b - (size_t)n - 2, fmt, ap); va_end(ap);
    if (n > (int)sizeof b - 2) n = (int)sizeof b - 2;
    b[n++] = '\n';
    int fd = open(g_logpath, O_WRONLY | O_CREAT | O_APPEND | O_CLOEXEC, 0644);
    if (fd >= 0) { if (write(fd, b, (size_t)n) < 0) {} close(fd); }
}

static void mkdir_p(const char *path) {
    char t[512]; snprintf(t, sizeof t, "%s", path);
    for (char *p = t + 1; *p; p++) if (*p == '/') { *p = 0; mkdir(t, 0755); *p = '/'; }
    mkdir(t, 0755);
}

static void init_paths(void) {
    const char *home = getenv("HOME"), *cfg = getenv("XDG_CONFIG_HOME"), *st = getenv("XDG_STATE_HOME");
    char d[400];
    if (cfg && *cfg) snprintf(d, sizeof d, "%s/ts6-mods", cfg); else snprintf(d, sizeof d, "%s/.config/ts6-mods", home ? home : "");
    mkdir_p(d); snprintf(g_cfgpath, sizeof g_cfgpath, "%s/agc.json", d);
    if (st && *st) snprintf(d, sizeof d, "%s/ts6-mods", st); else snprintf(d, sizeof d, "%s/.local/state/ts6-mods", home ? home : "");
    mkdir_p(d); snprintf(g_logpath, sizeof g_logpath, "%s/ts6mod.log", d);
}

/* ---------- config ---------- */
typedef struct { int enabled; int dashboard_button; ts6dsp_params p; char preset[32]; float strength; } cfg_t;  /* dashboard_button: UI-only mod switch, stored here so all mod switches live in one file */
static cfg_t g_cfg;
static pthread_mutex_t g_ctl = PTHREAD_MUTEX_INITIALIZER; /* control paths only; the audio thread never takes it */

static void cfg_default(cfg_t *c) {
    memset(c, 0, sizeof *c);
    ts6dsp_default_params(&c->p);
    snprintf(c->preset, sizeof c->preset, "balanced"); c->strength = 50.f;
}

/* ---------- streams ---------- */
typedef struct {
    _Atomic(void *) key;          /* pa_stream*, NULL = free slot */
    int fmt, rate, ch; size_t framesize;
    _Atomic(ts6dsp *) dsp;
    float la_ms;                  /* lookahead the current dsp was created with */
    float *buf;                   /* BUF_BYTES, allocated at register time */
    void *bw_ptr;                 /* last pa_stream_begin_write buffer */
    _Atomic uint64_t writes, proc, pass, oversize, badfmt;
    _Atomic float out_peak, in_peak;   /* sample peaks (0..1) since the last /meters read; only measured while processing */
} stream_t;
static stream_t g_st[MAX_STREAMS];

static struct { ts6dsp *d; time_t t; } g_retire[RETIRE_MAX];
static void retire(ts6dsp *d) {   /* caller holds g_ctl */
    if (!d) return;
    int oldest = 0;
    for (int i = 0; i < RETIRE_MAX; i++) {
        if (!g_retire[i].d) { g_retire[i].d = d; g_retire[i].t = time(0); return; }
        if (g_retire[i].t < g_retire[oldest].t) oldest = i;
    }
    ts6dsp_destroy(g_retire[oldest].d); g_retire[oldest].d = d; g_retire[oldest].t = time(0);
}
static void sweep_retired(void) {
    pthread_mutex_lock(&g_ctl);
    time_t now = time(0);
    for (int i = 0; i < RETIRE_MAX; i++)
        if (g_retire[i].d && now - g_retire[i].t >= RETIRE_AFTER_S) { ts6dsp_destroy(g_retire[i].d); g_retire[i].d = NULL; }
    pthread_mutex_unlock(&g_ctl);
}

static stream_t *find_stream(void *s) {
    for (int i = 0; i < MAX_STREAMS; i++) if (atomic_load_explicit(&g_st[i].key, memory_order_acquire) == s) return &g_st[i];
    return NULL;
}

static ts6dsp *make_dsp(stream_t *st) {   /* caller holds g_ctl */
    ts6dsp_params p = g_cfg.p; p.enabled = 1;
    ts6dsp *d = ts6dsp_create(st->rate, st->ch, &p);
    if (d) st->la_ms = p.lookahead_ms;
    return d;
}

/* bring every stream in line with g_cfg (control thread / registration); caller holds g_ctl */
static void apply_locked(void) {
    if (!g_cfg.enabled) {
        atomic_store(&g_enabled, 0);
        for (int i = 0; i < MAX_STREAMS; i++) { retire(atomic_exchange(&g_st[i].dsp, NULL)); }
        return;
    }
    for (int i = 0; i < MAX_STREAMS; i++) {
        stream_t *st = &g_st[i];
        if (!atomic_load(&st->key) || (st->fmt != FMT_S16LE && st->fmt != FMT_F32LE)) continue;
        ts6dsp *d = atomic_load(&st->dsp);
        ts6dsp_params p = g_cfg.p; p.enabled = 1;
        if (!d || fabsf(st->la_ms - p.lookahead_ms) > 0.01f) {
            ts6dsp *n = make_dsp(st);
            if (n) retire(atomic_exchange(&st->dsp, n)); else logf_("ts6dsp_create failed (rate=%d ch=%d)", st->rate, st->ch);
        } else ts6dsp_set_params(d, &p);
    }
    atomic_store(&g_enabled, 1);
}

static void register_stream(void *s) {
    const pa_spec *sp = real_get_spec ? real_get_spec(s) : NULL;
    pthread_mutex_lock(&g_ctl);
    stream_t *st = NULL;
    for (int i = 0; i < MAX_STREAMS; i++) if (atomic_load(&g_st[i].key) == s) { atomic_store(&g_st[i].key, NULL); retire(atomic_exchange(&g_st[i].dsp, NULL)); }
    for (int i = 0; i < MAX_STREAMS && !st; i++) if (!atomic_load(&g_st[i].key)) st = &g_st[i];
    if (!st) { logf_("stream table full, stream %p not processed", s); pthread_mutex_unlock(&g_ctl); return; }
    if (!st->buf) st->buf = aligned_alloc(64, BUF_BYTES);
    if (!st->buf || !sp) { logf_("playback stream %p: no sample spec / buffer, passthrough", s); pthread_mutex_unlock(&g_ctl); return; }
    st->fmt = sp->format; st->rate = (int)sp->rate; st->ch = sp->channels;
    st->framesize = (size_t)st->ch * (st->fmt == FMT_S16LE ? 2u : st->fmt == FMT_F32LE ? 4u : 0u);
    st->bw_ptr = NULL; st->la_ms = -1.f;
    atomic_store(&st->dsp, NULL);
    atomic_store(&st->writes, 0); atomic_store(&st->proc, 0); atomic_store(&st->pass, 0);
    atomic_store(&st->oversize, 0); atomic_store(&st->badfmt, 0); atomic_store(&st->out_peak, 0.f); atomic_store(&st->in_peak, 0.f);
    logf_("playback stream %p: format=%d rate=%d channels=%d%s", s, st->fmt, st->rate, st->ch,
          st->framesize ? "" : " (unsupported format: always passthrough)");
    atomic_store_explicit(&st->key, s, memory_order_release);
    if (g_cfg.enabled) apply_locked();
    pthread_mutex_unlock(&g_ctl);
}

static void unregister_stream(void *s) {
    pthread_mutex_lock(&g_ctl);
    for (int i = 0; i < MAX_STREAMS; i++) if (atomic_load(&g_st[i].key) == s) {
        atomic_store(&g_st[i].key, NULL); retire(atomic_exchange(&g_st[i].dsp, NULL));
        logf_("playback stream %p closed (writes=%llu processed=%llu passthrough=%llu)", s,
              (unsigned long long)g_st[i].writes, (unsigned long long)g_st[i].proc, (unsigned long long)g_st[i].pass);
    }
    pthread_mutex_unlock(&g_ctl);
}

/* ---------- audio path: no allocation, no locks ---------- */
static int process_in(stream_t *st, ts6dsp *d, void *buf, size_t nbytes) {
    size_t nf = nbytes / st->framesize;
    if (!nf || ((uintptr_t)buf & 3)) return 0;
    float peak = 0.f, ipk = 0.f;
    if (st->fmt == FMT_F32LE) {
        float *f = buf;
        for (size_t i = 0; i < nf * (size_t)st->ch; i++) { float a = fabsf(f[i]); if (a > ipk) ipk = a; }
        ts6dsp_process_f32(d, f, (int)nf);
        for (size_t i = 0; i < nf * (size_t)st->ch; i++) { float a = fabsf(f[i]); if (a > peak) peak = a; }
    } else {
        int16_t *s = buf;
        for (size_t i = 0; i < nf * (size_t)st->ch; i++) { float a = fabsf((float)s[i]) / 32768.f; if (a > ipk) ipk = a; }
        ts6dsp_process_s16(d, s, (int)nf);
        for (size_t i = 0; i < nf * (size_t)st->ch; i++) { float a = fabsf((float)s[i]) / 32768.f; if (a > peak) peak = a; }
    }
    if (ipk > atomic_load_explicit(&st->in_peak, memory_order_relaxed)) atomic_store_explicit(&st->in_peak, ipk, memory_order_relaxed);
    if (peak > atomic_load_explicit(&st->out_peak, memory_order_relaxed)) atomic_store_explicit(&st->out_peak, peak, memory_order_relaxed);
    return 1;
}

/* returns 1 if the data was handled via a processed copy and the real write done (result in *ret) */
static int hooked_write(void *s, const void *data, size_t n, free_cb_t fcb, void *fcb_data, int has_ext, int64_t off, int seek, int *ret) {
    stream_t *st = find_stream(s);
    if (!st) return 0;
    atomic_fetch_add_explicit(&st->writes, 1, memory_order_relaxed);
    ts6dsp *d;
    if (!atomic_load_explicit(&g_enabled, memory_order_relaxed) || !(d = atomic_load_explicit(&st->dsp, memory_order_acquire)) || !st->framesize) {
        atomic_fetch_add_explicit(&st->pass, 1, memory_order_relaxed);
        return 0;
    }
    if (data == st->bw_ptr) {            /* buffer from pa_stream_begin_write: writable, process in place */
        st->bw_ptr = NULL;
        if (!process_in(st, d, (void *)data, n)) { atomic_fetch_add_explicit(&st->pass, 1, memory_order_relaxed); return 0; }
        atomic_fetch_add_explicit(&st->proc, 1, memory_order_relaxed);
        return 0;                          /* caller forwards the (now processed) original buffer */
    }
    if (n > BUF_BYTES || n < st->framesize) { atomic_fetch_add_explicit(&st->oversize, 1, memory_order_relaxed); atomic_fetch_add_explicit(&st->pass, 1, memory_order_relaxed); return 0; }
    memcpy(st->buf, data, n);
    if (!process_in(st, d, st->buf, n)) { atomic_fetch_add_explicit(&st->pass, 1, memory_order_relaxed); return 0; }
    atomic_fetch_add_explicit(&st->proc, 1, memory_order_relaxed);
    int r = real_write(s, st->buf, n, NULL, off, seek);   /* NULL free_cb: pulse copies */
    if (r == 0 && fcb) fcb(has_ext ? fcb_data : (void *)data); /* pulse took ownership of the original: release it as it would have */
    *ret = r;
    return 1;
}

static int w_write(void *s, const void *data, size_t n, free_cb_t fcb, int64_t off, int seek) {
    int r; if (hooked_write(s, data, n, fcb, NULL, 0, off, seek, &r)) return r;
    return real_write(s, data, n, fcb, off, seek);
}
static int w_write_ext(void *s, const void *data, size_t n, free_cb_t fcb, void *fd, int64_t off, int seek) {
    int r; if (hooked_write(s, data, n, fcb, fd, 1, off, seek, &r)) return r;
    return real_write_ext(s, data, n, fcb, fd, off, seek);
}
static int w_begin_write(void *s, void **data, size_t *n) {
    int r = real_begin_write(s, data, n);
    stream_t *st = find_stream(s);
    if (st) st->bw_ptr = (r == 0 && data) ? *data : NULL;
    return r;
}
static int w_cancel_write(void *s) {
    stream_t *st = find_stream(s); if (st) st->bw_ptr = NULL;
    return real_cancel_write(s);
}
static int w_connect_playback(void *s, const char *dev, const void *attr, int flags, const void *vol, void *sync) {
    int r = real_connect_playback(s, dev, attr, flags, vol, sync);
    if (r == 0) register_stream(s);
    return r;
}
static int w_disconnect(void *s) { unregister_stream(s); return real_disconnect(s); }

/* ---------- dlsym interposition ---------- */
static char g_seen[MAX_SEEN][40]; static _Atomic int g_nseen; static atomic_flag g_seen_lock = ATOMIC_FLAG_INIT;
static void log_symbol(const char *n) {
    if (strncmp(n, "pa_stream_", 10) && strncmp(n, "pa_simple_", 10) && strncmp(n, "snd_pcm_", 8) && strncmp(n, "pw_", 3)) return;
    while (atomic_flag_test_and_set(&g_seen_lock)) {}
    int found = 0, cnt = g_nseen;
    for (int i = 0; i < cnt; i++) if (!strncmp(g_seen[i], n, sizeof g_seen[i] - 1)) { found = 1; break; }
    if (!found && cnt < MAX_SEEN) { snprintf(g_seen[cnt], sizeof g_seen[cnt], "%s", n); g_nseen = cnt + 1; }
    atomic_flag_clear(&g_seen_lock);
    if (!found) logf_("dlsym resolved: %s", n);
}

static void init_real(void) {
    if (real_dlsym) return;
    void *p = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.34");
    if (!p) p = dlvsym(RTLD_NEXT, "dlsym", "GLIBC_2.2.5");
    real_dlsym = (void *(*)(void *, const char *))p;
}

typedef struct { const char *name; void **real; void *wrap; } hook_t;
static hook_t g_hooks[] = {
    { "pa_stream_connect_playback", (void **)&real_connect_playback, (void *)w_connect_playback },
    { "pa_stream_write",            (void **)&real_write,            (void *)w_write },
    { "pa_stream_write_ext_free",   (void **)&real_write_ext,        (void *)w_write_ext },
    { "pa_stream_begin_write",      (void **)&real_begin_write,      (void *)w_begin_write },
    { "pa_stream_cancel_write",     (void **)&real_cancel_write,     (void *)w_cancel_write },
    { "pa_stream_disconnect",       (void **)&real_disconnect,       (void *)w_disconnect },
};
static _Atomic int g_hooked[6];

__attribute__((noinline)) static void *dlsym_slow(void *h, const char *name) {
    void *r = real_dlsym(h, name);
    if (!r) return r;
    log_symbol(name);
    if (!strcmp(name, "pa_stream_get_sample_spec")) { real_get_spec = (const pa_spec *(*)(void *))r; return r; }
    /* all of connect_playback/write/get_spec must exist, else do not hook anything (fail safe) */
    for (size_t i = 0; i < sizeof g_hooks / sizeof *g_hooks; i++) if (!strcmp(name, g_hooks[i].name)) {
        if (!real_get_spec) { void *g = real_dlsym(h, "pa_stream_get_sample_spec"); real_get_spec = (const pa_spec *(*)(void *))g; }
        if (!real_get_spec) { logf_("pa_stream_get_sample_spec unavailable: %s not hooked", name); return r; }
        if (!*g_hooks[i].real) *g_hooks[i].real = r;
        atomic_store(&g_hooked[i], 1);
        return g_hooks[i].wrap;
    }
    return r;
}

EXPORT void *dlsym(void *h, const char *name) {
    if (__builtin_expect(!real_dlsym, 0)) init_real();
    if (__builtin_expect(!atomic_load_explicit(&g_active, memory_order_relaxed) || h == RTLD_NEXT, 1))
        return real_dlsym(h, name);       /* sibling call: glibc still sees the real caller (RTLD_NEXT) */
    return dlsym_slow(h, name);
}

/* ---------- tiny JSON helpers (flat objects only) ---------- */
static const char *jfind(const char *b, const char *key) {
    char k[48]; snprintf(k, sizeof k, "\"%s\"", key);
    const char *p = strstr(b, k); if (!p) return NULL;
    p += strlen(k); while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    if (*p != ':') return NULL;
    p++; while (*p == ' ' || *p == '\t' || *p == '\n' || *p == '\r') p++;
    return p;
}
static int jnum(const char *b, const char *key, float *out) {
    const char *p = jfind(b, key); if (!p) return 0;
    char *e; double v = strtod(p, &e); if (e == p || !isfinite(v)) return 0;
    *out = (float)v; return 1;
}
static int jbool(const char *b, const char *key, int *out) {
    const char *p = jfind(b, key); if (!p) return 0;
    if (!strncmp(p, "true", 4)) { *out = 1; return 1; }
    if (!strncmp(p, "false", 5)) { *out = 0; return 1; }
    return 0;
}
static int jstr(const char *b, const char *key, char *out, size_t cap) {
    const char *p = jfind(b, key); if (!p || *p != '"') return 0;
    p++; size_t n = 0;
    while (*p && *p != '"' && n + 1 < cap) { char c = *p++; if (!((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_' || c == '-')) return 0; out[n++] = c; }
    if (*p != '"') return 0;
    out[n] = 0; return 1;
}

static void cfg_apply_json(cfg_t *c, const char *b) {
    int i; float f; char s[32];
    if (jbool(b, "enabled", &i)) c->enabled = i;
    if (jbool(b, "dashboard_button", &i)) c->dashboard_button = i;
    if (jnum(b, "target_db", &f)) c->p.target_db = f;
    if (jnum(b, "max_gain_db", &f)) c->p.max_gain_db = f;
    if (jnum(b, "gate_db", &f)) c->p.gate_db = f;
    if (jnum(b, "threshold_db", &f)) c->p.threshold_db = f;
    if (jnum(b, "ratio", &f)) c->p.ratio = f;
    if (jnum(b, "knee_db", &f)) c->p.knee_db = f;
    if (jnum(b, "attack_ms", &f)) c->p.attack_ms = f;
    if (jnum(b, "release_ms", &f)) c->p.release_ms = f;
    if (jnum(b, "makeup_db", &f)) c->p.makeup_db = f;
    if (jnum(b, "lookahead_ms", &f)) c->p.lookahead_ms = f;
    if (jnum(b, "ceiling_db", &f)) c->p.ceiling_db = f;
    if (jnum(b, "strength", &f)) c->strength = f < 0 ? 0 : f > 100 ? 100 : f;
    if (jstr(b, "preset", s, sizeof s)) snprintf(c->preset, sizeof c->preset, "%s", s);
}

static int cfg_json(const cfg_t *c, char *o, size_t cap) {
    const ts6dsp_params *p = &c->p;
    return snprintf(o, cap,
        "{\"enabled\":%s,\"dashboard_button\":%s,\"preset\":\"%s\",\"strength\":%.1f,\"target_db\":%.2f,\"max_gain_db\":%.2f,\"gate_db\":%.2f,"
        "\"threshold_db\":%.2f,\"ratio\":%.2f,\"knee_db\":%.2f,\"attack_ms\":%.2f,\"release_ms\":%.2f,"
        "\"makeup_db\":%.2f,\"lookahead_ms\":%.2f,\"ceiling_db\":%.2f}",
        c->enabled ? "true" : "false", c->dashboard_button ? "true" : "false", c->preset, c->strength, p->target_db, p->max_gain_db, p->gate_db, p->threshold_db,
        p->ratio, p->knee_db, p->attack_ms, p->release_ms, p->makeup_db, p->lookahead_ms, p->ceiling_db);
}

static void cfg_save(void) {   /* caller holds g_ctl */
    char tmp[560], js[1024]; snprintf(tmp, sizeof tmp, "%s.tmp", g_cfgpath);
    cfg_json(&g_cfg, js, sizeof js);
    FILE *f = fopen(tmp, "w");
    if (!f) { logf_("cannot write %s: %s", tmp, strerror(errno)); return; }
    fprintf(f, "%s\n", js); fclose(f);
    if (rename(tmp, g_cfgpath)) logf_("rename config failed: %s", strerror(errno));
}

static void cfg_load(void) {
    cfg_default(&g_cfg);
    FILE *f = fopen(g_cfgpath, "r");
    if (!f) { logf_("no config file, default: disabled"); return; }
    char b[2048]; size_t n = fread(b, 1, sizeof b - 1, f); fclose(f); b[n] = 0;
    cfg_apply_json(&g_cfg, b);
    logf_("config loaded: enabled=%d", g_cfg.enabled);
}

/* clamp to the dsp ranges (mirrors sanitize() in ts6dsp.c) so the stored/echoed config is what runs */
static float clampf(float v, float lo, float hi) { return !(v >= lo) ? lo : v > hi ? hi : v; }
static void cfg_clamp(cfg_t *c) {
    ts6dsp_params *p = &c->p;
    p->target_db = clampf(p->target_db, -40, 0); p->max_gain_db = clampf(p->max_gain_db, 0, 24);
    p->gate_db = clampf(p->gate_db, -90, -20); p->threshold_db = clampf(p->threshold_db, -60, 0);
    p->ratio = clampf(p->ratio, 1, 20); p->knee_db = clampf(p->knee_db, 0, 24);
    p->attack_ms = clampf(p->attack_ms, 0.1f, 200); p->release_ms = clampf(p->release_ms, 5, 2000);
    p->makeup_db = clampf(p->makeup_db, -12, 24); p->lookahead_ms = clampf(p->lookahead_ms, 0, 20);
    p->ceiling_db = clampf(p->ceiling_db, -24, 0);
}

/* ---------- HTTP control API ---------- */
static float to_db(float lin) { return lin < 1e-6f ? -120.f : 20.f * log10f(lin); }

static int status_json(char *o, size_t cap) {
    int n = snprintf(o, cap, "{\"module\":\"ts6mod\",\"version\":\"" VERSION "\",\"pid\":%d,\"enabled\":%s,\"mode\":\"%s\",\"config_file\":\"%s\",\"hooked\":[",
                     getpid(), g_cfg.enabled ? "true" : "false", atomic_load(&g_enabled) ? "processing" : "passthrough", g_cfgpath);
    int first = 1;
    for (size_t i = 0; i < sizeof g_hooks / sizeof *g_hooks; i++) if (atomic_load(&g_hooked[i])) { n += snprintf(o + n, cap - (size_t)n, "%s\"%s\"", first ? "" : ",", g_hooks[i].name); first = 0; }
    n += snprintf(o + n, cap - (size_t)n, "],\"streams\":[");
    first = 1;
    for (int i = 0; i < MAX_STREAMS; i++) {
        stream_t *st = &g_st[i]; if (!atomic_load(&st->key)) continue;
        ts6dsp *d = atomic_load(&st->dsp);
        n += snprintf(o + n, cap - (size_t)n,
            "%s{\"format\":\"%s\",\"rate\":%d,\"channels\":%d,\"processing\":%s,\"latency_frames\":%d,\"writes\":%llu,\"processed_writes\":%llu,\"passthrough_writes\":%llu,\"oversize\":%llu}",
            first ? "" : ",", st->fmt == FMT_S16LE ? "s16le" : st->fmt == FMT_F32LE ? "f32le" : "unsupported", st->rate, st->ch,
            (d && atomic_load(&g_enabled)) ? "true" : "false", d ? ts6dsp_latency_frames(d) : 0,
            (unsigned long long)st->writes, (unsigned long long)st->proc, (unsigned long long)st->pass, (unsigned long long)st->oversize);
        first = 0;
    }
    n += snprintf(o + n, cap - (size_t)n, "]}");
    return n;
}

static int meters_json(char *o, size_t cap) {
    float in = -120.f, gr = 0.f, lg = 0.f, pk = 0.f, ipk = 0.f; int active = 0;
    for (int i = 0; i < MAX_STREAMS; i++) {
        stream_t *st = &g_st[i]; if (!atomic_load(&st->key)) continue;
        float p = atomic_exchange(&st->out_peak, 0.f); if (p > pk) pk = p;
        p = atomic_exchange(&st->in_peak, 0.f); if (p > ipk) ipk = p;
        ts6dsp *d = atomic_load(&st->dsp);
        if (d && atomic_load(&g_enabled)) {
            float a, b, c; ts6dsp_get_meters(d, &a, &b, &c);
            if (!active || a > in) { in = a; gr = b; lg = c; } active = 1;
        }
    }
    return snprintf(o, cap, "{\"active\":%s,\"in_db\":%.1f,\"gain_reduction_db\":%.2f,\"leveler_gain_db\":%.2f,\"in_peak_db\":%.2f,\"out_peak_db\":%.2f}",
                    active ? "true" : "false", in, gr, lg, to_db(ipk), to_db(pk));
}

static int origin_ok(const char *req, char *origin, size_t cap) {
    origin[0] = 0;
    const char *h = strcasestr(req, "\r\norigin:");
    if (h) { h += 9; while (*h == ' ') h++; size_t n = strcspn(h, "\r\n"); if (n >= cap) return 0; memcpy(origin, h, n); origin[n] = 0;
        if (strncmp(origin, "tsui://", 7)) return 0; }
    const char *hh = strcasestr(req, "\r\nhost:");     /* DNS rebinding guard */
    if (hh) { hh += 7; while (*hh == ' ') hh++; if (strncmp(hh, "127.0.0.1", 9) && strncmp(hh, "localhost", 9)) return 0; }
    return 1;
}

static void respond(int c, int code, const char *origin, const char *body, int n) {
    char h[512];
    int m = snprintf(h, sizeof h,
        "HTTP/1.1 %d %s\r\nContent-Type: application/json\r\nContent-Length: %d\r\nCache-Control: no-store\r\n"
        "Access-Control-Allow-Origin: %s\r\nAccess-Control-Allow-Private-Network: true\r\n"
        "Access-Control-Allow-Methods: GET, POST, OPTIONS\r\nAccess-Control-Allow-Headers: content-type\r\nAccess-Control-Max-Age: 600\r\n"
        "Vary: Origin\r\nConnection: close\r\n\r\n",
        code, code == 200 ? "OK" : code == 204 ? "No Content" : code == 403 ? "Forbidden" : code == 404 ? "Not Found" : "Bad Request", n,
        origin[0] ? origin : "null");
    if (write(c, h, (size_t)m) < 0) {}
    if (n > 0 && write(c, body, (size_t)n) < 0) {}
}

static void handle(int c) {
    struct timeval tv = { 1, 0 }; setsockopt(c, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof tv);
    char req[8192]; size_t len = 0;
    while (len < sizeof req - 1) {
        ssize_t r = read(c, req + len, sizeof req - 1 - len); if (r <= 0) break;
        len += (size_t)r; req[len] = 0;
        char *he = strstr(req, "\r\n\r\n");
        if (he) { const char *cl = strcasestr(req, "\r\ncontent-length:"); size_t want = cl ? (size_t)atoi(cl + 17) : 0;
                  if (len >= (size_t)(he + 4 - req) + want) break; }
    }
    req[len] = 0;
    char origin[96], out[4096]; int n = 0;
    if (!origin_ok(req, origin, sizeof origin)) { respond(c, 403, "", "{\"error\":\"forbidden\"}", 21); return; }
    char method[8] = "", path[64] = ""; sscanf(req, "%7s %63s", method, path);
    char *body = strstr(req, "\r\n\r\n"); body = body ? body + 4 : req + len;
    if (!strcmp(method, "OPTIONS")) { respond(c, 204, origin, "", 0); return; }
    if (!strcmp(path, "/status") && !strcmp(method, "GET")) { n = status_json(out, sizeof out); respond(c, 200, origin, out, n); }
    else if (!strcmp(path, "/meters") && !strcmp(method, "GET")) { n = meters_json(out, sizeof out); respond(c, 200, origin, out, n); }
    else if (!strcmp(path, "/config") && (!strcmp(method, "GET") || !strcmp(method, "POST"))) {
        pthread_mutex_lock(&g_ctl);
        if (method[0] == 'P') {
            cfg_t was = g_cfg; cfg_apply_json(&g_cfg, body); cfg_clamp(&g_cfg);
            apply_locked(); cfg_save();
            if (was.enabled != g_cfg.enabled) logf_("mod %s via API", g_cfg.enabled ? "ENABLED" : "disabled");
        }
        n = cfg_json(&g_cfg, out, sizeof out);
        pthread_mutex_unlock(&g_ctl);
        respond(c, 200, origin, out, n);
    } else respond(c, 404, origin, "{\"error\":\"not found\"}", 21);
}

static void *server_thread(void *arg) {
    (void)arg;
    pthread_setname_np(pthread_self(), "ts6mod-ctl");
    const char *pe = getenv("TS6MOD_PORT"); int port = pe && atoi(pe) > 0 ? atoi(pe) : 38998;
    int s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0), one = 1;
    setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    struct sockaddr_in sa = { .sin_family = AF_INET, .sin_port = htons((uint16_t)port) };
    sa.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
    /* the client's first process hands over to a re-spawned one: keep retrying while the old one still holds the port */
    for (int tries = 0; s >= 0 && (bind(s, (void *)&sa, sizeof sa) || listen(s, 8)); tries++) {
        if (tries >= 120) { logf_("control API bind 127.0.0.1:%d failed: %s", port, strerror(errno)); return NULL; }
        close(s); usleep(500000); s = socket(AF_INET, SOCK_STREAM | SOCK_CLOEXEC, 0); setsockopt(s, SOL_SOCKET, SO_REUSEADDR, &one, sizeof one);
    }
    if (s < 0) return NULL;
    logf_("control API listening on 127.0.0.1:%d", port);
    for (;;) {
        struct pollfd pf = { s, POLLIN, 0 };
        if (poll(&pf, 1, 500) > 0) { int c = accept4(s, 0, 0, SOCK_CLOEXEC); if (c >= 0) { handle(c); close(c); } }
        sweep_retired();
    }
    return NULL;
}

/* ---------- main-process filter ---------- */
static int is_main_process(void) {
    char ex[512]; ssize_t k = readlink("/proc/self/exe", ex, sizeof ex - 1);
    if (k <= 0) return 0;
    ex[k] = 0;
    const char *exe = getenv("TS6MOD_EXE"); if (!exe || !*exe) exe = "/opt/teamspeak/TeamSpeak";
    if (strcmp(ex, exe)) return 0;
    char cmd[8192]; int fd = open("/proc/self/cmdline", O_RDONLY | O_CLOEXEC); if (fd < 0) return 0;
    ssize_t n = read(fd, cmd, sizeof cmd - 1); close(fd); if (n < 0) return 0;
    for (ssize_t i = 0; i < n; i += (ssize_t)strlen(cmd + i) + 1) if (!strncmp(cmd + i, "--type=", 7)) return 0;
    return 1;
}

__attribute__((constructor)) static void ts6mod_init(void) {
    init_real();
    if (!is_main_process()) return;
    init_paths();
    /* LD_PRELOAD stays in the environment on purpose: the client re-spawns itself once at start and that
     * second process is the real main process. Children (zygote/renderer/...) are filtered by "--type=". */
    cfg_load(); cfg_clamp(&g_cfg);
    atomic_store(&g_enabled, 0);
    atomic_store(&g_active, 1);
    logf_("ts6mod " VERSION " loaded in main process (ppid=%d)", getppid());
    pthread_t t;
    if (pthread_create(&t, NULL, server_thread, NULL) == 0) pthread_detach(t); else logf_("pthread_create failed");
}

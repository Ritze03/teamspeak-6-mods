/* Stand-in for the TS client's audio path: dlopen()s libpulse, resolves every function via dlsym() (so the
 * ts6mod dlsym interposition is exercised) and plays a deterministic burst signal to a given sink.
 * Run via test/run_hook_test.sh with LD_PRELOAD=libts6mod.so and TS6MOD_EXE=<this binary>. */
#define _GNU_SOURCE
#include <dlfcn.h>
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
typedef struct { int format; uint32_t rate; uint8_t channels; } spec_t;
#define F(ret, name, args) static ret (*name) args
F(void *, pa_mainloop_new, (void)); F(void *, pa_mainloop_get_api, (void *)); F(int, pa_mainloop_iterate, (void *, int, int *));
F(void *, pa_context_new, (void *, const char *)); F(int, pa_context_connect, (void *, const char *, int, void *)); F(int, pa_context_get_state, (void *));
F(void *, pa_stream_new, (void *, const char *, const spec_t *, const void *));
F(int, pa_stream_connect_playback, (void *, const char *, const void *, int, const void *, void *)); F(int, pa_stream_get_state, (void *));
F(size_t, pa_stream_writable_size, (void *)); F(int, pa_stream_write, (void *, const void *, size_t, void (*)(void *), int64_t, int));
F(int, pa_stream_begin_write, (void *, void **, size_t *)); F(int, pa_stream_disconnect, (void *));
static void freecb(void *p) { free(p); }
static int16_t gen(long n) {   /* 1 s period: 0.8 s of -30 dBFS 300 Hz, then 0.2 s of a clipped 200 Hz burst (+6 dB over full scale) */
    long p = n % 48000; double v;
    if (p < 38400) v = 0.0316 * sin(2 * M_PI * 300.0 * (double)n / 48000.0);
    else v = 2.0 * sin(2 * M_PI * 200.0 * (double)n / 48000.0);
    if (v > 1) v = 1;
    if (v < -1) v = -1;
    return (int16_t)lrint(v * 32767.0);
}
int main(int argc, char **argv) {
    const char *sink = argc > 1 ? argv[1] : NULL; int secs = argc > 2 ? atoi(argv[2]) : 12;
    void *h = dlopen("libpulse.so.0", RTLD_NOW); if (!h) { fprintf(stderr, "no libpulse\n"); return 2; }
#define L(n) do { *(void **)&n = dlsym(h, #n); if (!n) { fprintf(stderr, "missing %s\n", #n); return 2; } } while (0)
    L(pa_mainloop_new); L(pa_mainloop_get_api); L(pa_mainloop_iterate); L(pa_context_new); L(pa_context_connect); L(pa_context_get_state);
    L(pa_stream_new); L(pa_stream_connect_playback); L(pa_stream_get_state); L(pa_stream_writable_size); L(pa_stream_write);
    L(pa_stream_begin_write); L(pa_stream_disconnect);
    void *m = pa_mainloop_new(), *ctx = pa_context_new(pa_mainloop_get_api(m), "ts6mod-harness");
    pa_context_connect(ctx, NULL, 0, NULL);
    while (pa_context_get_state(ctx) != 4) { if (pa_context_get_state(ctx) > 4) return 3; pa_mainloop_iterate(m, 1, NULL); }
    spec_t sp = { 3, 48000, 2 };
    void *st = pa_stream_new(ctx, "harness", &sp, NULL);
    pa_stream_connect_playback(st, sink, NULL, 0, NULL, NULL);
    while (pa_stream_get_state(st) != 2) { if (pa_stream_get_state(st) > 2) return 4; pa_mainloop_iterate(m, 1, NULL); }
    const int CH = 960; long n = 0, total = 48000L * secs; int k = 0;
    while (n < total) {
        pa_mainloop_iterate(m, 0, NULL);
        if (pa_stream_writable_size(st) < (size_t)CH * 4) { usleep(2000); continue; }
        if (k++ & 1) {                       /* heap buffer + free callback */
            int16_t *b = malloc((size_t)CH * 4); for (int i = 0; i < CH; i++) b[2 * i] = b[2 * i + 1] = gen(n + i);
            pa_stream_write(st, b, (size_t)CH * 4, freecb, 0, 0);
        } else {                             /* pa_stream_begin_write zero-copy buffer */
            void *p = NULL; size_t sz = (size_t)CH * 4;
            if (pa_stream_begin_write(st, &p, &sz) || sz < (size_t)CH * 4) { usleep(2000); continue; }
            int16_t *b = p; for (int i = 0; i < CH; i++) b[2 * i] = b[2 * i + 1] = gen(n + i);
            pa_stream_write(st, p, (size_t)CH * 4, NULL, 0, 0);
        }
        n += CH;
    }
    usleep(500000); pa_stream_disconnect(st); return 0;
}

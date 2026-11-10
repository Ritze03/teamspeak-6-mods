/* wavproc in.wav out.wav [key=value ...]  -- 16-bit PCM WAV through the ts6dsp chain.
 * Keys: enabled comp target max_gain gate threshold ratio knee attack release makeup lookahead ceiling
 * Output is latency-compensated (same length as input). */
#include "ts6dsp.h"
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

static uint32_t rd32(const uint8_t *p) { return p[0] | p[1] << 8 | p[2] << 16 | (uint32_t)p[3] << 24; }
static uint16_t rd16(const uint8_t *p) { return (uint16_t)(p[0] | p[1] << 8); }
static void wr32(uint8_t *p, uint32_t v) { for (int i = 0; i < 4; i++) p[i] = (uint8_t)(v >> 8 * i); }
static void wr16(uint8_t *p, uint16_t v) { p[0] = (uint8_t)v; p[1] = (uint8_t)(v >> 8); }

static int die(const char *m) { fprintf(stderr, "wavproc: %s\n", m); return 1; }

int main(int argc, char **argv) {
    if (argc < 3) return die("usage: wavproc in.wav out.wav [key=value ...]");
    ts6dsp_params p; ts6dsp_default_params(&p);
    struct { const char *k; float *f; } keys[] = {
        { "target", &p.target_db }, { "max_gain", &p.max_gain_db }, { "gate", &p.gate_db },
        { "threshold", &p.threshold_db }, { "ratio", &p.ratio }, { "knee", &p.knee_db },
        { "attack", &p.attack_ms }, { "release", &p.release_ms }, { "makeup", &p.makeup_db },
        { "lookahead", &p.lookahead_ms }, { "ceiling", &p.ceiling_db } };
    for (int i = 3; i < argc; i++) {
        char *eq = strchr(argv[i], '=');
        if (!eq) return die("arguments after the file names must be key=value");
        *eq = 0; float v = strtof(eq + 1, NULL); int ok = 0;
        if (!strcmp(argv[i], "enabled")) { p.enabled = (int)v; ok = 1; }
        if (!strcmp(argv[i], "comp")) { p.comp_enabled = (int)v; ok = 1; }
        for (size_t k = 0; k < sizeof keys / sizeof *keys; k++) if (!strcmp(argv[i], keys[k].k)) { *keys[k].f = v; ok = 1; }
        if (!ok) { fprintf(stderr, "wavproc: unknown key '%s'\n", argv[i]); return 1; }
    }

    FILE *f = fopen(argv[1], "rb");
    if (!f) return die("cannot open input");
    fseek(f, 0, SEEK_END); long sz = ftell(f); fseek(f, 0, SEEK_SET);
    uint8_t *d = malloc((size_t)sz + 1);
    if (!d || fread(d, 1, (size_t)sz, f) != (size_t)sz) return die("read error");
    fclose(f);
    if (sz < 12 || memcmp(d, "RIFF", 4) || memcmp(d + 8, "WAVE", 4)) return die("not a WAV file");

    int ch = 0, sr = 0, bits = 0, fmt = 0; const uint8_t *data = NULL; uint32_t dlen = 0;
    for (long o = 12; o + 8 <= sz;) {
        uint32_t cl = rd32(d + o + 4);
        if (!memcmp(d + o, "fmt ", 4) && o + 8 + 16 <= sz) {
            fmt = rd16(d + o + 8); ch = rd16(d + o + 10); sr = (int)rd32(d + o + 12); bits = rd16(d + o + 22);
        } else if (!memcmp(d + o, "data", 4)) {
            data = d + o + 8; dlen = cl; if ((long)dlen > sz - o - 8) dlen = (uint32_t)(sz - o - 8); break;
        }
        o += 8 + (long)cl + (cl & 1);
    }
    if (!data || fmt != 1 || bits != 16) return die("only 16-bit PCM WAV is supported");
    ts6dsp *s = ts6dsp_create(sr, ch, &p);
    if (!s) return die("unsupported sample rate / channel count");

    int frames = (int)(dlen / (uint32_t)(2 * ch)), lat = ts6dsp_latency_frames(s);
    size_t total = ((size_t)frames + (size_t)lat) * (size_t)ch;
    int16_t *buf = calloc(total, sizeof(int16_t));
    if (!buf) return die("out of memory");
    for (size_t i = 0; i < (size_t)frames * (size_t)ch; i++) buf[i] = (int16_t)rd16(data + 2 * i);
    float worst_gr = 0, lgmax = -99;
    for (int pos = 0; pos < frames + lat; pos += 480) { /* 10 ms blocks like a realtime caller */
        int n = frames + lat - pos < 480 ? frames + lat - pos : 480;
        ts6dsp_process_s16(s, buf + (size_t)pos * (size_t)ch, n);
        float gr, lg; ts6dsp_get_meters(s, NULL, &gr, &lg);
        if (gr > worst_gr) worst_gr = gr;
        if (lg > lgmax) lgmax = lg;
    }
    int pk = 0;
    uint32_t olen = (uint32_t)frames * (uint32_t)ch * 2;
    uint8_t hdr[44] = "RIFFxxxxWAVEfmt ";
    wr32(hdr + 4, 36 + olen); wr32(hdr + 16, 16); wr16(hdr + 20, 1); wr16(hdr + 22, (uint16_t)ch);
    wr32(hdr + 24, (uint32_t)sr); wr32(hdr + 28, (uint32_t)(sr * ch * 2)); wr16(hdr + 32, (uint16_t)(ch * 2));
    wr16(hdr + 34, 16); memcpy(hdr + 36, "data", 4); wr32(hdr + 40, olen);
    FILE *o = fopen(argv[2], "wb");
    if (!o) return die("cannot open output");
    fwrite(hdr, 1, 44, o);
    for (size_t i = 0; i < (size_t)frames * (size_t)ch; i++) {
        int16_t v = buf[i + (size_t)lat * (size_t)ch]; /* drop the leading latency */
        uint8_t b2[2]; wr16(b2, (uint16_t)v); fwrite(b2, 1, 2, o);
        if (abs(v) > pk) pk = abs(v);
    }
    fclose(o);
    printf("%d Hz, %d ch, %d frames, latency %d frames; out peak %.2f dBFS, worst GR %.1f dB, max leveler gain %.1f dB\n",
           sr, ch, frames, lat, 20 * log10f((float)(pk ? pk : 1) / 32768.f), worst_gr, lgmax);
    free(buf); free(d); ts6dsp_destroy(s);
    return 0;
}

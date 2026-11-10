/* ts6dsp - voice dynamics chain: slow leveler (AGC) -> compressor -> lookahead brickwall limiter.
 * One independent state per audio stream. C11, no dependencies. See README.md. */
#ifndef TS6DSP_H
#define TS6DSP_H
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

typedef struct {
    int   enabled;       /* 0 = bypass (still delayed by latency, crossfaded in 10 ms), 1 = process */
    /* leveler */
    float target_db;     /* target RMS, -40..0, default -20 */
    float max_gain_db;   /* max boost, 0..24, default 12 */
    float gate_db;       /* input RMS below this: leveler holds, -90..-20, default -50 */
    /* compressor */
    float threshold_db;  /* -60..0, default -24 */
    float ratio;         /* 1..20, default 3 (1 = off) */
    float knee_db;       /* 0..24, default 6 */
    float attack_ms;     /* 0.1..200, default 5 */
    float release_ms;    /* 5..2000, default 150 */
    float makeup_db;     /* -12..24, default 4 */
    /* limiter */
    float lookahead_ms;  /* 0..20, default 5. Fixes the latency: only read at create (see README) */
    float ceiling_db;    /* -24..0, default -1. |out| <= this, sample peak */
} ts6dsp_params;

typedef struct ts6dsp ts6dsp;

void    ts6dsp_default_params(ts6dsp_params *p);
/* channels 1..16. Returns NULL on bad args / out of memory. Allocates here, never in process. */
ts6dsp *ts6dsp_create(int sample_rate, int channels, const ts6dsp_params *p);
/* Safe to call from one control thread while another runs process(); applied at the next block
 * boundary. Values are clamped to their ranges. lookahead_ms is ignored here (fixed at create). */
void    ts6dsp_set_params(ts6dsp *s, const ts6dsp_params *p);
/* Clear all runtime state (delay lines, meters, smoothed gains) to the just-created state, keeping
 * the allocations, sample_rate/channels and current params. No allocation; safe to call from the
 * audio thread. Used to repurpose a pooled instance for a new speaker (see per-speaker-hook.md). */
void    ts6dsp_reset(ts6dsp *s);
void    ts6dsp_process_f32(ts6dsp *s, float *interleaved, int frames);
void    ts6dsp_process_s16(ts6dsp *s, int16_t *interleaved, int frames);
int     ts6dsp_latency_frames(const ts6dsp *s);
/* Meters of the last processed block; any pointer may be NULL.
 * gain_reduction_db: compressor + limiter reduction (>= 0, worst point of the block). */
void    ts6dsp_get_meters(const ts6dsp *s, float *in_db, float *gain_reduction_db, float *leveler_gain_db);
void    ts6dsp_destroy(ts6dsp *s);

#ifdef __cplusplus
}
#endif
#endif

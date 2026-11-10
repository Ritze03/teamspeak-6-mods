/* ts6hook - per-speaker (per incoming voice stream) compressor/limiter for the TeamSpeak 6 client.
 *
 * Inline-hooks the internal, non-exported function that receives one sender's decoded PCM block
 * (int16 mono, 10 ms frames at codec rate) before it is resampled and mixed. The function is found
 * at runtime by a byte signature (never a hardcoded address); the detour runs one ts6dsp instance
 * per sender over the block in place, then calls the original. See superdoc/features/per-speaker-hook.md.
 *
 * All functions here are called only from the TeamSpeak main process (ts6mod.c gates that). The
 * detour runs on the client's audio/mix thread; everything else runs on the control (HTTP) thread. */
#ifndef TS6HOOK_H
#define TS6HOOK_H
#include <stddef.h>
#include <stdint.h>
#include "dsp/ts6dsp.h"

/* bitmask for the per-speaker parameter override (which ts6dsp_params fields are set).
 * lookahead_ms is deliberately absent: a per-speaker lookahead would need a different delay-line
 * length per instance; the global lookahead is used for every speaker. */
enum {
    TPM_TARGET    = 1u << 0,
    TPM_MAXGAIN   = 1u << 1,
    TPM_GATE      = 1u << 2,
    TPM_THRESHOLD = 1u << 3,
    TPM_RATIO     = 1u << 4,
    TPM_KNEE      = 1u << 5,
    TPM_ATTACK    = 1u << 6,
    TPM_RELEASE   = 1u << 7,
    TPM_MAKEUP    = 1u << 8,
    TPM_CEILING   = 1u << 9,
};

typedef struct {
    int      clear;        /* override == null: remove the per-speaker override entirely */
    int      has_enabled;  int   enabled;   /* process this speaker at all (default 1) */
    int      has_gain;     float gain_db;   /* extra output gain in dB (boost past the stock limit) */
    uint32_t param_mask;   ts6dsp_params params; /* only the masked fields are valid */
} ts6hook_override;

/* ts6mod.c -> ts6hook: the global config. base = the whole-stream ts6dsp params; per_speaker is the
 * resolved mode (enabled && mode=="per_speaker"). Installs the hook the first time per_speaker is 1
 * (lazy), updates the pool params, and sets whether the detour processes. Called on the control
 * thread under ts6mod's g_ctl. Safe to call repeatedly. */
void ts6hook_set_config(const ts6dsp_params *base, int per_speaker);

/* control thread: set / clear a per-speaker override, keyed by client_id (per session). schid is
 * stored for display only. */
void ts6hook_set_override(uint32_t client_id, int schid, const ts6hook_override *ov);

/* status fields for /status (control thread). */
void ts6hook_status(int *installed, uint64_t *match_addr, int *active, int *speaker_count, float *added_latency_ms);

/* JSON array body for GET /speakers (control thread). Returns bytes written (snprintf semantics). */
int  ts6hook_speakers_json(char *out, size_t cap);

#endif

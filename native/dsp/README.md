# ts6dsp

Small C11 voice dynamics library, no dependencies: **leveler (slow AGC) -> compressor -> lookahead
brickwall limiter**. One `ts6dsp` state per audio stream (whole mix now, per speaker later).
Linked detection: all channels get the same gain. No allocation, locks or syscalls in `process`.

    make lib       # libts6dsp.a (-fPIC, linkable into a shared lib)
    make test      # self-test, exit code != 0 on failure
    make wavproc   # ./wavproc in.wav out.wav [key=value ...]   (16-bit PCM, mono/stereo)

Example: `./wavproc in.wav out.wav ratio=4 lookahead=10 makeup=6`. Keys: `enabled target max_gain
gate threshold ratio knee attack release makeup lookahead ceiling`. Output is latency-compensated.

## Parameters (`ts6dsp_params`; values are clamped to the range)

| field | range | default | meaning |
|---|---|---|---|
| enabled | 0/1 | 1 | 0 = bypass (delayed by the same latency, 10 ms crossfade) |
| target_db | -40..0 | -20 | leveler target RMS |
| max_gain_db | 0..24 | 12 | max leveler boost (cut is fixed at -12) |
| gate_db | -90..-20 | -50 | input RMS below this: leveler holds, silence/noise is not pumped up |
| threshold_db | -60..0 | -24 | compressor threshold (peak level) |
| ratio | 1..20 | 3 | 1 = no compression |
| knee_db | 0..24 | 6 | soft knee width |
| attack_ms / release_ms | 0.1..200 / 5..2000 | 5 / 150 | |
| makeup_db | -12..24 | 4 | |
| lookahead_ms | 0..20 | 5 | limiter lookahead = latency; read **only at create** |
| ceiling_db | -24..0 | -1 | output sample peak never exceeds this |

`ts6dsp_set_params` may be called from a control thread while `process` runs; it is applied at the
next block boundary. Attack/release/threshold/ratio/knee/target/gate changes are click-free (the
smoothed gain states carry over); makeup and `enabled` are ramped over 10 ms. Lowering
`ceiling_db` takes effect immediately; samples already in the delay line are caught by a final
clamp (can click once, rare).

## Latency

`ts6dsp_latency_frames()` = round(lookahead_ms * rate / 1000), constant for the life of the state
(5 ms default = 240 frames at 48 kHz), also when bypassed. To change the lookahead, destroy and
create a new state.

## Why

- **Order leveler -> compressor -> limiter.** The leveler is slow (boost tau 1.5 s, cut 0.3 s), so
  it only evens out speaker/mic distance. The compressor handles syllable-scale dynamics on an
  already-sane level, so its threshold means the same for every speaker. The limiter comes last
  because only it can promise a ceiling; everything before it may overshoot at speech onset (the
  "peaky AGC" problem), the limiter sees that overshoot before it is heard.
- **Fixed latency instead of live lookahead changes.** Changing the delay line length while
  running shifts the audio and clicks. A constant delay chosen at create has no such artefact; a
  rare lookahead change costs one re-create, which the caller can crossfade.
- **Limiter** = per-sample required gain -> sliding window min over `L = D+1` samples -> box
  average over `L`. The average of window minima is provably <= the requirement of the sample
  being output, so the gain is fully down before the peak arrives, with a smooth ramp rather than
  a hard cut. A 50 ms release envelope (fixed) is applied before the min filter. With lookahead 0
  the gain is instant (L=1). The final clamp exists for float rounding and ceiling changes only;
  removing it still passes the tests.
- Leveler gain is computed from the **input** RMS (feed-forward) and only moves when the input is
  above the gate.

## Known limitations

- Leveler boost during pauses with noise above the gate raises the noise; raise `gate_db` for noisy mics.
- The compressor detector is peak-based (10 ms decay); threshold is a peak level, not RMS.
- Simplifications are marked `ponytail:` in `ts6dsp.c` (per-sample log/exp, fixed limiter release, seqlock param hand-off for a single writer thread).

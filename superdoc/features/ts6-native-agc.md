# The client's own playback AGC (two modes)

What TeamSpeak 6 (6.0.0-beta5.1, Linux) does by itself to level other users' voices, measured black-box on the
[test rig](test-rig.md) with our module off. Written to compare with and tune our AGC
([agc.md](agc.md), `native/dsp/ts6dsp.c`). Status: behaviour measured; the internal implementation is **inferred**, the
disassembly was not completed (see Unknown).

Related: [ts6-modding-surface.md](ts6-modding-surface.md#audio-controls-from-js) (how the keys are set from JS),
[per-speaker-hook.md](per-speaker-hook.md).

## The two options

| | Stock "AGC" | "Experimental mode" |
|---|---|---|
| UI | Settings -> Audio -> Playback: "Automatic Gain Control" ("Automatically level the volume of other users") | Hidden developer card: "Playback AGC Experimental Mode" (`settings.dev.agc_experimental`; "may be removed at any time") |
| UI model key | `audioSettings[Out].devices[<device>].agc`, default `true` | `audioSettings[Out].global.agcExperimentalMode`, default `false` |
| Native key | `setPlaybackConfigValue(schid, 'agc', ...)` | `setPlaybackConfigValue(schid, 'agc_experimental_mode', ...)` |
| Scope | playback only (capture has its own `agc` via `setPreProcessorConfigValue`, a Speex preprocessor, default on, unrelated) | playback only |

Experimental mode is a **modifier of the AGC, not an independent AGC**: with `agc=false` and `agc_experimental_mode=true`
the output level was the same as everything off (rig runs `expOnly_*`: no change). So the states are
off / legacy (`agc` only) / experimental (`agc` + `agc_experimental_mode`).

## Where it sits

Native class `com::teamspeak5::audio::playback::Agc` (RTTI `N3com9teamspeak5audio8playback3AgcE`, created through
`make_shared`), next to `playback::Cng` (comfort noise), `playback::I_Dsp` / `I_Playback_Client_Dsp` and
`Playback_Manager`. It runs before `pa_stream_write` (our whole-stream AGC sees its output).

Per sender or on the mix (rig, two talkers at once: 440 Hz tone at -33 dBFS peak from A, 1 kHz tone at -12 dBFS from B,
measured per frequency; solo = the same tone alone):

| mode | A (440 Hz) solo -> together | B (1 kHz) solo -> together |
|---|---|---|
| legacy | -20 (+13 dB) -> -32 (+1) | -19 (-7) -> -18 (-6) |
| experimental | -21.6 -> -21.8 | -10.2 -> -10.2 |

- **Experimental = per sender**: each talker gets exactly the gain it gets alone, independent of the other.
- **Legacy = not independent per sender**: A loses 12 dB of its solo gain while B is present, so a state/level estimate is
  shared across talkers (consistent with the mix, or a shared estimator). The gain applied is not one common linear factor
  either (A +1 vs B -6 while their input differs by 21 dB, output differs by 14), so some compressive curve is in the path.
  Confidence medium; mix-level is the simplest reading.

## Measured behaviour (peak dBFS of a sine, rig; input -> output)

Legacy (`agc` on, experimental off), steady state:

| input peak | output peak | gain |
|---|---|---|
| 0 (clipped sine) | -19 | -19 |
| -12 | -18/-19 | about -6 |
| -24 | -19 | +5 |
| -33 | -20, still rising at 8 s | +13 |
| -45 | -39.8, still rising | +5 |
| -57 | -49.5 | +7 |

- Target about -19 dBFS peak (about -22 dBFS RMS) for steady material above about -35; it never boosts a loud signal.
- **Fast down, slow up**: loud onset is pulled down about 6-9 dB within the first 0.5 s and 15 dB within 1 s; upward gain
  rises about 1 dB/s (-33 tone: -26, -25, -24, -22.9, -20.9, -20 at 0.5, 1, 2, 3, 5, 8 s).
- **Gain is held, not released, across quiet**: after 5 s at -12 (gain -6) a 9 s tone at -48 stayed at -54 (still -6),
  no release in 9 s; the gain also carries over between separate talk bursts (start level of each run depends on the
  previous run). Quiet levels (-45, -57) climb only slowly and not to the target: speech that is quiet *and* low (below
  about -40 dBFS peak) is hardly lifted.
- Speech WAVs: `quiet.wav` (RMS -35 / peak -21) rose per word (1.5 s apart) -35, -32, -30, -27, -25, -24, -24, -24 dB word
  RMS, i.e. +11 dB in about 7 s; `bursty.wav` (RMS -27 words, 15 ms onset spike at -0.2 dBFS) was **lowered** to -35 on the
  first word and crept to -30 (the spike drives the gain down, speech body ends 3-8 dB below plain).

Experimental (`agc` + `agc_experimental_mode`):

| input peak | output peak | gain |
|---|---|---|
| 0 (clipped) | -0.1 .. -0.6 | 0 (limited) |
| -12 | -10.2 | +1.8 |
| -24 | -14.4 (ramp -21.2, -17.7, -16.4, -15.6, -14.4 over 5 s) | +9.6 |
| -33 | -21.6 | +11.4 |
| -45 | -33.4 | +11.6 |
| -57 | -44.7 | +12 |

- Static-looking curve: **max gain about +12 dB**, compressing toward about -10 dBFS peak (about -13 RMS), hard ceiling
  near 0 dBFS (no clipping seen). Much louder than legacy: `bursty.wav` words -28 -> -21 RMS, `quiet.wav` -35 -> -28 RMS.
- Gain is present **immediately** at stream start (+10 dB at the first block, then it settles), no 1-5 s ramp from unity
  like legacy; it adapts slowly afterwards (about -1.5 dB/s down after a loud start, up to +8 about 9 s later after loud ->
  quiet). Step test -12 / -48 / -12: first 5 s output -2, -5, -7, -8, -9; quiet 9 s -46 .. -40; loud again -1, -2, -4, -7, -8, -9.
- Quiet sections of `bursty.wav` between words stay raised by the same gain (inter-word floor and reverb tails are lifted
  as much as speech; there is no gate visible at these levels).

Level-reading caveat: all numbers are sine peaks or WAV word RMS after the Opus path (about -1 dB). Latency was not
measured; neither mode showed an obvious lookahead.

## What they probably are (inference, no disassembly)

- The binary statically contains the WebRTC AudioProcessing config printer with `gain_controller1`, `adaptive_digital`,
  `gain_controller2`, `fixed_digital: { gain_db`, `compression_gain_db`, `target_level_dbfs`, `enable_limiter`,
  `initial_gain_db`, `max_gain_change_db_per_second`, `max_gain_db`, `headroom_db`, `SaturationProtectorImpl`,
  `webrtc::Agc`, `modules/audio_processing/gain_control_impl.cc` (the legacy WebRTC AGC1), and `WebRTC-Agc2*` field-trial
  names. So WebRTC AGC1 and AGC2 code is present; whether `playback::Agc` calls it or implements its own curve was not shown.
- Legacy behaviour (target ~-19 peak, fast attack, ~1 dB/s release, state held, fixed target) is **consistent with
  WebRTC AGC1 adaptive digital** (`target_level_dbfs`, `compression_gain_db`, limiter), applied on the playback side.
  Experimental behaviour (per-sender, initial gain +10 at start, slow adaptation, max +12 dB, ceiling near 0) is
  **consistent with an AGC2-style adaptive digital gain with an initial gain and a fixed-digital limiter**. Both are
  hypotheses (confidence low-medium); do not cite them as fact.

## How they interact with ours

- Our AGC ([agc.md](agc.md)) acts after the stock one (whole mode at `pa_stream_write`; per-speaker mode at the per-sender
  hook `playback_sender_data`). With the stock AGC on, we level material that was already levelled: two AGCs chase each
  other (ours sees the stock gain move slowly up on every pause and tail). Compare ours against a baseline recorded with
  `RIG_STOCK_AGC=off`; test both with the stock AGC off before judging ours.
- Stock legacy AGC lowers loud onsets within 0.5-1 s and then holds that gain through pauses; a fast limiter/leveler of
  ours on top sees each word start 6-9 dB too loud at first.
- The rig default is stock AGC on (`RIG_STOCK_AGC=off` to disable); the experimental flag is never set by the rig.

## Tuning lessons for ours

- **Echoey sound**: the experimental mode's behaviour shows what causes it: constant +12 dB max gain applied also to the
  low-level material between words, so reverb tails and room noise are lifted by the same amount as speech. A leveler
  that rises quickly in pauses does the same; keep our upward rate slow (about 1 dB/s like legacy) and hold (do not
  release) gain when the input drops below the speech floor.
- Legacy shows the useful property: fast down, slow up, gain held across quiet; and the cost: a short onset spike drives
  the gain down for seconds (here the whole body of `bursty.wav` came out 3-8 dB quieter). Run the level detector on a
  slightly smoothed / RMS-like envelope, with the limiter (not the leveler) catching spikes.
- Experimental's immediate +10 dB at stream start avoids the "first words too quiet" problem of legacy; a sender-specific
  initial gain is an option for us.
- Per-sender processing (experimental) keeps a quiet talker audible next to a loud one; legacy's shared gain does not
  (A got only +1 dB with B present).

## Unknown

- Whether `playback::Agc` uses WebRTC code or its own; exact parameters (target level, compression gain, limiter flag,
  max gain 12 dB measured only as an upper plateau). A static xref from the key strings (`agc_experimental_mode` at file
  offset `0x7ed44b`) to code was not found (no rip-relative or absolute reference in `objdump -d`, so the key is likely
  built through an indirect table); the REA session timed out on the 80 MB binary.
- Added latency of either mode; behaviour with speech-VAD gating; behaviour on stereo / 3D-positioned senders.
- Measurements are single runs on one machine (tones and two synthetic speech WAVs); gain state carries over between
  runs, so the first seconds of each run show the previous run's end state.

## Method (reproduce)

Rig up with `RIG_STOCK_AGC=off tools/rig/rig up`, then per run set both keys on the listener over CDP 9230
(`setPlaybackConfigValue(h.id, 'agc', ...)` then `'agc_experimental_mode'`), `rig talk A <wav> &` and
`rig record 15 out.wav`. Tones: ffmpeg `sine=f=440` with `volume=` to reach the wanted peak; analysis: numpy RMS / peak per
window, or a single-frequency correlation for the two-talker case.

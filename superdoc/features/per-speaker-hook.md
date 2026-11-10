# Per-speaker compressor/limiter (per incoming voice stream)

Second audio mod. Runs the [ts6dsp](../../native/dsp/README.md) chain (leveler -> compressor ->
lookahead limiter) **once per sender**, on each speaker's decoded PCM *before* it is resampled and
mixed, instead of once on the whole mix (that is the [AGC mod](agc.md)). This fixes the two problems
the whole-mix path cannot: everyone is leveled independently (one loud speaker no longer pumps the
others down), and the start-of-speech peak is caught per speaker by that speaker's own limiter.

TeamSpeak 6 has no plugin API (the TS3 SDK's `onEditPlaybackVoiceDataEvent` hook is gone), so we
reach the per-sender PCM by **inline-hooking** an internal function of the statically-linked, stripped
client, found at runtime by a byte signature. Nothing on disk is modified.

Related: [agc.md](agc.md) (whole-stream mod, shared control API and DSP), [test-rig.md](test-rig.md)
(how this was verified with known talkers), [ts6-modding-surface.md](ts6-modding-surface.md).

Code: `native/ts6hook.c` (`native/ts6hook.h`), driven from `native/ts6mod.c`. Built into the same
`native/libts6mod.so`.

## The hook site

The hooked function (we call it `playback_sender_data`) receives **one sender's decoded block**:

| arg | reg (SysV) | meaning |
|---|---|---|
| sender | `rdi` | per-sender object pointer (stable for the stream's life) |
| pcm | `rsi` | int16 interleaved samples, writable in place |
| frames | `edx` | frame count — one block (observed 960 = 20 ms at 48 kHz on `6.0.0-beta5.1`; the code handles any count) |
| channels | `ecx` | channel count; the function itself bails unless `== 1` (mono) |
| rate | `r8` | codec sample rate (48000) |

Confirmed by `objdump` of the prologue and by the live probe (below): the function bails to its
epilogue when `channels != 1` or when `byte[[rdi]+0x3be4] == 0`; `rsi`/`edx`/`r8` carry the block.
It has two direct callers; one hook covers both (both reach the same entry with this ABI).

**Why hook here and not at the mixer or the per-client volume multiply.** This is the one place that
sees a *single* sender's samples, already decoded to linear PCM, still separate, with a writable
buffer, and it runs before resample+mix so our processed samples flow downstream unchanged (the first
caller passes the same `pcm`/`frames`/`channels`/`rate` straight into the mix path right after our
detour returns). The per-client *volume* multiply (the stock volume slider) happens later and
elsewhere; applying an override gain here therefore boosts a speaker *past* the stock slider cap.

### Finding it (signature, never an address)

`g_target` is located at load time by scanning the main executable's executable mappings
(`/proc/self/maps`, the segments backed by `/proc/self/exe`) for this 35-byte signature
(`SIG` in `ts6hook.c:find_target`):

```
55 41 57 41 56 41 55 41 54 53 48 81 EC A8 01 00 00   push rbp/r15/r14/r13/r12/rbx ; sub rsp,0x1a8
4C 89 44 24 20                                       mov [rsp+0x20],r8            (save rate)
48 8B 07                                             mov rax,[rdi]               (vtable/first member)
0F B6 80 E4 3B 00 00                                 movzx eax,byte [rax+0x3be4]
83 F9 01                                             cmp ecx,1                   (channels == 1 ?)
```

The 17-byte prologue alone is *not* unique (98 hits in `6.0.0-beta5.1`); the longer signature matches
**exactly once** (file offset `0x4554f10`, runtime VA printed in `/status.per_speaker.hook_addr`).
Install refuses unless the match count is exactly 1. `native/test/sigscan.sh` performs the same
on-disk check (`${TS6MOD_TS_BIN:-/opt/teamspeak/TeamSpeak}`) and exits 0 iff one match.

**Why a signature, not an offset.** The client is updated often (the binary was rebuilt the day of
this work; the previous worker's recorded offsets had already drifted). An address is dead on the next
build; a signature keyed on the function's own shape survives any relink that leaves the shape intact.

## Detour mechanics

Classic inline trampoline hook (`ts6hook.c:install`):

1. **Trampoline** (an anonymous RWX page): the original 17-byte prologue copied verbatim (it is
   position-independent — six `push`es and `sub rsp,0x1a8`, no rip-relative bytes), followed by a
   14-byte absolute jump back to `g_target + 17`. Calling the trampoline runs the real function.
2. **Patch**: `g_target`'s first 16 bytes become a 14-byte absolute jump to our `detour`
   (`FF 25 00000000 <abs64>`) + two `nop`. The jump is absolute, so the detour may live anywhere
   (the `.so` is far from the exe; a rel32 jump would not reach).
3. Written **tail-first, then the leading qword in one atomic 8-byte store**, so the `FF 25` opcode
   only becomes visible once the full jump operand is already in place (`g_target` is 16-aligned).

`detour` is entered by `jmp` (so the stack is exactly the caller's), processes, then `return
g_trampoline(sender, pcm, frames, channels, rate)` — the compiler re-marshals the five args into
`rdi/rsi/edx/ecx/r8`, the trampoline runs the real body, and its `ret` returns through the detour to
the caller. The hook adds no stack frame the original did not have.

**Why inline-hook and not `LD_PRELOAD`/`dlsym` interposition** (as the whole-stream path uses): this
function is internal to the statically-linked audio core — it is never resolved through `dlsym` and
has no exported symbol, so the interposition trick that catches `pa_stream_*` cannot see it. An inline
detour is the only way in without patching the file on disk.

**Lazy install (vanilla guarantee, rule D7).** Nothing in memory is patched until per-speaker mode is
**first enabled**. With `enabled:false` or `mode:"whole"` the hook is never installed and the client
is byte-for-byte vanilla. Once installed it stays installed (un-patching a live function is riskier
than leaving it); when per-speaker is then turned off, `g_active` goes 0 and `detour` is a pure
passthrough — it calls the original with the untouched buffer, so audio is unchanged, `/status`
reports `active:false` and `added_latency_ms:0`.

**Known patch-window caveat.** The two writes that install the patch are not a single atomic
operation across the whole 16 bytes; there is a sub-microsecond window during which a thread entering
the function could execute a half-patched prologue. Install happens on the control thread the moment
the user enables per-speaker mode (a deliberate, one-time action), so the window is vanishingly
unlikely to be hit. Documented rather than solved (stopping every thread to patch is not worth it
here).

## The sender object

- **clientId**: `uint32` at `sender + 0x30` (`CID_OFFSET` in `ts6hook.c`; the object also mirrors it at 0x120/0x140/0x190). This is the
  per-session TeamSpeak clientId (1,2,3,… by connect order), the same id the UI knows. Confirmed with
  the rig: the talking sender's field read 2 for RigTalkerA and 3 for RigTalkerB.
- **not** the clientId: `sender + 0x168` holds the sample rate (48000) — the previous worker's
  "clientId candidate" guess; corrected here by the probe.

### Probe (for the next client update)

Build is permanent and env-gated: launch the listener with `TS6HOOK_PROBE=1` and enable per-speaker
mode. While a sender's block is above -40 dBFS RMS (i.e. actually talking) the detour logs, once a
second per thread, every `uint32` field in `[sender, sender+0x800]` whose value is a small integer
(1..64) — the clientId is the field that reads the talker's known clientId. Play one talker at a time
(`tools/rig/rig talk A bursty`) and read `…/state/ts6-mods/ts6mod.log`. Re-confirm `CID_OFFSET` this
way after any client update; if it moved, update the constant.

Rig invocation (the rig inherits the environment): `TS6HOOK_PROBE=1 RIG_STOCK_AGC=off tools/rig/rig up`, then enable per-speaker mode
and play one talker at a time as above.

## Per-speaker engine

- **Pool.** When per-speaker is first enabled, a pool of `MAX_SPEAKERS` (32) `ts6dsp` instances is
  pre-created at 48 kHz mono with the current params (control thread). The audio thread never
  allocates.
- **Routing.** `detour` reads the clientId, finds its slot (`lookup`) or claims one (`claim`: a free
  slot via CAS, else evict the least-recently-seen slot). A claimed slot's pooled DSP is
  `ts6dsp_reset` (allocation-free) and configured from base params + this speaker's override.
- **Processing.** If the slot is active, `ts6dsp_process_s16` runs in place; then the override's extra
  gain (if any) is applied and re-clamped to the DSP ceiling, so the ceiling guarantee holds even with
  a boost. Then the original is called. **The ceiling is per speaker, before the mix**: simultaneous speakers can sum above it
  (measured: ceiling -6 dB, two talkers at once -> mixed peak -4.9 dBFS; whole-stream mode on the same run: -6.0). Whole-stream mode
  guarantees the ceiling on the mix, so combine it with per-speaker levelling when a hard mix ceiling matters. Per-speaker meters (in dB, gain reduction, leveler gain, out
  peak) are stored atomically for `/speakers`.
- **Threading.** `playback_sender_data` runs on the client's audio/mix thread. Slot claim uses atomic
  CAS so it is safe even if more than one audio thread ever calls in; meters/override fields the
  control thread touches are atomics or seqlock-guarded. The audio path takes no lock and (outside the
  env-gated probe) makes no syscall.

### Lookahead and flush

Each per-sender DSP adds a constant `lookahead_ms` delay (default 5 ms = 240 frames), reported as
`added_latency_ms`. The last `D` frames of an utterance sit in the delay line when the speaker stops.
**We do not reset the DSP between a speaker's utterances** — the slot (and its delay line) persist for
the clientId — so that tail simply comes out, delayed by `D`, at the start of the speaker's next
block. No frames are lost; the only cost is the constant `D`-frame delay. **Bounded tail loss**
happens only when a slot is LRU-evicted to make room for a 33rd concurrent speaker: that speaker's
≤ `lookahead_ms` (≤ 20 ms) tail is dropped. `MAX_SPEAKERS` = 32 makes this rare (TS channels rarely
have 32 simultaneous talkers).

**Why persist, not flush with silence.** We can only process the blocks the client hands us; there is
nowhere to emit extracted tail samples between utterances. Keeping the delay line is the real
no-loss solution; a silence-flush would merely discard the same tail earlier.

## Config

In `$XDG_CONFIG_HOME/ts6-mods/agc.json` (shared with the AGC mod, `cfg_*` in `ts6mod.c`):

- **`enabled`** (bool, default false) — master switch (both mods).
- **`mode`** (`"whole"` | `"per_speaker"`, default `"whole"`) — `"whole"` = existing whole-stream DSP
  at `pa_stream_write`; `"per_speaker"` = this hook, and the whole-stream path then passes through.
- The `ts6dsp` params (`target_db`, `ratio`, `lookahead_ms`, `ceiling_db`, …: see
  [dsp/README.md](../../native/dsp/README.md)) are the **base** params; per-speaker overrides layer on
  top.

The old `dashboard_button` key was **removed** from the native config (the UI owns that switch now; it
was never read on the native side).

## Control API additions (loopback only, same Origin/Host hardening as agc.md)

| Request | Result |
|---|---|
| `GET /status` | gains `config_mode` and a `per_speaker` object: `{hook_installed, hook_addr:"0x…", active, speakers, added_latency_ms}`. Existing fields unchanged. |
| `GET /speakers` | `[{client_id, schid, active, frames, rate, channels, in_db, gain_reduction_db, leveler_gain_db, out_peak_db, override}]` — live per-speaker meters for the UI (one entry per known sender this session). |
| `POST /speaker` | `{client_id, (schid), override: {enabled?, gain_db?, params?:{…}} \| null}`. Sets or (`null`) clears a per-speaker override. `params` may be any subset of the `ts6dsp` params **except `lookahead_ms`** (per-speaker lookahead is not supported — all speakers share one delay-line length; use the global `lookahead_ms`). Answers `{ok,client_id}`. |

Override semantics:
- `enabled:false` — this speaker is not processed (passed through); with a `gain_db` it is still
  boosted (plain gain, clamped to full scale, no dynamics).
- `gain_db` — extra output gain in dB, applied after the DSP and clamped to the ceiling (boost a quiet
  speaker past the stock volume slider while keeping the ceiling).
- `params` — the given fields replace the base params for this speaker (a bitmask, `TPM_*`); unset
  fields keep the base value, so changing the global config still moves the speaker's unset params.

**Persistence (decision).** Overrides are kept **per session, keyed by clientId**, in the native
module only — clientIds are not stable across reconnects, so persisting them natively would be wrong.
The **UI persists overrides by UID** and re-pushes `{client_id → override}` over `POST /speaker` on
connect / when a client joins (it knows the UID↔clientId mapping; the native side does not). An
override set for a clientId that is not currently talking is stored and applied the moment that
clientId's first block arrives.

## Testing

- `make -C native/dsp test` — DSP self-test (unchanged; also exercises `ts6dsp_reset` via the pool).
- `native/test/run_hook_test.sh` — whole-stream passthrough/ceiling (mode `whole`, unaffected).
- `native/test/sigscan.sh` — the signature is present exactly once on disk.
- **Rig** ([test-rig.md](test-rig.md)): `RIG_STOCK_AGC=off tools/rig/rig up`, then
  `curl -s -X POST -d '{"enabled":true,"mode":"per_speaker"}' 127.0.0.1:39001/config`.
  `rig talk A bursty & rig record 14 out.wav; wait`, measure with `ffmpeg … volumedetect`. A's recorded
  peak stays at/under the configured `ceiling_db`; a quiet talker is raised toward `target_db`
  independently; a `POST /speaker {client_id, override:{enabled:false}}` leaves that talker untouched
  while the other is still processed.

## What to do when the signature no longer matches (after a client update)

1. `native/test/sigscan.sh` prints 0 (or >1) matches → the hook will refuse to install (safe: the
   module stays pure passthrough, `/status.per_speaker.hook_installed:false`).
2. Find the new `playback_sender_data`: disassemble around the old area, or search for the
   `movzx eax,[rax+0x3be4]; cmp ecx,1` core (`0F B6 80 E4 3B 00 00 83 F9 01`) which is the function's
   fingerprint, and re-derive a fresh unique signature from its prologue. Update `SIG` in `ts6hook.c`
   and the hex in `sigscan.sh`.
3. Re-run the `TS6HOOK_PROBE=1` probe to re-confirm the ABI and `CID_OFFSET` (object layout can shift).
4. If the prologue shape changed (different `push`/`sub`), update `PROLOGUE_LEN` and re-check that the
   relocated bytes are still position-independent.

## Known limits

- 48 kHz mono blocks only (the codec path); a block at another rate/channel count is passed through
  (guarded in `detour`). The function already bails on non-mono itself.
- Max 32 simultaneous speakers; beyond that the least-recently-active is evicted (≤ 20 ms tail loss).
- The sub-µs patch-install window (above).
- clientIds are per session; overrides do not survive a reconnect on the native side (the UI re-pushes).
- `mode` is mutually exclusive: `whole` and `per_speaker` do not run at once (per-speaker supersedes
  the whole-mix path, which would otherwise double-process).

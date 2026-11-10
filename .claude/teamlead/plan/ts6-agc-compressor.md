# Better AGC / compressor-limiter for TeamSpeak 6

> **Stage 5** — building (one phase, I1–I14) · started 2026-11-10
> Next: build everything, run the agent checks, then hand you the test guide.

## Goal
A modded TS6, made of a CDP-injected UI plus an `LD_PRELOAD` native module, with:
- a **per-user (per incoming voice stream) compressor/limiter AGC** that is deeply customizable for tuning;
- a set of **toggleable UI mods**.

Every feature is individually switchable. With everything off, the client is vanilla.

## Context
User's ask: a well-functioning per-user (per incoming stream) compressor/limiter for TS6 with simple settings, ideally configurable in the TS6 UI (plugin); replaces TS6's peaky built-in AGC. Find a way in via online research + reverse engineering (TS6 plugin API barely documented). Out-of-the-box approaches welcome. Longer term: more TS6 customization.

**Machine:**
- TS6 **`6.0.0-beta5.1`** is now installed (local PKGBUILD bump of AUR `teamspeak`; binary md5 `93efb8eb…`), together with TS3 `3.6.2`. All RE below was done on beta5 (md5 `0d2f15bb…`).
- **The Spike A signature still matches exactly once in beta5.1.** The full pattern is at file `0x4554f10` (it was `0x44ebd60`), so offsets moved and the byte-signature approach works.
- The user's installed themes include `graphite` and `aurora`, which share one layout.

**Web research (row 3):**
- UI is most likely **CEF** (Chromium Embedded), not Electron; web UI (`index.html`, `vendor.js`). No official TS6 plugin SDK, no JS addon/theme API; most TS3 native plugins reportedly don't work in TS6. [Plugin support thread](https://community.teamspeak.com/t/plugin-support/55200), [supercraft FAQ](https://supercraft.host/wiki/teamspeak/teamspeak6_features/)
- Community mods inject JS/CSS into `index.html` via [TS6AddonInstaller](https://github.com/Exopandora/TS6AddonInstaller): it patches the client's file-validation and domain-validation checks; addons must be reinstalled after each TS update. Example: [BetterChat](https://github.com/Exopandora/BetterChat). No audio-processing mod or native TS6 plugin exists.
- TS3 SDK had exactly the hook we want: `onEditPlaybackVoiceDataEvent(schid, clientID, samples, …)` gives per-client 16-bit/48 kHz PCM before mixing; plus `setClientVolumeModifier` (per-client dB). [ClientSDK docs](https://teamspeakdocs.github.io/ClientSDK/client_html/ar01s18.html)
- TS6 has an "Automatic Gain Control for Other Users" toggle (receive-side). The known **start-of-speech peaking bug** (TS 3.6.x and 6.0 betas) happens with AGC on or off. Staff say "still on our list" (2025-12). [peaking thread](https://community.teamspeak.com/t/teamspeak-3-6-0-and-6-0-0-sound-peaking-problem/41168?page=6)
- Remote Apps websocket (`ws://localhost:5899`): auth + `buttonPress` for bound hotkeys, plus state events (talk status, clients, channels). It has **no audio or volume control**. [thread](https://community.teamspeak.com/t/teamspeak-remote-apps/23250)
- Outside the client, EasyEffects/PipeWire filter-chain can compress TS's output, but only the **one mixed stream**, not per speaker. No per-speaker export path exists.

**Local RE (row 2; raw dumps in `~/tmp/ts6-re/`):**
- **Stack:** CEF host plus native C++ core. The voice/audio core is **statically linked** into the stripped 80 MB PIE `/opt/teamspeak/TeamSpeak` (built with conan). Its only dynamic exports are zlib/libc, so it has **no plugin API surface**. It finds no TS3 plugin loading (0 hits for `ts3plugin`/`onEditPlaybackVoiceData`).
- **UI:** plain files in `/opt/teamspeak/html/client_ui/` (`index.html`, `main.js` = Vue 2, 10.8 MB minified), served as `tsui://default/`. No asar. They are root-owned and overwritten by package updates. The binary embeds sha512 hashes of these files, and the hash check is enforced (see Spike B).
- **Official extensions** (`/opt/teamspeak/docs/Extensions.md`): `~/.config/TeamSpeak/Default/extensions/<id>/package.json`, **CSS themes only**, "alpha". Remote Apps doc: events + hotkeys, no audio.
- **Audio:** ALSA (linked), PulseAudio and PipeWire (dlopen). The client mixes internally and emits **one sink-input**, currently routed into an EasyEffects sink. WebRTC APM (AGC1/AGC2, limiter fields) and Speex preprocess (AGC) are statically present.
- **UI↔native bridge:** the global `tsclient_internal` (~337 methods). Relevant ones: `setClientVolumeModifier(schid, clientId, dB, persist)` / `get…`; `setPlaybackConfigValue(schid, key, value)` with keys `agc`, `comfort_noise_*`, `echo_reduction_ducking`, plus a global `agc_experimental_mode`; `setPreProcessorConfigValue` for capture (`agc`, `denoise`, `vad`, …). **Playback AGC is a bare on/off per device, with no target, max-gain or limiter params.**
- **Settings:** SQLite `~/.config/TeamSpeak/Default/settings.db`, table `json_blobs`. `client_volume_modifiers` = `{uid: {volume: dB}}` (-200 = muted); `audio_settings` holds per-device DSP flags.

**Spike A, per-sender hook (row 4, static, Opus 4.8; artifacts `~/tmp/ts6-spike-a/`):** **POSSIBLE WITH CAVEATS.**
- **Hook site:** a `playback_sender_data` function at VA `0x44ecd60` (file `0x44ebd60`). It receives **one sender's decoded block, int16 mono, 10 ms frames at codec rate (48 kHz → 480), before resampling and mixing.** Inferred args: `rdi`=sender object, `rsi`=PCM, `edx`=frames, `ecx`=channels, `r8`=rate.
- **Patching it:** non-virtual, with 2 direct callers and a clean 17-byte prologue.
- **Re-finding it after updates:** a unique signature `55 41 57 41 56 41 55 41 54 53 48 81 EC A8 01 00 00 4C 89 44 24 20 48 8B 07 0F B6 80 E4 3B 00 00 83 F9 01`, or the short core `0F B6 80 E4 3B 00 00 83 F9 01 0F 85` (1 match).
- **Built-in playback AGC:** WebRTC APM, per **device**, running on the **mix** (fn `0x2c0b8b0`). That's why it pumps everyone together; our hook sits upstream of it.
- **Lookahead:** feasible as a constant N×10 ms delay. Held frames must be flushed at end of speech.
- **Unknown, needs a runtime probe:** the clientId offset in the sender object; that `rsi`/`edx` are the PCM pointer and frame count; that it runs on the realtime thread; where the per-client volume multiply happens (it isn't in this function).
- **Proposed probe:** detour `0x44ecd60` to log `{tid, rdi, rsi, edx, ecx, r8, RMS}` while two people talk.
- REA/Ghidra MCP timed out on the 80 MB binary; the worker used objdump plus its own scripts.

**Spike B, injection (row 5; scratch `~/tmp/ts6-spike-b/`):**
- An `LD_PRELOAD` `.so` loads into TS6. The preload is inherited by every child (CEF subprocesses, the `sh`/`cp`/`hyprctl` helpers TS spawns), so it must filter to the main process: exe path matches and there is no `--type=` arg.
- An isolated copy (separate HOME/XDG profile) runs alongside the user's own instance.
- **Stock binary refuses an edited `index.html`** (`ERR_INVALID_RESPONSE`), so the sha512 check is enforced. Only the TS6AddonInstaller byte patches get around it.
- **`--remote-debugging-port` works on the unmodified binary.** CDP lists one target, `tsui://default/index.html#/`.
- **JS→native works:** a `fetch` from the tsui page to a loopback listener in the `.so` round-trips with CORS `*` + `Access-Control-Allow-Private-Network: true`. No CSP.
- **ToS:** the TS6AddonInstaller README states that client modifications violate the TeamSpeak Terms of Service since beta5.

**DSP core (row 7, done):** `native/dsp/` (`ts6dsp.{h,c}`, C11, no deps).
- Chain: leveler → compressor → lookahead limiter. Per-stream instances, click-free param changes, meters.
- `make -C native/dsp test` passes:
  - bursts peak exactly at the ceiling for lookahead 0/5/20 ms;
  - the leveler reaches 90% in about 3.4 s, capped at max gain, with the gate holding on noise;
  - latency equals the lookahead.

**Live survey of the real client (row 6, done).**
- Docs:
  - `superdoc/features/ts6-modding-surface.md`: launch, version info, bridge map, events, audio controls, recipes;
  - `superdoc/features/ts6-ui-extension-points.md`: settings page, top bar, context menus with ids, tree rows, panels, modals, hotkeys, theming, mod-API sketch;
  - `tools/cdp/cdp.mjs`: CDP helper;
  - `.claude/local/ts6-live.md`: real launch, server and bot details.
- Facts:
  - **JS sees no per-speaker audio levels.**
  - **`Page.reload` wipes the auto-connect state, so never reload.**
  - Experimental AGC = `global.agcExperimentalMode` + `audio.Update()`.
  - The server's music bots are silent unless a track plays, and there's no safe way to start one.
  - `settings.db` backup: `~/tmp/ts6-backup/20261110-011622/`.

**GUI brainstorm (rows 9–13), grounding facts:**
- Stable unhashed `tsv-*`/`ts-*` classes.
- Settings categories come from `categoriesLookup`; the "customization" category holds Remote Apps.
- Hidden `settings.dev.*` toggles exist.
- Connection info lives in `serverConnectionHandler.connectionInfo`.
- Talk-status events are channel-agnostic, but only for subscribed channels.
- `idleTime` is only available by polling `requestConnectionInfo`.
- Open chats live in the `.tsv-activities` vm `openedActivityGroups`.
- **Tree sizing needs a restart because `server-tree` caches the `--ts-tree-*-height` vars at `mounted()`, and `CSSVariableCache.recomputeCache` is broken.**

**In progress (row 8, exploratory, before this plan):** whole-stream AGC. It consists of:
- a `native/` preload hooking TS's output via dlsym interposition;
- a loopback control API;
- `launcher/ts6-mod`;
- a first `panel/` with the Mods settings page, the AGC section, TS AGC + experimental toggles, and the Dashboard button (D8).

Phase A builds on and refactors it.

## Decisions
- **D1** Target: real compression per incoming voice stream (per user), with good audio quality and volume limiting: no spikes, responsive, reliable. A configurable lookahead is welcome. — *the user's answer to Q1.*

- **D2** Feasibility first: before committing to a design, prove what's possible (native per-sender hook, UI injection) with a read-only/isolated RE spike. — *user: "before i dream big, i want to know what is actually possible".*

- **D3** RE/injection workers that 5.5 safeguards stop run on **Claude Opus 4.8** via the project agent `.claude/agents/re-opus48.md` (`model: claude-opus-4-8`). — *user's call after both Sonnet spikes were stopped by safeguards.*

- **D4** Settings UI = **in-client panel injected at runtime over CDP**. A launcher starts stock TS6 with `--remote-debugging-port` + our `LD_PRELOAD` `.so`, injects the panel JS, and the panel talks to the `.so` over loopback HTTP. No UI file edits, no binary patches. — *user's choice; spike B proved every link on the stock binary.*

- **D5** Test against the **real client**; moving the server's music bot is the only allowed server action. **Document every point of customizability** so the user can build on it. *User: "Really document it, so i can do some fun stuff with it."*

- **D6** Models: try 5.5 workers (`tl-sonnet-*`/`tl-opus-*`) first; fall back to `re-opus48` (D3) if safeguards stop them. — *user.*

- **D7** **Every mod feature is individually toggleable. With everything disabled the client behaves like vanilla:**
  - no injected UI beyond the Mods settings entry;
  - native audio is a true passthrough: no processing, no added latency;
  - no extra server requests;
  - stock settings untouched.
  - *User: "Everything that you will add HAS to be configurable. So a client with everything disabled is basically a vanilla client."*

- **D8** **Dashboard quick button** (TS6's home/start page, normally reached via the sidebar ≡ menu) in the left icon column. It calls the native route and is toggleable, default off. — *user: "A direct button for the dashboard would be nice."*

- **D9** For every brainstorm idea, take the lead's suggestion. *User: "for all of the open questions just take your suggestion".*
  - **Build:** ping/loss HUD + sparkline/alerts (Q3, Q4); codec readout + copy-diagnostics (Q7); Mods page + dev-flag unlocker (Q8); copy-ID menu (Q9); command palette with local + join actions (Q11); channel activity badges (Q13); idle probe for expanded channels only, throttled (Q14); join/leave feed (Q15); per-user audio popover (Q18); DSP meters + presets (Q19); chat tabs in the title bar (Q23); live theme reload (Q24); density slider (Q25); declutter toggles (Q27).
  - **Chat tabs (Q23):** 36 px (`--tsv-bar-height`); sidebar collapsed to its 62 px icon column; servers shown as tabs too, behind their own toggle.
  - **Later (not in this plan):** Q5, Q6, Q10, Q12, Q16, Q17, Q20, Q21, Q22, Q26, and Q27's section collapsing.

- **D10** Every mod must look right in the **default TS theme and the user's custom themes**. graphite and aurora share one layout, so test default + graphite. Style only with TS's own CSS variables and classes. — *user.*

- **D11** **The AGC must be deeply customizable** so the user can tune it:
  - every DSP parameter is exposed: leveler target, max gain, gate, threshold, ratio, knee, attack, release, makeup, lookahead, ceiling;
  - built-in presets (Voice / Music / Quiet night) plus user-saved custom presets;
  - a whole-stream vs per-speaker mode;
  - per-user overrides;
  - live meters.
  - *User: "One thing that is important to be really customizable is the automatic gain control. So I can probably test it and figure out some good settings."*

- **D12** **Mod framework:** `panel/core/` holds the registry, the Mods settings page with a per-mod toggle, persistence via `tsclient_internal.saveJsonBlob('mods')`, and the mod-API helpers from extension-points §10. Each mod lives in its own `panel/mods/<name>/` and the launcher injects core first. — *why: parallel workers never share a file, and the per-mod toggle is how D7 is enforced in one place.*

- **D13** **Local test rig:** a local TS6 server, isolated talker client(s) whose mic is a PipeWire virtual source playing test WAVs (bursty and quiet speech), and an isolated modded listener. Per-speaker work is proven there, not on the user's server. — *why: the server's bots are silent, per-speaker work needs known talkers on demand, and it keeps the real server untouched.*

- **D14** Live theme reload polls the active theme stylesheet (cache-busted) only while "live reload" is on, then re-measures the tree. There is no native file watcher. — *why: no native changes, and zero cost when off.*

- **D15** **`chat` mod: split long messages.**
  - The chat input's character limit is raised, so long text can be typed.
  - On send, text over the server's per-message limit is split into several messages, preferring paragraph/line/word boundaries.
  - **Code blocks are never broken mid-fence.** A block that has to be split is closed and reopened with the same fence and language in the next part.
  - A small hint near the input shows that the message will be sent as N parts.
  - A configurable delay between parts, default 0 ms.
  - Toggleable, default off (D7).
  - *User: "splits messages, which are too long into multiple messages … handle codeblocks properly … delay inbetween those messages (default at 0ms)."*

- **D16** **`files` mod: auto-compress oversized images.**
  - Images over the upload limit (5 MB) are downscaled to a configurable max resolution, then re-encoded at the highest quality that fits the limit (quality found by binary search).
  - Settings: max resolution, output format (JPEG default / WebP / keep PNG when there is transparency), strip metadata, target size margin.
  - Encoding happens in-page with the browser's own codecs (CEF Chrome 151: `createImageBitmap` + `canvas.toBlob('image/jpeg'|'image/webp', q)`, EXIF orientation respected), so **no system dependency**.
  - Animated GIFs are left untouched.
  - Toggleable, default off (D7).
  - *User: "compress images that are too large with settings … maximum resolution … automatically determine the right compression level … if possible do it in the code itself."*
  - *Caveat:* if TS uploads by file path natively instead of from a JS `File`, the compressed file is written to a temp file via the native module's loopback API and that path is handed over.

- **D18** **Extensible mod API, TS internals in one place.**
  - Every TS-specific selector, vm path and bridge call lives in a single **anchors** module in `panel/core/`.
  - Mods never name DOM ids or classes. They call semantic slots, e.g. `api.topBar.add(el)`, `api.contextMenu.client.add({label, onClick})`, `api.settings.addSection()`, `api.treeRow.decorate(fn)`, `api.chatInput.onBeforeSend(fn)`.
  - Plugins can extend the API further: `api.extend('name', impl)` and new slot definitions, which other plugins then use.
  - After a TS update only the anchors need fixing.
  - *User: "the ID is still stored somewhere, but only in a single place … plugins can say stuff like yeah, add this to the top bar … plugins should be able to extend this API even further."*

- **D19** **Every mod ships an agent-runnable test procedure.**
  - A CDP-driven `panel/mods/<name>/test.mjs`, with no user input, plus a written procedure on the mod's doc page.
  - `tools/test/run-all.mjs` runs an anchor health check (every anchor resolves on the installed TS version), the native signature-scan check, then every mod test.
  - After a TS update, an agent re-runs it and fixes what fails.
  - *User: "write down a testing procedure for every single mod … an agent should be able to test it, so no user intervention is required for updates."*

- **D20** **A user-facing `README.md` at the repo root.** It covers:
  - what the project is, with a feature list (each feature toggleable, everything off = vanilla);
  - requirements (Linux, TS6 version tested, Node, gcc);
  - build + launch (`launcher/ts6-mod`, desktop entry);
  - where the Mods settings live and how to disable everything;
  - writing your own plugin against the mod API;
  - running `tools/test/run-all.mjs` after a TS update;
  - a ToS caveat that client modification may violate TeamSpeak's terms.
  - No personal data. — *user: "Also write a readme".*

- **D17** **One phase. All human testing comes at the very end.** Everything is built and agent-verified with no pause for the user. Stage 7 is the user testing the whole thing at once, guided by a test guide. — *user: "the last phase should be me testing everything … so I can actually sleep and just come back to something that I can test."*

## Done when
**Agent-verified (run in Stage 6, before you test anything)**
- [ ] With all mods off, a CDP check finds no injected DOM except the Mods settings entry; the native `/status` reports passthrough with 0 added latency; and no mod-originated server requests occur — *verified by: agent*
- [ ] On the rig, the per-speaker hook maps each talker correctly (probe log: clientId ↔ known talker, 10 ms int16 blocks) — *verified by: agent*
- [ ] On the rig, a burst-heavy talker never exceeds the configured ceiling at the listener, while a quiet talker is levelled up independently (per-speaker mode) — *verified by: agent*
- [ ] Every AGC parameter, mode, preset (built-in + custom save/rename/delete) and per-user override is editable in the panel and survives a client restart — *verified by: agent*
- [ ] `make -C native/dsp test` passes and the native module builds with zero warnings — *verified by: agent*
- [ ] Each UI mod has its own toggle, default off; switching one off removes its DOM, listeners, timers and polling — *verified by: agent*
- [ ] On the real client each feature works:
  - the HUD shows live ping/loss;
  - the copy menu copies a UID;
  - activity badges light up;
  - chat tabs open and close chats;
  - theme reload resizes the tree without a restart;
  - the palette jumps and joins;
  - the join/leave feed shows moves;
  - the density slider, declutter toggles and Dashboard button work.
  - *verified by: agent*
- [ ] Message splitting: the splitter's unit tests pass, with every part ≤ the limit, fences balanced in every part, and rejoining the parts giving the original text. On the real client, an over-limit message typed into a chat with yourself (or an empty channel) goes out as N parts, with the hint shown and the delay honoured — *verified by: agent*
- [ ] Image compression: the user's test set is copied to `.claude/local/test-images/` (local only, never committed) and used read-only. It holds 6 PNGs of 16–45 MB, plus a 143 MB `whale.zip`. Each PNG is sent under the limit, at ≤ the max resolution, with the quality chosen automatically. A PNG with transparency is handled too (generate one if none of the set has alpha). A file already under the limit, and the non-image `.zip`, are left untouched. Verified on the real client in a chat with yourself — *verified by: agent*
- [ ] Screenshots of every mod in the default and graphite themes show no layout breakage — *verified by: agent*
- [ ] `map.py --check` shows no DANGLING links, and the docs are anonymized (no names, IDs, hosts, home paths) — *verified by: agent*
- [ ] No mod contains a raw TS selector, vm path or bridge name; a grep of `panel/mods/` for `tsv-`/`ts-`/`__vue__`/`tsclient_internal` is empty, and all of them live in the anchors module only — *verified by: agent*
- [ ] A sample plugin that adds its own API extension, plus a second plugin that uses that extension, both work — *verified by: agent*
- [ ] `node tools/test/run-all.mjs` passes on the real client with no user input. Every anchor resolves, every mod's automated test passes, the native signature scan finds the hook, and each mod's doc page has a written test procedure — *verified by: agent*
- [ ] `README.md` covers every D20 item, and every command in it runs as written — *verified by: agent*
- [ ] A **test guide** exists at `superdoc/features/testing-guide.md`: how to launch the modded client, then one short checklist per mod with what to try and what you should see — *verified by: agent*

**Your testing (Stage 7, the very end; everything is built and agent-checked first)**
- [ ] The client starts via the launcher and behaves like vanilla with every mod off — *verified by: user*
- [ ] The AGC sounds good on the real server and its settings are useful for tuning (whole-stream and per-speaker) — *verified by: user*
- [ ] Each UI mod does what you wanted: HUD, copy menu, palette, activity badges, join/leave feed, chat tabs, density, declutter, theme reload, Dashboard button, message splitting, image compression — *verified by: user*
- [ ] Everything looks right in the default theme and your themes — *verified by: user*

## Implementation plan
*Built from D1–D20 · decisions:2a6b*

| Wave | ID | Task | Agent | Owns | After |
|:----:|:--:|------|-------|------|-------|
| 1 | I1 | Mod core + **extensible mod API**:<br>• registry, Mods settings page with a per-mod toggle (default off), `saveJsonBlob('mods')` persistence;<br>• **one anchors module** holding every TS selector, vm path and bridge call;<br>• semantic slots: top bar, sidebar icon, settings section, context menu (client/channel/server), tree-row decorator, chat input, toasts, modals, events, version;<br>• `api.extend()` / slot definitions so plugins can add their own API.<br>Theme-safe styling. The launcher injects core + `panel/mods/*`. Port row 8's panel (AGC section, Dashboard button) onto it.<br>**Test harness:** `tools/test/run-all.mjs` (CDP, no user input) runs an anchor health check plus every mod's `test.mjs`. Doc: mod API page — **D4 D7 D8 D10 D12 D18 D19** | `tl-sonnet-medium` | `panel/core/`, `launcher/`, `tools/test/`, `superdoc/features/ts6-mod-api.md` | — |
| 1 | I2 | Test rig: local TS6 server, isolated talker client(s) with a PipeWire virtual-source mic playing test WAVs, an isolated modded listener, and start/stop scripts. Doc page — **D2 D13** | `tl-sonnet-medium` | `tools/rig/`, `superdoc/features/test-rig.md` | — |
| 2 | I3 | Per-speaker native hook: runtime probe on the rig (args, clientId offset, thread), signature scan, a per-sender ts6dsp instance, per-user overrides, lookahead flush at end of speech, control-API per-user endpoints, exact passthrough when off. Falls back to `re-opus48` if stopped — **D1 D3 D6 D7** | `tl-opus-medium` | `native/` | I2 |
| 3 | I4 | AGC UI (`audio` mod):<br>• global page with every parameter, built-in + custom presets, whole-stream/per-speaker mode, live meters, TS playback-AGC + experimental toggles;<br>• per-user audio popover: volume past the stock limit, mute, boost, per-user AGC override.<br>Doc `agc.md` — **D1 D5 D9 D11** | `tl-sonnet-medium` | `panel/mods/audio/`, `superdoc/features/agc.md` | I1, I3 |
| 4 | I5 | `net` mod: ping/loss/bandwidth HUD, sparkline + alerts, channel codec readout, copy-diagnostics. Doc — **D9 D19** | `tl-sonnet-medium` | `panel/mods/net/`, `superdoc/features/mod-net.md` | I4 |
| 4 | I6 | `power` mod: copy UID/IDs menu for users and channels, Ctrl+K command palette (local + join actions), dev-flag unlocker section. Doc — **D9 D19** | `tl-sonnet-medium` | `panel/mods/power/`, `superdoc/features/mod-power.md` | I4 |
| 4 | I7 | `aware` mod: channel activity badges, throttled idle probe (expanded channels only), join/leave feed. Zero server requests when off. Doc — **D7 D9** | `tl-sonnet-medium` | `panel/mods/aware/`, `superdoc/features/mod-aware.md` | I4 |
| 4 | I8 | `layout` mod: chat tabs in the title bar (36 px, servers optional), density slider, declutter toggles. Doc — **D9 D10** | `tl-sonnet-medium` | `panel/mods/layout/`, `superdoc/features/mod-layout.md` | I4 |
| 4 | I9 | `theme` mod: live theme reload with tree re-measure, theme picker, reload button. Doc — **D9 D14** | `tl-sonnet-medium` | `panel/mods/theme/`, `superdoc/features/mod-theme.md` | I4 |
| 4 | I13 | `chat` mod: raise the input limit, find the server's per-message limit, split on send at paragraph/line/word boundaries, fence-aware code-block splitting (close and reopen with the same fence and lang), "will send as N parts" hint, inter-part delay setting (default 0 ms). Pure splitter function with assert tests. Doc — **D7 D15** | `tl-sonnet-medium` | `panel/mods/chat/`, `superdoc/features/mod-chat.md` | I4 |
| 4 | I14 | `files` mod: find TS's upload path and limit, intercept oversized images, downscale to max resolution, binary-search the quality to fit, choose the format, strip metadata, skip GIFs; in-page codecs, with a native temp-file fallback only if uploads go by path (scope request for `native/`). Settings UI. Doc — **D7 D16** | `tl-sonnet-medium` | `panel/mods/files/`, `superdoc/features/mod-files.md` | I4 |
| 5 | I10 | Theme-compat visual pass: screenshot every mod in the default and graphite themes and fix any styling issues — **D10** | `tl-opus-medium` | `panel/` | I5, I6, I7, I8, I9, I13, I14 |
| 6 | I11 | Docs integration: overview module map + "where to look", `CLAUDE.md` stack and links, TERMINOLOGY, a "how to build your own mod" section, the **user test guide** (launch + one checklist per mod), and the root **`README.md`** — **D5 D17 D20** | `tl-sonnet-medium` | `superdoc/architecture/overview.md`, `CLAUDE.md`, `superdoc/meta/TERMINOLOGY.md`, `superdoc/features/testing-guide.md`, `README.md` | I10 |
| 6 | I12 | QC: vanilla check with everything off, `run-all.mjs`, plus every agent criterion — **D7 D18 D19** | `tl-sonnet-medium` | *(read-only)* | I10 |

**Every mod step (I4–I9, I13, I14) also:**
- uses only the mod API: no TS selectors outside `panel/core/` anchors. Missing slots go to the lead as a scope request against `panel/core/` (**D18**);
- ships `test.mjs` plus a written test procedure on its doc page (**D19**).

I3 adds a signature-scan self-check that `run-all.mjs` calls.

## Open questions

### Answered
- ~~2. How should the settings UI work?~~ → in-client panel via CDP → **D4**
- ~~1. What do you want out of this; how much fragility is acceptable?~~ → real per-user compression + limiting, lookahead OK; feasibility first → **D1**, **D2**
- ~~3–27. GUI brainstorm ideas~~ → take every suggestion → **D9**; theme compatibility → **D10**; deep AGC customization → **D11**

## Research request

## Brainstorm request

## Notes from me


# Board

<!-- GENERATED from .state/board.json — do not hand-edit; use the board tools -->

| ✓ | ID | Task | Agent | Owns | State | Branch |
|:-:|:--:|------|-------|------|-------|--------|
|   | 8 | Integrate whole-stream AGC: LD_PRELOAD .so (playback output hook + DSP), loopback control API, launcher (CDP inject), in-client panel incl. TS AGC + experimental toggle; live test with music bot; docs | `tl-sonnet-medium` | `native`, `launcher`, `panel`, `tools/cdp`, `superdoc/features/agc.md`, `superdoc/features/ts6-modding-surface.md`, `superdoc/features/ts6-ui-extension-points.md`, `superdoc/architecture/overview.md`, `superdoc/meta/TERMINOLOGY.md`, `CLAUDE.md` | running | — |

## Done

| ✓ | ID | Task | Agent | Owns | State | Branch |
|:-:|:--:|------|-------|------|-------|--------|
| x | 3 | Scout: online research — TS6 plugin/addon API, community mods, per-user AGC/compressor options, out-of-the-box approaches | `tl-sonnet-medium` | *(read-only)* | merged | — |
| x | 4 | Spike A: native per-sender audio hook feasibility in TS6 binary (locate per-sender PCM fn, signature, client id, hookability) | `re-opus48` | *(read-only)* | merged | — |
| x | 5 | Spike B: injection feasibility — LD_PRELOAD into TS6, UI JS injection (sha512 enforcement), remote-debugging, UI↔native channel | `re-opus48` | *(read-only)* | merged | — |
| x | 6 | Live survey of the real TS6 client via CDP: modding/display surface, tsclient_internal, events, version/compat info, experimental AGC; write superdoc page + CDP helper | `tl-sonnet-medium` | `superdoc/features/ts6-modding-surface.md`, `superdoc/features/ts6-ui-extension-points.md`, `superdoc/features/ts6-mod-api.md`, `tools/cdp`, `.claude/local` | merged | — |
| x | 7 | DSP core in C: per-stream leveler + compressor + lookahead limiter, offline self-test + wav CLI | `tl-sonnet-medium` | `native/dsp` | merged | — |
| x | 9 | Brainstorm GUI mods — lens: power-user/admin tools (IDs, info, quick actions) | `tl-sonnet-medium` | *(read-only)* | merged | — |
| x | 10 | Brainstorm GUI mods — lens: network & diagnostics visibility (ping, loss, connection stats) | `tl-sonnet-medium` | *(read-only)* | merged | — |
| x | 11 | Brainstorm GUI mods — lens: awareness/presence (activity in other channels, notifications) | `tl-sonnet-medium` | *(read-only)* | merged | — |
| x | 12 | Brainstorm GUI mods — lens: layout/declutter (chat tabs on top, sidebar, density) | `tl-sonnet-medium` | *(read-only)* | merged | — |
| x | 13 | Brainstorm GUI mods — lens: audio UX + fun/integrations | `tl-sonnet-medium` | *(read-only)* | merged | — |

### How it was solved

- **3** Findings folded into plan Context: CEF web UI, injection via TS6AddonInstaller patches, no TS6 plugin SDK, TS3 per-client PCM hook, Remote Apps has no audio, EasyEffects only sees mixed stream.
- **4** Opus 4.8 static RE: per-sender hook at VA 0x44ecd60 (playback_sender_data, int16 mono 10ms frames pre-resample/pre-mix), unique byte signature, playback AGC is per-device on mix (0x2c0b8b0). clientId offset + arg semantics need runtime probe. Folded into plan Context.
- **5** Opus 4.8 re-run: stock binary enforces sha512 (edited index → ERR_INVALID_RESPONSE); 3 AddonInstaller patches make it load; --remote-debugging-port works on stock binary (CDP target = tsui page) → no-patch injection route; fetch tsui→loopback .so works (CORS * + Allow-Private-Network), no CSP. Copy's index restored; TeamSpeak.patched left in ~/tmp/ts6-spike-b as evidence. Folded into plan Context + Q2.
- **6** Handback failed (not auto mode); lead checked deliverables directly: superdoc/features/ts6-modding-surface.md (248 l) + ts6-ui-extension-points.md (241 l: settings page, top bar, ctx menus w/ ids, tree rows, modals, hotkeys, theming, mod API sketch), tools/cdp/cdp.mjs, .claude/local/ts6-live.md. Key: no per-speaker levels in JS; experimental AGC = global.agcExperimentalMode + audio.Update() (or setPlaybackConfigValue 'agc_experimental_mode'); Page.reload wipes auto-connect; bots silent unless a track plays. settings.db backup ~/tmp/ts6-backup/20261110-011622/. Client left running with CDP on 127.0.0.1:9222.
- **7** native/dsp: ts6dsp.{h,c} C11 leveler→compressor→lookahead limiter, Makefile (lib/test/wavproc), README. Worker's handback failed (SubagentHandback refused, not auto mode) so lead verified directly: `make test` all pass — burst peaks exactly at ceiling for lookahead 0/5/20 ms, leveler 90% in ~3.4 s capped at max gain, gate holds on noise, latency 0/240/960 frames matches, 60 s silence clean, no clicks on param change, s16 path capped.
- **9** Power-user lens folded into plan Open questions 8–12: Mods settings page in Settings→Extensions (categoriesLookup 'customization') + hidden settings.dev.* flags, persist via saveJsonBlob; copy menu (contextmenu hook, getClientInfo); inspector; Ctrl+K palette; export. Hint: settings.dev.sidebar_tabs exists (relevant to chat-tabs seed).
- **10** Network lens folded into plan Open questions 3–7 (HUD from serverConnectionHandler.connectionInfo sample class; sparkline via TSGraph; per-user requestConnectionInfo; stream stats overlay; codec readout/copy diagnostics). No voice jitter exposed; per-user audio stats not in JS.
- **11** Awareness lens → plan Q13–17. Key fact: talk status is channel-agnostic in JS but only for subscribed channels (no JS subscribe call); idleTime only via RequestConnectionInfo polling.
- **12** Layout lens → plan Q23–27. Stable tsv-*/ts-* classes; chat tabs via own strip in .tsv-window-bar spacer driven by .tsv-activities vm; theme restart root cause: server-tree caches --ts-tree-* heights at mounted() + broken CSSVariableCache.recomputeCache (for-in over Map) → live reload by re-reading heights + flattenServer/$forceUpdate.
- **13** Audio/fun lens → plan Q18–22 (per-user popover, DSP meter strip+presets, soundboard, recording, OBS/StreamDeck). Stock agc/denoise/vad all via SetPlaybackConfigValue/setAudio — presets can drive them.

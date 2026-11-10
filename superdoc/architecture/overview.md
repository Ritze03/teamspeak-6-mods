# Architecture Overview

The first doc to read. It links out to sibling docs rather than duplicating them. User-facing entry points: the repo-root
`README.md` and the [testing guide](../features/testing-guide.md).

## Big picture

`teamspeak-6-mods` adds opt-in mods to the stock TeamSpeak 6 client (Linux) without patching its files. Two entry
points are used: an `LD_PRELOAD` native module in the client's main process (audio), and a Chrome DevTools Protocol
(CDP) connection to the client's UI page (injected JS). Every mod has its own switch, default off; with everything off
the client behaves like vanilla ("everything HAS to be configurable").

Stack: C (preload module, per-speaker detour, DSP core; `native/`), Node (launcher, CDP injector, test runner;
`launcher/`, `tools/`), injected JavaScript (the mod framework `panel/core/` plus one directory per mod `panel/mods/`).

Layers on the UI side: `panel/core/anchors.js` is the only place naming TeamSpeak internals; `slots.js`/`core.js` give mods a
semantic `api`; a mod needing its own TS names owns one core extension file `panel/core/x-<mod>.js`; mods in `panel/mods/<name>/`
contain no TS names. Why: a client update then breaks anchors, not mods ([features/ts6-mod-api.md](../features/ts6-mod-api.md)).

## Process model

```
launcher/ts6-mod ─┬─ client main process  (LD_PRELOAD=native/libts6mod.so, --remote-debugging-port, loopback)
                  │     └─ CEF children (inherit LD_PRELOAD; the module ignores them: cmdline has --type=)
                  │     └─ module: control thread, HTTP on 127.0.0.1:<port>
                  └─ tools/cdp/mods-inject.mjs ── CDP ──> UI page (tsui://) : bundle of panel/core + panel/mods (tools/cdp/bundle.mjs)
                                                  ├ binding ts6modNative: page <-> injector <-> module HTTP (/config /status /meters /speakers /speaker)
                                                  └ binding ts6modReadImage: narrow image-file reader (files mod)
```
The client re-spawns itself once at start; the launcher follows the process carrying the debug-port flag.
Dev loop: `tools/cdp/mods-reload.mjs` swaps the panel code into the running client; `tools/test/run-all.mjs` tests it.

## Data flow

- Whole-stream audio: client mixer -> `pa_stream_write` (wrapped via the `dlsym` interposition) -> `ts6dsp` (if enabled) -> libpulse.
- Per-speaker audio: decoded sender PCM -> inline detour (`native/ts6hook.c:detour`, installed from a signature scan of the client
  binary) -> one `ts6dsp` per sender (+ per-user override and boost) -> the client's mixer; the whole-stream path then passes through.
  Details: [features/per-speaker-hook.md](../features/per-speaker-hook.md).
- Settings: Mods page -> `api.native` -> binding -> injector -> `POST /config` / `/speaker` -> module (applies live, saves `agc.json`).
  Mod switches and per-mod settings: one JSON blob in the client's profile (`api.storage`, [features/ts6-mod-api.md](../features/ts6-mod-api.md)).
- Meters: the audio mod polls `/meters` and `/speakers` (only while its settings are shown).
- Other mods read client state and events through the bridge (`api.events`, `api.bridge`, `api.state`), never through the module.
- Details: [features/agc.md](../features/agc.md).

## Module map

| Path | Role |
|---|---|
| `native/ts6mod.c` | preload module: main-process filter, `dlsym` hook, stream table, control API, config file |
| `native/ts6hook.{c,h}` | per-speaker inline detour: signature scan, speaker pool, per-client overrides, `/speakers` JSON |
| `native/dsp/` | `ts6dsp` library: leveler -> compressor -> lookahead limiter ([README](../../native/dsp/README.md)) |
| `native/test/` | hook test without the client (`run_hook_test.sh`, harness + null sink), `sigscan.sh` (signature check on the installed client) |
| `launcher/ts6-mod`, `launcher/ts6-mod.desktop` | starts the client with the module + debug port, runs the injector; desktop entry template |
| `tools/cdp/cdp.mjs` | dependency-free CDP helper (list/eval/inject/watch) |
| `tools/cdp/mods-inject.mjs` | injects the bundle, provides the `ts6modNative` and `ts6modReadImage` bindings |
| `tools/cdp/bundle.mjs` | builds the page script from `panel/` (core files, then mods, examples only on request) |
| `tools/cdp/mods-reload.mjs` | hot-swaps panel code into the running client |
| `tools/test/run-all.mjs`, `core-tests.mjs` | all checks against a running modded client (lint, anchors, sigscan, mod tests, core/slot tests, vanilla) |
| `tools/rig/` | local audio test rig (null sinks, test WAVs) ([features/test-rig.md](../features/test-rig.md)) |
| `panel/core/` | framework: `anchors.js`, `core.js`, `slots.js`, `page.js` (Mods page), `core.css`, extension files `x-<mod>.js` |
| `panel/mods/<name>/` | one mod each: `index.js`, optional `style.css`, `test.mjs` (`audio aware chat dashboard files layout net power theme`) |
| `panel/examples/ext-provider`, `ext-consumer` | sample plugins, injected only with `TS6MOD_EXAMPLES=1` / `--examples` |

## Docs

- Framework and API: [features/ts6-mod-api.md](../features/ts6-mod-api.md) (includes "How to build your own mod"); Mods page and
  Dashboard mod: [features/mods-panel.md](../features/mods-panel.md).
- Audio: [features/agc.md](../features/agc.md), [features/per-speaker-hook.md](../features/per-speaker-hook.md),
  [features/test-rig.md](../features/test-rig.md).
- Mods: [net](../features/mod-net.md), [power](../features/mod-power.md), [aware](../features/mod-aware.md),
  [layout](../features/mod-layout.md), [theme](../features/mod-theme.md), [chat](../features/mod-chat.md),
  [files](../features/mod-files.md).
- Client research: [features/ts6-modding-surface.md](../features/ts6-modding-surface.md) (internals reachable from outside),
  [features/ts6-ui-extension-points.md](../features/ts6-ui-extension-points.md) (UI hooks).
- Human testing: [features/testing-guide.md](../features/testing-guide.md).

## Where to look for X

- The audio hook / which `pa_*` calls are wrapped: `native/ts6mod.c:dlsym_slow`, `g_hooks`.
- Processing on the write path: `native/ts6mod.c:hooked_write`, `process_in`.
- Enable/disable, mode, lookahead change, DSP swap: `native/ts6mod.c:apply_locked`.
- Control API handlers / config file: `native/ts6mod.c:handle`, `cfg_apply_json`, `cfg_save`.
- Main-process filter: `native/ts6mod.c:is_main_process`.
- Per-speaker detour, install, overrides, status: `native/ts6hook.c:detour`, `install`, `ts6hook_set_override`, `ts6hook_status`,
  `ts6hook_speakers_json`; signature check on a new client: `native/test/sigscan.sh`.
- DSP algorithm: `native/dsp/ts6dsp.c:ts6dsp_process_f32`.
- Launch sequence and env vars: `launcher/ts6-mod`.
- CDP injection, the HTTP proxy path allow-list, the image reader: `tools/cdp/mods-inject.mjs`, `readImage`.
- Which files go into the page and in what order: `tools/cdp/bundle.mjs:coreFiles`, `buildBundle`.
- Every TS selector / Vue path / bridge name and the anchor health check: `panel/core/anchors.js:check`; theme tokens:
  `anchors.js:themeTokens`; Settings category push: `anchors.js:addSettingsPage`; sidebar icon block: `anchors.js:sidebarBlock`.
- Mod registry, cleanup ledger, `api.extend`, `coreApi` (extension files): `panel/core/core.js:register`, `coreApi`.
- Slots (`topBar`, `sidebar`, `contextMenu`, `treeRow`, `chatInput`, ...): `panel/core/slots.js`.
- The Mods page and `api.ui` widgets: `panel/core/page.js` (`install`).
- AGC page, presets, per-user popover and their sync: `panel/mods/audio/index.js:openUser`, `syncPeers`; the mod-off
  vanilla guard: `panel/core/x-audio.js:vanillaGuard`.
- Dashboard button: `panel/mods/dashboard/index.js` (`api.sidebar.addIcon`).
- Chat splitter: `panel/mods/chat/index.js:splitParts`, `byteLength`; theme flatten/re-measure: `panel/core/x-theme.js:flatten`, `treeRemount`;
  net alerts: `panel/mods/net/index.js:checkAlerts`.
- Image upload hooks: `panel/core/x-files.js` (`api.files.hook`); layout, aware, power: `panel/core/x-layout.js`, `x-aware.js`, `x-power.js`.

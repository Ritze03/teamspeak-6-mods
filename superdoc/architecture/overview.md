# Architecture Overview

The first doc to read. It links out to sibling docs rather than duplicating them.

## Big picture

`teamspeak-6-mods` adds opt-in mods to the stock TeamSpeak 6 client (Linux) without patching its files. Two entry
points are used: an `LD_PRELOAD` native module in the client's main process (audio), and a Chrome DevTools Protocol
(CDP) connection to the client's UI page (injected JS). Every mod has its own switch, default off; with everything off
the client behaves like vanilla ("everything HAS to be configurable").

Stack: C (preload module + DSP core, `native/`), Node (launcher + CDP injector, `launcher/`, `tools/cdp/`), injected
JavaScript (`panel/`).

## Process model

```
launcher/ts6-mod ─┬─ client main process  (LD_PRELOAD=native/libts6mod.so, --remote-debugging-port, loopback)
                  │     └─ CEF children (inherit LD_PRELOAD; the module ignores them: cmdline has --type=)
                  │     └─ module: control thread, HTTP on 127.0.0.1:<port>
                  └─ tools/cdp/mods-inject.mjs ── CDP ──> UI page (tsui://) : panel/panel.js
                                                  └ binding ts6modNative: page <-> injector <-> module HTTP
```
The client re-spawns itself once at start; the launcher follows the process carrying the debug-port flag.

## Data flow

Audio: client mixer -> `pa_stream_write` (wrapped via the `dlsym` interposition) -> `ts6dsp` (if enabled) -> libpulse.
Settings: panel -> binding -> injector -> `POST /config` -> module (applies live, saves `agc.json`).
Meters: panel polls `/meters` (only while the page is visible).
Details: [features/agc.md](../features/agc.md).

## Module map

| Path | Role |
|---|---|
| `native/ts6mod.c` | preload module: main-process filter, `dlsym` hook, stream table, control API, config file |
| `native/dsp/` | `ts6dsp` library: leveler -> compressor -> lookahead limiter ([README](../../native/dsp/README.md)) |
| `native/test/` | hook test without the client (harness + null sink) |
| `launcher/ts6-mod` | starts the client with the module + debug port, runs the injector; `.desktop` template |
| `tools/cdp/cdp.mjs` | dependency-free CDP helper (list/eval/inject/watch) |
| `tools/cdp/mods-inject.mjs` | injects the panel, provides the `ts6modNative` bridge |
| `panel/panel.js`, `panel.css` | Mods settings page, AGC controls, Dashboard button |

Docs: [features/agc.md](../features/agc.md), [features/mods-panel.md](../features/mods-panel.md),
[features/ts6-modding-surface.md](../features/ts6-modding-surface.md) (client internals reachable from outside),
[features/ts6-ui-extension-points.md](../features/ts6-ui-extension-points.md) (UI hooks).

## Where to look for X

- The audio hook / which `pa_*` calls are wrapped: `native/ts6mod.c:dlsym_slow`, `g_hooks`.
- Processing on the write path: `native/ts6mod.c:hooked_write`, `process_in`.
- Enable/disable, lookahead change, DSP swap: `native/ts6mod.c:apply_locked`.
- Control API handlers / config file: `native/ts6mod.c:handle`, `cfg_apply_json`, `cfg_save`.
- Main-process filter: `native/ts6mod.c:is_main_process`.
- DSP algorithm: `native/dsp/ts6dsp.c:ts6dsp_process_f32`.
- Launch sequence: `launcher/ts6-mod`.
- CDP injection and the HTTP bridge: `tools/cdp/mods-inject.mjs`.
- The Mods settings page and its rendering: `panel/panel.js:install`, `render`, `agcCard`.
- Strength -> parameters: `panel/panel.js:paramsForStrength`.
- Stock AGC / experimental AGC toggles: `panel/panel.js:setStockAgc`, `setExperimental`.
- Dashboard button: `panel/panel.js:setDashboardButton`, `dashEnsure`.

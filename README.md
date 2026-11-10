# teamspeak-6-mods

Opt-in mods for the **TeamSpeak 6 client on Linux**. Nothing in the client is patched: a small native module is preloaded
into the client process (audio), and a launcher injects a "Mods" page and the UI mods through the client's local debug port.
Every mod has its own switch and is **off by default**. With everything off, the client behaves like the stock one.

> **Terms of service.** Modifying the client may violate TeamSpeak's terms of service (the community installer for TS6 mods states
> that modifications violate the ToS since beta5). This project patches no client files, but it still changes the client's
> behaviour at runtime. Use it at your own risk.

## Mods

| Mod | What it does |
|---|---|
| **audio** | Automatic gain control (leveler, compressor, limiter) on the whole output or on each speaker separately, with presets, per-user volume, mute, boost and per-user AGC overrides |
| **dashboard** | Direct Dashboard (start page) button in the left icon column |
| **net** | Top-bar ping / packet-loss HUD with a history popover, diagnostics copy and optional alerts |
| **power** | Copy-ID entries in the right-click menus, command palette (Ctrl+K), unlocker for hidden developer toggles |
| **aware** | Channel activity badges, optional idle times, join / leave feed |
| **layout** | Chat and server tabs in the title bar, row density slider, switches to hide clutter |
| **theme** | Theme picker, one-click reload and live reload of the active extension theme |
| **chat** | Splits long messages (fence-safe for code blocks) and raises the input limit |
| **files** | Compresses large images before upload (chat and channel Files tab) |

Details per mod: `superdoc/features/` (`agc.md`, `mod-*.md`, `mods-panel.md`).

## Requirements

- Linux; TeamSpeak 6 client installed (tested with `6.0.0-beta5.1`; default path `/opt/teamspeak/TeamSpeak`, else set `TS6MOD_TS_BIN`)
- Node.js 22 or newer
- `gcc` (or another C compiler) and `make`
- Audio mod: the client must play through PulseAudio or PipeWire's pulse layer (`pipewire-pulse`)

## Build and start

```
make -C native                 # builds native/libts6mod.so (the launcher also does this on first start)
launcher/ts6-mod               # starts the client with the module and the mods; close a running client first
```

Anything after `launcher/ts6-mod` is passed to the client (for example a `ts3server://<server>` URL). Environment variables:
`TS6MOD_TS_BIN` (client binary), `TS6MOD_CDP_PORT` (debug port, default 9222), `TS6MOD_PORT` (native control port, default 38998),
`TS6MOD_PROFILE_DIR` (separate profile for a second client), `TS6MOD_EXAMPLES=1` (also load the sample plugins).
The debug and control ports listen on loopback only. Closing the client ends the launcher.

Desktop entry: copy `launcher/ts6-mod.desktop` to `~/.local/share/applications/`, replace `<repo>` with the absolute path of this checkout.

## Using it

Open **Settings -> Mods**. Every mod is a card with a switch; switch it on and its settings appear underneath. Settings apply live and are
remembered. A step-by-step check of every mod is in [superdoc/features/testing-guide.md](superdoc/features/testing-guide.md).

## Turning it all off

- Switch the mods off on the Mods page: the added UI, timers, requests and audio processing disappear (the "Mods" entry in Settings stays).
- Or start the client the normal way (not through `launcher/ts6-mod`): the module is not loaded and nothing is injected, so it is the stock client.
- To reset the native audio config, delete `$XDG_CONFIG_HOME/ts6-mods/` (default `~/.config/ts6-mods/`) while the client is closed.

## Write your own plugin

A mod is a folder `panel/mods/<name>/` with an `index.js` that calls `ts6mod.register(...)` and uses a small semantic API (top bar buttons,
context-menu items, tree row decorations, settings widgets, ...); cleanup on switch-off is automatic and TeamSpeak internals stay in one file.
Walkthrough, API reference and tests: [superdoc/features/ts6-mod-api.md](superdoc/features/ts6-mod-api.md) ("How to build your own mod").
Sample plugins: `panel/examples/` (load with `TS6MOD_EXAMPLES=1 launcher/ts6-mod`).

## Checks and after a TeamSpeak update

```
make -C native/dsp test                  # DSP unit tests (no client needed)
node panel/mods/chat/split.test.mjs      # chat splitter unit tests (no client needed)
native/test/sigscan.sh                   # does the installed client still match the per-speaker hook signature?
node tools/cdp/cdp.mjs list              # is a modded client reachable on the debug port?
node tools/test/run-all.mjs              # everything, against the running modded client
```

`run-all.mjs` has no `--help`: any run starts the full test suite against the client on `--cdp-port` (default 9222). It first hot-replaces
the panel code in that client with the files on disk (`--no-reload` skips this), switches mods on and off in memory and restores them, and only
sends test messages when connected to a local (127.0.0.1) server (options: `--only <mod>`, `--examples`, `--cdp-port`, `--control-port`).

After a client update: start with `launcher/ts6-mod`, run `native/test/sigscan.sh` and `node tools/test/run-all.mjs`. A failing anchor names the
selector or path to fix in `panel/core/anchors.js`; a signature scan with no single match means the per-speaker hook signature in `native/ts6hook.c`
needs updating (until then the audio mod's per-speaker mode stays off and audio is untouched). See `superdoc/features/per-speaker-hook.md`.

## Repository layout

`native/` (preload module, per-speaker hook, DSP) - `launcher/` (start script, desktop entry) - `tools/` (CDP injector, test runner, audio rig) -
`panel/core/` (mod framework) - `panel/mods/` (the mods) - `panel/examples/` (sample plugins) - `superdoc/` (documentation; start with
`superdoc/architecture/overview.md`).

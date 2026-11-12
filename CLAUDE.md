# teamspeak-6-mods

Mods for the TeamSpeak 6 client (Linux), added without patching its files. Stack: a C `LD_PRELOAD`
module (`native/`: whole-stream AGC on the output write, per-speaker inline detour `ts6hook`, DSP core `ts6dsp`), a Node
launcher + CDP injector + test runner (`launcher/ts6-mod`, `tools/cdp/`, `tools/test/`), and an injected JS mod framework
(`panel/core/`) with one directory per mod (`panel/mods/`: audio, dashboard, net, power, aware, layout, theme, chat, files)
behind a "Mods" settings page. Rule: every feature has its own switch and defaults to off; everything off = vanilla
client. Start modded: `launcher/ts6-mod`. User docs: `README.md`, `superdoc/features/testing-guide.md`.

Feature docs (plain links, read on demand): `superdoc/features/ts6-mod-api.md` (framework, API, slots, anchors,
extension files, tests, launcher, how to build a mod), `superdoc/features/mods-panel.md` (Mods page, Dashboard button),
`superdoc/features/agc.md` (audio mod, control API, presets, per-user audio), `superdoc/features/ts6-native-agc.md` (stock playback AGC + experimental mode, measured), `superdoc/features/per-speaker-hook.md`
(native per-sender detour), `superdoc/features/test-rig.md` (local audio rig), mods: `superdoc/features/mod-net.md`,
`mod-power.md`, `flatpak.md` (Flatpak / non-/opt client discovery, launcher), `mod-aware.md`, `mod-layout.md`, `mod-theme.md`, `mod-chat.md`, `mod-files.md`, research:
`superdoc/features/ts6-modding-surface.md` (client internals reachable from outside),
`superdoc/features/ts6-ui-extension-points.md` (UI hooks).

<!-- superdoc:start v4 -->
## Docs: read before you touch, update after you change

Full discipline — what to read, when to update, how to record the *why* — lives in the
always-loaded `superdoc/claude-instructions/documentation.md` below; this is a pointer, not
a restatement.

Reference docs — plain links, read the one relevant to your task on demand:

- **`superdoc/architecture/overview.md`** — codebase navigation map (module map, data flow,
  "where to look for X"). **Start here to navigate the code.**

## Always in context (force-loaded, mandatory)

`@` is reserved for the must-always-know set. Everything above is a plain link: an
optional, on-demand read.

- **Terminology** — @superdoc/meta/TERMINOLOGY.md — project vocabulary; use these meanings,
  ask before acting on an undefined term, and keep it current.
- **Documentation discipline** — @superdoc/claude-instructions/documentation.md — read
  before you touch, update after you change, record design rationale (the *why*).
- **Version policy** — @superdoc/claude-instructions/documentation-version-policy.md — how
  this project bumps doc/version markers.
- **Changelog** — @superdoc/claude-instructions/changelog.md — every user-facing change adds a
  dated entry to `CHANGELOG.md` in the same commit.

Path base: `CLAUDE.md` uses repo-root-relative paths (`@superdoc/...`, `` `superdoc/...` ``);
links *inside* docs are docs-relative. Precedence: `CLAUDE.md` is authoritative for
rules, docs are the reference — reconcile to `CLAUDE.md` on conflict. `@`-budget:
force-load a file only if its absence would let the agent do the wrong thing on *any*
task.
<!-- superdoc:end -->

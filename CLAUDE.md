# teamspeak-6-mods

Mods for the TeamSpeak 6 client (Linux), added without patching its files. Stack: a C `LD_PRELOAD`
module with a DSP core (`native/`, whole-stream AGC on the output write), a Node launcher + CDP injector
(`launcher/ts6-mod`, `tools/cdp/`), and an injected JS "Mods" settings page (`panel/`). Rule: every feature has its
own switch and defaults to off; everything off = vanilla client. Start modded: `launcher/ts6-mod`.

Feature docs (plain links, read on demand): `superdoc/features/agc.md` (AGC mod, hook, control API, build/launch),
`superdoc/features/mods-panel.md` (panel, Dashboard button), `superdoc/features/ts6-modding-surface.md` (client
internals reachable from outside), `superdoc/features/ts6-ui-extension-points.md` (UI hooks).

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

Path base: `CLAUDE.md` uses repo-root-relative paths (`@superdoc/...`, `` `superdoc/...` ``);
links *inside* docs are docs-relative. Precedence: `CLAUDE.md` is authoritative for
rules, docs are the reference — reconcile to `CLAUDE.md` on conflict. `@`-budget:
force-load a file only if its absence would let the agent do the wrong thing on *any*
task.
<!-- superdoc:end -->

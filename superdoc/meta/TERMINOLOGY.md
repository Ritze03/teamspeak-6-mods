# Terminology

Project-specific vocabulary. When the user uses a term defined here, use the same
meaning.

**If the user uses a non-standard term that is not defined here, ask what they mean by
it before acting on it.** Once its meaning is clear, add it to this file. Keep this
file up to date automatically: whenever the user introduces or clarifies a term, add or
amend the entry here.

**Keep every entry short: what the term is, and where to read more.** One or two
sentences, about 200 characters. Details, behaviour, option names, history and rationale
belong on the linked doc page. If that page doesn't exist and there is more to say, write
the page; don't grow the entry. When you amend an entry, trim it to this form instead of
appending. This file stays in context for the whole session.

## Terms

- **Dashboard**: TS6's home/start page (banner, Popular Servers, Chats, Recent), opened natively via the sidebar hamburger menu; the mod adds a direct button. See [features/mods-panel.md](../features/mods-panel.md#dashboard-button).
- **Mod**: one opt-in feature (`panel/mods/<name>/`, own switch, default off) registered with `ts6mod.register`; the native audio module belongs to the `audio` mod. See [features/ts6-mod-api.md](../features/ts6-mod-api.md).
- **Mods page**: the "Mods" category in the client's Settings; one card per mod with its switch and settings. See [features/mods-panel.md](../features/mods-panel.md).
- **Anchors / anchors module**: `panel/core/anchors.js`, the only file naming TS classes, Vue paths and bridge calls; each anchor has a `resolve()` and a health check. See [features/ts6-mod-api.md](../features/ts6-mod-api.md#anchors).
- **Core extension file (x-file)**: `panel/core/x-<mod>.js`, one per mod, may name TS internals and adds anchors and `api.<name>`. See [features/ts6-mod-api.md](../features/ts6-mod-api.md).
- **Slot**: a place a mod can add UI through the api (`api.topBar`, `api.sidebar`, `api.contextMenu`, `api.treeRow`, ...); plugins can define more. See [features/ts6-mod-api.md](../features/ts6-mod-api.md#api-reference).
- **Whole-stream vs per-speaker mode**: the AGC runs on the mixed output (`whole`) or on each sender before the mix (`per_speaker`, enables per-user overrides). See [features/agc.md](../features/agc.md#modes).
- **Test rig**: local setup (null sinks, test WAVs, second client) that gives the audio mod known talkers. See [features/test-rig.md](../features/test-rig.md).
- **Vanilla (everything off)**: with every mod off the client behaves as stock: no mod DOM, timers, requests, audio processing. Checked by `run-all`. See [features/agc.md](../features/agc.md#vanilla-rule-decision-d7).

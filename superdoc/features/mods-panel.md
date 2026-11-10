# Mods page and the Dashboard mod

The injected UI of the mods: one **Mods** page in the client's Settings that lists every mod with its own switch (all
**default off**), and the mods themselves. Everything off = vanilla client; only the "Mods" entry in Settings remains.
The framework (core, slots, anchors, `api`, tests, launcher env) is documented in [ts6-mod-api.md](ts6-mod-api.md); the
underlying mechanics in [ts6-ui-extension-points.md](ts6-ui-extension-points.md); the AGC side in [agc.md](agc.md).

## Structure

- `panel/core/`: framework (`anchors.js`, `core.js`, `slots.js`, `page.js`, `core.css`). The Mods page is
  `panel/core/page.js` (`boot.page.install`); it is a Settings category pushed into the settings mode list by
  `anchors.js:addSettingsPage`.
- `panel/mods/audio/`: the AGC page, per-user audio popover and the two stock TeamSpeak playback AGC toggles (see below).
- `panel/mods/dashboard/`: the Dashboard button.
- Injected by `tools/cdp/mods-inject.mjs` (bundle built by `tools/cdp/bundle.mjs`): one CDP socket stays open,
  `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate` (never `Page.reload`), plus the binding `ts6modNative` through
  which mods talk to the native control API (see [agc.md](agc.md), "Why"). Idempotent (`window.__ts6mod`). Open the page from
  code with `__ts6mod.open()`.

On the page each mod is a card: its switch (title and description from `register`), and, while on, its `settings(api, container)`
area underneath. Switches are stored in the bridge blob `mods` ([ts6-mod-api.md](ts6-mod-api.md), "Persistence"); the page makes no
request and holds no timer until it is shown.

## Audio mod

`panel/mods/audio/` (+ `panel/core/x-audio.js`): the AGC page (master switch, whole-stream / per-speaker mode, every DSP parameter,
built-in and own presets, live meters, per-speaker list, per-user list), the per-user "Audio..." popover and the two stock TeamSpeak
playback AGC toggles. Everything is in the mod's area on the Mods page; polling (meters 120 ms, status 2 s) runs in the settings scope, i.e.
only while the page is shown and the mod is on. Details, presets and the control API: [agc.md](agc.md).
**The mod switch also switches the native AGC**: off = native `enabled:false` (persisted by the native module), on = the user's own master
choice is restored (vanilla rule, see [agc.md](agc.md)).

## Dashboard button

Dashboard = the client's home/start page. Natively it is reached through the main-menu (hamburger) entry "Dashboard"; that entry
selects the app item `appController.dashboard`. The mod's button calls the same action (`api.nav.showDashboard`).

- Switch: Settings -> Mods -> "Dashboard button", **default off**, stored in the mods blob (before the framework it was
  `dashboard_button` in the native config; that key was removed from the native module, so existing users switch the mod on once).
- Code: `panel/mods/dashboard/index.js` is one `api.sidebar.addIcon({title, icon:'dashboard', onClick, active})`. The slot lives in
  `panel/core/slots.js` (`api.sidebar`) and `panel/core/anchors.js` (`sidebarBlock`, `sidebarPlace`).
- Placement: the left icon column (contacts, chats, bookmarks, groups). Each of those icons is its own icon-group block inside
  the column container. The slot appends a block built from the same markup with the app's own `<ts-icon>` (the Dashboard mod
  uses the same icon the menu entry has), after the last stock group; several mods may add icons, they keep registration order.
  `active` is re-evaluated on every route change, so the button is highlighted while the Dashboard is displayed.
- Start-up: the Dashboard item and the icons do not exist while the UI is still loading, so the block is built lazily by a
  debounced DOM observer (`sbSync`) once they do.
- Survival: the same observer puts the block back after Vue re-renders the sidebar; route changes do not matter because the block
  is outside the router view.
- Switching it off removes the block, the observer and the route hook (the framework's cleanup; checked by the mod's `test.mjs`).

Why: the column's blocks are Vue-rendered from internal "resources", which a mod cannot add to, so DOM injection of a same-class
block is the least invasive route; the click handler is the native action, nothing is faked. The click handler sits on the
block's root (not on the inner tab) so that a plain `element.click()` in tests and a real click behave the same.

### Test procedure (Dashboard button)

By hand: switch "Dashboard button" on -> an icon appears in the left column. Click it -> the Dashboard opens and the icon is highlighted.
Navigate elsewhere -> the highlight goes away. Switch the mod off -> the icon is gone.

Automated: `panel/mods/dashboard/test.mjs` starts from off (no button), enables (exactly one button, titled "Dashboard"), clicks it
(route becomes `/dashboard`, button gets the `active` class), restores the route (highlight removed), disables (button gone) and runs
`ctx.assertClean('dashboard')` (no ledger entries, no DOM left).

## Terms

See `meta/TERMINOLOGY.md` ("Dashboard").

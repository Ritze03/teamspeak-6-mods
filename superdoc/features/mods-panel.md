# Mods page and the Dashboard mod

The injected UI of the mods: one **Mods** page in the client's Settings that lists every mod with its own switch (all
**default off**), and the mods themselves. Everything off = vanilla client; only the "Mods" entry in Settings remains.
The framework (core, slots, anchors, `api`, tests, launcher env) is documented in [ts6-mod-api.md](ts6-mod-api.md); the
underlying mechanics in [ts6-ui-extension-points.md](ts6-ui-extension-points.md); the AGC side in [agc.md](agc.md).

## Structure

- `panel/core/`: framework (`anchors.js`, `core.js`, `slots.js`, `page.js`, `core.css`). The Mods page is
  `panel/core/page.js` (`boot.page.install`); it is a Settings category pushed into the settings mode list by
  `anchors.js:addSettingsPage`.
- `panel/mods/audio/`: the AGC page, per-user audio popover and the AGC dropdown (see below).
- `panel/mods/dashboard/`: the Dashboard button.
- Injected by `tools/cdp/mods-inject.mjs` (bundle built by `tools/cdp/bundle.mjs`): one CDP socket stays open,
  `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate` (never `Page.reload`), plus the binding `ts6modNative` through
  which mods talk to the native control API (see [agc.md](agc.md), "Why"). Idempotent (`window.__ts6mod`). Open the page from
  code with `__ts6mod.open()` (or `__ts6mod.open(<mod id>, <tab>)` for one mod's page).

Switches are stored in the bridge blob `mods` ([ts6-mod-api.md](ts6-mod-api.md), "Persistence"); the page makes no request and holds
no timer until it is shown.

## Page layout: overview cards + one page per mod

`panel/core/page.js` renders two views in place inside the stock settings frame (`anchors.js:addSettingsPage`, scroll area + card):

- **Overview** (`renderGrid`): header "Mods", "N of M on · everything off = stock client", a search field ("Search mods and settings").
  Then a responsive grid (`.mods-grid`, `repeat(auto-fill, minmax(250px, 1fr))`) with one card (`[data-mod-card="<id>"]`) per registered
  mod: icon tile (`register.icon`, an SVG path; fallback puzzle piece), the name as a button that opens the mod, the mod's switch (top right,
  works without opening; the switch is TS's own toggle markup), the one-line `summary` (fallback `description`, clamped to 3 lines, full
  description as tooltip), and a footer with the status line ("Off", "On", "On · <status()>", "On · No settings", "Could not enable") and
  "Settings ›". Enabled cards get a faint accent tint. Card order: groups Audio, Interface, Server & network, Chat & files, Tools, then
  other groups, then mods without a group ("Other"); inside a group by `order`, then name. The status lines are refreshed every 2 s while
  the overview is shown (`status()` hooks must be cheap reads).
- **Search** (`match`): a card stays when the query is in its name, summary, description or group, or in one of its setting labels:
  `register.keywords` plus the labels harvested from the mod's page the last time it was shown (`harvest`: box titles, field labels,
  toggle titles, pills, buttons, tab names). A card matched by a label names it in its status line ("Matches “Ping limit”"). No match:
  "No mod or setting matches …". Typing while a mod page is open returns to the overview.
- **Mod page** (`renderDetail`, `[data-mod-page="<id>"]`): "‹ All mods", a header (icon tile, name, full description, the mod's switch),
  then the settings area `.mods-mod-body[data-ts6mod="<id>"]`, which is a box grid (`.mods-boxes`, `repeat(auto-fill, minmax(330px, 1fr))`).
  The mod's `settings(api, container)` renders into it; afterwards `boxify` turns every `ui.section` into a box, groups loose top-level
  nodes into untitled boxes, and leaves tabs (`ui.tabs`), the footer (`ui.footer`) and top-level notes / errors / status lines as
  full-width strips. `addSection` blocks are boxes too. Off: "This mod is off. Its settings are kept; switch it on to use them." (as
  before, settings only render while the mod is on, because `settings()` gets the enabled mod's scoped api). No settings at all: "This
  mod has no settings." Toggling the mod on its page re-renders the area; switching it off removes it (D7).
- **Memory**: the open mod and the search reset when the Mods category is left (returning shows the overview); the last tab per mod is
  kept for the session. `__ts6mod.open(id?, tab?)` opens the overview or a mod page (tests: `ctx.openModsPage(id, tab)`);
  `__ts6mod.page` = `{view(), openMod(id, tab), back(), search(q), tab()}` for tests.
- **Compact boxes**: inside a box sliders are one row (label · slider · value box with unit, fixed 92 px value column), toggle rows lose
  the stock 24 px gap, long toggle subtitles (> 90 characters) and slider/param help texts become hover tooltips with a small "?" mark
  (`ui.toggle`/`ui.slider`, `LONG_SUB`); short subtitles and `ui.note`s stay visible.
- **Theme**: surfaces are `--mods-surface` / `--mods-surface-2` / `--mods-surface-on` (the theme's text colour or accent mixed into
  transparency with `color-mix`, defined on `.mods-card` in `core.css`), so the cards are a shade lighter on dark themes and darker on
  light ones; all text colours are `--mods-*` tokens. Checked in the default theme and graphite at 1920 and 960 px.

Why (decision, the user reviewed mockups): the old page was one long list of every mod and every option, hard to navigate. Chosen: an
overview of cards (switch usable without opening) and, on click, that mod's own page in place (no modal), its settings as boxes in a
responsive grid; tabs only for Audio (Processing · Presets · Parameters · Per-user), every other mod is short enough to show its boxes
directly. Rejected: a drop-down mod selector, a left-hand mod list / two-pane view, and a cards/list view switch. At narrow widths
(960 px window) the grids simply drop to fewer columns and the boxes stack. The framework contract stays small and generic (optional
register fields and `ui.tabs`, see [ts6-mod-api.md](ts6-mod-api.md)), so third-party mods without the new fields still get a card
(fallback icon, group "Other").

### Test procedure (Mods page)

Automated, `tools/test/core-tests.mjs`: "Mods page lists mods with their switch state" (one card per registered mod, each card switch
shows its mod's state) and "Mods page (card switch, mod page and back, tabs, off note, search, audio tabs)": a throw-away mod with
group/icon/summary/keywords/status, a plain section and two tabs; checks the Off status, the card switch enabling it without leaving the
overview, the `status()` text and tint, no settings DOM on the overview, opening by the card name, boxes, tab bar + aside, tab switch
swapping the panels, back link (settings DOM removed), the remembered tab, the page switch (off note, settings removed / back), the
overview after leaving the category, search by keyword, by a harvested label, by another mod's title and with no match, and the audio
mod's four tabs. "slot: settings" covers `settings()` + `addSection` on the mod page and the scoped timers. By hand: the Mods page
section of [testing-guide.md](testing-guide.md).

## Audio mod

`panel/mods/audio/` (+ `panel/core/x-audio.js`): the AGC page (an "AGC" dropdown: TS6Mods / Vanilla / Vanilla (Experimental), whole-stream / per-speaker mode,
every DSP parameter, built-in and own presets, live meters, per-speaker and per-user lists) and the per-user "Audio..." popover. Everything is on the
mod's own page (four tabs); polling (meters 120 ms, status 2 s) runs in the settings scope, i.e. only while its page is shown and the mod is on.
The dropdown replaces the former master switch and the two stock playback AGC toggles; the mod switch off restores the user's stock values (vanilla rule).
Details, presets and the control API: [agc.md](agc.md#the-agc-dropdown-and-the-stock-playback-agc).

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

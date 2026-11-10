# Mods panel and Dashboard button

The injected UI of the mods: one **Mods** page in the client's Settings (all switches and the AGC controls) and optional
extras that each have their own switch. Source: `panel/panel.js` (+ `panel/panel.css`), injected by
`tools/cdp/mods-inject.mjs`. Underlying mechanics: [ts6-ui-extension-points.md](ts6-ui-extension-points.md);
the AGC side: [agc.md](agc.md).

## Injection

`tools/cdp/mods-inject.mjs` keeps one CDP socket open: `Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate` of
the panel (never `Page.reload`), plus the binding `ts6modNative` through which the page talks to the native control API
(see [agc.md](agc.md), "Why"). The script is idempotent (`window.__ts6mod`), waits for the Vue app, then pushes the
Settings page descriptor (`TS6Mods`) and rebuilds the nav list if Settings is already open. Open it from code with
`__ts6mod.open()`.

## Dashboard button

Dashboard = the client's home/start page. Natively it is reached through the main-menu (hamburger) entry
"Dashboard"; that entry selects the app item `appController.dashboard`, i.e. `appController.showItem(appController.dashboard)`
(route `#/dashboard`). The mod's button calls exactly that.

- Switch: Settings -> Mods -> Interface -> "Dashboard button", **default off**, stored as `dashboard_button` in the native
  config (applied at client start by the panel, `applySavedUi`).
- Placement: the left icon column (contacts, chats, bookmarks, groups). Each of those icons is its own
  `.tsv-resources-group` block inside `.resources-section`. The mod appends a fifth block of the same classes with the app's
  own `<ts-icon name="dashboard">` (same icon the menu entry uses). Highlighted while the route is `/dashboard`.
- Start-up: `appController.dashboard` does not exist while the UI is still loading, so the node is built lazily by `dashEnsure`
  (driven by the observer) once it does.
- Survival: a debounced `MutationObserver` on `document.body` (`dashEnsure`) puts the block back after Vue re-renders the
  sidebar; route changes do not matter because the block is outside the router view.
- Switching it off removes the node and the observer.

Why: the column's blocks are Vue-rendered from internal "resources", which a mod cannot add to, so DOM injection of a
same-class block is the least invasive route; the click handler is the native action, nothing is faked. (Top-bar placement
next to the AFK/mic/speaker controls was not needed.)

## Terms

See `meta/TERMINOLOGY.md` ("Dashboard").

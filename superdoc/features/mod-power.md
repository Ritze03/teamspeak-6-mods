# Power mod

Power-user tools in one switch (mod id `power`, default **off**): copy-ID entries in the right-click menus, a command
palette (default Ctrl+K) with local and join actions, and an unlocker for the client's hidden developer toggles. Off =
no menu entries, no hotkey listener, no palette DOM, nothing polled. Framework and rules: [ts6-mod-api.md](ts6-mod-api.md).

Files: `panel/mods/power/index.js` (the mod, no client internals), `panel/mods/power/style.css` (palette),
`panel/mods/power/test.mjs`, `panel/core/x-power.js` (every client-specific name, exposed as `api.power`).

## Features and settings

All settings are on the Power card's page (Settings -> Mods -> Power; boxes Command palette, Copy entries in the right-click menus, Hidden developer toggles) (stored with `api.storage`: `hotkey`, `copy`).

1. **Copy entries.** Right-click a user: *Copy unique ID*, *Copy client ID*, *Copy database ID* (only shown when the id is
   known), *Copy nickname*. Right-click a channel: *Copy channel ID*, *Copy channel path* (`Parent / Child`, without the
   server name), *Copy channel name* (off by default, the path ends in it). Each entry has its own switch in the settings
   (applies on the next menu open; `visible()` reads the setting every time). A toast confirms with the copied value, or
   says the clipboard was not available. Mechanism: `api.contextMenu.client/.channel.add`; `api.power.copy` writes with
   `navigator.clipboard.writeText` and falls back to a hidden `<textarea>` + `document.execCommand('copy')`.
2. **Command palette.** Setting *Shortcut* (default `Ctrl+K`, click the button and press a new combination; Esc cancels,
   it must contain Ctrl, Alt or Meta, or be an F-key; *Reset* restores the default). Overlay with a search field and a
   list; every space separated word must match as a subsequence of title, group or keywords, substring and word-start
   matches rank higher. Keys: Up/Down (wraps), Enter runs, Esc or the hotkey closes, click runs, click on the scrim closes;
   Tab is swallowed so focus stays in the field, and no key typed in the palette reaches the client. Items:
   - Go to: Open Settings, Open Mods page, Go to Dashboard.
   - Audio / Server (only while a connected server tab is displayed): Mute/Unmute microphone, Mute/Unmute speakers (press
     the toolbar's own buttons), Disconnect from server.
   - Mods: Enable/Disable every mod except Power itself (in-memory and persisted, same as the card switch).
   - Server: Switch to `<server>` for every other open server tab.
   - Channel: Join `<channel path>` for every channel of the displayed server except the one you are in. A
     password-protected channel is listed with a "password" tag and the join reports that it is protected. Spacer channels
     (`[spacer]`, `[cspacer]`, `[*spacer...]` names, `x-power.js:SPACER`) are decorative and not offered; their tag is
     stripped from channel paths.
   Running an item closes the palette first, then runs it; failures show a toast.
3. **Developer toggles.** Section *Hidden developer toggles* lists the client's hidden developer options with their live
   values and a switch each (keep active items in place, restore opened chats, skip UI permission checks, disable animated
   attachments, show activity categories, group contact requests, idle time chart, async virtual list scrolling, combine
   sidebar tabs). A warning line states that they change the real client settings and persist after the mod is switched off;
   risky ones carry an extra "experimental" line; one needs a client restart (shown). Values follow changes made elsewhere
   (polled every 1.5 s while the page is shown only). **The mod never changes them on its own**, not on enable, not on
   disable: only a click on a switch does. Not included on purpose: the hidden "transparent header" (the client forces it
   off whenever settings are applied), the playback AGC experimental switch (the audio mod owns it via `api.audio`), numeric
   and network options (tree icon slots, ICE port range, log level, loss resilience): out of scope for plain switches.

## Mechanism

- Context menus: the core's `contextMenu` slot (target gives `model`, `id`, `schid`).
- Hotkey: one capture-phase `keydown` listener on the document (`api.listen`); a match calls `preventDefault` and
  `stopImmediatePropagation`, so nothing else sees the combination. Ctrl+K is not used by the client itself (checked: the
  client's own document key handlers cover Ctrl+C, Ctrl+F/F3 and Escape in dialogs).
- Palette: built on open inside an `api.scope()`; closing disposes the scope (DOM node and listeners). The palette also
  closes on mod disable. Items are collected when the palette opens, not kept.
- Everything client-specific is in `panel/core/x-power.js`, namespace `api.power`:
  `copy`, `tokensCss`, `clientIds(target)`, `channelInfo(target)`, `servers`, `showServer`, `channels`, `join`, `disconnect`,
  `connected`, `micMuted`, `speakersMuted`, `toggleMic`, `toggleSpeakers`, `openSettings`, `mods`, `setMod`, `devFlags`,
  `setDevFlag`, and `test.*` (open/click a row's context menu without a mouse, read clients; used by `test.mjs`).
  Anchors added: `power.connections`, `power.workflowSettings`, `power.appearanceSettings`, `power.hideSidebarTabs`,
  `power.toolButtons`, `power.bridgeMove`.
- Joining: the bridge call `requestClientMove(schid, [ownClientId], channelId, password)` (documented in
  [ts6-modding-surface.md](ts6-modding-surface.md)), not a UI action, so it works from any page. Channel path: walk the
  channel's `parent` chain while it is a channel (the top channel's parent is the server object).
- Developer toggles: they live in the app controller's `workflowSettings` / `appearanceSettings` objects and
  `hideSidebarTabs`; written through `applyWorkflowSettings` / `applyAppearanceSettings` (what the client's own Developer
  page does, which also persists them), found by reading the Developer settings component in the UI bundle.
  `appController.developerTools` is the client's own (hidden) Developer page item, an alternative way to open it.
- Palette colours: `--mods-*` tokens plus `--power-surface/-scrim/-shadow`, built in `api.power.tokensCss()` from the
  client's own theme properties (the mod's CSS may not name them; there is no `--mods-surface` token yet, a core token for it
  would let `tokensCss` go).

Why:
- Hotkey in text fields: Ctrl/Alt/Meta combinations have no typing meaning (Chrome and the chat editor bind nothing to
  Ctrl+K), so the palette opens even from the chat box; a combination without those modifiers would swallow typing there, so
  the recorder refuses it and a hand-edited one is ignored while a text field has focus.
- Join through the bridge move, not by selecting the channel: it needs no tree to be displayed and gives a real success or
  error status for the toast.
- Mute actions press the toolbar buttons instead of setting properties: that is exactly what the user does, so every side
  effect (sound, state sync) matches.
- Items are computed on open: channel lists change constantly and nothing has to be kept in sync or removed.

## Test procedure

Automated: `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only power` (the full run covers lint, anchors
including the six `power.*` ones, and the vanilla check). `panel/mods/power/test.mjs` needs a client connected to a server with
another client and at least one more channel (it logs a SKIP line for parts it cannot do). It runs: off = Ctrl+K does nothing
-> enable -> copy menu on another client's row (menu lists the entries; clicking Copy unique ID / client ID / nickname, the
clipboard is read back and compared) and on a channel row (path) -> palette: opens on a trusted Ctrl+K, input focused,
arrows move, Esc and the hotkey close it, it opens with a text field focused, "mods page" + Enter opens the Mods page,
searching a channel name + Enter joins it (own channel id changes; the channel you are in is not offered) -> Mods page:
developer section lists every flag with the warning, clicking one switch flips the client setting and clicking again
restores it -> disable: no palette, no copy entries, `assertClean`. The test grants itself focus emulation and clipboard
permission over CDP (the test window is not focused; run-all puts the clipboard text back at the end). The palette join (join
another channel, go back) runs only on the local test server; on any other server it is a SKIP. The channel copy part picks a
channel whose row is rendered (the tree is a virtual list). Menu icons must be TS icon names (`item-copy`): an unknown name made
the client drop the item from the menu.

Manual: right-click a user, pick *Copy unique ID*, paste somewhere; press Ctrl+K, type part of a channel name, Enter.

## Known limits

- The test client window is not OS-focused, so real `navigator.clipboard` use there needs CDP focus emulation; with a focused
  window or the textarea fallback it works.
- Copy entries appear in the "Mods" section of the menu (shared with other mods), not in the menu's own sections.
- Database ID is empty until the client has fetched the user's info; the entry then stays hidden.
- Join does not prompt for channel passwords.
- `disconnect` calls the connection handler's `Disconnect()`; it was checked to exist, the test does not run it (it would
  end the test session).
- The hidden developer toggles are the client's own, their meaning can change per client version; `power.workflowSettings`
  and `power.appearanceSettings` anchors only check that the settings objects exist, not each key.

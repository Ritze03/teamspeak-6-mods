# Mod framework and mod API

The injected UI side of the mods is a small framework: **core** (`panel/core/`) plus any number of **mods**
(`panel/mods/<name>/`). A mod never touches TeamSpeak internals; it calls the semantic API below (`api.topBar.add`,
`api.contextMenu.client.add`, ...). Everything TS-specific sits in one file, `panel/core/anchors.js`. Mechanics behind
the slots (what was probed on the client): [ts6-ui-extension-points.md](ts6-ui-extension-points.md); launch/bridge/events:
[ts6-modding-surface.md](ts6-modding-surface.md); the Mods page and the Dashboard mod: [mods-panel.md](mods-panel.md).

```
launcher/ts6-mod -> tools/cdp/mods-inject.mjs --CDP--> UI page
   panel/core/anchors.js   the ONLY file naming TS classes/ids, Vue paths, bridge calls; every anchor has a resolve()
   panel/core/core.js      registry, cleanup ledger, persistence, api object, extend/defineSlot
   panel/core/slots.js     topBar, sidebar, contextMenu, treeRow, chatInput, toast, modal, state, nav, audio
   panel/core/page.js      "Mods" settings page, api.ui kit, api.settings
   panel/core/core.css     widget styles (only --mods-* tokens)
   panel/mods/<name>/      one mod each: index.js (+ style.css, test.mjs)
   panel/examples/<name>/  sample plugins, injected only on request
```

Why this shape: the UI is a minified Vue 2 app whose internals change per release. Concentrating every TS name in
`anchors.js` means a TS update breaks one file, and `anchors.check()` says which anchor (by name) no longer resolves.
Why per-mod cleanup is automatic: requirement "switching a mod off removes its DOM, listeners, timers and polling;
everything off = vanilla client". Mods get that for free because everything they create goes through the api, which
records an undo for it.

## Writing a mod

Convention: `panel/mods/<name>/index.js` (registers itself), optional `style.css` (added on enable, removed on disable),
optional `test.mjs` (see "Tests"). `<name>` is the directory name; the mod `id` should equal it.

```js
ts6mod.register({
  id: 'hello', title: 'Hello', description: 'Shows what the API can do.',   // card name; description = header of the mod's page
  // optional card metadata (all may be left out):
  group: 'Tools', order: 1,          // card order: Audio, Interface, Server & network, Chat & files, Tools, other groups, then "Other"
  icon: 'M4 5h16v11H9l-5 4z',        // SVG path (24x24 viewBox, stroked); fallback: a puzzle piece
  summary: 'One line for the card.', // fallback: description
  keywords: ['Shout'],               // setting labels the search finds before the page was ever opened
  status: api => 'loud',             // card status line while on ("On · loud"); cheap reads only, called every 2 s on the overview
  enable(api) {                      // runs when the switch goes on (default: off); may be async
    api.topBar.add({ title: 'Hello', icon: 'settings-addons', onClick: () => api.toast('Hello', 'It works') });
  },
  disable() {},                      // optional; only for state outside the api (the ledger undoes the rest)
  settings(api, container) {         // optional: the mod's own page on the Mods page while the mod is on
    container.append(api.ui.section('Box title', api.ui.note('Settings go here')));   // every ui.section becomes a box
    return () => {};                 // optional cleanup, called when the page is left
  },
});
```

**How the Mods page lays out a mod** (`panel/core/page.js`, details in [mods-panel.md](mods-panel.md)): the overview shows one card per
mod built from the fields above; the mod's page is a responsive grid of boxes (min 330 px). After `settings()` returns, `page.js:boxify`
makes each top-level `api.ui.section(title, ...)` a box, wraps other loose top-level nodes into untitled boxes, and keeps `api.ui.tabs`,
`api.ui.footer` and top-level `api.ui.note` / `.mods-error` / `.mods-status` elements as full-width strips. Add the class `mods-span` to a
section to make its box span the whole row (wide tables, e.g. the audio speaker list). So: group related controls with `ui.section`; a mod
with many settings may split them into tabs. Long toggle subtitles (> 90 characters) and slider `help` become hover tooltips.

Rules: (1) every mod defaults to **off**; (2) mods contain **no raw TS names**: this lint must stay empty and is step 1 of
run-all: `grep -rnE '(^|[^a-zA-Z0-9_])tsv?-|__vue__|tsclient_internal' panel/mods/`. Icon names such as `'settings-addons'` are
plain strings and fine. If a mod needs something the api lacks, add a slot/helper to core + anchors, not a TS name to the mod;
(3) use only `api.*` for anything that has to be undone (a raw `setInterval` in a mod is not cleaned up);
(4) style only with `--mods-*` tokens (below) so default and custom themes both work.

## How to build your own mod

A minimal mod from zero, using only the api. Samples to copy from: `panel/mods/dashboard/` (smallest real mod), `panel/mods/net/`
(settings, polling, popover), `panel/examples/ext-provider/` and `ext-consumer/` (extensions and slots).

1. **Folder.** `panel/mods/hello/` with `index.js` (the folder name is the mod id). Everything in `panel/mods/*/index.js` is bundled
   automatically (`tools/cdp/bundle.mjs:buildBundle`); a `style.css` next to it is added on enable and removed on disable.
2. **Register.** `index.js` calls `ts6mod.register({id: 'hello', title, description, enable(api), settings?(api, container)})`.
   The Mods page shows a card with a switch (default off). Nothing runs until the user switches it on. Give the card an `icon` (SVG path),
   a `group`, a one-line `summary` and, if useful, a `status(api)` line and search `keywords` (see "Writing a mod"); without them the card
   still works (puzzle icon, group "Other", the description as summary).
3. **Use a slot** in `enable(api)`: `api.topBar.add({title, icon, onClick})`, `api.sidebar.addIcon`, `api.contextMenu.client.add`,
   `api.treeRow.decorate`, `api.chatInput.onBeforeSend`, `api.toast` (table above). Timers, listeners and observers only through
   `api.interval/listen/observe/onDom`.
4. **Settings UI.** `api.storage.get(key, default)` / `.set(key, value)` persist; build the controls in `settings(api, container)` with
   the kit (`api.ui.toggle({title, sub, checked, onChange})`, `api.ui.slider({label, min, max, step, unit, value, onInput})`,
   `api.ui.note`, `api.ui.button`, ...), grouped into boxes with `api.ui.section(title, ...controls)`, as `panel/mods/net/index.js` does.
   Many settings? Split them into tabs: `container.append(api.ui.tabs([{name: 'One', content: [sectionA, sectionB]}, {name: 'Two',
   render: panel => panel.append(...)}]).el)` (`panel/mods/audio/index.js:settings`). Style only with the `--mods-*` tokens.
5. **Cleanup is automatic.** Whatever went through the api is undone when the switch goes off; write `disable()` only for state outside
   the api. Do not touch the DOM or timers directly in `enable`.
6. **A TS name needed?** Do not put it in the mod (the lint fails). Add `panel/core/x-hello.js` (an extension file, see below): define an
   anchor with `boot.anchors.def`, expose a small API with `boot.core.coreApi('hello', ...)`, and call `api.hello.*` from the mod.
7. **Test.** `panel/mods/hello/test.mjs` with `export default async function (ctx) {...}`; model it on `panel/mods/dashboard/test.mjs`:
   start from off, `ctx.enable`, assert the marked DOM (`[data-ts6mod="hello"]`), `ctx.disable`, `ctx.assertClean('hello')`.
8. **Run it.** With a modded client running (`launcher/ts6-mod`): `node tools/cdp/mods-reload.mjs --mod hello` hot-loads just that mod
   (no restart, other mods stay as they are), switch it on in Settings -> Mods, then
   `node tools/test/run-all.mjs --only hello` runs lint, anchor check and that mod's test (without `--only` everything runs).

```js
// panel/mods/hello/index.js
ts6mod.register({
  id: 'hello', title: 'Hello', description: 'Adds a button to the top bar.',
  group: 'Tools', icon: 'M4 5h16v11H9l-5 4z', summary: 'A top bar button that says hello.',
  status: api => (api.storage.get('shout', false) ? 'shouting' : ''),
  enable(api) {
    api.topBar.add({ title: 'Hello', icon: 'settings-addons', onClick: () => api.toast('Hello', api.storage.get('text', 'It works')) });
  },
  settings(api, container) {
    container.append(api.ui.section('Toast',
      api.ui.toggle({ title: 'Shout', sub: 'Use capitals in the toast.', checked: !!api.storage.get('shout', false), onChange: v => api.storage.set('shout', v) }).el));
  },
});
```

## API reference

`api` is created per mod on enable. Handles returned by `add`-style slot calls are `{remove(), update?(patch)}`; helper
calls (`interval`, `listen`, ...) return a plain undo function. Everything is also undone automatically on disable.
Status column: all slots below were run against the live client by `tools/test/core-tests.mjs` (yes) unless stated.

| Call | What it does | Mechanism (anchored in `anchors.js`) | Tested live |
|---|---|---|---|
| `api.topBar.add({title, icon, onClick, active})` or `add(element)` | button in the top bar next to mic/speaker; `active` bool or fn, `update(patch)` re-evaluates | wrap the `buttons` computed getter of the central toolbar component; element form appends the node to the toolbar | yes (spec form); element form not separately |
| `api.sidebar.addIcon({title, icon, onClick, active})` | button in the left icon column (several allowed, in registration order); `active` bool or fn, re-evaluated on every route change | own Vue block built from the column's markup + `<ts-icon>`, placed behind the last stock group, restored by a shared DOM observer | yes |
| `api.contextMenu.client.add({label, icon, onClick(target), visible(target)})` / `.channel.add(...)` | item in the right-click menu of client / channel rows (section "Mods"); `target = {kind, id, schid, name, model}`. `icon` must be a TS icon name (`'item-copy'`, `'settings-addons'`); an unknown or empty name falls back to `'settings-addons'` | `$watch('data')` on the context-menu container + last right-clicked row | yes |
| `api.contextMenu.server.add(...)` | **unsupported, throws** a clear error: the server entry has no context menu of its own (probed; a synthetic right-click on the sidebar header and root row opens nothing) | - | yes (throws) |
| `api.treeRow.decorate({for:'client'\|'channel', render(model)})` -> `{remove}` | inline marker at the end of every matching row; `render` returns string / Node / null; re-rendered on talk/property/move events; rows are recycled, markers keyed by model id | debounced DOM observer + `row.__vue__.$props.data` | yes |
| `api.treeRow.refresh()` | re-render all decorations now | - | yes (via events) |
| `api.chatInput.onBeforeSend(fn)` -> `{remove}` | `fn({text, limit, element, kind})`: return nothing (keep), `false` (cancel), a string (replace) or `string[]` (send each as its own message, in order, through the composer's own send path) | per composer instance, wrap `sendMessageContent` (both Enter and the send button end there); instances are found on `focusin` and by the DOM observer | logic yes (fake composer, because the test never sends a real message); real composer verified patched/restored |
| `api.chatInput.available() / limit() / element() / text() / setText(t)` | the active composer (the focused one, else the first): length limit (8192 here), the editable element, its text | reads `maxInputLength`, `msg` of the composer component | yes |
| `api.toast(title, text, opts?)` | local notification (notification center + bell) | `createGlobalNotification(plainObject)`; removed by tag on disable. Whether a transient popup is drawn is not confirmed visually | yes (enters/leaves the notification center) |
| `api.modal.show({title, render(container, close), onClose})` -> `{close()}` | the app's own modal overlay; closing on disable | `events.onInvokeModalOverlayEmitter.fire` | yes |
| `api.settings.addSection({title, render(container, scopedApi)})` | extra box on this mod's page on the Mods page | page.js | yes |
| `api.settings.addPage({key, title, icon, render(container, scopedApi)})` | a separate category in the client's Settings navigation; `icon` is a stock icon name or `{src: <image URL>}` (drawn by swapping the nav glyph for an `<img>`; the bundle exposes the root `icon.svg` as `boot.iconUrl`); the container sits in the stock page frame (scroll area + readable width), so long pages scroll like stock ones | push into the Settings mode list + rebuild nav | yes |
| `api.settings.open()` | open the Mods page (overview) | router | yes |
| `api.settings.show(tab?)` | open this mod's own page on the Mods page, optionally on a tab (the net popover's "Settings" link) | `page.js:core.open` | yes (core-tests via `__ts6mod.open`) |
| `api.events.on(name, cb)` | native -> UI events (`talkStatusChanged`, `clientMoved`, `textMessage`, ...) | one dispatcher per event name over `tsclient_internal.on` (it has no "off", so un-subscribing removes the callback from the dispatcher) | yes |
| `api.bridge.call(name, ...args)` | promisified native bridge call: resolves with the value (an array if the callback carries more than one value), rejects with `error.status` on non-zero status. Methods without a callback (`saveJsonBlob`, `deleteJsonBlob`) are detected and called without one | `tsclient_internal[name]` | yes |
| `api.state.connections() / current() / ownClient() / channel() / channels() / clients({all})` | read helpers over the displayed connection: plain summaries plus `.model` (the live Vue model) | `appController.connections`, `serverConnectionHandler` | yes |
| `api.version()` | `{api, client, build, chrome}`, e.g. build number for gating | `getClientLibVersion`, `getChromeVersion` (fetched before mods are enabled) | yes |
| `api.nav.route() / onDashboard() / showDashboard()` | route info; open the Dashboard (same action as the main-menu entry) | router, `showItem(dashboard)` | yes |
| `api.audio.stock() / setStockAgc(v) / setExperimentalAgc(v)` | read/set TeamSpeak's own playback AGC options (persist; the experimental one reopens the playback stream) | `audioSettings` model, see [ts6-modding-surface.md](ts6-modding-surface.md) | read yes; setters not run by tests (they change user settings) |
| `api.native.get(path)` / `.post(path, body)` / `.available()` | native module control API (`/config`, `/status`, `/meters`, `/speakers`, `/speaker`) through the CDP binding `ts6modNative` (the page cannot open http://) | binding + injector proxy | yes (audio mod) |
| `api.storage.get(key, default) / set / remove / all` | per-mod persisted settings | in memory + debounced `saveJsonBlob` | yes |
| `api.addStyle(css)` | `<style>` removed on disable (a mod's `style.css` is added the same way) | - | yes |
| `api.el(tag, props, ...kids)` | create a DOM node marked as this mod's (`data-ts6mod`); props: `class`, `on:{event:fn}`, `style`, attributes/properties | - | yes |
| `api.icon(name)` | the TS icon element (`<ts-icon>` needs Vue, so it is rendered through a tiny Vue instance; retried while the UI loads) | `Vue` + `ts-icon` | yes |
| `api.ui.*` | widget kit for settings areas: `toggle({title, sub, help?, checked, onChange})`, `row`, `subtitle`, `note`, `section(title, ...kids)` (= a box on the mod page), `row2`, `button`, `pill`, `slider({label, min, max, step, unit, value, help?, onInput, onCommit})`, `meter`, `footer(...kids)` (full-width line under the boxes; links right-aligned), `tabs`, `h` | TS settings markup for `toggle`, our `mods-*` classes for the rest; a long toggle `sub` (> 90 chars) or `help` becomes a tooltip with a "?" mark | yes (audio mod, core-tests) |
| `api.ui.tabs([{name, content: Node\|Node[]} \| {name, render(panel)}], {aside?, onSelect?})` -> `{el, select(name), current(), panel(name), aside}` | tab bar + panels; every panel is built at once and laid out as boxes, only the selected one is displayed; `aside` (text/Node, updatable via the returned `aside` element) sits right-aligned in the bar; the last tab is remembered per mod for the session | `page.js:ui.tabs` (the api version passes `key: <mod id>`) | yes (core-tests, audio) |
| `api.interval(fn, ms)`, `api.timeout(fn, ms)` | timers, cleared on disable | - | yes |
| `api.listen(target, type, fn, opts)` | DOM listener, removed on disable | - | yes |
| `api.observe(target, opts, cb)` | `MutationObserver`, disconnected on disable | - | yes |
| `api.onDom(cb, {debounce})` | debounced "something in the page changed" callback (one shared observer) | - | yes |
| `api.watch(getter, cb, opts)` | Vue `$watch` on app state, unwatched on disable | root vm `$watch` | not separately |
| `api.onRoute(cb)` | route change callback | `router.afterEach` | yes (sidebar `active`) |
| `api.scope()` | child api with its own ledger; `scope.dispose()` undoes just that. The `api` passed to `settings()` is a scope that dies when the Mods page is left | - | yes |
| `api.extend`, `api.ext`, `api.require`, `api.defineSlot`, `api.slots` | extensibility, see below | - | yes (examples) |

Not implemented from the original sketch ([ts6-ui-extension-points.md](ts6-ui-extension-points.md) section 10): `addHeaderItem`
(sidebar/content header icons) and `addPanel` (extra tab on a client/channel/server view). The mechanisms are known (prototype
getter wrap / `contentModes` push) and belong in `anchors.js` + `slots.js` when a mod needs them. `onReady` is internal (core
waits for the Vue app, then enables the switched-on mods).

### Extensibility (plugins that add API surface)

A mod can offer something to other mods, whichever is enabled first:

- `api.extend('name', impl)`: provider. `api.ext.name` gives `impl` to anyone (undefined while absent);
  `api.require('name', impl => { ...; return cleanupFn })` runs now if the provider is enabled, otherwise as soon as it is, and
  runs the cleanup when the provider goes away or the consumer is disabled. Names are unique (a second `extend` throws).
- `api.defineSlot('name', {attach(spec, {owner}) -> detachFn | {detach, update}})`: provider of a new slot. Consumers call
  `api.slots.name.add(spec)` -> `{remove(), update(patch)}`. Items added **before** the slot exists are queued and attached when
  it is defined; when the provider is disabled its items detach and are re-attached if the slot comes back. `api.slots.name.defined()`
  tells if a provider is there.

Why lazy resolution instead of load order: all mods are loaded first, then the switched-on ones are enabled in registration
order, so a consumer can easily be enabled before its provider; queueing/waiting makes the order irrelevant.
Samples: `panel/examples/ext-provider/` and `panel/examples/ext-consumer/`, with tests that run both orders.

## Persistence

One JSON blob under the bridge key `mods`: `{"enabled": {"<id>": true}, "settings": {"<id>": {...}}}`, written with
`tsclient_internal.saveJsonBlob(key, string)` (no callback) and read with `getJsonBlob(key, cb(status, string))` (empty
string when absent); `deleteJsonBlob(key)`. It lives in the profile's `json_blobs` table like the client's own blobs and
is not touched by the native config. The native AGC `enabled` switch deliberately stays in the native module's config file:
the audio hook needs it at client start, before any UI exists (see [agc.md](agc.md)).

## Theming

Mod styles use only the tokens `--mods-fg`, `--mods-muted`, `--mods-accent`, `--mods-accent-fg`, `--mods-error`, `--mods-ok`,
`--mods-warn`, `--mods-info`, `--mods-line`, `--mods-field-bg`, `--mods-field-line`, `--mods-track`, `--mods-hover`. `anchors.js`
(`themeTokens`) maps them onto TS's own custom properties (`--ts-primary-font-color`, `--ts-primary-accent-color`,
`--ts-error-color`, ...), so default and custom themes (which override those properties) both look right. The tokens and the
core stylesheet exist only while a mod is enabled or the Mods page is shown. The settings widgets (`api.ui.toggle`) reuse TS's
own markup/classes (via anchors), the rest are `mods-*` classes. Inside the Mods page (`.mods-card`) `core.css` also defines the derived surfaces `--mods-surface`, `--mods-surface-2`, `--mods-surface-on` and `--mods-soft-line` (the text colour or accent mixed into transparency with `color-mix`) for cards and boxes.

## Anchors

`panel/core/anchors.js` is the only place that names: DOM classes/ids (`.tsv-*`, `.ts-*`, `<ts-icon>`), Vue paths
(`__vue__`, `appController`, `contentModes`, `serverConnectionHandler`, ...) and bridge calls (`tsclient_internal.*`).
Families (each entry is `def(name, description, resolve, optional)`):

- `app.*`: root Vue instance, controller, Vue constructor, router, connections, settings mode list, Dashboard item, notifications, modal emitter, audio settings.
- `dom.*`: central toolbar, left icon column, context-menu container, tree scroller/rows (optional: only while a tree is shown), chat composer (optional: only while a chat is shown).
- `bridge.*`: the bridge methods the core uses (`on`, `getJsonBlob`, `saveJsonBlob`, `deleteJsonBlob`, `getClientLibVersion`, `getChromeVersion`).
- `class.*`: the TS CSS classes the widgets borrow, checked against the loaded stylesheets.
- `theme.tokens`: the TS custom properties the `--mods-*` tokens are built from.

Health check: `__ts6mod.anchors.check()` in the page runs every `resolve()` and returns `[{name, desc, ok, found, note}]`; step 2 of
run-all prints the failing ones by name. Optional anchors that are absent only because of what is displayed are not failures
(run-all opens a view with tree and composer first).

**After a TS update:** start the client with `launcher/ts6-mod`, run `node tools/test/run-all.mjs`. Every `FAIL anchor <name>`
names the resolve to fix in `anchors.js` (the failing selector/path is in its description). Fix it there (probe in the page with
`node tools/cdp/cdp.mjs eval '<expr>'`), then `node tools/cdp/mods-reload.mjs` swaps the code into the running client without a
restart, and re-run. Mods and tests should not need changes. `core-tests.mjs` additionally exercises each slot end to end, which
catches drift that a resolve cannot (e.g. the structure of a menu data object).

## Core extension files (`panel/core/x-<mod>.js`)

Use one when a mod needs a TS name (DOM class, Vue path, bridge call) or a core-level API that the built-in anchors and slots
lack. Each mod may own exactly one such file; it is a normal core file (an IIFE over `window.__ts6modBoot`), so it may name TS
internals, and the D18 grep over `panel/mods/` stays empty. It is still part of the anchors module in spirit: the mod owns the file,
but anything generally useful may later be promoted into `anchors.js` / `slots.js`. Why: parallel mod work must not collide on
`anchors.js` / `slots.js`.

Load order (`tools/cdp/bundle.mjs:coreFiles`): `anchors.js`, `core.js`, the other built-in files sorted, then every `x-*.js` sorted,
then the mods. Hot reload (`mods-reload.mjs`, `buildBundle({replace:true})`) picks them up like any core file.

Registration calls:

- `boot.anchors.def(name, desc, resolve, optional)`: a new anchor in the same table as the built-in ones, so
  `__ts6mod.anchors.check()` and run-all's anchor health check cover it. Also exposed for use in the file: `get`, `tryGet`, `$`, `$$`,
  `vue`, `cls`, `el`, `wait`, `bridge.call`, `bridge.on`.
- `boot.core.coreApi(name, (api, track, anchors) => impl)`: adds `api.<name>` to every mod's api (also to `api.scope()` apis).
  `track(kind, undo)` puts a resource in the calling mod's cleanup ledger, undone on disable, exactly like the built-in slots. The
  factory runs once per api object and must not create resources itself; do that inside `impl` methods. A name used twice, or equal
  to a built-in api member, throws.

```js
(function (boot) {
  const A = boot.anchors;
  A.def('net.status', 'connection status vm', () => document.querySelector('.tsv-status')?.__vue__, true);
  boot.core.coreApi('net', (api, track, anchors) => ({
    info: () => anchors.get('net.status').info,
    onChange(cb) { const un = api.events.on('connectStatusChanged', cb); return un; },   // api.events already tracks
    badge(text) { const n = api.el('span', {}, text); document.body.append(n); return track('net-badge', () => n.remove()); },
  }));
})(window.__ts6modBoot);
```

Test: `tools/test/core-tests.mjs` ("extension file registration") injects the same two calls at runtime and checks anchor listing,
ledger tracking, clean disable and the collision errors.

## Tests

`node tools/test/run-all.mjs [--cdp-port 9222] [--control-port 38998] [--examples] [--no-reload] [--only <id>]` (Node 22+, no
dependencies, against a running modded client; exit code 1 on any FAIL; SKIP does not fail):

1. **lint**: the grep above over `panel/mods/`;
2. **anchors**: every anchor resolves on this client;
3. **native signature scan**: `native/test/sigscan.sh` if it exists, else SKIP;
4. **mod tests**: every `panel/mods/*/test.mjs` (and `panel/examples/*/test.mjs` with `--examples`), then
   `tools/test/core-tests.mjs` (core + every slot; it may name TS internals because it tests the anchors layer);
5. **vanilla**: with every mod off, no `[data-ts6mod]` DOM, no ledger entries, no core stylesheet, no DOM observer, no native
   polling, no event subscriptions, no extensions/slots, and Settings has only the "Mods" entry.

Unless `--no-reload`, run-all first replaces the panel code in the page with the files on disk (same as `mods-reload.mjs`), so
tests judge the repo, not what the injector loaded at start. Mod switches are changed in memory only (`persist:false`) and put
back; the route is restored after every test; throw-away test mods (`t-*`) are removed. Also put back at the end: the persisted
`mods` blob (tests change settings through `api.storage`, which saves the whole store), the clipboard text and the window-size
override (run-all owns it: a test never sets its own `Emulation.setDeviceMetricsOverride`).

**Real client vs. test client.** run-all can run against the user's own client with no input and no side effect on the server:
every part that reaches the server (chat messages, moves/joins, private chats, local mutes, a second client, serverquery,
uploads) runs only when `ctx.onTestServer()` is true, and every part that writes files (theme edits) only when
`ctx.clientProfile().isolated`. Skipped parts print `SKIP <test>: <part>  <reason>`. Why: an accidental full run against the
real client once posted test messages and moved the user on a real server; the gates make that impossible instead of relying on
care. The full coverage needs an isolated client (`TS6MOD_PROFILE_DIR`) connected to a local test server; see
[test-rig.md](test-rig.md).

**Audio isolation (user rule).** Test clients never use the user's real microphone or speakers (the user talks on TeamSpeak while tests run and must not hear themselves). `connect_muted:true` does not mute on this build; run-all therefore mutes every isolated client under test and the second client (`AWARE_P2_CDP`, `TS6MOD_CHAT_CDP2`) itself: the client's own toggles (`SetClientSelfProperties({inputMuted:true, outputMuted:true})`) plus the audio streams (`pactl ...-mute`), re-applied every 500 ms, in `tools/test/mute-test-clients.mjs`; it prints `audio isolation: ... [input, output] = [true,true]`. Clients you start by hand must be muted right after connecting; verify with `tools/rig/audio-audit.mjs <cdp-port>` or `pactl list short source-outputs` / `sink-inputs`. The windows are parked on the hidden Hyprland workspace `special:ts6test` (rule + `tools/rig/hide-client.sh` fallback). Full rules, reasons and the window-rule line: [test-rig.md](test-rig.md) "Rules for every test client".

Isolated test clients must be launched with `--ozone-platform=x11 --disable-backgrounding-occluded-windows --disable-renderer-backgrounding --disable-background-timer-throttling` (`tools/rig/rig:CLIENT_FLAGS` passes them). A hidden or backgrounded client never runs `requestAnimationFrame`, so tests that wait on it fail (audio popover closes, layout sidebar collapse, slot modal `close()`, contextMenu item without icon).

The tests also have to hold on a real, busy profile (several mods already on, many channels, own chats open): count only nodes of your own mod (`[data-ts6mod="<id>"]`, e.g. tree-row decorations), only tree rows rendered inside the scroller, and wait for a node to exist before clicking it (pages and tabs render a moment after `ctx.openModsPage` returns).

**`test.mjs` contract:** `export default async function (ctx) { ... }`; throwing or a failed assert = FAIL. `ctx`:

| Member | Meaning |
|---|---|
| `ctx.eval(expr)` | evaluate an expression in the UI page (promises awaited), returns the JSON value |
| `ctx.enable(id)` / `ctx.disable(id)` | switch a mod in memory; resolves when `enable()` finished (throws with the mod's error if it failed) |
| `ctx.assert(cond, msg)` / `ctx.equal(actual, expected, msg)` | assertions (`equal` is deep via JSON) |
| `ctx.assertClean(id)` | the mod is off and left no trace: empty ledger (no timers/listeners/observers/slots/...), no `[data-ts6mod="id"]` node |
| `ctx.waitFor(expr, msg, ms)` | poll until truthy, else fail with `msg` |
| `ctx.openModsPage(id?, tab?)` / `ctx.restoreRoute()` | navigate to the Mods page: the overview, or mod `id`'s own page (needed to see its settings), optionally on tab `tab`; resolves once that view is shown / back to where the test started |
| `ctx.pressEscape()` | trusted Escape key (closes menus that ignore synthetic events) |
| `ctx.trace()` | core diagnostics: marked DOM, style/observer state, native request count, ledgers, extensions, slots, event subscriptions |
| `ctx.onTestServer()` | true only when every connection is to 127.0.0.1 / localhost / ::1: gate every server-side action on it |
| `ctx.clientProfile()` | `{configDir, isolated}` of the client process on `ctx.cdpPort` (from its environment); `isolated` = not the user's `~/.config`: gate every file write on it |
| `ctx.skip(part, reason)` | print a SKIP line for a part of the test that cannot run here (does not fail) |
| `ctx.controlPort`, `ctx.cdpPort`, `ctx.cdp`, `ctx.sleep(ms)`, `ctx.log(text)` | plumbing |

Test files live inside `panel/mods/<name>/`, so they are covered by the lint: use `__ts6mod.*` (core diagnostics) and the mod's own
marked DOM (`[data-ts6mod="<id>"]`), never TS names. Page-side core handles for tests: `__ts6mod.trace()`, `.ledger(id)`,
`.list()`, `.setEnabled(id, on, {persist})`, `.route()`, `.goto(path)`, `.open(id?, tab?)`, `.page` (`view()`, `openMod`, `back`, `search(q)`, `tab()`), `.anchors.check()`.

## Launcher, injector, hot reload

`launcher/ts6-mod` env vars:

| Env | Meaning |
|---|---|
| `TS6MOD_TS_BIN` | client binary; unset = discovery: `/opt/teamspeak`, `~/.local/opt/teamspeak`, then the Flatpak (see [flatpak.md](flatpak.md)) |
| `TS6MOD_FLATPAK=1` / `TS6MOD_FLATPAK_ID` | force Flatpak mode / app id (default `com.teamspeak.TeamSpeak`) |
| `TS6MOD_DRYRUN=1` | print the start command and exit (after discovery and the already-running checks) |
| `TS6MOD_CDP_PORT` | DevTools (CDP) port, default 9222 |
| `TS6MOD_PORT` | native control API port, default 38998 |
| `TS6MOD_PROFILE_DIR=<dir>` | isolated profile: `HOME` and `XDG_CONFIG_HOME/CACHE_HOME/STATE_HOME/DATA_HOME` point at subdirectories of `<dir>`, so several clients run side by side with their own settings database and native config/log; only a client on the same CDP port blocks the start |
| `TS6MOD_EXAMPLES=1` | also inject `panel/examples/*` (default off) |
| `TS6MOD_WRAP` | command prefix, e.g. `ccorral --` |

Everything else on the command line is passed to the client, e.g. `ts3server://<host>:<port>?nickname=<name>` to auto-connect.
Without `TS6MOD_PROFILE_DIR` the launcher refuses to start while a default-profile client runs (a second start would be swallowed by
the running instance and the module could not be preloaded); clients carrying a different `--remote-debugging-port` are assumed to be
isolated and are ignored. Example for a second client: `TS6MOD_PROFILE_DIR=<dir> TS6MOD_CDP_PORT=9230 TS6MOD_PORT=39000 launcher/ts6-mod`.

`tools/cdp/mods-inject.mjs [--cdp-port N] [--port N] [--examples]` injects (`Page.addScriptToEvaluateOnNewDocument` + `Runtime.evaluate`;
**never `Page.reload`**, it wipes the client's auto-connect state) one script built by `tools/cdp/bundle.mjs`: `panel/core/*.js` (anchors,
core first), then every `panel/mods/*/index.js` with its `style.css`, then `panel/examples/*` only with `--examples`. It is idempotent
(`window.__ts6mod` guard) and keeps the `ts6modNative` binding that proxies `/config`, `/status`, `/meters`, `/speakers`, `/speaker` to the native control API (the allow-list is a regex in `mods-inject.mjs`; anything else is refused) and the narrow image-file reader binding `ts6modReadImage` (see [mod-files.md](mod-files.md)).

`node tools/cdp/mods-reload.mjs [--cdp-port N] [--examples] [--mod <id>]...` hot-swaps the panel code from disk into the running client
(whole core + mods, or just the named mod directories); mods that were on stay on. Use it while developing a mod instead of restarting.

Mechanics of a whole-core swap: `unload()` of the old core disables every mod, peels its composer hook and flushes a pending
save, then leaves the ids of the mods that were on (in memory, so also `persist:false` ones) in `window.__ts6modCarry`; the new
core's `start()` enables those instead of the persisted set. `__ts6mod.ready` turns true once `start()` enabled its mods.
Why: a core replaced while its own `start()` was still awaiting used to enable mods into a dead core, which left its DOM, styles
and composer hook behind (two HUDs, a message split twice after rapid reloads). Now `start()` and `enableRec` stop as soon as
the core is unloaded, and the composer hook tags each wrapper with its core (`__ts6modLayer`) and peels layers of dead cores
before wrapping (`anchors.chat.layers(vm)`, `chat.restoreAll()`). Test: core-tests "hot reload twice keeps exactly one
composer hook layer".

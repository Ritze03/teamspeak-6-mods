# TeamSpeak 6 UI extension points (injected JS)

How to extend the stock TS6 UI from JS injected over CDP (see [ts6-modding-surface.md](ts6-modding-surface.md)
for launch, bridge, events and version gating). Probed live on `6.0.0beta5` (Vue 2.7.16). Every snippet
below was run against the real client and screenshot/DOM-verified unless marked **untested**.

**Why these mechanisms:** the UI is a minified Vue 2 app and its component classes are not exported to the
page, so we cannot subclass or register components. What *is* reachable is (a) the `appController` object graph
(plain data that components render from), (b) live component instances through `el.__vue__`, and (c) the Vue
constructor itself (`root.constructor`, walk `.super`). Extension therefore means "append to the data the app
already renders" (best: survives re-render, looks native) or "wrap a getter / computed", and only as a last resort
DOM injection. Any patch is lost on UI reload (and must not be undone by `Page.reload`; see the other page).

Shared prelude (all snippets assume it):
```js
const root = document.querySelector('#app').__vue__;
const app  = root.appController;
let Vue = root.constructor; while (Vue.super) Vue = Vue.super;          // the real Vue 2 constructor
const conn = () => app.connections[0].serverConnectionHandler;          // live model, .id = schid
const forceUpdateAll = v => { v.$forceUpdate(); v.$children.forEach(forceUpdateAll); };
```
Menu/tool items are instances of an internal class; get its constructor from any existing item
(`new (existingItem.constructor)(title, iconName, onSelected)`). Icon names are plain strings
(`'settings-addons'`, `'microphone'`, `'speaker'`, ...; same names as in the bundle's icon enum).

## 1. Custom page in Settings  (works; survives route changes)

Settings is an activity whose pages come from `app.contentModes.settings` (array of mode descriptors). The
nav list is built by the categories component from that array: known keys go to fixed groups, **unknown keys land
in an automatic "Others" group**. A page's `component` is a **function returning a Promise of a Vue constructor**
(not an ES-module-shaped object).
```js
app.contentModes.settings.push({
  component: 'ts-settings-view', keepAlive: true, renderKey: 'settings',
  image: 'settings-addons', key: 'ModSettings', title: 'My Mod',
  extraProps: { component: () => Promise.resolve(Vue.extend({
    render(h) { return h('div', { staticClass: 'ts-card ts-widget' }, [
      h('div', { staticClass: 'ts-card-setting-container' }, [h('label', 'Hello from a mod')])]); } })) },
});
```
- The nav is computed once in `created()` of the categories component (`.tsv-settings-categories .tsv-list`).
  Push **before Settings is first opened**, or rebuild an already-open one:
  `const v=document.querySelector('.tsv-settings-categories .tsv-list').__vue__; [].concat(v.$options.created).forEach(f=>f.call(v));`
- Open it: `root.$router.push('/settings?mode=ModSettings')` (hash `#/settings?mode=<key>`) or `app.showItem(app.settings, 'ModSettings')`.
- Re-use TS CSS classes (`ts-card`, `ts-widget`, `ts-card-setting-container`, `ts-toggle` etc.) to look native.
- Limits: a plain `Vue.extend({render})` cannot use TS's own registered components (`ts-toggle`, ...) unless you
  render them via `this.$root`-registered names (untested); build with plain elements + TS CSS, or pull component
  constructors from existing vm's (`someVm.$options.components`).
- Persisting mod settings: use `app.userConfiguration.setValueForKey('<key>', json)` / `getValueForKey` (writes the
  profile's `general_settings`; namespace your key, e.g. `mod.<name>`), or the bridge `saveJsonBlob/getJsonBlob`
  (own blob key), or your helper daemon.

## 2. Top bar and toolbars  (works; survives route changes)

- **Central toolbar** (mic / speaker buttons at window top, `.tsv-central-toolbar`): its component computes
  `buttons` locally. Wrap the computed watcher's getter:
  ```js
  const v = document.querySelector('.tsv-central-toolbar').__vue__, w = v._computedWatchers.buttons, g = w.getter;
  w.getter = function (vm) { const base = g.call(this, vm); const Item = base[0].constructor;
    const it = new Item(); it.image = 'settings-addons'; it.title = 'Mod'; it.identifier = 'mod-tb';
    it.onSelected = () => {/* ... */}; return [...base, it]; };
  w.dirty = true; v.$forceUpdate();
  ```
  Verified: button rendered next to speaker, survived settings <-> chat navigation. `it.class = {active: bool}` toggles
  the active state; `it.tooltip`, `it.badgeText`, `it.contextMenuData = {component, data:{sections:[...]}}` exist (items
  have ~50 fields: `onSelected/onAltSelected/onShiftSelected`, `badgeCount`, `isDisabled`, `accessory*`).
- **Sidebar header** (server name row; `headerBarItems`) and per-activity bars (`activityBarItems`, `accessoryItems`)
  are getters on the activity class prototype. Wrap on the prototype, then invalidate cached computeds:
  ```js
  const P = Object.getPrototypeOf(app.connections[0]);   // connection activity class
  const d = Object.getOwnPropertyDescriptor(P, 'headerBarItems'), orig = d.get;
  Object.defineProperty(P, 'headerBarItems', { configurable: true, enumerable: d.enumerable,
    get() { const base = orig.call(this) || []; const Item = base[0] && base[0].constructor; if (!Item) return base;
      const it = new Item('Mod', 'settings-addons', () => {}); return [...base, it]; } });
  (function walk(v){ const cw=v._computedWatchers; if(cw) for(const k in cw) if(/BarItems|headerTools|accessoryItems/.test(k)) cw[k].dirty=true; v.$forceUpdate(); v.$children.forEach(walk); })(root);
  ```
  Verified: button appears in the sidebar header. `activityBarItems` of the connection activity are **not** the top
  bar (they were patched with no visible effect; the top bar is the central toolbar above).
- **Content header icons** (info / chat / files at top right of a channel or client view) come from `headerBarItems`
  of the *content* item (channel/client class); same technique on that class's prototype (**untested** per class).
- **Free-form live info** (e.g. a bitrate badge): not a component slot; use DOM injection (section 4) into a stable
  host such as `.tsv-sidebar-header`, or a modal/popover.

## 3. Context (right-click) menus  (works for clients and channels; callbacks get ids)

All tree/right-click menus render through one root component `context-menu-container`
(`root.$children.find(c => c.$options.name === 'context-menu-container')`). Opening a menu assigns its
`data` = `{ buttons: Item[], sections: [{title, items: Item[]}] }`; the list is built fresh per opening by an internal
static helper (not reachable), so you hook the *container*, not the builder:
```js
const cm = root.$children.find(c => c.$options.name === 'context-menu-container');
let row = null;                                                             // remember what was right-clicked
document.addEventListener('contextmenu', e => { row = e.target.closest('[class*=ts-server-tree-item-]'); }, true);
cm.$watch('data', d => {
  if (!d || !d.sections) return;
  const comp = row && row.__vue__ || {}, target = (comp.$props && comp.$props.data) || comp.data;   // client or channel model
  const Item = (d.buttons[0] || d.sections[0].items[0]).constructor;
  const it = new Item('My action', 'settings-addons', () => {
    // target.constructor.name: client class or channel class; ids:
    const schid = target.sc_handler.id, id = target.id;                       // client: number id, channel: string id
  });
  d.sections.push({ title: 'Mods', items: [it] });                            // or d.buttons.push(it) for a top-level row
});
```
Verified: item appears below the built-in entries, runs with `{clientId 146, schid 1}` for a client row and
`{channelId "44", schid 1}` for a channel row; selecting it closes the menu; handler receives one argument (the DOM event).
- Client/channel rows are DOM `.ts-server-tree-item-leaf.client|.channel`, a Vue component with prop `data` = the model.
  Context menus opened from other places (chat, header, tabs) use the same container; the target discovery above
  then needs another `closest()` selector (**untested** for server/chat/avatar menus).
- Built-ins remain (including destructive ones such as kick/ban); a mod can also *remove* items by filtering
  `d.sections[*].items` (identify by `title`; titles are localized, so match the localization key's English text
  only as a fallback).
- Conditional items: decide inside the `$watch` callback from `target.properties` / permissions
  (`conn().permissionManager.GetPermissionValueByName('b_client_kick_from_server')`).

## 4. Channel / client tree rows  (works; use DOM, survives scroll recycling)

The tree is a virtual list (`.ts-server-tree-scroller`); rows are recycled, so Vue re-patches them. Inject with a
debounced `MutationObserver` that (re)adds a marker element from the row's model:
```js
const deco = () => document.querySelectorAll('.ts-server-tree-item-leaf.client').forEach(row => {
  const c = row.__vue__ && row.__vue__.$props.data, host = row.querySelector('.ts-server-tree-client-info__name-row');
  if (!c || !host) return;
  let b = host.querySelector(':scope > .mod-badge');
  if (!b) { b = document.createElement('span'); b.className = 'mod-badge'; host.appendChild(b); }
  b.textContent = '#' + c.id + (c.properties.flagTalking ? ' ♪' : '');
});
new MutationObserver(() => { clearTimeout(window.__t); window.__t = setTimeout(deco, 50); })
  .observe(document.querySelector('.ts-server-tree-scroller'), { childList: true, subtree: true });
```
Verified: badge next to nicknames, correct after scrolling away and back. Notes: Vue owns those subtrees, so keep the
injected node a trailing child of a stable container and re-add it whenever it is missing; do not store state on it.
Update on events (`talkStatusChanged`, `clientPropertiesUpdated`) by re-running `deco`. A **per-user level badge is not
possible from real data**: there are no per-speaker level events (only talking on/off), see the other page.
Channel rows: `.ts-server-tree-item-leaf.channel` (model `row.__vue__.$props.data`). Alternative to DOM: wrap the row
component's `render` via its constructor options (`row.__vue__.constructor.options.render`) (**untested**).

## 5. Client info panel, sidebars, chat area, notifications

- **Extra tab/panel on a client, channel, server or connection view:** push a mode descriptor into
  `app.contentModes.client | channel | server | connection | ...` (keys seen: `client: ClientInfo, Chat, OwnFiles`;
  `channel: ChannelInfo, Chat, ChannelFiles`; `server: Info, ServerLog, Permissions, BanList, ...`;
  `connection: ServerTree`; `chatRoom`, `localChat`, `whisper`, `dashboard`, `resources`, ...). Same descriptor shape as
  section 1 but `component` is directly the lazy ctor (`component: () => Promise.resolve(Vue.extend({props:['item','data'], render}))`);
  optional `isAvailable(item)`, `isListed(item)`, `hideImage`. Verified on a client: the mode shows in
  `app.modesForContent(client)`, opens via `app.showItem(client, 'ModClientInfo')` (hash
  `#/connection<N>/client<id>:<uid>?mode=,ModClientInfo`) and rendered with `item.id` available.
- **Chat area:** the message composer has an `integrations` hook (`integrationsManager`, chat-input integrations); not
  explored. Chat events arrive as native `textMessage`/`tschat_*` events and can be observed read-only.
- **Notifications / toasts:** `app.createGlobalNotification(n)` or `app.notificationCenter.add(n)`. The notification class
  is not exported; a plain object with the same fields works (title, type 0=Plain, subtitle, text, image, displayDuration,
  identifier, dismissable, `seen`/`expirationTime` getters, `dismiss()`, `remove()`, `compare()`; optional
  `actions: [{title, image, onSelected, isConstructive}]`). Verified: it entered `notificationCenter.visibleNotifications`
  and the bell badge incremented. Whether a transient popup toast is drawn was **not confirmed visually**
  (the bell panel shows it). Remove with `app.notificationCenter.remove(n)`. Native notifications:
  `tsclient_internal.tsnotifications_showNotification` (OS-level, **untested**).

## 6. Hotkeys

- Native hotkeys are fixed actions (connect/disconnect, PTT, PTM, mic/speaker mute, master volume, channel
  commander, whisper, stream, away, profile, 3D sound). Presses arrive as the native event
  `onHotkey` with `{type, mode, target}`; `tsclient_internal.on('onHotkey', cb)` lets a mod *observe* them
  (**untested live**; derived from the dispatcher). The key-binding list is hard-coded, so a mod **cannot add a new
  bindable action** to Settings -> Key Bindings without also injecting UI there.
- Options for custom shortcuts: (a) in-window `keydown` listeners (only while the window has focus; works, plain DOM);
  (b) the official Remote Apps websocket (`127.0.0.1:5899`, one-time user approval): an external helper sends
  `{type:'keyPress', payload:{button, state}}`, which the *user* binds to an existing action in Key Bindings;
  (c) a helper daemon with its own global-hotkey backend that then calls the bridge over CDP.

## 7. Modals and dialogs (native look)  (works)

Fire the app's own modal event; the window renders the component in its modal overlay and handles dimming/Escape:
```js
app.events.onInvokeModalOverlayEmitter.fire({
  identifier: 'mod-modal', data: { hello: 'world' },
  component: () => Promise.resolve(Vue.extend({ props: ['data'],
    render(h) { return h('div', { staticClass: 'ts-card', style: 'padding:24px' }, [
      h('h3', 'My modal'), h('p', this.data.hello),
      h('button', { on: { click: () => this.$emit('close') } }, 'Close')]); } })),
});
```
Verified: overlay appears (`app.modalOverlayVisible` true), `$emit('close')` removes it. Unstyled content sits top-left; wrap
in TS classes for polish. Also available: `app.pushFullscreenQueueItem({identifier, component, props})` (full-window
overlay used for terms/login; **untested**), `app.openExternalLink(url)` (trusted-host guard), and the lightbox/URL-warning
emitters.

## 8. Theming

- DOM/CSS: `<style>` injection works like any page (**not separately tested; the inline-style badge was**). The UI is built on
  ~650 CSS custom properties (`--tsv-*` layout/typography/radius, `--ts-primary-background`, `--ts-primary-accent-color`,
  `--ts-primary-font-color`, `--tsv-bg`, `--tsv-border-radius*`, `--tsv-font-size*`). Override them on `:root`.
- Official route: theme extensions (CSS in `<profile>/extensions/<id>/` with `package.json`; see the other page) are
  loaded by the app (`app.availableThemes`, `app.applyUserStyle`, `app.getUserStyles`, `app.refreshAvailableUserStyles`).
  Injected `<style>` is applied after and wins on equal specificity; mods should only set variables / namespaced classes
  so they compose with whatever theme the user chose.
- Component CSS is scoped by `data-v-*` attributes; override by class, not by those attributes (they change per build).

## 9. Data and actions available to mods

- **Subscribe (native):** `tsclient_internal.on(...)`: client joined/left/moved (`clientMoved`: `type` 0 subscription/appeared,
  1 moved by self, 2 moved by other, 3 timeout, 4 kick channel, 5 kick server, 6 ban), `talkStatusChanged`,
  `clientPropertiesUpdated` (full property object), `channelPropertiesUpdated`, `textMessage` (**untested live**),
  `connectStatusChanged`, `serverError`, `log`, device/audio events.
- **Subscribe (Vue):** `vm.$watch(() => model.field, cb)`; `root.$store.subscribe(mutation => ...)`
  (account/UI state only); `router.afterEach` for route changes.
- **Safe (local-only) actions:** navigation (`$router.push`, `app.showItem`), `contentModes` edits, notifications,
  per-client volume with `persist=false`, UI settings via
  `userConfiguration`, all getters.
- **Server-affecting (confirm with the user in the mod):** moves, kicks, bans, messages/pokes, channel edits, permission
  edits, file transfers, account calls. Never call from an automatic hook.

## 10. Mod API sketch (facts, no implementation)

| Helper | Mechanism | Section |
|---|---|---|
| `onReady(cb)` | poll `#app.__vue__.appController.connections.length`, then run | modding-surface, startup |
| `getVersion()` | `getClientLibVersion` build + Chrome major + feature probes | modding-surface |
| `addSettingsPage({key,title,icon,render})` | push into `contentModes.settings`; re-run categories `created` if open | 1 |
| `addToolbarItem({title,icon,onClick,active})` | wrap `buttons` computed getter of `.tsv-central-toolbar` vm | 2 |
| `addHeaderItem(...)` | prototype getter wrap on activity class + dirty computeds | 2 |
| `addContextMenuItem({for:'client'\|'channel', title, icon, onSelect(target), visible(target)})` | `$watch('data')` on `context-menu-container` + last right-clicked row | 3 |
| `decorateRow({for, render(model)->string\|node})` | debounced MutationObserver + `row.__vue__.$props.data` | 4 |
| `addPanel({for:'client'\|'channel'\|'server', key, title, render})` | push into `contentModes.<kind>` | 5 |
| `toast(title, text)` | `createGlobalNotification(plainObject)` | 5 |
| `showModal(component, data)` | `events.onInvokeModalOverlayEmitter.fire` | 7 |
| `addStyle(css)` / `setVars({...})` | `<style>` / `:root` custom properties | 8 |
| `on(event, cb)` | `tsclient_internal.on` (+ unsubscribe by wrapping) | 9 |
| `bridge.call(name, ...args)` | promisified `tsclient_internal` (status != 0 rejects) | modding-surface |
| `storage.get/set(key)` | `userConfiguration.getValueForKey/setValueForKey` | 1 |
| `audio.setExperimentalAgc(bool, {persist})` | `audioSettings[0].global.agcExperimentalMode` + `Update()` (+`save()`) | modding-surface |

Cross-cutting rules for the loader: do everything idempotently (guard with a `window.__mod*` flag, since UI code may run
twice), keep an undo list for every patch (prototype getters, computed getters, observers, pushed descriptors), and
re-apply nothing after a UI reload (see "Do not Page.reload").

## Could not hook / unknown

- A native (OS) context menu or window chrome: not part of the page.
- Adding a new Key Binding action; per-speaker levels; remote-audio PCM.
- Server/chat/avatar context menus, content-header icons per class, `ts-*` registered components inside injected
  settings pages, popup (separate window) targets: **untested**.

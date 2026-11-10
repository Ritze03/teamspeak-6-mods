/* ts6-mods anchors: the ONLY file of the panel code that names TeamSpeak internals.
 *
 * Everything the mod core and the mods need from the TS UI goes through this file: DOM class names and ids
 * (tsv-*, ts-* elements), Vue vm paths (__vue__, appController, contentModes, serverConnectionHandler, ...) and
 * bridge calls (tsclient_internal.*). Mods never see any of it; they call the semantic API of core.js.
 *
 * After a TS update only this file should need fixing: every anchor is a named entry with a resolve() function,
 * `anchors.check()` runs them all and says which one broke (run-all.mjs does that against the live client).
 * See superdoc/features/ts6-mod-api.md ("Anchors").
 */
(function (boot) {
  'use strict';
  const entries = [];            // {name, desc, optional, resolve}
  const byName = new Map();
  const def = (name, desc, resolve, optional) => { const e = { name, desc, optional: !!optional, resolve }; entries.push(e); byName.set(name, e); return e; };
  const wait = ms => new Promise(r => setTimeout(r, ms));
  const $ = (s, r) => (r || document).querySelector(s);
  const $$ = (s, r) => [...(r || document).querySelectorAll(s)];

  class AnchorError extends Error { constructor(name, desc, why) { super(`anchor "${name}" (${desc}) not resolved: ${why || 'missing'}`); this.anchor = name; } }
  /* get('name') -> value, or throws AnchorError naming the anchor */
  function get(name) {
    const e = byName.get(name); if (!e) throw new Error('unknown anchor ' + name);
    let v, why = '';
    try { v = e.resolve(); } catch (err) { why = String(err && err.message || err); }
    if (v === undefined || v === null || v === false) throw new AnchorError(name, e.desc, why);
    return v;
  }
  const tryGet = name => { try { return get(name); } catch (e) { return null; } };

  /* ================= anchors: Vue app graph ================= */
  def('app.root', 'root Vue instance of the UI page: #app.__vue__', () => $('#app').__vue__);
  def('app.controller', 'the app singleton: root.appController', () => get('app.root').appController);
  def('app.Vue', 'the real Vue 2 constructor (root.constructor, walk .super)', () => { let V = get('app.root').constructor; while (V.super) V = V.super; return V; });
  def('app.router', 'vue-router instance: root.$router', () => get('app.root').$router);
  def('app.connections', 'live server connections: appController.connections (array of activities)', () => { const c = get('app.controller').connections; return Array.isArray(c) ? c : null; });
  def('app.settingsModes', 'array of Settings page descriptors: appController.contentModes.settings', () => get('app.controller').contentModes.settings);
  def('app.settingsNav', 'Settings categories list vm (only while Settings is open)', () => { const e = $('.tsv-settings-categories .tsv-list'); return e && e.__vue__; }, true);
  def('app.dashboardItem', 'the Dashboard app item: appController.dashboard + showItem()', () => { const a = get('app.controller'); return typeof a.showItem === 'function' && a.dashboard; });
  def('app.notify', 'appController.createGlobalNotification + notificationCenter.add/remove', () => { const a = get('app.controller'); return typeof a.createGlobalNotification === 'function' && typeof a.notificationCenter.add === 'function' && typeof a.notificationCenter.removeNotificationsByTagPrefix === 'function'; });
  def('app.modal', 'modal overlay emitter: appController.events.onInvokeModalOverlayEmitter.fire', () => typeof get('app.controller').events.onInvokeModalOverlayEmitter.fire === 'function');
  def('audio.settings', 'output audio settings model: connections[0].serverConnectionHandler.audio.audioSettings (needs a connection)', () => { const c = get('app.connections')[0]; return c && c.serverConnectionHandler.audio.audioSettings; }, true);

  /* ================= anchors: DOM ================= */
  def('dom.toolbar', 'central toolbar (mic/speaker buttons) element, vm computed "buttons"', () => { const e = $('.tsv-central-toolbar'); return e && e.__vue__ && e.__vue__._computedWatchers && e.__vue__._computedWatchers.buttons && e; });
  def('dom.sidebarColumn', 'left icon column container holding the icon groups', () => $('.resources-section'));
  def('dom.contextMenu', 'context menu container vm (context-menu-container) with reactive data', () => get('app.root').$children.find(c => c.$options.name === 'context-menu-container'));
  def('dom.treeScroller', 'channel tree scroller element', () => $('.ts-server-tree-scroller'), true);
  def('dom.clientRows', 'client rows in the channel tree: row vm has $props.data', () => { const r = $('.ts-server-tree-item-leaf.client'); return r && r.__vue__ && r.__vue__.$props.data && r; }, true);
  def('dom.channelRows', 'channel rows in the channel tree: row vm has $props.data', () => { const r = $('.ts-server-tree-item-leaf.channel:not(.spacer)'); return r && r.__vue__ && r.__vue__.$props.data && r; }, true);
  def('dom.chatInput', 'chat message composer vm (chat-input) with sendMessageContent/maxInputLength (only while a chat is displayed)', () => { const e = $('.ts-chat-input-container'); const v = e && e.__vue__; return v && typeof v.sendMessageContent === 'function' && v; }, true);

  /* ================= anchors: native bridge ================= */
  const bridge = () => window.tsclient_internal;
  for (const m of ['on', 'getJsonBlob', 'saveJsonBlob', 'deleteJsonBlob', 'getClientLibVersion', 'getChromeVersion'])
    def('bridge.' + m, 'tsclient_internal.' + m, () => typeof bridge()[m] === 'function');

  /* ================= anchors: CSS classes the widgets rely on ================= */
  const cls = {
    card: 'ts-card ts-widget full', rowBox: 'ts-card-setting-container', toggleWrap: 'ts-toggle-wrapper ts-flex row', col: 'tsv-flex-column',
    subtitle: 'tsv-font-subtitle', toggle: 'ts-toggle', toggleInner: 'ts-toggle-inner', flex: 'tsv-flex tsv-flex-wrap tsv-flex-snd-center',
    cardContent: 'ts-card-content',
    group: 'tsv-resources-group', bar: 'tsv-bar tsv-tabs tsv-tabs-slim tsv-tabs-combined', tab: 'tsv-tab-item tsv-bar-item', flexCenter: 'tsv-flex tsv-flex-center', magnify: 'tsv-magnify',
    iconPlain: 'tsv-icon-no-animation tsv-icon-base-third-color',
  };
  let cssText = null;
  const cssHas = c => {
    if (cssText === null) { cssText = ''; for (const ss of document.styleSheets) { try { for (const r of ss.cssRules) cssText += (r.selectorText || '') + ' '; } catch (e) { /* cross-origin sheet */ } } }
    return cssText.includes('.' + c);
  };
  for (const k of ['card', 'rowBox', 'toggle', 'toggleInner', 'cardContent', 'tab', 'group'])
    for (const c of cls[k].split(' ').filter(c => /^ts-|^tsv-/.test(c)))
      def('class.' + c, 'CSS class .' + c + ' exists in the loaded stylesheets', () => cssHas(c));

  /* ================= theme tokens (TS custom properties -> mod tokens) ================= */
  const themeTokens = {
    '--mods-fg': 'var(--ts-primary-font-color, #d2d2d2)', '--mods-muted': 'var(--ts-muted-font-color, #888)',
    '--mods-accent': 'var(--ts-primary-accent-color, #6aa0ff)', '--mods-accent-fg': 'var(--ts-primary-font-color-invert, #111)',
    '--mods-error': 'var(--ts-error-color, #ff6b6b)', '--mods-ok': 'var(--ts-settings-info-color, #3ddc84)', '--mods-warn': 'var(--ts-settings-warning-color, #ffb74d)',
    '--mods-info': 'var(--ts-brand-color-bl, #64b5f6)', '--mods-line': 'var(--ts-divider-bg-color, rgba(128,128,128,.3))',
    '--mods-field-bg': 'var(--ts-select-bg, rgba(128,128,128,.15))', '--mods-field-line': 'var(--ts-select-border-color, rgba(128,128,128,.35))',
    '--mods-track': 'var(--ts-toggle-bg-color, rgba(128,128,128,.25))', '--mods-hover': 'var(--ts-tree-item-hover-bg-color, rgba(128,128,128,.28))',
  };
  def('theme.tokens', 'TS custom properties the mod tokens are built from (e.g. --ts-primary-font-color)', () => { const cs = getComputedStyle(document.documentElement); return cs.getPropertyValue('--ts-primary-font-color') !== '' && cs.getPropertyValue('--ts-primary-accent-color') !== ''; });
  const cssSelectors = () => `.mods-sidebar-icon.active .tsv-tab-item { background: var(--mods-hover); border-radius: 8px; }\n`;

  /* ================= low-level helpers ================= */
  const vue = () => ({ root: get('app.root'), app: get('app.controller'), Vue: get('app.Vue'), router: get('app.router') });
  async function ready(timeoutMs = 60000) {   // the Vue app exists a moment after the document starts
    const t0 = Date.now();
    while (Date.now() - t0 < timeoutMs) {
      try { const a = tryGet('app.controller'); if (a && a.contentModes && a.contentModes.settings && tryGet('app.Vue') && tryGet('app.router')) return true; } catch (e) { /* not yet */ }
      await wait(250);
    }
    return false;
  }
  const isReady = () => { try { const a = tryGet('app.controller'); return !!(a && a.contentModes && a.contentModes.settings); } catch (e) { return false; } };

  /* ---- native bridge ---- */
  const nativeOn = (name, cb) => bridge().on(name, cb);   // tsclient_internal has no "off": core.js keeps one dispatcher per event name
  function call(name, ...args) {   // promisified; callbacks are (status, value, extra)
    return new Promise((res, rej) => {
      const fin = (status, ...rest) => { if (status !== 0) return rej(Object.assign(new Error(`${name} failed with status ${status}`), { status })); res(rest.length > 1 ? rest : rest[0]); };
      try { bridge()[name](...args, fin); }
      catch (e) {
        if (/Too many arguments/.test(String(e.message))) { try { res(bridge()[name](...args)); } catch (e2) { rej(e2); } }   // fire-and-forget methods (saveJsonBlob/deleteJsonBlob) take no callback
        else rej(e);
      }
    });
  }
  const getBlob = key => new Promise(res => { try { bridge().getJsonBlob(key, (s, v) => res(s === 0 ? v : '')); } catch (e) { res(''); } });
  const saveBlob = (key, text) => bridge().saveJsonBlob(key, text);   // (key, string), no callback
  const versionInfo = () => new Promise(res => {
    const out = { client: '', build: 0, chrome: '' }; let n = 2; const done = () => { if (--n === 0) res(out); };
    try { bridge().getClientLibVersion((s, build, str) => { if (s === 0) { out.build = build; out.client = String(str).replace(/\s*\[.*$/, ''); } done(); }); } catch (e) { done(); }
    try { bridge().getChromeVersion(v => { out.chrome = String(v); done(); }); } catch (e) { done(); }
    setTimeout(() => { n = 1; done(); }, 2000);
  });

  /* ---- icons: <ts-icon> is a registered Vue component, so it needs a Vue render ---- */
  function icon(name) {
    const { Vue } = vue(); const holder = document.createElement('span'); holder.className = 'mods-icon';
    let vm = null, tries = 0, dead = false, timer = 0;
    const attempt = () => {
      if (dead) return;
      if (vm) { try { vm.$destroy(); } catch (e) { /* ignore */ } vm = null; }
      vm = new Vue({ render: h => h('ts-icon', { attrs: { name }, class: cls.iconPlain }) }); vm.$mount();
      if (vm.$el && vm.$el.nodeType === 1) holder.replaceChildren(vm.$el);
      else if (++tries < 40) timer = setTimeout(attempt, 250);   // icons are not ready while the UI is still loading
    };
    attempt();
    return { el: holder, destroy() { dead = true; clearTimeout(timer); if (vm) { try { vm.$destroy(); } catch (e) { /* ignore */ } vm = null; } holder.replaceChildren(); } };
  }

  /* ---- routes / navigation ---- */
  const route = () => { const r = get('app.root').$route; return { path: r.path, fullPath: r.fullPath, params: Object.assign({}, r.params), query: Object.assign({}, r.query) }; };
  function onRoute(cb) { const un = get('app.router').afterEach(() => { try { cb(route()); } catch (e) { console.error('[ts6mod] route cb', e); } }); return typeof un === 'function' ? un : () => {}; }
  const goto = path => { Promise.resolve(get('app.router').push(path)).catch(() => {}); };   // vue-router resolves with a huge Route object: never hand it back
  const showOwnChannelChat = () => { const h = currentHandler(), a = get('app.controller'); a.showItem(h.ownClient.channel, 'Chat'); };   // dev/test helper: a view with tree + composer
  const showDashboard = () => { const a = get('app.controller'); a.showItem(a.dashboard); };
  const onDashboard = () => route().path === '/dashboard';
  const openSettings = key => { const a = get('app.controller'); get('app.router').push('/settings' + (key ? '?mode=' + encodeURIComponent(key) : '')); return a && true; };

  /* ---- settings pages ---- */
  function rebuildSettingsNav() {   // the nav list is computed once in created() of the categories component
    try { const v = tryGet('app.settingsNav'); if (v) [].concat(v.$options.created).forEach(f => f.call(v)); } catch (e) { /* nav appears next time Settings opens */ }
  }
  /* page: {key, title, icon, mount(host), unmount(host)}; host is the page's root element. Returns undo. */
  function addSettingsPage(page) {
    const { Vue } = vue(), modes = get('app.settingsModes');
    const ctor = Vue.extend({
      name: 'ts6-mods-page-' + page.key,
      render(h) { return h('div', { class: cls.card + ' mods-card' }); },
      mounted() { page.mount(this.$el); }, activated() { page.mount(this.$el); },
      deactivated() { page.unmount(this.$el); }, beforeDestroy() { page.unmount(this.$el); },
    });
    const desc = { component: 'ts-settings-view', keepAlive: true, renderKey: 'settings', image: page.icon || 'settings-addons', key: page.key, title: page.title, extraProps: { component: () => Promise.resolve(ctor) } };
    const i0 = modes.findIndex(m => m.key === page.key); if (i0 >= 0) modes.splice(i0, 1);
    modes.push(desc); rebuildSettingsNav();
    return () => { const i = modes.indexOf(desc); if (i >= 0) modes.splice(i, 1); rebuildSettingsNav(); };
  }
  const settingsModeKeys = () => get('app.settingsModes').map(m => m.key);

  /* ---- widgets that borrow TS markup (settings look) ---- */
  const el = (tag, props, ...kids) => {
    if (props != null && (typeof props !== 'object' || props.nodeType || Array.isArray(props))) { kids.unshift(props); props = null; }   // el('span', 'text') / el('div', child)
    const n = document.createElement(tag);
    if (props) for (const k in props) { const v = props[k]; if (v == null || v === false) continue; if (k === 'class') n.className = v; else if (k === 'on') for (const ev in v) n.addEventListener(ev, v[ev]); else if (k === 'style' && typeof v === 'object') Object.assign(n.style, v); else if (k in n && k !== 'list') n[k] = v; else n.setAttribute(k, v); }
    for (const kid of kids.flat()) if (kid != null && kid !== false) n.append(kid.nodeType ? kid : document.createTextNode(String(kid)));
    return n;
  };
  let uid = 0;
  /* TS settings toggle markup. -> {el, set(checked), setDisabled(b)} */
  function toggle({ title, sub, checked, onChange, disabled }) {
    const id = 'mods-toggle-' + (uid++);
    let on = !!checked, dis = !!disabled;
    const input = el('input', { id, type: 'checkbox', tabindex: dis ? -1 : 0, checked: on });
    const inner = el('div', { class: cls.toggleInner + ' visible' }, input), sw = el('div', { class: cls.toggle + ' visible', on: { click: e => click(e) } }, inner);
    const label = el('label', { class: cls.col, on: { click: e => click(e) } }, el('span', title), sub ? el('p', { class: cls.subtitle }, sub) : null);
    const root = el('div', { class: cls.rowBox }, el('div', {}, el('div', { class: cls.toggleWrap }, label, el('div', { class: cls.flex }, sw))));
    const paint = () => { for (const n of [sw, inner]) n.classList.toggle('checked', on); input.checked = on; root.classList.toggle('mods-disabled', dis); input.tabIndex = dis ? -1 : 0; };
    function click(e) { if (e) { e.preventDefault(); e.stopPropagation(); } if (dis) return; on = !on; paint(); onChange && onChange(on); }
    input.addEventListener('click', e => e.stopPropagation()); input.addEventListener('change', () => { if (!dis) { on = input.checked; paint(); onChange && onChange(on); } });
    paint();
    return { el: root, set(v) { on = !!v; paint(); }, get: () => on, setDisabled(b) { dis = !!b; paint(); } };
  }
  const settingsRow = (...kids) => el('div', { class: cls.rowBox }, ...kids);
  const subtitle = text => el('p', { class: cls.subtitle }, text);

  /* ---- central toolbar (top bar) ---- */
  /* specs: () => [{id,title,icon,onClick,active}]; wraps the "buttons" computed getter; returns {refresh, undo} */
  function toolbarPatch(getSpecs) {
    const tb = get('dom.toolbar'), vm = tb.__vue__, w = vm._computedWatchers.buttons, orig = w.getter;
    w.getter = function (v) {
      const base = orig.call(this, v), Item = base[0] && base[0].constructor; if (!Item) return base;
      const extra = getSpecs().map(s => { const it = new Item(); it.image = s.icon; it.title = s.title; it.identifier = 'ts6mod-' + s.id; it.onSelected = e => s.onClick && s.onClick(e); if (s.active) it.class = { active: true }; return it; });
      return [...base, ...extra];
    };
    const refresh = () => { w.dirty = true; vm.$forceUpdate(); };
    refresh();
    return { vm, refresh, undo() { if (w.getter !== orig) w.getter = orig; refresh(); }, alive: () => !vm._isDestroyed && w.getter !== orig && document.contains(tb) };
  }
  const toolbarVm = () => { const tb = tryGet('dom.toolbar'); return tb && tb.__vue__; };
  const toolbarHost = () => tryGet('dom.toolbar');

  /* ---- left icon column ---- */
  /* block: a Vue-rendered group with the app's own markup; {el, setActive(b), destroy()} or null while the icons are not ready */
  function sidebarBlock({ title, icon: name, onClick, active }) {
    const { Vue } = vue();
    const vm = new Vue({
      data: { active: !!active },
      render(h) {
        return h('div', { class: cls.group + ' mods-sidebar-icon' + (this.active ? ' active' : ''), attrs: { title }, on: { click: e => onClick && onClick(e) } }, [h('div', { class: cls.bar }, [h('div', { class: cls.tab }, [
          h('div', { class: cls.flexCenter }, [h('div', { class: cls.magnify }, [h('ts-icon', { attrs: { name }, class: cls.iconPlain })])])])])]);
      },
    });
    vm.$mount();
    if (!vm.$el || vm.$el.nodeType !== 1) { vm.$destroy(); return null; }
    return { el: vm.$el, setActive(b) { vm.active = !!b; }, destroy() { vm.$destroy(); if (vm.$el && vm.$el.parentNode) vm.$el.parentNode.removeChild(vm.$el); } };
  }
  /* put the blocks (in order) behind the last stock group; no-op while the column does not exist */
  function sidebarPlace(blocks) {
    const sec = tryGet('dom.sidebarColumn'); if (!sec || !blocks.length) return;
    const groups = $$(':scope > .' + cls.group.split(' ')[0] + ':not(.mods-sidebar-icon)', sec).filter(g => g.querySelector('.' + cls.tab.split(' ')[0]));   // skips the empty bottom drop-area group
    const last = groups[groups.length - 1]; if (!last) return;
    let prev = last;
    for (const b of blocks) { if (prev.nextElementSibling !== b.el) prev.after(b.el); prev = b.el; }
  }
  const sidebarObserveRoot = () => document.body;

  /* ---- context menus ---- */
  const ROW = '.ts-server-tree-item-leaf.client, .ts-server-tree-item-leaf.channel';
  function rowTarget(row) {
    if (!row) return null;
    const vm = row.__vue__, m = vm && (vm.$props && vm.$props.data || vm.data); if (!m) return null;
    const kind = row.classList.contains('client') ? 'client' : 'channel';
    return { kind, id: m.id, schid: m.sc_handler && m.sc_handler.id, model: m, name: kind === 'client' ? m.nickname : (m.properties && m.properties.name) };
  }
  /* hook(d, target, makeItem): called when a menu opens, may push into d.sections/d.buttons. Returns undo. */
  function contextMenuHook(hook) {
    const cm = get('dom.contextMenu'); let row = null;
    const rec = e => { row = e.target && e.target.closest && e.target.closest(ROW); };
    document.addEventListener('contextmenu', rec, true);
    const unwatch = cm.$watch('data', d => {
      if (!d || !d.sections) return;
      const first = (d.buttons && d.buttons[0]) || (d.sections[0] && d.sections[0].items && d.sections[0].items[0]); if (!first) return;
      const Item = first.constructor;
      const target = rowTarget(row); row = null;   // a stale row must not leak into a menu opened some other way
      try { hook(d, target, (label, ic, fn) => new Item(label, ic, fn)); } catch (e) { console.error('[ts6mod] context menu hook', e); }
    });
    return () => { document.removeEventListener('contextmenu', rec, true); unwatch(); };
  }

  /* ---- channel tree rows ---- */
  const KIND = { client: { sel: '.ts-server-tree-item-leaf.client', host: '.ts-server-tree-client-info__name-row' }, channel: { sel: '.ts-server-tree-item-leaf.channel:not(.spacer)', host: '.ts-server-tree-item-node-content.channel' } };
  function treeRows(kind) {
    const k = KIND[kind]; if (!k) throw new Error('unknown row kind ' + kind);
    return $$(k.sel).map(row => { const vm = row.__vue__, model = vm && vm.$props && vm.$props.data, host = $(k.host, row); return model && host ? { row, host, model } : null; }).filter(Boolean);
  }
  const treeRoot = () => tryGet('dom.treeScroller') || document.body;

  /* ---- chat composer ---- */
  const chatInputs = () => $$('.ts-chat-input-container').map(e => e.__vue__).filter(v => v && typeof v.sendMessageContent === 'function');
  const chatInfo = vm => ({ limit: vm.maxInputLength, text: vm.msg, element: vm.$el.querySelector('.cm-content') || vm.$el, kind: vm.chat ? 'chat' : (vm.room ? 'room' : 'unknown') });
  /* wrap sendMessageContent of one composer instance: wrapper(orig, vm) returns the replacement function. Returns undo. */
  function chatPatch(vm, wrapper) {
    const had = Object.prototype.hasOwnProperty.call(vm, 'sendMessageContent'), orig = vm.sendMessageContent;
    vm.sendMessageContent = wrapper(orig.bind(vm), vm);
    return () => { if (had) vm.sendMessageContent = orig; else delete vm.sendMessageContent; };
  }
  const chatSetText = (vm, t) => { vm.msg = t; };
  const chatGetText = vm => vm.msg;

  /* ---- notifications / modals ---- */
  function toast({ id, title, text, subtitle, duration }) {
    const a = get('app.controller'); let seen = false;
    const n = {
      title, text: text || '', subtitle: subtitle || '', type: 0, image: undefined, displayDuration: duration || 6000, identifier: id, tag: id, dismissable: true,
      presentationTime: 0, occurrenceCount: 1, preventGrouping: true,
      get seen() { return seen; }, set seen(v) { seen = v; },
      get expirationTime() { return (this.presentationTime || Date.now()) + this.displayDuration; },
      dismiss() { a.notificationCenter.remove(this); }, remove() { a.notificationCenter.remove(this); }, compare(o) { return o === this; },
    };
    a.createGlobalNotification(n);
    return () => { try { a.notificationCenter.remove(n); } catch (e) { /* already gone */ } };
  }
  const toastCleanup = tag => { try { get('app.controller').notificationCenter.removeNotificationsByTagPrefix(tag); } catch (e) { /* ignore */ } };
  /* spec: {id, render(host, close)}; returns {close()} */
  function modal({ id, render, onClose }) {
    const { Vue, app } = vue(); let closed = false, cmp = null;
    const comp = Vue.extend({
      props: ['data'],
      render(h) { return h('div', { class: 'ts-card mods-modal' }); },
      mounted() { cmp = this; this.$el.__close = () => { this.$emit('close'); }; render(this.$el, () => { this.$emit('close'); });   /* $emit returns the vm: never hand that back */ },
      beforeDestroy() { if (!closed) { closed = true; onClose && onClose(); } },
    });
    app.events.onInvokeModalOverlayEmitter.fire({ identifier: id, data: {}, component: () => Promise.resolve(comp) });
    return { close() { if (cmp && !closed) cmp.$emit('close'); } };
  }

  /* ---- observable state (read helpers) ---- */
  const handlers = () => (tryGet('app.connections') || []).map(c => c.serverConnectionHandler).filter(Boolean);
  function currentHandler() {
    const conns = tryGet('app.connections') || []; let id = null;
    try { id = get('app.root').$route.params.activityIdentifier; } catch (e) { /* no route yet */ }
    const c = conns.find(c => c.id === id) || conns[0]; return c && c.serverConnectionHandler;
  }
  const clientSummary = (h, c) => ({ id: c.id, nickname: c.nickname, uid: c.uid, channelId: c.channel && c.channel.id, talking: !!c.properties.flagTalking, inputMuted: !!c.properties.inputMuted, outputMuted: !!c.properties.outputMuted, away: !!c.properties.away, self: c.id === h.ownClientId, model: c });
  const channelSummary = ch => ({ id: ch.id, name: ch.properties && ch.properties.name, parentId: ch.parent && ch.parent.id, model: ch });
  const stateOf = h => h && ({
    schid: h.id, connected: h.connectionStatus === 4,
    ownClient: h.ownClient ? clientSummary(h, h.ownClient) : null,
    channel: h.ownClient && h.ownClient.channel ? channelSummary(h.ownClient.channel) : null,
    clients: [...h.GetFlatListClients()].map(c => clientSummary(h, c)),
    channels: [...h.GetFlatListChannels()].map(channelSummary),
  });

  /* ---- TeamSpeak's own playback AGC settings (audio mod) ---- */
  const audioSettings = () => tryGet('audio.settings');
  function readStockAgc() {
    const s = audioSettings(); if (!s) return null;
    try { const b = s.buildPlaybackDspBlob(); if (b) return { agc: !!b.agc, experimental: !!b.agc_experimental_mode }; } catch (e) { /* internals changed: hide the rows */ }
    return null;
  }
  function activeOutDevice(s) {   // {mode, deviceId} of the active output device
    const id = s[0].device && s[0].device.id; if (!id) return null;
    for (const [mode, list] of s[0].devices) if (list.some(e => e[0].id === id)) return { mode, deviceId: id };
    return null;
  }
  function setStockAgc(v) {
    const s = audioSettings(), d = s && activeOutDevice(s); if (!d) throw new Error('active output device not found');
    s.onAudioDspSettingsChanged({ io: 0, settings: { mode: d.mode, deviceId: d.deviceId, agc: !!v } });   // what the stock toggle does
    s.save();
  }
  function setExperimentalAgc(v) {   // documented in superdoc/features/ts6-modding-surface.md
    const s = audioSettings(); if (!s) throw new Error('audio settings unavailable');
    s[0].global.agcExperimentalMode = !!v;
    get('app.connections').forEach(c => c.serverConnectionHandler.audio.Update());   // pushes agc_experimental_mode; reopens the playback stream
    s.save();
  }

  /* ================= health check ================= */
  function check() {
    return entries.map(e => {
      let v, why = '';
      try { v = e.resolve(); } catch (err) { why = String(err && err.message || err); }
      const found = !(v === undefined || v === null || v === false);
      return { name: e.name, desc: e.desc, optional: e.optional, ok: found || e.optional, found, note: found ? '' : (e.optional ? 'absent right now (optional, depends on what is displayed)' : (why || 'not found')) };
    });
  }

  boot.anchors = {
    get, tryGet, check, entries: () => entries.map(e => ({ name: e.name, desc: e.desc, optional: e.optional })), AnchorError,
    ready, isReady, vue, cls, themeTokens, cssSelectors,
    el, wait,
    bridge: { call, getBlob, saveBlob, on: nativeOn, versionInfo },
    icon, route, goto, showOwnChannelChat, onRoute, showDashboard, onDashboard, openSettings,
    settings: { addPage: addSettingsPage, keys: settingsModeKeys },
    ui: { toggle, row: settingsRow, subtitle },
    toolbar: { patch: toolbarPatch, vm: toolbarVm, host: toolbarHost },
    sidebar: { block: sidebarBlock, place: sidebarPlace, observeRoot: sidebarObserveRoot },
    contextMenu: { hook: contextMenuHook },
    tree: { rows: treeRows, root: treeRoot },
    chat: { inputs: chatInputs, info: chatInfo, patch: chatPatch, setText: chatSetText, getText: chatGetText },
    toast, toastCleanup, modal,
    state: { handlers, current: currentHandler, of: stateOf },
    audio: { readStock: readStockAgc, setStock: setStockAgc, setExperimental: setExperimentalAgc },
  };
})(window.__ts6modBoot);

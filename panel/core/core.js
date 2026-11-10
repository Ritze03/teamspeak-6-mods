/* ts6-mods core: mod registry, per-mod cleanup ledger, persistence and the API object every mod gets.
 * Contains no TeamSpeak names (those live in anchors.js). The slots (top bar, sidebar, menus, ...) are api parts in
 * slots.js, the "Mods" settings page is page.js. Docs: superdoc/features/ts6-mod-api.md. */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  const API_VERSION = 1;
  const mods = new Map();                       // id -> rec
  const changeSubs = new Set();
  const parts = [];                             // api part builders: (api, rec) => void
  const stats = { nativeRequests: 0, loadErrors: [] };
  let started = false, startError = null, versionInfo = { client: '', build: 0, chrome: '' };
  let store = { enabled: {}, settings: {} };
  let loading = null;
  const warn = (what, e) => console.error('[ts6mod] ' + what, e);
  const fire = () => changeSubs.forEach(f => { try { f(); } catch (e) { warn('change listener', e); } });

  /* ---------- core stylesheet: only present while a mod is enabled or the Mods page is shown ---------- */
  let styleRefs = 0, styleEl = null;
  function coreStyle(delta) {
    styleRefs = Math.max(0, styleRefs + delta);
    if (styleRefs > 0 && !styleEl) {
      styleEl = document.createElement('style'); styleEl.setAttribute('data-ts6mod-core', '');
      const tok = Object.entries(A.themeTokens).map(([k, v]) => `${k}: ${v};`).join(' ');
      styleEl.textContent = `:root { ${tok} }\n` + A.cssSelectors() + (boot.coreCss || '');
      document.head.appendChild(styleEl);
    } else if (styleRefs === 0 && styleEl) { styleEl.remove(); styleEl = null; }
  }

  /* ---------- cleanup ledger ---------- */
  function makeLedger() {
    const items = new Set(); let disposed = false;
    const run = it => { try { it.undo(); } catch (e) { warn('undo ' + it.kind, e); } };
    return {
      add(kind, undo) {
        const it = { kind, undo };
        if (disposed) { run(it); return () => {}; }
        items.add(it);
        return () => { if (items.delete(it)) run(it); };
      },
      counts() { const c = {}; for (const it of items) c[it.kind] = (c[it.kind] || 0) + 1; return c; },
      get size() { return items.size; },
      dispose() { disposed = true; for (const it of [...items].reverse()) { items.delete(it); run(it); } },
    };
  }

  /* ---------- persistence: one JSON blob "mods" = {enabled:{id:bool}, settings:{id:{...}}} ---------- */
  let saveTimer = 0;
  const saveStore = () => { clearTimeout(saveTimer); saveTimer = setTimeout(() => { try { A.bridge.saveBlob('mods', JSON.stringify(store)); } catch (e) { warn('saving mods blob', e); } }, 250); };
  async function loadStore() {
    try { const t = await A.bridge.getBlob('mods'); const o = t ? JSON.parse(t) : {}; store = { enabled: o.enabled || {}, settings: o.settings || {} }; }
    catch (e) { warn('reading mods blob', e); store = { enabled: {}, settings: {} }; }
  }

  /* ---------- native control API (CDP binding, the page cannot open http://) ---------- */
  const waiting = new Map(); let seq = 0;
  window.__ts6modReply = r => { const w = waiting.get(r.id); if (w) { waiting.delete(r.id); clearTimeout(w.t); r.ok ? w.res(r.text ? JSON.parse(r.text) : null) : w.rej(new Error(r.status ? 'HTTP ' + r.status : r.text)); } };
  function nativeRequest(path, body) {
    return new Promise((res, rej) => {
      if (typeof window.ts6modNative !== 'function') return rej(new Error('bridge missing'));
      const id = ++seq, t = setTimeout(() => { waiting.delete(id); rej(new Error('timeout')); }, 2000);
      waiting.set(id, { res, rej, t }); stats.nativeRequests++;
      window.ts6modNative(JSON.stringify({ id, path, body }));
    });
  }

  /* ---------- shared native event dispatcher (tsclient_internal.on has no "off") ---------- */
  const nativeSubs = new Map();
  function nativeSubscribe(name, cb) {
    let s = nativeSubs.get(name);
    if (!s) { s = new Set(); nativeSubs.set(name, s); A.bridge.on(name, (...a) => s.forEach(f => { try { f(...a); } catch (e) { warn('event ' + name, e); } })); }
    s.add(cb); return () => s.delete(cb);
  }

  /* ---------- shared debounced DOM observer ---------- */
  const domSubs = new Set(); let domObs = null;
  function domSubscribe(cb, debounce) {
    const sub = { cb, t: 0, debounce };
    domSubs.add(sub);
    if (!domObs) { domObs = new MutationObserver(() => domSubs.forEach(s => { clearTimeout(s.t); s.t = setTimeout(() => { try { s.cb(); } catch (e) { warn('onDom', e); } }, s.debounce); })); domObs.observe(document.body, { childList: true, subtree: true }); }
    return () => { clearTimeout(sub.t); domSubs.delete(sub); if (!domSubs.size && domObs) { domObs.disconnect(); domObs = null; } };
  }

  /* ---------- extensions (api.extend) and slots (api.defineSlot) ---------- */
  const exts = new Map(), waiters = [];
  function fireWaiter(w) {
    const e = exts.get(w.name);
    if (e && !w.fired) { w.fired = true; try { const r = w.cb(e.impl); if (typeof r === 'function') w.cleanup = r; } catch (err) { warn('require ' + w.name, err); } }
    else if (!e && w.fired) { w.fired = false; if (w.cleanup) { const c = w.cleanup; w.cleanup = null; try { c(); } catch (err) { warn('require cleanup', err); } } }
  }
  const slotDefs = new Map(), slotItems = new Map();
  const items = name => { let s = slotItems.get(name); if (!s) slotItems.set(name, s = new Set()); return s; };
  function slotAttach(name, it) {
    const d = slotDefs.get(name); if (!d || it.attached) return;
    try { const r = d.impl.attach(it.spec, { owner: it.owner }); it.attached = true; it.res = r; } catch (e) { warn('slot ' + name + ' attach', e); }
  }
  function slotDetach(it) {
    if (!it.attached) return; it.attached = false; const r = it.res; it.res = null;
    try { typeof r === 'function' ? r() : r && typeof r.detach === 'function' && r.detach(); } catch (e) { warn('slot detach', e); }
  }

  /* ---------- api ---------- */
  function makeApi(rec, ledger) {
    const track = (kind, undo) => ledger.add(kind, undo);
    const api = { id: rec.id, _track: track, _rec: rec, coreStyleRef: coreStyle, apiVersion: API_VERSION };
    api.version = () => Object.assign({ api: API_VERSION }, versionInfo);
    api.log = (...a) => console.log('[ts6mod:' + rec.id + ']', ...a);
    api.isEnabled = () => rec.enabled;
    api.el = (tag, props, ...kids) => { const n = A.el(tag, props, ...kids); n.setAttribute('data-ts6mod', rec.id); return n; };
    api.addStyle = css => { const s = document.createElement('style'); s.setAttribute('data-ts6mod', rec.id); s.textContent = css; document.head.appendChild(s); return track('style', () => s.remove()); };
    api.interval = (fn, ms) => { const t = setInterval(() => { try { fn(); } catch (e) { warn(rec.id + ' interval', e); } }, ms); return track('interval', () => clearInterval(t)); };
    api.timeout = (fn, ms) => { let un; const t = setTimeout(() => { un && un(); try { fn(); } catch (e) { warn(rec.id + ' timeout', e); } }, ms); un = track('timeout', () => clearTimeout(t)); return un; };
    api.listen = (target, type, fn, opts) => { target.addEventListener(type, fn, opts); return track('listener', () => target.removeEventListener(type, fn, opts)); };
    api.observe = (target, opts, cb) => { const o = new MutationObserver(cb); o.observe(target, opts); return track('observer', () => o.disconnect()); };
    api.onDom = (cb, opts) => { const un = domSubscribe(cb, (opts && opts.debounce) || 100); return track('dom', un); };
    api.watch = (getter, cb, opts) => { const un = A.vue().root.$watch(getter, cb, opts); return track('watch', un); };
    api.onRoute = cb => track('route', A.onRoute(cb));
    api.storage = {
      get: (k, d) => { const s = store.settings[rec.id]; return s && k in s ? s[k] : d; },
      set: (k, v) => { (store.settings[rec.id] = store.settings[rec.id] || {})[k] = v; saveStore(); },
      remove: k => { const s = store.settings[rec.id]; if (s) { delete s[k]; saveStore(); } },
      all: () => Object.assign({}, store.settings[rec.id]),
    };
    api.bridge = { call: (name, ...args) => A.bridge.call(name, ...args) };
    api.events = { on: (name, cb) => track('event', nativeSubscribe(name, cb)) };
    api.native = {
      get: p => nativeRequest(p), post: (p, body) => nativeRequest(p, body),
      available: () => typeof window.ts6modNative === 'function',
    };
    api.scope = () => { const led = makeLedger(); rec.scopes.add(led); const s = makeApi(rec, led); s.dispose = () => { rec.scopes.delete(led); led.dispose(); }; return s; };

    /* --- extensibility --- */
    api.extend = (name, impl) => {
      if (exts.has(name)) throw new Error(`extension "${name}" already provided by mod "${exts.get(name).owner}"`);
      const e = { owner: rec.id, impl }; exts.set(name, e); waiters.filter(w => w.name === name).forEach(fireWaiter);
      return track('extension', () => { if (exts.get(name) === e) { exts.delete(name); waiters.filter(w => w.name === name).forEach(fireWaiter); } });
    };
    api.ext = new Proxy({}, { get: (_, n) => { const e = exts.get(n); return e && e.impl; }, has: (_, n) => exts.has(n), ownKeys: () => [...exts.keys()], getOwnPropertyDescriptor: (_, n) => exts.has(n) ? { enumerable: true, configurable: true, value: exts.get(n).impl } : undefined });
    api.require = (name, cb) => {   // cb(impl) now or when a provider appears; may return a cleanup fn (called when it goes away or this mod is disabled)
      const w = { name, cb, fired: false, cleanup: null }; waiters.push(w); fireWaiter(w);
      return track('require', () => { const i = waiters.indexOf(w); if (i >= 0) waiters.splice(i, 1); if (w.fired && w.cleanup) { const c = w.cleanup; w.cleanup = null; try { c(); } catch (e) { warn('require cleanup', e); } } });
    };
    api.defineSlot = (name, impl) => {
      if (slotDefs.has(name)) throw new Error(`slot "${name}" already defined by mod "${slotDefs.get(name).owner}"`);
      if (!impl || typeof impl.attach !== 'function') throw new Error('defineSlot needs {attach(spec, ctx) -> detach|{detach, update}}');
      const d = { owner: rec.id, impl }; slotDefs.set(name, d); items(name).forEach(it => slotAttach(name, it));
      return track('slot-def', () => { if (slotDefs.get(name) === d) { items(name).forEach(slotDetach); slotDefs.delete(name); } });
    };
    api.slots = new Proxy({}, { get: (_, name) => ({
      add(spec) {
        const it = { owner: rec.id, spec, attached: false, res: null }; items(name).add(it); slotAttach(name, it);
        const un = track('slot-item', () => { slotDetach(it); items(name).delete(it); });
        return { remove: un, update(patch) {
          Object.assign(it.spec, patch);
          if (it.attached && it.res && typeof it.res.update === 'function') { try { it.res.update(it.spec); } catch (e) { warn('slot update', e); } } else if (it.attached) { slotDetach(it); slotAttach(name, it); }
        } };
      },
      defined: () => slotDefs.has(name),
    }) });

    for (const p of parts) p(api, rec);
    return api;
  }

  /* ---------- core extension files (panel/core/x-<mod>.js): api namespaces for every mod ---------- */
  const apiNames = new Set();
  function coreApi(name, factory) {   // factory(api, track, anchors) -> impl; runs per mod api (and per api.scope()), so it must not create resources itself
    if (typeof name !== 'string' || !name || typeof factory !== 'function') throw new Error('coreApi(name, (api, track, anchors) => impl) needs a name and a factory');
    if (apiNames.has(name)) throw new Error(`api namespace "${name}" already registered by a core extension`);
    const led = makeLedger();
    try { if (name in makeApi({ id: '(probe)', scopes: new Set() }, led)) throw new Error(`api namespace "${name}" collides with a built-in api member`); } finally { led.dispose(); }
    apiNames.add(name);
    parts.push(api => { api[name] = factory(api, api._track, A); });
  }

  /* ---------- registry ---------- */
  function register(def) {
    if (!def || !def.id || typeof def.enable !== 'function') throw new Error('register({id, title, description, enable(api), disable?(), settings?(api, container)}) needs id and enable');
    const old = mods.get(def.id);
    const wasOn = old && old.enabled;
    if (old && old.enabled) disableRec(old);
    const rec = { id: def.id, def, enabled: false, api: null, ledger: null, scopes: new Set(), css: (loading && loading.id === def.id ? loading.css : '') || '', source: (loading && loading.source) || 'mod', error: null };
    mods.set(def.id, rec);
    if (started && (wasOn || store.enabled[def.id])) enableRec(rec);
    fire();
    return rec;
  }
  function load(id, css, fn, source) {   // used by the injector: runs a mod's index.js with its style.css
    loading = { id, css, source: source || 'mod' };
    try { fn(boot.core); if (!mods.has(id)) throw new Error('index.js did not register a mod with id "' + id + '"'); }
    catch (e) { stats.loadErrors.push({ id, error: String(e && e.stack || e) }); warn('loading mod ' + id, e); }
    finally { loading = null; }
  }

  async function enableRec(rec) {
    if (rec.enabled) return;
    rec.error = null; rec.enabled = true; rec.ledger = makeLedger(); const led = rec.ledger;
    rec.api = makeApi(rec, led); coreStyle(+1); rec.styleHeld = true;
    try {
      if (rec.css) rec.api.addStyle(rec.css);
      const r = rec.def.enable(rec.api); if (r && typeof r.then === 'function') await r;
    } catch (e) { rec.error = String(e && e.message || e); warn('enabling ' + rec.id, e); if (rec.ledger === led) disableRec(rec, true); }
    fire();
  }
  function disableRec(rec, keepError) {
    if (!rec.enabled) return;
    rec.enabled = false;
    try { rec.def.disable && rec.def.disable(); } catch (e) { warn('disable() of ' + rec.id, e); }
    for (const s of [...rec.scopes]) s.dispose(); rec.scopes.clear();
    if (rec.ledger) rec.ledger.dispose();
    document.querySelectorAll('[data-ts6mod="' + rec.id + '"]').forEach(n => n.remove());   // safety net: nothing a mod made may survive
    rec.ledger = null; rec.api = null; if (!keepError) rec.error = null;
    if (rec.styleHeld) { rec.styleHeld = false; coreStyle(-1); }
    fire();
  }
  function unregister(id, opts) {   // dev/tests: disable and forget a mod (opts.purge also drops its stored settings and switch)
    const rec = mods.get(id); if (!rec) return false;
    disableRec(rec); mods.delete(id);
    if (opts && opts.purge) { delete store.settings[id]; delete store.enabled[id]; saveStore(); }
    fire(); return true;
  }
  async function setEnabled(id, on, opts) {
    const rec = mods.get(id); if (!rec) throw new Error('unknown mod ' + id);
    if (!opts || opts.persist !== false) { store.enabled[id] = !!on; saveStore(); }
    if (on) await enableRec(rec); else disableRec(rec);
    return rec.enabled;
  }

  /* ---------- diagnostics (tests) ---------- */
  function ledger(id) {
    const rec = mods.get(id); if (!rec) return null;
    const c = rec.ledger ? rec.ledger.counts() : {};
    for (const s of rec.scopes) { const sc = s.counts(); for (const k in sc) c[k] = (c[k] || 0) + sc[k]; }
    return c;
  }
  const trace = () => ({
    marked: [...document.querySelectorAll('[data-ts6mod]')].map(n => n.tagName.toLowerCase() + ':' + n.getAttribute('data-ts6mod')),
    coreStyle: !!styleEl, domObserver: !!domObs, domSubs: domSubs.size,
    nativeRequests: stats.nativeRequests,
    ledgers: Object.fromEntries([...mods.keys()].map(id => [id, ledger(id)])),
    exts: [...exts.keys()], slots: [...slotDefs.keys()],
    events: Object.fromEntries([...nativeSubs].map(([k, v]) => [k, v.size]).filter(([, n]) => n)),
  });
  const list = () => [...mods.values()].map(r => ({ id: r.id, title: r.def.title || r.id, description: r.def.description || '', enabled: r.enabled, source: r.source, error: r.error }));

  /* ---------- lifecycle ---------- */
  async function start() {
    if (started) return;
    const ok = await A.ready();
    if (!ok) { startError = 'UI app not found (not the main UI page?)'; return; }
    await loadStore();
    versionInfo = await A.bridge.versionInfo();
    started = true;
    boot.page.install();
    for (const rec of mods.values()) if (store.enabled[rec.id]) await enableRec(rec);
  }
  function unload() {
    for (const rec of [...mods.values()].reverse()) disableRec(rec);
    try { boot.page.uninstall(); } catch (e) { warn('page uninstall', e); }
    if (styleEl) { styleRefs = 0; coreStyle(0); }
    delete window.ts6mod; delete window.__ts6mod; delete window.__ts6modReply; delete window.__ts6modBoot;
  }

  const core = {
    apiVersion: API_VERSION, register, unregister, load, start, unload, setEnabled, list, ledger, trace, stats,
    anchors: A,
    get started() { return started; }, get error() { return startError; },
    isEnabled: id => !!(mods.get(id) && mods.get(id).enabled),
    mods: () => mods, store: () => store, onChange: cb => { changeSubs.add(cb); return () => changeSubs.delete(cb); },
    addApiPart: p => parts.push(p), coreApi, makeApi, makeLedger, coreStyle, enableRec, disableRec,
    dom: domSubscribe, nativeOn: nativeSubscribe, warn, fire,
    open: () => A.openSettings('TS6Mods'), route: A.route, goto: A.goto, showOwnChannelChat: A.showOwnChannelChat,
  };
  boot.core = core;
  window.ts6mod = window.__ts6mod = core;
})(window.__ts6modBoot);

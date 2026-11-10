/* ts6-mods "Mods" settings page + the UI kit mods use inside it (api.ui) + api.settings.
 * Two views in place: the overview (a card per registered mod: icon, name, switch, summary, status line, search over names and
 * setting labels) and one mod's own page (back link, header with its switch, its settings laid out as boxes in a grid, optional
 * tabs). While a mod is enabled and its page is shown, the mod's settings(api, container) renders there with a scoped api whose
 * timers/observers die when the page is left (so polling only runs while visible). TS markup comes from anchors.js.
 * Docs: superdoc/features/mods-panel.md (page), superdoc/features/ts6-mod-api.md (register fields, api.ui). */
(function (boot) {
  'use strict';
  const A = boot.anchors, core = boot.core, warn = core.warn, el = A.el;
  const KEY = 'TS6Mods';
  /* card order: these groups first (in this order), then any other group, then mods without a group ("Other") */
  const GROUPS = ['Audio', 'Interface', 'Server & network', 'Chat & files', 'Tools'];
  const FALLBACK_ICON = 'M10 4a2 2 0 1 1 4 0v2h4v4h-1a2 2 0 1 0 0 4h1v4h-4v-1a2 2 0 1 0-4 0v1H6v-4h1a2 2 0 1 0 0-4H6V6h4z';   // puzzle piece
  const LONG_SUB = 90;   // a toggle subtitle longer than this becomes a hover tooltip (keeps the boxes compact)
  let undoPage = null, unsub = null, shown = null, held = false, ticker = 0;
  let openId = null;            // the mod whose page is shown (null = overview); reset when the Mods category is left
  let want = null;              // {id, tab} asked for by open() before the page was mounted
  const tabMemory = new Map();  // tabs key (mod id) -> last selected tab, for this session
  const labels = new Map();     // mod id -> setting labels seen when its page was last shown (search also finds those)
  const tiles = new Map();      // mod id -> overview card
  let detail = null;            // the shown mod page {id, el, sw, ..., body, box, secBox, scope, cleanup, secScope, nsec}
  let query = '';

  const nameOf = rec => String(rec.def.title || rec.id);
  const summaryOf = rec => String(rec.def.summary || rec.def.description || '');
  const hasSettings = rec => !!rec.def.settings || !!(rec.sections && rec.sections.length);
  const groupRank = g => { const i = GROUPS.indexOf(g); return i >= 0 ? i : g && g !== 'Other' ? GROUPS.length : GROUPS.length + 1; };
  const orderOf = rec => (typeof rec.def.order === 'number' ? rec.def.order : 1e6);
  const sorted = () => [...core.mods().values()].sort((a, b) => groupRank(a.def.group) - groupRank(b.def.group) ||
    String(a.def.group || '').localeCompare(String(b.def.group || '')) || orderOf(a) - orderOf(b) || nameOf(a).localeCompare(nameOf(b)));

  /* ---------- small pieces ---------- */
  const NS = 'http://www.w3.org/2000/svg';
  function iconTile(d, big) {
    const s = document.createElementNS(NS, 'svg'), p = document.createElementNS(NS, 'path'), px = big ? '22' : '20';
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: px, height: px, fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'stroke-linecap': 'round', 'stroke-linejoin': 'round', 'aria-hidden': 'true' })) s.setAttribute(k, v);
    p.setAttribute('d', typeof d === 'string' && d ? d : FALLBACK_ICON); s.append(p);
    return el('div', { class: 'mods-ic' + (big ? ' big' : '') }, s);
  }
  /* just the switch of a TS settings toggle (same classes, so it follows the theme) */
  function switchEl(label, onFlip) {
    let on = false;
    const input = el('input', { type: 'checkbox', tabindex: 0, 'aria-label': label });
    const inner = el('div', { class: A.cls.toggleInner + ' visible' }, input);
    const sw = el('div', { class: A.cls.toggle + ' visible mods-switch', title: label, on: { click: e => { e.preventDefault(); e.stopPropagation(); onFlip(!on); } } }, inner);
    input.addEventListener('click', e => e.stopPropagation()); input.addEventListener('change', () => onFlip(input.checked));
    const set = v => { on = !!v; sw.classList.toggle('checked', on); inner.classList.toggle('checked', on); input.checked = on; };
    return { el: sw, set, get: () => on };
  }
  const flipMod = (id, sw) => v => { sw.set(v); core.setEnabled(id, v).catch(e => warn('switching ' + id, e)); };
  function statusOf(rec) {
    if (rec.error) return 'Could not enable';
    if (!rec.enabled) return 'Off';
    let s = '';
    if (typeof rec.def.status === 'function' && rec.api) { try { s = rec.def.status(rec.api) || ''; } catch (e) { s = ''; } }
    return 'On' + (s ? ' · ' + s : hasSettings(rec) ? '' : ' · No settings');
  }
  function match(rec, q) {   // -> {hit, label}: label = the setting label that matched (shown on the card)
    if (!q) return { hit: true };
    if ([nameOf(rec), summaryOf(rec), rec.def.description, rec.def.group].join(' ').toLowerCase().includes(q)) return { hit: true };
    const kw = [].concat(Array.isArray(rec.def.keywords) ? rec.def.keywords : [], labels.get(rec.id) || []);
    const m = kw.find(k => String(k).toLowerCase().includes(q));
    return m ? { hit: true, label: String(m) } : { hit: false };
  }
  function scrollTop() { for (let n = shown && shown.host; n; n = n.parentElement) if (n.scrollTop) n.scrollTop = 0; }

  /* ---------- overview ---------- */
  function tile(rec) {
    const t = { id: rec.id };
    t.sw = switchEl(nameOf(rec) + ' on or off', v => flipMod(rec.id, t.sw)(v));
    t.name = el('button', { class: 'mods-tile-name', type: 'button', on: { click: () => openMod(rec.id) } });
    t.desc = el('p', { class: 'mods-tile-desc' });
    t.status = el('span', { class: 'mods-tile-status' });
    t.icon = rec.def.icon; t.ic = iconTile(rec.def.icon);
    t.el = el('div', { class: 'mods-tile', 'data-mod-card': rec.id },
      el('div', { class: 'mods-tile-top' }, t.ic, t.name, t.sw.el), t.desc,
      el('div', { class: 'mods-tile-foot' }, t.status, el('button', { class: 'mods-link mods-tile-open', type: 'button', on: { click: () => openMod(rec.id) } }, 'Settings ›')));
    return t;
  }
  function renderGrid() {
    if (!shown) return;
    const recs = sorted(), q = query.trim().toLowerCase();
    for (const [id, t] of tiles) if (!core.mods().has(id)) { t.el.remove(); tiles.delete(id); }
    let hits = 0, on = 0;
    recs.forEach((rec, i) => {
      let t = tiles.get(rec.id); if (!t) { t = tile(rec); tiles.set(rec.id, t); }
      if (shown.grid.children[i] !== t.el) shown.grid.insertBefore(t.el, shown.grid.children[i] || null);
      if (t.icon !== rec.def.icon) { const ic = iconTile(rec.def.icon); t.ic.replaceWith(ic); t.ic = ic; t.icon = rec.def.icon; }   // re-registered (hot reload)
      t.name.textContent = nameOf(rec); t.desc.textContent = summaryOf(rec); t.desc.title = rec.def.description || '';
      t.sw.set(rec.enabled); t.el.classList.toggle('on', rec.enabled);
      const m = match(rec, q); t.el.hidden = !m.hit; if (m.hit) hits++;
      t.status.textContent = t.status.title = m.label ? 'Matches “' + m.label + '”' : statusOf(rec);
      t.status.classList.toggle('mods-hit', !!m.label);
      if (rec.enabled) on++;
    });
    shown.count.textContent = on + ' of ' + recs.length + ' on · everything off = stock client';
    shown.empty.textContent = recs.length ? 'No mod or setting matches “' + query.trim() + '”.' : 'No mods installed.';
    shown.empty.hidden = hits > 0;
  }

  /* ---------- one mod's page ---------- */
  function teardownBody(d) {
    if (!d) return;
    if (d.body) harvest(d);
    if (d.cleanup) { try { d.cleanup(); } catch (e) { warn('settings cleanup', e); } d.cleanup = null; }
    if (d.secScope) { d.secScope.dispose(); d.secScope = null; }
    if (d.scope) { d.scope.dispose(); d.scope = null; }
    if (d.body) { d.body.remove(); d.body = d.box = d.secBox = null; }
  }
  function harvest(d) {   // remember the labels of this page for the search
    const seen = new Set();
    d.body.querySelectorAll('.mods-subtitle, .mods-field > label, .mods-label, .mods-tab, label > span:first-child, .mods-pill, button').forEach(n => {
      const t = n.textContent.replace(/\?$/, '').trim(); if (t && t.length <= 60) seen.add(t); });
    labels.set(d.id, [...seen]);
  }
  function renderSections(d, rec) {
    if (d.secScope) { d.secScope.dispose(); d.secScope = null; }
    d.secBox.replaceChildren();
    const secs = rec.sections || [];
    d.nsec = secs.length;
    if (!secs.length) return;
    d.secScope = rec.api.scope();
    for (const s of secs) {
      const box = el('div', { class: 'mods-section mods-box' }, s.title ? el('h4', { class: 'mods-subtitle' }, s.title) : null); d.secBox.append(box);
      try { s.render(box, d.secScope); } catch (e) { box.append(el('p', { class: 'mods-error' }, String(e && e.message || e))); }
    }
  }
  function buildDetail(rec) {
    const d = { id: rec.id, body: null };
    d.sw = switchEl(nameOf(rec) + ' on or off', v => flipMod(rec.id, d.sw)(v));
    d.err = el('p', { class: 'mods-error' });
    d.off = el('p', { class: 'mods-note mods-offnote' }, 'This mod is off. Its settings are kept; switch it on to use them.');
    d.none = el('p', { class: 'mods-note mods-offnote' }, 'This mod has no settings.');
    d.el = el('div', { class: 'mods-detail', 'data-mod-page': rec.id },
      el('button', { class: 'mods-link mods-back', type: 'button', on: { click: () => closeMod() } }, '‹ All mods'),
      el('div', { class: 'mods-detail-head' }, iconTile(rec.def.icon, true),
        el('div', { class: 'mods-detail-text' }, el('h2', { class: 'mods-detail-title' }, nameOf(rec)), el('p', { class: 'mods-detail-desc' }, rec.def.description || rec.def.summary || '')),
        d.sw.el),
      d.err, d.off, d.none);
    return d;
  }
  function renderDetail() {
    const rec = core.mods().get(openId);
    if (!rec) { closeMod(); return; }
    if (detail && detail.def !== rec.def) { teardownBody(detail); detail.el.remove(); detail = null; }   // re-registered
    if (!detail) { detail = buildDetail(rec); detail.def = rec.def; shown.detailHost.append(detail.el); }
    const d = detail;
    d.sw.set(rec.enabled);
    d.err.textContent = rec.error ? 'Could not enable: ' + rec.error : ''; d.err.hidden = !rec.error;
    d.none.hidden = hasSettings(rec);
    d.off.hidden = rec.enabled || !hasSettings(rec);
    const wantBody = rec.enabled && rec.api && hasSettings(rec);
    if (!wantBody) { teardownBody(d); return; }
    if (!d.body) {
      d.body = el('div', { class: 'mods-mod-body', 'data-ts6mod': rec.id });
      d.box = el('div', { class: 'mods-boxes' }); d.secBox = el('div', { class: 'mods-secs' });
      d.body.append(d.box); d.el.append(d.body);
      if (rec.def.settings) {
        d.scope = rec.api.scope();
        try { const c = rec.def.settings(d.scope, d.box); if (typeof c === 'function') d.cleanup = c; }
        catch (e) { warn('settings() of ' + rec.id, e); d.box.append(el('p', { class: 'mods-error' }, 'Settings failed: ' + String(e && e.message || e))); }
      }
      boxify(d.box); d.box.append(d.secBox);
      renderSections(d, rec);
      harvest(d);
    } else if ((rec.sections || []).length !== d.nsec) renderSections(d, rec);
  }
  function openMod(id, tab) {
    if (!core.mods().has(id)) return false;
    if (tab) tabMemory.set(id, tab);
    if (openId === id && detail) {   // already shown: just pick the tab
      const b = tab && detail.el.querySelector('.mods-tab[data-tab="' + CSS.escape(tab) + '"]'); if (b) b.click();
      return true;
    }
    if (detail) { teardownBody(detail); detail.el.remove(); detail = null; }
    openId = id; render(); scrollTop();
    return true;
  }
  function closeMod() {
    if (detail) { teardownBody(detail); detail.el.remove(); detail = null; }
    const was = openId; openId = null; render();
    if (was) scrollTop();
  }

  function render() {
    if (!shown) return;
    shown.grid.hidden = !!openId; shown.detailHost.hidden = !openId;
    if (openId) { shown.empty.hidden = true; renderDetail(); } else renderGrid();
  }
  function mount(host) {
    if (shown && shown.host === host) { applyWant(); return; }
    if (shown) unmount(shown.host);
    if (!held) { held = true; core.coreStyle(+1); }
    const search = el('input', { type: 'search', class: 'mods-search-in', placeholder: 'Search mods and settings', 'aria-label': 'Search mods and settings' });
    const ico = document.createElementNS(NS, 'svg'), path = document.createElementNS(NS, 'path');
    for (const [k, v] of Object.entries({ viewBox: '0 0 24 24', width: '16', height: '16', fill: 'none', stroke: 'currentColor', 'stroke-width': '1.8', 'aria-hidden': 'true' })) ico.setAttribute(k, v);
    path.setAttribute('d', 'M11 4a7 7 0 1 0 0 14a7 7 0 1 0 0-14z M20 20l-4-4'); ico.append(path);
    const count = el('span', { class: 'mods-count' });
    const grid = el('div', { class: 'mods-grid' }), empty = el('p', { class: 'mods-absent mods-empty' }), detailHost = el('div', { class: 'mods-detail-host' });
    const root = el('div', { class: A.cls.cardContent + ' mods-page' },
      el('div', { class: 'mods-head' }, el('h3', { class: 'mods-title' }, 'Mods'), count, el('label', { class: 'mods-search' }, ico, search)),
      grid, empty, detailHost);
    host.append(root);
    query = ''; openId = null;
    search.addEventListener('input', () => { query = search.value; if (openId) closeMod(); else renderGrid(); });
    search.addEventListener('keydown', e => { if (e.key === 'Escape' && search.value) { e.stopPropagation(); search.value = ''; query = ''; renderGrid(); } });
    shown = { host, root, grid, empty, detailHost, count, search };
    unsub = core.onChange(render);
    ticker = setInterval(() => { if (shown && !openId && !document.hidden) renderGrid(); }, 2000);   // status lines follow live state (status() hooks are cheap reads)
    applyWant(); render();
  }
  function unmount(host) {
    if (!shown || (host && shown.host !== host)) return;
    if (unsub) { unsub(); unsub = null; }
    clearInterval(ticker); ticker = 0;
    if (detail) { teardownBody(detail); detail = null; }
    tiles.clear(); openId = null; query = '';
    shown.host.replaceChildren(); shown = null;
    if (held) { held = false; core.coreStyle(-1); }
  }
  function applyWant() { if (!want || !shown) return; const w = want; want = null; if (w.id) openMod(w.id, w.tab); else closeMod(); }

  /* put a settings container's loose top-level nodes into untitled boxes; sections become boxes; tabs, footers and top-level
   * notes/errors/status lines stay full-width strips */
  const STRIP = ['mods-tabs', 'mods-foot', 'mods-wide', 'mods-note', 'mods-error', 'mods-status', 'mods-secs', 'mods-absent'];
  function boxify(c) {
    let run = null;
    for (const n of [...c.childNodes]) {
      if (n.nodeType === 3 && !n.textContent.trim()) continue;
      const cl = n.classList;
      if (cl && cl.contains('mods-section')) { cl.add('mods-box'); run = null; continue; }
      if (cl && STRIP.some(s => cl.contains(s))) { run = null; continue; }
      if (!run) { run = el('div', { class: 'mods-section mods-box' }); c.insertBefore(run, n); }
      run.append(n);
    }
  }

  /* ---------- UI kit (api.ui) ---------- */
  const fmt = (v, step) => (step < 1 ? (+v).toFixed(1) : String(Math.round(v * 100) / 100));
  const helpMark = text => el('span', { class: 'mods-help', title: text, 'aria-label': text }, '?');
  const ui = {
    h: el, row: A.ui.row, subtitle: A.ui.subtitle,
    /* TS settings toggle; a long `sub` (or an explicit `help`) becomes a hover tooltip with a small "?" mark */
    toggle(o) {
      const long = o.sub && String(o.sub).length > LONG_SUB, tip = o.help || (long ? o.sub : '');
      const t = A.ui.toggle(long ? Object.assign({}, o, { sub: '' }) : o);
      t.el.classList.add('mods-trow');
      if (tip) { t.el.title = tip; const s = t.el.querySelector('label > span'); if (s) s.append(helpMark(tip)); }
      return t;
    },
    note: (text, kind) => el('p', { class: 'mods-note' + (kind ? ' mods-' + kind : '') }, text),
    section: (title, ...kids) => el('div', { class: 'mods-section' }, title ? el('h4', { class: 'mods-subtitle' }, title) : null, ...kids),
    row2: (...kids) => el('div', { class: 'mods-row' }, ...kids),
    footer: (...kids) => el('div', { class: 'mods-foot' }, ...kids),
    button: ({ label, onClick, kind }) => el('button', { class: kind === 'link' ? 'mods-link' : 'mods-pill', type: 'button', on: { click: onClick || (() => {}) } }, label),
    pill: ({ label, onClick, on }) => { const b = el('button', { class: 'mods-pill' + (on ? ' on' : ''), type: 'button', on: { click: onClick || (() => {}) } }, label); return { el: b, set(v) { b.classList.toggle('on', !!v); } }; },
    slider({ label, min, max, step, unit, value, help, onInput, onCommit }) {
      const range = el('input', { class: 'mods-range', type: 'range', min, max, step, value });
      const num = el('input', { type: 'number', min, max, step, value: fmt(value, step) });
      const root = el('div', { class: 'mods-field', title: help || '' }, el('label', label, help ? helpMark(help) : null), range, el('span', { class: 'mods-num' }, num, el('em', unit || '')));
      range.addEventListener('input', () => { num.value = fmt(+range.value, step); onInput && onInput(+range.value); });
      num.addEventListener('change', () => { const x = Math.min(max, Math.max(min, +num.value)); if (!isNaN(x)) { range.value = x; num.value = fmt(x, step); (onCommit || onInput) && (onCommit || onInput)(x); } });
      return { el: root, set(v) { if (document.activeElement !== range) range.value = v; if (document.activeElement !== num) num.value = fmt(v, step); } };
    },
    meter({ label, kind }) {
      const fill = el('div', { class: 'mods-meter-fill ' + (kind || '') }), val = el('span', { class: 'mods-meter-v' }, '-');
      return { el: el('div', { class: 'mods-meter' }, el('span', { class: 'mods-meter-l' }, label), el('div', { class: 'mods-meter-track' }, fill), val),
        set(pct, text) { fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%'; val.textContent = text == null ? '-' : text; } };
    },
    /* tabs([{name, render(panel) | content: Node|Node[]}], {aside, key, onSelect}) -> {el, select(name), current(), panel(name), aside}
     * Every panel is built at once (only the selected one is displayed) and laid out as boxes like the settings container.
     * `aside` (text or Node) sits right-aligned in the tab bar; `key` remembers the last tab for the session (api.ui.tabs passes the mod id). */
    tabs(list, opts) {
      opts = opts || {};
      const names = list.map(t => t.name), panels = new Map(), btns = new Map();
      let cur = opts.key && tabMemory.get(opts.key); if (!names.includes(cur)) cur = names[0];
      const bar = el('div', { class: 'mods-tabbar', role: 'tablist' });
      for (const t of list) {
        const b = el('button', { class: 'mods-tab', type: 'button', role: 'tab', 'data-tab': t.name, on: { click: () => select(t.name) } }, t.name);
        const p = el('div', { class: 'mods-tabpanel mods-boxes', role: 'tabpanel', 'data-tab': t.name });
        try { if (t.render) t.render(p); else p.append(...[].concat(t.content || [])); }
        catch (e) { warn('tab ' + t.name, e); p.append(el('p', { class: 'mods-error' }, String(e && e.message || e))); }
        boxify(p); bar.append(b); btns.set(t.name, b); panels.set(t.name, p);
      }
      const aside = el('span', { class: 'mods-tabaside' }, opts.aside == null ? '' : opts.aside); bar.append(aside);
      function select(name) {
        if (!panels.has(name)) return;
        cur = name; if (opts.key) tabMemory.set(opts.key, name);
        for (const [n, b] of btns) { const on = n === name; b.classList.toggle('on', on); b.setAttribute('aria-selected', String(on)); panels.get(n).hidden = !on; }
        if (opts.onSelect) { try { opts.onSelect(name); } catch (e) { warn('tabs onSelect', e); } }
      }
      select(cur);
      return { el: el('div', { class: 'mods-tabs' }, bar, ...panels.values()), select, current: () => cur, panel: n => panels.get(n), aside };
    },
  };

  core.addApiPart((api, rec) => {
    api.ui = Object.assign({}, ui, { tabs: (list, opts) => ui.tabs(list, Object.assign({ key: rec.id }, opts)) });
    api.settings = {
      open: () => core.open(),
      /* show(tab?): open this mod's own page on the Mods page (optionally on a tab) */
      show: tab => core.open(rec.id, tab),
      /* addSection({title, render(container, scopedApi)}): an extra box on this mod's page (shown while enabled) */
      addSection(spec) {
        (rec.sections = rec.sections || []).push(spec); core.fire();
        return { remove: api._track('settings-section', () => { const i = (rec.sections || []).indexOf(spec); if (i >= 0) rec.sections.splice(i, 1); core.fire(); }) };
      },
      /* addPage({key, title, icon, render(container, scopedApi)}): a separate category in the client's Settings navigation */
      addPage(spec) {
        let scope = null;
        const undo = A.settings.addPage({ key: 'TS6Mods.' + rec.id + '.' + spec.key, title: spec.title, icon: spec.icon,
          mount(host) { if (scope) return; scope = api.scope(); host.setAttribute('data-ts6mod', rec.id); try { spec.render(host, scope); } catch (e) { warn('settings page', e); } },
          unmount(host) { if (scope) { scope.dispose(); scope = null; } host.replaceChildren(); } });
        return { remove: api._track('settings-page', () => { if (scope) { scope.dispose(); scope = null; } undo(); }) };
      },
    };
  });

  /* open(id?, tab?): the Mods page, on the overview or on one mod's page (tests and api.settings use it) */
  core.open = (id, tab) => {
    want = { id: id || null, tab: tab || null };
    if (id && tab) tabMemory.set(id, tab);
    if (shown && A.route().fullPath.includes(KEY)) { applyWant(); return true; }
    return A.openSettings(KEY);
  };
  core.page = {
    view: () => (!shown ? null : openId ? 'mod' : 'grid'),
    openMod: (id, tab) => openMod(id, tab), back: () => closeMod(),
    search(q) { if (!shown) return false; shown.search.value = q || ''; shown.search.dispatchEvent(new Event('input')); return true; },
    tab: () => { const b = detail && detail.el.querySelector('.mods-tab.on'); return b ? b.dataset.tab : null; },
  };

  boot.page = {
    install() { undoPage = A.settings.addPage({ key: KEY, title: 'Mods', icon: 'settings-addons', mount, unmount }); },
    uninstall() { unmount(); if (undoPage) { undoPage(); undoPage = null; } },
  };
})(window.__ts6modBoot);

/* ts6-mods "Mods" settings page + the UI kit mods use inside it (api.ui) + api.settings.
 * The page lists every registered mod with its switch (default off). While a mod is enabled and the page is shown, the
 * mod's settings(api, container) renders below its switch, with a scoped api whose timers/observers die when the page
 * is left (so polling only runs while visible). TS markup comes from anchors.js. */
(function (boot) {
  'use strict';
  const A = boot.anchors, core = boot.core, warn = core.warn, el = A.el;
  const KEY = 'TS6Mods';
  let undoPage = null, unsub = null, shown = null, held = false;
  const rows = new Map();   // id -> {wrap, toggle, err, body, settingsBox, secBox, scope, cleanup, secScope, nsec}

  function teardownBody(row) {
    if (row.cleanup) { try { row.cleanup(); } catch (e) { warn('settings cleanup', e); } row.cleanup = null; }
    if (row.secScope) { row.secScope.dispose(); row.secScope = null; }
    if (row.scope) { row.scope.dispose(); row.scope = null; }
    if (row.body) { row.body.remove(); row.body = row.settingsBox = row.secBox = null; }
  }
  function renderSections(row, rec) {
    if (row.secScope) { row.secScope.dispose(); row.secScope = null; }
    row.secBox.replaceChildren();
    const secs = rec.sections || [];
    row.nsec = secs.length;
    if (!secs.length) return;
    row.secScope = rec.api.scope();
    for (const s of secs) {
      const box = el('div', { class: 'mods-section' }, s.title ? el('h4', { class: 'mods-subtitle' }, s.title) : null); row.secBox.append(box);
      try { s.render(box, row.secScope); } catch (e) { box.append(el('p', { class: 'mods-error' }, String(e && e.message || e))); }
    }
  }
  function paint(rec) {
    let row = rows.get(rec.id);
    if (!row) {
      row = { wrap: el('div', { class: 'mods-mod' }), toggle: null, err: null };
      row.toggle = A.ui.toggle({ title: rec.def.title || rec.id, sub: rec.def.description || '', checked: rec.enabled, onChange: v => core.setEnabled(rec.id, v) });
      row.err = el('p', { class: 'mods-error' });
      row.wrap.append(row.toggle.el, row.err); rows.set(rec.id, row);
    }
    row.toggle.set(rec.enabled);
    row.err.textContent = rec.error ? 'Could not enable: ' + rec.error : ''; row.err.hidden = !rec.error;
    const wantBody = rec.enabled && rec.api && (rec.def.settings || (rec.sections && rec.sections.length));
    if (!wantBody) { teardownBody(row); return row; }
    if (!row.body) {
      row.body = el('div', { class: 'mods-mod-body', 'data-ts6mod': rec.id }); row.settingsBox = el('div'); row.secBox = el('div'); row.body.append(row.settingsBox, row.secBox);
      row.wrap.append(row.body);
      if (rec.def.settings) {
        row.scope = rec.api.scope();
        try { const c = rec.def.settings(row.scope, row.settingsBox); if (typeof c === 'function') row.cleanup = c; }
        catch (e) { warn('settings() of ' + rec.id, e); row.settingsBox.append(el('p', { class: 'mods-error' }, 'Settings failed: ' + String(e && e.message || e))); }
      }
      renderSections(row, rec);
    } else if ((rec.sections || []).length !== row.nsec) renderSections(row, rec);
    return row;
  }
  function render() {
    if (!shown) return;
    const recs = [...core.mods().values()].sort((a, b) => String(a.def.title || a.id).localeCompare(String(b.def.title || b.id)));
    for (const [id, row] of rows) if (!core.mods().has(id)) { teardownBody(row); row.wrap.remove(); rows.delete(id); }
    for (const rec of recs) { const row = paint(rec); if (row.wrap.parentNode !== shown.list) shown.list.append(row.wrap); }
    shown.empty.hidden = recs.length > 0;
  }
  function mount(host) {
    if (shown && shown.host === host) return;
    if (shown) unmount(shown.host);
    if (!held) { held = true; core.coreStyle(+1); }
    const list = el('div', { class: 'mods-list' }), empty = el('p', { class: 'mods-absent' }, 'No mods installed.');
    host.append(el('div', { class: A.cls.cardContent }, el('h3', { class: 'mods-title' }, 'Mods'),
      el('p', { class: 'mods-absent' }, 'Every mod is off by default. With everything off the client is vanilla.'), list, empty));
    shown = { host, list, empty };
    unsub = core.onChange(render); render();
  }
  function unmount(host) {
    if (!shown || (host && shown.host !== host)) return;
    if (unsub) { unsub(); unsub = null; }
    for (const row of rows.values()) { teardownBody(row); row.wrap.remove(); } rows.clear();
    shown.host.replaceChildren(); shown = null;
    if (held) { held = false; core.coreStyle(-1); }
  }

  /* ---------- UI kit (api.ui) ---------- */
  const fmt = (v, step) => (step < 1 ? (+v).toFixed(1) : String(Math.round(v * 100) / 100));
  const ui = {
    h: el, toggle: A.ui.toggle, row: A.ui.row, subtitle: A.ui.subtitle,
    note: (text, kind) => el('p', { class: 'mods-note' + (kind ? ' mods-' + kind : '') }, text),
    section: (title, ...kids) => el('div', { class: 'mods-section' }, title ? el('h4', { class: 'mods-subtitle' }, title) : null, ...kids),
    row2: (...kids) => el('div', { class: 'mods-row' }, ...kids),
    button: ({ label, onClick, kind }) => el('button', { class: kind === 'link' ? 'mods-link' : 'mods-pill', type: 'button', on: { click: onClick || (() => {}) } }, label),
    pill: ({ label, onClick, on }) => { const b = el('button', { class: 'mods-pill' + (on ? ' on' : ''), type: 'button', on: { click: onClick || (() => {}) } }, label); return { el: b, set(v) { b.classList.toggle('on', !!v); } }; },
    slider({ label, min, max, step, unit, value, help, onInput, onCommit }) {
      const range = el('input', { class: 'mods-range', type: 'range', min, max, step, value });
      const num = el('input', { type: 'number', min, max, step, value: fmt(value, step) });
      const root = el('div', { class: 'mods-field', title: help || '' }, el('label', label), range, el('span', { class: 'mods-num' }, num, el('em', unit || '')));
      range.addEventListener('input', () => { num.value = fmt(+range.value, step); onInput && onInput(+range.value); });
      num.addEventListener('change', () => { const x = Math.min(max, Math.max(min, +num.value)); if (!isNaN(x)) { range.value = x; num.value = fmt(x, step); (onCommit || onInput) && (onCommit || onInput)(x); } });
      return { el: root, set(v) { if (document.activeElement !== range) range.value = v; if (document.activeElement !== num) num.value = fmt(v, step); } };
    },
    meter({ label, kind }) {
      const fill = el('div', { class: 'mods-meter-fill ' + (kind || '') }), val = el('span', { class: 'mods-meter-v' }, '-');
      return { el: el('div', { class: 'mods-meter' }, el('span', { class: 'mods-meter-l' }, label), el('div', { class: 'mods-meter-track' }, fill), val),
        set(pct, text) { fill.style.width = Math.max(0, Math.min(100, pct || 0)) + '%'; val.textContent = text == null ? '-' : text; } };
    },
  };

  core.addApiPart((api, rec) => {
    api.ui = ui;
    api.settings = {
      open: () => A.openSettings(KEY),
      /* addSection({title, render(container, scopedApi)}): an extra titled block in this mod's area of the Mods page (shown while enabled) */
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

  boot.page = {
    install() { undoPage = A.settings.addPage({ key: KEY, title: 'Mods', icon: 'settings-addons', mount, unmount }); },
    uninstall() { unmount(); if (undoPage) { undoPage(); undoPage = null; } },
  };
})(window.__ts6modBoot);

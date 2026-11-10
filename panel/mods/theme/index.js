/* Theme mod: theme development helper. A theme picker (installed extension themes), a "Reload theme" button and an optional
 * "live reload" that polls the active theme's stylesheet while the switch is on. When the CSS changed it is swapped in without a
 * restart and the server tree is re-measured (so changed row heights apply). Everything off by default; with live reload off
 * there is no polling and no injected style. Docs: superdoc/features/mod-theme.md. The TS-specific parts live in panel/core/x-theme.js. */
(() => {
  const DEFAULT_MS = 1000, MIN_MS = 250, MAX_MS = 10000;
  let modApi = null, stopPoll = null, busy = false, view = null;
  const S = { live: false, ms: DEFAULT_MS, last: '', error: '', reloads: 0 };

  const stamp = () => new Date().toLocaleTimeString();
  const note = text => { S.last = text; if (view) view.sync(); };

  async function runCheck(force) {
    if (busy) return null;
    busy = true;
    try {
      const r = await modApi.theme.check({ force });
      S.error = '';
      if (r.changed || force) { S.reloads++; note((force ? 'Reloaded ' : 'Changed, reloaded ') + stamp() + (r.active ? '' : ' (no extension theme active)')); }
      return r;
    } catch (e) { S.error = String(e && e.message || e); if (view) view.sync(); return null; }
    finally { busy = false; }
  }

  function applyPolling() {   /* (re)start or stop the poll timer from S; the api ledger removes it on disable */
    if (stopPoll) { stopPoll(); stopPoll = null; }
    modApi.theme.reset();
    if (S.live) stopPoll = modApi.interval(() => { runCheck(false); }, S.ms);
  }

  ts6mod.register({
    id: 'theme',
    title: 'Theme tools',
    description: 'For theme developers: switch the extension theme from here, reload it with one click, or let "live reload" watch the active theme file and apply changes (including tree row heights) without a restart.',
    enable(api) {
      modApi = api; busy = false;
      S.live = !!api.storage.get('live', false);
      S.ms = Math.max(MIN_MS, Math.min(MAX_MS, +api.storage.get('ms', DEFAULT_MS) || DEFAULT_MS));
      S.last = ''; S.error = ''; S.reloads = 0;
      applyPolling();
    },
    disable() { modApi = null; stopPoll = null; view = null; },

    settings(api, box) {
      const { ui } = api, h = ui.h;
      // after a switch the tree still has the old theme's row heights cached (stock behaviour), so re-measure once the new CSS is in
      const remeasureSoon = () => { for (const ms of [400, 1200]) api.timeout(() => { api.theme.remeasure().catch(() => {}); }, ms); };
      const sel = h('select', { class: 'theme-mod-select', on: { change: () => { try { api.theme.apply(sel.value || null); remeasureSoon(); } catch (e) { S.error = String(e.message || e); } setTimeout(sync, 300); } } });
      const fill = () => {
        const cur = api.theme.current() || '';
        sel.replaceChildren();
        let group = null;
        for (const t of api.theme.list()) {
          if (t.id !== null && t.extension !== group) { group = t.extension; sel.append(h('optgroup', { label: group })); }
          const o = h('option', { value: t.id || '' }, t.name);
          (t.id !== null && sel.lastChild.tagName === 'OPTGROUP' ? sel.lastChild : sel).append(o);
        }
        sel.value = cur;
      };
      const rescan = ui.button({ label: 'Rescan themes', kind: 'link', onClick: async () => { await api.theme.rescan(); fill(); sync(); } });
      const reload = ui.button({ label: 'Reload theme now', onClick: async () => { await runCheck(true); } });
      const liveT = ui.toggle({ title: 'Live reload', sub: 'Poll the active theme file and apply changes without a restart. Off = no polling at all.', onChange: v => { S.live = v; api.storage.set('live', v); applyPolling(); sync(); } });
      const ms = ui.slider({ label: 'Poll interval', min: MIN_MS, max: 5000, step: 250, unit: 'ms', value: S.ms, onInput: v => { S.ms = v; api.storage.set('ms', v); cancelRestart(); if (S.live) cancelRestart = api.timeout(applyPolling, 300); } });
      let cancelRestart = () => {};
      const status = h('p', { class: 'mods-status' }), err = h('p', { class: 'mods-error' });
      function sync() {
        if (!view) return;
        liveT.set(S.live); ms.el.hidden = !S.live;
        sel.value = api.theme.current() || '';
        const src = api.theme.activeSource();
        status.textContent = (src ? 'Active theme file: ' + src.split('?')[0].replace(/^.*\/extension\//, '') : 'No extension theme active.') + (S.last ? ' | ' + S.last : '');
        err.textContent = S.error; err.hidden = !S.error;
      }
      box.append(ui.row2(h('span', { class: 'mods-label' }, 'Theme'), sel, rescan), ui.row2(reload), liveT.el, ms.el, status, err);
      view = { sync };
      fill(); ms.set(S.ms); sync();
      api.interval(sync, 1500);   /* the active theme can change from the stock Appearance page */
      return () => { view = null; };
    },
  });
})();

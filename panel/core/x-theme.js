/* Core extension for the `theme` mod: theme list / switch through the client's own theme setting, a cache-busted read of the
 * active theme stylesheet (with its @import chain), a live swap of the CSS without a restart, and a re-measure of the server
 * tree (it caches its row-height variables when it is mounted). Adds anchors theme.* and api.theme.
 * Docs: superdoc/features/mod-theme.md. May name TS internals (the mod itself may not). */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  const LINK_ID = 'userStyle';   // the <link> the client keeps for the active extension theme

  A.def('theme.controller', 'app controller theme API: getUserStyles / applyUserStyle / disableUserStyle / refreshAvailableUserStyles / appearanceSettings.user_style',
    () => { const c = A.get('app.controller'); return typeof c.applyUserStyle === 'function' && typeof c.disableUserStyle === 'function' && typeof c.getUserStyles === 'function' && typeof c.refreshAvailableUserStyles === 'function' && c; });
  A.def('theme.link', 'the <link id="userStyle"> element of the active extension theme (absent while no extension theme is active)', () => document.getElementById(LINK_ID), true);
  A.def('theme.tree', 'server tree component (scroller ancestor) that caches the row-height variables (only while a tree is shown)', () => treeVm(), true);

  /* ---- tree: the component that caches the row heights (data fields clientHeightCompact/Detailed, channelHeightDefault, spacerHeightDefault) ---- */
  function treeVm() {
    const s = document.querySelector('.ts-server-tree-scroller');
    for (let e = s; e; e = e.parentElement) { if (e.__vue__ && e.__vue__.$data && 'clientHeightCompact' in e.__vue__.$data) return e.__vue__; }
    return null;
  }
  /* the variables the tree reads once in mounted() (same names, same order as its own code) */
  const TREE_VARS = ['--ts-tree-client-height-compact', '--ts-tree-client-height-default', '--ts-tree-channel-height-default', '--ts-tree-spacer-height-default'];
  const TREE_FIELDS = ['clientHeightCompact', 'clientHeightDetailed', 'channelHeightDefault', 'spacerHeightDefault'];

  const sleep = ms => new Promise(r => setTimeout(r, ms));
  const bust = u => u + (u.includes('?') ? '&' : '?') + '_t=' + Date.now() + Math.random().toString(36).slice(2, 6);
  /* tsui:// is not CORS-readable with a plain fetch, but a no-cors fetch of the (same-scheme) extension file hands back the text */
  const fetchText = async u => { const r = await fetch(bust(u), { mode: 'no-cors', cache: 'no-store' }); if (!r.ok) throw new Error('HTTP ' + r.status + ' for ' + u.split('?')[0]); return r.text(); };

  const TOKEN = /@import\s+(?:url\(\s*(['"]?)([^'")]*)\1\s*\)|(['"])([^'"]*)\3)\s*;|url\(\s*(['"]?)([^'")]*)\5\s*\)/g;
  /* flatten(url): the file text with every plain @import inlined and every relative url() made absolute, so it can live in a <style> */
  async function flatten(url, depth, seen) {
    if (depth > 6 || seen.has(url.split('?')[0])) return '';
    seen.add(url.split('?')[0]);
    const text = await fetchText(url);
    let out = '', last = 0, m;
    TOKEN.lastIndex = 0;
    while ((m = TOKEN.exec(text))) {
      out += text.slice(last, m.index); last = m.index + m[0].length;
      const imp = m[2] !== undefined ? m[2] : m[4];
      if (imp !== undefined) { out += await flatten(new URL(imp, url).href, depth + 1, seen); continue; }
      const u = m[6];
      out += (!u || /^(data:|#|[a-z][a-z0-9+.-]*:)/i.test(u)) ? m[0] : 'url("' + new URL(u, url).href + '")';
    }
    return out + text.slice(last);
  }

  boot.core.coreApi('theme', (api, track, anchors) => {
    const ctl = () => anchors.get('theme.controller');
    const st = { style: null, sig: null, href: null };
    const linkEl = () => anchors.tryGet('theme.link');

    const idOf = us => (us && typeof us === 'object') ? us.extensionIdentifier + '//' + us.name : (us || null);
    const current = () => idOf(ctl().appearanceSettings.user_style);

    /* installed extension themes (+ the "no theme" entry first) */
    function list() {
      const out = [{ id: null, name: 'Default (no extension theme)', extension: '' }];
      const av = ctl().getUserStyles() || {};
      for (const ext of Object.keys(av)) {
        const pkg = av[ext], themes = (pkg.content && pkg.content.themes) || [];
        for (const t of themes) out.push({ id: ext + '//' + t.name, name: t.name, extension: pkg.name || ext, source: t.source });
      }
      return out;
    }
    const rescan = async () => { ctl().refreshAvailableUserStyles(true); await sleep(400); return list(); };
    function apply(id) { if (id) ctl().applyUserStyle(id); else ctl().disableUserStyle(); }
    const activeSource = () => { const l = linkEl(); return l ? l.href : null; };

    /* the re-measure: the tree reads --ts-tree-*-height once at mount and its cache refresh is dead, so the tree gets re-mounted */
    async function remeasure() { return treeRemount(); }

    function dropStyle() { if (st.style) { st.style.remove(); st.style = null; } const l = linkEl(); if (l) l.disabled = false; }
    function swap(link, css) {
      if (!st.style || !st.style.isConnected) {
        st.style = api.el('style', { 'data-theme-live': '' });
        link.after(st.style);
        track('theme-live-style', () => { dropStyle(); st.sig = null; st.href = null; });
      }
      st.style.textContent = css;
      link.disabled = true;
    }

    /* check({force}): read the active theme (cache-busted, with its imports); when it differs from the last read (or force),
     * swap the new CSS in and re-measure the tree. The first read after start is only a baseline unless forced. */
    async function check(opts) {
      const force = !!(opts && opts.force), link = linkEl();
      if (!link && force) await remeasure();
      if (!link) { const had = !!st.style; if (had) dropStyle(); st.sig = null; st.href = null; return { active: false, changed: had }; }
      const href = link.href, css = await flatten(href, 0, new Set());
      const first = st.sig === null, changed = !first && (css !== st.sig || href !== st.href);
      st.sig = css; st.href = href;
      if (changed || force) { const l2 = linkEl(); if (l2) { swap(l2, css); await remeasure(); } }   // the link may have been replaced while we were reading
      return { active: true, changed: changed || force, bytes: css.length, source: href.split('?')[0] };
    }
    const reset = () => { st.sig = null; };   // forget the baseline (live reload switched off/on)

    /* diagnostics for tests/status: the active link and live style, and the first client row's rendered height */
    const state = () => { const l = linkEl(), r = document.querySelector('.ts-server-tree-item-leaf.client');
      return { source: l ? l.href : null, linkDisabled: l ? l.disabled : null, liveStyles: document.querySelectorAll('style[data-theme-live]').length,
        treeShown: !!A.tryGet('theme.tree'), clientRow: r ? Math.round(r.getBoundingClientRect().height) : null }; };

    return { state, list, current, apply, rescan, activeSource, check, reset, remeasure, flattenUrl: u => flatten(u, 0, new Set()) };
  });

  /* Re-measure the tree: its own cache (appController.variableCache.recomputeCache) iterates a Map with for..in and so never refreshes
   * anything, and its measuring clone is stale. So read the variables the way the clone does (a hidden probe whose width is the
   * variable, inside the tree's container so it inherits the same scope), write the numbers into the component's fields, and let it
   * rebuild its row list; the virtual list drops its cached sizes. */
  async function treeRemount() {
    const vm = A.tryGet('theme.tree'), scroller = document.querySelector('.ts-server-tree-scroller');
    if (!vm || !scroller) return { remeasured: false, reason: 'no tree shown' };
    const p = document.createElement('div');
    p.style.cssText = 'position:absolute;visibility:hidden;height:0;pointer-events:none';
    scroller.parentElement.appendChild(p);
    let vals;
    try { vals = TREE_VARS.map(n => { p.style.width = 'var(' + n + ')'; return p.getBoundingClientRect().width; }); } finally { p.remove(); }
    if (vals.some(v => !(v > 0))) return { remeasured: false, reason: 'unreadable variable', vals };
    TREE_FIELDS.forEach((f, i) => { vm[f] = vals[i]; });
    if (typeof vm.flattenServer === 'function') vm.flattenServer();
    const vl = scroller.__vue__;
    if (vl && typeof vl.refreshHeightCache === 'function') vl.refreshHeightCache();
    await sleep(60);
    return { remeasured: true, vals };
  }
})(window.__ts6modBoot);

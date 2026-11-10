/* Core extension file of the "layout" mod (panel/mods/layout/). Everything TeamSpeak-specific the mod needs lives here:
 *   api.layout.chats      open activities (servers + chats) as plain objects; show / close with the client's own actions
 *   api.layout.frame      the free zone of the title bar (between the central toolbar and the window buttons)
 *   api.layout.sidebar    collapse the left column to its icon column and put it back
 *   api.layout.density    scale the channel tree row heights live (CSS vars + the tree component's cached heights)
 *   api.layout.declutter  CSS that hides individual UI parts
 * Docs: superdoc/features/mod-layout.md. */
(function (boot) {
  'use strict';
  const A = boot.anchors, $ = A.$, $$ = A.$$;

  /* ---------- anchors ---------- */
  const actsVm = () => { const e = $('.tsv-activities'); return e && e.__vue__ && Array.isArray(e.__vue__.openedActivityGroups) ? e.__vue__ : null; };
  A.def('layout.activities', 'sidebar activities list vm (.tsv-activities): openedActivityGroups, itemClosed()', () => actsVm(), true);
  const winVm = () => { const e = $('.tsv-sidebar'); const w = e && e.__vue__ && e.__vue__.$parent; return w && w.windowLayout && typeof w.windowLayout.setSlotCollapsed === 'function' && 'collapsedSidebar' in w ? w : null; };
  A.def('layout.window', 'window vm above the sidebar: collapsedSidebar + windowLayout.setSlotCollapsed(0, bool)', () => winVm());
  A.def('layout.titleBar', 'title bar of the content area: .tsv-window-bar holding the central toolbar and the window buttons', () => $('.tsv-window-bar'), true);
  const treeVms = () => $$('.ts-server-tree-scroller').map(s => s.__vue__ && s.__vue__.$parent).filter(v => v && typeof v.flattenServer === 'function' && 'clientHeightDetailed' in v);
  A.def('layout.tree', 'channel tree component(s): cached row heights (clientHeightCompact/Detailed, channelHeightDefault, spacerHeightDefault) + flattenServer()', () => treeVms()[0], true);

  /* ---------- hide rules (declutter) ---------- */
  const HIDE = {
    announce:   { label: 'Announcement bar', group: 'Server view', help: 'The bar above the channel tree (for example "Is this your TeamSpeak server?").', css: '.ts-notification:has(.ts-notification-widget-announcement) { display: none !important; }\n.ts-notifications-overlay:has(.ts-notification-widget-announcement):not(:has(.ts-notification:not(:has(.ts-notification-widget-announcement)))) { display: none !important; }' },
    hostBanner: { label: 'Server banner on the info page', group: 'Server view', help: 'The (often empty) banner card at the top of the server info page.', css: '.tsv-server-host-banner { display: none !important; }' },
    transfer:   { label: 'File transfer info', group: 'Server view', help: 'The "File Transfer Info" card on the server info page.', css: '.ts-transfer-quota-outer { display: none !important; }' },
    createChannel: { label: 'Create Channel button', group: 'Server view', help: 'The Create Channel button at the bottom of the channel tree.', css: '.ts-server-status-constructive-buttons { display: none !important; }' },
    afk:        { label: 'AFK button', group: 'Toolbar', help: 'The away button next to the microphone and speaker buttons.', css: '.tsv-central-toolbar > .tsv-tool-buttons:not(.tsv-central-toolbar-buttons) { display: none !important; }' },
    join:       { label: '"Create a TeamSpeak Community" button', group: 'Sidebar', help: 'The big button below the server list in the left column.', css: '.ts-join-community { display: none !important; }' },
    bookmarks:  { label: 'Bookmarks section', group: 'Sidebar', help: 'The Bookmarks block in the left column.', css: '.resources-section .tsv-resources-group:has(.ts-bookmarks-root) { display: none !important; }' },
    dashStart:  { label: 'Dashboard: "Start your own Community" banner', group: 'Dashboard', help: 'The promotion banner at the top of the Dashboard.', css: '.ts-start-community-banner { display: none !important; }' },
    dashPopular: { label: 'Dashboard: Popular Servers', group: 'Dashboard', help: 'The Popular Servers block with the server cards and the quick-connect field.', css: '.tsv-highlight-servers > :not(.ts-start-community-banner) { display: none !important; }' },
    dashChats:  { label: 'Dashboard: Chats', group: 'Dashboard', help: 'The "Join / Start a Group Chat" block.', css: '.tsv-dashboard-chats { display: none !important; }' },
  };
  const selOf = k => HIDE[k].css.split(' {')[0];

  /* ---------- helpers ---------- */
  const flat = x => (Array.isArray(x) ? x.flatMap(flat) : [x]);
  const items = () => { const v = actsVm(); return v ? v.openedActivityGroups.flatMap(g => flat(g.items)).filter(Boolean) : []; };
  const safe = (f, d) => { try { const x = f(); return x === undefined ? d : x; } catch (e) { return d; } };
  const app = () => A.get('app.controller');
  const unreadOf = it => it.type === 'connection' ? safe(() => +it.badgeCount || 0, 0)
    : safe(() => { const c = (it.client || it.channel); const ch = c && c.chat; return ch ? +(ch.unread_message_count || 0) : 0; }, 0);
  function snapshot() {
    const cur = safe(() => app().currentActivityIdentifier, '');
    const its = items();
    const chatActive = its.some(i => i.type !== 'connection' && safe(() => i.isActive, false));
    return its.map(it => {
      const server = it.type === 'connection';
      return { id: String(it.identifier), kind: server ? 'server' : 'chat', title: String(safe(() => it.displayName, '') || it.identifier),
        unread: unreadOf(it), active: server ? (!chatActive && it.identifier === cur) : !!safe(() => it.isActive, false), closable: !server };
    });
  }
  const byId = id => items().find(i => String(i.identifier) === id);

  /* ---------- density: probe element converts a CSS var to a number of px ---------- */
  const DENSITY_VARS = ['--ts-tree-client-height-default', '--ts-tree-client-height-compact', '--ts-tree-channel-height-default', '--ts-tree-spacer-height-default'];
  const FIELD_OF = { '--ts-tree-client-height-compact': 'clientHeightCompact', '--ts-tree-client-height-default': 'clientHeightDetailed', '--ts-tree-channel-height-default': 'channelHeightDefault', '--ts-tree-spacer-height-default': 'spacerHeightDefault' };
  function measureVar(name) {
    const p = document.createElement('div'); p.style.cssText = 'position:absolute;visibility:hidden;pointer-events:none;width:1px;height:var(' + name + ')';
    document.documentElement.appendChild(p); const h = p.getBoundingClientRect().height; p.remove(); return h;
  }
  function pushHeightsToTrees() {   // the tree component caches the heights at mount (and its cache refresh is broken): write them in and re-flatten
    for (const vm of treeVms()) {
      for (const n of DENSITY_VARS) { const h = measureVar(n); if (h > 0) vm[FIELD_OF[n]] = h; }
      vm.flattenServer();
    }
  }

  boot.core.coreApi('layout', (api, track) => {
    let sidebarUndo = null, sidebarWas = null;
    let densStyle = null, densRaw = null, densUndo = null;

    function sidebarSet(on) {
      const w = winVm(); if (!w) return false;
      if (sidebarUndo === null) {
        sidebarWas = !!w.collapsedSidebar;
        sidebarUndo = track('layout-sidebar', () => { const ww = winVm(); if (ww && !sidebarWas && ww.collapsedSidebar) ww.windowLayout.setSlotCollapsed(0, false); sidebarUndo = null; });
      }
      if (!!w.collapsedSidebar !== !!on) w.windowLayout.setSlotCollapsed(0, !!on);
      return true;
    }

    function densitySet(f) {
      if (!(f > 0)) return;
      if (!densUndo) {
        const cs = getComputedStyle(document.documentElement);
        densRaw = DENSITY_VARS.map(n => [n, cs.getPropertyValue(n).trim()]).filter(([, v]) => v);
        if (!densRaw.length) return;
        densStyle = document.createElement('style'); densStyle.setAttribute('data-ts6mod', api.id); document.head.appendChild(densStyle);
        densUndo = track('layout-density', () => { densStyle.remove(); densStyle = null; densUndo = null; pushHeightsToTrees(); });
      }
      densStyle.textContent = ':root{' + densRaw.map(([n, v]) => n + ':calc((' + v + ') * ' + f + ') !important').join(';') + '}';
      pushHeightsToTrees();
    }

    return {
      chats: {
        available: () => !!actsVm(),
        list: snapshot,
        /* cb(list) when the set of tabs, a title, an unread count or the active tab changes */
        onChange(cb) {
          const un = A.get('app.root').$watch(() => JSON.stringify(snapshot()), () => cb(snapshot()));
          return track('layout-watch', un);
        },
        show(id) { const it = byId(id); if (!it) return false; app().showItem(it); return true; },
        close(id) { const it = byId(id), v = actsVm(); if (!it || !v) return false; Promise.resolve(v.itemClosed(it)).catch(() => {}); return true; },
      },
      frame: {
        /* free zone of the title bar: {left, right, top, height} in page px, or null */
        rect() {
          const bar = $('.tsv-central-toolbar') ? $('.tsv-central-toolbar').closest('.tsv-window-bar') : $('.tsv-window-bar');
          if (!bar) return null;
          const br = bar.getBoundingClientRect(), tb = $('.tsv-central-toolbar');
          let left = tb ? tb.getBoundingClientRect().right : br.left;
          const sb = $('.tsv-sidebar'); if (!tb && sb) left = Math.max(left, sb.getBoundingClientRect().right);
          let right = window.innerWidth;
          for (const b of $$('.tsv-window-bar')) { const last = b.lastElementChild; if (last && last.querySelector('.tsv-action-subtle')) right = Math.min(right, last.getBoundingClientRect().left); }
          return { left: left + 12, right: right - 12, top: br.top, height: br.height };
        },
        /* cb() when the title bar geometry may have changed (resize, sidebar collapse, panes moved) */
        onChange(cb) {
          const ro = new ResizeObserver(() => cb());
          [document.documentElement, ...$$('.tsv-window-bar'), $('.tsv-sidebar')].filter(Boolean).forEach(e => ro.observe(e));
          const un = safe(() => A.get('app.root').$watch(() => { const w = winVm(); return w ? JSON.stringify(w.windowLayout.windowSlots.map(s => s.size)) : ''; }, () => cb()), null);
          return track('layout-frame-watch', () => { ro.disconnect(); if (un) un(); });
        },
      },
      sidebar: {
        collapsed: () => { const w = winVm(); return w ? !!w.collapsedSidebar : null; },
        collapse: () => sidebarSet(true),
        restore: () => { if (sidebarUndo) sidebarUndo(); },   // put the column back as it was before collapse()
      },
      density: {
        /* f = factor of the stock row heights (1 = vanilla); applies live, no reload */
        set: f => { if (Math.abs(f - 1) < 0.001) { if (densUndo) densUndo(); } else densitySet(f); },
        reset: () => { if (densUndo) densUndo(); },
        active: () => !!densUndo,
        rowHeights: () => treeVms().length ? [...$$('.ts-server-tree-item-leaf')].slice(0, 12).map(r => Math.round(r.getBoundingClientRect().height * 10) / 10) : [],
      },
      declutter: {
        items: Object.entries(HIDE).map(([key, h]) => ({ key, label: h.label, group: h.group, help: h.help })),
        /* css text hiding the given keys (an array of keys); both Dashboard blocks hidden = the whole card goes */
        css(keys) {
          const set = new Set(keys); let css = Object.keys(HIDE).filter(k => set.has(k)).map(k => HIDE[k].css).join('\n');
          if (set.has('dashStart') && set.has('dashPopular')) css += '\n.tsv-dashboard-servers { display: none !important; }';
          return css;
        },
      },
    };
  });

  /* ---------- test helper (used by panel/mods/layout/test.mjs through ctx.eval; harmless otherwise) ---------- */
  window.__ts6modLayoutDev = {
    /* open up to n private chats (a first message makes the client list them as open chats); returns the number of open chats */
    async openChats(n) {
      const h = A.get('app.connections')[0].serverConnectionHandler, me = h.ownClient;
      const others = [...h.GetFlatListClients()].filter(c => c !== me && c.id !== me.id);
      others.sort((a, b) => (/^Layout/.test(b.nickname || b.name) ? 1 : 0) - (/^Layout/.test(a.nickname || a.name) ? 1 : 0));
      for (const c of others.slice(0, n)) {
        app().showItem(c, 'Chat');
        let ci = null; for (let i = 0; i < 40 && !ci; i++) { await new Promise(r => setTimeout(r, 100)); const e = $('.ts-chat-input-container'); ci = e && e.__vue__ && typeof e.__vue__.sendMessageContent === 'function' ? e.__vue__ : null; }
        if (!ci) continue;
        ci.msg = 'layout test'; await ci.sendMessageContent(); await new Promise(r => setTimeout(r, 600));
      }
      return items().filter(i => i.type !== 'connection').length;
    },
    /* geometry for tests: sidebar width, heights of the tree rows, strip height, the client's bar height */
    probe() {
      const sb = $('.tsv-sidebar'), t = $('.lay-tab');
      return { sidebar: sb ? Math.round(sb.getBoundingClientRect().width) : 0, rows: $$('.ts-server-tree-item-leaf').slice(0, 20).map(r => Math.round(r.getBoundingClientRect().height * 10) / 10),
        tab: t ? Math.round(t.getBoundingClientRect().height) : 0, barVar: getComputedStyle(document.documentElement).getPropertyValue('--tsv-bar-height').trim() };
    },
    /* per hide key: how many matching elements exist and how many of them are display:none */
    hideState() {
      const o = {};
      for (const k of Object.keys(HIDE)) { const els = $$(selOf(k)); o[k] = { n: els.length, hidden: els.filter(e => getComputedStyle(e).display === 'none').length }; }
      return o;
    },
    showServer() { const a = app(); a.showItem(a.connections[0]); },
    showDashboard() { const a = app(); a.showItem(a.dashboard); },
  };
})(window.__ts6modBoot);

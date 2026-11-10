/* Core extension file of the "layout" mod (panel/mods/layout/). Everything TeamSpeak-specific the mod needs lives here:
 *   api.layout.chats      the own channel's chat (pinned tab) + open chats as plain objects; show / close with the client's own actions
 *   api.layout.frame      the tab zone of the title bar (from the chat pane's content start, never over the central toolbar, to the
 *                         window buttons)
 *   api.layout.sidebar    collapse the left column to its icon column and put it back
 *   api.layout.density    scale the channel tree row heights live (CSS vars + the tree component's cached heights)
 *   api.layout.declutter  CSS that hides individual UI parts
 *   api.layout.createChannel  style of the Create Channel button at the bottom of the channel tree (round collapse / compact / hidden)
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
  /* bottom bar of the server pane: the server-status-bar component sets isSmall = bar width < (label copy + right group) and then
     renders the visible button group without its title; a hidden copy (.ts-hidden) always carries the title and is what it measures */
  const statusBars = () => $$('.ts-server-status-bar').filter(e => e.__vue__ && 'isSmall' in e.__vue__);
  A.def('layout.statusBar', 'server pane bottom bar (.ts-server-status-bar, vm isSmall) with the Create Channel group .ts-server-status-constructive-buttons', () => statusBars()[0], true);
  const CC_BTN = '.ts-server-status-bar > .ts-server-status-constructive-buttons:not(.ts-hidden) > .tsv-tool-button';
  A.def('layout.createChannel', 'visible Create Channel button (.tsv-tool-button in the non-.ts-hidden constructive group); label .tsv-tool-button-title', () => $(CC_BTN), true);
  /* the chat pane: the detail activity view right of the channel tree (it shows the channel / private chat); its content header
     item (.tsv-content-header-bar > .tsv-bar-item) is where the chat's own header and messages start */
  const chatPane = () => $$('.tsv-activity-detail').find(e => e.getClientRects().length && e.getBoundingClientRect().width > 0) || null;
  A.def('layout.chatPane', 'chat pane = visible .tsv-activity-detail (detail view right of the tree); content starts at its .tsv-content-header-bar > .tsv-bar-item', () => chatPane(), true);
  /* own channel chat, as the stock "Show current Channel Chat" button does it: connection.currentChannelItem (= ownClient.GetChannel()),
     shown with appController.showItem(channel, 'Chat'); active when it is the connection's activeDetailItem in Chat mode and the
     connection is the current activity without a slide-over; unread = connection.unreadChannelMessageCount */
  A.def('layout.ownChannel', 'connection.currentChannelItem + isActiveServer + unreadChannelMessageCount; showItem(channel, "Chat")', () => { const c = A.get('app.connections').find(x => x.currentChannelItem); return c && 'isActiveServer' in c && 'unreadChannelMessageCount' in c ? c : null; }, true);
  A.def('layout.tree','channel tree component(s): cached row heights (clientHeightCompact/Detailed, channelHeightDefault, spacerHeightDefault) + flattenServer()', () => treeVms()[0], true);

  /* ---------- hide rules (declutter) ---------- */
  const HIDE = {
    announce:   { label: 'Announcement bar', group: 'Server view', help: 'The bar above the channel tree (for example "Is this your TeamSpeak server?").', css: '.ts-notification:has(.ts-notification-widget-announcement) { display: none !important; }\n.ts-notifications-overlay:has(.ts-notification-widget-announcement):not(:has(.ts-notification:not(:has(.ts-notification-widget-announcement)))) { display: none !important; }' },
    hostBanner: { label: 'Server banner on the info page', group: 'Server view', help: 'The (often empty) banner card at the top of the server info page.', css: '.tsv-server-host-banner { display: none !important; }' },
    transfer:   { label: 'File transfer info', group: 'Server view', help: 'The "File Transfer Info" card on the server info page.', css: '.ts-transfer-quota-outer { display: none !important; }' },
    afk:        { label: 'AFK button', group: 'Toolbar', help: 'The away button next to the microphone and speaker buttons.', css: '.tsv-central-toolbar > .tsv-tool-buttons:not(.tsv-central-toolbar-buttons) { display: none !important; }' },
    join:       { label: '"Create a TeamSpeak Community" button', group: 'Sidebar', help: 'The big button below the server list in the left column.', css: '.ts-join-community { display: none !important; }' },
    bookmarks:  { label: 'Bookmarks section', group: 'Sidebar', help: 'The Bookmarks block in the left column.', css: '.resources-section .tsv-resources-group:has(.ts-bookmarks-root) { display: none !important; }' },
    dashStart:  { label: 'Dashboard: "Start your own Community" banner', group: 'Dashboard', help: 'The promotion banner at the top of the Dashboard.', css: '.ts-start-community-banner { display: none !important; }' },
    dashPopular: { label: 'Dashboard: Popular Servers', group: 'Dashboard', help: 'The Popular Servers block with the server cards and the quick-connect field.', css: '.tsv-highlight-servers > :not(.ts-start-community-banner) { display: none !important; }' },
    dashChats:  { label: 'Dashboard: Chats', group: 'Dashboard', help: 'The "Join / Start a Group Chat" block.', css: '.tsv-dashboard-chats { display: none !important; }' },
  };
  const selOf = k => HIDE[k].css.split(' {')[0];

  /* Create Channel button styles. vanilla = only the stock collapsed state (no title child) becomes a 30 px circle; compact = the
     title is always hidden and the button is that circle; hidden = the whole group (and its measuring copy) is gone. */
  const CC_CIRCLE = 'width: 30px !important; height: 30px !important; min-width: 30px; padding: 0 !important; box-sizing: border-box; justify-content: center; align-items: center; border-radius: 50% !important;';
  const CC_CSS = {
    vanilla: CC_BTN + ':not(:has(.tsv-tool-button-title)) { ' + CC_CIRCLE + ' }',
    compact: CC_BTN + ' { ' + CC_CIRCLE + ' }\n' + CC_BTN + ' > .tsv-tool-button-title { display: none !important; }',
    hidden: '.ts-server-status-constructive-buttons { display: none !important; }',
  };
  const ccLabel = () => { const t = $('.ts-server-status-constructive-buttons.ts-hidden .tsv-tool-button-title'); return (t && t.textContent.trim()) || 'Create Channel'; };

  /* ---------- helpers ---------- */
  const flat = x => (Array.isArray(x) ? x.flatMap(flat) : [x]);
  const items = () => { const v = actsVm(); return v ? v.openedActivityGroups.flatMap(g => flat(g.items)).filter(Boolean) : []; };
  const safe = (f, d) => { try { const x = f(); return x === undefined ? d : x; } catch (e) { return d; } };
  const app = () => A.get('app.controller');
  const unreadOf = it => it.type === 'connection' ? safe(() => +it.badgeCount || 0, 0)
    : safe(() => { const c = (it.client || it.channel); const ch = c && c.chat; return ch ? +(ch.unread_message_count || 0) : 0; }, 0);
  /* the connection the pinned tab belongs to: the active server, else the one shown, else the first with a channel */
  const pinConn = () => safe(() => {
    const cs = A.get('app.connections').filter(c => c.currentChannelItem), cur = app().currentActivityIdentifier;
    return cs.find(c => c.isActiveServer) || cs.find(c => c.identifier === cur) || cs[0] || null;
  }, null);
  const PIN = 'pinned';
  /* stable key of a chat item for the saved tab order: <server uuid>|u:<client unique id> or <server uuid>|c:<channel id> */
  const chatKey = it => safe(() => {
    const cl = it.client, ch = it.channel, h = (cl || ch).sc_handler;
    return (h && h.uuid || '?') + '|' + (cl ? 'u:' + (cl.properties.uniqueIdentifier || cl.identifier) : 'c:' + ch.id);
  }, 'id:' + it.identifier);
  /* list of tabs: one pinned tab for the own channel's chat of the active server (kind 'pinned'), then one per open chat (kind
     'chat'); the chat item of that same channel is left out (the pinned tab stands for it). Servers are no tabs. */
  function snapshot() {
    const a = app(), conn = pinConn(), ch = conn && conn.currentChannelItem;
    const out = [];
    if (ch) {
      const conns = safe(() => A.get('app.connections').filter(c => c.currentChannelItem).length, 1);
      out.push({ id: PIN, kind: 'pinned', key: safe(() => conn.serverConnectionHandler.uuid, '?') + '|c:' + ch.id, title: String(safe(() => ch.displayName, '') || ''), server: String(safe(() => conn.displayName, '') || ''),
        multi: conns > 1, unread: safe(() => +conn.unreadChannelMessageCount || 0, 0),
        active: safe(() => conn.activeDetailItem === ch && ch.lastContentModeKey === 'Chat' && a.currentActivity === conn && !a.hasSlideoverVisible, false), closable: false });
    }
    for (const it of items()) {
      if (it.type === 'connection' || (ch && safe(() => it.channel === ch, false))) continue;
      out.push({ id: String(it.identifier), kind: 'chat', key: chatKey(it), title: String(safe(() => it.displayName, '') || it.identifier),
        unread: unreadOf(it), active: !!safe(() => it.isActive, false), closable: true });
    }
    return out;
  }
  const byId = id => items().find(i => String(i.identifier) === id);
  /* server uuids of the established connections (the mod prunes the saved order only for chats of a server that is still there) */
  const liveServers = () => safe(() => A.get('app.connections').map(c => c.serverConnectionHandler && c.currentChannelItem && c.serverConnectionHandler.uuid).filter(Boolean), []);

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
    const frameWatchers = new Set();
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

    let ccUndo = null;
    const ccMarked = new Set();
    function ccLabelSet() {   // tooltip + accessible name on the visible button(s); the stock button has neither
      const name = ccLabel();
      for (const b of $$(CC_BTN)) if (b.getAttribute('title') !== name) { b.setAttribute('title', name); b.setAttribute('aria-label', name); ccMarked.add(b); }
      if (!ccUndo) ccUndo = track('layout-cc-label', () => { for (const b of ccMarked) { b.removeAttribute('title'); b.removeAttribute('aria-label'); } ccMarked.clear(); ccUndo = null; });
    }

    return {
      createChannel: {
        styles: ['vanilla', 'compact', 'hidden'],
        /* css text for a style; vanilla = stock behaviour with the auto-collapsed state drawn as a circle */
        css: style => CC_CSS[style] || CC_CSS.vanilla,
        /* put the localized label as title/aria-label on the visible button (call again after DOM changes); clear() removes it */
        label: ccLabelSet,
        clear: () => { if (ccUndo) ccUndo(); },
      },
      chats: {
        available: () => !!actsVm(),
        list: snapshot,
        /* cb(list) when the set of tabs, a title, an unread count or the active tab changes */
        onChange(cb) {
          const un = A.get('app.root').$watch(() => JSON.stringify(snapshot()), () => cb(snapshot()));
          return track('layout-watch', un);
        },
        /* show a tab: the pinned id shows the own channel's chat of the active server (the stock button's call), others their chat */
        show(id) {
          if (id === PIN) { const c = pinConn(); if (!c) return false; app().showItem(c.currentChannelItem, 'Chat'); return true; }
          const it = byId(id); if (!it) return false; app().showItem(it); return true;
        },
        close(id) { const it = byId(id), v = actsVm(); if (!it || !v) return false; Promise.resolve(v.itemClosed(it)).catch(() => {}); return true; },
        liveServers,
        /* server part of a tab key (see chatKey) */
        serverOf: key => String(key).split('|')[0],
      },
      frame: {
        /* free zone of the title bar: {left, right, top, height, chatLeft} in page px, or null. left = the chat pane's content
           start (its header item), but never left of the central toolbar's right edge + 12; chatLeft = that content start (null
           without a visible chat pane) */
        rect() {
          const bar = $('.tsv-central-toolbar') ? $('.tsv-central-toolbar').closest('.tsv-window-bar') : $('.tsv-window-bar');
          if (!bar) return null;
          const br = bar.getBoundingClientRect(), tb = $('.tsv-central-toolbar');
          let left = (tb ? tb.getBoundingClientRect().right : br.left) + 12;
          const sb = $('.tsv-sidebar'); if (!tb && sb) left = Math.max(left, sb.getBoundingClientRect().right + 12);
          const pane = chatPane(); let chatLeft = null;
          if (pane) { const hi = pane.querySelector('.tsv-content-header-bar > .tsv-bar-item'); chatLeft = hi && hi.getClientRects().length ? hi.getBoundingClientRect().left : pane.getBoundingClientRect().left + 10; left = Math.max(left, chatLeft); }
          let right = window.innerWidth;
          for (const b of $$('.tsv-window-bar')) { const last = b.lastElementChild; if (last && last.querySelector('.tsv-action-subtle')) right = Math.min(right, last.getBoundingClientRect().left); }
          return { left, right: right - 12, top: br.top, height: br.height, chatLeft };
        },
        /* cb() when the title bar geometry may have changed (resize, sidebar collapse, tree pane resized, chat pane rebuilt) */
        onChange(cb) {
          const ro = new ResizeObserver(() => cb()), seen = new Set();
          const watchEls = () => { for (const e of [document.documentElement, ...$$('.tsv-window-bar'), $('.tsv-sidebar'), chatPane(), $('.tsv-central-toolbar')]) if (e && !seen.has(e)) { seen.add(e); ro.observe(e); } };
          watchEls();
          const un = safe(() => A.get('app.root').$watch(() => { const w = winVm(); return w ? JSON.stringify(w.windowLayout.windowSlots.map(s => s.size)) : ''; }, () => cb()), null);
          frameWatchers.add(watchEls);
          return track('layout-frame-watch', () => { ro.disconnect(); seen.clear(); frameWatchers.delete(watchEls); if (un) un(); });
        },
        /* observe elements that appeared since onChange() (the chat pane and bars are rebuilt per view); call after DOM changes */
        rewatch: () => frameWatchers.forEach(f => f()),
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
      if (n > 0 && !A.get('app.connections').every(c => c.connectInfo && /^(127\.0\.0\.1|localhost|::1)$/.test(String(c.connectInfo.address)))) throw new Error('openChats sends messages: refused outside the local test server');
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
    /* local test server only: send "layout test" into the own channel (makes the client list that channel chat as an open chat);
       with chId, first move the own client into that channel. Returns the own channel's name. */
    async channelChat(chId) {
      if (!A.get('app.connections').every(c => c.connectInfo && /^(127\.0\.0\.1|localhost|::1)$/.test(String(c.connectInfo.address)))) throw new Error('channelChat moves/sends: refused outside the local test server');
      const c = A.get('app.connections')[0], h = c.serverConnectionHandler;
      if (chId != null) {
        let target = null; const walk = x => { for (const y of x.channels || []) { if (String(y.id) === String(chId)) target = y; walk(y); } }; walk(h);
        if (target && target !== h.ownClient.GetChannel()) { await h.RequestMoveClientsToChannel([h.ownClient], target); await new Promise(r => setTimeout(r, 700)); }
      }
      app().showItem(c.currentChannelItem, 'Chat');
      let ci = null; for (let i = 0; i < 40 && !ci; i++) { await new Promise(r => setTimeout(r, 100)); const e = $('.ts-chat-input-container'); ci = e && e.__vue__ && typeof e.__vue__.sendMessageContent === 'function' ? e.__vue__ : null; }
      if (ci) { ci.msg = 'layout test'; await ci.sendMessageContent(); await new Promise(r => setTimeout(r, 600)); }
      return c.currentChannelItem.displayName;
    },
    /* name of the own channel of the pinned tab's server / whether its chat is also listed as an open chat item */
    ownChannel() { const c = pinConn(); return c ? c.currentChannelItem.displayName : null; },
    ownChannelChatOpen() { const c = pinConn(), ch = c && c.currentChannelItem; return !!ch && items().some(i => i.type !== 'connection' && safe(() => i.channel === ch, false)); },
    /* channels of the first connection (id + name), for tests that move the own client */
    channels() { const out = [], h = A.get('app.connections')[0].serverConnectionHandler; const walk = x => { for (const y of x.channels || []) { out.push({ id: String(y.id), name: y.properties.name }); walk(y); } }; walk(h); return out; },
    /* strip left edge vs. the chat pane's content start (the alignment target) */
    align() { const s = $('.lay-strip'), r = s && s.getBoundingClientRect(), pane = chatPane(), hi = pane && pane.querySelector('.tsv-content-header-bar > .tsv-bar-item');
      return { strip: r ? Math.round(r.left) : null, chat: hi ? Math.round(hi.getBoundingClientRect().left) : pane ? Math.round(pane.getBoundingClientRect().left + 10) : null, toolbar: $('.tsv-central-toolbar') ? Math.round($('.tsv-central-toolbar').getBoundingClientRect().right) : null }; },
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
    /* Create Channel button + bottom bar geometry of the shown server pane */
    cc() {
      const bar = statusBars().find(e => e.offsetParent) || statusBars()[0], b = bar && bar.querySelector(':scope > .ts-server-status-constructive-buttons:not(.ts-hidden) > .tsv-tool-button');
      const R = e => { if (!e || !e.getClientRects().length) return null; const r = e.getBoundingClientRect(); return { l: Math.round(r.left), t: Math.round(r.top), r: Math.round(r.right), b: Math.round(r.bottom), w: Math.round(r.width * 10) / 10, h: Math.round(r.height * 10) / 10 }; };
      const t = b && b.querySelector('.tsv-tool-button-title');
      return { bar: R(bar), collapsed: bar ? !!bar.__vue__.isSmall : null, btn: R(b), shown: !!R(b),
        label: !!t && getComputedStyle(t).display !== 'none', radius: b ? getComputedStyle(b).borderRadius : '', title: b ? b.getAttribute('title') : null,
        right: R(bar && bar.querySelector(':scope > .ts-server-informative-buttons')) };
    },
    /* main (tree) pane: paneWidth(px) sets its slot size like a drag of the divider (not saved; clamped to the slot minimum by the
       client) and returns the previous slot size; paneWidth() returns the bottom bar width */
    paneWidth(px) {
      const L = winVm() && winVm().windowLayout, slot = L && L.windowSlots[L.mainIndex];
      if (px != null && slot) { const was = slot.size; slot.size = px; slot.change = 0; L.injectOrUpdateStylesheet(L.mainIndex); return was; }
      const bar = statusBars().find(e => e.offsetParent); return bar ? Math.round(bar.getBoundingClientRect().width) : null;
    },
    showServer() { const a = app(); a.showItem(a.connections[0]); },
    showDashboard() { const a = app(); a.showItem(a.dashboard); },
  };
})(window.__ts6modBoot);

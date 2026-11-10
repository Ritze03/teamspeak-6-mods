/* Layout mod: chat tabs (and optionally server tabs) in the title bar with the sidebar collapsed to its icon column, a live
 * row-height slider for the channel tree, and switches that hide individual UI parts. Every feature is its own switch and
 * starts off. All TeamSpeak specifics are in panel/core/x-layout.js (api.layout). Docs: superdoc/features/mod-layout.md. */
(() => {
  const DEF = { chatTabs: false, serverTabs: false, density: 100, hide: {} };
  let M = null;   // state of the enabled mod, shared with the settings page

  function enable(api) {
    const L = api.layout, st = api.storage;
    const S = { chatTabs: !!st.get('chatTabs', DEF.chatTabs), serverTabs: !!st.get('serverTabs', DEF.serverTabs), density: +st.get('density', DEF.density) || 100, hide: Object.assign({}, st.get('hide', {})) };
    const stripOn = () => S.chatTabs || S.serverTabs;
    let strip = null, stripIcons = [], stopWatch = null, stopFrame = null, hideStyle = null, sidebarDone = false;

    /* ---------- tab strip ---------- */
    function buildTab(t) {
      const kids = [];
      if (t.kind === 'server') { const ic = api.icon('server'); ic.classList.add('lay-tab-icon'); kids.push(ic); }
      kids.push(api.el('span', { class: 'lay-tab-title' }, t.title));
      if (t.unread > 0) kids.push(api.el('span', { class: 'lay-tab-badge' }, t.unread > 99 ? '99+' : String(t.unread)));
      if (t.closable) kids.push(api.el('button', { class: 'lay-tab-x', type: 'button', title: 'Close chat', on: { click: e => { e.stopPropagation(); L.chats.close(t.id); } } }, '×'));
      return api.el('div', { class: 'lay-tab ' + t.kind + (t.active ? ' active' : '') + (t.unread > 0 ? ' unread' : ''), title: t.title, 'data-tab': t.id, on: { click: () => L.chats.show(t.id) } }, ...kids);
    }
    function render() {
      if (!strip) return;
      const tabs = L.chats.list().filter(t => (t.kind === 'server' ? S.serverTabs : S.chatTabs));
      const servers = tabs.filter(t => t.kind === 'server'), chats = tabs.filter(t => t.kind === 'chat');
      // a shown chat tab that is the open view takes the highlight from the server tab; with chat tabs off the server tab keeps it
      // (the own channel's chat counts as active whenever that channel is showing, which must not hide the server tab)
      if (chats.some(t => t.active)) servers.forEach(t => { t.active = false; });
      const key = JSON.stringify(tabs);
      if (strip.dataset.key === key) return;
      strip.dataset.key = key;
      strip.replaceChildren(...servers.map(buildTab), ...(servers.length && chats.length ? [api.el('span', { class: 'lay-sep' })] : []), ...chats.map(buildTab));
      strip.classList.toggle('empty', !tabs.length);
      const a = strip.querySelector('.lay-tab.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      place();
    }
    function place() {
      if (!strip) return;
      const r = L.frame.rect(); if (!r || r.right - r.left < 60) { strip.style.display = 'none'; return; }
      const h = Math.min(36, r.height);   // the client's bar height
      Object.assign(strip.style, { display: '', left: r.left + 'px', width: (r.right - r.left) + 'px', top: (r.top + (r.height - h) / 2) + 'px', height: h + 'px' });
    }
    function startStrip() {
      if (strip) return;
      strip = api.el('div', { class: 'lay-strip' });
      strip.addEventListener('wheel', e => { if (Math.abs(e.deltaY) > Math.abs(e.deltaX)) { strip.scrollLeft += e.deltaY; e.preventDefault(); } }, { passive: false });
      document.body.append(strip);
      if (!sidebarDone) { sidebarDone = L.sidebar.collapse(); }
      stopWatch = L.chats.onChange(render); stopFrame = L.frame.onChange(place);
      render(); place();
      api.timeout(place, 400); api.timeout(place, 1200);   // the sidebar collapse animates; settle afterwards
    }
    function stopStrip() {
      if (!strip) return;
      if (stopWatch) { stopWatch(); stopWatch = null; } if (stopFrame) { stopFrame(); stopFrame = null; }
      strip.remove(); strip = null;
      L.sidebar.restore(); sidebarDone = false;
    }
    api.listen(window, 'resize', place);
    api.onDom(() => { if (strip) { render(); place(); } }, { debounce: 150 });   // the chat list lives in a component that can be rebuilt
    api.onRoute(() => { if (strip) render(); });

    /* ---------- declutter ---------- */
    function applyHide() {
      if (hideStyle) { hideStyle(); hideStyle = null; }
      const keys = Object.keys(S.hide).filter(k => S.hide[k]);
      if (keys.length) hideStyle = api.addStyle(L.declutter.css(keys));
    }

    /* ---------- apply everything from S ---------- */
    function applyAll() {
      if (stripOn()) { if (!strip) startStrip(); else render(); } else stopStrip();
      L.density.set(S.density / 100);
      applyHide();
    }
    M = {
      S, L,
      setTabs(which, on) { S[which] = !!on; st.set(which, !!on); applyAll(); },
      setDensity(v) { S.density = v; st.set('density', v); L.density.set(v / 100); },
      setHide(key, on) { if (on) S.hide[key] = true; else delete S.hide[key]; st.set('hide', Object.assign({}, S.hide)); applyHide(); },
    };
    applyAll();
  }

  /* ---------- settings (Mods page) ---------- */
  function settings(api, box) {
    if (!M) { box.append(api.ui.note('Not ready.')); return; }
    const { ui } = api, h = ui.h, { S, L } = M;
    const chatT = ui.toggle({ title: 'Chat tabs in the title bar', sub: 'Every open chat gets a tab (click to show it, × to close it). The left column is collapsed to its icon column while tabs are on and restored when they are off.', checked: S.chatTabs, onChange: v => M.setTabs('chatTabs', v) });
    const srvT = ui.toggle({ title: 'Servers as tabs too', sub: 'Adds a tab for every connected server in front of the chat tabs.', checked: S.serverTabs, onChange: v => M.setTabs('serverTabs', v) });
    const dens = ui.slider({ label: 'Channel tree row height', min: 60, max: 140, step: 5, unit: '%', value: S.density, help: '100% is the stock spacing; lower is more compact, higher more comfortable. Applies immediately.', onInput: v => M.setDensity(v) });
    const reset = ui.button({ label: 'Reset to 100%', kind: 'link', onClick: () => { M.setDensity(100); dens.set(100); } });
    box.append(ui.section('Tabs', chatT.el, srvT.el), ui.section('Density', dens.el, h('div', { class: 'mods-row' }, reset)));
    /* one box per group of hide switches ("Hide: Server view", ...); the help text is the hover tooltip */
    const groups = new Map();
    for (const it of L.declutter.items) {
      if (!groups.has(it.group)) { groups.set(it.group, ui.section('Hide: ' + it.group)); box.append(groups.get(it.group)); }
      groups.get(it.group).append(ui.toggle({ title: it.label, help: it.help, checked: !!S.hide[it.key], onChange: v => M.setHide(it.key, v) }).el);
    }
  }

  ts6mod.register({
    id: 'layout',
    title: 'Layout',
    group: 'Interface', order: 1,
    icon: 'M5 4h14a2 2 0 0 1 2 2v12a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z M3 9h18 M9 9v11',
    summary: 'Chat and server tabs in the title bar, channel tree row height, and hiding parts of the window you never use.',
    keywords: ['Chat tabs in the title bar', 'Servers as tabs too', 'Channel tree row height', 'Density', 'Hide', 'Announcement bar', 'Server banner', 'File transfer info', 'Create Channel button', 'AFK button', 'Bookmarks section', 'Popular Servers'],
    status: api => { const s = api.storage, hid = Object.values(s.get('hide', {})).filter(Boolean).length, d = +s.get('density', 100) || 100;
      return [s.get('chatTabs') ? 'Chat tabs' : '', s.get('serverTabs') ? 'Server tabs' : '', d !== 100 ? 'Rows ' + d + '%' : '', hid ? hid + ' hidden' : ''].filter(Boolean).join(' · '); },
    description: 'Chat tabs (and server tabs) in the title bar, a row-height slider for the channel tree, and switches to hide parts of the interface. Everything starts off.',
    enable,
    disable() { M = null; },
    settings,
  });
})();

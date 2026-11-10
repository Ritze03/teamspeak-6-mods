/* Layout mod: chat tabs in the title bar (aligned with the chat pane, the current channel's chat pinned first, reorderable) with the sidebar collapsed to its icon column, a live
 * row-height slider for the channel tree, and switches that hide individual UI parts. Every feature is its own switch and
 * starts off. All TeamSpeak specifics are in panel/core/x-layout.js (api.layout). Docs: superdoc/features/mod-layout.md. */
(() => {
  const DEF = { chatTabs: false, density: 100, hide: {}, ccStyle: 'vanilla', tabOrder: [] };
  const CC = [['vanilla', 'Vanilla', 'Stock button: the label folds away when the pane is narrow, and the folded button is a circle.'], ['compact', 'Compact', 'Always just the circle with the plus icon (hover shows the name).'], ['hidden', 'Hidden', 'No Create Channel button.']];
  /* the Create Channel style; older versions had a "createChannel" hide switch, which counts as Hidden until a style is picked */
  const ccOf = st => { const v = st.get('ccStyle'); return CC.some(c => c[0] === v) ? v : (st.get('hide', {}) || {}).createChannel ? 'hidden' : DEF.ccStyle; };
  let M = null;   // state of the enabled mod, shared with the settings page

  function enable(api) {
    const L = api.layout, st = api.storage;
    const S = { chatTabs: !!st.get('chatTabs', DEF.chatTabs), density: +st.get('density', DEF.density) || 100, hide: Object.assign({}, st.get('hide', {})), ccStyle: ccOf(st), order: [].concat(st.get('tabOrder', DEF.tabOrder) || []).filter(k => typeof k === 'string') };
    delete S.hide.createChannel;   // migrated into ccStyle (dropped from the stored set on the next change)
    const stripOn = () => S.chatTabs;   // servers are no tabs any more: the pinned tab is the current channel's chat
    let strip = null, stripIcons = [], stopWatch = null, stopFrame = null, hideStyle = null, sidebarDone = false, ccStyle = null;

    /* ---------- tab strip: pinned own-channel chat + open chats, reorderable ---------- */
    let pinIcon = null, prevKeys = null, drag = null, pending = false, dragEndAt = 0, dropLine = null;
    function buildTab(t) {
      const kids = [];
      if (t.kind === 'pinned') { if (!pinIcon) { pinIcon = api.icon('channel'); pinIcon.classList.add('lay-tab-icon'); } kids.push(pinIcon); }
      kids.push(api.el('span', { class: 'lay-tab-title' }, t.title));
      if (t.kind === 'pinned' && t.multi && t.server) kids.push(api.el('span', { class: 'lay-tab-server' }, t.server));
      if (t.unread > 0) kids.push(api.el('span', { class: 'lay-tab-badge' }, t.unread > 99 ? '99+' : String(t.unread)));
      if (t.closable) kids.push(api.el('button', { class: 'lay-tab-x', type: 'button', title: 'Close chat', on: { click: e => { e.stopPropagation(); forget([t.key]); L.chats.close(t.id); } } }, '×'));
      const tip = t.kind === 'pinned' ? t.title + ': chat of your current channel' + (t.server ? ' (' + t.server + ')' : '') : t.title + ' (drag to reorder)';
      const el = api.el('div', { class: 'lay-tab ' + t.kind + (t.active ? ' active' : '') + (t.unread > 0 ? ' unread' : ''), title: tip, 'data-tab': t.id,
        on: { click: () => { if (performance.now() - dragEndAt > 250) L.chats.show(t.id); } } }, ...kids);
      if (t.kind === 'chat') { el.dataset.key = t.key; el.addEventListener('pointerdown', e => dragStart(e, el)); }
      return el;
    }
    /* saved order first (S.order), tabs not in it after them in the client's order (so new tabs append at the end) */
    function ordered(chats) {
      const idx = new Map(S.order.map((k, i) => [k, i]));
      return chats.map((t, i) => ({ t, i, o: idx.has(t.key) ? idx.get(t.key) : Infinity })).sort((a, b) => a.o - b.o || a.i - b.i).map(x => x.t);
    }
    function forget(keys) {
      const n = S.order.length; S.order = S.order.filter(k => !keys.includes(k));
      if (S.order.length !== n) st.set('tabOrder', S.order.slice());
    }
    /* a chat that disappeared while its server is still connected was closed: drop it from the saved order. Chats of a server that
       went away keep their place, and so does the chat the pinned tab currently stands for. */
    function prune(chats, pinKey) {
      const now = new Set(chats.map(t => t.key));
      if (prevKeys) {
        const live = new Set(L.chats.liveServers());
        forget([...prevKeys].filter(k => !now.has(k) && k !== pinKey && live.has(L.chats.serverOf(k))));
      }
      prevKeys = now;
    }
    function render() {
      if (!strip) return;
      if (drag) { pending = true; return; }   // re-render after the drop (it would replace the dragged element)
      const all = L.chats.list(), pin = all.filter(t => t.kind === 'pinned'), raw = all.filter(t => t.kind === 'chat');
      prune(raw, pin.length ? pin[0].key : null);
      const chats = ordered(raw), tabs = pin.concat(chats);
      const key = JSON.stringify(tabs);
      if (strip.dataset.key === key) return;
      strip.dataset.key = key;
      strip.replaceChildren(...pin.map(buildTab), ...(pin.length && chats.length ? [api.el('span', { class: 'lay-sep' })] : []), ...chats.map(buildTab));
      strip.classList.toggle('empty', !tabs.length);
      const a = strip.querySelector('.lay-tab.active'); if (a && a.scrollIntoView) a.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      place();
    }
    /* drag to reorder: pointer events on a chat tab (not on its x), 5 px threshold, a drop line between tabs, order saved on drop */
    function dragStart(e, el) {
      if (e.button !== 0 || (e.target.closest && e.target.closest('.lay-tab-x'))) return;
      drag = { el, key: el.dataset.key, x0: e.clientX, on: false, before: null };
      try { el.setPointerCapture(e.pointerId); } catch (err) { /* pointer already gone */ }
      el.addEventListener('pointermove', dragMove); el.addEventListener('pointerup', dragEnd); el.addEventListener('pointercancel', dragEnd);
    }
    function dragMove(e) {
      if (!drag || !strip) return;
      if (!drag.on) {
        if (Math.abs(e.clientX - drag.x0) < 5) return;
        drag.on = true; drag.el.classList.add('dragging'); strip.classList.add('dragging');
        dropLine = api.el('span', { class: 'lay-drop' }); strip.append(dropLine);
      }
      const sr = strip.getBoundingClientRect();
      if (e.clientX < sr.left + 24) strip.scrollLeft -= 12; else if (e.clientX > sr.right - 24) strip.scrollLeft += 12;
      const tabs = [...strip.querySelectorAll('.lay-tab.chat')];
      drag.before = tabs.find(t => { if (t === drag.el) return false; const r = t.getBoundingClientRect(); return e.clientX < r.left + r.width / 2; }) || null;
      const last = tabs[tabs.length - 1];
      dropLine.style.left = (drag.before ? drag.before.offsetLeft - 3 : last.offsetLeft + last.offsetWidth + 1) + 'px';
    }
    function dragEnd() {
      const d = drag; drag = null; if (!d) return;
      d.el.removeEventListener('pointermove', dragMove); d.el.removeEventListener('pointerup', dragEnd); d.el.removeEventListener('pointercancel', dragEnd);
      if (dropLine) { dropLine.remove(); dropLine = null; }
      if (d.on && strip) {
        dragEndAt = performance.now();
        d.el.classList.remove('dragging'); strip.classList.remove('dragging');
        const keys = [...strip.querySelectorAll('.lay-tab.chat')].map(t => t.dataset.key).filter(k => k !== d.key);
        const at = d.before ? keys.indexOf(d.before.dataset.key) : -1;
        keys.splice(at < 0 ? keys.length : at, 0, d.key);
        S.order = keys.concat(S.order.filter(k => !keys.includes(k)));   // saved keys of chats not shown now stay, behind
        st.set('tabOrder', S.order.slice());
      }
      if (d.on || pending) { pending = false; if (strip) { strip.dataset.key = ''; render(); } }
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
      drag = null; dropLine = null; prevKeys = null; pending = false;
      strip.remove(); strip = null;
      L.sidebar.restore(); sidebarDone = false;
    }
    api.listen(window, 'resize', place);
    api.onDom(() => { if (strip) { L.frame.rewatch(); render(); place(); } }, { debounce: 150 });   // the chat list and the chat pane are components that can be rebuilt
    api.onRoute(() => { if (strip) render(); });

    /* ---------- declutter ---------- */
    function applyHide() {
      if (hideStyle) { hideStyle(); hideStyle = null; }
      const keys = Object.keys(S.hide).filter(k => S.hide[k]);
      if (keys.length) hideStyle = api.addStyle(L.declutter.css(keys));
    }

    /* ---------- Create Channel button ---------- */
    function applyCc() {
      if (ccStyle) { ccStyle(); ccStyle = null; }
      ccStyle = api.addStyle(L.createChannel.css(S.ccStyle));
      if (S.ccStyle === 'hidden') L.createChannel.clear(); else L.createChannel.label();
    }
    api.onDom(() => { if (S.ccStyle !== 'hidden') L.createChannel.label(); }, { debounce: 200 });   // the bar is rebuilt per server / view

    /* ---------- apply everything from S ---------- */
    function applyAll() {
      if (stripOn()) { if (!strip) startStrip(); else render(); } else stopStrip();
      L.density.set(S.density / 100);
      applyHide();
      applyCc();
    }
    M = {
      S, L,
      setTabs(which, on) { S[which] = !!on; st.set(which, !!on); applyAll(); },
      setDensity(v) { S.density = v; st.set('density', v); L.density.set(v / 100); },
      setCc(v) { S.ccStyle = v; st.set('ccStyle', v); if (S.hide.createChannel !== undefined || (st.get('hide', {}) || {}).createChannel !== undefined) st.set('hide', Object.assign({}, S.hide)); applyCc(); },
      setHide(key, on) { if (on) S.hide[key] = true; else delete S.hide[key]; st.set('hide', Object.assign({}, S.hide)); applyHide(); },
    };
    applyAll();
  }

  /* ---------- settings (Mods page) ---------- */
  function settings(api, box) {
    if (!M) { box.append(api.ui.note('Not ready.')); return; }
    const { ui } = api, h = ui.h, { S, L } = M;
    const chatT = ui.toggle({ title: 'Chat tabs in the title bar', sub: 'Tabs above the chat pane. The first tab is always the chat of the channel you are in (it follows you when you switch channels); every other open chat gets a tab after it (click to show it, × to close it, drag to reorder). The left column is collapsed to its icon column while tabs are on and restored when they are off.', checked: S.chatTabs, onChange: v => M.setTabs('chatTabs', v) });
    const dens = ui.slider({ label: 'Channel tree row height', min: 60, max: 140, step: 5, unit: '%', value: S.density, help: '100% is the stock spacing; lower is more compact, higher more comfortable. Applies immediately.', onInput: v => M.setDensity(v) });
    const reset = ui.button({ label: 'Reset to 100%', kind: 'link', onClick: () => { M.setDensity(100); dens.set(100); } });
    const ccPills = CC.map(([v, label, tip]) => { const p = ui.pill({ label, on: S.ccStyle === v, onClick: () => { M.setCc(v); ccPills.forEach(x => x.p.set(x.v === v)); } }); p.el.title = tip; p.el.setAttribute('data-cc', v); return { v, p }; });
    const ccRow = h('div', { class: 'mods-row', 'data-lay': 'cc' }, h('span', { class: 'mods-label' }, 'Create Channel button (bottom of the channel tree)'), ...ccPills.map(x => x.p.el));
    box.append(ui.section('Tabs', chatT.el), ui.section('Density', dens.el, h('div', { class: 'mods-row' }, reset)), ui.section('Create Channel button', ccRow));
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
    summary: 'Chat tabs in the title bar (current channel first, reorderable), channel tree row height, Create Channel button style, and hiding parts of the window you never use.',
    keywords: ['Chat tabs in the title bar', 'Current channel', 'Reorder tabs', 'Channel tree row height', 'Density', 'Hide', 'Announcement bar', 'Server banner', 'File transfer info', 'Create Channel button', 'Compact', 'AFK button', 'Bookmarks section', 'Popular Servers'],
    status: api => { const s = api.storage, hid = Object.entries(s.get('hide', {})).filter(([k, v]) => v && k !== 'createChannel').length, d = +s.get('density', 100) || 100, cc = ccOf(s);
      return [s.get('chatTabs') ? 'Chat tabs' : '', d !== 100 ? 'Rows ' + d + '%' : '', cc !== 'vanilla' ? 'Create Channel ' + cc : '', hid ? hid + ' hidden' : ''].filter(Boolean).join(' · '); },
    description: 'Chat tabs in the title bar (the current channel\'s chat pinned first, the others reorderable by drag), a row-height slider for the channel tree, and switches to hide parts of the interface. Everything starts off.',
    enable,
    disable() { M = null; },
    settings,
  });
})();

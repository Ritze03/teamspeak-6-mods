// Layout mod: chat tabs (pinned current-channel tab, alignment with the chat pane, open / switch / reorder / close, sidebar collapse +
// restore), live row-height density, hide switches,
// settings page, clean disable. Needs a connected server (run-all opens one). The chat part needs one other client on the server
// and sends "layout test" as a private message to up to two of them and into channels (moving the own client), so it runs ONLY on
// the local test server (ctx.onTestServer());
// on any other server it just checks that the chats that are already open get a tab each (nothing sent, opened or closed).
export default async function (ctx) {
  const DEV = 'window.__ts6modLayoutDev';
  const probe = () => ctx.eval(`${DEV}.probe()`);
  const cfg = o => ctx.eval(`__ts6mod.store().settings.layout = ${JSON.stringify(Object.assign({ chatTabs: false, density: 100, hide: {}, tabOrder: [] }, o))}; 1`);
  const orig = await ctx.eval(`JSON.stringify(__ts6mod.store().settings.layout ?? null)`);   // restored at the end (settings are read from memory on enable)
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  let paneRestore = null;   // tree pane slot size to put back if the Create Channel part stops halfway
  try {
    await ctx.disable('layout');
    await ctx.eval(`${DEV}.showServer()`);
    await ctx.waitFor(`${DEV}.probe().rows.length > 2`, 'channel tree rows are shown');
    const base = await probe();
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-strip').length`), 0, 'no tab strip while the mod is off');

    /* ---- chat tabs: pinned current-channel tab, alignment with the chat pane, open / switch / close, reorder ---- */
    await cfg({ chatTabs: true });
    await ctx.enable('layout');
    await ctx.waitFor(`document.querySelectorAll('.lay-strip').length === 1`, 'tab strip appears');
    await ctx.waitFor(`${DEV}.probe().sidebar === 62`, 'sidebar collapsed to its 62 px icon column');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-tab.server').length`), 0, 'no server tabs (the server has no chat of its own)');
    await ctx.waitFor(`document.querySelectorAll('.lay-tab.pinned').length === 1`, 'one pinned tab for the current channel');
    const pinnedFirst = await ctx.eval(`(() => { const t = document.querySelector('.lay-strip .lay-tab'); return !!t && t.classList.contains('pinned') && !t.querySelector('.lay-tab-x'); })()`);
    ctx.equal(pinnedFirst, true, 'the pinned tab is leftmost and has no close button');
    ctx.equal(await ctx.eval(`document.querySelector('.lay-tab.pinned .lay-tab-title').textContent`), await ctx.eval(`${DEV}.ownChannel()`), 'pinned tab shows the own channel name');
    await ctx.eval(`document.querySelector('.lay-tab.pinned').click()`);
    await ctx.waitFor(`document.querySelector('.lay-tab.pinned.active')`, 'clicking the pinned tab shows the channel chat (pinned tab active)');
    await ctx.sleep(500);
    const al = await ctx.eval(`${DEV}.align()`);
    if (al.chat != null && al.chat > al.toolbar + 12) ctx.assert(Math.abs(al.strip - al.chat) <= 1, `strip starts where the chat pane's content starts (${al.strip} vs ${al.chat})`);
    else ctx.log(`chat pane content (${al.chat}) is left of the toolbar end (${al.toolbar}): strip starts after the toolbar (${al.strip})`);
    const wasPane = await ctx.eval(`${DEV}.paneWidth(${DEV}.paneWidth() + 120)`);   // wider tree pane: the strip follows
    paneRestore = wasPane;
    await ctx.sleep(600);
    const al2 = await ctx.eval(`${DEV}.align()`);
    if (al2.chat != null && al2.chat > al2.toolbar + 12) ctx.assert(Math.abs(al2.strip - al2.chat) <= 1 && al2.chat !== al.chat, `after resizing the tree pane the strip follows (${al2.strip} vs ${al2.chat}, was ${al.chat})`);
    await ctx.eval(`${DEV}.paneWidth(${wasPane})`); paneRestore = null;
    const local = await ctx.onTestServer();
    if (local) {
      const chans = await ctx.eval(`${DEV}.channels()`), cur = await ctx.eval(`${DEV}.ownChannel()`);
      const other = chans.find(c => c.name !== cur);
      await ctx.eval(`${DEV}.channelChat()`);   // a message in the own channel: the client lists that channel chat as an open chat
      ctx.equal(await ctx.eval(`[...document.querySelectorAll('.lay-tab.chat')].some(t => t.textContent.includes(${JSON.stringify(cur)}))`), false, 'the own channel chat gets no second tab (the pinned tab stands for it)');
      if (other) {
        await ctx.eval(`${DEV}.channelChat(${JSON.stringify(other.id)})`);
        await ctx.waitFor(`document.querySelector('.lay-tab.pinned .lay-tab-title').textContent === ${JSON.stringify(other.name)}`, `pinned tab follows a channel move (${other.name})`);
        await ctx.eval(`${DEV}.channelChat(${JSON.stringify(chans.find(c => c.name === cur).id)})`);   // back
      }
    }
    const n = await ctx.eval(`${DEV}.openChats(${local ? 2 : 0})`);   // 0 = only count the open chats, send nothing
    const own = await ctx.eval(`${DEV}.ownChannelChatOpen()`) ? 1 : 0;   // the own channel's chat item has no tab of its own
    if (!local) {
      if (n - own) await ctx.waitFor(`document.querySelectorAll('.lay-tab.chat').length === ${n - own}`, `one tab per already open chat (${n - own})`);
      ctx.skip('opening, switching, reordering and closing chat tabs', 'needs private messages to other users: local test server only');
    } else if (n - own < 1) ctx.skip('chat tabs', 'no other client on the test server to chat with');
    else {
      const m = n - own;
      await ctx.waitFor(`document.querySelectorAll('.lay-tab.chat').length === ${m}`, `one tab per open chat (${m})`);
      const ids = await ctx.eval(`[...document.querySelectorAll('.lay-tab.chat')].map(t => t.dataset.tab)`);
      await ctx.eval(`document.querySelector('.lay-tab[data-tab="${ids[0]}"]').click()`);
      await ctx.waitFor(`document.querySelector('.lay-tab[data-tab="${ids[0]}"]').classList.contains('active')`, 'clicking a tab shows that chat (it becomes active)');
      ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-tab.active').length`), 1, 'exactly one active tab (the pinned one is off)');
      if (ids.length >= 2) {
        /* drag the last chat tab in front of the first (pointer events, like a mouse drag) */
        const keys0 = await ctx.eval(`[...document.querySelectorAll('.lay-tab.chat')].map(t => t.dataset.key)`);
        await ctx.eval(`(() => { const tabs = [...document.querySelectorAll('.lay-tab.chat')], a = tabs[tabs.length - 1], b = tabs[0], ra = a.getBoundingClientRect(), rb = b.getBoundingClientRect(), y = ra.top + ra.height / 2;
          const ev = (t, x) => a.dispatchEvent(new PointerEvent(t, { clientX: x, clientY: y, button: 0, buttons: t === 'pointerup' ? 0 : 1, pointerId: 1, bubbles: true }));
          ev('pointerdown', ra.left + 30); for (let i = 1; i <= 8; i++) ev('pointermove', ra.left + 30 + (rb.left + 8 - ra.left - 30) * i / 8); ev('pointerup', rb.left + 8); })()`);
        await ctx.sleep(300);
        const keys1 = await ctx.eval(`[...document.querySelectorAll('.lay-tab.chat')].map(t => t.dataset.key)`);
        ctx.equal(keys1[0], keys0[keys0.length - 1], 'drag and drop moves the tab in front of the first one');
        ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-drop').length`), 0, 'drop line removed after the drop');
        const saved = await ctx.eval(`__ts6mod.store().settings.layout.tabOrder`);
        ctx.equal(Array.isArray(saved) && saved[0] === keys1[0], true, 'the new order is saved (tabOrder)');
        ctx.equal(await ctx.eval(`document.querySelector('.lay-tab[data-tab="${ids[0]}"]').classList.contains('active')`), true, 'a drag does not count as a click (active tab unchanged)');
      }
      await ctx.eval(`document.querySelector('.lay-tab.chat .lay-tab-x').click()`);
      await ctx.waitFor(`document.querySelectorAll('.lay-tab.chat').length === ${m - 1}`, 'the x button closes the chat');
      ctx.equal(await ctx.eval(`${DEV}.openChats(0)`), n - 1, 'the client has one chat less too');
      while (await ctx.eval(`document.querySelectorAll('.lay-tab.chat').length`) > 0) await ctx.eval(`document.querySelector('.lay-tab.chat .lay-tab-x').click()`), await ctx.sleep(400);
      ctx.equal(await ctx.eval(`(__ts6mod.store().settings.layout.tabOrder || []).length`), 0, 'closed tabs drop out of the saved order');
    }
    await ctx.eval(`${DEV}.showDashboard()`);
    await ctx.waitFor(`!document.querySelector('.lay-tab.pinned.active')`, 'the pinned tab is not active on the Dashboard');
    await ctx.eval(`document.querySelector('.lay-tab.pinned').click()`);
    await ctx.waitFor(`document.querySelector('.lay-tab.pinned.active')`, 'the pinned tab brings back the channel chat');
    await ctx.disable('layout');
    await ctx.waitFor(`${DEV}.probe().sidebar === ${base.sidebar}`, 'sidebar width restored when the mod is switched off');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-strip').length`), 0, 'strip removed');
    await ctx.assertClean('layout');

    /* ---- density: live (enable with the tree on screen) and restore without a reload ---- */
    await ctx.eval(`${DEV}.showServer()`);
    await ctx.waitFor(`${DEV}.probe().rows.length > 2`, 'tree shown');
    await cfg({ density: 70 });
    await ctx.enable('layout');
    await ctx.waitFor(`${DEV}.probe().rows.every(h => h < ${Math.max(...base.rows)})`, 'rows shrink right away');
    const small = await probe();
    ctx.assert(mean(small.rows) < mean(base.rows) * 0.8, `compact rows are clearly smaller (${mean(small.rows).toFixed(1)} vs ${mean(base.rows).toFixed(1)})`);
    await ctx.disable('layout');
    await ctx.waitFor(`Math.abs(${DEV}.probe().rows.reduce((a, b) => a + b, 0) / ${DEV}.probe().rows.length - ${mean(base.rows)}) < 1`, 'row heights back to stock after switching off');
    await ctx.assertClean('layout');

    /* ---- settings page: slider changes the tree, switches exist ---- */
    await cfg({});
    await ctx.enable('layout');
    await ctx.openModsPage('layout');
    await ctx.waitFor(`document.querySelector('[data-ts6mod="layout"] input[type=range]')`, 'density slider on the Mods page');
    const toggles = await ctx.eval(`document.querySelectorAll('[data-ts6mod="layout"] input[type=checkbox]').length`);
    ctx.assert(toggles >= 10, `settings show the chat-tab and hide switches (${toggles})`);
    await ctx.eval(`(() => { const r = document.querySelector('[data-ts6mod="layout"] input[type=range]'); r.value = 130; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ctx.restoreRoute();
    await ctx.eval(`${DEV}.showServer()`);
    await ctx.waitFor(`${DEV}.probe().rows.length > 2 && ${DEV}.probe().rows.reduce((a, b) => a + b, 0) / ${DEV}.probe().rows.length > ${mean(base.rows) * 1.15}`, 'slider to 130% makes the rows taller');
    await ctx.openModsPage('layout');
    await ctx.eval(`(() => { const r = document.querySelector('[data-ts6mod="layout"] input[type=range]'); r.value = 100; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ctx.restoreRoute();
    await ctx.disable('layout');

    /* ---- Create Channel button style: vanilla (stock + round collapse), compact (circle), hidden; narrow pane; migration; off ---- */
    await ctx.eval(`${DEV}.showServer()`);
    await ctx.waitFor(`${DEV}.cc().btn`, 'Create Channel button on screen');
    const cc = () => ctx.eval(`${DEV}.cc()`);
    const wide = await ctx.eval(`${DEV}.paneWidth()`);
    const was = await ctx.eval(`${DEV}.paneWidth(Math.max(${wide}, 520))`);   // wide enough for the label (restored in finally)
    paneRestore = was;
    await ctx.waitFor(`${DEV}.cc().collapsed === false`, 'wide pane: stock button shows its label');
    const stock = await cc();
    const circle = c => c.btn && Math.abs(c.btn.w - c.btn.h) <= 1 && c.btn.w >= 24;
    const cfgCc = async (o, msg) => { await ctx.disable('layout'); await cfg(o); await ctx.enable('layout'); await ctx.sleep(400); ctx.log(msg); };
    await cfgCc({ ccStyle: 'vanilla' }, 'style vanilla');
    let c = await cc();
    ctx.equal(c.label && Math.abs(c.btn.w - stock.btn.w) < 1 && c.radius === stock.radius, true, `vanilla, wide: the expanded pill is untouched (${c.btn.w}x${c.btn.h}, ${c.radius})`);
    ctx.equal(c.title, 'Create Channel', 'tooltip/aria-label "Create Channel" set while the mod is on');
    await ctx.eval(`${DEV}.paneWidth(200)`);   // the client clamps to the slot minimum
    await ctx.waitFor(`${DEV}.cc().collapsed === true`, 'narrow pane: the stock auto-collapse folds the label away');
    await ctx.sleep(300); c = await cc();
    ctx.assert(circle(c) && !c.label, `vanilla, narrow: the collapsed button is a circle (${c.btn.w}x${c.btn.h})`);
    ctx.assert(!c.right || c.right.r <= c.bar.r + 1, `narrow: the right group stays inside the bar (${c.right && c.right.r} <= ${c.bar.r})`);
    await ctx.eval(`${DEV}.paneWidth(${Math.max(wide, 520)})`);
    await ctx.waitFor(`${DEV}.cc().collapsed === false`, 'wide again');
    await cfgCc({ ccStyle: 'compact' }, 'style compact');
    c = await cc();
    ctx.assert(circle(c) && !c.label && c.title === 'Create Channel', `compact, wide: circle without label, tooltip kept (${c.btn.w}x${c.btn.h})`);
    await cfgCc({ ccStyle: 'hidden' }, 'style hidden');
    c = await cc();
    ctx.equal(c.shown, false, 'hidden: the button is not displayed');
    await cfgCc({ hide: { createChannel: true } }, 'old hide switch, no style');
    ctx.equal((await cc()).shown, false, 'migration: an old "createChannel" hide switch counts as Hidden');
    await ctx.disable('layout');
    c = await cc();
    ctx.equal(c.shown && c.label && c.title === null && Math.abs(c.btn.w - stock.btn.w) < 1, true, 'off: stock button back (label, no added title)');
    await ctx.assertClean('layout');
    await ctx.eval(`${DEV}.paneWidth(${was})`); paneRestore = null;
    /* settings page: three style pills */
    await cfg({});
    await ctx.enable('layout');
    await ctx.openModsPage('layout');
    await ctx.waitFor(`document.querySelectorAll('[data-ts6mod="layout"] [data-lay="cc"] [data-cc]').length === 3`, 'Create Channel style pills on the Layout page');
    ctx.equal(await ctx.eval(`document.querySelector('[data-ts6mod="layout"] [data-cc].on').dataset.cc`), 'vanilla', 'Vanilla is the default');
    await ctx.restoreRoute();
    await ctx.disable('layout');

    /* ---- hide switches ---- */
    const keysServer = ['announce', 'hostBanner', 'transfer', 'afk', 'join', 'bookmarks'], keysDash = ['dashStart', 'dashPopular', 'dashChats'];
    const hide = Object.fromEntries([...keysServer, ...keysDash].map(k => [k, true]));
    // base = what the client (or the user's theme) already hides while the mod is off: "visible" means back to that, not "all shown"
    let off0 = null;
    const check = async (keys, want, msg) => {
      const st = await ctx.eval(`${DEV}.hideState()`);
      let seen = 0;
      for (const k of keys) {
        if (st[k].n === 0) { ctx.log(`${k}: element not on screen here, not checked`); continue; }
        if (!want && off0 && off0[k] && off0[k].hidden === off0[k].n) { if (msg.startsWith('visible while')) ctx.log(`${k}: already hidden by the client or theme while the mod is off, only the "hidden while on" check applies`); continue; }
        seen++; ctx.equal(want ? st[k].hidden === st[k].n : st[k].hidden === ((off0 && off0[k] && off0[k].hidden) || 0), true, `${msg}: ${k} (${st[k].hidden}/${st[k].n} hidden)`);
      }
      return seen;
    };
    for (const [view, keys] of [['showServer', keysServer], ['showDashboard', keysDash]]) {
      await ctx.disable('layout');
      await ctx.eval(`${DEV}.${view}()`); await ctx.sleep(900);
      off0 = await ctx.eval(`${DEV}.hideState()`);
      await check(keys, false, 'visible while off');
      await cfg({ hide });
      await ctx.enable('layout'); await ctx.sleep(300);
      const seen = await check(keys, true, 'hidden while on');
      ctx.assert(seen > 0, `at least one ${view === 'showServer' ? 'server view' : 'Dashboard'} element was found to test`);
      await ctx.disable('layout'); await ctx.sleep(300);
      await check(keys, false, 'visible again after switching off');
    }
    await ctx.assertClean('layout');
  } finally {
    if (paneRestore != null) await ctx.eval(`${DEV}.paneWidth(${paneRestore})`).catch(() => {});
    await ctx.disable('layout').catch(() => {});
    await ctx.eval(`(() => { const s = __ts6mod.store().settings, o = ${JSON.stringify(orig)}; if (o === 'null') delete s.layout; else s.layout = JSON.parse(o); })()`).catch(() => {});
    await ctx.restoreRoute().catch(() => {});
  }
}

// Layout mod: chat tabs (open / switch / close, sidebar collapse + restore), server tabs, live row-height density, hide switches,
// settings page, clean disable. Needs a connected server (run-all opens one). The chat part needs one other client on the server
// and sends "layout test" as a private message to up to two of them, so it runs ONLY on the local test server (ctx.onTestServer());
// on any other server it just checks that the chats that are already open get a tab each (nothing sent, opened or closed).
export default async function (ctx) {
  const DEV = 'window.__ts6modLayoutDev';
  const probe = () => ctx.eval(`${DEV}.probe()`);
  const cfg = o => ctx.eval(`__ts6mod.store().settings.layout = ${JSON.stringify(Object.assign({ chatTabs: false, serverTabs: false, density: 100, hide: {} }, o))}; 1`);
  const orig = await ctx.eval(`JSON.stringify(__ts6mod.store().settings.layout ?? null)`);   // restored at the end (settings are read from memory on enable)
  const mean = a => a.reduce((x, y) => x + y, 0) / a.length;
  try {
    await ctx.disable('layout');
    await ctx.eval(`${DEV}.showServer()`);
    await ctx.waitFor(`${DEV}.probe().rows.length > 2`, 'channel tree rows are shown');
    const base = await probe();
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-strip').length`), 0, 'no tab strip while the mod is off');

    /* ---- chat tabs ---- */
    await cfg({ chatTabs: true });
    await ctx.enable('layout');
    await ctx.waitFor(`document.querySelectorAll('.lay-strip').length === 1`, 'tab strip appears');
    await ctx.waitFor(`${DEV}.probe().sidebar === 62`, 'sidebar collapsed to its 62 px icon column');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-tab.server').length`), 0, 'no server tabs with the server switch off');
    const local = await ctx.onTestServer();
    const n = await ctx.eval(`${DEV}.openChats(${local ? 2 : 0})`);   // 0 = only count the open chats, send nothing
    if (!local) {
      if (n) await ctx.waitFor(`document.querySelectorAll('.lay-tab.chat').length === ${n}`, `one tab per already open chat (${n})`);
      ctx.skip('opening, switching and closing chat tabs', 'needs private messages to other users: local test server only' + (n ? ` (the ${n} open chats got a tab each)` : ''));
    } else if (n === 0) ctx.skip('chat tabs', 'no other client on the test server to chat with');
    else {
      await ctx.waitFor(`document.querySelectorAll('.lay-tab.chat').length === ${n}`, `one tab per open chat (${n})`);
      ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-tab.chat.active').length`), 1, 'exactly one active tab');
      const ids = await ctx.eval(`[...document.querySelectorAll('.lay-tab.chat')].map(t => t.dataset.tab)`);
      const active = await ctx.eval(`document.querySelector('.lay-tab.chat.active').dataset.tab`);
      const other = ids.find(i => i !== active);
      if (other) {
        await ctx.eval(`document.querySelector('.lay-tab[data-tab="${other}"]').click()`);
        await ctx.waitFor(`document.querySelector('.lay-tab[data-tab="${other}"]').classList.contains('active')`, 'clicking a tab shows that chat (it becomes active)');
        ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-tab.chat.active').length`), 1, 'still exactly one active tab');
      }
      await ctx.eval(`document.querySelector('.lay-tab.chat .lay-tab-x').click()`);
      await ctx.waitFor(`document.querySelectorAll('.lay-tab.chat').length === ${n - 1}`, 'the x button closes the chat');
      ctx.equal(await ctx.eval(`${DEV}.openChats(0)`), n - 1, 'the client has one chat less too');
      while (await ctx.eval(`document.querySelectorAll('.lay-tab.chat').length`) > 0) await ctx.eval(`document.querySelector('.lay-tab.chat .lay-tab-x').click()`), await ctx.sleep(400);
    }
    await ctx.disable('layout');
    await ctx.waitFor(`${DEV}.probe().sidebar === ${base.sidebar}`, 'sidebar width restored when the mod is switched off');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-strip').length`), 0, 'strip removed');
    await ctx.assertClean('layout');

    /* ---- server tabs ---- */
    await cfg({ serverTabs: true });
    await ctx.enable('layout');
    await ctx.waitFor(`document.querySelectorAll('.lay-tab.server').length >= 1`, 'a tab per connected server');
    const p = await probe();
    ctx.equal(p.tab, parseInt(p.barVar), 'tabs are as high as the client bar (the bar-height variable)');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.lay-tab.chat').length`), 0, 'no chat tabs with the chat switch off');
    await ctx.eval(`${DEV}.showDashboard()`);
    await ctx.waitFor(`document.querySelectorAll('.lay-tab.server.active').length === 0`, 'no server tab is active on the Dashboard');
    await ctx.eval(`document.querySelector('.lay-tab.server').click()`);
    await ctx.waitFor(`document.querySelectorAll('.lay-tab.server.active').length === 1`, 'clicking the server tab shows the server');
    await ctx.disable('layout');

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
    await ctx.openModsPage();
    await ctx.waitFor(`document.querySelector('[data-ts6mod="layout"] input[type=range]')`, 'density slider on the Mods page');
    const toggles = await ctx.eval(`document.querySelectorAll('[data-ts6mod="layout"] input[type=checkbox]').length`);
    ctx.assert(toggles >= 12, `settings show the tab, server-tab and hide switches (${toggles})`);
    await ctx.eval(`(() => { const r = document.querySelector('[data-ts6mod="layout"] input[type=range]'); r.value = 130; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ctx.restoreRoute();
    await ctx.eval(`${DEV}.showServer()`);
    await ctx.waitFor(`${DEV}.probe().rows.length > 2 && ${DEV}.probe().rows.reduce((a, b) => a + b, 0) / ${DEV}.probe().rows.length > ${mean(base.rows) * 1.15}`, 'slider to 130% makes the rows taller');
    await ctx.openModsPage();
    await ctx.eval(`(() => { const r = document.querySelector('[data-ts6mod="layout"] input[type=range]'); r.value = 100; r.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ctx.restoreRoute();
    await ctx.disable('layout');

    /* ---- hide switches ---- */
    const keysServer = ['announce', 'hostBanner', 'transfer', 'createChannel', 'afk', 'join', 'bookmarks'], keysDash = ['dashStart', 'dashPopular', 'dashChats'];
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
    await ctx.disable('layout').catch(() => {});
    await ctx.eval(`(() => { const s = __ts6mod.store().settings, o = ${JSON.stringify(orig)}; if (o === 'null') delete s.layout; else s.layout = JSON.parse(o); })()`).catch(() => {});
    await ctx.restoreRoute().catch(() => {});
  }
}

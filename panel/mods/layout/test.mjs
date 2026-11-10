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
  let paneRestore = null;   // tree pane slot size to put back if the Create Channel part stops halfway
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
    await ctx.openModsPage('layout');
    await ctx.waitFor(`document.querySelector('[data-ts6mod="layout"] input[type=range]')`, 'density slider on the Mods page');
    const toggles = await ctx.eval(`document.querySelectorAll('[data-ts6mod="layout"] input[type=checkbox]').length`);
    ctx.assert(toggles >= 11, `settings show the tab, server-tab and hide switches (${toggles})`);
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

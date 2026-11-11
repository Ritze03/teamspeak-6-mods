// Net mod: off by default -> on shows the HUD with live ping/loss (needs a connected client) -> popover, sparkline, codec,
// copy diagnostics, alerts, settings -> off removes everything and stops statistics requests.
export default async function (ctx) {
  const HUD = '[data-ts6mod="net"][data-net="hud"]', POP = '[data-ts6mod="net"][data-net="pop"]';
  const reqs = () => ctx.eval('window.__ts6modNetRequests');

  await ctx.disable('net');
  await ctx.assertClean('net');
  const r0 = await reqs(); await ctx.sleep(2500);
  ctx.equal(await reqs(), r0, 'no statistics requests while off');

  const connected = await ctx.eval(`__ts6mod.anchors.check().every(a => a.name !== 'net.ownClientId' || a.ok)`);
  ctx.assert(connected, 'net anchors resolve');

  await ctx.enable('net');
  const online = await ctx.eval(`!!document.querySelector('${HUD}') && !document.querySelector('${HUD}').hidden`);
  if (!online) {
    ctx.log('SKIP live part: client is not connected to a server (HUD hidden, no requests expected)');
    const a = await reqs(); await ctx.sleep(2200);
    ctx.equal(await reqs(), a, 'no requests without a connection');
  } else {
    // live numbers that update
    await ctx.waitFor(`/\\d+ ms/.test(document.querySelector('${HUD}').textContent) && /↓\\d+\\.\\d%.*↑\\d+\\.\\d%/.test(document.querySelector('${HUD}').textContent)`, 'HUD shows ping (ms) and loss (%)');
    const u1 = +(await ctx.eval(`document.querySelector('${HUD}').getAttribute('data-updates')`));
    await ctx.waitFor(`+document.querySelector('${HUD}').getAttribute('data-updates') > ${u1}`, 'HUD updates over time', 6000);
    ctx.assert(/↓/.test(await ctx.eval(`document.querySelector('${HUD}').textContent`)), 'bandwidth shown by default');

    // placement: bottom bar by default, first item of the stock connection-status group, no overlap with its neighbours
    const geo = () => ctx.eval(`(() => { const h = document.querySelector('${HUD}'), g = h && h.parentElement, bar = g && g.parentElement;
      const R = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom }; };
      // the other visible bar items (the Create Channel group when shown; not the spacer, not the invisible measuring copy)
      const others = bar ? [...bar.children].filter(c => c !== g && c.getClientRects().length && getComputedStyle(c).visibility !== 'hidden' && c.getBoundingClientRect().width > 4 && !/flex-grow/.test(c.className)) : [];
      const left = others.map(R).sort((a, b) => b.r - a.r)[0] || null;
      const sib = h && h.nextElementSibling, vp = h && h.querySelector('.net-ping'), vl = vp && R(vp);
      return { inBottom: !!(bar && /status-bar/.test(bar.className)), first: !!g && g.firstElementChild === h, h: h && R(h), bar: bar && R(bar), sib: sib && R(sib), left,
        ping: !!vl && vl.b <= R(h).b + 1 && vl.r <= R(h).r + 1 }; })()`);
    const okGeo = (p, tag) => {
      ctx.assert(p.inBottom && p.first, `${tag}: HUD is the first item of the bottom bar's connection-status group`);
      ctx.assert(!p.sib || p.h.r <= p.sib.l + 1, `${tag}: HUD does not overlap the stock connection status (${Math.round(p.h.r)} <= ${p.sib && Math.round(p.sib.l)})`);
      ctx.assert(!p.left || p.left.r <= p.h.l + 1, `${tag}: HUD does not overlap the Create Channel button (${p.left && Math.round(p.left.r)} <= ${Math.round(p.h.l)})`);
      ctx.assert(p.h.r <= p.bar.r + 1 && p.h.l >= p.bar.l - 1, `${tag}: HUD inside the bar`);
      ctx.assert(p.ping, `${tag}: ping readout visible inside the HUD`);
    };
    okGeo(await geo(), 'wide');
    if (await ctx.eval(`!!window.__ts6modLayoutDev`)) {   // pane width helper of the layout core extension (works with the layout mod off)
      const was = await ctx.eval(`__ts6modLayoutDev.paneWidth(200)`);   // clamped to the minimum by the client
      try { await ctx.sleep(1200); okGeo(await geo(), 'narrow pane'); } finally { await ctx.eval(`__ts6modLayoutDev.paneWidth(${was})`); }
      await ctx.sleep(600);
    }
    // top bar position (setting) moves it live, and back (the pills write the setting; the original settings object is put back)
    const origNet = await ctx.eval(`JSON.stringify(__ts6mod.store().settings.net ?? null)`);
    await ctx.openModsPage('net');
    await ctx.waitFor(`document.querySelector('[data-ts6mod="net"] [data-pos="top"]')`, 'Position pills on the Net page');
    await ctx.eval(`document.querySelector('[data-ts6mod="net"] [data-pos="top"]').click()`);
    await ctx.restoreRoute();
    await ctx.waitFor(`!document.querySelector('${HUD}').closest('[class*="status-bar"]')`, 'Position "Top bar" moves the HUD out of the bottom bar');
    await ctx.openModsPage('net');
    await ctx.eval(`document.querySelector('[data-ts6mod="net"] [data-pos="bottom"]').click()`);
    await ctx.restoreRoute();
    await ctx.waitFor(`!!document.querySelector('${HUD}').closest('[class*="status-bar"]')`, 'Position "Bottom bar" puts it back');
    await ctx.eval(`(() => { const s = __ts6mod.store().settings, o = ${JSON.stringify(origNet)}; if (o === 'null') delete s.net; else s.net = JSON.parse(o); })()`);

    // popover: graph, stats, codec
    await ctx.eval(`document.querySelector('${HUD}').click()`);
    await ctx.waitFor(`!document.querySelector('${POP}').hidden`, 'popover opens on click');
    await ctx.waitFor(`!!document.querySelector('${POP} svg .net-ping-line, ${POP} svg .net-ping-dot')`, 'sparkline drawn');
    await ctx.waitFor(`/Codec\\s*\\S/.test(document.querySelector('${POP}').textContent) && !/Codec-/.test(document.querySelector('${POP}').textContent)`, 'codec readout filled');
    const rect = await ctx.eval(`(() => { const r = document.querySelector('${POP}').getBoundingClientRect(); return r.width > 100 && r.left >= 0 && r.right <= innerWidth && r.top >= 0 })()`);
    ctx.assert(rect, 'popover is placed on screen');

    // copy diagnostics (clipboard write needs a focused document; the button reports the outcome)
    await ctx.eval(`[...document.querySelectorAll('${POP} button')].find(b => /Copy diagnostics/.test(b.textContent)).click()`);
    await ctx.waitFor(`document.querySelector('${POP} button[data-copied]')`, 'copy outcome shown');
    const ok = await ctx.eval(`document.querySelector('${POP} button[data-copied]').getAttribute('data-copied')`);
    if (ok === 'ok') {
      const text = await ctx.eval(`navigator.clipboard.readText().catch(() => '')`);
      if (text) ctx.assert(/Ping ms/.test(text) && /Client:/.test(text) && /Channel codec/.test(text), 'clipboard holds the diagnostics block');
    } else ctx.log('clipboard write refused in this environment (copy button reported failure)');

    await ctx.pressEscape();
    await ctx.waitFor(`document.querySelector('${POP}').hidden`, 'Escape closes the popover');

    // alerts: a limit below any real value must fire exactly one toast (cooldown) after two samples
    const toasts = () => ctx.eval(`(__ts6mod.ledger('net') || {}).toast || 0`);
    ctx.equal(await toasts(), 0, 'no alert toast with alerts off (default)');
    await ctx.eval(`__ts6mod.store().settings.net = { alert: true, pingMax: -1, lossMax: 1000, interval: 1 }`);
    await ctx.waitFor(`(__ts6mod.ledger('net') || {}).toast >= 1`, 'alert toast fires when the ping limit is exceeded', 8000);
    await ctx.sleep(3500);
    ctx.equal(await toasts(), 1, 'alert does not repeat within the cooldown');
    await ctx.eval(`delete __ts6mod.store().settings.net`);
  }

  await ctx.openModsPage('net');
  await ctx.waitFor(`/Update interval/.test(document.body.textContent) && /Show bandwidth/.test(document.body.textContent)`, 'settings listed on the Mods page');
  if (online) {
    // the bandwidth switch of the settings area hides/shows the bandwidth part of the HUD live (clicked twice: value restored)
    const clickBw = () => ctx.eval(`(() => { let n = [...document.querySelectorAll('*')].filter(x => !x.children.length && /Show bandwidth/.test(x.textContent)).pop(); while (n && !n.querySelector('input[type=checkbox]')) n = n.parentElement; const i = n.querySelector('input[type=checkbox]'); i.parentElement.parentElement.click(); })()`);
    await clickBw();
    await ctx.waitFor(`document.querySelector('${HUD} .net-bw').hidden`, 'bandwidth hidden after switching it off');
    await clickBw();
    await ctx.waitFor(`!document.querySelector('${HUD} .net-bw').hidden`, 'bandwidth shown again after switching it on');
  }
  await ctx.restoreRoute();

  await ctx.disable('net');
  await ctx.waitFor(`!document.querySelector('${HUD}') && !document.querySelector('${POP}')`, 'HUD and popover removed on disable');
  await ctx.assertClean('net');
  const b = await reqs(); await ctx.sleep(2500);
  ctx.equal(await reqs(), b, 'no statistics requests after disable');
}

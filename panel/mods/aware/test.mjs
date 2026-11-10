// aware mod test. Needs the shared local test server. The join/leave feed part needs a SECOND plain client on CDP port
// $AWARE_P2_CDP (default 9263), already running (it is connected and disconnected by this test); without it that part is skipped.
// Channels "aware-a"/"aware-b" are created through serverquery (creds file $AWARE_QUERY_CREDS, default $HOME/tmp/ts6-modsrv/creds.env)
// when missing. The feed part (second client, serverquery) runs ONLY on the local test server (ctx.onTestServer()); a second client that
// was connected before is connected again afterwards (same nickname), so later tests still find it. Elsewhere the test is read-only:
// talk events are simulated locally; the idle probe sends requestConnectionInfo (a read-only query the client also sends for its own
// client-info view). Test procedure: superdoc/features/mod-aware.md.
import { connect } from '../../../tools/cdp/cdp.mjs';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';

const BADGE = '[data-ts6mod="aware"].aware-badge';
const requests = ctx => ctx.eval('__ts6modBoot.aware.stats.requests');
const entries = ctx => ctx.eval('window.__awProbe.entries()');

function query(cmds) {   // raw serverquery, one connection, resolves with the whole reply text
  const env = Object.fromEntries(readFileSync(process.env.AWARE_QUERY_CREDS || `${process.env.HOME}/tmp/ts6-modsrv/creds.env`, 'utf8').split('\n').filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));
  return new Promise((res, rej) => {
    const s = createConnection(10112, '127.0.0.1'); let buf = '';
    s.on('data', d => { buf += d; }); s.on('error', rej);
    s.on('connect', () => { const lines = [`login serveradmin ${env.SERVERADMIN_PASSWORD}`, 'use 1', ...cmds, 'quit']; let i = 0; const t = setInterval(() => { if (i < lines.length) s.write(lines[i++] + '\n'); else clearInterval(t); }, 150); });
    s.on('close', () => res(buf));
  });
}

export default async function (ctx) {
  const set = o => ctx.eval(`(__ts6mod.store().settings.aware = ${JSON.stringify(o)}, 1)`);   // in-memory settings, never saved
  const cleanupSettings = () => ctx.eval('(delete __ts6mod.store().settings.aware, 1)');
  let p2 = null, p2Restore = null;
  const p2e = async x => { try { return await p2.eval(x); } catch (e) { throw new Error(`second client: ${e.message} (in: ${x.slice(0, 60)})`); } };
  try {
    await ctx.disable('aware');
    if (!(await ctx.eval(`__ts6mod.anchors.tree.rows('channel').length`))) { await ctx.eval('__ts6mod.showOwnChannelChat()'); }   // a view with the channel tree
    await ctx.waitFor(`__ts6mod.anchors.tree.rows('channel').length > 0`, 'channel tree is displayed', 8000);
    ctx.equal(await ctx.eval(`document.querySelectorAll('[data-ts6mod="aware"]').length`), 0, 'no mod DOM while the mod is off');
    const R0 = await requests(ctx);

    /* ---- mod on, idle probe OFF (default): zero bridge requests however long we wait ---- */
    await set({ idleInterval: 1, fade: 2 });
    await ctx.enable('aware');
    await ctx.eval(`ts6mod.register({id: 't-aware-probe', title: 'probe', enable(api) { window.__awProbe = api.ext.aware; window.__awApi = api; }})`);
    await ctx.enable('t-aware-probe');
    ctx.assert(await ctx.eval('!!window.__awProbe'), 'extension "aware" is available');
    await ctx.sleep(3500);
    ctx.equal(await requests(ctx), R0, 'idle probe off: no requestConnectionInfo calls with the mod on');

    /* ---- activity badges: talking count, then a fading "recent" dot ---- */
    // another client whose channel row is rendered right now (the tree is a virtual list: off-screen rows carry no badge)
    const shown = await ctx.eval(`__ts6mod.anchors.tree.rows('channel').map(r => String(r.model.id))`);
    const info = (await ctx.eval(`__awApi.state.clients({all: true}).filter(c => !c.self).map(c => ({id: c.id, ch: c.channelId}))`)).filter(c => shown.includes(String(c.ch)));
    if (!info.length) ctx.skip('activity badges', 'no other client in a channel whose row is on screen');
    else {
    const c1 = info[0].id;
    const rowsOf = () => ctx.eval(`[...document.querySelectorAll('${BADGE}')].map(b => b.className + '|' + b.textContent)`);
    const before = (await rowsOf()).filter(x => x.includes('talking')).length;   // real talkers may exist on the shared server
    await ctx.eval(`__ts6modBoot.aware.talk(${c1}, 1)`);
    await ctx.waitFor(`document.querySelector('${BADGE}.talking')`, 'a talking badge appears on a channel row after a talk-start');
    ctx.assert((await rowsOf()).filter(x => x.includes('talking')).length >= Math.max(1, before), 'talking badge present');
    // survives re-rendering of the rows (collapse / expand recycles them)
    await ctx.eval('__ts6modBoot.aware.setCollapsed(true)'); await ctx.sleep(400);
    await ctx.eval('__ts6modBoot.aware.setCollapsed(false)');
    await ctx.waitFor(`document.querySelector('${BADGE}.talking')`, 'badge comes back after the rows were re-rendered');
    await ctx.eval(`__ts6modBoot.aware.talk(${c1}, 0)`);
    // other workers' real talkers share the server, so judge only this channel's row: after the stop it shows a recent dot (or still
    // a talking badge when a real talker is there too) and the dot's opacity falls below 1 within the fade time
    const ROW = `.mods-deco[data-mid="channel:${info[0].ch}"] .aware-badge`;
    await ctx.waitFor(`document.querySelector('${ROW}')`, 'this channel keeps a badge after the talk stopped');
    await ctx.sleep(1300);
    ctx.assert(await ctx.eval(`(() => { const b = document.querySelector('${ROW}'); return !b || b.classList.contains('talking') || +b.style.opacity < 0.95; })()`), 'recent dot fades (opacity falls) or is gone');
    }

    /* ---- idle probe ON: one request per tick, only for clients in expanded channels ---- */
    await set({ idle: true, idleInterval: 1, idleMin: 0, fade: 2 });
    await ctx.eval('window.__awProbe.apply()');
    const R1 = await requests(ctx);
    await ctx.sleep(3600);
    const R2 = await requests(ctx);
    ctx.assert(R2 - R1 >= 2 && R2 - R1 <= 5, `throttled: ${R2 - R1} requests in 3.6 s with a 1 s interval`);
    await ctx.waitFor(`document.querySelector('[data-ts6mod="aware"].aware-idle')`, 'an idle label shows for polled users', 4000);
    await ctx.eval('__ts6modBoot.aware.setCollapsed(true)'); await ctx.sleep(1200);
    const R3 = await requests(ctx); await ctx.sleep(2500);
    ctx.equal(await requests(ctx), R3, 'all channels collapsed: no requests (expanded channels only)');
    await ctx.eval('__ts6modBoot.aware.setCollapsed(false)');
    await set({ idle: false, idleInterval: 1, fade: 2 });
    await ctx.eval('window.__awProbe.apply()');
    await ctx.sleep(300);
    const R4 = await requests(ctx); await ctx.sleep(2500);
    ctx.equal(await requests(ctx), R4, 'idle probe switched off again: requests stop');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.aware-idle').length`), 0, 'idle labels removed with the probe');

    /* ---- join / leave feed with a second client ---- */
    const local = await ctx.onTestServer();
    if (local) { try { p2 = await connect(+(process.env.AWARE_P2_CDP || 9263)); } catch (e) { p2 = null; } }
    if (!local) ctx.skip('join/leave feed', 'drives a second client and serverquery: local test server only');
    else if (!p2) ctx.skip('join/leave feed', 'no second client on CDP ' + (process.env.AWARE_P2_CDP || 9263));
    else {
      const drv = await ctx.eval('__ts6modBoot.aware.p2Driver');
      await p2e(drv);
      const was = await p2e('window.__awareP2.status()');
      if (was) { p2Restore = was.nick; await p2e("window.__awareP2.disconnect()"); await ctx.sleep(5000); }
      const nick = 'AwT' + Math.floor(Math.random() * 1e4);
      const n0 = (await entries(ctx)).length;
      await p2e(`window.__awareP2.connect(${JSON.stringify(nick)}, 9990)`);
      const t0 = Date.now(); let st = null;
      while (Date.now() - t0 < 20000 && !(st = await p2e('window.__awareP2.status()'))) await ctx.sleep(500);
      ctx.assert(st, 'second client connected');
      let chans = await p2e('window.__awareP2.channels()');
      if (!chans.some(c => c.name === 'aware-a') || !chans.some(c => c.name === 'aware-b')) {
        await query(['channelcreate channel_name=aware-a channel_flag_permanent=1', 'channelcreate channel_name=aware-b channel_flag_permanent=1']); await ctx.sleep(1500);
        chans = await p2e('window.__awareP2.channels()');
      }
      const A = chans.find(c => c.name === 'aware-a'), B = chans.find(c => c.name === 'aware-b');
      ctx.assert(A && B, 'channels aware-a / aware-b exist');
      await ctx.waitFor(`window.__awProbe.entries().some(e => e.nick === ${JSON.stringify(nick)} && e.kind === 'join')`, 'feed shows the join', 6000);
      await p2e(`window.__awareP2.move('${A.id}')`);
      await ctx.waitFor(`window.__awProbe.entries().some(e => e.nick === ${JSON.stringify(nick)} && e.kind === 'move' && e.to === 'aware-a')`, 'feed shows the move into aware-a', 6000);
      await p2e(`window.__awareP2.move('${B.id}')`);
      await ctx.waitFor(`window.__awProbe.entries().some(e => e.nick === ${JSON.stringify(nick)} && e.kind === 'move' && e.from === 'aware-a' && e.to === 'aware-b')`, 'feed shows the move aware-a -> aware-b', 6000);
      await p2e('window.__awareP2.disconnect()');
      await ctx.waitFor(`window.__awProbe.entries().some(e => e.nick === ${JSON.stringify(nick)} && e.kind === 'disconnect')`, 'feed shows the disconnect', 8000);
      const mine = (await entries(ctx)).filter(e => e.nick === nick).map(e => e.kind + ':' + (e.from || '') + '>' + (e.to || ''));
      ctx.log('feed entries: ' + mine.join(' | '));
      ctx.assert((await entries(ctx)).length - n0 >= 4, 'at least four new entries (join, 2 x move, disconnect)');
      // the panel lists them
      ctx.assert(await ctx.eval('window.__awProbe.togglePanel()'), 'feed panel can be opened');
      await ctx.waitFor(`[...document.querySelectorAll('.aware-pop .aware-entry')].some(e => e.textContent.includes(${JSON.stringify(nick)}))`, 'panel lists the entries');
      await ctx.pressEscape();
      await ctx.waitFor(`!document.querySelector('.aware-pop')`, 'Escape closes the panel');
    }

    /* ---- off: nothing left, no requests ---- */
    await set({ idle: true, idleInterval: 1, idleMin: 0 });
    await ctx.eval('window.__awProbe.apply()');
    await ctx.sleep(1500);
    await ctx.disable('t-aware-probe');
    await ctx.disable('aware');
    await ctx.assertClean('aware');
    const R5 = await requests(ctx); await ctx.sleep(2500);
    ctx.equal(await requests(ctx), R5, 'mod off (even with the idle probe configured on): no requests');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.aware-pop, .aware-badge, .aware-idle').length`), 0, 'no badges / popup / idle labels left');
  } finally {
    if (p2) {
      try { await p2e('window.__awareP2 && window.__awareP2.disconnect()'); } catch (e) { /* gone */ }
      if (p2Restore) {   // the second client was connected before this test: connect it again for the tests that follow
        try {
          await ctx.sleep(2500); await p2e(`window.__awareP2.connect(${JSON.stringify(p2Restore)}, 9990)`);
          for (let i = 0; i < 40 && !(await p2e('window.__awareP2.status()')); i++) await ctx.sleep(500);
        } catch (e) { ctx.log('could not reconnect the second client: ' + e.message); }
      }
      p2.close();
    }
    await ctx.eval(`(window.__ts6modBoot && __ts6modBoot.aware.setCollapsed(false), __ts6mod.unregister && __ts6mod.unregister('t-aware-probe'), delete window.__awProbe, 1)`).catch(() => {});
    await cleanupSettings().catch(() => {});
  }
}

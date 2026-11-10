// aware mod test. Needs the shared local test server. The join/leave feed part needs a SECOND plain client on CDP port
// $AWARE_P2_CDP (default 9263), already running (it is connected and disconnected by this test); without it that part is skipped.
// Channels "aware-a"/"aware-b" are created through serverquery (creds file $AWARE_QUERY_CREDS, default $HOME/tmp/ts6-modsrv/creds.env)
// when missing. The feed part (second client, serverquery) runs ONLY on the local test server (ctx.onTestServer()); a second client that
// was connected before is connected again afterwards (same nickname), so later tests still find it. Elsewhere the test is read-only:
// the talk circles and the idle probe send requestConnectionInfo (a read-only query the client also sends for its own client-info view).
// The talk-circle check with a real other-channel talker (the second client sends a few channel messages in aware-b, which resets its
// idle time) also runs only there; elsewhere marks are only checked passively. Test procedure: superdoc/features/mod-aware.md.
import { connect } from '../../../tools/cdp/cdp.mjs';
import { createConnection } from 'node:net';
import { readFileSync } from 'node:fs';

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

    /* ---- mod on, talk circles and idle probe OFF: zero bridge requests however long we wait ---- */
    await set({ talk: false, idleInterval: 1 });
    await ctx.enable('aware');
    await ctx.eval(`ts6mod.register({id: 't-aware-probe', title: 'probe', enable(api) { window.__awProbe = api.ext.aware; window.__awApi = api; }})`);
    await ctx.enable('t-aware-probe');
    ctx.assert(await ctx.eval('!!window.__awProbe'), 'extension "aware" is available');
    await ctx.sleep(3500);
    ctx.equal(await requests(ctx), R0, 'talk circles and idle probe off: no requestConnectionInfo calls with the mod on');

    /* ---- talk circles on (passive part, any server): one request per tick, marks only on other channels' rows the client has no
     * talk status for, and no channel badges any more ---- */
    await set({ talk: true, idleInterval: 1 });
    await ctx.eval('window.__awProbe.apply()');
    const T1 = await requests(ctx); await ctx.sleep(3600);
    const T2 = await requests(ctx);
    const others = await ctx.eval(`__ts6modBoot.aware.marks().length + 0`);
    ctx.assert(T2 - T1 <= 5, `talk circles: throttled to ${T2 - T1} requests in 3.6 s with a 1 s interval`);
    const bad = (await ctx.eval('__ts6modBoot.aware.marks()')).filter(m => m.stock || m.mine || m.id == null);
    ctx.equal(bad.length, 0, `marks only on other channels' rows the client has no talk status for (${others} marked now)`);
    ctx.equal(await ctx.eval(`document.querySelectorAll('.aware-badge, [data-ts6mod="aware"].mods-deco[data-mid^="channel:"]').length`), 0, 'no badge on channel rows');
    await set({ talk: false, idleInterval: 1 });
    await ctx.eval('window.__awProbe.apply()');
    await ctx.sleep(300);
    ctx.equal(await ctx.eval('__ts6modBoot.aware.marks().length'), 0, 'talk circles off: no marks left');
    const T3 = await requests(ctx); await ctx.sleep(2500);
    ctx.equal(await requests(ctx), T3, 'talk circles off: requests stop');

    /* ---- idle probe ON: one request per tick, only for clients in expanded channels ---- */
    await set({ talk: false, idle: true, idleInterval: 1, idleMin: 0 });
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
    await set({ talk: false, idle: false, idleInterval: 1 });
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
      await p2e('window.__awareP2.quiet()');   // never the real microphone / speakers on a test client
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

      /* talk circle of a real other-channel client: second client in aware-b (mic and speakers off); its channel messages reset its idle time */
      const myCh = String(await ctx.eval('__awApi.state.clients({all: true}).find(c => c.self).channelId'));
      if (myCh === String(B.id)) ctx.skip('talk circle', 'this client sits in aware-b itself');
      else {
        await set({ talk: true, idle: false, idleInterval: 1 });
        await ctx.eval('window.__awProbe.apply()');
        await ctx.waitFor(`__ts6modBoot.aware.circle(${st.id}) !== null`, "second client's row is on screen", 6000);
        await ctx.waitFor(`(c => c && !c.talking)(__ts6modBoot.aware.circle(${st.id}))`, 'idle second client: talk circle normal', 10000);
        let lit = null;
        for (let i = 0; i < 12 && !lit; i++) {   // stay active (one message per second, at most 12: below the server's flood limit) until a poll catches it at idle 0 s
          await p2e(`window.__awareP2.say('aware test ${i}')`); await ctx.sleep(1000);
          lit = await ctx.eval(`(c => c && c.talking && c.marked && !c.stock ? c : null)(__ts6modBoot.aware.circle(${st.id}))`);
        }
        ctx.assert(lit, "active second client in another channel: its talk circle shows talking (stock class + our mark)");
        ctx.equal((await ctx.eval('__ts6modBoot.aware.marks()')).filter(m => m.stock || m.mine).length, 0, 'own channel / stock-talking rows never marked');
        await ctx.waitFor(`(c => c && !c.talking && !c.marked)(__ts6modBoot.aware.circle(${st.id}))`, 'quiet again (idle > 0 s): talk circle back to normal', 10000);
        await set({ talk: false, idle: false, idleInterval: 1 });
        await ctx.eval('window.__awProbe.apply()');
        await ctx.sleep(300);
        ctx.equal(await ctx.eval('__ts6modBoot.aware.marks().length'), 0, 'talk circles off: no marks left');
      }

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
    await set({ talk: true, idle: true, idleInterval: 1, idleMin: 0 });
    await ctx.eval('window.__awProbe.apply()');
    await ctx.sleep(1500);
    await ctx.disable('t-aware-probe');
    await ctx.disable('aware');
    await ctx.assertClean('aware');
    const R5 = await requests(ctx); await ctx.sleep(2500);
    ctx.equal(await requests(ctx), R5, 'mod off (even with talk circles and idle probe configured on): no requests');
    ctx.equal(await ctx.eval(`document.querySelectorAll('.aware-pop, .aware-badge, .aware-idle').length`), 0, 'no popup / idle labels left');
    ctx.equal(await ctx.eval('__ts6modBoot.aware.marks().length'), 0, 'no talk circle marks left');
  } finally {
    if (p2) {
      try { await p2e('window.__awareP2 && window.__awareP2.disconnect()'); } catch (e) { /* gone */ }
      if (p2Restore) {   // the second client was connected before this test: connect it again for the tests that follow
        try {
          await ctx.sleep(2500); await p2e(`window.__awareP2.connect(${JSON.stringify(p2Restore)}, 9990)`);
          for (let i = 0; i < 40 && !(await p2e('window.__awareP2.status()')); i++) await ctx.sleep(500);
          await p2e('window.__awareP2.quiet()');
        } catch (e) { ctx.log('could not reconnect the second client: ' + e.message); }
      }
      p2.close();
    }
    await ctx.eval(`(window.__ts6modBoot && __ts6modBoot.aware.setCollapsed(false), __ts6mod.unregister && __ts6mod.unregister('t-aware-probe'), delete window.__awProbe, 1)`).catch(() => {});
    await cleanupSettings().catch(() => {});
  }
}

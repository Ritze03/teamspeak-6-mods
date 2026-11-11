// Audio mod: the AGC page (AGC dropdown, mode, every parameter, built-in/custom presets), the vanilla rule (mod off = native AGC
// off), the per-user popover (volume/mute/boost/AGC override, saved per UID, pushed to the native module) and cleanup.
// Safe on a real client: the per-user part (it mutes a user locally, which TeamSpeak sends to the server as a client mute request) runs
// ONLY on the local test server (ctx.onTestServer()); the native master switch stays OFF while modes/overrides are edited (so the
// per-speaker hook is never installed by this test); every native value, user record, preset and local mute is restored.
// The per-user part is skipped when nobody else is connected; the native part when the control API is unreachable.
export default async function (ctx) {
  const BODY = 'div[data-ts6mod="audio"]:not(.aud-pop)', POP = '.aud-pop';
  const base = `http://127.0.0.1:${ctx.controlPort}`;
  const nat = async (path, body) => (await fetch(base + path, body ? { method: 'POST', body: JSON.stringify(body) } : {})).json();
  let nativeUp = false;
  try { nativeUp = (await fetch(base + '/status')).ok; } catch (e) { ctx.log('native control API not reachable on port ' + ctx.controlPort + ' (UI part only)'); }
  const reqs = () => ctx.eval(`__ts6mod.trace().nativeRequests`);
  const modOn = () => ctx.eval(`__ts6mod.list().find(m => m.id === 'audio').enabled`);
  const near = (a, b) => Math.abs(a - b) < 0.06;
  // the page (or its tab) may still be rendering / re-rendering after a state change: wait for the node instead of failing at once
  const click = async sel => { await ctx.waitFor(`!!document.querySelector(${JSON.stringify(sel)})`, 'present: ' + sel, 8000); return click0(sel); };
  const click0 = sel => ctx.eval(`(() => { const n = document.querySelector(${JSON.stringify(sel)}); if (!n) throw new Error('missing ' + ${JSON.stringify(sel)}); n.click(); return 1; })()`);
  const clickText = (scope, text) => ctx.eval(`(() => { const n = [...document.querySelectorAll(${JSON.stringify(scope + ' label, ' + scope + ' button')})].find(x => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!n) throw new Error('missing ' + ${JSON.stringify(text)}); n.click(); return 1; })()`);
  const setNum = (scope, key, v) => ctx.eval(`(() => { const i = document.querySelector(${JSON.stringify(scope + ' [data-key="' + key + '"] input[type=number]')}); if (!i) throw new Error('no field ' + ${JSON.stringify(key)}); i.value = ${v}; i.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`);
  const store = () => ctx.eval(`JSON.parse(JSON.stringify(__ts6mod.store().settings.audio || null))`);

  // ---- snapshot everything the test may change
  const wasOn = await modOn(), snap = await store(), cfg0 = nativeUp ? await nat('/config') : null;
  const wasEnabledStore = await ctx.eval(`!!__ts6mod.store().enabled.audio`);
  const restore = async () => {
    if (await modOn()) await ctx.disable('audio');
    if (nativeUp) await nat('/config', cfg0);   // transient: the next enable adopts/restores the user's master switch from it
    await ctx.eval(`(() => { const s = __ts6mod.store(); const snap = ${JSON.stringify(snap)}; if (snap) s.settings.audio = snap; else delete s.settings.audio; return 1; })()`);
    // persist the restored settings (setEnabled writes the whole blob) without changing the saved switch, then put the in-memory switch back
    await ctx.eval(`__ts6mod.setEnabled('audio', ${wasEnabledStore}, { persist: true }).then(() => 1)`);
    await ctx.eval(`__ts6mod.setEnabled('audio', ${wasOn}, { persist: false }).then(() => 1)`);
    if (nativeUp && !wasOn) await nat('/config', { enabled: false });
  };

  try {
    await ctx.disable('audio');   // start from "off" whatever the user has switched on
    if (nativeUp) {
      const st = await nat('/status');
      ctx.assert(st.enabled === false && st.mode === 'passthrough', 'vanilla rule: mod off -> native AGC off / passthrough');
      if (st.per_speaker) ctx.assert(st.per_speaker.added_latency_ms === 0, 'mod off -> no added latency');
    }
    await ctx.enable('audio');
    if (nativeUp) await nat('/config', { enabled: false });   // keep the master off while editing (no per-speaker hook install on a real client)
    ctx.equal(await ctx.eval(`document.querySelectorAll('${BODY}').length`), 0, 'no settings DOM until the Mods page is open');
    await ctx.openModsPage('audio', 'Parameters');
    await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 1`, 'audio area on the Mods page');
    ctx.assert(await ctx.eval(`!!document.querySelector('${BODY} select[data-act="agc"]')`), 'AGC dropdown is listed');

    if (nativeUp) {
      await ctx.waitFor(`!!document.querySelector('${BODY} [data-key="target_db"]') && !document.querySelector('${BODY} [data-key="target_db"]').closest('[hidden]')`, 'AGC controls shown');
      const a = await reqs(); await ctx.sleep(700);
      ctx.assert(await reqs() > a, 'meters/status are polled while the page is shown');

      // AGC dropdown (whole mode: the hook is not involved), through the real select
      await nat('/config', { mode: 'whole' });
      await ctx.openModsPage('audio', 'Processing');
      await ctx.waitFor(`document.querySelector('${BODY}') && /Whole stream/.test(document.querySelector('${BODY}').textContent)`, 'page up');
      const pickAgc = async v => { await ctx.eval(`(() => { const s = document.querySelector('${BODY} select[data-act="agc"]'); s.value = ${JSON.stringify(v)}; s.dispatchEvent(new Event('change', { bubbles: true })); return 1; })()`); await ctx.sleep(500); };
      await pickAgc('ts6mods');
      ctx.equal((await nat('/config')).enabled, true, 'dropdown TS6Mods -> native enabled');
      ctx.equal((await store()).agcMode, 'ts6mods', 'AGC choice remembered');
      await pickAgc('vanilla');
      ctx.equal((await nat('/config')).enabled, false, 'dropdown Vanilla -> native disabled');
      ctx.equal((await store()).agcMode, 'vanilla', 'AGC choice remembered (Vanilla)');
      // stock keys (only when the client has a settings model, i.e. is connected): TS6Mods = both off, Vanilla = agc on, Experimental = both on; mod off restores the originals
      const stk = () => ctx.eval(`JSON.parse(JSON.stringify(__ts6mod.mods().get('audio').api.stockAgc.read()))`);
      if (await stk()) {
        await pickAgc('ts6mods'); let k = await stk(); ctx.assert(!k.agc && !k.experimental, 'TS6Mods -> stock AGC and experimental off');
        await pickAgc('vanilla'); k = await stk(); ctx.assert(k.agc && !k.experimental, 'Vanilla -> stock AGC on, experimental off');
        await pickAgc('experimental'); k = await stk(); ctx.assert(k.agc && k.experimental, 'Vanilla (Experimental) -> stock AGC and experimental on');
        ctx.equal((await nat('/config')).enabled, false, 'Vanilla (Experimental) -> native disabled');
        const orig = (await store()).stockOrig; ctx.assert(!!orig, 'pre-mod stock values remembered');
        await ctx.disable('audio'); await ctx.sleep(500); k = await stk();
        ctx.equal(k.agc, !!orig.agc[k.device], 'mod off restores the stock AGC value of the device');
        if (orig.exp !== undefined) ctx.equal(k.experimental, !!orig.exp, 'mod off restores the experimental flag');
        await ctx.enable('audio'); await nat('/config', { enabled: false });
        await ctx.openModsPage('audio', 'Processing');
        await pickAgc('vanilla');
      }

      // mode
      await clickText(BODY, 'Per speaker'); await ctx.sleep(500);
      ctx.equal((await nat('/config')).mode, 'per_speaker', 'mode per speaker set');
      await ctx.openModsPage('audio', 'Parameters');
      await ctx.waitFor(`document.querySelector('${BODY} .aud-speakers').closest('[hidden]') === null`, 'speaker list shown in per-speaker mode');
      await ctx.openModsPage('audio', 'Processing');
      await clickText(BODY, 'Whole stream'); await ctx.sleep(500);
      ctx.equal((await nat('/config')).mode, 'whole', 'mode whole set');
      await ctx.openModsPage('audio', 'Parameters');

      // compressor switch: off by default, locks its sliders (still visible), on unlocks them
      const compState = () => ctx.eval(`(() => { const b = document.querySelector('${BODY} [data-key="comp_enabled"]'); const f = document.querySelector('${BODY} .aud-param[data-key="ratio"]'); return { on: !!b.querySelector('input').checked, locked: f.classList.contains('mods-disabled') && f.querySelector('input').disabled, shown: f.offsetParent !== null }; })()`);
      await nat('/config', { comp_enabled: false }); await ctx.sleep(400);
      let cs = await compState();
      ctx.assert(!cs.on && cs.locked && cs.shown, 'compressor off: switch off, sliders locked but visible');
      await click(`${BODY} [data-key="comp_enabled"] .visible`); await ctx.sleep(500);
      ctx.equal((await nat('/config')).comp_enabled, true, 'compressor switch on -> native comp_enabled');
      cs = await compState();
      ctx.assert(cs.on && !cs.locked, 'compressor on: sliders unlocked');
      await click(`${BODY} [data-key="comp_enabled"] .visible`); await ctx.sleep(500);
      ctx.equal((await nat('/config')).comp_enabled, false, 'compressor switch off again');

      // every parameter through its number field
      await nat('/config', { comp_enabled: true }); await ctx.sleep(400);
      const defs = await ctx.eval(`[...document.querySelectorAll('${BODY} .aud-param')].map(p => { const r = p.querySelector('input[type=range]'); return { key: p.dataset.key, min: +r.min, max: +r.max, step: +r.step }; })`);
      ctx.equal(defs.length, 11, 'eleven parameter fields');
      for (const d of defs) {
        const cur = (await nat('/config'))[d.key];
        const snapTo = f => { const v = d.min + Math.round((d.max - d.min) * f / d.step) * d.step; return Math.round(v * 100) / 100; };
        let v = snapTo(0.3); if (near(v, cur)) v = snapTo(0.7);
        await setNum(BODY, d.key, v);
        await ctx.sleep(350);
        const got = (await nat('/config'))[d.key];
        ctx.assert(near(got, v), `parameter ${d.key}: set ${v}, native has ${got}`);
      }

      // built-in presets: values and "modified"
      await ctx.openModsPage('audio', 'Presets');
      const modified = () => ctx.eval(`!document.querySelector('${BODY} .aud-modified').hidden`);
      for (const key of ['voice', 'music', 'quiet']) {
        await click(`${BODY} [data-preset="${key}"]`); await ctx.sleep(500);
        const c = await nat('/config');
        ctx.equal(c.preset, key, `preset ${key} selected natively`);
        ctx.assert(!(await modified()), `preset ${key}: not modified right after applying`);
        ctx.equal(c.comp_enabled, false, `preset ${key}: compressor off`);
        if (key === 'voice') ctx.assert(near(c.target_db, -20) && near(c.ratio, 3) && near(c.ceiling_db, -1), 'voice values applied');
        if (key === 'music') ctx.assert(near(c.target_db, -18) && near(c.ratio, 2) && near(c.release_ms, 400), 'music values applied');
        if (key === 'quiet') ctx.assert(near(c.target_db, -26) && near(c.ratio, 6) && near(c.ceiling_db, -6), 'quiet night values applied');
      }
      await setNum(BODY, 'ratio', 4); await ctx.sleep(400);
      ctx.assert(await modified(), 'editing a value shows "modified"');

      // custom presets: save as, update, rename, delete (names are free text; the native key is user_<id>)
      const userKey = () => ctx.eval(`(() => { const p = document.querySelector('${BODY} [data-preset^="user_"]'); return p ? p.dataset.preset : null; })()`);
      const presetOf = async name => Object.values(((await store()).presets) || {}).find(p => p.name === name);
      await click(`${BODY} [data-act="save-as"]`);
      await ctx.eval(`(() => { const i = document.querySelector('${BODY} [data-act="name"]'); i.value = 'Aud test (1)'; return 1; })()`);
      await click(`${BODY} [data-act="name-ok"]`);
      await ctx.waitFor(`!!document.querySelector('${BODY} [data-preset^="user_"]')`, 'custom preset pill appears');
      await ctx.sleep(400);
      const key = await userKey();
      ctx.equal((await nat('/config')).preset, key, 'custom preset selected natively');
      ctx.assert(!(await modified()), 'a just-saved preset is not modified');
      ctx.assert(near((await presetOf('Aud test (1)')).values.ratio, 4), 'custom preset stored with the current values');
      await setNum(BODY, 'ratio', 7); await ctx.sleep(400);
      ctx.assert(await modified(), 'custom preset shows modified after an edit');
      await click(`${BODY} [data-act="update"]`);
      await ctx.waitFor(`document.querySelector('${BODY} .aud-modified').hidden`, 'update clears modified');
      ctx.assert(near((await presetOf('Aud test (1)')).values.ratio, 7), 'update stored the new values');
      await click(`${BODY} [data-act="rename"]`);
      await ctx.eval(`(() => { const i = document.querySelector('${BODY} [data-act="name"]'); i.value = 'Aud test renamed'; return 1; })()`);
      await click(`${BODY} [data-act="name-ok"]`);
      await ctx.waitFor(`document.querySelector('${BODY} [data-preset="${key}"]').textContent === 'Aud test renamed'`, 'renamed pill');
      ctx.equal(await userKey(), key, 'rename keeps the preset key');
      ctx.assert(!!(await presetOf('Aud test renamed')) && !(await presetOf('Aud test (1)')), 'rename stored');
      await click(`${BODY} [data-act="delete"]`);
      await ctx.waitFor(`!document.querySelector('${BODY} [data-preset^="user_"]')`, 'deleted pill gone');
      await ctx.sleep(400);
      ctx.assert(!(await presetOf('Aud test renamed')), 'deleted preset removed from storage');
      ctx.equal((await nat('/config')).preset, 'custom', 'deleting the selected preset leaves the values as "custom"');

      // an unknown native preset name (the native default's legacy "balanced") with the Voice values selects Voice by value
      const voice = { target_db: -20, max_gain_db: 12, gate_db: -50, threshold_db: -24, ratio: 3, knee_db: 6, attack_ms: 5, release_ms: 150, makeup_db: 4, lookahead_ms: 5, ceiling_db: -1, comp_enabled: false };
      await nat('/config', { preset: 'balanced', ...voice });
      await ctx.waitFor(`!!document.querySelector('${BODY} [data-preset="voice"].on')`, 'legacy preset name with Voice values highlights Voice', 5000);
      ctx.assert(!/do not match a preset/.test(await ctx.eval(`document.querySelector('${BODY}').textContent`)), 'no "custom" note for a value-matched preset');
      await nat('/config', { preset: 'balanced', ratio: 5 });   // values no longer match anything: nothing highlighted
      await ctx.waitFor(`!document.querySelector('${BODY} [data-preset].on')`, 'unknown name with unmatched values highlights nothing', 5000);

      // quick off -> on: the enable must wait for the disable's post, or it reads a stale /config and loses the AGC choice
      await ctx.eval(`(() => { __ts6mod.store().settings.audio.agcMode = 'ts6mods'; return 1; })()`);
      for (let i = 0; i < 4; i++) {
        await ctx.eval(`(async () => { await __ts6mod.setEnabled('audio', false, { persist: false }); await __ts6mod.setEnabled('audio', true, { persist: false }); return 1; })()`);
        await ctx.sleep(300);
        ctx.equal((await nat('/config')).enabled, true, `back-to-back off/on #${i + 1}: native enabled equals the stored AGC choice`);
      }
      await nat('/config', { enabled: false });
      await ctx.openModsPage('audio');
      await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 1`, 'audio area back after the toggles');
    }

    // ---- per-user popover (needs another connected user and the native module)
    const local = await ctx.onTestServer();
    if (!local) ctx.skip('per-user popover (volume, mute, boost, AGC override)', 'the local mute reaches the server: local test server only');
    else if (!nativeUp) ctx.skip('per-user popover', 'native control API not reachable');
    if (nativeUp && local) {
      const peer = await ctx.eval(`(() => { const a = __ts6mod.mods().get('audio').api; const l = a.peers.list().filter(p => !p.self && p.uid); return l.find(p => p.nickname === 'AudT') || l[0] || null; })()`);
      if (!peer) ctx.skip('per-user popover', 'no other user connected');
      else {
        await ctx.eval(`(() => { const a = __ts6mod.mods().get('audio').api; window.__audPostOrig = a.native.post; window.__audPosts = []; a.native.post = (p, b) => { window.__audPosts.push([p, b]); return window.__audPostOrig.call(a.native, p, b); }; return 1; })()`);
        const lastOv = () => ctx.eval(`(() => { const p = window.__audPosts.filter(x => x[0] === '/speaker' && x[1].client_id === ${peer.id}); return p.length ? p[p.length - 1][1].override : undefined; })()`);
        const rec = async () => ((await store()).users || {})[peer.uid];
        const wasMuted = peer.muted;
        // open through the real context menu of the user's row when it is rendered, else through the page's user list
        await ctx.restoreRoute();
        let rows = []; for (let i = 0; i < 15 && !rows.length; i++) { rows = await ctx.eval(`__ts6mod.anchors.tree.rows('client').map(r => r.model.id)`); if (!rows.length) await ctx.sleep(200); }
        let how = 'list';
        if (rows.includes(peer.id)) {
          const opened = await ctx.eval(`(async () => {
            const A = __ts6mod.anchors, cm = A.get('dom.contextMenu'), r = A.tree.rows('client').find(x => x.model.id === ${peer.id});
            cm.data = null;
            r.row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90, button: 2, buttons: 2 }));
            for (let i = 0; i < 20 && !cm.data; i++) await new Promise(res => setTimeout(res, 100));
            const s = (cm.data && cm.data.sections || []).find(s => s.title === 'Mods'); const it = s && s.items.find(i => i.title === 'Audio...');
            if (!it) return 'no menu item'; it.onSelected(new MouseEvent('click')); return 'ok'; })()`);
          ctx.equal(opened, 'ok', 'right-click menu offers "Audio..."');
          await ctx.eval(`__ts6mod.anchors.get('dom.contextMenu').data = null`); how = 'menu';
        } else ctx.log('peer row not rendered in the channel tree: popover opened from the page list (context-menu item not exercised)');
        {
          if (how === 'list') {
            await ctx.openModsPage('audio', 'Per-user');
            await ctx.waitFor(`!!document.querySelector('${BODY} .aud-user[data-uid="${peer.uid}"] [data-act="user-edit"]:not([hidden])')`, 'user listed on the page');
            await click(`${BODY} .aud-user[data-uid="${peer.uid}"] [data-act="user-edit"]`);
          }
          await ctx.waitFor(`!!document.querySelector('${POP}')`, 'popover opens');
          // volume (stock range), mute, boost
          await setNum(POP, 'vol', -6); await ctx.sleep(300);
          ctx.equal((await rec()).vol, -6, 'volume saved under the UID');
          await clickText(POP, 'Mute'); await ctx.sleep(500);
          ctx.equal((await rec()).mute, true, 'mute saved under the UID');
          ctx.assert(await ctx.eval(`__ts6mod.mods().get('audio').api.peers.list().find(p => p.id === ${peer.id}).muted`), 'user is muted (stock local mute)');
          await setNum(POP, 'boost', 6); await ctx.sleep(500);
          ctx.equal((await rec()).boost, 6, 'boost saved');
          ctx.equal((await lastOv()).gain_db, 6, 'boost pushed to the native module as gain_db');
          await click(`${POP} [data-agc="bypass"]`); await ctx.sleep(500);
          ctx.equal(await lastOv(), { gain_db: 6, enabled: false }, 'bypass pushed as enabled:false (+ gain)');
          await click(`${POP} [data-agc="custom"]`); await ctx.sleep(300);
          await setNum(POP, 'ratio', 8); await ctx.sleep(500);
          ctx.equal((await lastOv()).params, { ratio: 8 }, 'custom AGC pushes only the ticked parameter');
          ctx.assert(!(await ctx.eval(`!!document.querySelector('${POP} [data-key="lookahead_ms"]')`)), 'no lookahead field in the per-user override');
          // close, switch the mod off and on: everything cleared, then re-pushed from the UID record (as after a reconnect)
          await ctx.disable('audio'); await ctx.sleep(500);
          ctx.assert(!(await ctx.eval(`__ts6mod.anchors.get('app.connections')[0].serverConnectionHandler.GetFlatListClients && [...__ts6mod.anchors.get('app.connections')[0].serverConnectionHandler.GetFlatListClients()].find(c => c.id === ${peer.id}).properties.isMuted`)), 'mod off: our local mute is lifted');
          await ctx.enable('audio'); await nat('/config', { enabled: false });
          await ctx.eval(`(() => { const a = __ts6mod.mods().get('audio').api; window.__audPostOrig = a.native.post; window.__audPosts = []; a.native.post = (p, b) => { window.__audPosts.push([p, b]); return window.__audPostOrig.call(a.native, p, b); }; return 1; })()`);
          await ctx.sleep(3500);
          ctx.equal((await lastOv()), { gain_db: 6, params: { ratio: 8 } }, 'after re-enable the override is pushed again from the stored UID record');
          ctx.assert(await ctx.eval(`__ts6mod.mods().get('audio').api.peers.list().find(p => p.id === ${peer.id}).muted`), 'mute re-applied from the record');
          // reset everything for the user: record gone, native override cleared, mute lifted
          await ctx.eval(`window.__audPosts.length = 0`);
          await ctx.openModsPage('audio', 'Per-user');
          await ctx.waitFor(`!!document.querySelector('${BODY} .aud-user[data-uid="${peer.uid}"] [data-act="user-edit"]:not([hidden])')`, 'saved user listed on the page');
          await click(`${BODY} .aud-user[data-uid="${peer.uid}"] [data-act="user-edit"]`);
          await ctx.waitFor(`!!document.querySelector('${POP}')`, 'popover opens from the saved-user list');
          await clickText(POP, 'Reset everything'); await ctx.sleep(600);
          ctx.assert(!(await rec()), 'reset removes the record');
          ctx.equal(await lastOv(), null, 'reset clears the native override');
          ctx.assert(await ctx.eval(`__ts6mod.mods().get('audio').api.peers.list().find(p => p.id === ${peer.id}).muted`) === wasMuted, 'reset restores the local mute state');
          await clickText(POP, 'Done');
          await ctx.waitFor(`!document.querySelector('${POP}')`, 'popover closes');
        }
      }
    }
    await ctx.restoreRoute();
    await ctx.waitFor(`document.querySelectorAll('${BODY}').length === 0`, 'settings DOM removed when the page is left');
    await ctx.sleep(300);
    const b = await reqs(); await ctx.sleep(700);
    ctx.equal(await reqs(), b, 'no polling while the page is hidden');
    await ctx.disable('audio');
    await ctx.assertClean('audio');
    if (nativeUp) { const st = await nat('/status'); ctx.assert(st.enabled === false && st.mode === 'passthrough', 'mod off -> native AGC off again'); }
    const c = await reqs(); await ctx.sleep(500);
    ctx.equal(await reqs(), c, 'no polling after disable');
  } finally {
    await restore();
  }
}

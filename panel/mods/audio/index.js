/* Audio mod (ported 1:1 from the old single-file panel; a later task rebuilds it): the "Better AGC" controls for the native
 * module (enable switch, presets, strength, advanced fields, live meters) plus the two stock TeamSpeak playback AGC
 * toggles. The native module's own `enabled` switch stays in its config file (the audio hook needs it at client start,
 * before any UI exists); this mod only shows/edits it. Docs: superdoc/features/agc.md. */
(() => {
  /* ---- strength -> parameters: piecewise-linear between three anchors (gentle .. balanced .. strong) ---- */
  const A0   = { target_db: -24, max_gain_db: 4,  threshold_db: -18, ratio: 2, knee_db: 8, attack_ms: 10, release_ms: 250, makeup_db: 1 };
  const A50  = { target_db: -20, max_gain_db: 12, threshold_db: -24, ratio: 3, knee_db: 6, attack_ms: 5,  release_ms: 150, makeup_db: 4 };
  const A100 = { target_db: -16, max_gain_db: 20, threshold_db: -30, ratio: 6, knee_db: 4, attack_ms: 2,  release_ms: 100, makeup_db: 6 };
  const PRESETS = { gentle: 20, balanced: 50, strong: 80 };
  const paramsForStrength = s => {
    const lo = s <= 50 ? A0 : A50, hi = s <= 50 ? A50 : A100, t = s <= 50 ? s / 50 : (s - 50) / 50, o = {};
    for (const k in lo) o[k] = Math.round((lo[k] + (hi[k] - lo[k]) * t) * 100) / 100;
    return o;
  };
  /* key, label, min, max, step, unit, help */
  const FIELDS = [
    ['target_db', 'Target level', -40, 0, 1, 'dB', 'RMS level the slow leveler steers every speaker towards.'],
    ['max_gain_db', 'Max boost', 0, 24, 1, 'dB', 'Most the leveler may raise quiet speakers.'],
    ['gate_db', 'Noise gate', -90, -20, 1, 'dB', 'Input below this level is never boosted (keeps silence and noise from being pumped up).'],
    ['threshold_db', 'Compressor threshold', -60, 0, 1, 'dB', 'Peak level above which the compressor reduces gain.'],
    ['ratio', 'Compressor ratio', 1, 20, 0.5, ':1', 'Gain reduction slope above the threshold.'],
    ['knee_db', 'Knee width', 0, 24, 1, 'dB', 'Soft transition around the threshold.'],
    ['attack_ms', 'Attack', 0.1, 100, 0.1, 'ms', 'How fast the compressor reacts to loud peaks.'],
    ['release_ms', 'Release', 10, 1000, 10, 'ms', 'How fast the compressor lets go.'],
    ['makeup_db', 'Make-up gain', -12, 24, 0.5, 'dB', 'Gain after compression.'],
    ['lookahead_ms', 'Limiter lookahead', 0, 20, 1, 'ms', 'Adds this much delay to ALL playback (0 = no delay, hard limiter). Applied when a stream (re)opens or the setting changes.'],
    ['ceiling_db', 'Ceiling', -24, 0, 0.5, 'dB', 'Output samples never exceed this level.'],
  ];

  let modApi = null, S = null, pending = null, cancelPend = () => {}, view = null;   // view = the shown settings area (null while hidden)

  /* ---- state + native control API (api.native: /config /status /meters) ---- */
  async function refreshStatus() {
    try { const [st, cfg] = await Promise.all([modApi.native.get('/status'), pending ? Promise.resolve(null) : modApi.native.get('/config')]);
      S.status = st; if (cfg) S.cfg = cfg; S.native = 'ok'; }
    catch (e) { S.native = 'absent'; S.status = null; S.meters = null; }
  }
  async function refreshMeters() {
    if (S.native !== 'ok') return;
    try { S.meters = await modApi.native.get('/meters'); } catch (e) { S.native = 'absent'; S.meters = null; }
  }
  const sync = () => { if (view) view.sync(); };
  function patch(changes, now) {   /* optimistic local update, debounced POST of only the changed keys */
    Object.assign(S.cfg, changes); pending = Object.assign(pending || {}, changes);
    cancelPend();
    cancelPend = modApi.timeout(async () => {
      const body = pending; pending = null;
      try { S.cfg = await modApi.native.post('/config', body); S.error = ''; await refreshStatus(); }
      catch (e) { S.error = 'Could not reach the native module (' + e.message + ')'; S.native = 'absent'; }
      sync();
    }, now ? 0 : 150);
    sync();
  }
  function guarded(fn) {
    try { S.error = ''; fn(); } catch (e) { S.error = String(e && e.message || e); }
    S.stock = modApi.audio.stock(); sync();
  }

  /* ---- settings area (plain DOM; persistent elements, sync() updates them in place so dragging a slider keeps working) ---- */
  function settings(api, box) {
    const { ui } = api, h = ui.h;
    const absent = h('div', { class: 'mods-note' });
    const enabledT = ui.toggle({ title: 'Better AGC (whole stream)', sub: 'Leveler, compressor and limiter on everything TeamSpeak plays (all speakers and sounds together). Off = vanilla audio, bit-exact, no added delay.', onChange: v => patch({ enabled: v }, true) });
    const status = h('p', { class: 'mods-status' });
    const pills = Object.keys(PRESETS).map(p => ({ p, b: ui.pill({ label: p[0].toUpperCase() + p.slice(1), onClick: () => patch({ preset: p, strength: PRESETS[p], ...paramsForStrength(PRESETS[p]) }, true) }) }));
    const custom = h('span', { class: 'mods-pill ghost' }, 'Custom');
    const strength = ui.slider({ label: 'Strength', min: 0, max: 100, step: 1, unit: '%', value: 50, onInput: s => patch({ strength: s, preset: 'strength', ...paramsForStrength(s) }) });
    const mIn = ui.meter({ label: 'Input level', kind: 'in' }), mGr = ui.meter({ label: 'Gain reduction', kind: 'gr' }), mLg = ui.meter({ label: 'Leveler gain', kind: 'lg' });
    const advBtn = ui.button({ label: 'Show advanced settings', kind: 'link', onClick: () => { S.advanced = !S.advanced; sync(); } });
    const reset = ui.button({ label: 'Reset to defaults', kind: 'link', onClick: () => patch({ preset: 'balanced', strength: 50, ...paramsForStrength(50), gate_db: -50, lookahead_ms: 5, ceiling_db: -1 }, true) });
    const fields = FIELDS.map(([key, label, min, max, step, unit, help]) => ({ key, s: ui.slider({ label, min, max, step, unit, value: min, help, onInput: x => patch({ [key]: x, preset: 'custom' }), onCommit: x => patch({ [key]: x, preset: 'custom' }, true) }) }));
    const adv = h('div', { class: 'mods-adv' }, fields.map(f => f.s.el));
    const block = h('div', { class: 'mods-block' }, h('div', { class: 'mods-row' }, h('span', { class: 'mods-label' }, 'Preset'), ...pills.map(x => x.b.el), custom),
      strength.el, h('div', { class: 'mods-meters' }, mIn.el, mGr.el, mLg.el), h('div', { class: 'mods-row' }, advBtn, reset), adv);
    const agc = h('div', {}, enabledT.el, status, block);
    const stockAgc = ui.toggle({ title: 'Automatic Gain Control', sub: 'TeamSpeak\'s own playback AGC (the stock setting of the active playback device).', onChange: v => guarded(() => api.audio.setStockAgc(v)) });
    const stockExp = ui.toggle({ title: 'Experimental AGC mode', sub: 'TeamSpeak\'s hidden "Playback AGC Experimental Mode" developer option. Re-opens the playback stream (short audio glitch).', onChange: v => guarded(() => api.audio.setExperimentalAgc(v)) });
    const stockNone = ui.row(h('p', { class: 'mods-absent' }, 'TeamSpeak audio settings are not available yet (not connected?).'));
    const stock = h('div', {}, stockAgc.el, stockExp.el, stockNone);
    const err = h('p', { class: 'mods-error' });
    box.append(agc, absent, h('h4', { class: 'mods-subtitle' }, 'TeamSpeak playback AGC'), stock, err);

    const meterFmt = (m, k) => (m && m.active ? m : null);
    function syncMeters() {
      const m = meterFmt(S.meters);
      mIn.set(m ? Math.max(0, (m.in_db + 80) / 80 * 100) : 0, m ? (m.in_db < -100 ? 'silence' : m.in_db.toFixed(1) + ' dB') : '-');
      mGr.set(m ? m.gain_reduction_db / 24 * 100 : 0, m ? m.gain_reduction_db.toFixed(1) + ' dB' : '-');
      mLg.set(m ? (m.leveler_gain_db + 12) / 36 * 100 : 0, m ? (m.leveler_gain_db > 0 ? '+' : '') + m.leveler_gain_db.toFixed(1) + ' dB' : '-');
    }
    view = { sync() {
      const ok = S.native === 'ok' && S.cfg, c = S.cfg;
      agc.hidden = !ok; absent.hidden = !!ok;
      absent.textContent = S.native === 'unknown' ? 'Checking for the native module...' :
        'Native module not loaded (or the launcher\'s injector is not running). The "Better AGC" needs the client to be started with launcher/ts6-mod (see superdoc/features/agc.md). Without it the client is vanilla; the two stock settings below still work.';
      if (ok) {
        enabledT.set(!!c.enabled);
        const st = S.status, str = st && st.streams[0];
        status.textContent = !st ? '' :
          'Module ' + st.version + ' | ' + (st.mode === 'processing' ? 'processing' : 'passthrough') + ' | ' +
          (st.streams.length ? st.streams.length + ' playback stream' + (st.streams.length > 1 ? 's' : '') + (str ? ' (' + str.format + ', ' + str.rate + ' Hz, ' + str.channels + ' ch, delay ' +
            (str.latency_frames ? (str.latency_frames * 1000 / str.rate).toFixed(1) + ' ms' : 'none') + ')' : '') : 'no playback stream open yet') +
          (st.hooked.length ? '' : ' | audio hook not engaged');
        block.classList.toggle('mods-dim', !c.enabled);
        pills.forEach(x => x.b.set(c.preset === x.p)); custom.classList.toggle('on', c.preset === 'custom' || c.preset === 'strength');
        strength.set(c.strength);
        advBtn.textContent = (S.advanced ? 'Hide' : 'Show') + ' advanced settings'; adv.hidden = !S.advanced;
        fields.forEach(f => f.s.set(c[f.key]));
        syncMeters();
      }
      const sk = S.stock; stockAgc.el.hidden = stockExp.el.hidden = !sk; stockNone.hidden = !!sk;
      if (sk) { stockAgc.set(sk.agc); stockExp.set(sk.experimental); }
      err.textContent = S.error; err.hidden = !S.error;
    } };
    view.sync();

    /* polling lives in this scoped api: it stops when the Mods page is left or the mod is disabled */
    const tick = what => () => { if (document.hidden) return; what(); };
    (async () => { S.stock = api.audio.stock(); await refreshStatus(); await refreshMeters(); sync(); })();
    api.interval(tick(async () => { await refreshMeters(); if (view) syncMeters(); }), 120);
    api.interval(tick(async () => { S.stock = api.audio.stock(); if (!pending) await refreshStatus(); sync(); }), 2000);
    return () => { view = null; };
  }

  ts6mod.register({
    id: 'audio',
    title: 'Audio (Better AGC)',
    description: 'Settings for the native whole-stream AGC and the two stock TeamSpeak playback AGC options. The AGC itself is switched inside (it lives in the native module\'s config, so it works from client start).',
    enable(api) { modApi = api; S = { native: 'unknown', cfg: null, status: null, meters: null, stock: null, advanced: false, error: '' }; pending = null; },
    disable() {   // flush a debounced change instead of dropping it
      cancelPend(); if (pending && modApi) modApi.native.post('/config', pending).catch(() => {});
      modApi = S = view = null; pending = null;
    },
    settings,
  });
})();

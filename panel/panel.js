/* ts6-mods panel: injected into the TeamSpeak 6 UI page over CDP (see superdoc/features/agc.md).
 * Adds ONE thing to a vanilla client: a "Mods" page in Settings. Nothing else is touched, no network
 * request is made until that page is open. Globals set by the injector: __ts6modCss and the CDP binding ts6modNative. */
(() => {
  'use strict';
  if (window.__ts6mod || location.protocol !== 'tsui:' || window.top !== window) return;
    const KEY = 'TS6Mods';
  const mod = window.__ts6mod = { version: '0.1.0', installed: false, error: null };

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
    ['ratio', 'Ratio', 1, 20, 0.5, ':1', 'Compression ratio (1 = compressor off).'],
    ['knee_db', 'Knee', 0, 24, 1, 'dB', 'Softness of the compressor threshold.'],
    ['attack_ms', 'Attack', 0.1, 200, 0.1, 'ms', 'How fast the compressor reacts.'],
    ['release_ms', 'Release', 5, 2000, 5, 'ms', 'How fast the compressor lets go.'],
    ['makeup_db', 'Make-up gain', -12, 24, 0.5, 'dB', 'Gain after compression.'],
    ['lookahead_ms', 'Limiter lookahead', 0, 20, 1, 'ms', 'Adds this much delay to ALL playback (0 = no delay, hard limiter). Applied when a stream (re)opens or the setting changes.'],
    ['ceiling_db', 'Ceiling', -24, 0, 0.5, 'dB', 'Output samples never exceed this level.'],
  ];

  let Vue = null, S = null, app = null, root = null;

  /* ---- native control API, reached through a CDP binding (the UI page itself cannot open http:// connections) ---- */
  const waiting = new Map(); let seq = 0;
  window.__ts6modReply = r => { const w = waiting.get(r.id); if (w) { waiting.delete(r.id); clearTimeout(w.t); r.ok ? w.res(JSON.parse(r.text)) : w.rej(new Error(r.status ? 'HTTP ' + r.status : r.text)); } };
  function http(path, body) {
    return new Promise((res, rej) => {
      if (typeof window.ts6modNative !== 'function') return rej(new Error('bridge missing'));
      const id = ++seq, t = setTimeout(() => { waiting.delete(id); rej(new Error('timeout')); }, 2000);
      waiting.set(id, { res, rej, t });
      window.ts6modNative(JSON.stringify({ id, path, body }));
    });
  }

  /* ---- TeamSpeak's own audio settings (UI model) ---- */
  const audioSettings = () => { try { return app.connections[0].serverConnectionHandler.audio.audioSettings; } catch (e) { return null; } };
  function readStock() {
    const s = audioSettings(); if (!s) return null;
    try { const b = s.buildPlaybackDspBlob(); if (b) return { agc: !!b.agc, exp: !!b.agc_experimental_mode }; } catch (e) { /* internals changed: hide the rows */ }
    return null;
  }
  function activeOutDevice(s) {   /* {mode, deviceId} of the active output device */
    const id = s[0].device && s[0].device.id; if (!id) return null;
    for (const [mode, list] of s[0].devices) if (list.some(e => e[0].id === id)) return { mode, deviceId: id };
    return null;
  }
  function setStockAgc(v) {
    const s = audioSettings(), d = s && activeOutDevice(s); if (!d) throw new Error('active output device not found');
    s.onAudioDspSettingsChanged({ io: 0, settings: { mode: d.mode, deviceId: d.deviceId, agc: v } });   // what the stock toggle does
    s.save();
  }
  function setExperimental(v) {   /* documented in superdoc/features/ts6-modding-surface.md */
    const s = audioSettings(); if (!s) throw new Error('audio settings unavailable');
    s[0].global.agcExperimentalMode = v;
    app.connections.forEach(c => c.serverConnectionHandler.audio.Update());   // pushes agc_experimental_mode; reopens the playback stream
    s.save();
  }

  /* ---- state ---- */
  function makeState() {
    return Vue.observable({
      native: 'unknown', cfg: null, status: null, meters: null, stock: null, advanced: false, error: '', busy: false,
    });
  }
  let pending = null, pendTimer = 0;
  async function refreshStatus() {
    try { const [st, cfg] = await Promise.all([http('/status'), pending ? Promise.resolve(null) : http('/config')]);
      S.status = st; if (cfg) S.cfg = cfg; S.native = 'ok'; }
    catch (e) { S.native = 'absent'; S.status = null; S.meters = null; }
  }
  async function refreshMeters() {
    if (S.native !== 'ok') return;
    try { S.meters = await http('/meters'); } catch (e) { S.native = 'absent'; S.meters = null; }
  }
  function patch(changes, now) {   /* optimistic local update, debounced POST of only the changed keys */
    Object.assign(S.cfg, changes);
    if ('dashboard_button' in changes) setDashboardButton(!!changes.dashboard_button); pending = Object.assign(pending || {}, changes);
    clearTimeout(pendTimer);
    pendTimer = setTimeout(async () => {
      const body = pending; pending = null;
      try { S.cfg = await http('/config', body); S.error = ''; await refreshStatus(); }
      catch (e) { S.error = 'Could not reach the native module (' + e.message + ')'; S.native = 'absent'; }
    }, now ? 0 : 150);
  }
  async function guarded(fn) {
    try { S.error = ''; await fn(); } catch (e) { S.error = String(e && e.message || e); }
    S.stock = readStock();
  }

  /* ---- rendering helpers ---- */
  let uid = 0;
  const fmt = (v, step) => (step < 1 ? (+v).toFixed(1) : String(Math.round(v * 100) / 100));
  const bar = (h, label, value, text, pct, cls) =>
    h('div', { class: 'mods-meter' }, [h('span', { class: 'mods-meter-l' }, label),
      h('div', { class: 'mods-meter-track' }, [h('div', { class: 'mods-meter-fill ' + cls, style: { width: Math.max(0, Math.min(100, pct)) + '%' } })]),
      h('span', { class: 'mods-meter-v' }, text)]);

  function toggle(h, title, sub, checked, onChange, disabled) {   // same markup as the stock settings toggle
    const id = 'mods-toggle-' + (uid++), cls = (checked ? 'checked ' : '') + 'visible';
    const click = () => { if (!disabled) onChange(!checked); };
    return h('div', { class: 'ts-card-setting-container' + (disabled ? ' mods-disabled' : '') }, [h('div', [h('div', { class: 'ts-toggle-wrapper ts-flex row' }, [
      h('label', { class: 'tsv-flex-column', on: { click } }, [h('span', title), sub ? h('p', { class: 'tsv-font-subtitle' }, sub) : null]),
      h('div', { class: 'tsv-flex tsv-flex-wrap tsv-flex-snd-center' }, [
        h('div', { class: 'ts-toggle ' + cls, on: { click } }, [h('div', { class: 'ts-toggle-inner ' + cls }, [
          h('input', { attrs: { id, type: 'checkbox', tabindex: disabled ? -1 : 0 }, domProps: { checked }, on: { click: e => e.stopPropagation(), change: e => onChange(e.target.checked) } })])])])])])]);
  }

  function field(h, f) {
    const [key, label, min, max, step, unit, help] = f, v = S.cfg[key];
    return h('div', { class: 'mods-field', attrs: { title: help } }, [
      h('label', label),
      h('input', { class: 'mods-range', attrs: { type: 'range', min, max, step }, domProps: { value: v }, on: { input: e => patch({ [key]: +e.target.value, preset: 'custom' }) } }),
      h('span', { class: 'mods-num' }, [h('input', { attrs: { type: 'number', min, max, step }, domProps: { value: fmt(v, step) },
        on: { change: e => { const x = Math.min(max, Math.max(min, +e.target.value)); if (!isNaN(x)) patch({ [key]: x, preset: 'custom' }, true); } } }), h('em', unit)])]);
  }

  function agcCard(h) {
    const c = S.cfg, kids = [];
    kids.push(toggle(h, 'Better AGC (whole stream)', 'Leveler, compressor and limiter on everything TeamSpeak plays (all speakers and sounds together). Off = vanilla audio, bit-exact, no added delay.',
      !!c.enabled, v => patch({ enabled: v }, true)));
    const st = S.status, str = st && st.streams[0];
    kids.push(h('p', { class: 'tsv-font-subtitle mods-status' }, !st ? '' :
      'Module ' + st.version + ' | ' + (st.mode === 'processing' ? 'processing' : 'passthrough') + ' | ' +
      (st.streams.length ? st.streams.length + ' playback stream' + (st.streams.length > 1 ? 's' : '') + (str ? ' (' + str.format + ', ' + str.rate + ' Hz, ' + str.channels + ' ch, delay ' +
        (str.latency_frames ? (str.latency_frames * 1000 / str.rate).toFixed(1) + ' ms' : 'none') + ')' : '') : 'no playback stream open yet') +
      (st.hooked.length ? '' : ' | audio hook not engaged')));
    const dis = !c.enabled;
    kids.push(h('div', { class: 'mods-block' + (dis ? ' mods-dim' : '') }, [
      h('div', { class: 'mods-row' }, [h('span', { class: 'mods-label' }, 'Preset'),
        ...Object.keys(PRESETS).map(p => h('button', { class: 'mods-pill' + (c.preset === p ? ' on' : ''), on: { click: () => patch({ preset: p, strength: PRESETS[p], ...paramsForStrength(PRESETS[p]) }, true) } }, p[0].toUpperCase() + p.slice(1))),
        h('span', { class: 'mods-pill ghost' + (c.preset === 'custom' || c.preset === 'strength' ? ' on' : '') }, 'Custom')]),
      h('div', { class: 'mods-field' }, [h('label', 'Strength'),
        h('input', { class: 'mods-range', attrs: { type: 'range', min: 0, max: 100, step: 1 }, domProps: { value: c.strength },
          on: { input: e => { const s = +e.target.value; patch({ strength: s, preset: 'strength', ...paramsForStrength(s) }); } } }),
        h('span', { class: 'mods-num' }, [h('b', Math.round(c.strength)), h('em', '%')])]),
      h('div', { class: 'mods-meters' }, (() => { const m = S.meters && S.meters.active ? S.meters : null; return [
        bar(h, 'Input level', 0, m ? (m.in_db < -100 ? 'silence' : m.in_db.toFixed(1) + ' dB') : '-', m ? Math.max(0, (m.in_db + 80) / 80 * 100) : 0, 'in'),
        bar(h, 'Gain reduction', 0, m ? m.gain_reduction_db.toFixed(1) + ' dB' : '-', m ? m.gain_reduction_db / 24 * 100 : 0, 'gr'),
        bar(h, 'Leveler gain', 0, m ? (m.leveler_gain_db > 0 ? '+' : '') + m.leveler_gain_db.toFixed(1) + ' dB' : '-', m ? (m.leveler_gain_db + 12) / 36 * 100 : 0, 'lg')]; })()),
      h('div', { class: 'mods-row' }, [h('button', { class: 'mods-link', on: { click: () => { S.advanced = !S.advanced; } } }, (S.advanced ? 'Hide' : 'Show') + ' advanced settings'),
        h('button', { class: 'mods-link', on: { click: () => patch({ preset: 'balanced', strength: 50, ...paramsForStrength(50), gate_db: -50, lookahead_ms: 5, ceiling_db: -1 }, true) } }, 'Reset to defaults')]),
      S.advanced ? h('div', { class: 'mods-adv' }, FIELDS.map(f => field(h, f))) : null,
    ]));
    return kids;
  }

  function interfaceCard(h) {
    return [h('h3', { class: 'mods-title mods-sub' }, 'Interface'),
      S.cfg ? toggle(h, 'Dashboard button', 'Adds a Dashboard button (home / start page) to the left icon column. Same as the Dashboard entry of the main menu.', !!S.cfg.dashboard_button, v => patch({ dashboard_button: v }, true))
        : h('div', { class: 'ts-card-setting-container' }, [h('p', { class: 'mods-absent' }, 'Needs the native module (stores the switch).')])];
  }

  function render(h) {
    const kids = [];
    kids.push(h('div', { class: 'ts-card-content' }, [
      h('h3', { class: 'mods-title' }, 'Audio'),
      ...(S.native === 'ok' && S.cfg ? agcCard(h) : [
        h('div', { class: 'ts-card-setting-container' }, [h('p', { class: 'mods-absent' }, S.native === 'unknown' ? 'Checking for the native module...' :
          'Native module not loaded (or the launcher\'s injector is not running). The "Better AGC" needs the client to be started with launcher/ts6-mod (see superdoc/features/agc.md). Without it the client is vanilla; the two stock settings below still work.')])]),
      ...interfaceCard(h),
      h('h3', { class: 'mods-title mods-sub' }, 'TeamSpeak playback AGC'),
      ...(S.stock ? [
        toggle(h, 'Automatic Gain Control', 'TeamSpeak\'s own playback AGC (the stock setting of the active playback device).', S.stock.agc, v => guarded(() => setStockAgc(v))),
        toggle(h, 'Experimental AGC mode', 'TeamSpeak\'s hidden "Playback AGC Experimental Mode" developer option. Re-opens the playback stream (short audio glitch).', S.stock.exp, v => guarded(() => setExperimental(v))),
      ] : [h('div', { class: 'ts-card-setting-container' }, [h('p', { class: 'mods-absent' }, 'TeamSpeak audio settings are not available yet (not connected?).')])]),
      S.error ? h('p', { class: 'mods-error' }, S.error) : null,
    ]));
    return h('div', { class: 'ts-card ts-widget full mods-card' }, kids);
  }

  function makeComponent() {
    let timers = [], active = false;
    const stop = () => { active = false; timers.forEach(clearInterval); timers = []; };
    const start = () => {
      if (active) return; active = true;
      const tick = async (what) => { if (document.hidden || !active) return; await what(); };
      const first = async () => { S.stock = readStock(); await refreshStatus(); await refreshMeters(); };
      first();
      timers = [setInterval(() => tick(refreshMeters), 120), setInterval(() => tick(async () => { S.stock = readStock(); if (!pending) await refreshStatus(); }), 2000)];
    };
    return Vue.extend({ name: 'ts6-mods-page', render, mounted: start, activated: start, deactivated: stop, beforeDestroy: stop });
  }

  /* ---- Dashboard quick button (left icon column) ----
   * The four icons of that column are separate Vue-rendered .tsv-resources-group blocks inside .resources-section.
   * We append a fifth block built from the same classes/markup and the app's own <ts-icon>, and put it back whenever
   * Vue re-renders the sidebar. Click = the native action of the hamburger menu's "Dashboard" entry:
   * app.showItem(app.dashboard)  (route #/dashboard). */
  const dash = { on: false, node: null, vm: null, obs: null, timer: 0, unhook: null };
  function dashBuild() {   // needs appController.dashboard, which does not exist yet while the UI is still loading
    dash.vm = new Vue({ render: h => h('div', { class: 'tsv-resources-group mods-dash' + (root.$route && root.$route.path === '/dashboard' ? ' active' : ''), attrs: { title: 'Dashboard' } }, [
      h('div', { class: 'tsv-bar tsv-tabs tsv-tabs-slim tsv-tabs-combined' }, [h('div', { class: 'tsv-tab-item tsv-bar-item', on: { click: () => app.showItem(app.dashboard) } }, [
        h('div', { class: 'tsv-flex tsv-flex-center' }, [h('div', { class: 'tsv-magnify' }, [h('ts-icon', { attrs: { name: 'dashboard' }, class: 'tsv-icon-no-animation tsv-icon-base-third-color' })])])])])]) });
    dash.vm.$mount(); dash.node = dash.vm.$el;
    dash.unhook = root.$router.afterEach(to => { if (dash.node) dash.node.classList.toggle('active', to.path === '/dashboard'); });   // highlight while on the Dashboard
  }
  function dashEnsure() {
    if (!dash.on) return;
    if (dash.node && dash.node.nodeType !== 1) {   // render failed (icons not ready while the UI loads): drop it and retry on the next tick
      if (typeof dash.unhook === 'function') dash.unhook();
      dash.vm.$destroy(); dash.vm = dash.node = dash.unhook = null;
    }
    if (!dash.node) { if (!app.dashboard) return; dashBuild(); if (dash.node.nodeType !== 1) return; }
    const sec = document.querySelector('.resources-section'); if (!sec) return;
    const groups = [...sec.querySelectorAll(':scope > .tsv-resources-group:not(.mods-dash)')].filter(g => g.querySelector('.tsv-tab-item')), last = groups[groups.length - 1];   // skips the empty bottom drop-area group
    if (!last) return;
    const n = dash.node;
    document.querySelectorAll('.mods-dash').forEach(x => { if (x !== n) x.remove(); });   // never more than one
    if (n.previousElementSibling !== last || (n.nextElementSibling && n.nextElementSibling.classList.contains('tsv-resources-group'))) last.after(n);
  }
  function setDashboardButton(on) {
    if (on === dash.on) return;
    dash.on = on;
    if (on) {
      dash.obs = new MutationObserver(() => { clearTimeout(dash.timer); dash.timer = setTimeout(() => { try { dashEnsure(); } catch (e) { mod.error = 'dash: ' + (e && e.stack || e); } }, 100); });
      dash.obs.observe(document.body, { childList: true, subtree: true });
      try { dashEnsure(); } catch (e) { mod.error = 'dash: ' + (e && e.stack || e); }
    } else {
      if (dash.obs) dash.obs.disconnect();
      if (typeof dash.unhook === 'function') dash.unhook();
      clearTimeout(dash.timer);
      if (dash.vm) { dash.vm.$destroy(); if (dash.node && dash.node.parentNode) dash.node.parentNode.removeChild(dash.node); }
      dash.obs = dash.vm = dash.node = dash.unhook = null;
    }
  }
  async function applySavedUi() {   // switches live in the native config; without it the client stays vanilla
    for (let i = 0; i < 8; i++) {
      try { const c = await http('/config'); if (!S.cfg) S.cfg = c; setDashboardButton(!!c.dashboard_button); return; }
      catch (e) { await new Promise(r => setTimeout(r, 1000)); }
    }
  }

  /* ---- install ---- */
  function addCss() {
    if (document.getElementById('ts6mod-css')) return;
    const st = document.createElement('style'); st.id = 'ts6mod-css'; st.textContent = window.__ts6modCss || '';
    document.head.appendChild(st);
  }
  function install() {
    root = document.querySelector('#app').__vue__; app = root.appController;
    Vue = root.constructor; while (Vue.super) Vue = Vue.super;
    S = makeState(); addCss();
    const comp = makeComponent();
    if (!app.contentModes.settings.some(m => m.key === KEY))
      app.contentModes.settings.push({ component: 'ts-settings-view', keepAlive: true, renderKey: 'settings', image: 'settings-addons', key: KEY, title: 'Mods',
        extraProps: { component: () => Promise.resolve(comp) } });
    try {   // settings already open: rebuild the nav list
      const v = document.querySelector('.tsv-settings-categories .tsv-list') && document.querySelector('.tsv-settings-categories .tsv-list').__vue__;
      if (v) [].concat(v.$options.created).forEach(f => f.call(v));
    } catch (e) { /* nav appears next time Settings opens */ }
    applySavedUi();
    mod.installed = true;
    mod.open = () => root.$router.push('/settings?mode=' + KEY);
    mod.state = S; mod.dash = dash; mod.dashEnsure = dashEnsure;
  }

  let tries = 0;
  const wait = setInterval(() => {
    try {
      const r = document.querySelector('#app'), a = r && r.__vue__ && r.__vue__.appController;
      if (a && a.contentModes && a.contentModes.settings) { clearInterval(wait); install(); }
      else if (++tries > 240) clearInterval(wait);   // 60 s: not the main UI page
    } catch (e) { clearInterval(wait); mod.error = String(e); }
  }, 250);
})();

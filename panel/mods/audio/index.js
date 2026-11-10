/* Audio mod: the full AGC page (master switch, whole-stream / per-speaker mode, every DSP parameter, presets with user presets,
 * live meters, per-speaker list), the per-user "Audio..." popover (volume, mute, boost past the stock limit, per-user AGC
 * override, saved per UID) and TeamSpeak's own two playback AGC toggles. TeamSpeak names live in panel/core/x-audio.js
 * (api.peers). Native side: native/ts6mod.c control API (/config /status /meters /speakers /speaker).
 * Vanilla rule: the mod switch also switches the native AGC (off while the mod is off). Docs: superdoc/features/agc.md. */
(() => {
  /* key, label, min, max, step, unit, help, group (ranges = native/dsp/README.md; the native module clamps anyway) */
  const PARAMS = [
    ['target_db', 'Target level', -40, 0, 1, 'dB', 'How loud the slow leveler wants every speaker to end up (average level). Lower = quieter overall.', 'Leveler'],
    ['max_gain_db', 'Max boost', 0, 24, 1, 'dB', 'The most the leveler may turn up a quiet speaker. 0 = it never boosts, only lowers.', 'Leveler'],
    ['gate_db', 'Noise gate', -90, -20, 1, 'dB', 'Below this input level the leveler stands still, so pauses and background noise are not pumped up. Raise it for noisy microphones.', 'Leveler'],
    ['threshold_db', 'Threshold', -60, 0, 1, 'dB', 'Peaks above this level are pressed down by the compressor.', 'Compressor'],
    ['ratio', 'Ratio', 1, 20, 0.5, ':1', 'How hard peaks above the threshold are pressed down. 1 = no compression, 20 = nearly a wall.', 'Compressor'],
    ['knee_db', 'Knee', 0, 24, 1, 'dB', 'How smoothly the compressor fades in around the threshold. 0 = abrupt, higher = gentler.', 'Compressor'],
    ['attack_ms', 'Attack', 0.1, 200, 0.1, 'ms', 'How fast the compressor reacts to a sudden loud sound. Short = fewer spikes, but can sound squashed.', 'Compressor'],
    ['release_ms', 'Release', 5, 2000, 5, 'ms', 'How fast the compressor lets go after a loud sound. Short = lively, long = smooth.', 'Compressor'],
    ['makeup_db', 'Make-up gain', -12, 24, 0.5, 'dB', 'Fixed gain after compression, to win back the loudness the compressor took away.', 'Compressor'],
    ['lookahead_ms', 'Lookahead', 0, 20, 1, 'ms', 'The limiter looks this far ahead so it can lower the volume before a peak arrives. It delays all voices by the same amount (0 = no delay, harder limiting). Applied when the setting changes.', 'Limiter'],
    ['ceiling_db', 'Ceiling', -24, 0, 0.5, 'dB', 'Hard limit: the output never gets louder than this, however loud the speaker is.', 'Limiter'],
  ];
  const KEYS = PARAMS.map(p => p[0]);
  const USER_KEYS = KEYS.filter(k => k !== 'lookahead_ms');   // per-user overrides cannot change the lookahead (one delay line length for all)
  const values = (...v) => Object.fromEntries(KEYS.map((k, i) => [k, v[i]]));
  /*                              target maxG gate thr  ratio knee att  rel  makeup look ceil */
  const PRESETS = {
    voice: { title: 'Voice', blurb: 'Evens out speakers and tames peaks; the default everyday setting.', values: values(-20, 12, -50, -24, 3, 6, 5, 150, 4, 5, -1) },
    music: { title: 'Music', blurb: 'Light touch for music bots: keeps the dynamics, only lifts quiet parts a little and stops peaks.', values: values(-18, 6, -60, -18, 2, 12, 20, 400, 2, 5, -1) },
    quiet: { title: 'Quiet night', blurb: 'Low overall volume with strong peak control: whispers stay audible, shouting never gets loud.', values: values(-26, 18, -55, -30, 6, 6, 2, 120, 0, 8, -6) },
  };
  const NAME_MAX = 32;

  let modApi = null, S = null, pending = null, cancelPend = () => {}, view = null, offPost = null;   // view = the shown settings area (null while hidden)
  const applied = new Map();   // "schid:clientId" -> state we pushed for that user in this session (see syncPeers)

  /* ---------------- native control API ---------------- */
  async function refreshStatus() {
    const a = modApi; if (!a) return;
    try { const [st, cfg] = await Promise.all([a.native.get('/status'), pending ? Promise.resolve(null) : a.native.get('/config')]);
      if (modApi !== a) return;   // disabled meanwhile: touch nothing
      S.status = st; if (cfg) S.cfg = cfg; S.native = 'ok'; }
    catch (e) { if (modApi !== a) return; S.native = 'absent'; S.status = null; S.meters = null; S.speakers = []; }
  }
  const sync = () => { if (view) view.sync(); };
  function patch(changes, now) {   /* optimistic local update, debounced POST of only the changed keys */
    Object.assign(S.cfg, changes); pending = Object.assign(pending || {}, changes);
    cancelPend();
    cancelPend = modApi.timeout(async () => {
      const body = pending, a = modApi; pending = null; if (!a) return;
      try { const cfg = await a.native.post('/config', body); if (modApi !== a) return; S.cfg = cfg; S.error = ''; await refreshStatus(); }
      catch (e) { if (modApi !== a) return; S.error = 'Could not reach the native module (' + e.message + ')'; S.native = 'absent'; }
      sync();
    }, now ? 0 : 150);
    sync();
  }
  const guarded = fn => { try { S.error = ''; fn(); } catch (e) { S.error = String(e && e.message || e); } S.stock = modApi.audio.stock(); sync(); };

  /* ---------------- presets ---------------- */
  /* user presets: {id: {name, values}}; the native config only stores the preset key (letters, digits, _ and - only), so the
   * key is "user_<id>" and the free-text name lives here */
  const customs = () => modApi.storage.get('presets', {});
  const isUserKey = key => typeof key === 'string' && key.startsWith('user_');
  const presetValues = key => PRESETS[key] ? PRESETS[key].values : (isUserKey(key) && customs()[key.slice(5)] ? customs()[key.slice(5)].values : null);
  const pick = o => Object.fromEntries(KEYS.map(k => [k, o[k]]));
  const same = (a, b) => KEYS.every(k => Math.abs(a[k] - b[k]) < 0.006);
  const presetName = key => PRESETS[key] ? PRESETS[key].title : customs()[key.slice(5)].name;
  function checkName(name, exceptKey) {
    if (!name) return 'Give the preset a name.';
    if (name.length > NAME_MAX) return 'At most ' + NAME_MAX + ' characters.';
    const low = name.toLowerCase();
    if (Object.values(PRESETS).some(p => p.title.toLowerCase() === low)) return 'That name belongs to a built-in preset.';
    if (Object.entries(customs()).some(([id, c]) => 'user_' + id !== exceptKey && c.name.toLowerCase() === low)) return 'A preset with that name exists.';
    return '';
  }

  /* ---------------- per-user records (stored per UID) ----------------
   * rec = {name, vol?: dB (stock per-user volume), mute?: bool, boost?: dB (>0, native gain past the stock limit),
   *        agc?: 'bypass'|'custom', params?: {key: value}}; absent record = nothing changed for that user. */
  const users = () => modApi.storage.get('users', {});
  const isDefault = r => !r || (r.vol === undefined && !r.mute && !(r.boost > 0) && !r.agc);
  const nativeOverride = r => {
    const o = {};
    if (r.boost > 0) o.gain_db = r.boost;
    if (r.agc === 'bypass') o.enabled = false;
    else if (r.agc === 'custom' && r.params && Object.keys(r.params).length) o.params = r.params;
    return Object.keys(o).length ? o : null;
  };
  function editUser(peer, fn) {
    const all = Object.assign({}, users()), r = Object.assign({}, all[peer.uid] || {});
    fn(r); if (peer.nickname) r.name = peer.nickname;
    if (isDefault(r)) delete all[peer.uid]; else all[peer.uid] = r;
    modApi.storage.set('users', all); syncPeers();
    return all[peer.uid] || null;
  }
  const speakerPost = (peer, override) => modApi.native.post('/speaker', { client_id: peer.id, schid: peer.schid, override });

  /* push stored per-user settings to the users present now (ids change per session), clear what is gone; cheap, runs on
   * roster events and every few seconds */
  let syncing = false;
  async function syncPeers() {
    if (!modApi || syncing) return; syncing = true;
    const api = modApi;
    try {
      let list; try { list = api.peers.list(); } catch (e) { return; }
      const u = users(), seen = new Set();
      for (const p of list) {
        if (p.self) continue;
        const key = p.schid + ':' + p.id; seen.add(key);
        const want = p.uid && u[p.uid] && !isDefault(u[p.uid]) ? u[p.uid] : null, cur = applied.get(key);
        const sig = want ? JSON.stringify([want.vol, want.mute, want.boost, want.agc, want.params]) : '';
        if (!want && !cur) continue;
        if (cur && cur.sig === sig) continue;
        const a = cur || { sig: '', origVol: undefined, muted: false, ov: '' };
        let ok = true;
        try {
          if (want && want.vol !== undefined) { if (a.origVol === undefined) a.origVol = await api.peers.getVolume(p.schid, p.id); await api.peers.setVolume(p.schid, p.id, want.vol); }
          else if (a.origVol !== undefined) { await api.peers.setVolume(p.schid, p.id, a.origVol); a.origVol = undefined; }
          if (want && want.mute && !p.muted && !a.muted) { await api.peers.setMuted(p.schid, p.id, true); a.muted = true; }
          else if ((!want || !want.mute) && a.muted) { await api.peers.setMuted(p.schid, p.id, false); a.muted = false; }
        } catch (e) { ok = false; }
        const ov = want ? nativeOverride(want) : null, ovs = ov ? JSON.stringify(ov) : '';
        if (ovs !== a.ov) { try { await speakerPost(p, ov); a.ov = ovs; } catch (e) { ok = false; } }
        a.sig = ok ? sig : ''; a.uid = p.uid;
        if (want || a.ov || a.origVol !== undefined || a.muted) applied.set(key, a); else applied.delete(key);
      }
      for (const [key, a] of [...applied]) {
        if (seen.has(key)) continue;   // the user left: the stock value dies with the session; the native override must not leak to a re-used id
        applied.delete(key);
        if (a.ov) { const [schid, id] = key.split(':'); speakerPost({ schid: +schid, id: +id }, null).catch(() => {}); }
      }
    } finally { syncing = false; }
  }
  function clearPeers() {   /* mod switched off: put everything we changed back */
    const api = modApi;
    for (const [key, a] of applied) {
      const [schid, id] = key.split(':').map(Number);
      if (a.origVol !== undefined) api.peers.setVolume(schid, id, a.origVol).catch(() => {});
      if (a.muted) api.peers.setMuted(schid, id, false).catch(() => {});
      if (a.ov) speakerPost({ schid, id }, null).catch(() => {});
    }
    applied.clear();
  }

  /* ---------------- small widgets ---------------- */
  const sign = (v, d) => (v > 0 ? '+' : '') + v.toFixed(d == null ? 1 : d);
  const bar = h => { const f = h('div', { class: 'mods-meter-fill' }), v = h('span', { class: 'mods-meter-v' }, '-');
    return { track: h('div', { class: 'mods-meter-track' }, f), v, set(pct, text, kind) { f.style.width = Math.max(0, Math.min(100, pct || 0)) + '%'; f.className = 'mods-meter-fill ' + (kind || ''); v.textContent = text == null ? '-' : text; } }; };
  const inPct = db => Math.max(0, (db + 80) / 80 * 100), inText = db => (db < -100 ? 'silence' : db.toFixed(1) + ' dB');

  /* one parameter field: the kit's slider + number input with a visible help line */
  function paramField(ui, h, [key, label, min, max, step, unit, help], onInput, onCommit) {
    const s = ui.slider({ label, min, max, step, unit, value: min, onInput, onCommit });
    return { key, s, el: h('div', { class: 'aud-param', 'data-key': key }, s.el, h('p', { class: 'aud-help' }, help)) };
  }

  /* ---------------- settings area (Mods page) ---------------- */
  function settings(api, box) {
    const { ui } = api, h = ui.h;
    const absent = h('div', { class: 'mods-note' });
    const status = h('p', { class: 'mods-status' });
    const master = ui.toggle({ title: 'Audio processing (AGC)', sub: 'Leveler, compressor and limiter on the voices you hear. Off = vanilla audio, bit-exact, no added delay.', onChange: v => { api.storage.set('master', v); patch({ enabled: v }, true); } });
    const modePills = [['whole', 'Whole stream'], ['per_speaker', 'Per speaker']].map(([m, label]) => ({ m, b: ui.pill({ label, onClick: () => patch({ mode: m }, true) }) }));
    const modeHelp = h('p', { class: 'mods-note aud-help' });

    /* presets */
    const presetRow = h('div', { class: 'mods-row aud-presets' }), presetNote = h('p', { class: 'mods-note aud-help' });
    const nameIn = h('input', { type: 'text', class: 'aud-name', maxlength: NAME_MAX, placeholder: 'Preset name', 'data-act': 'name' });
    let nameMode = null;   // 'save' | 'rename' | null
    const nameOk = ui.button({ label: 'OK', onClick: () => commitName() }), nameNo = ui.button({ label: 'Cancel', kind: 'link', onClick: () => { nameMode = null; sync(); } });
    nameOk.setAttribute('data-act', 'name-ok');
    const nameErr = h('span', { class: 'mods-error aud-inline-err' });
    const nameRow = h('div', { class: 'mods-row' }, nameIn, nameOk, nameNo, nameErr);
    nameIn.addEventListener('keydown', e => { if (e.key === 'Enter') commitName(); else if (e.key === 'Escape') { nameMode = null; sync(); } });
    const act = (label, name, fn) => { const b = ui.button({ label, onClick: fn }); b.setAttribute('data-act', name); return b; };
    const bSave = act('Save as...', 'save-as', () => { nameMode = 'save'; nameIn.value = ''; nameErr.textContent = ''; sync(); nameIn.focus(); });
    const bUpdate = act('Update preset', 'update', () => { const c = customs(); c[selected().slice(5)].values = pick(S.cfg); api.storage.set('presets', c); sync(); });
    const bRename = act('Rename...', 'rename', () => { nameMode = 'rename'; nameIn.value = presetName(selected()); nameErr.textContent = ''; sync(); nameIn.focus(); });
    const bDelete = act('Delete', 'delete', () => { const c = customs(); delete c[selected().slice(5)]; api.storage.set('presets', c); patch({ preset: 'custom' }, true); });
    const bRevert = act('Revert to preset', 'revert', () => { const sel = selected(); patch({ preset: sel, ...presetValues(sel) }, true); });
    const modified = h('span', { class: 'mods-pill ghost on aud-modified' }, 'modified');
    const presetActs = h('div', { class: 'mods-row' }, bSave, bUpdate, bRename, bDelete, bRevert);
    /* an unknown name (e.g. the native default's legacy "balanced") falls back to matching the values against the built-in presets */
    const selected = () => {
      const k = S.cfg && S.cfg.preset; if (k && presetValues(k)) return k;
      return S.cfg ? Object.keys(PRESETS).find(id => same(S.cfg, PRESETS[id].values)) || null : null;
    };
    function commitName() {
      const name = nameIn.value.trim(), err = checkName(name, nameMode === 'rename' ? selected() : null);
      if (err) { nameErr.textContent = err; return; }
      const c = customs(); let key;
      if (nameMode === 'save') { const id = 'p' + Date.now().toString(36); c[id] = { name, values: pick(S.cfg) }; key = 'user_' + id; }
      else { key = selected(); c[key.slice(5)].name = name; }
      api.storage.set('presets', c); patch({ preset: key }, true); nameMode = null; sync();
    }
    let presetSig = '';
    function renderPresets() {
      const mine = Object.entries(customs()).map(([id, c]) => [c.name, 'user_' + id]).sort((a, b) => a[0].localeCompare(b[0])), sel = selected();
      const sig = JSON.stringify([mine, sel]); if (sig === presetSig) return; presetSig = sig;
      const mk = (key, label, tip) => { const b = ui.pill({ label, onClick: () => patch({ preset: key, ...presetValues(key) }, true), on: key === sel }); b.el.setAttribute('data-preset', key); b.el.title = tip || ''; return b.el; };
      presetRow.replaceChildren(h('span', { class: 'mods-label' }, 'Preset'), ...Object.entries(PRESETS).map(([k, p]) => mk(k, p.title, p.blurb)), ...mine.map(([name, key]) => mk(key, name, 'Your preset')));
    }

    /* parameters */
    const fields = PARAMS.map(def => paramField(ui, h, def, x => patch({ [def[0]]: x }), x => patch({ [def[0]]: x }, true)));
    const groups = ['Leveler', 'Compressor', 'Limiter'].map(g => ui.section(g, ...fields.filter(f => PARAMS.find(p => p[0] === f.key)[7] === g).map(f => f.el)));
    const params = h('div', { class: 'aud-params' }, ...groups);

    /* meters */
    const mIn = ui.meter({ label: 'Input level', kind: 'in' }), mGr = ui.meter({ label: 'Gain reduction', kind: 'gr' }), mLg = ui.meter({ label: 'Leveler gain', kind: 'lg' });
    const mPi = ui.meter({ label: 'Input peak', kind: 'in' }), mPo = ui.meter({ label: 'Output peak', kind: 'in' });
    const wholeMeters = ui.section('Live meters', h('div', { class: 'mods-meters' }, mIn.el, mGr.el, mLg.el, mPi.el, mPo.el));
    const spRows = new Map(), spEmpty = h('p', { class: 'mods-note' }, 'Nobody is talking yet. Active speakers appear here with their own meters.');
    const spList = h('div', { class: 'aud-speakers' });
    const speakersBox = ui.section('Speakers (live)', ui.note('One compressor per speaker. Level and gain reduction are measured on each speaker\'s own voice.'), spList, spEmpty);

    /* saved per-user settings */
    const userList = h('div', { class: 'aud-users' }), userEmpty = h('p', { class: 'mods-note' }, 'Nobody here yet. Right-click a user in the channel tree and choose "Audio..." too.');
    let userSig = '';
    const summary = r => [r.vol !== undefined ? 'volume ' + sign(r.vol) + ' dB' : '', r.mute ? 'muted' : '', r.boost > 0 ? 'boost +' + r.boost.toFixed(1) + ' dB' : '',
      r.agc === 'bypass' ? 'AGC bypassed' : r.agc === 'custom' ? 'custom AGC (' + Object.keys(r.params || {}).length + ')' : ''].filter(Boolean).join(', ') || 'no changes';
    function renderUsers() {   // users with saved settings plus the users in your channel
      const u = users(), here = new Map(); try { api.peers.list().filter(p => !p.self && p.uid).forEach(p => here.set(p.uid, p)); } catch (e) { /* not connected */ }
      const ids = [...new Set([...Object.keys(u), ...[...here.values()].filter(p => p.sameChannel).map(p => p.uid)])];
      const nameOf = uid => (here.get(uid) && here.get(uid).nickname) || (u[uid] && u[uid].name) || 'Unknown user';
      const sig = JSON.stringify([u, ids.map(i => [i, nameOf(i), here.has(i)])]); if (sig === userSig) return; userSig = sig;
      ids.sort((a, b) => nameOf(a).localeCompare(nameOf(b)));
      userList.replaceChildren(...ids.map(uid => {
        const p = here.get(uid), saved = !!u[uid];
        const edit = ui.button({ label: 'Edit...', onClick: () => openUser(here.get(uid)) }); edit.hidden = !p; edit.setAttribute('data-act', 'user-edit');
        const forget = ui.button({ label: 'Forget', kind: 'link', onClick: () => { const all = Object.assign({}, users()); delete all[uid]; api.storage.set('users', all); syncPeers(); sync(); } }); forget.hidden = !saved;
        return h('div', { class: 'mods-row aud-user', 'data-uid': uid }, h('span', { class: 'aud-uname' }, nameOf(uid) + (p ? '' : ' (not here)')), h('span', { class: 'aud-help' }, saved ? summary(u[uid]) : 'no changes'), edit, forget);
      }));
      userEmpty.hidden = ids.length > 0;
    }

    /* stock toggles */
    const stockAgc = ui.toggle({ title: 'Automatic Gain Control', sub: 'TeamSpeak\'s own playback AGC (the stock setting of the active playback device).', onChange: v => guarded(() => api.audio.setStockAgc(v)) });
    const stockExp = ui.toggle({ title: 'Experimental AGC mode', sub: 'TeamSpeak\'s hidden "Playback AGC Experimental Mode" developer option. Re-opens the playback stream (short audio glitch).', onChange: v => guarded(() => api.audio.setExperimentalAgc(v)) });
    const stockNone = ui.row(h('p', { class: 'mods-absent' }, 'TeamSpeak audio settings are not available yet (not connected?).'));
    const stock = h('div', {}, stockAgc.el, stockExp.el, stockNone);
    const err = h('p', { class: 'mods-error' });

    const body = h('div', {}, status,
      ui.section('Mode', h('div', { class: 'mods-row' }, h('span', { class: 'mods-label' }, 'Processing'), ...modePills.map(x => x.b.el)), modeHelp),
      ui.section('Presets', presetRow, h('div', { class: 'mods-row' }, modified), presetNote, nameRow, presetActs),
      ui.section('Parameters', ui.note('Edits apply live and are kept by the native module (they survive a client restart).'), params),
      wholeMeters, speakersBox,
      ui.section('Per-user settings', userList, userEmpty));
    const agc = h('div', {}, master.el, body);
    box.append(agc, absent, ui.section('TeamSpeak playback AGC', stock), err);

    function syncSpeakers() {
      const list = (S.speakers || []).filter(s => s.active || s.frames > 0);
      /* the hook only knows the numeric client id (it reports schid 0), so users are matched by id alone */
      let names = new Map(); try { api.peers.list().filter(p => !p.self).forEach(p => { const k = String(p.id); if (!names.has(k) || p.sameChannel) names.set(k, p); }); } catch (e) { /* ignore */ }
      const keep = new Set();
      for (const s of list) {
        const key = String(s.client_id); keep.add(key);
        let r = spRows.get(key);
        if (!r) {
          const nick = h('span', { class: 'aud-uname' }), lvl = bar(h), gr = bar(h), lg = h('span', { class: 'aud-lg' }), ovr = h('span', { class: 'mods-pill ghost on aud-ovr' }, 'override');
          const btn = ui.button({ label: 'Audio...', onClick: () => { const p = names.get(key); if (p) openUser(p); } }); btn.setAttribute('data-act', 'speaker-audio');
          r = { key, nick, lvl, gr, lg, ovr, btn, el: h('div', { class: 'aud-sprow', 'data-client': String(s.client_id) }, nick, h('div', { class: 'aud-bars' }, lvl.track, gr.track), h('div', { class: 'aud-vals' }, lvl.v, gr.v, lg), ovr, btn) };
          spRows.set(key, r); spList.append(r.el);
        }
        const p = names.get(key);
        r.nick.textContent = p ? p.nickname : '#' + s.client_id; r.btn.hidden = !p;
        r.el.classList.toggle('aud-idle', !s.active);
        r.lvl.set(inPct(s.in_db), inText(s.in_db), 'in'); r.gr.set(s.gain_reduction_db / 24 * 100, s.gain_reduction_db.toFixed(1) + ' dB', 'gr');
        r.lg.textContent = 'gain ' + sign(s.leveler_gain_db) + ' dB'; r.ovr.hidden = !s.override;
      }
      for (const [k, r] of [...spRows]) if (!keep.has(k)) { r.el.remove(); spRows.delete(k); }
      spEmpty.hidden = spRows.size > 0;
    }
    function syncMeters() {
      const m = S.meters && S.meters.active ? S.meters : null;
      mIn.set(m ? inPct(m.in_db) : 0, m ? inText(m.in_db) : '-');
      mGr.set(m ? m.gain_reduction_db / 24 * 100 : 0, m ? m.gain_reduction_db.toFixed(1) + ' dB' : '-');
      mLg.set(m ? (m.leveler_gain_db + 12) / 36 * 100 : 0, m ? sign(m.leveler_gain_db) + ' dB' : '-');
      mPi.set(m ? inPct(m.in_peak_db) : 0, m ? inText(m.in_peak_db) : '-');
      mPo.set(m ? inPct(m.out_peak_db) : 0, m ? inText(m.out_peak_db) : '-');
    }
    view = { syncMeters, syncSpeakers, sync() {
      const ok = S.native === 'ok' && S.cfg, c = S.cfg;
      agc.hidden = !ok; absent.hidden = !!ok;
      absent.textContent = S.native === 'unknown' ? 'Checking for the native module...' :
        'Native module not loaded (or the launcher\'s injector is not running). The AGC needs the client to be started with launcher/ts6-mod (see superdoc/features/agc.md). Without it the client is vanilla; the two stock settings below still work.';
      if (ok) {
        master.set(!!c.enabled);
        const st = S.status, ps = st && st.per_speaker;
        status.textContent = !st ? '' : 'Module ' + st.version + ' | ' + (st.mode === 'processing' ? 'processing' : 'passthrough') +
          (c.mode === 'per_speaker' ? ' | per speaker' + (ps ? (ps.hook_installed ? (ps.active ? ', ' + ps.speakers + ' speaker' + (ps.speakers === 1 ? '' : 's') + ', delay ' + ps.added_latency_ms.toFixed(1) + ' ms' : ', idle') : ', hook not installed') : '') :
            (st.streams.length ? ' | delay ' + (st.streams[0].latency_frames ? (st.streams[0].latency_frames * 1000 / st.streams[0].rate).toFixed(1) + ' ms' : 'none') : ' | no playback stream open yet'));
        modePills.forEach(x => x.b.set(c.mode === x.m));
        modeHelp.textContent = c.mode === 'per_speaker'
          ? 'Each speaker is leveled and limited on its own before the voices are mixed: a loud speaker no longer pushes the others down. Needed for the per-user overrides (boost, bypass, custom AGC). Installs an inline hook the first time you choose it.'
          : 'One leveler/compressor/limiter on everything you hear, all speakers and sounds mixed together. Works everywhere, but one loud speaker lowers the others too.';
        if (c.mode === 'per_speaker' && ps && !ps.hook_installed && c.enabled) status.textContent += ' (this client version is not supported by the per-speaker hook; see the AGC doc)';
        body.classList.toggle('mods-dim', !c.enabled);
        const sel = selected(), vals = sel && presetValues(sel), mod = !!vals && !same(c, vals), isUser = !!sel && isUserKey(sel);
        renderPresets();
        modified.hidden = !mod; bRevert.hidden = !mod; bUpdate.hidden = !(mod && isUser); bRename.hidden = !isUser; bDelete.hidden = !isUser;
        presetNote.textContent = !sel ? 'Values do not match a preset (custom). Save them as your own preset below.' : (PRESETS[sel] ? PRESETS[sel].blurb : 'Your preset.');
        nameRow.hidden = !nameMode; nameOk.textContent = nameMode === 'rename' ? 'Rename' : 'Save';
        fields.forEach(f => f.s.set(c[f.key]));
        wholeMeters.hidden = c.mode !== 'whole'; speakersBox.hidden = c.mode !== 'per_speaker';
        syncMeters(); syncSpeakers(); renderUsers();
      }
      const sk = S.stock; stockAgc.el.hidden = stockExp.el.hidden = !sk; stockNone.hidden = !!sk;
      if (sk) { stockAgc.set(sk.agc); stockExp.set(sk.experimental); }
      err.textContent = S.error; err.hidden = !S.error;
    } };
    view.sync();

    /* polling lives in this scoped api: it stops when the Mods page is left or the mod is disabled */
    let busy = false;
    const live = async () => {
      if (document.hidden || busy || S.native !== 'ok' || !S.cfg) return; busy = true;
      try {
        if (S.cfg.mode === 'per_speaker') { S.speakers = await api.native.get('/speakers'); if (view) view.syncSpeakers(); }
        else { S.meters = await api.native.get('/meters'); if (view) view.syncMeters(); }
      } catch (e) { S.native = 'absent'; S.meters = null; S.speakers = []; sync(); } finally { busy = false; }
    };
    (async () => { S.stock = api.audio.stock(); await refreshStatus(); sync(); })();
    api.interval(live, 120);
    api.interval(async () => { if (document.hidden) return; S.stock = api.audio.stock(); if (!pending) await refreshStatus(); sync(); }, 2000);
    return () => { view = null; };
  }

  /* ---------------- per-user popover ---------------- */
  function openUser(peer) {
    const api = modApi, sc = api.scope();
    api.modal.show({ title: 'Audio: ' + (peer.nickname || 'user'), onClose: () => sc.dispose(), render(body, close) {
      const { ui } = api, h = ui.h, rec = () => users()[peer.uid] || {}, edit = fn => editUser(peer, fn);
      if (!peer.uid) { body.append(ui.note('This user has no identity yet, so settings could not be saved for them.')); return; }
      const modeNote = h('div', { class: 'mods-note' });
      const goPer = ui.button({ label: 'Switch to per-speaker mode', onClick: () => patch({ mode: 'per_speaker', enabled: true }, true) });
      modeNote.append('Boost, bypass and custom AGC only work in per-speaker mode with the AGC switched on. ', goPer);

      const vol = ui.slider({ label: 'Volume', min: api.peers.range.min, max: api.peers.range.max, step: 0.5, unit: 'dB', value: 0, onInput: x => edit(r => { r.vol = x; }) });
      const volReset = ui.button({ label: 'Reset volume', kind: 'link', onClick: () => { edit(r => { delete r.vol; }); api.peers.getVolume(peer.schid, peer.id).then(v => vol.set(v)).catch(() => {}); } });
      const mute = ui.toggle({ title: 'Mute', sub: 'Silences this user for you (TeamSpeak\'s own local mute).', onChange: v => edit(r => { r.mute = v; }) });
      const boost = ui.slider({ label: 'Boost', min: 0, max: 24, step: 0.5, unit: 'dB', value: 0, onInput: x => edit(r => { if (x > 0) r.boost = x; else delete r.boost; }) });
      vol.el.setAttribute('data-key', 'vol'); boost.el.setAttribute('data-key', 'boost');
      const pills = [['', 'Global settings'], ['bypass', 'Bypass (no processing)'], ['custom', 'Custom']].map(([v, label]) => ({ v, b: ui.pill({ label, onClick: () => { edit(r => { if (v) r.agc = v; else delete r.agc; if (v === 'custom') r.params = r.params || {}; }); paint(); } }) }));
      pills.forEach(x => x.b.el.setAttribute('data-agc', x.v || 'default'));
      const rows = USER_KEYS.map(key => {
        const def = PARAMS.find(p => p[0] === key), cb = h('input', { type: 'checkbox', title: 'Use own value for this user' });
        const s = ui.slider({ label: def[1], min: def[2], max: def[3], step: def[4], unit: def[5], value: def[2], onInput: x => { cb.checked = true; edit(r => { r.params = Object.assign({}, r.params, { [key]: x }); }); } });
        cb.addEventListener('change', () => edit(r => { const p = Object.assign({}, r.params); if (cb.checked) p[key] = S.cfg ? S.cfg[key] : def[2]; else delete p[key]; r.params = p; }));
        return { key, cb, s, el: h('div', { class: 'aud-uparam', 'data-key': key }, cb, s.el) };
      });
      const custom = h('div', { class: 'aud-uparams' }, ui.note('Tick a value to give this user their own; unticked values follow the global settings.'), ...rows.map(x => x.el));
      const mIn = bar(h), mGr = bar(h), mLg = h('span', { class: 'aud-lg' }), ovr = h('span', { class: 'mods-pill ghost on aud-ovr' }, 'override active');
      const meters = h('div', { class: 'mods-meters aud-umeters' }, h('div', { class: 'mods-meter' }, h('span', { class: 'mods-meter-l' }, 'Level'), mIn.track, mIn.v), h('div', { class: 'mods-meter' }, h('span', { class: 'mods-meter-l' }, 'Gain reduction'), mGr.track, mGr.v), h('div', { class: 'mods-row' }, mLg, ovr));
      const resetAll = ui.button({ label: 'Reset everything for this user', kind: 'link', onClick: () => { edit(r => { for (const k of Object.keys(r)) if (k !== 'name') delete r[k]; }); paint(); api.peers.getVolume(peer.schid, peer.id).then(v => vol.set(v)).catch(() => {}); } });
      const done = ui.button({ label: 'Done', onClick: close });
      body.append(h('div', { class: 'aud-pop' }, modeNote,
        ui.section('Volume', vol.el, h('div', { class: 'mods-row' }, volReset), mute.el, boost.el,
          ui.note('Volume uses TeamSpeak\'s own range (up to +10 dB). Boost adds more on top, after processing, never louder than the ceiling.')),
        ui.section('AGC for this user', h('div', { class: 'mods-row' }, ...pills.map(x => x.b.el)), custom),
        ui.section('Live', meters), h('div', { class: 'mods-row' }, resetAll, done)));

      function paint() {
        const r = rec(), per = S.cfg && S.cfg.mode === 'per_speaker' && S.cfg.enabled;
        modeNote.hidden = !!per; meters.parentNode.hidden = !per;
        mute.set(!!r.mute); boost.set(r.boost || 0);
        pills.forEach(x => x.b.set((r.agc || '') === x.v)); custom.hidden = r.agc !== 'custom';
        rows.forEach(x => { const has = r.params && x.key in r.params; x.cb.checked = !!has; x.s.set(has ? r.params[x.key] : (S.cfg ? S.cfg[x.key] : 0)); });
      }
      (async () => { try { vol.set(rec().vol !== undefined ? rec().vol : await api.peers.getVolume(peer.schid, peer.id)); } catch (e) { /* not connected */ } })();
      paint();
      let busy = false;
      sc.interval(async () => {
        if (document.hidden || busy || !S || S.native !== 'ok') return; busy = true;
        try {
          const per = S.cfg && S.cfg.mode === 'per_speaker'; paint();
          if (per) { const m = (await sc.native.get('/speakers')).find(s => s.client_id === peer.id);
            mIn.set(m ? inPct(m.in_db) : 0, m ? inText(m.in_db) : '-', 'in'); mGr.set(m ? m.gain_reduction_db / 24 * 100 : 0, m ? m.gain_reduction_db.toFixed(1) + ' dB' : '-', 'gr');
            mLg.textContent = m ? 'Leveler gain ' + sign(m.leveler_gain_db) + ' dB' : 'Not talking'; ovr.hidden = !(m && m.override); }
        } catch (e) { /* native gone */ } finally { busy = false; }
      }, 150);
    } });
  }

  ts6mod.register({
    id: 'audio',
    title: 'Audio (AGC and per-user audio)',
    description: 'Automatic gain control for the voices you hear (leveler, compressor, limiter; whole stream or per speaker; presets and every parameter), per-user volume/mute/boost/AGC in the right-click menu, and the two stock TeamSpeak playback AGC options. Switching this mod off also switches the native AGC off.',
    async enable(api) {
      if (offPost) { await offPost; offPost = null; }   // a quick off->on must not read /config before the disable's post has landed
      modApi = api; S = { native: 'unknown', cfg: null, status: null, meters: null, speakers: [], stock: null, error: '' }; pending = null;
      try {   // vanilla rule: the native master switch follows the mod; the user's own choice is remembered here ("master")
        const cfg = await api.native.get('/config'); S.native = 'ok'; S.cfg = cfg;
        let m = api.storage.get('master'); if (m === undefined) { m = !!cfg.enabled; api.storage.set('master', m); }   // first run: adopt what the native config had
        if (!!cfg.enabled !== m) S.cfg = await api.native.post('/config', { enabled: m });
      } catch (e) { S.native = 'absent'; }
      api.contextMenu.client.add({ label: 'Audio...', icon: 'settings-audio', visible: t => !api.peers.target(t).self, onClick: t => { const p = api.peers.target(t); if (p.id != null) openUser(p); } });
      let cancel = () => {}; const later = () => { cancel(); cancel = api.timeout(syncPeers, 300); };
      api.peers.onChange(later); api.interval(syncPeers, 3000);
      syncPeers();
    },
    disable() {   // flush a debounced change, restore what we changed on users, switch the native AGC off (vanilla)
      cancelPend(); const a = modApi, p = pending; pending = null;
      if (a) {
        if (a.storage.get('master') === undefined && S && S.cfg) a.storage.set('master', !!S.cfg.enabled);
        clearPeers();
        /* ONE post, sent now: pending changes and the switch-off together (two chained posts left a request in flight after disable) */
        offPost = a.native.post('/config', Object.assign({}, p, { enabled: false })).catch(() => {});
      }
      modApi = S = view = null;
    },
    settings,
  });
})();

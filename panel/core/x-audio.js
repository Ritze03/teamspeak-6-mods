/* Core extension file of the `audio` mod (panel/mods/audio): every TeamSpeak name the mod needs, exposed as api.peers
 * (the other users on the connected servers and TeamSpeak's own per-user volume/mute), plus the one-shot "vanilla at
 * start" guard for the native AGC. Docs: superdoc/features/agc.md. Nothing here runs until a mod calls it; resources go
 * through track()/api.events (the calling mod's ledger). */
(function (boot) {
  'use strict';
  const A = boot.anchors, core = boot.core;

  A.def('audio.volume', 'bridge: tsclient_internal.get/setClientVolumeModifier(schid, clientId, dB, persist) (per-user volume; set has no callback)', () => typeof window.tsclient_internal.setClientVolumeModifier === 'function' && typeof window.tsclient_internal.getClientVolumeModifier === 'function');
  A.def('audio.mute', 'bridge: tsclient_internal.requestSetClientsMute(schid, [clientId], bool, cb) (local per-user mute) + client.properties.isMuted', () => typeof window.tsclient_internal.requestSetClientsMute === 'function');
  A.def('audio.peers', 'displayed connections: serverConnectionHandler.GetFlatListClients() yields {id, uid, nickname, properties}', () => { const h = A.get('app.connections')[0]?.serverConnectionHandler; return !h || typeof h.GetFlatListClients === 'function'; }, true);

  /* the stock per-user fader runs from +10 dB down to mute (-200); the slider range we offer stays inside the usable part */
  const RANGE = { min: -40, max: 10 };
  const handlers = () => A.state.handlers().filter(h => h.connectionStatus === 4);
  const find = (schid, id) => { const h = handlers().find(x => String(x.id) === String(schid)); return h && [...h.GetFlatListClients()].find(c => c.id === id); };

  boot.core.coreApi('peers', (api, track, anchors) => ({
    range: RANGE,
    /* a context-menu target (api.contextMenu.client) -> {schid, id, uid, nickname, self} */
    target(t) {
      const m = (t && t.model) || {}, h = handlers().find(x => String(x.id) === String(t && t.schid));
      return { schid: t && t.schid, id: m.id != null ? m.id : t && t.id, uid: m.uid || '', nickname: m.nickname || (t && t.name) || '', self: !!h && m.id === h.ownClientId };
    },
    /* every user on every established connection: [{schid, id, uid, nickname, self, muted, sameChannel}] */
    list() {
      const out = [];
      for (const h of handlers()) for (const c of h.GetFlatListClients()) out.push({ schid: h.id, id: c.id, uid: c.uid || '', nickname: c.nickname || '', self: c.id === h.ownClientId, muted: !!(c.properties && c.properties.isMuted),
        sameChannel: !!(c.channel && h.ownClient && h.ownClient.channel && c.channel.id === h.ownClient.channel.id) });
      return out;
    },
    /* cb() whenever users may have appeared/left/changed or a connection came or went (undone with the calling mod) */
    onChange(cb) {
      const offs = ['clientMoved', 'connectStatusChanged', 'clientPropertiesUpdated'].map(n => api.events.on(n, cb));
      return () => offs.forEach(f => f());
    },
    /* stock per-user volume in dB; persist=false: this session only (the client's own saved value stays) */
    setVolume: (schid, id, db) => anchors.bridge.call('setClientVolumeModifier', schid, id, db, false),
    getVolume: async (schid, id) => { const v = await anchors.bridge.call('getClientVolumeModifier', schid, id); return typeof v === 'number' ? v : 0; },
    /* the stock local mute of a user (same as the right-click mute) */
    async setMuted(schid, id, on) {
      await anchors.bridge.call('requestSetClientsMute', schid, [id], !!on);
      const c = find(schid, id); if (c && c.properties) c.properties.isMuted = !!on;
    },
  }));

  /* TeamSpeak's stock playback AGC (per output device `agc`, global `agcExperimentalMode`), used by the audio mod's "AGC"
   * dropdown: api.stockAgc.read() -> {device, agc, experimental} | null (settings model not available: not connected);
   * write({agc?, experimental?, device?}) goes through the same setters as the stock toggles (persisted with save();
   * `device` defaults to the active output device). Only changed values are written: the experimental flag reopens the
   * playback stream (short glitch). Why per device: the stock `agc` toggle belongs to the device in the `devices` map. */
  const outSettings = () => A.tryGet('audio.settings');
  const deviceMode = (s, id) => { for (const [mode, list] of s[0].devices) if (list.some(e => e[0].id === id)) return mode; return null; };
  boot.core.coreApi('stockAgc', () => { const impl = {
    read() {
      const s = outSettings(); if (!s) return null;
      try { const b = s.buildPlaybackDspBlob(), id = s[0].device && s[0].device.id; return b && id ? { device: id, agc: !!b.agc, experimental: !!b.agc_experimental_mode } : null; } catch (e) { return null; }
    },
    write(o) {
      const s = outSettings(); if (!s) throw new Error('audio settings unavailable');
      const cur = impl.read(); let dirty = false;
      if (o.agc !== undefined) {
        const id = o.device || (cur && cur.device), mode = id && deviceMode(s, id);
        if (mode == null) throw new Error('output device not found');
        if (!(cur && cur.device === id && cur.agc === !!o.agc)) { s.onAudioDspSettingsChanged({ io: 0, settings: { mode, deviceId: id, agc: !!o.agc } }); dirty = true; }
      }
      if (o.experimental !== undefined && !(cur && cur.experimental === !!o.experimental)) {
        s[0].global.agcExperimentalMode = !!o.experimental;
        A.get('app.connections').forEach(c => c.serverConnectionHandler.audio.Update());   // pushes agc_experimental_mode (reopens the stream)
        dirty = true;
      }
      if (dirty) s.save();
    },
  }; return impl; });

  /* Vanilla rule at client start: with the audio mod switched off the native AGC must be off too, but a mod that is off runs
   * no code. This one-shot (a core file, so it loads regardless of the mod switch) turns a still-enabled native AGC off.
   * It waits for the core to be started (blob loaded) so it knows whether the mod is on; at most once per page load. */
  (async function vanillaGuard() {
    try {
      for (let i = 0; i < 120 && !core.started; i++) await new Promise(r => setTimeout(r, 500));
      if (!core.started || core.store().enabled.audio || !core.mods().has('audio') || typeof window.ts6modNative !== 'function') return;
      const led = core.makeLedger(), api = core.makeApi({ id: '(audio-guard)', scopes: new Set() }, led);   // a throw-away api only for api.native
      try {
        const cfg = await api.native.get('/config');
        if (cfg && cfg.enabled && !core.store().enabled.audio) await api.native.post('/config', { enabled: false });
      } finally { led.dispose(); }
    } catch (e) { /* native module absent: nothing to guard */ }
  })();
})(window.__ts6modBoot);

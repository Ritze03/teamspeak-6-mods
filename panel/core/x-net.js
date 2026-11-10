/* Core extension file of the `net` mod (connection quality HUD). The only place the net mod's TeamSpeak names live: the
 * bridge call behind connection statistics, the connection/channel/server property paths and the popover surface colour.
 * Adds `api.net` to every mod's api. Docs: superdoc/features/mod-net.md. */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  A.def('net.requestConnectionInfo', 'bridge: tsclient_internal.requestConnectionInfo(schid, clientId, cb(status, stats))', () => typeof window.tsclient_internal.requestConnectionInfo === 'function');
  A.def('net.ownClientId', 'displayed connection handler exposes ownClientId and connectionStatus', () => { const h = A.get('app.connections')[0]?.serverConnectionHandler; return !h || ('ownClientId' in h && 'connectionStatus' in h); }, true);

  let requests = 0;   // statistics requests sent since page load (test hook: "no polling while off")
  Object.defineProperty(window, '__ts6modNetRequests', { configurable: true, get: () => requests });

  const CODECS = { 0: 'Speex narrowband', 1: 'Speex wideband', 2: 'Speex ultra-wideband', 3: 'CELT mono', 4: 'Opus voice', 5: 'Opus music' };
  const num = v => (typeof v === 'number' && isFinite(v) ? v : null);

  boot.core.coreApi('net', (api, track, anchors) => {
    const handler = () => { try { const h = anchors.state.current(); return h && h.connectionStatus === 4 ? h : null; } catch (e) { return null; } };
    return {
      /* true while the displayed connection is established */
      connected: () => !!handler(),
      /* one statistics request for the displayed connection -> normalised sample or null (not connected / failed).
         ping ms, loss % (worst of both directions and the total), bandwidth bytes/s (last second), jitter ms */
      async poll() {
        const h = handler(); if (!h) return null;
        requests++;
        let s;
        try { s = await anchors.bridge.call('requestConnectionInfo', h.id, h.ownClientId); } catch (e) { return null; }
        if (!s || typeof s !== 'object') return null;
        const frac = [s.packetlossTotal, s.client2serverPacketlossTotal, s.server2clientPacketlossTotal].map(num).filter(v => v !== null);
        return {
          t: Date.now(),
          ping: num(s.ping), jitter: num(s.pingDeviation),
          loss: frac.length ? Math.max(...frac) * 100 : null,   // the client reports a 0..1 fraction
          lossUp: num(s.client2serverPacketlossTotal) !== null ? s.client2serverPacketlossTotal * 100 : null,
          lossDown: num(s.server2clientPacketlossTotal) !== null ? s.server2clientPacketlossTotal * 100 : null,
          bwIn: num(s.bandwidthReceivedLastSecondTotal), bwOut: num(s.bandwidthSentLastSecondTotal),
        };
      },
      /* static-ish facts about the displayed connection: server version/platform, own channel's codec/quality */
      meta() {
        const h = handler(); if (!h) return null;
        const sp = h.properties || {}, c = h.ownClient && (h.ownClient.m_channel || h.ownClient.channel), cp = (c && c.properties) || {};
        return {
          serverVersion: sp.version || null, serverPlatform: sp.platform || null,
          channelName: c ? c.displayName || null : null,
          codecId: num(cp.codec), codec: num(cp.codec) !== null ? CODECS[cp.codec] || 'codec ' + cp.codec : null, quality: num(cp.codecQuality),
        };
      },
      /* surface colours for a popover that matches the active theme (default and custom) */
      theme: () => ({ bg: 'var(--ts-context-menu-background, #1b1e27)', line: 'var(--ts-divider-bg-color, rgba(128,128,128,.3))' }),
    };
  });
})(window.__ts6modBoot);

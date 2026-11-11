/* Core extension file of the `net` mod (connection quality HUD). The only place the net mod's TeamSpeak names live: the
 * bridge call behind connection statistics, the connection/channel/server property paths and the popover surface colour.
 * Adds `api.net` to every mod's api. Docs: superdoc/features/mod-net.md. */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  A.def('net.requestConnectionInfo', 'bridge: tsclient_internal.requestConnectionInfo(schid, clientId, cb(status, stats))', () => typeof window.tsclient_internal.requestConnectionInfo === 'function');
  A.def('net.ownClientId', 'displayed connection handler exposes ownClientId and connectionStatus', () => { const h = A.get('app.connections')[0]?.serverConnectionHandler; return !h || ('ownClientId' in h && 'connectionStatus' in h); }, true);

  /* bottom bar of the server pane; its right group (.ts-server-informative-buttons: connection status + server events) is counted
     by the bar's own auto-collapse (isSmall = bar < label copy + right group), so a node placed in it never overlaps the left button */
  const rightGroups = () => A.$$('.ts-server-status-bar > .ts-server-informative-buttons');
  A.def('net.statusBar', 'server pane bottom bar right group: .ts-server-status-bar > .ts-server-informative-buttons (stock connection status + events)', () => rightGroups()[0], true);

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
        /* Why the timeout: the client sometimes never calls the callback back (dead handler during a reconnect / server switch); without a
           deadline the awaiting tick would hang forever and the HUD would freeze on its last values. */
        let timer;
        try { s = await Promise.race([anchors.bridge.call('requestConnectionInfo', h.id, h.ownClientId), new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('timeout')), 5000); })]); } catch (e) { return null; } finally { clearTimeout(timer); }
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
      /* bottom bar of the shown server pane: mount(el) keeps el as the first item of the stock network-status group (re-placed when
         the client rebuilds the bar, e.g. on a server or view switch); returns remove().
         el gets a max-width = what the bar has left with the Create Channel button collapsed (44 px reserve, 0 when it is hidden) and
         the stock items beside it, so a narrow pane clips el (it wraps and drops trailing parts) instead of pushing the stock items out.
         Why not let the group shrink: the bar's own collapse compares its width to the group's width, a shrinking group would never
         trigger it. */
      bottomBar: {
        available: () => rightGroups().length > 0,
        mount(el) {
          let bar = null;
          const ro = new ResizeObserver(() => fit());
          const fit = () => {
            const g = el.parentElement; if (!g || !bar || !g.isConnected) return;
            const cs = getComputedStyle(bar), es = getComputedStyle(el);
            const outer = bar.clientWidth - parseFloat(cs.paddingLeft) - parseFloat(cs.paddingRight);
            const cc = bar.querySelector(':scope > .ts-server-status-constructive-buttons:not(.ts-hidden)');
            const reserve = cc && cc.getClientRects().length ? 44 : 0;
            const others = g.getBoundingClientRect().width - el.getBoundingClientRect().width - parseFloat(es.marginLeft) - parseFloat(es.marginRight);
            const mw = Math.max(0, Math.floor(outer - reserve - others)) + 'px';
            if (el.style.maxWidth !== mw) el.style.maxWidth = mw;
          };
          const put = () => {
            const g = rightGroups().find(x => x.offsetParent) || rightGroups()[0];
            if (g && (el.parentElement !== g || g.firstElementChild !== el)) g.prepend(el);
            if (g && g.parentElement !== bar) { ro.disconnect(); bar = g.parentElement; ro.observe(bar); [...bar.children].forEach(c => ro.observe(c)); }   // children too: the Create Channel group can be hidden by another mod
            fit();
          };
          const unRo = track('net-bottom-fit', () => { ro.disconnect(); el.style.maxWidth = ''; });
          put();
          const un = api.onDom(put, { debounce: 60 });
          return () => { un(); unRo(); el.remove(); };
        },
      },
      /* surface colours for a popover that matches the active theme (default and custom) */
      theme: () => ({ bg: 'var(--ts-context-menu-background, #1b1e27)', line: 'var(--ts-divider-bg-color, rgba(128,128,128,.3))' }),
    };
  });
})(window.__ts6modBoot);

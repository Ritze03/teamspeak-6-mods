/* Core extension for the "aware" mod (panel/mods/aware/): everything TS-specific it needs, as api.aware.
 * Docs: superdoc/features/mod-aware.md. Owned by the aware mod; anything generally useful may be promoted into anchors.js/slots.js.
 *
 *   api.aware.schid()                      id of the displayed server connection (or null)
 *   api.aware.channelOfClient(id)          channel id (string) of a client of the displayed connection
 *   api.aware.onTalk(cb(clientId, on))     talk start/stop of the displayed connection (whispers ignored); also fed by the test hook
 *   api.aware.talkers()                    [clientId] currently flagged as talking (seed for onTalk)
 *   api.aware.onActivity(cb(entry))        join / leave / move / disconnect / timeout / kick / ban entries, see below
 *   api.aware.expandedClients()            [{schid, id}] clients whose channel row is visible in the tree (every ancestor expanded), not ourselves
 *   api.aware.requestInfo(schid, clientId) ONE bridge request (counted in stats); stores the answer's idle time
 *   api.aware.idleMs(clientModel)          last polled idle time of that client in ms (grows with the age of the answer), or null
 *   api.aware.stats()                      {requests}: how many bridge requests api.aware.requestInfo ever issued (test observable)
 *   api.aware.toolbar.rect() / .contains(node)  bounding rect of the top bar, whether a node is inside it
 *   api.aware.skin()                       CSS string: popup background/text from the theme's own context-menu variables
 *   api.aware.cleanup(fn)                  run fn when the calling mod (or scope) is disabled
 * Test hooks: window.__ts6modBoot.aware.talk(clientId, status) feeds the same path as a real talkStatusChanged; .setCollapsed(bool) collapses/restores all
 * channel rows; .p2Driver is the source of a driver for a second plain client (see below). */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  const stats = { requests: 0 };
  const talkSubs = new Set();           // test hook delivery
  const idle = new Map();               // `${schid}:${clientId}` -> {ms, at}
  const saved = new Map();   // channel -> collapsed flag before setCollapsed(true)
  boot.aware = {
    talk: (clientId, status) => talkSubs.forEach(f => f(clientId, !!status)), stats,
    setCollapsed(on) {   // test hook: collapse every channel in the tree (on) or put the flags back (off)
      const h = A.state.current(); if (!h) return 0; let n = 0;
      for (const c of h.GetFlatListChannels()) { if (on) { if (!saved.has(c)) saved.set(c, c.treeCollapsed); c.treeCollapsed = true; n++; } else if (saved.has(c)) { c.treeCollapsed = saved.get(c); saved.delete(c); n++; } }
      return n;
    },
  };

  /* Test support: source of a small driver that test.mjs evaluates in a SECOND, plain client (reached over its own CDP port) to
   * join, move and leave the server; test files may not name TS internals, so the TS calls live here. Not used by the mod. */
  boot.aware.p2Driver = `(() => {
    const ac = () => document.querySelector('#app').__vue__.appController;
    const live = () => ac().connections.find(c => c.serverConnectionHandler && c.serverConnectionHandler.connectionStatus === 4);
    window.__awareP2 = {
      connect(nick, port) {
        const a = ac(); a.welcomeDisplayed = true; a.connections.slice().forEach(c => a.closeConnection(c));
        const c = a.openConnection({ address: '127.0.0.1', port, nickname: nick, phonetic_nickname: '', identity: '', server_password: '', default_channel: '/', default_channel_password: '', default_channel_id: '0', sound_pack: '', show_serverquery_clients: false, send_mytsid: true, announce_to_chat: false, connect_muted: false, connectTime: 0 });
        a.showItem(c); return true;
      },
      status() { const c = live(); if (!c) return null; const h = c.serverConnectionHandler, me = [...h.GetFlatListClients()].find(x => x.id === h.ownClientId); return { id: h.ownClientId, schid: h.id, nick: me ? (me.nickname || (me.properties && me.properties.nickname) || '') : '' }; },
      channels() { const c = live(); return c ? [...c.serverConnectionHandler.GetFlatListChannels()].map(x => ({ id: String(x.id), name: x.properties.name })) : []; },
      move(cid) { const h = live().serverConnectionHandler; tsclient_internal.requestClientMove(h.id, [h.ownClientId], String(cid), '', () => {}); return true; },   // fire and forget too: a CDP-awaited bridge promise gets collected
      disconnect() { const was = !!live(); for (const c of ac().connections.slice()) { const h = c.serverConnectionHandler; if (h && h.connectionStatus !== 0) tsclient_internal.stopConnection(h.id, 'bye', () => {}); setTimeout(() => ac().closeConnection(c), 1500); } return was; },   // fire and forget: awaiting the callback loses the CDP promise
    };
    return true;
  })()`;

  A.def('aware.requestInfo', 'bridge requestConnectionInfo(schid, clientId, cb(status, info)): info.idleTime is the client idle time in ms', () => typeof window.tsclient_internal !== 'undefined' && typeof window.tsclient_internal.requestConnectionInfo === 'function');
  A.def('aware.channelCollapsed', 'channel model flag treeCollapsed (true = collapsed in the tree), channel.parent chain', () => { const h = A.state.handlers()[0]; const c = h && [...h.GetFlatListChannels()][0]; return c && 'treeCollapsed' in c; }, true);

  const handler = schid => A.state.handlers().find(h => h.id === schid);
  const curHandler = () => A.state.current();
  const chName = (h, id) => { if (!h) return '#' + id; const c = [...h.GetFlatListChannels()].find(c => String(c.id) === String(id)); return c && c.properties && c.properties.name || '#' + id; };

  boot.core.coreApi('aware', (api, track) => ({
    schid: () => { const h = curHandler(); return h ? h.id : null; },
    channelOfClient(id) { const h = curHandler(); if (!h) return null; for (const c of h.GetFlatListClients()) if (c.id === id) return c.channel ? String(c.channel.id) : null; return null; },
    talkers() { const h = curHandler(); return h ? [...h.GetFlatListClients()].filter(c => c.properties.flagTalking).map(c => c.id) : []; },
    onTalk(cb) {
      const on = (id, v) => cb(id, v);
      api.events.on('talkStatusChanged', e => { if (e.isWhisper) return; const h = curHandler(); if (e.connectionId != null && h && e.connectionId !== h.id) return; cb(e.clientId, !!e.status); });
      talkSubs.add(on); return track('aware-talk-hook', () => talkSubs.delete(on));
    },
    onActivity(cb) {
      const nicks = new Map(), where = new Map();   // `${schid}:${clientId}` -> nickname / last known channel id
      for (const h of A.state.handlers()) for (const c of h.GetFlatListClients()) { nicks.set(h.id + ':' + c.id, c.nickname); if (c.channel) where.set(h.id + ':' + c.id, String(c.channel.id)); }
      return api.events.on('clientMoved', e => {
        if (e.hotReload) return;
        const h = handler(e.connectionId), key = e.connectionId + ':' + e.clientId, nw = String(e.newChannelId), old = String(e.oldChannelId);
        const model = h && [...h.GetFlatListClients()].find(c => c.id === e.clientId);
        if (model) nicks.set(key, model.nickname); else if (e.properties && e.properties.nickname) nicks.set(key, e.properties.nickname);
        const nick = nicks.get(key) || '#' + e.clientId, self = !!(h && h.ownClientId === e.clientId);
        let kind, from = null, to = null;
        if (nw === '0') {   // left the server: timeout (3), kick (5), ban (6), else a plain disconnect
          kind = e.type === 3 ? 'timeout' : e.type === 5 ? 'kick' : e.type === 6 ? 'ban' : 'disconnect'; from = chName(h, where.get(key) || old); where.delete(key); nicks.delete(key);
        } else if (old === '0') {   // appeared: a new connection, or a known client that moved in from a channel we had no view of
          const was = where.get(key); kind = was ? 'move' : 'join'; from = was ? chName(h, was) : null; to = chName(h, nw); where.set(key, nw);
        } else { kind = 'move'; from = chName(h, old); to = chName(h, nw); where.set(key, nw); }
        cb({ schid: e.connectionId, clientId: e.clientId, kind, nick, from, to, reason: e.message || '', self });
      });
    },
    expandedClients() {
      const h = curHandler(); if (!h) return [];
      const shown = ch => { for (let c = ch; c; c = c.parent) if (c.treeCollapsed) return false; return true; };
      return [...h.GetFlatListClients()].filter(c => c.id !== h.ownClientId && c.channel && shown(c.channel)).map(c => ({ schid: h.id, id: c.id }));
    },
    async requestInfo(schid, clientId) {
      stats.requests++;
      const info = await A.bridge.call('requestConnectionInfo', schid, clientId);
      if (info && typeof info.idleTime === 'number') idle.set(schid + ':' + clientId, { ms: info.idleTime, at: Date.now() });
      return info;
    },
    idleMs(model) { const e = idle.get((model.sc_handler && model.sc_handler.id) + ':' + model.id); return e ? e.ms + (Date.now() - e.at) : null; },
    stats: () => Object.assign({}, stats),
    toolbar: { rect: () => { const t = A.tryGet('dom.toolbar'); return t ? t.getBoundingClientRect() : null; }, contains: n => !!(n && n.closest && n.closest('.tsv-central-toolbar')) },   // the top bar: where to anchor a popup / whether a press landed on it
    skin: () => '.aware-pop { background: var(--ts-context-menu-background, #1b2030); color: var(--ts-context-menu-font-color, var(--mods-fg)); backdrop-filter: blur(8px); }',   // popup surface of the active theme (same as its context menus)
    cleanup: fn => track('aware-cleanup', fn),
    forget: () => idle.clear(),
  }));
})(window.__ts6modBoot);

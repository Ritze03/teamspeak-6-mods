/* Core extension for the "aware" mod (panel/mods/aware/): everything TS-specific it needs, as api.aware.
 * Docs: superdoc/features/mod-aware.md. Owned by the aware mod; anything generally useful may be promoted into anchors.js/slots.js.
 *
 *   api.aware.schid()                      id of the displayed server connection (or null)
 *   api.aware.onActivity(cb(entry))        join / leave / move / disconnect / timeout / kick / ban entries, see below
 *   api.aware.expandedClients()            [{schid, id}] clients whose channel row is visible in the tree (every ancestor expanded), not ourselves
 *   api.aware.otherRows()                  [{schid, id}] client rows rendered right now (on screen) that are not in my channel, not
 *                                          ourselves, and not flagged talking by the client itself (whose talk status the client does not know)
 *   api.aware.requestInfo(schid, clientId) ONE bridge request (counted in stats, 5 s timeout, null while one is in flight for that client); stores the answer's idle time
 *   api.aware.idleMs(clientModel)          last polled idle time of that client in ms (grows with the age of the answer), or null
 *   api.aware.answer(schid, clientId)      {ms, at} raw last answer (idle ms, answer time) or null
 *   api.aware.askedAt(schid, clientId)     time the last request for that client went out (0 = never)
 *   api.aware.markTalking(fn(schid, id))   colour the stock talk circle of other-channel clients for which fn returns true (stock
 *                                          "talking" class on the row's icon, plus our own marker class); returns {sync()}; disposed with the scope
 *   api.aware.stats()                      {requests}: how many bridge requests api.aware.requestInfo ever issued (test observable)
 *   api.aware.toolbar.rect() / .contains(node)  bounding rect of the top bar, whether a node is inside it
 *   api.aware.skin()                       CSS string: popup background/text from the theme's own context-menu variables
 *   api.aware.cleanup(fn)                  run fn when the calling mod (or scope) is disabled
 * Test hooks: window.__ts6modBoot.aware.setCollapsed(bool) collapses/restores all
 * channel rows; .circle(clientId) -> null (no row on screen) | {talking, marked, stock} state of that client's talk circle; .marks() [{id, stock, mine}] of the
 * rows carrying our mark; .p2Driver is the source of a driver for a second plain client (see below). */
(function (boot) {
  'use strict';
  const A = boot.anchors;
  const stats = { requests: 0 };
  const idle = new Map();               // `${schid}:${clientId}` -> {ms, at}
  const inflight = new Set();           // keys with a request on its way
  const REQUEST_TIMEOUT = 5000;         // ms; a lost callback is given up after this
  const asked = new Map();              // `${schid}:${clientId}` -> time the last request went out
  /* Talk circle: the client row's icon stack carries the class "talking" while the client model's properties.flagTalking is set
   * (computed cssClasses); its CSS then shows the talking arcs in the theme's colour. MARK tells our additions apart from the stock ones. */
  const ICON = '.tsv-server-tree-icon', TALK = 'talking', MARK = 'aware-talk';
  /* Can this client be talking right now? Per-client model properties (known for other channels too): inputMuted (mic muted),
   * inputHardware (false = no mic), inputDeactivated (mic deactivated), away. Not outputMuted (speakers off: mic still works, outputOnlyMuted
   * is that case), not isTalker (talk power grant: false for almost everyone, true talk-power is per channel and not derivable). */
  const canTalk = m => { const p = m.properties; return !p.inputMuted && p.inputHardware !== false && !p.inputDeactivated && !p.away; };
  const iconOf = row => row.querySelector(ICON);
  const saved = new Map();   // channel -> collapsed flag before setCollapsed(true)
  boot.aware = {
    stats,
    circle(id) { const r = A.tree.rows('client').find(r => r.model.id === id); const ic = r && iconOf(r.row); return ic ? { talking: ic.classList.contains(TALK), marked: ic.classList.contains(MARK), stock: !!r.model.properties.flagTalking } : null; },
    marks() {   // [{id, stock, mine}] of every row icon carrying our mark: stock = the client itself says talking, mine = in my channel or myself
      const h = A.state.current(), own = h && h.ownClient && h.ownClient.channel ? String(h.ownClient.channel.id) : null;
      return [...document.querySelectorAll('.' + MARK)].map(ic => { const row = ic.closest('.ts-server-tree-item-leaf'), r = A.tree.rows('client').find(x => x.row === row), m = r && r.model; return { id: m ? m.id : null, stock: !!(m && m.properties.flagTalking), mine: !!(m && h && (m.id === h.ownClientId || (m.channel && String(m.channel.id) === own))) }; });
    },
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
        const c = a.openConnection({ address: '127.0.0.1', port, nickname: nick, phonetic_nickname: '', identity: '', server_password: '', default_channel: '/', default_channel_password: '', default_channel_id: '0', sound_pack: '', show_serverquery_clients: false, send_mytsid: true, announce_to_chat: false, connect_muted: true, connectTime: 0 });
        a.showItem(c); return true;
      },
      status() { const c = live(); if (!c) return null; const h = c.serverConnectionHandler, me = [...h.GetFlatListClients()].find(x => x.id === h.ownClientId); return { id: h.ownClientId, schid: h.id, nick: me ? (me.nickname || (me.properties && me.properties.nickname) || '') : '' }; },
      channels() { const c = live(); return c ? [...c.serverConnectionHandler.GetFlatListChannels()].map(x => ({ id: String(x.id), name: x.properties.name })) : []; },
      quiet() { const h = live().serverConnectionHandler, p = h.ownClient.properties, bs = document.querySelector('.tsv-central-toolbar').__vue__.buttons || []; if (!p.inputMuted) bs.find(b => /^microphone/.test(b.image)).onSelected(); if (!p.outputMuted) bs.find(b => /^speaker/.test(b.image)).onSelected(); return true; },   // mic and speakers off: a test client never picks up or plays real audio
      say(text) { const h = live().serverConnectionHandler; tsclient_internal.requestSendChannelTextMsg(h.id, text, '0', () => {}); return true; },   // a channel message resets idle time on the server
      move(cid) { const h = live().serverConnectionHandler; tsclient_internal.requestClientMove(h.id, [h.ownClientId], String(cid), '', () => {}); return true; },   // fire and forget too: a CDP-awaited bridge promise gets collected
      disconnect() { const was = !!live(); for (const c of ac().connections.slice()) { const h = c.serverConnectionHandler; if (h && h.connectionStatus !== 0) tsclient_internal.stopConnection(h.id, 'bye', () => {}); setTimeout(() => ac().closeConnection(c), 1500); } return was; },   // fire and forget: awaiting the callback loses the CDP promise
    };
    return true;
  })()`;

  A.def('aware.requestInfo', 'bridge requestConnectionInfo(schid, clientId, cb(status, info)): info.idleTime is the client idle time in ms', () => typeof window.tsclient_internal !== 'undefined' && typeof window.tsclient_internal.requestConnectionInfo === 'function');
  A.def('aware.talkCircle', 'client row icon (' + ICON + ') gets the class "' + TALK + '" while the client talks (model cssClasses from properties.flagTalking)', () => { const r = A.tree.rows('client')[0]; return !r || !!iconOf(r.row); }, true);
  A.def('aware.channelCollapsed', 'channel model flag treeCollapsed (true = collapsed in the tree), channel.parent chain', () => { const h = A.state.handlers()[0]; const c = h && [...h.GetFlatListChannels()][0]; return c && 'treeCollapsed' in c; }, true);

  const handler = schid => A.state.handlers().find(h => h.id === schid);
  const curHandler = () => A.state.current();
  const chName = (h, id) => { if (!h) return '#' + id; const c = [...h.GetFlatListChannels()].find(c => String(c.id) === String(id)); return c && c.properties && c.properties.name || '#' + id; };

  boot.core.coreApi('aware', (api, track) => ({
    schid: () => { const h = curHandler(); return h ? h.id : null; },
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
    otherRows() {
      const h = curHandler(); if (!h) return [];
      const mine = h.ownClient && h.ownClient.channel ? String(h.ownClient.channel.id) : null;
      return A.tree.rows('client').map(r => r.model).filter(m => m.id !== h.ownClientId && m.channel && String(m.channel.id) !== mine && !m.properties.flagTalking && canTalk(m)).map(m => ({ schid: h.id, id: m.id }));
    },
    markTalking(fn) {
      const sync = () => {
        const h = curHandler(), mine = h && h.ownClient && h.ownClient.channel ? String(h.ownClient.channel.id) : null;
        for (const { row, model } of A.tree.rows('client')) {
          const ic = iconOf(row); if (!ic) continue;
          const stock = !!model.properties.flagTalking;   // the client knows the real status: never touch it
          let want = false;
          if (h && !stock && canTalk(model) && model.id !== h.ownClientId && model.channel && String(model.channel.id) !== mine) { try { want = !!fn(h.id, model.id); } catch (e) { want = false; } }
          if (want) { if (!ic.classList.contains(MARK) || !ic.classList.contains(TALK)) ic.classList.add(TALK, MARK); }
          else if (ic.classList.contains(MARK)) { ic.classList.remove(MARK); if (!stock) ic.classList.remove(TALK); }
        }
        // marks on recycled rows the walk above did not reach (no model) go too
        for (const ic of document.querySelectorAll('.' + MARK)) { const row = ic.closest('.ts-server-tree-item-leaf'); if (!row || !A.tree.rows('client').some(r => r.row === row)) { ic.classList.remove(MARK, TALK); } }
      };
      const later = () => api.timeout(sync, 80);   // after Vue re-rendered the row (it rewrites the class attribute)
      api.onDom(sync, { debounce: 60 });
      for (const n of ['talkStatusChanged', 'clientPropertiesUpdated', 'clientMoved', 'clientSelfPropertyUpdated']) api.events.on(n, later);   // property events re-sync marks at once (mic mute, away)
      track('aware-talk-marks', () => {
        for (const ic of document.querySelectorAll('.' + MARK)) {
          const row = ic.closest('.ts-server-tree-item-leaf'), r = row && A.tree.rows('client').find(x => x.row === row);
          ic.classList.remove(MARK); if (!(r && r.model.properties.flagTalking)) ic.classList.remove(TALK);
        }
      });
      sync();
      return { sync };
    },
    answer(schid, clientId) { return idle.get(schid + ':' + clientId) || null; },
    askedAt: (schid, clientId) => asked.get(schid + ':' + clientId) || 0,
    async requestInfo(schid, clientId) {
      const key = schid + ':' + clientId;
      if (inflight.has(key)) return null;   // one request per client at a time
      inflight.add(key); stats.requests++; asked.set(key, Date.now());
      try {
        // A bridge call can occasionally never call back: race a timeout so one lost callback cannot freeze the poller (same guard as x-net.js:poll)
        const info = await Promise.race([A.bridge.call('requestConnectionInfo', schid, clientId), new Promise(res => setTimeout(() => res(null), REQUEST_TIMEOUT))]);
        if (info && typeof info.idleTime === 'number') idle.set(key, { ms: info.idleTime, at: Date.now() });
        return info;
      } finally { inflight.delete(key); }
    },
    idleMs(model) { const e = idle.get((model.sc_handler && model.sc_handler.id) + ':' + model.id); return e ? e.ms + (Date.now() - e.at) : null; },
    stats: () => Object.assign({}, stats),
    toolbar: { rect: () => { const t = A.tryGet('dom.toolbar'); return t ? t.getBoundingClientRect() : null; }, contains: n => !!(n && n.closest && n.closest('.tsv-central-toolbar')) },   // the top bar: where to anchor a popup / whether a press landed on it
    skin: () => '.aware-pop { background: var(--ts-context-menu-background, #1b2030); color: var(--ts-context-menu-font-color, var(--mods-fg)); backdrop-filter: blur(8px); }',   // popup surface of the active theme (same as its context menus)
    cleanup: fn => track('aware-cleanup', fn),
    forget: () => { idle.clear(); asked.clear(); },
  }));
})(window.__ts6modBoot);

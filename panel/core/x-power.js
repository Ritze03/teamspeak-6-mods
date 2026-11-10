/* Core extension of the "power" mod (panel/mods/power): every TeamSpeak name the mod needs, exposed as api.power.
 * Docs: superdoc/features/mod-power.md. Mechanism notes are there too ("Why" and "Mechanism"). Nothing here runs until
 * a mod calls it; the only resources are registered through track() in the calling mod's ledger. */
(function (boot) {
  'use strict';
  const A = boot.anchors, core = boot.core;

  /* ---------- anchors (health-checked by run-all like the built-in ones) ---------- */
  A.def('power.connections', 'connection activities: appController.connections, each with .serverConnectionHandler', () => { const c = A.get('app.connections'); return c && typeof A.get('app.controller').showItem === 'function' && c; });
  A.def('power.workflowSettings', 'appController.workflowSettings + applyWorkflowSettings(patch) (hidden developer toggles)', () => { const a = A.get('app.controller'); return a.workflowSettings && typeof a.applyWorkflowSettings === 'function'; });
  A.def('power.appearanceSettings', 'appController.appearanceSettings + applyAppearanceSettings(patch) (hidden developer toggles)', () => { const a = A.get('app.controller'); return a.appearanceSettings && typeof a.applyAppearanceSettings === 'function'; });
  A.def('power.hideSidebarTabs', 'appController.hideSidebarTabs (hidden developer toggle "combined sidebar tabs")', () => typeof A.get('app.controller').hideSidebarTabs === 'boolean');
  A.def('power.toolButtons', 'central toolbar items (image "microphone[-slash]" / "speaker[-slash]", the icon changes with the mute state) with onSelected: the mute toggles', () => { const t = A.tryGet('dom.toolbar'); const b = t && t.__vue__.buttons; return Array.isArray(b) && b.some(x => /^microphone/.test(x.image)) && b.some(x => /^speaker/.test(x.image)); });
  A.def('power.bridgeMove', 'tsclient_internal.requestClientMove (channel join)', () => typeof window.tsclient_internal.requestClientMove === 'function');

  /* ---------- clipboard ---------- */
  async function copy(text) {
    text = String(text);
    try { if (navigator.clipboard && navigator.clipboard.writeText) { await navigator.clipboard.writeText(text); return true; } } catch (e) { /* no permission / focus: fall back */ }
    const ta = document.createElement('textarea'); ta.value = text; ta.setAttribute('readonly', ''); ta.style.cssText = 'position:fixed;left:-9999px;top:0;opacity:0';
    const prev = document.activeElement;
    document.body.append(ta); ta.select();
    let ok = false; try { ok = document.execCommand('copy'); } catch (e) { ok = false; }
    ta.remove(); try { prev && prev.focus && prev.focus(); } catch (e) { /* ignore */ }
    return ok;
  }

  /* ---------- servers, channels, joining ---------- */
  const conns = () => (A.tryGet('app.connections') || []).filter(c => c && c.serverConnectionHandler);
  const handlerOf = schid => { const c = conns().find(c => String(c.serverConnectionHandler.id) === String(schid)); return c && c.serverConnectionHandler; };
  const serverName = c => { const h = c.serverConnectionHandler; let n = ''; try { n = h.properties && (h.properties.name || h.properties.virtualserverName) || ''; } catch (e) { /* not connected */ } return n || c.title || c.displayName || ('Server ' + h.id); };
  function channelPath(ch) { const parts = [], Ch = ch.constructor; for (let c = ch, n = 0; c && c.constructor === Ch && n < 32; c = c.parent, n++) parts.unshift((c.properties && c.properties.name) || ('#' + c.id)); return parts.join(' / '); }
  /* the top channel's parent is the server object (another class), so the walk stops there */
  const channelRec = (h, ch) => ({ id: ch.id, schid: h.id, name: (ch.properties && ch.properties.name) || '', path: channelPath(ch), password: !!(ch.properties && ch.properties.flagPassword), current: !!(h.ownClient && h.ownClient.channel && h.ownClient.channel.id === ch.id) });

  /* ---------- hidden developer toggles: where each lives in the app's settings objects ---------- */
  const DEV = [
    { key: 'keepActiveItemsInList', where: 'workflow', label: 'Keep active items in place in the sidebar', info: 'Active chats/servers stay where they are instead of jumping to the top.' },
    { key: 'restoreOpenedActivities', where: 'workflow', label: 'Restore opened chats on start', info: 'Re-open the chats that were open when the client was closed.' },
    { key: 'skipUIPermissionChecks', where: 'workflow', label: 'Skip permission checks in the UI', info: 'Actions are no longer hidden or disabled when the UI thinks you lack the permission. The server still decides.', risk: true },
    { key: 'disableAnimatedAttachments', where: 'workflow', label: 'Disable animated attachments', info: 'No animated GIF previews. Takes effect after a client restart.', restart: true },
    { key: 'show_activity_categories', where: 'appearance', label: 'Show activity categories', info: 'Group the sidebar activity list under category headers.' },
    { key: 'group_contact_invites', where: 'appearance', label: 'Group pending contact requests', info: 'Show pending contact requests as one group.' },
    { key: 'show_idle_time_history', where: 'appearance', label: 'Idle time chart in client info', info: 'Show the idle time history chart in the client info panel.' },
    { key: 'dev_virtual_list_scrolling_mode_async', where: 'appearance', label: 'Asynchronous virtual list scrolling (experimental)', info: 'Faster scrolling in long lists, but blank areas can flash during fast scrolling.', risk: true },
    { key: 'hideSidebarTabs', where: 'sidebar', label: 'Combine sidebar tabs', info: 'Hide the sidebar tab strip (combined tabs).' },
  ];
  const devObj = d => { const a = A.get('app.controller'); return d.where === 'workflow' ? a.workflowSettings : d.where === 'appearance' ? a.appearanceSettings : a; };
  const devGet = d => { try { return !!devObj(d)[d.key]; } catch (e) { return false; } };
  function devSet(d, v) {
    const a = A.get('app.controller'); v = !!v;
    if (d.where === 'workflow') a.applyWorkflowSettings({ [d.key]: v });
    else if (d.where === 'appearance') a.applyAppearanceSettings({ [d.key]: v });
    else a[d.key] = v;
  }

  core.coreApi('power', (api, track) => ({
    /* ----- clipboard ----- */
    copy,
    /* the palette's surface colours as CSS custom properties built from the client's own theme properties (the mod's CSS may not name them) */
    tokensCss: () => ':root { --power-surface: var(--ts-primary-background, #333947); --power-scrim: color-mix(in srgb, var(--ts-primary-background-darker2, #111) 55%, transparent); --power-shadow: var(--ts-popout-shadow, 2px 2px 14px rgba(0,0,0,.6)); }',
    /* ----- context-menu targets -> plain ids ----- */
    clientIds(t) {
      const m = t && t.model || {}, p = m.properties || {};
      return { clientId: m.id, uid: m.uid || '', databaseId: p.databaseId != null && p.databaseId !== '' && p.databaseId !== 0 ? p.databaseId : null, nickname: m.nickname || t.name || '' };
    },
    channelInfo(t) {
      const m = t && t.model || {}, h = handlerOf(t && t.schid);
      return { id: m.id, name: (m.properties && m.properties.name) || t.name || '', path: channelPath(m), schid: t && t.schid, handler: !!h };
    },
    /* ----- servers and channels ----- */
    servers() { const cur = A.state.current(); return conns().map(c => ({ schid: c.serverConnectionHandler.id, name: serverName(c), connected: c.serverConnectionHandler.connectionStatus === 4, current: !!cur && cur.id === c.serverConnectionHandler.id })); },
    showServer(schid) { const c = conns().find(c => String(c.serverConnectionHandler.id) === String(schid)); if (!c) throw new Error('no such server tab'); A.get('app.controller').showItem(c); },
    channels(schid) { const h = schid != null ? handlerOf(schid) : A.state.current(); if (!h || h.connectionStatus !== 4) return []; return [...h.GetFlatListChannels()].map(ch => channelRec(h, ch)); },
    async join(schid, channelId) {
      const h = handlerOf(schid); if (!h || !h.ownClient) throw new Error('not connected');
      const r = await A.bridge.call('requestClientMove', h.id, [h.ownClient.id], String(channelId), '');
      return r;
    },
    disconnect() { const h = A.state.current(); if (!h) throw new Error('no connection displayed'); h.Disconnect(); },
    connected: () => { const h = A.state.current(); return !!h && h.connectionStatus === 4; },
    /* ----- mute toggles (the toolbar's own buttons) ----- */
    micMuted() { const h = A.state.current(); return !!(h && h.ownClient && h.ownClient.properties.inputMuted); },
    speakersMuted() { const h = A.state.current(); return !!(h && h.ownClient && h.ownClient.properties.outputMuted); },
    toggleMic() { const b = (A.get('dom.toolbar').__vue__.buttons || []).find(b => /^microphone/.test(b.image)); if (!b) throw new Error('microphone button not found'); b.onSelected(); },
    toggleSpeakers() { const b = (A.get('dom.toolbar').__vue__.buttons || []).find(b => /^speaker/.test(b.image)); if (!b) throw new Error('speaker button not found'); b.onSelected(); },
    /* ----- navigation ----- */
    openSettings() { core.goto('/settings'); },
    /* ----- mods (the registry itself, no TS names) ----- */
    mods() { return core.list(); },
    setMod: (id, on) => core.setEnabled(id, on),
    /* ----- hidden developer toggles ----- */
    devFlags() { return DEV.map(d => ({ key: d.key, label: d.label, info: d.info, restart: !!d.restart, risk: !!d.risk, value: devGet(d) })); },
    setDevFlag(key, v) { const d = DEV.find(d => d.key === key); if (!d) throw new Error('unknown developer flag ' + key); devSet(d, v); return devGet(d); },
    /* ----- test helpers (right-click a tree row without a mouse; the test must not name TS classes) ----- */
    test: {
      showTree: () => A.showOwnChannelChat(),
      hasRow: (kind, id) => A.tree.rows(kind).some(r => String(r.model.id) === String(id)),
      async openMenu(kind, id) {   // -> titles of the "Mods" section of the menu that opens for that row
        const cm = A.get('dom.contextMenu'), row = A.tree.rows(kind).find(r => String(r.model.id) === String(id)); if (!row) throw new Error('no ' + kind + ' row ' + id);
        cm.data = null;
        row.row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90, button: 2, buttons: 2 }));
        for (let i = 0; i < 20 && !cm.data; i++) await A.wait(100);
        const s = (cm.data && cm.data.sections || []).find(s => s.title === 'Mods');
        return s ? s.items.map(i => i.title) : null;
      },
      clickMenu(title) { const s = (A.get('dom.contextMenu').data.sections || []).find(s => s.title === 'Mods'), it = s && s.items.find(i => i.title === title); if (!it) throw new Error('no menu item ' + title); it.onSelected(new MouseEvent('click')); },
      closeMenu() { A.get('dom.contextMenu').data = null; },
      clients: () => A.state.of(A.state.current()).clients.map(c => ({ id: c.id, nickname: c.nickname, uid: c.uid, self: c.self })),
      ownChannelId: () => { const h = A.state.current(); return h && h.ownClient && h.ownClient.channel && h.ownClient.channel.id; },
    },
  }));
})(window.__ts6modBoot);

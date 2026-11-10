/* Server awareness mod: channel activity badges, idle probe (expanded channels only, throttled), join/leave feed.
 * Docs: superdoc/features/mod-aware.md. TS specifics live in panel/core/x-aware.js (api.aware). Every sub-feature has its own
 * switch and lives in its own api.scope(), so switching it off disposes exactly its DOM, listeners, timers and requests. */
ts6mod.register({
  id: 'aware',
  title: 'Server awareness',
  group: 'Server & network', order: 2,
  icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  summary: 'Talking badges on channels, idle times next to users, and a join / leave feed in the title bar.',
  keywords: ['Channel activity badges', 'Activity fade time', 'Idle probe', 'Seconds between requests', 'Show idle from', 'Join / leave feed', 'Feed notifications', 'Entries kept'],
  status: api => { const A = api.ext.aware; if (!A) return ''; const c = A.cfg(); return [c.badges ? 'Badges' : '', c.idle ? 'Idle' : '', c.feed ? 'Feed' : ''].filter(Boolean).join(', '); },
  description: 'Activity badges on channels (who is talking, recent activity), idle time of users in expanded channels (opt-in: polls the server), and a join / leave / move feed.',
  enable(api) {
    const DEF = { badges: true, idle: false, feed: true, toasts: false, idleInterval: 5, idleMin: 60, fade: 30, feedMax: 50 };
    const cfg = () => Object.assign({}, DEF, api.storage.all());
    const scopes = {};   // sub-feature name -> its scope, present while that feature is on
    let panel = null;    // {toggle} of the running feed, for tests
    const feed = { entries: [], unseen: 0, listeners: new Set() };   // memory only: dies with the mod
    api.aware.cleanup(() => api.aware.forget());
    api.addStyle(api.aware.skin());

    const pad = n => String(n).padStart(2, '0');
    const hhmm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
    const dur = s => (s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm' : Math.floor(s) + 's');

    /* ---------- 1. channel activity badges ---------- */
    function badges(s, c) {
      const talking = new Set(s.aware.talkers());     // client ids currently talking
      const last = new Map();                         // channel id -> time someone last talked there
      const now0 = Date.now();
      for (const id of talking) { const ch = s.aware.channelOfClient(id); if (ch != null) last.set(ch, now0); }
      s.aware.onTalk((id, on) => {
        if (on) talking.add(id); else talking.delete(id);
        const ch = s.aware.channelOfClient(id); if (ch != null) last.set(ch, Date.now());
      });   // the tree re-renders its decorations on talk events by itself
      const talkingIn = ch => { let n = 0; for (const id of talking) if (s.aware.channelOfClient(id) === String(ch)) n++; return n; };
      s.treeRow.decorate({ for: 'channel', render(m) {
        const n = talkingIn(m.id), age = (Date.now() - (last.get(String(m.id)) || 0)) / 1000;
        if (!n && !(age < c.fade)) return null;
        const b = s.el('span', { class: 'aware-badge ' + (n ? 'talking' : 'recent'), title: n ? n + ' talking here' : 'Someone talked here ' + dur(age) + ' ago' });
        if (n) b.textContent = '♪ ' + n; else { b.textContent = '●'; b.style.opacity = String(Math.max(0.15, 1 - age / c.fade)); }
        return b;
      } });
      // fade: re-render once a second, and only while some channel is still inside its fade time
      s.interval(() => { const now = Date.now(); let any = talking.size > 0; for (const [k, t] of last) { if ((now - t) / 1000 > c.fade) last.delete(k); else any = true; } if (any) s.treeRow.refresh(); }, 1000);
    }

    /* ---------- 2. idle probe ---------- */
    function idle(s, c) {
      let rr = 0;
      s.treeRow.decorate({ for: 'client', render(m) {
        const ms = s.aware.idleMs(m); if (ms == null || ms / 1000 < c.idleMin) return null;
        return s.el('span', { class: 'aware-idle', title: 'Idle for ' + dur(ms / 1000) + ' (polled from the server)' }, 'idle ' + dur(ms / 1000));
      } });
      s.interval(() => {   // one request in total per tick, round-robin over the users of expanded channels
        const list = s.aware.expandedClients(); if (!list.length) return;
        const cl = list[rr++ % list.length];
        s.aware.requestInfo(cl.schid, cl.id).then(() => s.treeRow.refresh(), () => {});
      }, Math.max(1, c.idleInterval) * 1000);
    }

    /* ---------- 3. join / leave feed ---------- */
    const WORD = { join: 'joined', leave: 'left', move: 'moved', disconnect: 'disconnected', timeout: 'lost connection', kick: 'was kicked', ban: 'was banned' };
    const textOf = e => e.nick + ' ' + WORD[e.kind] + (e.kind === 'join' ? (e.to ? ' → ' + e.to : '') : e.kind === 'move' ? ': ' + (e.from || '?') + ' → ' + (e.to || '?') : e.from ? ' (' + e.from + ')' : '') + (e.reason && e.kind !== 'move' && e.kind !== 'timeout' && !/^disconnecting$/i.test(e.reason) ? ' – ' + e.reason : '');
    const notify = () => feed.listeners.forEach(f => f());
    function feedSetup(s, c) {
      let pop = null;
      const btn = s.topBar.add({ title: () => 'Join / leave feed' + (feed.unseen ? ' (' + feed.unseen + ' new)' : ''), icon: 'contacts', active: () => feed.unseen > 0, onClick: () => toggle() });
      const refreshBtn = () => btn.update({});
      const drawList = () => {
        if (!pop) return;
        pop.replaceChildren(s.el('div', { class: 'aware-pophead' }, s.el('span', {}, 'Join / leave feed'), s.el('button', { class: 'mods-link', type: 'button', on: { click: () => { feed.entries.length = 0; feed.unseen = 0; notify(); } } }, 'Clear')));
        const mine = feed.entries.filter(e => e.schid === s.aware.schid());
        if (!mine.length) pop.append(s.el('p', { class: 'mods-note' }, 'Nothing yet. Joins, leaves, moves and disconnects on this server show up here.'));
        for (const e of mine) pop.append(s.el('div', { class: 'aware-entry ' + e.kind }, s.el('span', { class: 'aware-time' }, hhmm(e.t)), s.el('span', { class: 'aware-text' }, textOf(e))));
      };
      const close = () => { if (pop) { pop.remove(); pop = null; } };
      function toggle() {
        if (pop) return close();
        pop = s.el('div', { class: 'aware-pop' }); document.body.append(pop);
        const r = s.aware.toolbar.rect(); if (r) { pop.style.top = (r.bottom + 6) + 'px'; pop.style.left = Math.max(8, Math.min(window.innerWidth - 350, r.left + r.width / 2 - 170)) + 'px'; pop.style.right = 'auto'; }
        feed.unseen = 0; refreshBtn(); drawList();
      }
      s.aware.cleanup(close);
      panel = { toggle }; s.aware.cleanup(() => { panel = null; });
      s.listen(document, 'mousedown', ev => { if (pop && !pop.contains(ev.target) && !s.aware.toolbar.contains(ev.target)) close(); }, true);
      s.listen(document, 'keydown', ev => { if (ev.key === 'Escape') close(); }, true);
      const onChange = () => { if (pop) { feed.unseen = 0; drawList(); } refreshBtn(); };
      feed.listeners.add(onChange); s.aware.cleanup(() => feed.listeners.delete(onChange));
      s.aware.onActivity(ev => {
        const e = Object.assign({ t: Date.now() }, ev);
        feed.entries.unshift(e); if (feed.entries.length > c.feedMax) feed.entries.length = c.feedMax;
        if (e.schid === s.aware.schid()) feed.unseen++;
        notify();
        if (c.toasts) s.toast('Server activity', textOf(e));
      });
    }

    /* ---------- switching sub-features on and off ---------- */
    const SUBS = { badges, idle, feed: feedSetup };
    function apply() {
      const c = cfg();
      for (const name of Object.keys(SUBS)) {
        const want = !!c[name];
        if (want && !scopes[name]) { scopes[name] = api.scope(); try { SUBS[name](scopes[name], c); } catch (e) { console.warn('[aware] ' + name, e); } }
        else if (!want && scopes[name]) { scopes[name].dispose(); delete scopes[name]; if (name === 'feed') { feed.entries.length = 0; feed.unseen = 0; } }
      }
    }
    api.extend('aware', {
      cfg,
      apply,
      entries: () => feed.entries.map(e => ({ kind: e.kind, nick: e.nick, from: e.from, to: e.to, text: textOf(e) })),
      togglePanel: () => { if (panel) panel.toggle(); return !!panel; },
      restart(name) { if (scopes[name]) { scopes[name].dispose(); delete scopes[name]; } apply(); },   // a feature that reads a value once (interval, fade, toasts) is rebuilt
    });
    apply();
  },

  settings(api, box) {
    const { ui } = api, A = api.ext.aware;
    if (!A) { box.append(ui.note('Switch the mod on to see its settings.')); return; }
    const set = (key, v, restart) => { api.storage.set(key, v); if (restart) A.restart(restart); else A.apply(); };
    const c = A.cfg();
    const tgl = (key, title, sub, restart) => { const t = ui.toggle({ title, sub, checked: !!c[key], onChange: v => set(key, v, restart) }); return t.el; };
    const sl = (key, label, min, max, step, unit, help, feature) => ui.slider({ label, min, max, step, unit, value: c[key], help, onCommit: v => set(key, v, feature), onInput: v => set(key, v, feature) }).el;
    box.append(
      ui.section('Channel activity',
        tgl('badges', 'Channel activity badges', 'A note with the number of people talking, or a fading dot after someone talked, on the channel row. Only channels you are subscribed to report activity.'),
        sl('fade', 'Activity fade time', 5, 300, 5, 's', 'How long the dot stays after the last talk.', 'badges')),
      ui.section('Idle times',
        tgl('idle', 'Idle probe (polls the server)', 'Shows "idle 12m" next to users of expanded channels. Idle time only exists as the answer to a per-user request, so this sends one request per interval. Off = no requests at all.'),
        sl('idleInterval', 'Seconds between requests', 1, 60, 1, 's', 'One request in total per interval, round-robin over the users in expanded channels.', 'idle'),
        sl('idleMin', 'Show idle from', 0, 1800, 30, 's', 'Hide the label for users who were active more recently than this.', 'idle')),
      ui.section('Join / leave feed',
        tgl('feed', 'Join / leave feed', 'A top bar button with a list of joins, leaves, moves and disconnects (kept in memory only).'),
        tgl('toasts', 'Feed notifications', 'Also show every feed entry as a notification.', 'feed'),
        sl('feedMax', 'Entries kept', 10, 200, 10, '', 'Oldest entries are dropped.', 'feed')),
    );
    return () => {};
  },
});

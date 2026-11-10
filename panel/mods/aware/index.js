/* Server awareness mod: talk circles of other channels' users (from polled idle time), idle labels, join/leave feed. All polling goes
 * through one throttled timer (one request per tick).
 * Docs: superdoc/features/mod-aware.md. TS specifics live in panel/core/x-aware.js (api.aware). Every sub-feature has its own
 * switch and lives in its own api.scope(), so switching it off disposes exactly its DOM, listeners, timers and requests. */
ts6mod.register({
  id: 'aware',
  title: 'Server awareness',
  group: 'Server & network', order: 2,
  icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  summary: 'Shows who talks in other channels on their talk circle, idle times next to users, and a join / leave feed in the title bar.',
  keywords: ['Show talking in other channels', 'Talk circle', 'Idle probe', 'Seconds between requests', 'Show idle from', 'Join / leave feed', 'Feed notifications', 'Entries kept'],
  status: api => { const A = api.ext.aware; if (!A) return ''; const c = A.cfg(); return [c.talk ? 'Talking' : '', c.idle ? 'Idle' : '', c.feed ? 'Feed' : ''].filter(Boolean).join(', '); },
  description: 'Talking shown on the talk circle of users in other channels (from their polled idle time), idle time of users in expanded channels (opt-in), and a join / leave / move feed. Polling sends at most one request per interval.',
  enable(api) {
    const DEF = { talk: true, idle: false, feed: true, toasts: false, idleInterval: 5, idleMin: 60, feedMax: 50 };
    const cfg = () => Object.assign({}, DEF, api.storage.all());
    const scopes = {};   // sub-feature name -> its scope, present while that feature is on
    let panel = null;    // {toggle} of the running feed, for tests
    const feed = { entries: [], unseen: 0, listeners: new Set() };   // memory only: dies with the mod
    api.aware.cleanup(() => api.aware.forget());
    api.addStyle(api.aware.skin());

    const pad = n => String(n).padStart(2, '0');
    const hhmm = t => { const d = new Date(t); return pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':' + pad(d.getSeconds()); };
    const dur = s => (s >= 3600 ? Math.floor(s / 3600) + 'h ' + Math.floor((s % 3600) / 60) + 'm' : s >= 60 ? Math.floor(s / 60) + 'm' : Math.floor(s) + 's');

    /* ---------- 1. talking in other channels (from idle time) ---------- */
    // The client only learns the talk status of people in its own channel. For the others, the polled idle time says when they last did
    // anything (voice, typing, any action resets it). Their stock talk circle is shown as talking while that last activity is younger
    // than LIT: the idle time extrapolated to now (answer + its age) is below 1 s plus one request interval. A client is asked only
    // every few intervals, so a window of just 1 s would catch almost nothing; one interval more makes any activity since the last
    // look light up (see the doc, "Why this threshold").
    const tickMs = c => Math.max(1, c.idleInterval) * 1000;
    const LIT = c => 1000 + tickMs(c);
    const talkingNow = (s, schid, id) => { const a = s.aware.answer(schid, id); return !!a && a.ms + (Date.now() - a.at) < LIT(cfg()); };
    let marks = null;   // {sync} of the running talk feature
    function talk(s) {
      marks = s.aware.markTalking((schid, id) => talkingNow(s, schid, id));
      s.interval(() => marks && marks.sync(), 1000);   // a mark ends when LIT runs out (local only, no requests)
      s.aware.cleanup(() => { marks = null; });
    }

    /* ---------- 2. idle labels ---------- */
    function idle(s, c) {
      s.treeRow.decorate({ for: 'client', render(m) {
        const ms = s.aware.idleMs(m); if (ms == null || ms / 1000 < c.idleMin) return null;
        return s.el('span', { class: 'aware-idle', title: 'Idle for ' + dur(ms / 1000) + ' (polled from the server)' }, 'idle ' + dur(ms / 1000));
      } });
    }

    /* ---------- the one request timer (runs while "talk" or "idle" is on) ---------- */
    // One request in total per tick, never more, whatever is switched on. Candidates: on-screen rows of other channels (talk) and users of
    // expanded channels (idle); the client asked longest ago goes first. Every other tick a client currently shown as talking that was
    // asked at least one tick ago is preferred, so its mark is confirmed or cleared quickly.
    function poll(s, c) {
      let tick = 0;
      s.interval(() => {
        const cur = cfg(), pool = new Map(), now = Date.now(), ms = tickMs(c);
        if (cur.talk) for (const x of s.aware.otherRows()) pool.set(x.schid + ':' + x.id, x);
        if (cur.idle) for (const x of s.aware.expandedClients()) pool.set(x.schid + ':' + x.id, x);
        if (!pool.size) return;
        const list = [...pool.values()], at = x => s.aware.askedAt(x.schid, x.id);
        const hot = cur.talk && tick++ % 2 === 0 ? list.filter(x => talkingNow(s, x.schid, x.id) && now - at(x) >= ms - 200) : [];
        const cl = (hot.length ? hot : list).reduce((a, b) => (at(b) < at(a) ? b : a));
        s.aware.requestInfo(cl.schid, cl.id).then(() => { s.treeRow.refresh(); if (marks) marks.sync(); }, () => {});
      }, tickMs(c));
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
    const SUBS = { talk, idle, poll, feed: feedSetup };
    const wanted = (c, name) => (name === 'poll' ? !!(c.talk || c.idle) : !!c[name]);
    function apply() {
      const c = cfg();
      for (const name of Object.keys(SUBS)) {
        const want = wanted(c, name);
        if (want && !scopes[name]) { scopes[name] = api.scope(); try { SUBS[name](scopes[name], c); } catch (e) { console.warn('[aware] ' + name, e); } }
        else if (!want && scopes[name]) { scopes[name].dispose(); delete scopes[name]; if (name === 'feed') { feed.entries.length = 0; feed.unseen = 0; } }
      }
    }
    api.extend('aware', {
      cfg,
      apply,
      entries: () => feed.entries.map(e => ({ kind: e.kind, nick: e.nick, from: e.from, to: e.to, text: textOf(e) })),
      togglePanel: () => { if (panel) panel.toggle(); return !!panel; },
      restart(name) { if (scopes[name]) { scopes[name].dispose(); delete scopes[name]; } apply(); },   // a feature that reads a value once (interval, toasts) is rebuilt
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
      ui.section('Talking in other channels',
        tgl('talk', 'Show talking in other channels (from idle time)', 'The client only knows who talks in your own channel. For users in other channels whose row is on screen, activity within the last second plus one request interval (idle time polled from the server) turns their talk circle on, as if you were in that channel. Shows up to one interval late, and also for typing or other activity.')),
      ui.section('Idle times',
        tgl('idle', 'Idle probe (polls the server)', 'Shows "idle 12m" next to users of expanded channels. Idle time only exists as the answer to a per-user request.'),
        sl('idleInterval', 'Seconds between requests', 1, 60, 1, 's', 'Shared by talking and idle times: one request in total per interval, to the user asked longest ago. Both off = no requests at all.', 'poll'),
        sl('idleMin', 'Show idle from', 0, 1800, 30, 's', 'Hide the label for users who were active more recently than this.', 'idle')),
      ui.section('Join / leave feed',
        tgl('feed', 'Join / leave feed', 'A top bar button with a list of joins, leaves, moves and disconnects (kept in memory only).'),
        tgl('toasts', 'Feed notifications', 'Also show every feed entry as a notification.', 'feed'),
        sl('feedMax', 'Entries kept', 10, 200, 10, '', 'Oldest entries are dropped.', 'feed')),
    );
    return () => {};
  },
});

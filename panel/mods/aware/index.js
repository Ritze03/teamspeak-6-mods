/* Server awareness mod: talk circles of other channels' users (from polled idle time), idle labels, join/leave feed. All polling goes
 * through one throttled timer (a few requests per second at most).
 * Docs: superdoc/features/mod-aware.md. TS specifics live in panel/core/x-aware.js (api.aware). Every sub-feature has its own
 * switch and lives in its own api.scope(), so switching it off disposes exactly its DOM, listeners, timers and requests. */
ts6mod.register({
  id: 'aware',
  title: 'Server awareness',
  group: 'Server & network', order: 2,
  icon: 'M2 12s4-7 10-7 10 7 10 7-4 7-10 7S2 12 2 12z M12 9a3 3 0 1 0 0 6a3 3 0 1 0 0-6z',
  summary: 'Shows who talks in other channels on their talk circle, idle times next to users, and a join / leave feed in the title bar.',
  keywords: ['Show talking in other channels', 'Talk circle', 'Idle probe', 'Check every', 'Show the word idle', 'Show idle from', 'Join / leave feed', 'Feed notifications', 'Entries kept'],
  status: api => { const A = api.ext.aware; if (!A) return ''; const c = A.cfg(); return [c.talk ? 'Talking' : '', c.idle ? 'Idle' : '', c.feed ? 'Feed' : ''].filter(Boolean).join(', '); },
  description: 'Talking shown on the talk circle of users in other channels (from their polled idle time), idle time of users in expanded channels (opt-in), and a join / leave / move feed. Polling sends at most 5 requests per second.',
  enable(api) {
    const DEF = { talk: true, idle: false, feed: true, toasts: false, idleInterval: 1, idleWord: true, idleMin: 60, feedMax: 50 };
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
    // anything (voice, typing, any action resets it). A mark (the stock talk circle) is shown by talkingNow below: extrapolated idle
    // time (answer + its age) under the hold time, plus one interval of slack while the next answer is pending (see the doc, "Timing").
    const tickMs = c => Math.max(1, c.idleInterval) * 1000;
    const LIT_BELOW = 1000;   // user spec: idle time below 1000 ms at the last check = talking
    // Lit while the last answer said idle < 1000 ms; it stays lit until the next answer says otherwise. The age limit only
    // clears a mark whose follow-up answers stopped coming (lost callback, client left the screen): 2 ticks + 1 s.
    const talkingNow = (s, schid, id) => {
      const a = s.aware.answer(schid, id); if (!a) return false;
      return a.ms < LIT_BELOW && Date.now() - a.at < 2 * tickMs(cfg()) + 1000;
    };
    let marks = null;   // {sync} of the running talk feature
    function talk(s) {
      marks = s.aware.markTalking((schid, id) => talkingNow(s, schid, id));
      s.interval(() => marks && marks.sync(), 300);   // a mark ends when its hold runs out (local only, no requests)
      s.aware.cleanup(() => { marks = null; });
    }

    /* ---------- 2. idle labels ---------- */
    function idle(s, c) {
      s.treeRow.decorate({ for: 'client', render(m) {
        const ms = s.aware.idleMs(m); if (ms == null || ms / 1000 < cfg().idleMin) return null;
        const word = cfg().idleWord !== false;
        return s.el('span', { class: 'aware-idle', title: 'Idle for ' + dur(ms / 1000) + ' (polled from the server)' }, (word ? 'idle ' : '') + dur(ms / 1000));
      } });
    }

    /* ---------- the request timer (runs while "talk" or "idle" is on) ---------- */
    // Every tick (default 1 s) the candidates are ranked and the best few are asked, at most MAX_RATE requests per second in total
    // (flood protection: a TS server's default anti-flood refills 5 points per second and one command costs 1). Rank: never asked
    // first, then lit clients (so a mark is confirmed or cleared on the next tick), then recently active ones, then the rest by
    // time since asked / period (idle < 30 s every 2 ticks, < 5 min every 4, else every 12). With up to MAX_RATE candidates all
    // are asked every tick; with more, the active ones keep the budget and the others take turns, none starves (its ratio grows).
    const MAX_RATE = 5;
    const period = (s, x) => {
      const a = s.aware.answer(x.schid, x.id), idle = a ? (a.ms + Date.now() - a.at) / 1000 : Infinity;
      return idle < 30 ? 2 : idle < 300 ? 4 : 12;
    };
    function poll(s, c) {
      const ms = tickMs(c), budget = Math.max(1, Math.floor(MAX_RATE * ms / 1000));
      s.interval(() => {
        const cur = cfg(), pool = new Map(), now = Date.now();
        if (cur.talk) for (const x of s.aware.otherRows()) pool.set(x.schid + ':' + x.id, x);   // muted / away clients are not in it
        if (cur.idle) for (const x of s.aware.expandedClients()) pool.set(x.schid + ':' + x.id, x);
        if (!pool.size) return;
        const ranked = [...pool.values()].map(x => {
          const at = s.aware.askedAt(x.schid, x.id), lit = cur.talk && talkingNow(s, x.schid, x.id);
          return { x, rank: !at ? 1e9 : lit ? 1e6 : (now - at) / (period(s, x) * ms) };
        }).sort((p, q) => q.rank - p.rank).slice(0, budget);
        for (const { x } of ranked) s.aware.requestInfo(x.schid, x.id).then(() => { s.treeRow.refresh(); if (marks) marks.sync(); }, () => {});
      }, ms);
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
        tgl('talk', 'Show talking in other channels (from idle time)', 'The client only knows who talks in your own channel. For users in other channels whose row is on screen, the talk circle is lit while their idle time (checked every second) is under 1 s, as if you were in that channel. Also lit by typing or other activity. Never for users with a muted microphone, no microphone, or away.')),
      ui.section('Idle times',
        tgl('idle', 'Idle probe (polls the server)', 'Shows "idle 12m" next to users of expanded channels. Idle time only exists as the answer to a per-user request.'),
        tgl('idleWord', 'Show the word "idle"', 'On: "idle 12m". Off: just "12m". The tooltip explains the time either way.', 'idle'),
        sl('idleInterval', 'Check every', 1, 60, 1, 's', 'Shared by talking and idle times: every interval the users most likely to be active are asked (at most 5 requests per second in total, the rest take turns). Both off = no requests at all.', 'poll'),
        sl('idleMin', 'Show idle from', 0, 1800, 30, 's', 'Hide the label for users who were active more recently than this.', 'idle')),
      ui.section('Join / leave feed',
        tgl('feed', 'Join / leave feed', 'A top bar button with a list of joins, leaves, moves and disconnects (kept in memory only).'),
        tgl('toasts', 'Feed notifications', 'Also show every feed entry as a notification.', 'feed'),
        sl('feedMax', 'Entries kept', 10, 200, 10, '', 'Oldest entries are dropped.', 'feed')),
    );
    return () => {};
  },
});

/* Power mod: copy-ID context menus, a command palette (default Ctrl+K) with local and join actions, and an unlocker for the
 * client's hidden developer toggles. All client specifics live in panel/core/x-power.js (api.power).
 * Docs: superdoc/features/mod-power.md. */
(() => {
  const DEFAULT_HOTKEY = 'Ctrl+K';
  /* copy entries: key, kind (client|channel), label, toast name, value(ids) */
  const COPY = [
    { key: 'uid', kind: 'client', label: 'Copy unique ID', what: 'unique ID', get: i => i.uid || null, def: true },
    { key: 'clientId', kind: 'client', label: 'Copy client ID', what: 'client ID', get: i => i.clientId, def: true },
    { key: 'dbId', kind: 'client', label: 'Copy database ID', what: 'database ID', get: i => i.databaseId, def: true },
    { key: 'nick', kind: 'client', label: 'Copy nickname', what: 'nickname', get: i => i.nickname || null, def: true },
    { key: 'chId', kind: 'channel', label: 'Copy channel ID', what: 'channel ID', get: i => i.id, def: true },
    { key: 'chPath', kind: 'channel', label: 'Copy channel path', what: 'channel path', get: i => i.path || null, def: true },
    { key: 'chName', kind: 'channel', label: 'Copy channel name', what: 'channel name', get: i => i.name || null, def: false },
  ];

  /* ---- hotkey strings: "Ctrl+Shift+K" ---- */
  const MODS = ['Ctrl', 'Alt', 'Shift', 'Meta'];
  function parseCombo(s) {
    const parts = String(s || '').split('+').map(p => p.trim()).filter(Boolean); if (!parts.length) return null;
    const key = parts.pop().toLowerCase(), c = { ctrl: false, alt: false, shift: false, meta: false, key };
    for (const p of parts) { const m = p.toLowerCase(); if (m in c && m !== 'key') c[m] = true; else return null; }
    return c;
  }
  const matches = (c, e) => !!c && e.ctrlKey === c.ctrl && e.altKey === c.alt && e.shiftKey === c.shift && e.metaKey === c.meta && String(e.key).toLowerCase() === c.key;
  function comboOf(e) {
    if (MODS.includes(e.key === 'Control' ? 'Ctrl' : e.key)) return null;   // only a modifier so far
    const k = e.key.length === 1 ? e.key.toUpperCase() : e.key;
    return [e.ctrlKey && 'Ctrl', e.altKey && 'Alt', e.shiftKey && 'Shift', e.metaKey && 'Meta', k].filter(Boolean).join('+');
  }
  const isEditable = t => !!(t && (t.isContentEditable || (t.closest && t.closest('input, textarea, select, [contenteditable=""], [contenteditable="true"]'))));

  /* ---- fuzzy search: every space-separated token must match as a subsequence; substring / word-start / run bonuses ---- */
  function scoreToken(hay, tok) {
    const i = hay.indexOf(tok);
    if (i >= 0) return 100 + (i === 0 ? 30 : /[\s/_-]/.test(hay[i - 1]) ? 20 : 0) - Math.min(i, 40) * 0.2;
    let h = 0, s = 0, run = 0;
    for (const ch of tok) {
      const j = hay.indexOf(ch, h); if (j < 0) return -1;
      run = j === h ? run + 1 : 0; s += 2 + run * 2 + (j === 0 || /[\s/_-]/.test(hay[j - 1]) ? 4 : 0) - Math.min(j - h, 6) * 0.3; h = j + 1;
    }
    return s;
  }
  function rank(items, query) {
    const toks = query.toLowerCase().split(/\s+/).filter(Boolean);
    if (!toks.length) return items.map(it => ({ it, score: 0 }));
    const out = [];
    for (const it of items) {
      const hay = (it.title + ' ' + it.group + ' ' + (it.kw || '')).toLowerCase(); let tot = 0, ok = true;
      for (const t of toks) { const s = scoreToken(hay, t); if (s < 0) { ok = false; break; } tot += s; }
      if (ok) out.push({ it, score: tot - it.title.length * 0.05 });
    }
    return out.sort((a, b) => b.score - a.score);
  }

  ts6mod.register({
    id: 'power',
    title: 'Power tools',
    description: 'Copy-ID entries in the right-click menus, a command palette (Ctrl+K) to jump, join and toggle, and an unlocker for the client\'s hidden developer toggles.',

    enable(api) {
      const P = api.power;
      api.addStyle(P.tokensCss());
      const cfg = () => api.storage.get('copy', {});
      const copyOn = key => { const c = cfg(), e = COPY.find(x => x.key === key); return key in c ? !!c[key] : !!e.def; };
      let closePalette = null;
      this.closePalette = () => closePalette && closePalette();   // see disable()

      /* ===== 1. copy entries (visibility is read from the settings on every menu open, so changes apply live) ===== */
      for (const e of COPY) {
        const ids = t => (e.kind === 'client' ? P.clientIds(t) : P.channelInfo(t));
        api.contextMenu[e.kind].add({
          label: e.label, icon: 'copy',
          visible: t => copyOn(e.key) && e.get(ids(t)) != null,
          onClick: async t => {
            const v = e.get(ids(t));
            const ok = v != null && await P.copy(v);
            api.toast(ok ? 'Copied ' + e.what : 'Could not copy', ok ? String(v) : 'The clipboard is not available.');
          },
        });
      }

      /* ===== 2. command palette ===== */
      function buildItems() {
        const items = [], add = (group, title, run, extra) => items.push(Object.assign({ group, title, run, kw: '' }, extra));
        const connected = P.connected();
        add('Go to', 'Open Settings', () => P.openSettings(), { kw: 'preferences options' });
        add('Go to', 'Open Mods page', () => api.settings.open(), { kw: 'mods plugins' });
        add('Go to', 'Go to Dashboard', () => api.nav.showDashboard(), { kw: 'home start' });
        if (connected) {
          add('Audio', P.micMuted() ? 'Unmute microphone' : 'Mute microphone', () => P.toggleMic(), { kw: 'mic input' });
          add('Audio', P.speakersMuted() ? 'Unmute speakers' : 'Mute speakers', () => P.toggleSpeakers(), { kw: 'headphones sound output deafen' });
          add('Server', 'Disconnect from server', () => P.disconnect(), { kw: 'leave quit' });
        }
        for (const m of P.mods()) if (m.id !== 'power') add('Mods', (m.enabled ? 'Disable ' : 'Enable ') + m.title, () => P.setMod(m.id, !m.enabled), { kw: 'mod toggle switch ' + m.id });
        for (const s of P.servers()) if (!s.current) add('Server', 'Switch to ' + s.name, () => P.showServer(s.schid), { kw: 'tab connection server' });
        for (const c of P.channels()) {
          if (c.current) continue;
          add('Channel', 'Join ' + c.path, async () => {
            try { await P.join(c.schid, c.id); api.toast('Joined channel', c.path); }
            catch (e) { api.toast('Could not join ' + c.path, c.password ? 'The channel is password protected.' : 'The server refused the move (status ' + (e && e.status) + ').'); }
          }, { kw: 'channel move go ' + c.name, sub: c.password ? 'password' : '' });
        }
        return items;
      }

      function openPalette() {
        if (closePalette) return;
        const prev = document.activeElement, scope = api.scope();
        let all = [], shown = [], active = 0;
        try { all = buildItems(); } catch (e) { api.log('palette items', e); }
        const input = scope.el('input', { class: 'power-input', type: 'text', placeholder: 'Type a command, channel or server', spellcheck: false, autocomplete: 'off', role: 'combobox', 'aria-expanded': 'true', 'aria-controls': 'power-list' });
        const list = scope.el('div', { class: 'power-list', id: 'power-list', role: 'listbox' });
        const foot = scope.el('div', { class: 'power-foot' }, scope.el('span', '↑↓ select'), scope.el('span', 'Enter run'), scope.el('span', 'Esc close'));
        const box = scope.el('div', { class: 'power-box', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'Command palette' }, input, list, foot);
        const root = scope.el('div', { class: 'power-overlay' }, box);
        const close = () => {
          if (!closePalette) return; closePalette = null;
          scope.dispose();   // removes the DOM and every listener of this palette
          try { prev && prev.isConnected && prev.focus && prev.focus(); } catch (e) { /* ignore */ }
        };
        closePalette = close;
        const setActive = (i, scroll) => {
          if (!shown.length) return; active = (i + shown.length) % shown.length;
          [...list.children].forEach((n, k) => { n.classList.toggle('active', k === active); n.setAttribute('aria-selected', k === active ? 'true' : 'false'); });
          const n = list.children[active]; if (n) { input.setAttribute('aria-activedescendant', n.id); if (scroll !== false) n.scrollIntoView({ block: 'nearest' }); }
        };
        const run = it => { close(); Promise.resolve().then(() => it.run()).catch(e => api.toast('Command failed', String(e && e.message || e))); };
        const render = () => {
          shown = rank(all, input.value).slice(0, 80).map(r => r.it);
          list.replaceChildren(...shown.map((it, k) => scope.el('div', { class: 'power-item', id: 'power-i' + k, role: 'option', on: { mousemove: () => { if (active !== k) setActive(k, false); }, click: () => run(it) } },
            scope.el('span', { class: 'power-group' }, it.group), scope.el('span', { class: 'power-title' }, it.title), it.sub ? scope.el('span', { class: 'power-sub' }, it.sub) : null)));
          if (!shown.length) list.append(scope.el('div', { class: 'power-empty' }, 'No match'));
          active = 0; setActive(0);
        };
        input.addEventListener('input', render);
        scope.listen(root, 'mousedown', e => { if (e.target === root) { e.preventDefault(); close(); } });
        scope.listen(box, 'keydown', e => {
          if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
          else if (e.key === 'ArrowDown') { e.preventDefault(); setActive(active + 1); }
          else if (e.key === 'ArrowUp') { e.preventDefault(); setActive(active - 1); }
          else if (e.key === 'Enter') { e.preventDefault(); if (shown[active]) run(shown[active]); }
          else if (e.key === 'Tab') e.preventDefault();   // focus stays in the field
          e.stopPropagation();   // typing must not reach the client's own shortcuts
        });
        scope.listen(box, 'focusout', () => scope.timeout(() => { if (closePalette === close && !box.contains(document.activeElement)) input.focus(); }, 0));
        document.body.append(root); scope._track('palette', () => root.remove()); render(); input.focus();
      }

      const hotkey = () => parseCombo(api.storage.get('hotkey', DEFAULT_HOTKEY));
      api.listen(document, 'keydown', e => {
        if (e.repeat || e.isComposing || !matches(hotkey(), e)) return;
        const c = hotkey();
        if (isEditable(e.target) && !(c.ctrl || c.alt || c.meta)) return;   // a plain key (or Shift+key) in a text field is typing
        e.preventDefault(); e.stopImmediatePropagation();
        if (closePalette) closePalette(); else openPalette();
      }, true);
    },

    disable() { try { this.closePalette && this.closePalette(); } catch (e) { /* the ledger removes the rest */ } },

    /* ===== settings: hotkey, copy entries, developer toggles ===== */
    settings(api, container) {
      const P = api.power, ui = api.ui;
      /* hotkey */
      const label = () => api.storage.get('hotkey', DEFAULT_HOTKEY);
      const keyBtn = ui.button({ label: label(), onClick: () => rec() });
      let stopRec = null;
      const rec = () => {
        if (stopRec) return; keyBtn.textContent = 'Press the new shortcut (Esc cancels)';
        const un = api.listen(document, 'keydown', e => {
          e.preventDefault(); e.stopImmediatePropagation();
          if (e.key === 'Escape') return done();
          const c = comboOf(e); if (!c) return;
          if (!(e.ctrlKey || e.altKey || e.metaKey) && !/^F\d+$/.test(e.key)) return;   // needs a modifier (or an F-key) so it never collides with typing
          api.storage.set('hotkey', c); done();
        }, true);
        stopRec = () => { un(); stopRec = null; };
        const done = () => { stopRec && stopRec(); keyBtn.textContent = label(); };
      };
      container.append(ui.section('Command palette',
        ui.row2(el('span', { class: 'mods-label' }, 'Shortcut'), keyBtn, ui.button({ kind: 'link', label: 'Reset to ' + DEFAULT_HOTKEY, onClick: () => { api.storage.remove('hotkey'); keyBtn.textContent = label(); } })),
        ui.note('Opens from anywhere in the client. In a text field (chat, search) it only opens if the shortcut contains Ctrl, Alt or Meta, so plain typing is never swallowed.')));
      function el(t, p, ...k) { return api.el(t, p, ...k); }

      /* copy entries */
      const cur = () => api.storage.get('copy', {});
      const box = ui.section('Copy entries in the right-click menus');
      for (const e of COPY) {
        box.append(ui.toggle({ title: e.label + (e.kind === 'client' ? ' (user)' : ' (channel)'), checked: e.key in cur() ? !!cur()[e.key] : e.def,
          onChange: v => api.storage.set('copy', Object.assign({}, cur(), { [e.key]: v })) }).el);
      }
      container.append(box);

      /* developer toggles */
      const dev = ui.section('Hidden developer toggles');
      dev.append(ui.note('These are the client\'s own developer options, normally hidden. They change your client settings for real and stay changed after the mod is switched off. This mod never changes them by itself; only the switches below do, when you click them.', 'warn'));
      const sw = new Map();
      for (const f of P.devFlags()) {
        const t = ui.toggle({ title: f.label, sub: f.info + (f.restart ? ' (restart required)' : ''), checked: f.value,
          onChange: v => { try { t.set(P.setDevFlag(f.key, v)); } catch (e) { t.set(!v); api.toast('Could not change', String(e && e.message || e)); } } });
        if (f.risk) t.el.append(el('p', { class: 'mods-note power-warn' }, 'Experimental: can make the UI misbehave. Switch it back off if it does.'));
        sw.set(f.key, t); dev.append(t.el);
      }
      container.append(dev);
      api.interval(() => { for (const f of P.devFlags()) { const t = sw.get(f.key); if (t && t.get() !== f.value) t.set(f.value); } }, 1500);   // follows changes made in the client's own pages

      return () => { if (stopRec) stopRec(); };
    },
  });
})();

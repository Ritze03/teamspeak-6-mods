/* ts6-mods semantic slots: top bar, left icon column, context menus, tree rows, chat composer, toast, modal,
 * read-only state, navigation, audio helpers. Each is an api part (added to every mod's api). All TS specifics are
 * delegated to anchors.js; everything a mod adds is registered in its cleanup ledger (undone on disable).
 * Services shared between mods (one toolbar patch, one observer, ...) start with the first user and stop with the last. */
(function (boot) {
  'use strict';
  const A = boot.anchors, core = boot.core, warn = core.warn;
  let seq = 0;

  /* shared(start) -> {acquire() -> release}: start() runs for the first user and returns its stop function */
  function shared(start) {
    let n = 0, stop = null;
    return { acquire() { if (n++ === 0) stop = start(); let done = false; return () => { if (done) return; done = true; if (--n === 0) { const s = stop; stop = null; try { s && s(); } catch (e) { warn('service stop', e); } } }; } };
  }
  const debounce = (fn, ms) => { let t = 0; const f = () => { clearTimeout(t); t = setTimeout(fn, ms); }; f.cancel = () => clearTimeout(t); return f; };
  const val = v => (typeof v === 'function' ? v() : v);

  /* ================= top bar (central toolbar) ================= */
  const TB = { items: new Set(), patch: null };
  const tbSpecs = () => [...TB.items].filter(i => !i.node).map(i => ({ id: i.id, title: val(i.spec.title), icon: i.spec.icon, onClick: i.spec.onClick, active: !!val(i.spec.active) }));
  const tbRefresh = () => { if (TB.patch) { try { TB.patch.refresh(); } catch (e) { warn('toolbar refresh', e); } } };
  function tbSync() {
    if (!TB.items.size) return;
    if (!TB.patch || !TB.patch.alive()) {   // first time, or the toolbar component was rebuilt
      if (TB.patch) { try { TB.patch.undo(); } catch (e) { /* component gone */ } TB.patch = null; }
      if ([...TB.items].some(i => !i.node)) { try { TB.patch = A.toolbar.patch(tbSpecs); } catch (e) { /* toolbar not rendered yet: retried on the next DOM change */ } }
    }
    const host = A.toolbar.host();
    if (host) for (const it of TB.items) if (it.node && it.node.parentNode !== host) host.appendChild(it.node);
  }
  const tbService = shared(() => {
    const un1 = core.dom(tbSync, 150), un2 = A.onRoute(tbRefresh);
    return () => { un1(); un2(); if (TB.patch) { try { TB.patch.undo(); } catch (e) { /* ignore */ } TB.patch = null; } };
  });

  /* ================= left icon column ================= */
  const SB = { items: new Set() };
  const sbActive = it => { try { return !!val(it.spec.active); } catch (e) { return false; } };
  function sbSync() {
    for (const it of SB.items) if (!it.block) { try { it.block = A.sidebar.block({ title: it.spec.title, icon: it.spec.icon, onClick: it.spec.onClick, active: sbActive(it) }); if (it.block) it.block.el.setAttribute('data-ts6mod', it.owner); } catch (e) { it.block = null; } }
    A.sidebar.place([...SB.items].filter(i => i.block).map(i => i.block));
  }
  const sbService = shared(() => {
    const un1 = core.dom(sbSync, 100), un2 = A.onRoute(() => SB.items.forEach(it => it.block && it.block.setActive(sbActive(it))));
    return () => { un1(); un2(); };
  });

  /* ================= context menus ================= */
  const CM = { items: new Set() };
  const cmService = shared(() => A.contextMenu.hook((d, target, makeItem) => {
    if (!target) return;
    const out = [];
    for (const it of CM.items) {
      if (it.kind !== target.kind) continue;
      try { if (it.spec.visible && it.spec.visible(target) === false) continue; } catch (e) { warn('contextMenu visible()', e); continue; }
      out.push(makeItem(val(it.spec.label) || it.owner, it.spec.icon || '', () => { try { it.spec.onClick(target); } catch (e) { warn('contextMenu onClick', e); } }));
    }
    if (out.length) d.sections.push({ title: 'Mods', items: out });
  }));

  /* ================= tree rows ================= */
  const TR = { decos: new Set() };
  function trRun(force) {
    for (const kind of ['client', 'channel']) {
      const ds = [...TR.decos].filter(d => d.kind === kind); if (!ds.length) continue;
      for (const { host, model } of A.tree.rows(kind)) for (const d of ds) {
        const key = kind + ':' + model.id; let m = host.querySelector(':scope > [data-deco="' + d.id + '"]');
        if (m && m.dataset.mid === key && !force) continue;
        let out; try { out = d.spec.render(model); } catch (e) { warn('treeRow render', e); out = null; }
        if (out == null || out === false || out === '') { if (m) m.remove(); continue; }
        if (!m) { m = document.createElement('span'); m.className = 'mods-deco'; m.setAttribute('data-ts6mod', d.owner); m.dataset.deco = d.id; host.appendChild(m); }
        m.dataset.mid = key;
        if (typeof out === 'object' && out.nodeType) m.replaceChildren(out); else if (m.textContent !== String(out)) m.textContent = String(out);
      }
    }
  }
  const trService = shared(() => {
    const full = debounce(() => trRun(true), 60), un1 = core.dom(() => trRun(false), 60), subs = ['talkStatusChanged', 'clientPropertiesUpdated', 'clientMoved', 'clientSelfPropertyUpdated', 'channelPropertiesUpdated'].map(n => core.nativeOn(n, full));
    return () => { un1(); full.cancel(); subs.forEach(u => u()); };
  });

  /* ================= chat composer ================= */
  const CI = { handlers: new Set(), patched: new Map() };
  const ciCtx = vm => { const i = A.chat.info(vm); return { text: i.text, limit: i.limit, element: i.element, kind: i.kind }; };
  function ciSync() {
    for (const [vm, undo] of CI.patched) if (vm._isDestroyed) { CI.patched.delete(vm); try { undo(); } catch (e) { /* ignore */ } }
    for (const vm of A.chat.inputs()) {
      if (CI.patched.has(vm)) continue;
      CI.patched.set(vm, A.chat.patch(vm, orig => async (...args) => {
        let parts = [A.chat.getText(vm)];
        for (const h of [...CI.handlers]) {
          if (parts.length !== 1) break;
          let r; try { r = await h.fn(Object.assign(ciCtx(vm), { text: parts[0] })); } catch (e) { warn('onBeforeSend', e); continue; }
          if (r === false) return;
          if (typeof r === 'string') parts = [r]; else if (Array.isArray(r) && r.length) parts = r.map(String);
        }
        if (parts.length === 1) { if (parts[0] !== A.chat.getText(vm)) A.chat.setText(vm, parts[0]); return orig(...args); }
        for (const p of parts) { A.chat.setText(vm, p); await orig(...args); await A.wait(40); }   // several messages through the composer's own send path
      }));
    }
  }
  const ciService = shared(() => {
    const un1 = core.dom(ciSync, 100), f = () => ciSync(); document.addEventListener('focusin', f, true);
    ciSync();
    return () => { un1(); document.removeEventListener('focusin', f, true); for (const undo of CI.patched.values()) { try { undo(); } catch (e) { /* ignore */ } } CI.patched.clear(); };
  });
  const activeComposer = () => { const all = A.chat.inputs(); return all.find(v => v.$el.contains(document.activeElement)) || all[0] || null; };

  /* ================= api part ================= */
  core.addApiPart((api, rec) => {
    const track = api._track;

    api.topBar = {
      /* add(el | {title, icon, onClick, active}) -> {remove(), update(patch)}; icon = TS icon name, active = bool | () => bool */
      add(arg) {
        const node = arg && arg.nodeType ? arg : null, it = { id: rec.id + '-' + (++seq), owner: rec.id, node, spec: node ? null : Object.assign({}, arg) };
        if (node) node.setAttribute('data-ts6mod', rec.id);
        TB.items.add(it); const rel = tbService.acquire(); tbSync(); tbRefresh();
        const un = track('topbar', () => { TB.items.delete(it); if (node) node.remove(); rel(); tbRefresh(); });
        return { remove: un, update(p) { if (it.spec) Object.assign(it.spec, p); tbRefresh(); } };
      },
    };

    api.sidebar = {
      /* addIcon({title, icon, onClick, active}) -> {remove(), update(patch)}; a button in the left icon column */
      addIcon(spec) {
        const it = { owner: rec.id, spec: Object.assign({}, spec), block: null };
        SB.items.add(it); const rel = sbService.acquire(); sbSync();
        const un = track('sidebar-icon', () => { SB.items.delete(it); if (it.block) it.block.destroy(); it.block = null; rel(); });
        return { remove: un, update(p) { Object.assign(it.spec, p); if (it.block) it.block.setActive(sbActive(it)); } };
      },
    };

    const cmKind = kind => ({
      /* add({label, icon, onClick(target), visible(target)}); target = {kind, id, schid, name, model} */
      add(spec) {
        const it = { owner: rec.id, kind, spec: Object.assign({}, spec) };
        CM.items.add(it); const rel = cmService.acquire();
        return { remove: track('context-menu', () => { CM.items.delete(it); rel(); }) };
      },
    });
    api.contextMenu = {
      client: cmKind('client'), channel: cmKind('channel'),
      server: { add() { throw new Error('api.contextMenu.server is not supported: the server entry of the channel tree has no context menu of its own in this client version (probed on 6.0.0-beta5.1). Use api.sidebar/api.topBar for server-level actions.'); } },
    };

    api.treeRow = {
      /* decorate({for: 'client'|'channel', render(model) -> string|Node|null}) -> {remove()}; an inline marker at the end of the row */
      decorate(spec) {
        if (spec.for !== 'client' && spec.for !== 'channel') throw new Error("treeRow.decorate: for must be 'client' or 'channel'");
        const d = { id: rec.id + '-' + (++seq), owner: rec.id, kind: spec.for, spec }; TR.decos.add(d); const rel = trService.acquire(); trRun(false);
        const un = track('tree-decoration', () => { TR.decos.delete(d); document.querySelectorAll('[data-deco="' + d.id + '"]').forEach(n => n.remove()); rel(); });
        return { remove: un };
      },
      refresh: () => trRun(true),
    };

    api.chatInput = {
      /* onBeforeSend(fn({text, limit, element, kind})): return undefined (keep), false (cancel), a string (replace) or string[] (send each as its own message, in order) */
      onBeforeSend(fn) {
        const h = { fn }; CI.handlers.add(h); const rel = ciService.acquire();
        return { remove: track('chat-hook', () => { CI.handlers.delete(h); rel(); }) };
      },
      available: () => !!activeComposer(),
      limit: () => { const v = activeComposer(); return v ? A.chat.info(v).limit : null; },
      element: () => { const v = activeComposer(); return v ? A.chat.info(v).element : null; },
      text: () => { const v = activeComposer(); return v ? A.chat.getText(v) : ''; },
      setText: t => { const v = activeComposer(); if (!v) throw new Error('no chat input is displayed'); A.chat.setText(v, t); },
    };

    api.toast = (title, text, opts) => {
      const un = A.toast(Object.assign({ id: 'ts6mod:' + rec.id + ':' + (++seq), title, text }, opts));
      return track('toast', un);
    };
    api.modal = {
      /* show({title, render(container, close), onClose}) -> {close()} */
      show(spec) {
        let un = () => {};
        const m = A.modal({ id: 'ts6mod-' + rec.id + '-' + (++seq), onClose: () => { un(); spec.onClose && spec.onClose(); },
          render: (host, close) => { host.setAttribute('data-ts6mod', rec.id); if (spec.title) host.append(A.el('h3', { class: 'mods-title' }, spec.title)); const body = A.el('div', { class: 'mods-modal-body' }); host.append(body); spec.render(body, close); } });
        un = track('modal', () => m.close());
        return { close: m.close };
      },
    };

    api.icon = name => { const ic = A.icon(name); track('icon', ic.destroy); ic.el.setAttribute('data-ts6mod', rec.id); return ic.el; };

    const cur = () => A.state.of(A.state.current());
    api.state = {
      connections: () => A.state.handlers().map(h => ({ schid: h.id, connected: h.connectionStatus === 4 })),
      current: cur,
      ownClient: () => { const s = cur(); return s && s.ownClient; },
      channel: () => { const s = cur(); return s && s.channel; },
      channels: () => { const s = cur(); return s ? s.channels : []; },
      clients: opts => { const s = cur(); if (!s) return []; return opts && opts.all ? s.clients : s.clients.filter(c => s.channel && c.channelId === s.channel.id); },
    };

    api.nav = { route: A.route, onDashboard: A.onDashboard, showDashboard: A.showDashboard };

    api.audio = {
      stock: A.audio.readStock,                        // {agc, experimental} of the active playback device, or null
      setStockAgc: A.audio.setStock,                   // what the stock AGC toggle does (persists)
      setExperimentalAgc: A.audio.setExperimental,     // the hidden "Playback AGC Experimental Mode" (persists, reopens the stream)
    };
  });
})(window.__ts6modBoot);

// Tests of the framework core and every semantic slot against the live client (run by run-all.mjs, step "core").
// Unlike mod tests this file may name TS internals (it tests the anchors layer). Each test registers a throw-away mod
// (id "t-*") in the page, uses the slot, checks the effect, disables it and checks that nothing is left; the mods are
// forgotten afterwards. Nothing here sends a chat message or changes server state: the chat hook is only exercised on a
// fake composer, and on the real one just checked to be patched.
const APP = `__ts6mod.anchors.get('app.controller')`;
const reg = (id, src) => `__ts6mod.register(Object.assign({ id: '${id}', title: '${id}', description: 'test' }, ${src}))`;

export const tests = [
  ['core: persistence (storage + mods blob)', async c => {
    await c.eval(reg('t-store', `{ enable(api) { api.storage.set('k', { n: 5 }); } }`));
    await c.enable('t-store');
    c.equal(await c.eval(`__ts6mod.mods().get('t-store').api.storage.get('k')`), { n: 5 }, 'storage.get returns what set stored');
    c.equal(await c.eval(`__ts6mod.mods().get('t-store').api.storage.get('missing', 7)`), 7, 'storage.get default');
    await c.sleep(600);   // debounced save
    const blob = await c.eval(`new Promise(r => tsclient_internal.getJsonBlob('mods', (s, v) => r(v)))`);
    const o = JSON.parse(blob);
    c.assert(o.enabled && o.settings && o.settings['t-store'] && o.settings['t-store'].k.n === 5, 'blob "mods" = {enabled, settings:{id:{k:v}}} contains the value: ' + blob.slice(0, 120));
    await c.eval(`__ts6mod.unregister('t-store', { purge: true })`); await c.sleep(600);
    const after = JSON.parse(await c.eval(`new Promise(r => tsclient_internal.getJsonBlob('mods', (s, v) => r(v)))`));
    c.assert(!after.settings['t-store'], 'purge removed the test entry from the blob');
  }],

  ['core: timers, listeners, observers are cleaned up on disable', async c => {
    const subs0 = (await c.trace()).domSubs;
    await c.eval(`document.querySelectorAll('#t-obs').forEach(n => n.remove()); window.__t = { tick: 0, to: 0, ev: 0, mo: 0, dom: 0 }`);
    await c.eval(reg('t-timers', `{ enable(api) {
      api.interval(() => window.__t.tick++, 20); api.timeout(() => window.__t.to++, 80);
      api.listen(document, 'ts6mod-test', () => window.__t.ev++);
      const n = document.createElement('div'); n.id = 't-obs'; document.body.append(n); api.addStyle('#t-obs{outline:0}');
      api.observe(n, { attributes: true }, () => window.__t.mo++);
      api.onDom(() => window.__t.dom++, { debounce: 10 });
    } }`));
    await c.enable('t-timers');
    await c.sleep(250);
    c.assert(await c.eval(`window.__t.tick > 3 && window.__t.to === 1`), 'interval ticks, timeout fired once');
    await c.eval(`document.dispatchEvent(new Event('ts6mod-test')); (() => { document.getElementById('t-obs').setAttribute('x', '1'); const e = document.createElement('i'); document.body.append(e); e.remove(); })()`);
    await c.sleep(100);
    c.assert(await c.eval(`window.__t.ev === 1 && window.__t.mo === 1 && window.__t.dom >= 1`), 'listener, observer and onDom work');
    c.equal(Object.keys(await c.eval(`__ts6mod.ledger('t-timers')`)).sort(), ['dom', 'interval', 'listener', 'observer', 'style'], 'ledger lists the registrations (the fired timeout is already released)');
    await c.disable('t-timers');
    const snap = await c.eval(`JSON.stringify(window.__t)`); await c.sleep(200);
    c.equal(await c.eval(`JSON.stringify(window.__t)`), snap, 'nothing fires after disable');
    await c.eval(`document.dispatchEvent(new Event('ts6mod-test'))`);
    c.equal(await c.eval(`window.__t.ev`), 1, 'DOM listener removed');
    c.equal(await c.eval(`document.querySelectorAll('style[data-ts6mod="t-timers"]').length`), 0, 'style removed');
    await c.eval(`document.getElementById('t-obs')?.remove(); delete window.__t`);
    await c.assertClean('t-timers');
    c.equal((await c.trace()).domSubs, subs0, 'onDom subscription removed (other mods may keep the shared observer alive)');
    await c.eval(`__ts6mod.unregister('t-timers')`);
  }],

  ['core: bridge.call, version, native events, state', async c => {
    await c.eval(reg('t-bridge', `{ enable(api) { window.__tb = { off: api.events.on('talkStatusChanged', () => {}) }; window.__api = api; } }`));
    await c.enable('t-bridge');
    const r = await c.eval(`(async () => { const api = window.__api;
      const v = api.version(), build = await api.bridge.call('getClientLibVersion');
      let rejected = false; try { await api.bridge.call('getPlaybackConfigValue', api.state.current().schid, 'agc'); } catch (e) { rejected = e.status === 1538; }
      const st = api.state.current();
      return { v, build, rejected, schid: st && st.schid, own: st && st.ownClient && st.ownClient.nickname, nClients: st && st.clients.length, chan: st && st.channel && st.channel.name, conns: api.state.connections().length, hasModel: !!(st && st.ownClient && st.ownClient.model) }; })()`);
    c.assert(r.v.client && r.v.build > 0 && r.v.chrome, 'api.version() has client/build/chrome: ' + JSON.stringify(r.v));
    c.assert(Array.isArray(r.build) && r.build[0] === r.v.build, 'bridge.call resolves (value, extra) as an array: ' + JSON.stringify(r.build));
    c.assert(r.rejected, 'bridge.call rejects on a non-zero status');
    c.assert(r.schid > 0 && r.own && r.nClients >= 1 && r.chan && r.conns >= 1 && r.hasModel, 'api.state.current(): ' + JSON.stringify(r));
    c.equal((await c.trace()).events, { talkStatusChanged: 1 }, 'native event subscription counted');
    await c.disable('t-bridge');
    c.equal((await c.trace()).events, {}, 'native event subscription removed on disable');
    await c.eval(`delete window.__api; delete window.__tb; __ts6mod.unregister('t-bridge')`);
  }],

  ['slot: toast', async c => {
    await c.eval(reg('t-toast', `{ enable(api) { api.toast('ts6mod test', 'a local test toast'); } }`));
    await c.enable('t-toast');
    const find = `${APP}.notificationCenter.findNotificationsByTagPrefix('ts6mod:t-toast').length`;
    c.assert(await c.eval(find) >= 1, 'notification entered the notification center');
    await c.disable('t-toast');
    c.equal(await c.eval(find), 0, 'notification removed on disable');
    await c.assertClean('t-toast'); await c.eval(`__ts6mod.unregister('t-toast')`);
  }],

  ['slot: modal', async c => {
    await c.eval(reg('t-modal', `{ enable(api) { window.__m = api.modal.show({ title: 'ts6mod test', render(box, close) { box.textContent = 'hello modal'; window.__close = close; }, onClose() { window.__closed = (window.__closed || 0) + 1; } }); } }`));
    await c.eval(`window.__closed = 0`);
    await c.enable('t-modal');
    await c.waitFor(`document.querySelector('.mods-modal .mods-modal-body') && document.querySelector('.mods-modal .mods-modal-body').textContent === 'hello modal'`, 'modal content rendered');
    await c.eval(`window.__close()`);
    await c.waitFor(`!document.querySelector('.mods-modal')`, 'close() removes the modal');
    c.equal(await c.eval(`window.__closed`), 1, 'onClose called once');
    await c.eval(`__ts6mod.mods().get('t-modal').api.modal.show({ render(b) { b.textContent = 'again'; } })`);
    await c.waitFor(`!!document.querySelector('.mods-modal')`, 'second modal shown');
    await c.disable('t-modal');
    await c.waitFor(`!document.querySelector('.mods-modal')`, 'disable closes an open modal');
    await c.eval(`delete window.__m; delete window.__close; delete window.__closed; __ts6mod.unregister('t-modal')`);
  }],

  ['slot: topBar (add spec, active, remove, getter restored)', async c => {
    const getter = `String(document.querySelector('.tsv-central-toolbar').__vue__._computedWatchers.buttons.getter)`;
    const ids = `document.querySelector('.tsv-central-toolbar').__vue__.buttons.map(b => b.identifier).filter(i => /^ts6mod-t-top/.test(i))`;
    const before = await c.eval(getter), nBefore = await c.eval(`document.querySelector('.tsv-central-toolbar').__vue__.buttons.length`);
    await c.eval(reg('t-top', `{ enable(api) { window.__on = false; window.__clicks = 0;
      window.__h = api.topBar.add({ title: 'ts6mod test', icon: 'settings-addons', onClick: () => window.__clicks++, active: () => window.__on }); } }`));
    await c.enable('t-top');
    c.equal((await c.eval(ids)).length, 1, 'one top bar button added');
    c.equal(await c.eval(`document.querySelector('.tsv-central-toolbar').__vue__.buttons.length`), nBefore + 1, 'stock buttons untouched');
    await c.eval(`document.querySelector('.tsv-central-toolbar').__vue__.buttons.find(b => /^ts6mod-t-top/.test(b.identifier)).onSelected()`);
    c.equal(await c.eval(`window.__clicks`), 1, 'onClick runs');
    await c.eval(`window.__on = true; window.__h.update({})`);
    c.equal(await c.eval(`!!(document.querySelector('.tsv-central-toolbar').__vue__.buttons.find(b => /^ts6mod-t-top/.test(b.identifier)).class || {}).active`), true, 'active() is re-evaluated on update');
    await c.disable('t-top');
    c.equal((await c.eval(ids)).length, 0, 'button removed on disable');
    c.equal(await c.eval(getter), before, 'toolbar computed getter restored to the original');
    await c.assertClean('t-top');
    await c.eval(`delete window.__on; delete window.__clicks; delete window.__h; __ts6mod.unregister('t-top')`);
  }],

  ['slot: sidebar.addIcon (order, update, remove)', async c => {
    await c.eval(reg('t-side', `{ enable(api) { window.__a = true; api.sidebar.addIcon({ title: 'T1', icon: 'settings-addons', onClick() {}, active: () => window.__a });
      api.sidebar.addIcon({ title: 'T2', icon: 'settings-addons', onClick() {} }); } }`));
    await c.enable('t-side');
    await c.waitFor(`document.querySelectorAll('[data-ts6mod="t-side"]').length === 2`, 'two icons appear');
    c.equal(await c.eval(`[...document.querySelectorAll('.resources-section > *')].map(e => e.title || '-').slice(-3)`).then(a => a.slice(0, 2)), ['T1', 'T2'], 'icons are placed in registration order behind the stock groups');
    c.equal(await c.eval(`document.querySelector('[data-ts6mod="t-side"]').classList.contains('active')`), true, 'active() applied');
    await c.disable('t-side');
    c.equal(await c.eval(`document.querySelectorAll('[data-ts6mod="t-side"]').length`), 0, 'icons removed');
    await c.assertClean('t-side'); await c.eval(`delete window.__a; __ts6mod.unregister('t-side')`);
  }],

  ['slot: icon element', async c => {
    await c.eval(reg('t-icon', `{ enable(api) { window.__i = api.icon('settings-addons'); document.body.append(window.__i); } }`));
    await c.enable('t-icon');
    await c.waitFor(`!!window.__i.querySelector('svg')`, 'api.icon() renders the TS icon');
    await c.disable('t-icon');
    c.equal(await c.eval(`document.body.contains(window.__i)`), false, 'icon removed');
    await c.eval(`delete window.__i; __ts6mod.unregister('t-icon')`);
  }],

  ['slot: contextMenu (client, channel; server throws), treeRow, chat hook', async c => {
    // show a view with the channel tree and the chat composer (local navigation only)
    await c.eval(`__ts6mod.showOwnChannelChat()`);
    await c.waitFor(`document.querySelectorAll('.ts-server-tree-item-leaf.client').length > 0 && !!document.querySelector('.ts-chat-input-container')`, 'tree and chat composer displayed', 8000);
    await c.eval(`window.__origSend = __ts6mod.anchors.chat.inputs().map(v => v.sendMessageContent)`);
    await c.eval(reg('t-ui', `{ enable(api) {
      window.__seen = []; window.__sent = [];
      api.contextMenu.client.add({ label: 'ts6mod client item', icon: 'settings-addons', onClick: t => window.__seen.push(['client', t.kind, t.id, t.schid, typeof t.name]), visible: t => t.id !== -1 });
      api.contextMenu.client.add({ label: 'hidden item', onClick() {}, visible: () => false });
      api.contextMenu.channel.add({ label: 'ts6mod channel item', onClick: t => window.__seen.push(['channel', t.kind, String(t.id), t.schid, typeof t.name]) });
      try { api.contextMenu.server.add({ label: 'x', onClick() {} }); window.__serverThrew = false; } catch (e) { window.__serverThrew = String(e.message); }
      api.treeRow.decorate({ for: 'client', render: m => '#' + m.id });
      api.treeRow.decorate({ for: 'channel', render: m => 'c' + m.id });
      window.__chat = api.chatInput.onBeforeSend(ctx => { window.__ctx = { text: ctx.text, limit: ctx.limit, kind: ctx.kind, el: !!ctx.element }; });
    } }`));
    await c.enable('t-ui');
    c.assert(String(await c.eval(`window.__serverThrew`)).includes('not supported'), 'contextMenu.server.add throws a clear error: ' + await c.eval(`window.__serverThrew`));

    // tree row decoration
    await c.waitFor(`document.querySelectorAll('.ts-server-tree-item-leaf.client .mods-deco').length > 0 && document.querySelectorAll('.ts-server-tree-item-leaf.channel .mods-deco').length > 0`, 'client and channel rows decorated');
    c.assert(await c.eval(`[...document.querySelectorAll('.ts-server-tree-item-leaf.client')].every(r => { const d = r.querySelector('.mods-deco'); return d && d.textContent === '#' + r.__vue__.$props.data.id; })`), 'every client row shows its own id');

    // context menu on a client row and a channel row
    const open = sel => c.eval(`(async () => { const cm = __ts6mod.anchors.get('dom.contextMenu'); cm.data = null;
      document.querySelector(${JSON.stringify(sel)}).dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: 120, clientY: 90, button: 2, buttons: 2 }));
      for (let i = 0; i < 20 && !cm.data; i++) await new Promise(r => setTimeout(r, 100));
      const s = (cm.data && cm.data.sections || []).find(s => s.title === 'Mods');
      return s ? s.items.map(i => i.title) : null; })()`);
    const closeMenu = async () => { await c.eval(`__ts6mod.anchors.get('dom.contextMenu').data = null`); await c.pressEscape(); };   // the menu stays drawn until a trusted key/click arrives
    c.equal(await open('.ts-server-tree-item-leaf.client.self'), ['ts6mod client item'], 'client menu has our visible item only');
    await c.eval(`(() => { const s = __ts6mod.anchors.get('dom.contextMenu').data.sections.find(s => s.title === 'Mods'); s.items[0].onSelected(new MouseEvent('click')); })()`);
    await closeMenu();
    c.equal(await c.eval(`window.__seen[0].slice(0, 2).concat([typeof window.__seen[0][2], window.__seen[0][4]])`), ['client', 'client', 'number', 'string'], 'onClick got a client target');
    c.equal(await open('.ts-server-tree-item-leaf.channel:not(.spacer)'), ['ts6mod channel item'], 'channel menu has the channel item');
    await c.eval(`(() => { const s = __ts6mod.anchors.get('dom.contextMenu').data.sections.find(s => s.title === 'Mods'); s.items[0].onSelected(new MouseEvent('click')); })()`);
    await closeMenu();
    c.equal(await c.eval(`window.__seen[1].slice(0, 2)`), ['channel', 'channel'], 'onClick got a channel target');

    // chat hook: the real composer is patched; the logic is exercised on a fake composer
    c.assert(await c.eval(`__ts6mod.anchors.chat.inputs().every((v, i) => v.sendMessageContent !== window.__origSend[i])`), 'real composer instance is patched');
    c.assert(await c.eval(`__ts6mod.mods().get('t-ui').api.chatInput.available() && __ts6mod.mods().get('t-ui').api.chatInput.limit() > 0 && !!__ts6mod.mods().get('t-ui').api.chatInput.element()`), 'chatInput.available/limit/element');
    const fake = `(() => { const sent = []; const vm = { _isDestroyed: false, msg: '', maxInputLength: 10, chat: {}, $el: document.createElement('div'),
      sendMessageContent: async function () { sent.push(this.msg); } };
      const host = document.createElement('div'); host.className = 'ts-chat-input-container'; host.hidden = true; host.__vue__ = vm; vm.$el = host; document.body.append(host);
      window.__fake = { vm, sent, host }; return true; })()`;
    await c.eval(fake);
    await c.eval(`window.__fake.vm.msg = 'plain'; document.dispatchEvent(new FocusEvent('focusin'))`);   // triggers the composer sync
    c.assert(await c.eval(`Object.prototype.hasOwnProperty.call(window.__fake.vm, 'sendMessageContent')`), 'fake composer picked up and patched');
    await c.eval(`window.__fake.vm.sendMessageContent()`);
    c.equal(await c.eval(`window.__fake.sent`), ['plain'], 'handler returning undefined sends unchanged');
    c.equal(await c.eval(`({ text: window.__ctx.text, limit: window.__ctx.limit, el: window.__ctx.el })`), { text: 'plain', limit: 10, el: true }, 'handler ctx has text/limit/element');
    await c.eval(`__ts6mod.mods().get('t-ui').api.chatInput.onBeforeSend(ctx => ctx.text === 'split me' ? ['one', 'two', 'three'] : ctx.text === 'cancel' ? false : ctx.text === 'swap' ? 'swapped' : undefined)`);
    await c.eval(`window.__fake.sent.length = 0; (async () => { const f = window.__fake; for (const t of ['split me', 'cancel', 'swap']) { f.vm.msg = t; await f.vm.sendMessageContent(); } })()`);
    await c.waitFor(`window.__fake.sent.length >= 4`, 'multi-part send finished', 3000);
    c.equal(await c.eval(`window.__fake.sent`), ['one', 'two', 'three', 'swapped'], 'array = several messages in order, false = cancelled, string = replaced');
    await c.eval(`window.__fake.host.remove()`);

    await c.disable('t-ui');
    c.equal(await c.eval(`document.querySelectorAll('.mods-deco').length`), 0, 'row decorations removed');
    c.assert(await c.eval(`__ts6mod.anchors.chat.inputs().every((v, i) => v.sendMessageContent === window.__origSend[i])`), 'composer patch undone (original method back)');
    c.equal(await open('.ts-server-tree-item-leaf.client.self'), null, 'menu items gone');
    await closeMenu();
    await c.assertClean('t-ui');
    await c.eval(`delete window.__seen; delete window.__sent; delete window.__serverThrew; delete window.__chat; delete window.__ctx; delete window.__fake; delete window.__origSend; __ts6mod.unregister('t-ui')`);
  }],

  ['slot: settings (own area, addSection, addPage)', async c => {
    await c.eval(reg('t-set', `{ settings(api, box) { box.textContent = 'own area'; window.__scoped = api.interval(() => (window.__tick = (window.__tick || 0) + 1), 20); },
      enable(api) { api.settings.addSection({ title: 'extra', render(box) { box.append(api.ui.note('section body')); } });
        api.settings.addPage({ key: 'p', title: 'T page', icon: 'settings-addons', render(host) { host.textContent = 'page body'; } }); } }`));
    await c.enable('t-set');
    c.assert((await c.eval(`__ts6mod.anchors.settings.keys()`)).includes('TS6Mods.t-set.p'), 'addPage adds a Settings category');
    await c.openModsPage();
    await c.waitFor(`!!document.querySelector('[data-ts6mod="t-set"]') && /own area/.test(document.querySelector('[data-ts6mod="t-set"]').textContent) && /section body/.test(document.querySelector('[data-ts6mod="t-set"]').textContent)`, 'own area and section rendered on the Mods page');
    await c.sleep(100);
    c.assert(await c.eval(`window.__tick > 2`), 'timers started in settings() run while the page is shown');
    await c.eval(`__ts6mod.goto('/')`); await c.waitFor(`!document.querySelector('[data-ts6mod="t-set"]')`, 'area removed when the page is left');
    const t1 = await c.eval(`window.__tick`); await c.sleep(150);
    c.equal(await c.eval(`window.__tick`), t1, 'scoped timers stop when the page is left');
    await c.disable('t-set');
    c.assert(!(await c.eval(`__ts6mod.anchors.settings.keys()`)).includes('TS6Mods.t-set.p'), 'addPage category removed on disable');
    await c.assertClean('t-set'); await c.eval(`delete window.__tick; delete window.__scoped; __ts6mod.unregister('t-set')`);
  }],

  ['core: Mods page lists mods with their switch state', async c => {
    await c.openModsPage();
    await c.waitFor(`document.querySelectorAll('.mods-mod').length >= 2`, 'Mods page lists the registered mods');
    const n = await c.eval(`document.querySelectorAll('.mods-mod').length`), m = await c.eval(`__ts6mod.list().length`);
    c.equal(n, m, 'one card per registered mod');
    await c.eval(`__ts6mod.goto('/')`);
  }],
];

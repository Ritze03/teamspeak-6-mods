// Power mod: copy-ID menu entries (clipboard read back and compared to the real values), command palette (hotkey, fuzzy search,
// keyboard, join a channel, open the Mods page), developer toggles section (explicit clicks only), clean disable.
// Needs a connected client with at least one other client and one other channel on the server (else those parts are skipped
// with a log line). Changes made: one benign developer toggle is flipped and flipped back; ONLY on the local test server
// (ctx.onTestServer()) the own client joins another channel through the palette and goes back to the channel it was in. On any other
// server the copy entries are read against an existing other client (read-only) and the join is skipped.
export default async function (ctx) {
  const M = '[data-ts6mod="power"]', B = M + '.mods-mod-body', OV = M + '.power-overlay';
  const P = 'window.__pwr';
  const key = async (k, code, vk, modifiers = 0) => { for (const type of ['keyDown', 'keyUp']) await ctx.cdp.send('Input.dispatchKeyEvent', { type, key: k, code, windowsVirtualKeyCode: vk, modifiers }); await ctx.sleep(150); };
  const ctrlK = () => key('k', 'KeyK', 75, 2);
  const overlays = () => ctx.eval(`document.querySelectorAll('${OV}').length`);
  const type = async text => {
    await ctx.cdp.send('Input.insertText', { text }); await ctx.sleep(150);
    if (await ctx.eval(`document.querySelector('${OV} input').value`) !== text) await ctx.eval(`(() => { const i = document.querySelector('${OV} input'); i.value = ${JSON.stringify(text)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);
    await ctx.sleep(100);
  };
  const openPalette = async () => { await ctrlK(); await ctx.waitFor(`document.querySelectorAll('${OV}').length === 1`, 'palette opens on Ctrl+K'); };
  const closeMenu = async () => { await ctx.eval(`window.__pwr.test.closeMenu()`); await ctx.pressEscape(); };   // the menu stays drawn until a trusted key arrives
  const activeText = () => ctx.eval(`(document.querySelector('${OV} .power-item.active .power-title') || {}).textContent || ''`);

  await ctx.disable('power');
  ctx.equal(await ctx.eval(`document.querySelectorAll('${M}').length`), 0, 'no mod DOM while off');
  await ctrlK();
  ctx.equal(await overlays(), 0, 'Ctrl+K does nothing while the mod is off');

  await ctx.enable('power');
  await ctx.eval(`window.__pwr = __ts6mod.mods().get('power').api.power`);
  const connected = await ctx.eval(`${P}.connected()`);
  if (!connected) ctx.log('SKIP connected parts: no connected server tab displayed');

  // focus emulation + clipboard permission, so the clipboard can be read back although the test window is not focused
  await ctx.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  try { await ctx.cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: 'tsui://default' }); } catch (e) { ctx.log('could not grant clipboard permission: ' + e.message); }
  const readClip = () => ctx.eval(`navigator.clipboard.readText()`);

  let startChannel = null;
  try {
    if (connected) {
      /* ---------- 1. copy menu ---------- */
      await ctx.eval(`${P}.test.showTree()`); await ctx.sleep(1500);
      const clients = await ctx.eval(`${P}.test.clients()`), other = clients.find(c => !c.self && c.uid);
      if (!other) ctx.skip('client copy entries', 'no other client on the server');
      else {
        await ctx.waitFor(`${P}.test.hasRow('client', ${other.id})`, 'the other client\'s row is rendered', 10000);
        const titles = await ctx.eval(`${P}.test.openMenu('client', ${other.id})`);
        ctx.assert(titles && ['Copy unique ID', 'Copy client ID', 'Copy nickname'].every(t => titles.includes(t)), 'client menu has the copy entries, got ' + JSON.stringify(titles));
        await ctx.eval(`${P}.test.clickMenu('Copy unique ID')`); await ctx.sleep(300);
        ctx.equal(await readClip(), other.uid, 'clipboard holds the other client\'s unique ID');
        await closeMenu();
        await ctx.eval(`${P}.test.openMenu('client', ${other.id})`);
        await ctx.eval(`${P}.test.clickMenu('Copy client ID')`); await ctx.sleep(300);
        ctx.equal(await readClip(), String(other.id), 'clipboard holds the client ID');
        await closeMenu();
        await ctx.eval(`${P}.test.openMenu('client', ${other.id})`);
        await ctx.eval(`${P}.test.clickMenu('Copy nickname')`); await ctx.sleep(300);
        ctx.equal(await readClip(), other.nickname, 'clipboard holds the nickname');
        await closeMenu();
      }
      // a channel whose row is rendered right now (the tree is a virtual list; spacer rows have no menu)
      let ch = null;
      for (let i = 0; i < 20 && !ch; i++) { ch = await ctx.eval(`${P}.channels().find(c => !c.decorative && ${P}.test.hasRow('channel', c.id)) || null`); if (!ch) await ctx.sleep(300); }
      if (ch) {
        const titles = await ctx.eval(`${P}.test.openMenu('channel', ${ch.id})`).catch(() => null);
        if (!titles) ctx.skip('channel copy entries', 'the channel menu did not open');
        else {
          ctx.assert(titles.includes('Copy channel ID') && titles.includes('Copy channel path'), 'channel menu has the copy entries, got ' + JSON.stringify(titles));
          await ctx.eval(`${P}.test.clickMenu('Copy channel path')`); await ctx.sleep(300);
          ctx.equal(await readClip(), ch.path, 'clipboard holds the channel path');
          await closeMenu();
        }
      }

      /* ---------- 2. palette ---------- */
      const local = await ctx.onTestServer();
      if (local) startChannel = await ctx.eval(`${P}.test.ownChannelId()`);
      const others = (await ctx.eval(`${P}.channels()`)).filter(c => !c.current && !c.password);
      const target = others.find(c => /^power-/i.test(c.name)) || others[0];
      await openPalette();
      ctx.equal(await ctx.eval(`document.activeElement === document.querySelector('${OV} input')`), true, 'palette input is focused');
      await key('ArrowDown', 'ArrowDown', 40);
      const second = await activeText(); await key('ArrowUp', 'ArrowUp', 38);
      ctx.assert((await activeText()) !== second, 'arrow keys move the selection');
      await ctx.pressEscape();
      ctx.equal(await overlays(), 0, 'Escape closes the palette');
      ctx.assert(await ctx.eval(`!document.querySelector('${M}.power-overlay')`), 'palette DOM removed');

      await openPalette(); await ctrlK();
      ctx.equal(await overlays(), 0, 'the hotkey also closes the palette');

      // opens while a text field has focus (the hotkey has Ctrl)
      await ctx.eval(`(() => { const i = document.createElement('input'); i.id = 'power-test-field'; i.style.cssText = 'position:fixed;left:0;top:0;z-index:99999'; document.body.append(i); i.focus(); })()`);
      await openPalette(); await ctx.pressEscape();
      await ctx.eval(`document.getElementById('power-test-field').remove()`);

      await openPalette(); await type('mods page');
      ctx.assert(/Mods page/.test(await activeText()), 'fuzzy search finds the Mods page action, got "' + await activeText() + '"');
      await key('Enter', 'Enter', 13);
      await ctx.waitFor(`__ts6mod.route().fullPath.includes('TS6Mods')`, 'local action opens the Mods page');
      ctx.equal(await overlays(), 0, 'palette closed after running an action');
      await ctx.restoreRoute();

      if (!local) ctx.skip('join a channel from the palette', 'moves the own client: local test server only');
      else if (!target) ctx.skip('join a channel from the palette', 'no other joinable channel on the server');
      else {
        await openPalette(); await type(target.name);
        ctx.assert((await activeText()).startsWith('Join ') && (await activeText()).includes(target.name), 'search puts "Join ' + target.name + '" first, got "' + await activeText() + '"');
        await key('Enter', 'Enter', 13);
        await ctx.waitFor(`${P}.test.ownChannelId() == ${JSON.stringify(target.id)}`, 'own client is in the channel chosen in the palette', 8000);
        ctx.equal(await overlays(), 0, 'palette closed after joining');
        // the channel we are in is no longer offered
        await openPalette(); await type(target.name);
        ctx.assert((await activeText()) !== 'Join ' + target.path, 'the channel we are in is not offered as a join target');
        await ctx.pressEscape();
      }
    }

    /* ---------- 3. settings: developer toggles, only explicit clicks change them ---------- */
    await ctx.openModsPage('power');
    await ctx.waitFor(`document.querySelectorAll('${B} label').length > 0 && /Hidden developer toggles/.test(document.querySelector('${B}').textContent)`, 'settings area with the developer section');
    const flags = await ctx.eval(`${P}.devFlags()`);
    ctx.assert(flags.length >= 5, 'developer flags are listed (' + flags.length + ')');
    const text = await ctx.eval(`document.querySelector('${B}').textContent`);
    ctx.assert(flags.every(f => text.includes(f.label)), 'every flag has a switch in the settings');
    ctx.assert(/never changes them by itself/.test(text), 'warning line is shown');
    const before = JSON.stringify(flags.map(f => [f.key, f.value]));
    const f0 = flags.find(f => f.key === 'group_contact_invites') || flags.find(f => !f.risk);
    const click = () => ctx.eval(`[...document.querySelectorAll('${B} label')].find(l => l.textContent.includes(${JSON.stringify(f0.label)})).click()`);
    await click();
    await ctx.waitFor(`${P}.devFlags().find(f => f.key === ${JSON.stringify(f0.key)}).value === ${!f0.value}`, 'clicking a switch changes the client setting');
    await click();
    await ctx.waitFor(`${P}.devFlags().find(f => f.key === ${JSON.stringify(f0.key)}).value === ${f0.value}`, 'clicking again restores it');
    ctx.equal(JSON.stringify((await ctx.eval(`${P}.devFlags()`)).map(f => [f.key, f.value])), before, 'all developer flags are back to their start values');
    await ctx.restoreRoute();
  } finally {
    if (startChannel != null) await ctx.eval(`${P}.join(${JSON.stringify(await ctx.eval(`${P}.servers().find(s => s.current).schid`))}, ${JSON.stringify(startChannel)})`).catch(() => {});
    await ctx.cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
    await ctx.eval(`(document.getElementById('power-test-field') || {remove(){}}).remove()`).catch(() => {});
  }

  /* ---------- 4. disable: no trace ---------- */
  await ctx.disable('power');
  await ctrlK();
  ctx.equal(await overlays(), 0, 'Ctrl+K does nothing after disable');
  if (connected) {
    await ctx.eval(`window.__pwr.test.showTree()`); await ctx.sleep(1200);
    const none = await ctx.eval(`(async () => { const c = window.__pwr.test.clients().find(c => !c.self); if (!c) return null; try { return await window.__pwr.test.openMenu('client', c.id); } catch (e) { return 'err'; } })()`);
    ctx.assert(none === null || none === 'err' || !none.some(t => /^Copy /.test(t)), 'no copy entries in the menu after disable (items of other enabled mods may remain), got ' + JSON.stringify(none));
    await closeMenu();
  }
  await ctx.eval(`delete window.__pwr`);
  await ctx.assertClean('power');
}

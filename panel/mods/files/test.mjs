// Files mod: oversize images are compressed on every route (chat drop / paste / attach button, Files tab drop / upload button), everything else is
// left alone, disable restores the stock behaviour and leaves no trace. Small generated fixtures + a 1 MB limit keep it fast; the real 16-45 MB
// set is run by hand (superdoc/features/mod-files.md "Test procedure").
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { deflateSync, crc32 } from 'node:zlib';
import { join } from 'node:path';

const png = (w, h) => {   // noisy RGB PNG (incompressible, so it is big)
  const raw = Buffer.alloc((w * 3 + 1) * h); for (let y = 0; y < h; y++) { raw[y * (w * 3 + 1)] = 0; for (let i = 0; i < w * 3; i++) raw[y * (w * 3 + 1) + 1 + i] = (Math.random() * 256) | 0; }
  const chunk = (t, d) => { const b = Buffer.concat([Buffer.from(t), d]); const o = Buffer.alloc(b.length + 8); o.writeUInt32BE(d.length, 0); b.copy(o, 4); o.writeUInt32BE(crc32(b), b.length + 4); return o; };
  const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 1 })), chunk('IEND', Buffer.alloc(0))]);
};

export default async function (ctx) {
  const T = '__ts6modFilesTest', LIM = 1e6;
  const ev = e => ctx.eval(e);
  await ctx.disable('files');
  await ev(`__ts6mod.store().settings.files = {limitMB: 1, maxRes: 1000, margin: 5, format: 'jpeg', alpha: 'webp', chat: true, filesTab: true}; 0`);
  const dir = mkdtempSync(join(process.env.HOME || '.', 'tmp', 'ts6files-'));
  const cleanup = async () => { try { await ev(`${T}.removeFakeModel(); ${T}.dialogPaths = null; ${T}.clearPreviews(); ${T}.unforceChat(); delete __ts6mod.store().settings.files; 0`); } catch (e) { /* page gone */ } rmSync(dir, { recursive: true, force: true }); };
  try {
    ctx.assert(await ev(`${T}.chatAvailable()`), 'a chat composer is displayed (run-all opens one)');
    ctx.assert(await ev(`${T}.forceChat()`), 'composer accepts attachments (forced: a plain TS3 chat has no attach button)');
    await ev(`${T}.clearPreviews(); 0`);
    const previews = () => ev(`${T}.previews()`);
    const waitPreviews = async (n, msg) => { for (let i = 0; i < 100; i++) { const p = await previews(); if (p.length >= n) return p; await ctx.sleep(150); } throw new Error('timeout: ' + msg); };
    const big = `${T}.makeFile({noise: {w: 1600, h: 1200}, name: 'big.png'})`;

    /* ---- off: stock behaviour (the stock drop limit is 5 MB, so a 7 MB image is rejected, a 2 MB one is attached unchanged) ---- */
    await ev(`(async () => { const f = await ${big}; ${T}.dropOnChat([f]); return 0; })()`);
    await ctx.sleep(1200);
    ctx.equal((await previews()).length, 0, 'off: a 7 MB image is rejected by the stock drop limit, nothing attached');

    await ctx.enable('files');

    /* ---- chat drop ---- */
    await ev(`(async () => { const f = await ${big}; window.__bigSize = f.size; ${T}.dropOnChat([f]); return 0; })()`);
    let p = await waitPreviews(1, 'dropped big PNG appears compressed');
    ctx.assert(await ev('window.__bigSize') > 5e6, 'fixture is over the stock 5 MB limit');
    ctx.assert(p[0].bytes <= LIM && p[0].w <= 1000 && p[0].mime === 'image/jpeg' && /\.jpg$/.test(p[0].name), `drop: <= 1 MB, <= 1000 px, jpeg (got ${JSON.stringify(p[0])})`);
    ctx.assert(p[0].w / p[0].h > 1.3 && p[0].w / p[0].h < 1.36, 'aspect ratio kept (4:3)');
    const log = await ev('window.__ts6modFilesLog');
    ctx.assert(log.length >= 1 && log[0].to.quality > 0.3 && log[0].to.quality <= 0.98, 'quality was chosen automatically: ' + log[0].to.quality);
    await ev(`${T}.clearPreviews(); 0`);

    /* ---- chat paste ---- */
    await ev(`(async () => { ${T}.pasteOnChat([await ${big}.then(f => new File([f], 'image.png', {type: 'image/png'}))]); return 0; })()`);
    p = await waitPreviews(1, 'pasted big PNG appears compressed');
    ctx.assert(p[0].bytes <= LIM && p[0].mime === 'image/jpeg' && /^image_\d+\.jpg$/.test(p[0].name), `paste: <= 1 MB, jpeg, stock-style name (got ${JSON.stringify(p[0])})`);
    await ev(`${T}.clearPreviews(); 0`);

    /* ---- untouched: image under the limit, gif over the limit, zip ---- */
    await ev(`(async () => { const f = await ${T}.makeFile({noise: {w: 120, h: 90}, name: 'small.png'}); window.__smallSize = f.size; ${T}.dropOnChat([f]); return 0; })()`);
    p = await waitPreviews(1, 'small image attached');
    ctx.equal([p[0].name, p[0].bytes, p[0].mime], ['small.png', await ev('window.__smallSize'), 'image/png'], 'under the limit: attached unchanged');
    await ev(`${T}.clearPreviews(); 0`);
    await ev(`(async () => { const u = new Uint8Array(2e6); for (let o = 0; o < u.length; o += 65536) crypto.getRandomValues(u.subarray(o, Math.min(u.length, o + 65536))); u.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]); window.__gifSize = u.length; ${T}.dropOnChat([new File([u], 'anim.gif', {type: 'image/gif'})]); return 0; })()`);
    p = await waitPreviews(1, 'gif attached');
    ctx.equal([p[0].name, p[0].bytes], ['anim.gif', 2e6], 'gif over the limit: untouched');
    await ev(`${T}.clearPreviews(); 0`);
    await ev(`(async () => { ${T}.dropOnChat([await ${T}.makeFile({zip: 2e6, name: 'a.zip'})]); return 0; })()`);
    p = await waitPreviews(1, 'zip attached');
    ctx.equal([p[0].name, p[0].bytes], ['a.zip', 2e6], 'zip over the mod limit (under the stock one): untouched');
    await ev(`${T}.clearPreviews(); 0`);
    await ev(`(async () => { ${T}.dropOnChat([await ${T}.makeFile({zip: 6e6, name: 'b.zip'})]); return 0; })()`);
    await ctx.sleep(1200);
    ctx.equal((await previews()).length, 0, 'zip over the stock limit: stock rejection, mod does not touch it');

    /* ---- transparency per setting ---- */
    const alphaCase = async (mode, mime, fmt) => {
      await ev(`__ts6mod.store().settings.files.alpha = '${mode}'; ${fmt ? `__ts6mod.store().settings.files.format = '${fmt}';` : ''} 0`);
      await ev(`(async () => { ${T}.dropOnChat([await ${T}.makeFile({noise: {w: 1400, h: 1000, alpha: true}, name: 'alpha.png'})]); return 0; })()`);
      const q = await waitPreviews(1, 'alpha PNG (' + mode + ')');
      await ev(`${T}.clearPreviews(); 0`);
      return q[0];
    };
    let a = await alphaCase('webp');
    ctx.assert(a.mime === 'image/webp' && a.alpha === true && a.bytes <= LIM, `alpha=webp keeps transparency in WebP, <= 1 MB (got ${JSON.stringify(a)})`);
    a = await alphaCase('png');
    ctx.assert(a.mime === 'image/png' && a.alpha === true && a.bytes <= LIM && a.w < 1000, `alpha=png stays PNG with alpha, shrunk until it fits (got ${JSON.stringify(a)})`);
    a = await alphaCase('flatten');
    ctx.assert(a.mime === 'image/jpeg' && a.alpha === false && a.bytes <= LIM, `alpha=flatten gives an opaque JPEG (got ${JSON.stringify(a)})`);
    await ev(`__ts6mod.store().settings.files.format = 'webp'; 0`);
    a = await alphaCase('flatten');
    ctx.assert(a.mime === 'image/webp' && a.alpha === false, 'output format WebP honoured (opaque)');
    await ev(`__ts6mod.store().settings.files.format = 'jpeg'; 0`);

    /* ---- attach button (native path: read through the injector binding) ---- */
    const bigPath = join(dir, 'pick.png'), smallPath = join(dir, 'tiny.png'), txtPath = join(dir, 'note.txt');
    writeFileSync(bigPath, png(1500, 1100)); writeFileSync(smallPath, png(60, 40)); writeFileSync(txtPath, 'hello');
    const reader = await ev(`typeof window.ts6modReadImage`);
    if (reader !== 'function') ctx.log('SKIP picker routes: injector read binding missing (client not started by launcher/ts6-mod)');
    else {
      const rej = await ev(`${T}.makeFile({path: '${txtPath}'}).then(() => 'read', e => String(e.message))`);
      ctx.equal(rej, 'not an image', 'the injector reader refuses a non-image file');
      const rej2 = await ev(`${T}.makeFile({path: '/etc/hostname'}).then(() => 'read', e => String(e.message))`);
      ctx.equal(rej2, 'not an image', 'the injector reader refuses a system file');
      await ev(`${T}.dialogPaths = ${JSON.stringify([bigPath, smallPath, txtPath])}; ${T}.pickInChat()`);
      p = await waitPreviews(3, 'picker adds three previews');
      const comp = p.find(x => x.name === 'pick.jpg');
      ctx.assert(comp && comp.bytes <= LIM && comp.w <= 1000 && comp.mime === 'image/jpeg', 'picker: big path image arrives compressed (data URL), <= 1 MB, <= 1000 px');
      ctx.equal(p.filter(x => x.path).map(x => x.path).sort(), [smallPath, txtPath].sort(), 'picker: small image and text file stay native paths');
      await ev(`${T}.clearPreviews(); ${T}.dialogPaths = null; 0`);
    }

    /* ---- Files tab (stand-in model: same two methods the Files tab uses) ---- */
    await ev(`${T}.installFakeModel()`);
    await ctx.sleep(900);   // the DOM observer patches the new model
    await ev(`(async () => { await ${T}.fakeUpload(await ${big}); await ${T}.fakeUpload(await ${T}.makeFile({noise: {w: 80, h: 60}, name: 'tiny.png'})); return 0; })()`);
    let calls = await ev(`${T}.fakeCalls()`);
    ctx.assert(calls[0].size <= LIM && calls[0].type === 'image/jpeg' && calls[0].name === 'big.jpg', 'Files tab drop: big image uploaded compressed (' + JSON.stringify(calls[0]) + ')');
    ctx.equal([calls[1].name, calls[1].type], ['tiny.png', 'image/png'], 'Files tab drop: small image uploaded unchanged');
    if (reader === 'function') {
      await ev(`${T}.fakeCalls().length = 0; ${T}.dialogPaths = ${JSON.stringify([bigPath, txtPath])}; (async () => { await ${T}.fakePick(); return 0; })()`);
      await ctx.sleep(1500);
      calls = await ev(`${T}.fakeCalls()`);
      ctx.assert(calls.some(c => c.kind === 'data' && c.size <= LIM && c.name === 'pick.jpg') && calls.some(c => c.kind === 'paths' && c.paths.length === 1 && c.paths[0] === txtPath), 'Files tab button: image compressed and sent as a file, the text file goes the stock path route');
    }

    /* ---- off again: stock behaviour, no trace ---- */
    await ctx.disable('files');
    await ev(`${T}.fakeCalls().length = 0; (async () => { await ${T}.fakeUpload(await ${big}); return 0; })()`);
    calls = await ev(`${T}.fakeCalls()`);
    ctx.assert(calls.length === 1 && calls[0].name === 'big.png' && calls[0].size > 5e6, 'off again: Files tab method restored (original 7 MB PNG passes through)');
    await ev(`(async () => { ${T}.dropOnChat([await ${big}]); return 0; })()`);
    await ctx.sleep(1200);
    ctx.equal((await previews()).length, 0, 'off again: stock drop limit applies again');
    await ctx.assertClean('files');
  } finally { await cleanup(); }
}

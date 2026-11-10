#!/usr/bin/env node
// Injects the mod framework (panel/core/*, panel/mods/*/index.js [+ panel/examples/* with --examples]) into the running
// TS6 UI over CDP and keeps the socket open, so the registration (Page.addScriptToEvaluateOnNewDocument) lives as long as
// the client. No Page.reload, ever (it wipes the client's auto-connect state).
//   node mods-inject.mjs [--cdp-port 9222] [--port 38998] [--examples]    (--port = native control API port; env TS6MOD_EXAMPLES=1 = --examples)
// Exits when the client's debug port has been gone for ~10 s (client closed).
import { connect, targets } from './cdp.mjs';
import { buildBundle } from './bundle.mjs';
import { open, realpath, lstat } from 'node:fs/promises';
import { basename } from 'node:path';

const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? +a[i + 1] : d; };
const cdpPort = opt('--cdp-port', 9222), ctlPort = opt('--port', 38998);
// Narrow read-only image reader for the "files" mod (the chat's file picker hands the client a native path string that the page
// cannot read). Regular files only (realpath + lstat), image magic bytes checked (not the name), size cap, chunked base64.
// Never lists, never writes. Docs: superdoc/features/mod-files.md ("Reading picker paths").
const IMG_MAX = 200 * 1024 * 1024, CHUNK_MAX = 8 * 1024 * 1024;
function imageMime(h) {
  if (h.length >= 8 && h.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return 'image/png';
  if (h.length >= 3 && h[0] === 0xff && h[1] === 0xd8 && h[2] === 0xff) return 'image/jpeg';
  if (h.length >= 12 && h.toString('latin1', 0, 4) === 'RIFF' && h.toString('latin1', 8, 12) === 'WEBP') return 'image/webp';
  if (h.length >= 6 && /^GIF8[79]a$/.test(h.toString('latin1', 0, 6))) return 'image/gif';
  if (h.length >= 2 && h.toString('latin1', 0, 2) === 'BM') return 'image/bmp';
  return null;
}
async function readImage({ path, offset = 0, length = 0 }) {
  if (typeof path !== 'string' || !path.startsWith('/') || path.includes('\0')) throw new Error('bad path');
  const real = await realpath(path), st = await lstat(real);
  if (!st.isFile()) throw new Error('not a regular file');
  if (st.size > IMG_MAX) throw new Error('too large');
  const fh = await open(real, 'r');
  try {
    const head = Buffer.alloc(16), { bytesRead } = await fh.read(head, 0, 16, 0);
    const mime = imageMime(head.subarray(0, bytesRead));
    if (!mime) throw new Error('not an image');
    const n = Math.max(0, Math.min(+length || 0, CHUNK_MAX, st.size - (+offset || 0)));
    let b64 = '';
    if (n > 0) { const buf = Buffer.alloc(n), r = await fh.read(buf, 0, n, +offset); b64 = buf.subarray(0, r.bytesRead).toString('base64'); }
    return { size: st.size, name: basename(real), mime, b64 };
  } finally { await fh.close(); }
}

const examples = a.includes('--examples') || process.env.TS6MOD_EXAMPLES === '1';

let gone = 0;
for (;;) {
  try {
    const t = (await targets(cdpPort)).find(t => t.url.startsWith('tsui://'));
    if (!t) throw new Error('no tsui page yet');
    gone = 0;
    const c = await connect(cdpPort), code = buildBundle({ examples });   // read from disk on every (re)connect
    await c.send('Page.enable');
    // The stock UI page cannot open http:// connections at all (net::ERR_UNKNOWN_URL_SCHEME), so mods reach the native
    // control API through this binding: page -> ts6modNative(json) -> here -> HTTP -> reply via evaluate.
    await c.send('Runtime.enable');
    await c.send('Runtime.addBinding', { name: 'ts6modNative' });
    await c.send('Runtime.addBinding', { name: 'ts6modReadImage' });
    c.on(async m => {
      if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'ts6modReadImage') return;
      let req, out;
      try { req = JSON.parse(m.params.payload); out = { id: req.id, ok: true, ...(await readImage(req)) }; }
      catch (e) { out = { id: req?.id, ok: false, error: String(e.message || e) }; }
      try { await c.send('Runtime.evaluate', { expression: `window.__ts6modImgReply&&window.__ts6modImgReply(${JSON.stringify(out)})` }); } catch (e) { /* page gone */ }
    });
    c.on(async m => {
      if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'ts6modNative') return;
      let req, out;
      try {
        req = JSON.parse(m.params.payload);
        if (!/^\/(config|status|meters|speakers|speaker)$/.test(req.path)) throw new Error('bad path');
        const r = await fetch(`http://127.0.0.1:${ctlPort}${req.path}`, { method: req.body === undefined ? 'GET' : 'POST', body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: AbortSignal.timeout(1500) });
        out = { id: req.id, ok: r.ok, status: r.status, text: await r.text() };
      } catch (e) { out = { id: req?.id, ok: false, status: 0, text: String(e) }; }
      try { await c.send('Runtime.evaluate', { expression: `window.__ts6modReply&&window.__ts6modReply(${JSON.stringify(out)})` }); } catch (e) { /* page gone */ }
    });
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: code });
    await c.eval(code);   // idempotent (window.__ts6mod guard); the core waits for the Vue app itself
    console.log('ts6-mods framework injected into', c.target.url, examples ? '(with examples)' : '');
    await new Promise(res => { c.ws.onclose = res; });
  } catch (e) {
    if (!/no tsui page|fetch failed|ws connect failed|ECONNREFUSED/.test(String(e))) console.error(String(e));
    if (/no tsui page/.test(String(e))) gone = 0; // client still starting: keep waiting
    else if (++gone > 40) { console.log('client gone, exiting'); process.exit(0); }
  }
  await new Promise(r => setTimeout(r, 250 + Math.min(gone, 20) * 25));
}

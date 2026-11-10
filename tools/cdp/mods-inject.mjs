#!/usr/bin/env node
// Injects panel/panel.js (+ panel.css) into the running TS6 UI over CDP and keeps the socket open, so the
// registration (Page.addScriptToEvaluateOnNewDocument) lives as long as the client. No Page.reload, ever.
//   node mods-inject.mjs [--cdp-port 9222] [--port 38998]    (--port = native control API port)
// Exits when the client's debug port has been gone for ~10 s (client closed).
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { connect, targets } from './cdp.mjs';

const a = process.argv.slice(2), opt = (n, d) => { const i = a.indexOf(n); return i >= 0 ? +a[i + 1] : d; };
const cdpPort = opt('--cdp-port', 9222), ctlPort = opt('--port', 38998);
const panelDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel');
const src = () => `window.__ts6modCss=${JSON.stringify(readFileSync(join(panelDir, 'panel.css'), 'utf8'))};\n` + readFileSync(join(panelDir, 'panel.js'), 'utf8');

let gone = 0;
for (;;) {
  try {
    const t = (await targets(cdpPort)).find(t => t.url.startsWith('tsui://'));
    if (!t) throw new Error('no tsui page yet');
    gone = 0;
    const c = await connect(cdpPort), code = src();
    await c.send('Page.enable');
    // The stock UI page cannot open http:// connections at all (net::ERR_UNKNOWN_URL_SCHEME), so the panel reaches
    // the native control API through this binding: page -> ts6modNative(json) -> here -> HTTP -> reply via evaluate.
    await c.send('Runtime.enable');
    await c.send('Runtime.addBinding', { name: 'ts6modNative' });
    c.on(async m => {
      if (m.method !== 'Runtime.bindingCalled' || m.params.name !== 'ts6modNative') return;
      let req, out;
      try {
        req = JSON.parse(m.params.payload);
        if (!/^\/(config|status|meters)$/.test(req.path)) throw new Error('bad path');
        const r = await fetch(`http://127.0.0.1:${ctlPort}${req.path}`, { method: req.body === undefined ? 'GET' : 'POST', body: req.body === undefined ? undefined : JSON.stringify(req.body), signal: AbortSignal.timeout(1500) });
        out = { id: req.id, ok: r.ok, status: r.status, text: await r.text() };
      } catch (e) { out = { id: req?.id, ok: false, status: 0, text: String(e) }; }
      try { await c.send('Runtime.evaluate', { expression: `window.__ts6modReply&&window.__ts6modReply(${JSON.stringify(out)})` }); } catch (e) { /* page gone */ }
    });
    await c.send('Page.addScriptToEvaluateOnNewDocument', { source: code });
    await c.eval(code);   // the script is idempotent and waits for the Vue app itself
    console.log('ts6-mods panel injected into', c.target.url);
    await new Promise(res => { c.ws.onclose = res; });
  } catch (e) {
    if (!/no tsui page|fetch failed|ws connect failed|ECONNREFUSED/.test(String(e))) console.error(String(e));
    if (/no tsui page/.test(String(e))) gone = 0; // client still starting: keep waiting
    else if (++gone > 40) { console.log('client gone, exiting'); process.exit(0); }
  }
  await new Promise(r => setTimeout(r, 250 + Math.min(gone, 20) * 25));
}

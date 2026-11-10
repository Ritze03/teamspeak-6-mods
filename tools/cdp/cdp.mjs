#!/usr/bin/env node
// Minimal dependency-free CDP helper for the TeamSpeak 6 client (Node >= 22, global WebSocket).
//   node cdp.mjs [--port 9222] list                  list page targets
//   node cdp.mjs [--port 9222] eval '<expr>'         evaluate in the UI page, print JSON result
//   node cdp.mjs [--port 9222] inject <file.js>      register for every new document + run now, then EXIT (registration dies with the socket!)
//   node cdp.mjs [--port 9222] watch <file.js>       like inject but stays connected, so the script is re-run on every UI reload
// Library use: import { targets, connect } from './cdp.mjs'; const c = await connect(); await c.send('Runtime.evaluate', {...});
// The client must have been started with --remote-debugging-port=<port> (binds 127.0.0.1 only).

export async function targets(port = 9222) {
  const r = await fetch(`http://127.0.0.1:${port}/json`);
  return (await r.json()).filter(t => t.type === 'page');
}

export async function connect(port = 9222) {
  const t = (await targets(port)).find(t => t.url.startsWith('tsui://')) ?? (await targets(port))[0];
  if (!t) throw new Error('no page target');
  const ws = new WebSocket(t.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws connect failed')); });
  let id = 0; const pending = new Map(); const listeners = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id && pending.has(m.id)) { const { res, rej } = pending.get(m.id); pending.delete(m.id); m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result); }
    else listeners.forEach(f => f(m));
  };
  return {
    target: t, ws,
    send: (method, params = {}) => new Promise((res, rej) => { pending.set(++id, { res, rej }); ws.send(JSON.stringify({ id, method, params })); }),
    on: f => listeners.push(f),
    close: () => ws.close(),
    // evaluate expression; awaitPromise so async expressions work; returns the JS value
    async eval(expression) {
      const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description ?? r.exceptionDetails.text);
      return r.result.value;
    },
  };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const a = process.argv.slice(2); let port = 9222;
  if (a[0] === '--port') { port = +a[1]; a.splice(0, 2); }
  const [cmd, arg] = a;
  if (cmd === 'list') console.log(JSON.stringify((await targets(port)).map(({ id, title, url }) => ({ id, title, url })), null, 1));
  else if (cmd === 'watch') {
    const { readFileSync } = await import('node:fs'); const src = readFileSync(arg, 'utf8');
    for (;;) { // reconnect loop: the registration is per CDP session, so redo it after the socket drops
      try {
        const c = await connect(port); await c.send('Page.enable');
        await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src }); await c.eval(src);
        console.log('watching', c.target.url); await new Promise(res => { c.ws.onclose = res; });
      } catch (e) { console.error(String(e)); }
      await new Promise(r => setTimeout(r, 1000));
    }
  }
  else if (cmd === 'eval' || cmd === 'inject') {
    const c = await connect(port);
    try {
      if (cmd === 'eval') console.log(JSON.stringify(await c.eval(arg), null, 1));
      else {
        const { readFileSync } = await import('node:fs'); const src = readFileSync(arg, 'utf8');
        await c.send('Page.enable'); // without Page.enable the registration did not fire after reload in testing
        const { identifier } = await c.send('Page.addScriptToEvaluateOnNewDocument', { source: src });
        await c.eval(src); console.log('injected, identifier', identifier);
      }
    } finally { c.close(); }
  } else { console.error('usage: cdp.mjs [--port N] list | eval <expr> | inject <file> | watch <file>'); process.exit(2); }
  process.exit(0);
}

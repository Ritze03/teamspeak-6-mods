#!/usr/bin/env node
// Runs every check of the mod framework against a RUNNING modded client (start it with launcher/ts6-mod).
//   node tools/test/run-all.mjs [--cdp-port 9222] [--control-port 38998] [--examples] [--no-reload] [--only <mod-id>]...
// Steps:  1 lint (no raw TS names in panel/mods/)   2 anchor health check (every anchor resolves on this client)
//         3 native signature scan (native/test/sigscan.sh if present, else SKIP)   4 every panel/mods/*/test.mjs
//         (+ panel/examples/*/test.mjs with --examples), then the core/slot tests of tools/test/core-tests.mjs   5 vanilla check (all mods off = no mod DOM/listeners/timers)
// Before step 2 the panel code on disk is hot-replaced into the page (like tools/cdp/mods-reload.mjs, never Page.reload) so the
// tests judge the repo state; --no-reload skips that. Mod switches are toggled in memory only (persist:false) and restored at
// the end; the page route is restored after every test. Exit code 1 on any FAIL, 0 otherwise (SKIP does not fail).
//
// test.mjs contract:  export default async function (ctx) { ... }   (throw / failed assert = FAIL)
//   ctx.eval(expr)            evaluate an expression in the UI page (promises awaited), returns the JSON value
//   ctx.enable(id) / ctx.disable(id)   switch a mod on/off in memory, resolves when done (enable() waits for enable() to finish)
//   ctx.assert(cond, msg) / ctx.equal(actual, expected, msg)   (deep equality for arrays/objects)
//   ctx.assertClean(id)       the mod is off and left no trace: nothing in its cleanup ledger, no [data-ts6mod="id"] node
//   ctx.waitFor(expr, msg, ms=5000)    poll an expression until truthy, else fail with msg
//   ctx.openModsPage(id?, tab?) / ctx.restoreRoute()   navigate to the Mods page (overview, or mod <id>'s own page, optionally
//                             on its tab <tab>) / back to where the test started
//   ctx.pressEscape()         trusted Escape key (closes menus/popups that ignore synthetic events)
//   ctx.sleep(ms), ctx.log(text), ctx.trace()  (core diagnostics), ctx.controlPort, ctx.cdpPort, ctx.cdp (raw CDP client)
//   ctx.onTestServer()        true only when every connection of the client goes to the LOCAL test server (127.0.0.1 / localhost).
//                             Gate EVERY server-side action on it (messages, joins/moves, channel creation, serverquery, uploads,
//                             pokes, mutes that reach the server): the suite also runs against the user's real client and server.
//   ctx.clientProfile()       {configDir, isolated}: the config dir of the client under test (from its process environment);
//                             isolated = not the user's real ~/.config, i.e. a TS6MOD_PROFILE_DIR client. Never write a real profile.
//   ctx.skip(part, reason)    print a SKIP line for a part of the test that cannot run on this client (does not fail the test)
// Isolated clients (never the real profile) are muted (mic + speakers) for the whole run and their window is parked on the hidden Hyprland
// workspace: tools/test/mute-test-clients.mjs, tools/rig/hide-client.sh (user rule, superdoc/features/test-rig.md "Audio isolation").
// Side effects of the run itself are put back at the end: mod switches (in memory), the persisted mods blob, route, window size
// override, clipboard text.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect } from '../cdp/cdp.mjs';
import { buildBundle, listMods } from '../cdp/bundle.mjs';
import { startMuting } from './mute-test-clients.mjs';

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const a = process.argv.slice(2), val = n => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const cdpPort = +(val('--cdp-port')[0] ?? 9222), controlPort = +(val('--control-port')[0] ?? 38998);
const examples = a.includes('--examples'), reload = !a.includes('--no-reload'), only = val('--only');
const out = { pass: 0, fail: 0, skip: 0 };
const line = (tag, name, extra = '') => { out[tag.toLowerCase()]++; console.log(`${tag.padEnd(4)}  ${name}${extra ? '  ' + extra : ''}`); };
const sleep = ms => new Promise(r => setTimeout(r, ms));

/* ---------- 1 lint ---------- */
{
  const r = spawnSync('grep', ['-rnE', '(^|[^a-zA-Z0-9_])tsv?-|__vue__|tsclient_internal', join(root, 'panel', 'mods')], { encoding: 'utf8' });
  if (r.status === 1) line('PASS', 'lint: no raw TS names in panel/mods/');
  else if (r.status === 0) { line('FAIL', 'lint: raw TS names in panel/mods/ (belong in panel/core/anchors.js)'); console.log(r.stdout.trim().split('\n').map(l => '        ' + l.replace(root + '/', '')).join('\n')); }
  else line('FAIL', 'lint: grep failed', r.stderr);
}

/* ---------- connect ---------- */
let cdp;
try { cdp = await connect(cdpPort); } catch (e) { line('FAIL', `connect to the client (CDP port ${cdpPort})`, String(e.message || e)); console.log(`\n${out.pass} passed, ${out.fail} failed, ${out.skip} skipped`); process.exit(1); }
const ev = async expr => { try { return await cdp.eval(expr); } catch (e) { throw new Error(`${e.message || e} (in: ${String(expr).replace(/\s+/g, ' ').slice(0, 90)})`); } };
const waitFor = async (expr, msg, ms = 5000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = await ev(expr); } catch (e) { /* page busy */ } if (v) return; if (Date.now() - t0 > ms) throw new Error('timeout: ' + msg); await sleep(100); } };

/* the client under test: test server? isolated profile? (the safety gates of the tests) */
const onTestServer = async () => !!(await ev(`(() => { const cs = __ts6mod.anchors.get('app.controller').connections || []; return cs.length > 0 && cs.every(c => c.connectInfo && /^(127\\.0\\.0\\.1|localhost|::1)$/.test(String(c.connectInfo.address))); })()`).catch(() => false));
function clientProfile() {   // read HOME / XDG_CONFIG_HOME of the process that owns our CDP port
  const real = join(homedir(), '.config');
  try {
    for (const pid of readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
      let cmd; try { cmd = readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0'); } catch (e) { continue; }
      if (!cmd.includes(`--remote-debugging-port=${cdpPort}`)) continue;
      const env = Object.fromEntries(readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean).map(l => l.split(/=(.*)/s).slice(0, 2)));
      const configDir = env.XDG_CONFIG_HOME || (env.HOME ? join(env.HOME, '.config') : real);
      return { configDir, isolated: configDir.replace(/\/+$/, '') !== real };
    }
  } catch (e) { /* no /proc */ }
  return { configDir: null, isolated: false };   // unknown: treat as the real profile
}
const profile = clientProfile();
console.log(`        client: CDP ${cdpPort}, ${profile.isolated ? 'isolated profile' : 'REAL profile (file-writing parts are skipped)'}, ${(await onTestServer()) ? 'local test server' : 'not the local test server (server-side parts are skipped)'}`);

/* user rule: a test client never uses the user's real microphone or speakers (the user talks on TeamSpeak while tests run).
 * Isolated clients are throw-away: mute capture + playback (app toggles AND the audio streams, re-applied every 500 ms so a test that
 * reconnects a client stays muted; nothing is restored) and park the window on the hidden Hyprland workspace. Covers the second client
 * given by AWARE_P2_CDP / TS6MOD_CHAT_CDP2 too. The user's real client is never muted. Why/how: superdoc/features/test-rig.md. */
const secondPorts = [process.env.AWARE_P2_CDP, process.env.TS6MOD_CHAT_CDP2].filter(Boolean).map(Number).filter((p, i, l) => p && p !== cdpPort && l.indexOf(p) === i);
let stopMuting = () => {};
if (profile.isolated) {
  const ports = [cdpPort, ...secondPorts];
  stopMuting = await startMuting({ ports, log: t => console.log('        ' + t) });
  spawnSync(join(root, 'tools', 'rig', 'hide-client.sh'), ports.map(String), { stdio: 'ignore' });   // fallback when no windowrule moves it
  const st = await ev(`(() => { const h = (__ts6mod.anchors.get('app.controller').connections || []).map(c => c.serverConnectionHandler).filter(Boolean)[0]; const me = h && h.ownClient; return me ? [!!me.properties.inputMuted, !!me.properties.outputMuted] : null; })()`).catch(() => null);
  console.log(`        audio isolation: ports ${ports.join(', ')} muted (own mic/speaker state [input, output] = ${JSON.stringify(st)}${st ? '' : ': not connected yet, re-applied on connect'})`);
}

/* clipboard text: some tests copy into it (copy-ID menu, diagnostics); put the user's text back at the end */
let clip0 = null;
try {
  await cdp.send('Browser.grantPermissions', { permissions: ['clipboardReadWrite', 'clipboardSanitizedWrite'], origin: 'tsui://default' }).catch(() => {});
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
  clip0 = await ev(`navigator.clipboard.readText().catch(() => null)`);
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
} catch (e) { clip0 = null; }

// a fresh client window is 300x400, which collapses the sidebar/tree: emulate 1280x800 for the run, cleared at the end
let emulated = false;
try {
  const [w, h] = await ev('[innerWidth, innerHeight]');
  if (w < 1000 || h < 700) { await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false }); emulated = true; await sleep(500); }
} catch (e) { /* best effort */ }
const origRoute = await ev('__ts6mod.route().fullPath').catch(() => null);

if (reload) {
  try {
    await ev(buildBundle({ examples, replace: true }));
    await waitFor('window.__ts6mod && window.__ts6mod.started && window.__ts6mod.ready !== false', 'framework started after reload', 30000);
  } catch (e) { line('FAIL', 'hot-load panel code from disk', String(e.message || e)); }
} else if (examples) {   // keep the live core, just add the examples
  const { buildLoadScript } = await import('../cdp/bundle.mjs');
  try { await ev(buildLoadScript({ examples: true, only: listMods({ examples: true }).filter(m => m.source === 'example').map(m => m.id) })); } catch (e) { line('FAIL', 'load examples', String(e.message || e)); }
}
const framework = await ev('!!(window.__ts6mod && window.__ts6mod.started)').catch(() => false);
if (!framework) { line('FAIL', 'mod framework is running in the client', 'start the client with launcher/ts6-mod (and check __ts6mod.error)'); console.log(`\n${out.pass} passed, ${out.fail} failed, ${out.skip} skipped`); process.exit(1); }
const loadErrors = await ev('__ts6mod.stats.loadErrors');
if (loadErrors.length) for (const le of loadErrors) line('FAIL', `mod ${le.id} failed to load`, le.error.split('\n')[0]); else line('PASS', 'all mod files loaded without errors');

/* ---------- 2 anchors ---------- */
{
  const startAt = await ev('__ts6mod.route().fullPath');
  await ev('__ts6mod.showOwnChannelChat()').catch(() => {}); await sleep(1500);   // a view with tree rows and the chat composer, so the optional anchors resolve too
  const res = await ev('__ts6mod.anchors.check()');
  await ev(`__ts6mod.goto(${JSON.stringify(startAt)})`).catch(() => {});
  const bad = res.filter(r => !r.ok), absent = res.filter(r => r.ok && !r.found);
  if (!bad.length) line('PASS', `anchors: ${res.length} entries resolve`, absent.length ? `(${absent.length} optional absent right now: ${absent.map(r => r.name).join(', ')})` : '');
  for (const r of bad) line('FAIL', `anchor ${r.name}`, `${r.desc} -> ${r.note}  (fix in panel/core/anchors.js)`);
}

/* ---------- 3 native signature scan ---------- */
{
  const sc = join(root, 'native', 'test', 'sigscan.sh');
  if (!existsSync(sc)) line('SKIP', 'native signature scan', 'native/test/sigscan.sh does not exist yet');
  else { const r = spawnSync('bash', [sc], { encoding: 'utf8' }); line(r.status === 0 ? 'PASS' : 'FAIL', 'native signature scan', r.status === 0 ? '' : (r.stdout + r.stderr).trim().split('\n').slice(-3).join(' | ')); }
}

/* ---------- 4 mod tests ---------- */
const initial = await ev(`Object.fromEntries(__ts6mod.list().map(m => [m.id, m.enabled]))`);
// the persisted mods blob: tests change mod settings through api.storage (which saves the whole store), so it is put back at the end
const blob0 = await ev(`__ts6mod.anchors.bridge.getBlob('mods')`).catch(() => undefined);
let startRoute = await ev('__ts6mod.route().fullPath');
if (startRoute.includes('TS6Mods') || startRoute.startsWith('/dashboard')) { startRoute = '/'; await ev(`__ts6mod.goto('/')`); await sleep(500); }   // the Mods page itself must not be the starting point
function makeCtx(name) {
  const touched = new Set();
  const c = {
    cdp, cdpPort, controlPort, sleep, waitFor, eval: ev, onTestServer, clientProfile: () => profile,
    log: t => console.log('        ' + t),
    skip: (part, reason) => line('SKIP', `${name}: ${part}`, reason),
    assert(cond, msg) { if (!cond) throw new Error('assert: ' + msg); },
    equal(actual, expected, msg) { if (JSON.stringify(actual) !== JSON.stringify(expected)) throw new Error(`assert: ${msg} (got ${JSON.stringify(actual)}, expected ${JSON.stringify(expected)})`); },
    async enable(id) { touched.add(id); const on = await ev(`__ts6mod.setEnabled(${JSON.stringify(id)}, true, {persist: false})`); const err = await ev(`(__ts6mod.list().find(m => m.id === ${JSON.stringify(id)}) || {}).error`); if (!on) throw new Error(`mod ${id} did not enable: ${err}`); },
    async disable(id) { touched.add(id); await ev(`__ts6mod.setEnabled(${JSON.stringify(id)}, false, {persist: false})`); },
    async assertClean(id) {
      const j = JSON.stringify(id), r = await ev(`({enabled: __ts6mod.isEnabled(${j}), ledger: __ts6mod.ledger(${j}), nodes: document.querySelectorAll('[data-ts6mod=' + ${j} + ']').length})`);
      if (r.enabled) throw new Error(`assert: mod ${id} is still enabled`);
      if (r.ledger && Object.keys(r.ledger).length) throw new Error(`assert: mod ${id} left registrations behind: ${JSON.stringify(r.ledger)}`);
      if (r.nodes) throw new Error(`assert: mod ${id} left ${r.nodes} DOM node(s) behind`);
    },
    trace: () => ev('__ts6mod.trace()'),
    async pressEscape() { for (const type of ['keyDown', 'keyUp']) await cdp.send('Input.dispatchKeyEvent', { type, key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 }); await sleep(300); },   // trusted key event, closes open menus/popups
    async openModsPage(id, tab) {   // the overview, or (with id) that mod's own page, optionally on one of its tabs
      await ev(`__ts6mod.open(${JSON.stringify(id || null)}, ${JSON.stringify(tab || null)})`);
      await waitFor(`__ts6mod.route().fullPath.includes('TS6Mods')`, 'Mods page route');
      await waitFor(id ? `!!document.querySelector('[data-mod-page="${id}"]')` + (tab ? ` && __ts6mod.page.tab() === ${JSON.stringify(tab)}` : '') : `__ts6mod.page.view() === 'grid'`,
        id ? `page of mod ${id}` + (tab ? ', tab ' + tab : '') : 'Mods overview');
      await sleep(300);
    },
    async restoreRoute() { await ev(`__ts6mod.goto(${JSON.stringify(startRoute)})`); await waitFor(`__ts6mod.route().fullPath === ${JSON.stringify(startRoute)}`, 'route restored'); await sleep(200); },
  };
  return { c, touched };
}
const files = [];
for (const m of listMods({ examples })) {
  if (only.length && !only.includes(m.id)) continue;
  const f = join(m.dir, 'test.mjs'); if (existsSync(f)) files.push({ id: m.id, kind: m.source, f }); else line('SKIP', `${m.source} ${m.id}`, 'no test.mjs');
}
for (const { id, kind, f } of files) {
  const name = `${kind} ${id}`, { c, touched } = makeCtx(name);
  try { const fn = (await import(pathToFileURL(f).href)).default; if (typeof fn !== 'function') throw new Error('test.mjs has no default export function'); await fn(c); line('PASS', name); }
  catch (e) { line('FAIL', name, String(e.message || e)); }
  finally {   // put everything back as it was before this test
    for (const [mid, was] of Object.entries(initial)) if (touched.has(mid)) await ev(`__ts6mod.setEnabled(${JSON.stringify(mid)}, ${!!was}, {persist: false})`).catch(() => {});
    await ev(`__ts6mod.goto(${JSON.stringify(startRoute)})`).catch(() => {}); await sleep(200);
  }
}

/* ---------- 4b core + slot tests ---------- */
if (!only.length) {
  const { tests } = await import('./core-tests.mjs');
  for (const [name, fn] of tests) {
    const { c, touched } = makeCtx(name);
    try { await fn(c); line('PASS', name); }
    catch (e) { line('FAIL', name, String(e.message || e)); }
    finally {
      await ev(`__ts6mod.list().filter(m => m.id.startsWith('t-')).forEach(m => __ts6mod.unregister(m.id))`).catch(() => {});   // throw-away test mods, also after a failed test
      for (const [mid, was] of Object.entries(initial)) if (touched.has(mid)) await ev(`__ts6mod.setEnabled(${JSON.stringify(mid)}, ${!!was}, {persist: false})`).catch(() => {});
      await ev(`__ts6mod.goto(${JSON.stringify(startRoute)})`).catch(() => {}); await sleep(300);
    }
  }
}

/* ---------- 5 vanilla check: everything off ---------- */
try {
  /* settle first: the last core test hot-reloads the core, and the new core's one-shot vanilla guard (panel/core/x-audio.js:vanillaGuard,
   * one GET /config per page load) can land up to ~0.5 s later, inside the polling window below. Wait until no request has been made for 1.2 s. */
  for (let quiet = 0, last = -1, i = 0; quiet < 1200 && i < 60; i++) { const n = await ev('__ts6mod.trace().nativeRequests'); quiet = n === last ? quiet + 200 : 0; last = n; await sleep(200); }
  const known = new Set(await ev(`__ts6mod.list().map(m => m.id)`)), ids = Object.keys(initial).filter(id => known.has(id));   // example tests unregister their mods
  for (const id of ids) await ev(`__ts6mod.setEnabled(${JSON.stringify(id)}, false, {persist: false})`);
  const t = await ev('__ts6mod.trace()');
  const left = Object.entries(t.ledgers).filter(([, l]) => l && Object.keys(l).length);
  const problems = [];
  if (t.marked.length) problems.push('DOM left: ' + t.marked.join(', '));
  if (left.length) problems.push('registrations left: ' + JSON.stringify(Object.fromEntries(left)));
  if (t.coreStyle) problems.push('core stylesheet still present');
  if (t.domObserver || t.domSubs) problems.push('DOM observer still running');
  if (Object.keys(t.events).length) problems.push('native event subscriptions left: ' + JSON.stringify(t.events));
  if (t.exts.length || t.slots.length) problems.push('extensions/slots left: ' + [...t.exts, ...t.slots].join(', '));
  const n0 = t.nativeRequests; await sleep(600); const n1 = (await ev('__ts6mod.trace()')).nativeRequests;
  if (n1 !== n0) problems.push(`native polling continues (${n1 - n0} requests in 600 ms)`);
  const modes = await ev('__ts6mod.anchors.settings.keys()');
  if (modes.filter(k => k.startsWith('TS6Mods')).join() !== 'TS6Mods') problems.push('Settings has mod entries other than "Mods": ' + modes.filter(k => k.startsWith('TS6Mods')).join(','));
  if (problems.length) line('FAIL', 'vanilla: all mods off', problems.join('; ')); else line('PASS', `vanilla: all ${ids.length} mods off leaves only the Mods settings entry`);
  for (const [id, was] of Object.entries(initial)) if (was && known.has(id)) await ev(`__ts6mod.setEnabled(${JSON.stringify(id)}, true, {persist: false})`).catch(() => {});
} catch (e) { line('FAIL', 'vanilla check', String(e.message || e)); }

if (blob0 !== undefined) {   // after any debounced save (250 ms) has fired; the in-memory store is put back too, in place
  await sleep(500);
  const restored = await ev(`(async () => { const b0 = ${JSON.stringify(blob0)}; if (await __ts6mod.anchors.bridge.getBlob('mods') === b0) return 'same';
    const o = b0 ? JSON.parse(b0) : {}, st = __ts6mod.store(); st.enabled = o.enabled || {}; st.settings = o.settings || {};
    await __ts6mod.anchors.bridge.saveBlob('mods', b0 || JSON.stringify(st)); return 'restored'; })()`).catch(e => 'failed: ' + e.message);
  if (restored !== 'same') console.log(`        mods blob changed by the tests: ${restored}`);
}
if (origRoute) await ev(`__ts6mod.goto(${JSON.stringify(origRoute)})`).catch(() => {});
if (emulated) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});   // tests must not set their own override (run-all owns it)
if (clip0 !== null) {
  try { await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true }); await ev(`navigator.clipboard.writeText(${JSON.stringify(clip0)}).then(() => 1, () => 0)`); } catch (e) { /* best effort */ }
  await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false }).catch(() => {});
}
stopMuting();
cdp.close();
console.log(`\n${out.pass} passed, ${out.fail} failed, ${out.skip} skipped`);
process.exit(out.fail ? 1 : 0);

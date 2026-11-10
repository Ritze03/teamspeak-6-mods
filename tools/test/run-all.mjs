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
//   ctx.openModsPage() / ctx.restoreRoute()   navigate to the Mods settings page / back to where the test started
//   ctx.pressEscape()         trusted Escape key (closes menus/popups that ignore synthetic events)
//   ctx.sleep(ms), ctx.log(text), ctx.trace()  (core diagnostics), ctx.controlPort, ctx.cdpPort, ctx.cdp (raw CDP client)
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { connect } from '../cdp/cdp.mjs';
import { buildBundle, listMods } from '../cdp/bundle.mjs';

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
const ev = async expr => cdp.eval(expr);
const waitFor = async (expr, msg, ms = 5000) => { const t0 = Date.now(); for (;;) { let v = false; try { v = await ev(expr); } catch (e) { /* page busy */ } if (v) return; if (Date.now() - t0 > ms) throw new Error('timeout: ' + msg); await sleep(100); } };

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
    await waitFor('window.__ts6mod && window.__ts6mod.started', 'framework started after reload', 30000);
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
let startRoute = await ev('__ts6mod.route().fullPath');
if (startRoute.includes('TS6Mods') || startRoute.startsWith('/dashboard')) { startRoute = '/'; await ev(`__ts6mod.goto('/')`); await sleep(500); }   // the Mods page itself must not be the starting point
function makeCtx(name) {
  const touched = new Set();
  const c = {
    cdp, cdpPort, controlPort, sleep, waitFor, eval: ev,
    log: t => console.log('        ' + t),
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
    async openModsPage() { await ev('__ts6mod.open()'); await waitFor(`__ts6mod.route().fullPath.includes('TS6Mods')`, 'Mods page route'); await sleep(300); },
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
  const { c, touched } = makeCtx(id), name = `${kind} ${id}`;
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
  const ids = Object.keys(initial);
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
  for (const [id, was] of Object.entries(initial)) if (was) await ev(`__ts6mod.setEnabled(${JSON.stringify(id)}, true, {persist: false})`).catch(() => {});
} catch (e) { line('FAIL', 'vanilla check', String(e.message || e)); }

if (origRoute) await ev(`__ts6mod.goto(${JSON.stringify(origRoute)})`).catch(() => {});
if (emulated) await cdp.send('Emulation.clearDeviceMetricsOverride').catch(() => {});
cdp.close();
console.log(`\n${out.pass} passed, ${out.fail} failed, ${out.skip} skipped`);
process.exit(out.fail ? 1 : 0);

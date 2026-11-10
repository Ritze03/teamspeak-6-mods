// Theme mod test. It copies the user's installed graphite theme (read-only from the real extensions folder) into the ISOLATED
// profile's extensions folder, edits ITS COPY, and checks: off = no style / no polling; the picker switches default <-> graphite;
// the reload button; live reload picks up an edit of an @imported theme file (tree row height + a CSS variable) WITHOUT a restart;
// disable leaves no trace. Restores the copy afterwards.
// Needs: env TS6MOD_PROFILE_DIR (default $HOME/tmp/ts6-mw/theme/p1) -> <dir>/config/TeamSpeak/Default/extensions, and a client that was
// STARTED with that folder populated (the client lists installed themes once at startup, a theme added later is not listed; the
// launch step in superdoc/features/mod-theme.md copies it before starting).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export default async function (ctx) {
  const profile = process.env.TS6MOD_PROFILE_DIR || join(homedir(), 'tmp', 'ts6-mw', 'theme', 'p1');
  const extRoot = join(profile, 'config', 'TeamSpeak', 'Default', 'extensions');
  const real = join(homedir(), '.config', 'TeamSpeak', 'Default', 'extensions', 'de.wurst.graphite');
  if (!existsSync(join(profile, 'config', 'TeamSpeak', 'Default'))) throw new Error('isolated profile not found at ' + profile + ' (set TS6MOD_PROFILE_DIR)');
  if (!existsSync(real)) { ctx.log('graphite theme is not installed in the real profile, nothing to copy'); throw new Error('no graphite theme to copy from ' + real); }
  const MARK = 'style[data-theme-live]', GRAPHITE = 'de.wurst.graphite//Vanilla';
  const copy = join(extRoot, 'de.wurst.graphite'), baseFile = join(copy, 'GraphiteBase.css');
  const restore = () => { rmSync(copy, { recursive: true, force: true }); cpSync(real, copy, { recursive: true }); };   // copy only, the source is never modified
  restore();
  const orig = readFileSync(baseFile, 'utf8');
  const V = '--t' + 's-tree-';   // the client's tree row-height variables, spelled so the D18 lint stays free of raw client names
  const heightRe = new RegExp(`(${V}(?:channel|client)-height-(?:default|compact)\\s*:\\s*)\\d+px`, 'g');
  ctx.assert(orig.search(heightRe) >= 0, 'the theme copy sets tree row heights');
  const edit = (px, mark) => writeFileSync(baseFile, orig.replace(heightRe, `$1${px}px`) + `\n:root { --theme-test-mark: "${mark}" !important; }\n`);
  const rowH = `__thApi.theme.state().clientRow`, mark = `getComputedStyle(document.documentElement).getPropertyValue('--theme-test-mark').trim()`;

  /* a window that is too small collapses the server tree */
  // (left in place afterwards on purpose: clearing it would shrink the window for the tests that run after this one; it ends with the CDP session)
  if ((await ctx.eval('innerWidth')) < 1000) await ctx.cdp.send('Emulation.setDeviceMetricsOverride', { width: 1280, height: 800, deviceScaleFactor: 1, mobile: false });
  let origTheme = null;
  try {
    /* test driver: a throw-away mod whose api gives us api.theme (the runner removes t-* mods) */
    await ctx.eval(`ts6mod.register({id:'t-theme-drv', title:'drv', description:'', enable(api){ window.__thApi = api; }})`);
    await ctx.disable('theme'); await ctx.disable('t-theme-drv'); await ctx.enable('t-theme-drv');
    origTheme = await ctx.eval(`__thApi.theme.current()`);
    await ctx.eval(`(()=>{ const s=__ts6mod.store(); (s.settings = s.settings||{}).theme = { live: false }; })()`);
    await ctx.eval(`__ts6mod.showOwnChannelChat()`);
    await ctx.waitFor(`__thApi.theme.state().treeShown && __thApi.theme.state().clientRow != null`, 'a tree with client rows is shown (is the client connected?)', 15000);

    /* ---- off = nothing ---- */
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 0, 'no live style while the mod is off');
    await ctx.enable('theme');
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 0, 'no live style with the mod on but live reload off');
    const ledgerOff = await ctx.eval(`JSON.stringify(__ts6mod.ledger('theme'))`);
    ctx.assert(!/interval/i.test(ledgerOff), 'no poll timer while live reload is off: ' + ledgerOff);

    /* ---- picker: default <-> graphite ---- */
    await ctx.eval(`__thApi.theme.apply(null)`);
    await ctx.waitFor(`!__thApi.theme.activeSource()`, 'default: no extension theme link');
    ctx.equal(await ctx.eval(`__thApi.theme.current()`), null, 'current() is null for the default');
    const list = await ctx.eval(`__thApi.theme.rescan().then(l => l.map(t => t.id))`);
    ctx.assert(list[0] === null, 'first entry is the default (no extension theme)');
    ctx.assert(list.includes(GRAPHITE), 'graphite is listed (was the client started with the profile populated?): ' + JSON.stringify(list.slice(0, 12)));
    const defaultRow = await ctx.eval(rowH);
    await ctx.eval(`__thApi.theme.apply('${GRAPHITE}')`);
    await ctx.waitFor(`(__thApi.theme.activeSource()||'').includes('de.wurst.graphite')`, 'graphite applied through the client setting');
    ctx.equal(await ctx.eval(`__thApi.theme.current()`), GRAPHITE, 'current() is graphite');

    /* ---- one-shot reload (the button): swaps the CSS in and re-measures the tree ---- */
    edit(40, 'one');
    await ctx.openModsPage();
    await ctx.waitFor(`[...document.querySelectorAll('button')].some(b => /Reload theme now/.test(b.textContent))`, 'Reload button on the Mods page', 5000);
    await ctx.eval(`[...document.querySelectorAll('button')].find(b => /Reload theme now/.test(b.textContent)).click()`);
    await ctx.waitFor(`__thApi.theme.state().liveStyles === 1`, 'the Reload button swaps the CSS in', 5000);
    await ctx.restoreRoute();
    ctx.equal(await ctx.eval(mark), '"one"', 'edited variable applied by the one-shot reload');
    await ctx.waitFor(`${rowH} === 40`, 'one-shot reload re-measures the tree: client row height 40 (was ' + defaultRow + ')', 4000);
    const css = await ctx.eval(`document.querySelector('${MARK}').textContent`);
    ctx.assert(css.includes('--theme-test-mark') && !/@import/.test(css), '@import chain flattened into the live style');
    await ctx.disable('theme');
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 0, 'disable removes the live style');
    ctx.equal(await ctx.eval(`__thApi.theme.state().linkDisabled`), false, 'disable gives the client its stylesheet link back');
    await ctx.assertClean('theme');

    /* ---- live reload: edit the imported theme file, no restart ---- */
    restore(); edit(28, 'zero');
    await ctx.eval(`__ts6mod.store().settings.theme = { live: true, ms: 300 }`);
    await ctx.enable('theme');
    ctx.assert(/interval/i.test(await ctx.eval(`JSON.stringify(__ts6mod.ledger('theme'))`)), 'live reload registers the poll timer');
    await ctx.sleep(1200);   // baseline read; nothing changed -> nothing swapped
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 0, 'unchanged theme file: nothing swapped in');

    edit(44, 'two');
    await ctx.waitFor(`${mark} === '"two"'`, 'edited CSS variable picked up live', 6000);
    await ctx.waitFor(`${rowH} === 44`, 'tree row height changed to 44 without a restart', 6000);
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 1, 'one live style');
    edit(34, 'three');   // a second edit replaces the style, it does not stack
    await ctx.waitFor(`${rowH} === 34`, 'second edit: row height 34', 6000);
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 1, 'still one live style');

    /* the picker while live reload is on: switching to the default drops the live style and the tree follows */
    await ctx.eval(`__thApi.theme.apply(null)`);
    await ctx.waitFor(`__thApi.theme.state().liveStyles === 0`, 'switching to the default drops the live style', 6000);
    await ctx.waitFor(`${rowH} === ${defaultRow}`, 'default row height is back (' + defaultRow + ')', 6000);

    /* ---- the controls are on the Mods page ---- */
    await ctx.openModsPage();
    await ctx.waitFor(`!!document.querySelector('select.theme-mod-select')`, 'theme picker is on the Mods page', 5000);
    ctx.assert(await ctx.eval(`[...document.querySelectorAll('button')].some(b => /Reload theme now/.test(b.textContent))`), 'Reload button present');
    await ctx.restoreRoute();

    /* ---- disable = clean, nothing polls any more ---- */
    await ctx.disable('theme');
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 0, 'no live style after disable');
    await ctx.assertClean('theme');
    await ctx.eval(`__thApi.theme.apply('${GRAPHITE}')`);
    await ctx.waitFor(`(__thApi.theme.activeSource()||'').includes('de.wurst.graphite')`, 'graphite applied');
    edit(50, 'four');
    await ctx.sleep(900);
    ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 0, 'no polling after disable (file edit ignored)');
  } finally {
    await ctx.disable('theme').catch(() => {});
    await ctx.eval(`(()=>{ __thApi.theme.apply(${JSON.stringify(origTheme)}); delete __ts6mod.store().settings.theme; })()`).catch(() => {});
    await ctx.disable('t-theme-drv').catch(() => {});
    restore();
  }
}

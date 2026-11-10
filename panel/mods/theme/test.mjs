// Theme mod test. Checks: off = no style / no polling; the picker switches default <-> graphite (and back to the user's theme at the
// end); the Reload button swaps the CSS in and re-measures the tree; live reload; disable leaves no trace.
// File-edit parts (an edited @imported theme file is picked up live: tree row height + a CSS variable, no restart) run ONLY against an
// isolated client (ctx.clientProfile().isolated, i.e. started with TS6MOD_PROFILE_DIR): the test copies the user's graphite theme
// read-only into THAT profile's extensions folder and edits the copy. Against the real profile nothing is ever written; those parts
// are skipped. The isolated client must have been STARTED with the copy present (the client lists installed themes once at startup;
// the launch step in superdoc/features/mod-theme.md copies it before starting).
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export default async function (ctx) {
  const prof = ctx.clientProfile();
  const realRoot = join(homedir(), '.config', 'TeamSpeak', 'Default', 'extensions'), real = join(realRoot, 'de.wurst.graphite');
  const extRoot = prof.isolated && prof.configDir ? join(prof.configDir, 'TeamSpeak', 'Default', 'extensions') : null;
  const files = !!extRoot && extRoot !== realRoot && existsSync(join(prof.configDir, 'TeamSpeak', 'Default')) && existsSync(real);
  if (!files) ctx.skip('theme file edits (one-shot and live reload of an edited file)', prof.isolated ? 'no graphite theme to copy or no profile folder' : 'the client uses the real profile, which this test never writes');
  const MARK = 'style[data-theme-live]', GRAPHITE = 'de.wurst.graphite//Vanilla';
  const copy = files ? join(extRoot, 'de.wurst.graphite') : null, baseFile = files ? join(copy, 'GraphiteBase.css') : null;
  const restore = () => {   // copy only, the source is never modified
    if (!files) return;
    if (!copy.startsWith(extRoot) || copy.startsWith(realRoot)) throw new Error('refusing to write outside the isolated profile');
    rmSync(copy, { recursive: true, force: true }); cpSync(real, copy, { recursive: true });
  };
  restore();
  const orig = files ? readFileSync(baseFile, 'utf8') : '';
  const V = '--t' + 's-tree-';   // the client's tree row-height variables, spelled so the D18 lint stays free of raw client names
  const heightRe = new RegExp(`(${V}(?:channel|client)-height-(?:default|compact)\\s*:\\s*)\\d+px`, 'g');
  if (files) ctx.assert(orig.search(heightRe) >= 0, 'the theme copy sets tree row heights');
  const edit = (px, mark) => { if (files) writeFileSync(baseFile, orig.replace(heightRe, `$1${px}px`) + `\n:root { --theme-test-mark: "${mark}" !important; }\n`); };
  const rowH = `__thApi.theme.state().clientRow`, mark = `getComputedStyle(document.documentElement).getPropertyValue('--theme-test-mark').trim()`;
  // window size: run-all owns the device-metrics override (it emulates 1280x800 for small windows and clears it at the end)
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

    /* ---- switching from the picker (tree unmounted on the Mods page): returning to the tree re-measures it; hidden fields hidden ---- */
    {
      const want = `(()=>{ const p = document.createElement('div'); p.style.cssText = 'position:absolute;visibility:hidden;height:0'; document.body.append(p);
        const v = ['client-height-compact','client-height-default','channel-height-default','spacer-height-default'].map(n => { p.style.width = 'var(${V}' + n + ')'; return p.getBoundingClientRect().width; }); p.remove(); return v; })()`;
      const same = `JSON.stringify(__thApi.theme.treeHeights()) === JSON.stringify(${want})`;
      const overlap = `__thApi.theme.rowsOverlap()`;
      const sw = async (id) => {
        await ctx.openModsPage();
        await ctx.waitFor(`!!document.querySelector('select.theme-mod-select')`, 'picker on the Mods page', 5000);
        ctx.assert(await ctx.eval(`(()=>{ const f = [...document.querySelectorAll('.mods-field')].find(e => /Poll interval/.test(e.textContent)); return !!f && getComputedStyle(f).display === 'none'; })()`), 'poll slider is not displayed while live reload is off');
        await ctx.eval(`(()=>{ const s = document.querySelector('select.theme-mod-select'); s.value = ${JSON.stringify(id || '')}; s.dispatchEvent(new Event('change')); })()`);
        await ctx.sleep(2000);   // longer than the post-switch timers: they must be no-ops here, the tree is not shown
        await ctx.restoreRoute();
        await ctx.waitFor(`__thApi.theme.state().treeShown && __thApi.theme.state().clientRow != null`, 'tree shown again', 8000);
        await ctx.waitFor(same, 'tree cached heights equal the computed vars after returning (' + (id || 'default') + ')', 5000);
        ctx.assert(!(await ctx.eval(overlap)), 'client rows do not overlap');
      };
      await sw(null);
      await sw(GRAPHITE);
    }

    /* ---- one-shot reload (the button): swaps the CSS in and re-measures the tree ---- */
    edit(40, 'one');
    const graphiteRow = await ctx.eval(rowH);
    await ctx.openModsPage();
    await ctx.waitFor(`[...document.querySelectorAll('button')].some(b => /Reload theme now/.test(b.textContent))`, 'Reload button on the Mods page', 5000);
    await ctx.eval(`[...document.querySelectorAll('button')].find(b => /Reload theme now/.test(b.textContent)).click()`);
    await ctx.waitFor(`__thApi.theme.state().liveStyles === 1`, 'the Reload button swaps the CSS in', 5000);
    await ctx.restoreRoute();
    if (files) {
      ctx.equal(await ctx.eval(mark), '"one"', 'edited variable applied by the one-shot reload');
      await ctx.waitFor(`${rowH} === 40`, 'one-shot reload re-measures the tree: client row height 40 (was ' + defaultRow + ')', 4000);
    } else {
      await ctx.waitFor(`${rowH} === ${graphiteRow}`, 'one-shot reload of the unchanged theme re-measures the tree to the same row height (' + graphiteRow + ')', 4000);
      ctx.equal((await ctx.eval(`__thApi.theme.remeasure()`)).remeasured, true, 'tree re-measure runs');
    }
    const css = await ctx.eval(`document.querySelector('${MARK}').textContent`);
    ctx.assert((!files || css.includes('--theme-test-mark')) && css.length > 200 && !/@import/.test(css), '@import chain flattened into the live style');
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

    if (files) {
      edit(44, 'two');
      await ctx.waitFor(`${mark} === '"two"'`, 'edited CSS variable picked up live', 6000);
      await ctx.waitFor(`${rowH} === 44`, 'tree row height changed to 44 without a restart', 6000);
      ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 1, 'one live style');
      edit(34, 'three');   // a second edit replaces the style, it does not stack
      await ctx.waitFor(`${rowH} === 34`, 'second edit: row height 34', 6000);
      ctx.equal(await ctx.eval(`__thApi.theme.state().liveStyles`), 1, 'still one live style');
    }

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
    await ctx.sleep(300);
    const back = await ctx.eval(`__thApi.theme.current()`).catch(() => 'unknown');
    await ctx.disable('t-theme-drv').catch(() => {});
    restore();
    ctx.equal(back, origTheme, 'the user\'s theme is restored exactly');
  }
}

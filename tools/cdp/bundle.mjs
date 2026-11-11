// Builds the scripts the injector sends to the TS6 UI page: panel/core/* first, then every panel/mods/<name>/index.js
// (+ style.css), then panel/examples/<name>/* only when asked. Shared by mods-inject.mjs, mods-reload.mjs and tools/test/run-all.mjs.
// Core files are concatenated (each is its own IIFE over window.__ts6modBoot); every mod's index.js is wrapped in
// function (ts6mod) { ... } and handed to ts6mod.load(id, css, fn, source). See superdoc/features/ts6-mod-api.md.
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export const panelDir = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'panel');
const read = p => readFileSync(p, 'utf8');
const dirs = d => (existsSync(d) ? readdirSync(d).filter(n => statSync(join(d, n)).isDirectory()).sort() : []);

export function coreFiles(dir = panelDir) {
  const names = readdirSync(join(dir, 'core')).filter(n => n.endsWith('.js'));
  const first = ['anchors.js', 'core.js'], x = n => n.startsWith('x-');   // x-<mod>.js (core extension files) load after every built-in file
  const rest = names.filter(n => !first.includes(n)).sort();
  return [...first.filter(n => names.includes(n)), ...rest.filter(n => !x(n)), ...rest.filter(x)];
}

/* [{id, source: 'mod'|'example', dir, js, css}] */
export function listMods({ examples = false, only = null, dir = panelDir } = {}) {
  const out = [];
  for (const [kind, sub] of [['mod', 'mods'], ['example', 'examples']]) {
    if (kind === 'example' && !examples) continue;
    for (const id of dirs(join(dir, sub))) {
      const base = join(dir, sub, id), js = join(base, 'index.js');
      if (!existsSync(js)) continue;
      if (only && !only.includes(id)) continue;
      out.push({ id, source: kind, dir: base, js: read(js), css: existsSync(join(base, 'style.css')) ? read(join(base, 'style.css')) : '' });
    }
  }
  return out;
}

/* The project icon (repo-root icon.svg, the single master, copied byte for byte) as a data: URL for the Mods nav entry. */
const iconUrl = () => 'data:image/svg+xml;base64,' + readFileSync(join(panelDir, '..', 'icon.svg')).toString('base64');

const loadCalls = mods => mods.map(m => `core.load(${JSON.stringify(m.id)}, ${JSON.stringify(m.css)}, function (ts6mod) {\n${m.js}\n}, ${JSON.stringify(m.source)});`).join('\n');

/* The full script: core + mods. replace=true unloads an already injected core first (dev hot reload). */
export function buildBundle({ examples = false, replace = false, only = null, dir = panelDir } = {}) {
  const core = coreFiles(dir).map(n => `/* ---- core/${n} ---- */\n` + read(join(dir, 'core', n))).join('\n');
  const css = readdirSync(join(dir, 'core')).filter(n => n.endsWith('.css')).sort().map(n => read(join(dir, 'core', n))).join('\n');
  return `(function () {
  if (window.__ts6mod) { if (!${replace}) return; window.__ts6mod.unload(); }
  window.__ts6modBoot = { coreCss: ${JSON.stringify(css)}, iconUrl: ${JSON.stringify(iconUrl())} };
${core}
  const core = window.__ts6mod;
${loadCalls(listMods({ examples, only, dir }))}
  core.start();
})();`;
}

/* Hot-load (or replace) only some mods into an already running core. */
export function buildLoadScript({ examples = false, only = null, dir = panelDir } = {}) {
  return `(function () { const core = window.__ts6mod; if (!core) throw new Error('mod core is not injected');\n${loadCalls(listMods({ examples, only, dir }))}\n})();`;
}

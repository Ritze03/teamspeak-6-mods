#!/usr/bin/env node
// Dev hot reload into the RUNNING client (never Page.reload): re-reads panel/ from disk and replaces it in the live page.
//   node mods-reload.mjs [--cdp-port 9222] [--examples]            replace core + all mods (mods that were enabled stay enabled)
//   node mods-reload.mjs [--cdp-port 9222] [--examples] --mod audio --mod dashboard   hot-load just these mod dirs (core untouched)
//   node mods-reload.mjs --help | -h                                print usage, exit 0, no connection
// Flags: --cdp-port N (default 9222 = the usual running client), --examples, --mod NAME (repeatable). Any other flag: usage, exit 2.
// The injector's own registration (for the next UI start) is not changed; restart the injector for that.
import { connect } from './cdp.mjs';
import { buildBundle, buildLoadScript } from './bundle.mjs';

const a = process.argv.slice(2), val = n => a.flatMap((x, i) => (x === n ? [a[i + 1]] : []));
const usage = 'usage: mods-reload.mjs [--cdp-port N] [--examples] [--mod NAME]...   (default port 9222; --help prints this)';
if (a.includes('--help') || a.includes('-h')) { console.log(usage); process.exit(0); }
const known = ['--cdp-port', '--mod', '--examples'];
if (a.some(x => x.startsWith('-') && !known.includes(x))) { console.error(usage); process.exit(2); }
const port = +(val('--cdp-port')[0] ?? 9222), only = val('--mod'), examples = a.includes('--examples');
const c = await connect(port);
try {
  if (only.length) await c.eval(buildLoadScript({ examples, only }));
  else await c.eval(buildBundle({ examples, replace: true }));
  console.log(only.length ? 'hot-loaded ' + only.join(', ') : 'core and mods replaced');
} finally { c.close(); }
process.exit(0);

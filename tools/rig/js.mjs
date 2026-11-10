#!/usr/bin/env node
// js.mjs <port> '<expression>' | @file.js : evaluate in the UI page of the client with that CDP port, print the JSON result.
import { readFileSync } from 'node:fs';
import { connect } from '../cdp/cdp.mjs';
let [port, expr] = process.argv.slice(2);
if (expr.startsWith('@')) expr = readFileSync(expr.slice(1), 'utf8');
const c = await connect(+port);
try { console.log(JSON.stringify(await c.eval(expr))); } finally { c.close(); }
process.exit(0);

#!/usr/bin/env node
// audio-audit.mjs <cdp-port>... [--allow-prefix ts6rig_]: show every PulseAudio/PipeWire stream (source-output = mic capture,
// sink-input = playback) of the test client on each CDP port and its device. Exit 1 if a stream sits on a device whose name does not
// start with the allowed prefix (default ts6rig_ = the rig's null sinks); `--strict` additionally fails on any stream that is NOT
// muted at the stream level, even on a rig device (muted streams on rig devices stay ok; streams on other devices always fail). User rule: test clients never use the real mic or
// speakers. See superdoc/features/test-rig.md "Audio isolation".
import { execFileSync } from 'node:child_process';
const args = process.argv.slice(2), strict = args.includes('--strict');
const pi = args.indexOf('--allow-prefix'), prefix = pi >= 0 ? args[pi + 1] : 'ts6rig_';
const ports = args.filter((x, i) => /^\d+$/.test(x) && !(pi >= 0 && i === pi + 1));
const usage = 'usage: audio-audit.mjs <cdp-port>... [--allow-prefix P] [--strict]';
if (args.includes('--help') || args.includes('-h')) { console.log(usage); process.exit(0); }
if (!ports.length) { console.error(usage); process.exit(2); }
const pa = k => JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', k], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const pids = new Map();
for (const p of ports) {
  try { for (const pid of execFileSync('pgrep', ['-f', '--', `--remote-debugging-port=${p}( |$)`], { encoding: 'utf8' }).split('\n').filter(Boolean)) pids.set(pid, p); } catch (e) { /* none */ }
}
const src = new Map(pa('sources').map(s => [s.index, s.name])), snk = new Map(pa('sinks').map(s => [s.index, s.name]));
let bad = 0, n = 0;
for (const [kind, list, devs, field] of [['capture ', pa('source-outputs'), src, 'source'], ['playback', pa('sink-inputs'), snk, 'sink']]) {
  for (const s of list) {
    const pid = s.properties['application.process.id'], port = pids.get(pid);
    if (!port) continue;
    const dev = devs.get(s[field]) ?? `#${s[field]}`, ok = dev.startsWith(prefix) && !(strict && !s.mute);
    n++; if (!ok) bad++;
    console.log(`${ok ? 'ok  ' : 'BAD '} CDP ${port} pid ${pid} ${kind} stream ${s.index} -> ${dev}${s.mute ? ' (stream muted)' : ''}${s.corked ? ' (corked)' : ''}`);
  }
}
if (!n) console.log(`ok   no audio stream of CDP port(s) ${ports.join(', ')}`);
process.exit(bad ? 1 : 0);

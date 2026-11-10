// Keeps throw-away test clients off the user's real microphone and speakers (user rule, see superdoc/features/test-rig.md
// "Audio isolation"). startMuting({ports}) mutes the clients behind these CDP ports now and again every 500 ms (a test may reconnect
// the client, e.g. the aware second client, and a new connection starts unmuted) and returns stop().
// Two layers, because the app-level mute alone is not enough (measured: a client with inputMuted+outputMuted still held capture and
// playback streams on the default devices):
//   1. app level: SetClientSelfProperties({inputMuted, outputMuted}) on every connection handler (the client's own mute buttons);
//   2. stream level: `pactl set-source-output-mute` / `set-sink-input-mute` on every stream of that client process that is not on a
//      ts6rig_* device (the rig's null sinks are the intended, harmless route and must keep working: the rig listener's playback is
//      what tests record).
// A client whose streams are all on ts6rig_* devices is a rig client and is left alone. Only ever pass isolated test clients.
import { execFileSync } from 'node:child_process';
import { connect } from '../cdp/cdp.mjs';

const pa = k => JSON.parse(execFileSync('pactl', ['-f', 'json', 'list', k], { encoding: 'utf8', maxBuffer: 1 << 26 }));
const pidsOf = port => { try { return execFileSync('pgrep', ['-f', '--', `--remote-debugging-port=${port}( |$)`], { encoding: 'utf8' }).split('\n').filter(Boolean); } catch (e) { return []; } };
const APP_MUTE = `(async () => { const cs = document.querySelector('#app')?.__vue__?.appController?.connections || [];
  for (const c of cs) { const h = c.serverConnectionHandler; if (h && h.SetClientSelfProperties && h.connectionStatus !== 0) await h.SetClientSelfProperties({ inputMuted: true, outputMuted: true }).catch(() => {}); } return cs.length; })()`;

export function muteStreams(ports) {   // layer 2 only; returns [{port, kind, id, device}] of the streams it muted
  const done = [];
  let src, snk, outs, ins;
  try { src = new Map(pa('sources').map(s => [s.index, s.name])); snk = new Map(pa('sinks').map(s => [s.index, s.name])); outs = pa('source-outputs'); ins = pa('sink-inputs'); } catch (e) { return done; }   // no pactl: nothing to do
  const byPid = new Map(); for (const p of ports) for (const pid of pidsOf(p)) byPid.set(pid, p);
  const mine = [...outs.map(s => ['source-output', s, src.get(s.source)]), ...ins.map(s => ['sink-input', s, snk.get(s.sink)])].filter(([, s]) => byPid.has(s.properties['application.process.id']));
  if (mine.length && mine.every(([, , dev]) => String(dev).startsWith('ts6rig_'))) return done;   // rig client: already on null sinks
  for (const [kind, s, dev] of mine) {
    if (String(dev).startsWith('ts6rig_') || s.mute) continue;
    try { execFileSync('pactl', [`set-${kind}-mute`, String(s.index), '1']); done.push({ port: byPid.get(s.properties['application.process.id']), kind, id: s.index, device: dev }); } catch (e) { /* stream gone */ }
  }
  return done;
}

export async function startMuting({ ports, log = () => {} }) {
  const clients = new Map();   // port -> cdp (own connection; failures are retried next tick)
  let stopped = false;
  const tick = async () => {
    for (const p of ports) {
      try { if (!clients.has(p)) clients.set(p, await connect(+p)); await clients.get(p).eval(APP_MUTE); } catch (e) { clients.get(p)?.close?.(); clients.delete(p); }
    }
    for (const m of muteStreams(ports)) log(`muted ${m.kind} ${m.id} of CDP ${m.port} (was on ${m.device})`);
  };
  await tick();
  const timer = setInterval(() => { if (!stopped) tick().catch(() => {}); }, 500);
  return () => { stopped = true; clearInterval(timer); for (const c of clients.values()) try { c.close(); } catch (e) { /* ignore */ } };
}

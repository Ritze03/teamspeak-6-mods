# Net mod (connection quality)

A top-bar HUD with live **ping** and **packet loss** (and optionally data rate in/out) for the displayed server connection.
Click it for a popover with a 60 s history graph, min/avg/max, the current channel's codec and a **Copy diagnostics** button.
Optional alerts. Default **off**; off removes the HUD, popover, timers and all statistics requests (vanilla client).
Built on [ts6-mod-api.md](ts6-mod-api.md); files: `panel/mods/net/` (`index.js`, `style.css`, `test.mjs`) and the core extension
`panel/core/x-net.js` (the only place with client names).

## Behaviour

- **HUD** (`index.js:enable`): an element added with `api.topBar.add(element)`; shows `<ping> ms`, `<loss> %` and, if enabled,
  `↓in ↑out` per second (short units to fit the narrow toolbar). Hidden while not connected. Ping turns warning-coloured over
  the ping limit, loss error-coloured over the loss limit (the limits are the alert limits, also with alerts off).
  In a narrow toolbar the HUD shrinks and the data rate wraps onto a clipped second line instead of spilling under the next pane.
- **Popover**: body-level fixed node under the HUD (a clipping toolbar cannot cut it). Opens on click or Enter/Space, closes on
  Escape, outside click, disconnect or disable. Contains: sparkline (ping line, loss bars, dashed ping-limit line, last 60 s),
  ping now + jitter, ping min/avg/max, loss now (up/down) and avg/max, bandwidth, codec, channel, buttons.
- **Codec readout**: codec name and quality (0-10) of the channel you are in, from the channel's properties. Re-read when the
  popover opens and on every poll while it is open. Bitrate is **not** shown: the client exposes only the quality number and the
  quality-to-bitrate table is not available from the UI (not derived rather than guessed).
- **Copy diagnostics**: plain text with client version/build, UI engine, OS, server version/platform, codec, sample count and
  window, ping min/avg/max/now, jitter, loss avg/max/now, bandwidth. Written with `navigator.clipboard.writeText`, falling back
  to a hidden textarea + `execCommand('copy')`. The text is never logged; the button shows `Copied` / `Copy failed` and sets
  `data-copied="ok|fail"` for a moment.
- **Alerts** (`index.js:checkAlerts`): off by default. A toast (`api.toast`) fires when a metric exceeds its limit in 2 consecutive
  samples. Re-arming needs a value below 80 % of the limit (hysteresis) and at most one toast per metric per 60 s (cooldown).
- **Polling**: one `api.interval` that requests statistics only while a connection is established; no request is made while
  disconnected, history is cleared on disconnect. Requests do not overlap (`busy` guard).

## Settings (Settings -> Mods -> Net card -> its page, boxes Display and Alert limits; persisted via `api.storage`)

| Key | Default | Meaning |
|---|---|---|
| `interval` | 2 | seconds between statistics requests (1-5); changing it restarts the timer |
| `bandwidth` | true | show data rate in the HUD |
| `alert` | false | enable threshold toasts |
| `pingMax` | 150 | ping limit in ms (30-1000) |
| `lossMax` | 5 | loss limit in % (1-50) |

## Mechanism

- Data: bridge call `requestConnectionInfo(schid, ownClientId, cb(status, stats))` (wrapped as `api.net.poll()`), which returns
  everything in one object: `ping`, `pingDeviation`, `packetlossTotal`, `client2serverPacketlossTotal`,
  `server2clientPacketlossTotal`, `bandwidth{Received,Sent}LastSecondTotal`, byte/packet counters. Why this call: the connection
  handler object has no cached ping/loss fields; they only exist after a request, so the mod must poll (kept to one request per
  interval, only while on).
- **Loss unit**: the client reports a 0..1 fraction; the mod shows `fraction * 100` and uses the worst of total/up/down. This was
  checked only at 0 % (loopback has no loss); the unit is an assumption from the TeamSpeak query convention.
- Server version/platform come from the connection's server properties, codec from the own channel's properties (`api.net.meta()`).

### `x-net.js` additions

- Anchors: `net.requestConnectionInfo` (bridge method exists), `net.ownClientId` (optional; connection handler has `ownClientId`
  and `connectionStatus`).
- `api.net`: `connected()`, `poll()` (normalised sample `{t, ping, jitter, loss, lossUp, lossDown, bwIn, bwOut}` or null), `meta()`
  (`{serverVersion, serverPlatform, channelName, codecId, codec, quality}` or null), `theme()` (popover surface colours as CSS
  values built from TS custom properties, so default and custom themes match).
- Test hook `window.__ts6modNetRequests`: count of statistics requests since page load.

## Test procedure

Needs a modded client (see [ts6-mod-api.md](ts6-mod-api.md) "Tests"); for the live part it must be connected to a server.

```
node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only net
```

`panel/mods/net/test.mjs` asserts: off by default and no requests while off; enable shows the HUD; ping (`N ms`) and loss (`N %`)
appear and the update counter (`data-updates`) increases; bandwidth shown by default; popover opens, sparkline and codec are
drawn and the popover is on screen; Copy diagnostics reports an outcome (and, if the clipboard can be read, the block contains
the expected lines); Escape closes the popover; with alerts on and an impossible limit exactly one toast fires and none repeats
within the cooldown; the bandwidth switch on the mod's page hides/shows the bandwidth part live (clicked twice to restore the
saved value); disable removes HUD and popover, `assertClean`, and the request counter stops. Without a connection the live
part is skipped (and the test asserts no requests). Manual check: also look at the HUD in the real top bar in the default and a
custom theme.

## Known limits

- Only the displayed connection is measured (not every tab).
- Loss percent cannot be provoked on loopback; the alert path is tested with a ping limit instead.
- Not visually verified in the top bar on the test client: the account-confirmation wall of a fresh test profile covers the main UI
  (the toolbar element exists with a sane size and position; the popover was checked in a screenshot).
- At narrow window widths the HUD uses the space of the toolbar; turn off bandwidth to shrink it.

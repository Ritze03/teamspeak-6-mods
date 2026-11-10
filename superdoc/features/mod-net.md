# Net mod (connection quality)

A HUD with live **ping** and **packet loss** (and optionally data rate in/out) for the displayed server connection, in the bottom bar of the channel tree pane next to the client's own connection-status
icons (default) or in the top bar.
Click it for a popover with a 60 s history graph, min/avg/max, the current channel's codec and a **Copy diagnostics** button.
Optional alerts. Default **off**; off removes the HUD, popover, timers and all statistics requests (vanilla client).
Built on [ts6-mod-api.md](ts6-mod-api.md); files: `panel/mods/net/` (`index.js`, `style.css`, `test.mjs`) and the core extension
`panel/core/x-net.js` (the only place with client names).

## Behaviour

- **HUD** (`index.js:enable`, `place()`): one element, placed by the `position` setting (switched live):
  - **Bottom bar** (default): `api.net.bottomBar.mount(el)` makes it the first item of the stock connection-status group (the
    rounded dark pill with the connection bars and the server-events button), so it reads as part of the stock stats. Text in the
    bar's own colour at 13 px (the stock button-label size); the own signal glyph is not shown there (the stock bars sit right next
    to it). It stays visible with the Create Channel button expanded, collapsed, compact or hidden (layout mod), and a narrow pane
    clips it from the end (data rate first, then loss) instead of pushing the stock items out of the bar: at the minimum pane width
    (220 px) the reserved widths may drop the loss (see Constant width).
    Why the bottom bar by default: the user asked for ping/loss to sit next to the stock network stats there and always show.
    Why inside the stock group and not a sibling: the bar's own auto-collapse (see [mod-layout.md](mod-layout.md) Create Channel)
    measures that group, so the label of Create Channel folds away early enough to leave the HUD its room.
  - **Top bar**: `api.topBar.add(element)` next to the mic/speaker buttons (the old placement).
  Shows `<ping> ms`, `<loss> %` and, if enabled, `↓in ↑out` per second (short units). Hidden while not connected. Ping turns warning-coloured over
  the ping limit, loss error-coloured over the loss limit (the limits are the alert limits, also with alerts off).
- **Constant width** (`style.css`: `.net-ping`, `.net-loss`, `.net-bwv`): every field is an inline-block with a reserved `min-width`
  and right-aligned tabular digits: ping `6ch` ("999 ms"), loss `6ch` ("99.9 %"; `fmtPct` always prints one decimal; "100.0 %" just grows the field), bandwidth
  two boxes of `5.5ch` each (`↓12.3k`; a longer value like `↓1023k` grows its box). Gaps are 6 px. `fmtBwShort` uses a fixed unit set (B, k, M), one decimal below 100 for k/M, whole numbers
  otherwise (max 5 characters). The HUD's width therefore only changes when the bandwidth option is toggled, in both positions, and the
  stock icons beside it never move. Narrow-pane clipping (`maxWidth` from `api.net.bottomBar`) still drops whole fields by wrapping,
  it does not reflow them; the fixed boxes are wider than a short value, so at the minimum pane width bandwidth drops out first.
  Why: a changing digit count or unit made the readout and the stock items next to it shift on every sample; reserving the worst case
  trades a few pixels of empty space for a stable bar. The reserved widths are the typical worst case (6ch), not the absolute one (7ch):
  7ch boxes made the gaps look huge, and the three fields (about 52 + 52 + 109 px) no longer fitted the ~228 px the bottom bar leaves, so
  the bandwidth part wrapped onto the clipped second line and was never visible although the option was on (it existed, `hidden=false`,
  but sat below the 21 px clip). With 6ch/5.5ch the whole HUD is about 200 px and fits.
  In a narrow toolbar the HUD shrinks and the data rate wraps onto a clipped second line instead of spilling under the next pane.
  In the bottom bar it must have `position: relative` like the stock items: the group's background is an absolutely positioned
  `::before` that otherwise paints over static children.
- **Popover**: body-level fixed node under the HUD, or above it when there is no room below (bottom bar) (a clipping toolbar cannot cut it). Opens on click or Enter/Space, closes on
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
| `position` | `bottom` | `bottom` (bottom bar of the channel tree) or `top` (top bar); pills "Bottom bar / Top bar" in Display |

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
  and `connectionStatus`), `net.statusBar` (optional; `.ts-server-status-bar > .ts-server-informative-buttons`, the stock
  connection-status group of the bottom bar).
- `api.net.bottomBar`: `available()`, `mount(el)` -> `remove()`. Prepends `el` to the shown bottom bar's status group and re-places
  it on DOM changes (the bar is rebuilt per server/view); a ResizeObserver on the bar and its children sets `el.style.maxWidth` =
  bar content width - 44 px reserve for the collapsed Create Channel button (0 when that group is not displayed) - the stock items.
  Why not a shrinkable group: the bar's collapse compares its width with the group's, a shrinking group would never trigger it.
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
saved value); placement: the HUD is the first item of the bottom bar's connection-status group, does not overlap the stock
status item or the Create Channel button and stays inside the bar, ping visible, both at the current and at the minimum pane width
(via `__ts6modLayoutDev.paneWidth`, restored; skipped without the layout core file); the Position pills move it to the top bar and
back (the original settings object is restored); disable removes HUD and popover, `assertClean`, and the request counter stops. Without a connection the live
part is skipped (and the test asserts no requests). Manual check: look at the bottom bar in the default and a custom theme, wide and at the minimum pane
width, with each Create Channel style.

## Known limits

- Only the displayed connection is measured (not every tab).
- Loss percent cannot be provoked on loopback; the alert path is tested with a ping limit instead.
- On a fresh test profile the account-confirmation wall (`.ts-first-launch` overlay) covers the main UI; for screenshots hide it with
  an injected style in the test client (the UI below is live). Bottom-bar look verified in the default and graphite themes.
- Top bar: at narrow window widths the HUD uses the space of the toolbar; turn off bandwidth to shrink it.
- Bottom bar at a narrow pane: when the readout is clipped, the HUD box keeps its maximum width, so a small empty gap can remain
  before the stock icons.

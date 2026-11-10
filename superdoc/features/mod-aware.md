# Mod: aware (server awareness)

Opt-in mod (default off) that shows what happens on the server: activity badges on channel rows, idle time of users, and a
join / leave / move feed. Code: `panel/mods/aware/` (`index.js`, `style.css`, `test.mjs`) and its core extension file
`panel/core/x-aware.js` (all TS-specific names). Framework: [ts6-mod-api.md](ts6-mod-api.md). Probed internals:
[ts6-modding-surface.md](ts6-modding-surface.md).

## Features and settings

Each sub-feature has its own switch and its own `api.scope()`; switching one off disposes exactly its DOM, listeners, timers
and requests. Settings are stored per mod (`api.storage`) and edited on the Mods page.

| Setting | Default | Meaning |
|---|---|---|
| `badges` | on | Channel activity badges |
| `fade` | 30 s | How long the "recent activity" dot stays after the last talk (opacity fades linearly) |
| `idle` | **off** | Idle probe (it sends requests) |
| `idleInterval` | 5 s | Time between two requests (one request in total per tick) |
| `idleMin` | 60 s | Idle label only for users idle at least this long |
| `feed` | on | Join/leave feed (top bar button + dropdown list) |
| `toasts` | off | Also show each feed entry as a notification |
| `feedMax` | 50 | Entries kept (memory only, dropped with the mod or `Clear`) |

Why the sub-feature defaults: the mod itself is off by default; once the user switched it on, badges and feed are free (events
only), but the idle probe talks to the server, so it needs its own explicit opt-in.

### Channel activity badges
`api.treeRow.decorate({for:'channel'})`: `♪ N` pill while N users of that channel talk, then a green dot whose opacity fades
over `fade` seconds. Talking state is kept from `talkStatusChanged` events (seeded from the clients' talking flag when the
feature starts); a 1 s interval re-renders only while some channel is still fading. Limit: talk-status events are
channel-agnostic but only arrive for channels the client is subscribed to, so unsubscribed channels never light up.
Whispers are ignored.

### Idle probe
Idle time only exists as the answer of the bridge request `requestConnectionInfo(schid, clientId, cb)`: `cb(status, info)` with
`info.idleTime` in ms. (The `idleTime` property of the client model stays 0 and no `clientConnectionInfo` event fires for it.)
Every `idleInterval` seconds one request goes out, round-robin over the clients of **expanded** channels (the channel and all
its ancestors are not collapsed, `treeCollapsed`), never ourselves. The answer is stored with a timestamp, so the label
(`idle 12m`, client rows via `treeRow.decorate({for:'client'})`) keeps growing between answers. Why throttled to one request
per tick overall and not per user: a server with hundreds of visible users must not be flooded.
Off (switch or mod): no timer exists, so zero requests; the test proves it with a counter (below).

### Join / leave feed
A top bar button (`api.topBar.add`, icon `contacts`, highlighted while there are unseen entries, title shows the count) opens a
list (time, nickname, from -> to). Entry kinds: `join`, `move`, `disconnect`, `timeout` (connection lost), `kick`, `ban`.
Derived from `clientMoved` (see x-file). Limits:
- Moves into a channel we are not subscribed to produce only a "left view" event; it is shown as a move (`from -> new channel`),
  and a later reappearance from an unseen channel is also a move (the last known channel per client is remembered).
- Channels created after we connected are not subscribed automatically, so the first move into them is seen only as a
  disappearance. Moves between subscribed channels are exact.
- No entries exist for the initial user list at connect (no events are sent for it).

## Mechanism (core extension `api.aware`, `panel/core/x-aware.js`)
Anchors added: `aware.requestInfo` (bridge function exists), `aware.channelCollapsed` (optional; channel model has `treeCollapsed`).
`api.aware`: `schid`, `channelOfClient`, `talkers`, `onTalk`, `onActivity`, `expandedClients`, `requestInfo` (the only place that
issues the request; counted in `boot.aware.stats.requests`), `idleMs`, `stats`, `toolbar.rect/contains`, `skin` (popup
background from the theme's context-menu variables, so default and custom themes match), `cleanup`, `forget`.
`clientMoved` payloads: new connection `oldChannelId "0"` + `properties`; leave `newChannelId "0"` with `type` 3 timeout /
5 kick / 6 ban and a `message`; moves carry both ids.

## Test procedure
Automatic: `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only aware`. Needs the shared test server and,
for the feed part, a second plain client on CDP `$AWARE_P2_CDP` (default 9263) that is running (connected or not; the test
connects/disconnects it); without it the feed part is skipped with a log line. Missing channels `aware-a`/`aware-b` are
created with serverquery (`$AWARE_QUERY_CREDS`, default `$HOME/tmp/ts6-modsrv/creds.env`). Steps: mod off leaves no DOM; mod on
with the idle probe off issues 0 requests over 3.5 s; synthetic talk event (test hook `__ts6modBoot.aware.talk`) shows a badge,
which survives row re-rendering and becomes a fading dot; idle probe on: 2-5 requests in 3.6 s at a 1 s interval, labels
appear, none with all channels collapsed (test hook `setCollapsed`), none after switching it off; second client joins, moves
twice, disconnects: feed has the matching entries and the panel lists them; mod off: `assertClean`, 0 requests even with the
probe configured on. Manual: talk with a second client (real mic) and watch the channel row; expand/collapse channels.
Test support in the x-file: `p2Driver` is JS source evaluated in the second client (TS calls stay out of `panel/mods/`).
Gating: the badge part uses another client in a channel whose row is on screen (else SKIP); the feed part (second client,
serverquery, channel creation) runs only on the local test server, and the second client gets its original nick back at the end.

## Known limits
Visual check needs the client window; fresh-profile clients show a full-screen account overlay (hide it in test clients).
Badges sit at the end of the channel row. The feed list shows entries of the displayed connection only.
Server-query sessions (for example an admin running commands) also appear in the feed as joins and leaves: the event does not say
what kind of client it is.

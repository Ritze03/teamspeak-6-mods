# Mod: aware (server awareness)

Opt-in mod (default off) that shows what happens on the server: who talks in other channels (on their own talk circle), idle
time of users, and a join / leave / move feed. Code: `panel/mods/aware/` (`index.js`, `style.css`, `test.mjs`) and its core extension file
`panel/core/x-aware.js` (all TS-specific names). Framework: [ts6-mod-api.md](ts6-mod-api.md). Probed internals:
[ts6-modding-surface.md](ts6-modding-surface.md).

## Features and settings

Each sub-feature has its own switch and its own `api.scope()`; switching one off disposes exactly its DOM, listeners, timers
and requests. Settings are stored per mod (`api.storage`) and edited on the Aware card's page (Settings -> Mods -> Aware; boxes Talking in other channels, Idle times, Join / leave feed).

| Setting | Default | Meaning |
|---|---|---|
| `talk` | on | "Show talking in other channels (from idle time)": talk circles of other channels' users (sends requests) |
| `idle` | **off** | Idle probe: `idle 12m` labels (sends requests) |
| `idleInterval` | 1 s | "Check every", shared by `talk` and `idle`: tick length of the request timer (at most 5 requests per second in total, see below) |
| `idleWord` | on | "Show the word idle": label `idle 12m` (on) or just `12m` (off); tooltip explains it either way |
| `idleMin` | 60 s | Idle label only for users idle at least this long |
| `feed` | on | Join/leave feed (top bar button + dropdown list) |
| `toasts` | off | Also show each feed entry as a notification |
| `feedMax` | 50 | Entries kept (memory only, dropped with the mod or `Clear`) |

Why the sub-feature defaults: the mod itself is off by default; once the user switched it on, the feed is free (events only).
`talk` replaced the old channel badge and keeps its default (on, user decision); it polls, but within the same one-request-per-tick
budget. The idle probe needs its own explicit opt-in.

### Talking in other channels (talk circles)
For a client in another channel, the client row's own talk circle (the stock talking arcs around the avatar) is switched on while
that client was recently active by its polled idle time (below), the same look the stock client shows for people in your own channel. Nothing is added to
channel rows.
**Why (user decision):** the earlier channel-row badge (a pill / green dot at the end of the channel row) sat on top of channel
banner images and over the row's expand chevron. The user wanted no badge on channels; instead "fake that I'm in there": colour
the talk circle of users in other channels. The stock client cannot do this itself: a TS3 server only sends voice, and with it talk
status, for your own channel (observed: a client talking in another channel keeps `flagTalking` false, subscribed or not), so the
polled idle time (0 s right after any activity) is the only available proxy.
- Which rows: client rows rendered right now (the tree is a virtual list, so on-screen rows of expanded channels), not myself, not
  in my channel, and not flagged talking by the client itself. A row the client already shows as talking (own channel, a whisper
  to me) is never touched.
- Which clients: only those that can be talking, by client model properties (`panel/core/x-aware.js:canTalk`): `inputMuted` false,
  `inputHardware` not false (false = no microphone), `inputDeactivated` false and `away` false. Others are neither marked nor asked
  (no request is spent on them), and a property change (`clientPropertiesUpdated`, `clientSelfPropertyUpdated`) re-syncs the marks
  at once, so a mark vanishes the moment someone mutes. **Why:** typing, or any other action, resets idle time, so a muted or away user
  who types would otherwise get a talk circle; they cannot be talking. Speaker-muted (`outputMuted`) clients stay candidates: they can
  still talk with the microphone on (`outputOnlyMuted` is the separate flag for that case). `isTalker` is not used: it is a talk power
  grant that is false for almost every client (live: only a few of a server's clients had it), so it would hide nearly everybody.
- When: `talkingNow` (`panel/mods/aware/index.js`). **User spec: check every second whether idle time is below 1000 ms; if so, light
  the circle.** Lit while the last answer said idle `< 1000 ms`, and it stays lit until the next answer says `>= 1000 ms`
  (continuous while someone talks). Only a mark whose answers stopped coming (lost callback, row left the screen) is cleared by age
  (`2 * interval + 1 s`). Marks are re-checked every 300 ms locally. The old `talkHold` window / extrapolation / slack logic and
  its setting are gone. Why: the old logic needed an answer to land inside a 1.5 s window with one request per tick, so talking
  lit the circle only sometimes; with every eligible client asked every second the plain threshold is both simpler and continuous.
- Which clients are asked: every tick (`idleInterval`, default 1 s) all candidates are ranked and the top `floor(5 * interval)` are
  asked (`poll`, `MAX_RATE = 5` requests per second). Rank: never asked, then lit clients, then by (time since asked) / (period),
  period in ticks by last answer idle: < 30 s `2`, < 5 min `4`, else `12`. With up to 5 candidates every one is asked every
  second; with more, recently active clients keep the budget and the others take turns (a starved client's ratio keeps growing).
  **Why the cap:** the client has no batch form (`requestConnectionInfo` is one command per client; no server event carries idle
  time), so N clients cost N commands per second. A TS server's default anti-flood refills 5 points per second and one command costs
  1, so 5 per second is sustainable indefinitely and N * 1 per second on a big server is not.
- Request guard: `api.aware.requestInfo` gives up after 5 s (a bridge call can occasionally never call back; same guard as the net
  mod's poll) and allows one request per client at a time, so a lost callback neither freezes the poller nor piles up requests.
- Timing: detection delay `<=` the interval plus request latency (measured about 10 ms on loopback), clearing the same, for up to 5
  candidates; beyond that active clients first, the rest within `N / 5` seconds.
- Units and freshness (measured live): `idleTime` is in milliseconds, grows 1:1 between answers (8107, 8312, 8521 ... at 200 ms
  spacing), and an answer is fresh (the server value at request time). Not verified: that voice resets it. The rig talker could
  not be made to transmit in this session (own and observed `flagTalking` stayed false, capture device `null`), so only typing /
  channel messages are proven to reset it; TS3 servers are expected to count voice.
- Mark: the stock class `talking` on the row's icon stack (the stock CSS then shows the talking arcs in the theme's colour, so
  default and extension themes look exactly like a real talker) plus our own marker class `aware-talk`, so only our additions
  are removed again (`panel/core/x-aware.js:markTalking`). Vue rewrites the class attribute only when its own class string
  changes, and recycled rows keep stale classes, so the marks are re-synced on tree DOM changes, on talk / move / property
  events, after every answer and once a second (local only).
- Limits: a mark lasts until the next check shows idle >= 1 s; it also lights for
  typing a message or any other action that resets idle time, not only for voice. With more than 5 candidates the least active are checked less often. Off-screen rows are never asked for this feature.

### Idle probe
Idle time only exists as the answer of the bridge request `requestConnectionInfo(schid, clientId, cb)`: `cb(status, info)` with
`info.idleTime` in ms. (The `idleTime` property of the client model stays 0 and no `clientConnectionInfo` event fires for it.)
Candidates are the clients of **expanded** channels (the channel and all its ancestors are not collapsed, `treeCollapsed`), never
ourselves; requests go through the shared timer below. The answer is stored with a timestamp, so the label
(`idle 12m`, client rows via `treeRow.decorate({for:'client'})`) keeps growing between answers. 

### The request timer (shared)
One timer (`panel/mods/aware/index.js:poll`) exists while `talk` or `idle` is on; every `idleInterval` seconds it sends up to `floor(5 * interval)` `requestConnectionInfo`s, chosen by the priority above. Candidates: on-screen other-channel rows (`talk`) plus clients of expanded channels (`idle`). Why a cap and not one request per user: a server with hundreds of visible users must not be flooded (flood protection), see above. Off (both switches, or the mod): no timer exists, so zero requests; the test proves it with a counter (below).

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
Anchor `aware.talkCircle` (optional; client row icon stack that takes the stock `talking` class).
`api.aware`: `schid`, `onActivity`, `expandedClients`, `otherRows` (on-screen rows of other channels without stock talk status that `canTalk`),
`requestInfo` (the only place that issues the request; counted in `boot.aware.stats.requests`), `idleMs`, `answer`, `askedAt`,
`markTalking(fn)` (talk-circle marks, disposed with the scope), `stats`, `toolbar.rect/contains`, `skin` (popup
background from the theme's context-menu variables, so default and custom themes match), `cleanup`, `forget`.
`clientMoved` payloads: new connection `oldChannelId "0"` + `properties`; leave `newChannelId "0"` with `type` 3 timeout /
5 kick / 6 ban and a `message`; moves carry both ids.

## Test procedure
Automatic: `node tools/test/run-all.mjs --cdp-port <cdp> --control-port <ctl> --only aware`. Needs the shared test server and,
for the second-client part, a second plain client on CDP `$AWARE_P2_CDP` (default 9263) that is running (connected or not; the
test connects/disconnects it, connects it muted and switches its microphone and speakers off: test clients never use real audio);
without it that part is skipped with a log line. Missing channels `aware-a`/`aware-b` are created with serverquery
(`$AWARE_QUERY_CREDS`, default `$HOME/tmp/ts6-modsrv/creds.env`). Steps: mod off leaves no DOM; mod on with talk circles and idle
probe off issues 0 requests over 3.5 s; talk circles on (any server, passive): at most 22 requests in 3.6 s (cap 5/s),
marks only on other channels' rows without stock talk status, no badge on channel rows, none left and requests stop when switched
off; idle probe on: 2-22 requests in 3.6 s, labels appear, none with all channels collapsed (test hook `setCollapsed`), none after
switching it off; second client joins, moves twice (into `aware-b`): feed has the matching entries; talk circle: the second client
sits idle in `aware-b` (circle normal), then sends one channel message per second (at most 12, below the flood limit) until a poll
catches idle 0 s and its circle shows talking (stock class + our mark, test hook `circle(id)`), then goes back to normal once quiet,
and no marks remain when switched off; disconnect is in the feed and the panel lists the entries; mod off: `assertClean`, no marks,
0 requests even with both polling features configured on.
Test support in the x-file: `p2Driver` is JS source evaluated in the second client (TS calls stay out of `panel/mods/`); test
hooks `circle(id)` and `marks()`.
Gating: the second-client part (feed, talk circle with real activity, serverquery, channel creation) runs only on the local test
server, and the second client gets its original nick back at the end. Elsewhere only the passive talk-circle checks run.
Manual: have someone in another channel talk (or type) and watch their talk circle (it lights within about one interval);
check that people in your own channel behave exactly as stock; expand/collapse and scroll the tree.
Visual check note: an occluded test client window gets about one frame per second, so a screenshot can show the state before
the last class change (CSS transitions start only on a frame); take two captures and use a larger interval so a mark lasts.

## Known limits
Visual check needs the client window; fresh-profile clients show a full-screen account overlay (hide it in test clients).
The feed list shows entries of the displayed connection only.
Server-query sessions (for example an admin running commands) also appear in the feed as joins and leaves: the event does not say
what kind of client it is.

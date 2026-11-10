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
| `idleInterval` | 5 s | "Seconds between requests", shared by `talk` and `idle`: one request in total per tick |
| `talkHold` | 1.5 s | "Stay lit for": how long a talk circle stays on after the last activity seen (0.5 to 5 s) |
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
- When: `talkingNow` (`panel/mods/aware/index.js`) with `H` = `talkHold` (1.5 s) and `I` = `idleInterval`, for the last answer
  (idle `a.ms`, age `age`): lit while `a.ms + age < H` (the idle time extrapolated to now is below the hold: the circle goes out `H`
  after the last activity seen), or while `a.ms < 300 ms and age < I + 0.5 s` (slack: the answer caught activity right now, so the
  person may still be talking and the circle is kept until the next answer is due). Every answer is evaluated at once: an answer with
  idle above `H` clears the mark immediately. Marks are re-checked every 300 ms locally.
- Which client is asked (one request per tick): every candidate has a period in ticks by its last answer, extrapolated: lit `1`,
  idle < 30 s `2`, idle < 5 min `4`, longer or no answer `12`. Never-asked clients go first, then lit clients that are due (so a
  lit mark is confirmed or cleared on the very next tick), then the highest (time since asked) / (period) ratio. The budget is never
  left unused: with nothing due the highest ratio still goes. **Why:** people talk in bursts, so clients active in the last half
  minute are the likely next talkers and are re-asked often, while someone idle for minutes is asked rarely; no starvation, because
  a starved client's ratio keeps growing.
- Timing (I = interval, default 5 s). Detection delay, from the start of talking to the mark: `<=` the client's re-ask time plus the
  request latency. A recently active client with R such clients on screen: about `max(2, R) * I` (10 s for R <= 2, 15 s for R = 3);
  a long-idle client that nobody else crowds out: round robin over all N candidates, `N * I` (N = 10: 50 s), longer only while
  recently active clients take the budget. A lit client: re-asked every tick, so the mark is cleared at the first answer after the
  stop: `<= I` plus latency (5 s), and when the stop came before the answer, the mark ends `H` after the last activity (1.5 s). Why
  the slack: with one request per tick the stop of talking is unknowable between answers, so a mark that must not blink during
  continuous talking has to survive until the next answer; the slack applies only while the last answer showed activity right
  then (idle below 300 ms), everything else follows the exact extrapolation. Previously the mark stayed `1 s + I` after the last
  activity and a lit client was re-asked only every other tick (clear within 1 to 2 I).
- Why this threshold (live finding, still valid for the window logic): idle time on the real server is exact in ms, grows 1:1 and
  drops to a few hundred ms after activity, so the signal itself works. Answers observed 632 ms, 399 ms and 1405 ms after short
  bursts, so a request that lands later than about a second after a burst still shows the (extrapolated) activity time, which is why
  `H` can be small now but the asked-often priority for recent talkers matters. Idle time is the only proxy. Not verified live: that
  voice (not only typing) resets idle time on every server; TS3 servers are expected to count voice as activity.
- Mark: the stock class `talking` on the row's icon stack (the stock CSS then shows the talking arcs in the theme's colour, so
  default and extension themes look exactly like a real talker) plus our own marker class `aware-talk`, so only our additions
  are removed again (`panel/core/x-aware.js:markTalking`). Vue rewrites the class attribute only when its own class string
  changes, and recycled rows keep stale classes, so the marks are re-synced on tree DOM changes, on talk / move / property
  events, after every answer and once a second (local only).
- Limits: a mark shows late (see Timing) or not at all when the client is asked only after its idle passed `talkHold`, and lasts `talkHold` after the activity (or until the next answer, see slack); it also lights for
  typing a message or any other action that resets idle time, not only for voice. With the default 5 s interval and many users on screen it is coarse; a smaller interval (down
  to 1 s) gives faster circles at a higher request rate. Off-screen rows are never asked for this feature.

### Idle probe
Idle time only exists as the answer of the bridge request `requestConnectionInfo(schid, clientId, cb)`: `cb(status, info)` with
`info.idleTime` in ms. (The `idleTime` property of the client model stays 0 and no `clientConnectionInfo` event fires for it.)
Candidates are the clients of **expanded** channels (the channel and all its ancestors are not collapsed, `treeCollapsed`), never
ourselves; requests go through the shared timer below. The answer is stored with a timestamp, so the label
(`idle 12m`, client rows via `treeRow.decorate({for:'client'})`) keeps growing between answers. 

### The request timer (shared)
One timer (`panel/mods/aware/index.js:poll`) exists while `talk` or `idle` is on; every `idleInterval` seconds it sends exactly
one `requestConnectionInfo`, chosen by the priority above (never asked, lit and due, then time since asked / period). Candidates: on-screen other-channel rows (`talk`) plus clients of expanded channels (`idle`). Why one request per
tick overall and not per user: a server with hundreds of visible users must not be flooded (flood protection). Rate before /
after the talk-circle change: before, 0 requests with the defaults (badges were event-only) and 1 per `idleInterval` with the
idle probe on; now 1 per `idleInterval` while `talk` (default on) or `idle` is on and a candidate exists, never more (same peak
rate). Off (both switches, or the mod): no timer exists, so zero requests; the test proves it with a counter (below).

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
probe off issues 0 requests over 3.5 s; talk circles on (any server, passive): at most 5 requests in 3.6 s at a 1 s interval,
marks only on other channels' rows without stock talk status, no badge on channel rows, none left and requests stop when switched
off; idle probe on: 2-5 requests in 3.6 s, labels appear, none with all channels collapsed (test hook `setCollapsed`), none after
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

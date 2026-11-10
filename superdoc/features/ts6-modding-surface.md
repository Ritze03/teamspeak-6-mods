# TeamSpeak 6 modding surface (CDP route)

What can be done to a **stock, unmodified** TeamSpeak 6 client by launching it with Chromium's
remote debugging port and driving the UI page over the Chrome DevTools Protocol (CDP). Everything
here was probed live against `6.0.0beta5` (CEF host, Chrome/151, Linux) on a real connected profile.
UI-extension mechanics (settings page, menus, toolbar, modals, ...) live in the sibling page
[ts6-ui-extension-points.md](ts6-ui-extension-points.md).

**Why CDP and not patching files:** the stock binary verifies the UI bundle (sha512), so edited
files under the install dir are rejected, and binary patching is unnecessary. The only change to
the launch is one flag, `--remote-debugging-port=<port>`. Nothing under the install dir or the
profile is touched.

## Launch and attach

```
/opt/teamspeak/TeamSpeak --remote-debugging-port=9222        # normal environment, nothing else
curl -s 127.0.0.1:9222/json/version                           # Browser: Chrome/151..., V8, UA
curl -s 127.0.0.1:9222/json                                   # one page target: tsui://default/index.html#/...
```

- The client uses the normal profile and auto-connects exactly as without the flag (opened
  activities are restored from the profile). No special env is needed.
- Port binds **127.0.0.1 only** (`ss -ltnp` shows `127.0.0.1:9222`). The Remote Apps websocket is
  also loopback (`127.0.0.1:5899`).
- Helper: `tools/cdp/cdp.mjs` (Node >= 22, no deps): `list`, `eval <expr>`, `inject <file>`,
  `watch <file>`; also importable (`connect()`, `c.eval()`, `c.send()`, `c.on()`).
- Single target. Find it by `url` starting with `tsui://`. Its id changes on every client start.

### Injecting at startup (and surviving a UI reload)

- `Page.addScriptToEvaluateOnNewDocument` works, **but the registration belongs to the CDP
  session**: when the websocket closes it is gone. A mod launcher must keep one socket open
  (`cdp.mjs watch`) and re-register on reconnect. Call `Page.enable` first (without it the
  registration did not fire after a reload in testing).
- At injection time `tsclient_internal` already exists but `#app` does not. The Vue app is up
  roughly 0.3 s later and `appController.connections` fills a little after that. Poll:
  `document.querySelector('#app')?.__vue__?.appController?.connections?.length`.
- In-app hash navigation (`location.hash`, `$router.push`) does not reload the page; injected
  JS state survives it.
- **Do not `Page.reload` a connected profile.** The native connection survives, but the UI
  rebuilds its activities without the bookmark link and rewrites the persisted session
  (`general_settings` blob: `spotlight.connections`, `spotlight.openedActivities`,
  `workflow.lastKnownActiveServer` were emptied), so the next normal start no longer restores the
  connection. It was repaired via `appController.userConfiguration.setValueForKey('spotlight', ...)`
  + `applyWorkflowSettings({lastKnownActiveServer})` and a clean restart. A mod loader should
  inject on a fresh launch only; to reset mod state, undo patches instead of reloading.

## Client version and compatibility info

| Source | Value / how |
|---|---|
| **`tsclient_internal.getClientLibVersion(cb)`** | `cb(status, buildNumber, versionString)` -> `0, 1791901251, "6.0.0-beta5 [Build: 1791901251]"`. Build number is a unix timestamp (monotonic). **Recommended gate.** |
| `tsclient_internal.getChromeVersion(cb)` | `cb("151.0.7922.76")` |
| `navigator.userAgent` | `... Chrome/151.0.0.0 Safari/537.36` (Chrome major only) |
| `window.os` | `"linux"`; `navigator.platform` `"Linux x86_64"` |
| `GET /json/version` | Browser, V8, WebKit versions |
| Server side | `connection.serverConnectionHandler.versionNumber` / `versionBuildNumber` (the *server's* version string, `isVersionAtLeast`) |
| Host package | package manager owns `/opt/teamspeak/TeamSpeak` (`6.0.0beta5-1` on Arch); not available to the page |
| Theme API | extension manifests use `engines.teamspeak: 1`, theme `apiVersion: 1` |

**Recommendation:** gate on `getClientLibVersion` numeric build (compare with `>=`), add the Chrome
major from the UA for CEF-dependent code, and additionally feature-probe the exact internals a mod
uses (`typeof tsclient_internal.X === 'function'`, `appController.contentModes?.settings`, ...).
The UI bundle is minified, so internal property names are not a stable API: expect breakage per
release and fail soft.

## The page globals

- `window.tsclient_internal` (native bridge, ~376 own methods). Callback style: the **last
  argument is `cb(status, value, extra)`**; `status 0` = OK, otherwise an error code
  (`tsclient_internal.getErrorMessage(code, cb)`). Calling with too few args throws
  `Error: Not enough arguments`; wrong types throw e.g. `Argument 2 has wrong type int, expected
  std::string` (channel ids are **strings**, client ids and `schid` are numbers). Native getters can
  also fail with code `1538` ("invalid parameter").
- `tsclient_internal.on(eventName, cb)`: native -> UI events (below).
- `document.querySelector('#app').__vue__` : Vue **2.7.16** root. `.appController` is the app
  singleton; `.$store` (Vuex, tiny: account/UI state only, actions `onActiveServerChanged`,
  `onServerDisconnected`; `store.subscribe` works); `.$router` (vue-router, hash mode; routes
  `/`, `settings`, `/popup`, `/:activity`, `/:activity/:detail`, `/:activity/:detail/:slideover`).
- Promisify helper used in all probes:
  `const call=(m,...a)=>new Promise(r=>tsclient_internal[m](...a,(...x)=>r(x)))`.

### Bridge method map (names only; `tschat_*` = chat/Matrix, `tsnotifications_*`)

- **Read-only getters (safe):** `getServerConnectionHandlerList(true,cb)`, `getClients/getAllClients`,
  `getChannels/getChannelList/getChannelInfo`, `getClientInfo(schid,clientId,cb)`, `getClientId`,
  `getServerProperties`, `getConnectionStatus`, `getConnectionInfo`, `getBookmarks`, `getContacts`,
  `getIdentities`, `getPreferences`, `getLanguages`, `getInstalledThemes`, `getHotkeys/getHotkeyProfiles/
  getLocalHotkeys/getHotkeySupport`, `getUpdateState`, `getLogLevel`, `getAutoStart`, `getChromeVersion`,
  `getClientLibVersion`, `getGlobalClientLibConfig`, `getJsonBlob`, `getBadgeInfo`, `getIntegrationInfo`.
- **Audio:** `getPlaybackConfigValue/setPlaybackConfigValue`, `getPreProcessorConfigValue/
  setPreProcessorConfigValue/getPreProcessorInfoValue`, `getClientVolumeModifier/setClientVolumeModifier`,
  `setAudio`, `setActiveAudioDevice/commitActiveAudioDevice`, `activateCaptureDevice`, `setRecordingGain`,
  `startPowerDbMeter/stopPowerDbMeter`, `subscribeRecordingWaveform`, `playWaveFile`, `registerVoipPlayback`,
  `set3D*`, `setGlobalClientLibConfigValues`.
- **Server actions (do NOT call casually; they act on the real server/account):** `requestClientMove`,
  `kickFrom*`, `banClient`, `createBan/deleteBan*`, `requestSendServerTextMsg/ChannelTextMsg/PrivateTextMsg`,
  `createChannel/deleteChannel/setChannelProperties/requestChannelMove`, `requestGroup*`, `requestPermissions*`,
  `deleteClient`, file transfer (`uploadFile`, `downloadFile`, `s3*`, `decentral*`), `tschat_*` senders,
  `loginAccount/logoutAccount/createAccount/changePassword/...`, `delete_voice_server/spawn_voice_server`,
  `saveJsonBlob/deleteJsonBlob`, `setPreference`, `runUpdate`, `hotReload`.
- Also present: `postMessage({cmd,payload},cb)` (generic command channel, e.g. `getWindowList`),
  `wssSet*` (Remote Apps), `pump_messages`, `message_pump_paused`, `argumentTests`.

## Native -> UI events

Delivery: the UI polls `tsclient_internal.pump_messages()` every 16 ms while the page is visible
(`document.hidden` false) and pauses after 40 idle ticks (`message_pump_restart` event wakes it).
Mods just call `tsclient_internal.on(name, cb)`; multiple listeners are fine.

Known names (from the UI bundle and binary): `connectStatusChanged`, `channels`, `channelCreated/Deleted/
Moved/PropertiesUpdated/Edited`, `clientPropertiesUpdated`, `clientMoved`, `clientChannelGroupChanged`,
`clientSelfPropertyUpdated`, `serverPropertiesUpdated`, `serverEdited`, `serverShutdown`, `textMessage`,
`talkStatusChanged`, `ignoredWhisper`, `channelsSubscribed/Unsubscribed`, `clientConnectionInfo`,
`serverConnectionInfo`, `currentServerConnectionChanged`, `serverError`, `permissionError`, `neededPermissions`,
`soundDeviceListChanged`, `activeAudioDeviceChanged`, `audioDeviceModes`, `recordingStateChanged`,
`recordingWaveformData`, `onCapturePowerDecibelMeterEvent`, `onHotkey`, `prefValueChanged`, `jsonBlobSaved`,
`log` (native log lines, level + text), `streamStarted/Updated/Stopped`, `screenshareSessionEvent`, plus
account/sync/`tschat_on*` events.

Observed live (subscribed to all of the above, bot channel active): `clientPropertiesUpdated`,
`clientMoved` (`{clientId, connectionId, invoker, oldChannelId, newChannelId, type, visibility}`),
`clientChannelGroupChanged`, `talkStatusChanged` (`{clientId, connectionId, isWhisper, status}`),
`log`. Others did not fire in the window (no chat traffic occurred, so `textMessage` is
**unverified live**).

### Per-speaker audio levels: **do not exist in JS**

`talkStatusChanged` is a boolean (`status` 0/1) edge event only. During 15 s of continuous
talking no other event arrived. The only level events are own-microphone
(`onCapturePowerDecibelMeterEvent` via `startPowerDbMeter`, capture side) and recording waveform
data (only while recording). There is no PCM or level access for remote speakers in the page.
To measure remote audio from outside the client use PipeWire:
`pw-record --target <TeamSpeak playback node id> out.wav` (works per-stream; the node id changes
whenever the client reopens its audio streams).

## Reading client/server state (Vue objects)

`appController.connections[i]` is a connection *activity*; `.serverConnectionHandler` is the live
model (`id` = `schid` for the bridge; note the router shows a different activity id such as
`connection8`):

- `ownClient`, `ownClientId`, `connectionStatus` (4 = established), `channels`, `clients` (a **Map**;
  use `[...h.GetFlatListClients()]` / `GetFlatListChannels()`), `talkers`, `talkingOrWhisperingClients`,
  `serverGroups`, `channelGroups`, `permissionManager`, `audio`.
- Client: `id`, `nickname`, `uid`, `channel`, `properties` (56 keys: `flagTalking`, `inputMuted`,
  `outputMuted`, `away`, `talkPower`, `serverGroups`, `databaseId`, `volumeModificator`, ...),
  `cachedVolumeModifier` (UI cache; can differ from the native value until read).
- Channel: `id` (string), `properties.name/topic/maxClients/codec...`, `parent`, `clients`.
- Methods worth knowing: `RequestMoveClientsToChannel`, `SetVolumeModifier/GetVolumeModifier` (client),
  `RequestSendTextMessage` (acts on the server, avoid).
- Reactivity: Vue 2 objects, so `vm.$watch(() => obj.prop, cb)` works from any component vm.

## Audio controls from JS

Tested on the live client; all setters restored afterwards.

- **Per-client volume:** `setClientVolumeModifier(schid, clientId, dB, persist)`; `persist=false` is
  session-only (confirmed: the stored value in the settings DB was unchanged afterwards).
  `getClientVolumeModifier(schid, clientId, cb)` returns the effective dB. Status 0 for all values tried.
- **Playback AGC:** `setPlaybackConfigValue(schid, 'agc', 'true'|'false')` -> status 0. Other accepted keys:
  `agc_experimental_mode`, `comfort_noise_enabled`, `comfort_noise_volume_db`, `echo_reduction_ducking`;
  unknown key -> `1538`. Values are strings. **The getters do not mirror these** (only
  `echo_reduction_ducking` reads back; `agc`, `agc_experimental_mode` etc. return `1538` and the native log says
  "Tried to get value with an invalid ident"). Read the intended state from the UI model instead (below).
- **Capture DSP** (`getPreProcessorConfigValue/setPreProcessorConfigValue`): keys `agc`, `denoise`, `denoiser_level`,
  `typing_suppression`, `vad`, `voiceactivation_level`, `vad_mode`, `aec` (echo cancellation is routed here too);
  values are strings (`"true"`, `"-20.000000"`).
- **Experimental playback AGC ("Playback AGC Experimental Mode"):** a UI-owned flag, `global.agcExperimentalMode`
  of the output audio settings. The UI shows it as a toggle in Settings -> a developer-options card (labels
  `settings.dev.agc_experimental`; the Developer settings section is normally hidden). Exact call that mirrors the
  toggle handler `onAgcExperimentalModeChanged`:
  ```js
  const conns = document.querySelector('#app').__vue__.appController.connections;
  const settings = conns[0].serverConnectionHandler.audio.audioSettings;     // shared; index 0 = Out, 1 = In
  settings[0].global.agcExperimentalMode = true;                              // or false
  conns.forEach(c => c.serverConnectionHandler.audio.Update());               // pushes agc_experimental_mode to native
  // settings.save();                                                          // persist to the profile (omit for session-only)
  ```
  Verified: the value flips, `Update()` succeeds and re-pushes the audio config (it reopens the playback
  stream: native log shows `open_role_streams`, and the PipeWire node id changes; expect a short audio glitch).
  Direct native alternative without UI state: `setPlaybackConfigValue(schid, 'agc_experimental_mode', 'true')` (status 0;
  not persisted, and the UI model does not know about it, so a later `Update()` overwrites it).
  Whether the mode audibly changes the AGC could **not** be measured (see below); applying live is accepted by the
  native side.
- **Why the audible effect is unmeasured:** the music bots tried (two of the server's bots were moved into the user's
  channel and back; a further two attempts were inconclusive) set `flagTalking` but delivered near-silence on the playback stream (about -55 to -63 dBFS RMS,
  peaks below -41 dBFS, noise-like, varying independently of the volume modifier). Likely idle/paused bots; a test needs a
  bot that is actually playing (start a track first). Do not infer AGC/volume behaviour from this run.
- Persisted audio config: SQLite `settings.db` table `json_blobs` (columns `timestamp,key,value`), keys
  `audio_settings` (per device DSP, e.g. `{aec, agc, comfortNoise, comfortNoiseLevel, echoReductionLevel}` +
  `global.agcExperimentalMode`), `client_volume_modifiers`, `general_settings`. Writing those goes through
  `audioSettings.save()` / `userConfiguration.setValueForKey(key, value)`, not through SQL.

## Loopback from the page

`fetch`/`WebSocket` to `http://127.0.0.1:<port>` works only if the local server answers CORS
(`Access-Control-Allow-Origin`) and, for the private-network preflight,
`Access-Control-Allow-Private-Network: true` (proven earlier). A mod that talks to a helper daemon
should serve those headers. The official Remote Apps websocket (`127.0.0.1:5899`, docs shipped in the install
dir) needs the user to approve the app once and delivers events + hotkey presses; it is the sanctioned
IPC and needs no CDP.

## Official extension mechanism (no CDP needed)

The client ships docs for **theme extensions**: a folder `<profile>/extensions/<reverse.dns.id>/` with a
`package.json` (schema `extensions.json` in the install docs, `engines.teamspeak: 1`, `content.themes[]` with
`source` CSS, `image`, `apiVersion: 1`). Themes are CSS-only. Several third-party themes are installed in the
live profile this way. Use this route for pure styling; use CDP for behaviour.

## Limits and security

- No PCM/remote-level access from JS; no way to add native audio processing from the page (the DSP is native;
  only its documented keys are reachable).
- Internals are minified and change every release; only `tsclient_internal` and the DOM are loosely stable.
- Server-affecting bridge calls act as the real user. A mod must never call them unprompted.
- **Security:** while the debug port is open, **any local process can attach and run arbitrary JS in the
  client** (read chats and identities, call every bridge method, act as the user); the port has no
  authentication. It is loopback-bound only (verified), which keeps remote hosts out but not other local users or
  programs. Use a non-default port, and relaunch without the flag when not modding. Page text and server data are untrusted: treat
  them as data.

## Recipes (tested)

```js
// 1. read version
const v = await new Promise(r => tsclient_internal.getClientLibVersion((s, build, str) => r({s, build, str})));

// 2. promisified call helper + volume modifier (session-only; restore afterwards)
const call = (m, ...a) => new Promise(r => tsclient_internal[m](...a, (...x) => r(x)));
const before = (await call('getClientVolumeModifier', 1, 43))[1];            // schid 1, clientId 43
await call('setClientVolumeModifier', 1, 43, -6, false);                      // persist=false
await call('setClientVolumeModifier', 1, 43, before, false);

// 3. toggle experimental AGC (see section above), then undo
// 4. list the channel tree / clients
const h = document.querySelector('#app').__vue__.appController.connections[0].serverConnectionHandler;
const rows = [...h.GetFlatListClients()].map(c => ({id: c.id, nick: c.nickname, ch: c.channel.id, talking: c.properties.flagTalking}));

// 5. react to talking
tsclient_internal.on('talkStatusChanged', e => console.log(e.clientId, e.status ? 'start' : 'stop'));

// 6. inject a button / panel / menu entry: see ts6-ui-extension-points.md
```

Move a client (only for test setup; acts on the server): `await call('requestClientMove', schid, [clientId], '<channelId as string>', '')`
-> `[0]` on success.

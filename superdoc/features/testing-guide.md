# Testing guide (for a human tester)

A practical checklist to try every mod by hand. Each mod: **try** (what to do) and **expect** (what you should see). Mod docs have the
details: [agc.md](agc.md), [mods-panel.md](mods-panel.md), [mod-net.md](mod-net.md), [mod-power.md](mod-power.md),
[mod-aware.md](mod-aware.md), [mod-layout.md](mod-layout.md), [mod-theme.md](mod-theme.md), [mod-chat.md](mod-chat.md),
[mod-files.md](mod-files.md). Framework: [ts6-mod-api.md](ts6-mod-api.md). Automated checks are separate (`node tools/test/run-all.mjs`).

## Start modded, get back to vanilla

- Close the TeamSpeak client, then run `launcher/ts6-mod` from the repo root (or start the "TeamSpeak (modded)" desktop entry built from
  `launcher/ts6-mod.desktop`). Optional: a server URL after the command to auto-connect.
- Open **Settings -> Mods**: a card per mod. All mods start **off**; switch on the one you test with the switch on its card, then open
  its own page with the card name or "Settings ›" ("‹ All mods" goes back; the search field finds mods by name and by setting label).
- Back to vanilla: switch every mod off, or close the client and start it the normal way (without the launcher).
- Set-up for most items: connect to a server and have at least one other person (or a second client) in your channel.

## The Mods page itself

1. Settings -> Mods. Expect: header "Mods", "N of 9 on · everything off = stock client", a search field, one card per mod (icon, name,
   switch, one-line description, status line, "Settings ›"). Enabled cards are slightly tinted.
2. Flip a card's switch. Expect: the mod goes on/off without leaving the overview; the status line changes ("On · …" / "Off").
3. Click a card name. Expect: the mod's page replaces the grid (back link, header with its switch, settings in boxes; Audio has tabs).
   Switch it off there: a note says it is off and its settings are kept. "‹ All mods" returns to the grid. Leaving the Mods category and
   coming back shows the grid again.
4. Type "ping limit" in the search. Expect: only "Connection quality" stays, its status line names the matching setting; a nonsense word
   shows "No mod or setting matches".
5. Make the window narrow (about 960 px). Expect: one column of cards, boxes stack, nothing cut off.

## audio (AGC and per-user audio)

Settings -> Mods -> Audio card (tabs Processing, Presets, Parameters, Per-user). Needs the PulseAudio/PipeWire-pulse backend.

1. **Whole stream.** Mode "whole stream", master switch on, preset Voice. Let someone speak loudly, then quietly.
   Expect: status line says processing; the meters move (input level, gain reduction, leveler gain); quiet speech is lifted, loud speech
   never gets above the ceiling (default -1 dB peak), and the first syllable of a loud speaker has no start-of-speech spike.
2. **Per speaker.** Switch mode to "per speaker" (the page explains it). With two people talking at different volumes.
   Expect: a list of speakers with nicknames and their own level and gain reduction; the quiet person is levelled up on their own while
   the loud person is not turned down because of them (in whole mode they share one gain).
   Note: in per-speaker mode the ceiling holds per speaker before the mix; two people talking at once can peak above it (whole mode holds it on the mix).
3. **Presets.** Switch between Voice, Music, Quiet night.
   Expect: the parameter sliders change to the preset values (Quiet night: lower overall volume, ceiling -6 dB); editing a value shows
   "modified"; Save as... creates your own preset, Update/Rename/Delete work, Revert returns to the preset.
4. **Per-user Audio...** Right-click a user in the channel tree -> "Audio..." (or Edit... in the page's per-user list). Try volume, mute,
   boost (0 to +24 dB), AGC "Bypass" and "Custom".
   Expect: the change is audible for that user only; boost and AGC overrides act only in per-speaker mode with the master on (the popover
   says so); Reset restores everything; the setting is back after you reconnect or restart the client (stored per user).
5. **Switch the mod off.** Expect: audio is untouched (status: passthrough, delay 0), per-user volume and mute are back to what they were.

Known limits: whole mode shares one gain for all speakers; enabling processing adds the lookahead delay (default 5 ms) to all playback.

## dashboard

1. Switch on "Dashboard button". Expect: a Dashboard icon in the left icon column, after the existing icons.
2. Click it. Expect: the start page opens (same as the main-menu entry) and the icon is highlighted; leaving the page removes the highlight.
3. Switch off. Expect: the icon is gone.

## net

Needs a server connection.

1. Switch on. Expect: a HUD in the top bar next to the mic and speaker buttons with `<n> ms`, `<n> %` and data rate; hidden when not connected.
2. Click it. Expect: a popover with a 60 s graph, ping now/jitter/min/avg/max, loss, bandwidth, codec and channel. Escape or a click outside closes it.
3. Press "Copy diagnostics" and paste somewhere. Expect: a text block with versions, ping, loss and codec; the button says "Copied".
4. In the settings turn "Show bandwidth" off, then enable Alerts with a low ping limit (30 ms). Expect: the HUD loses the rate part; a notification
   appears once and does not repeat for a minute.
5. Switch off. Expect: HUD and popover gone.

## power

1. Right-click a user and a channel. Expect: entries "Copy unique ID", "Copy client ID", "Copy nickname" (users) and "Copy channel ID", "Copy channel path"
   (channels) in a "Mods" section; clicking one shows a notification with the copied value, and it pastes correctly.
2. Press **Ctrl+K**. Expect: a palette with a search field. Type part of a channel name: "Join <channel>" appears; Enter joins; Esc closes. Also try
   "Open Mods page", "Mute microphone". The shortcut can be changed in the settings.
3. Look at "Hidden developer toggles" in the settings. Expect: a list of switches with a warning that they change real client settings; nothing is
   changed until you click one.
4. Switch off. Expect: no extra menu entries, Ctrl+K does nothing.

## aware

1. Switch on. Expect: when someone talks in a channel its row shows a note pill with a count, then a fading dot (about 30 s). Only channels you are subscribed to light up.
2. Look at the top bar. Expect: a join/leave feed button; ask someone to join, move, leave. The list shows time, nickname and from -> to.
3. Turn on the idle probe (off by default; it sends one request every 5 s). Expect: users in expanded channels who were idle for over a minute get an
   `idle 12m` style label that keeps growing.
4. Switch off. Expect: badges, feed button and labels gone.

## layout

All sub-features start off after enabling the mod.

1. "Chat tabs": open two chats. Expect: a tab strip in the title bar with one tab per chat (click switches, x closes, count badge for unread), and the
   left column collapsed to its icon column; switching off restores the previous column.
2. "Server tabs" (own switch): connect two servers. Expect: one tab per server in front of the chat tabs, no x.
3. Density slider: move 60 to 140 %. Expect: tree rows get smaller/larger live; 100 is exactly vanilla.
4. Hide switches: try each (announcement bar, banner card, File Transfer Info card, Create Channel, AFK, Create a TeamSpeak Community, Bookmarks,
   Dashboard banner / Popular Servers / Chats). Expect: exactly that element disappears, and comes back when switched off.

## theme

1. Switch on. Expect: a theme picker with "Default (no extension theme)" and every installed extension theme; picking one applies it like in Appearance settings.
2. "Reload theme now" after editing the active theme's CSS file. Expect: the change appears without a restart (also changed row heights).
3. Turn "Live reload" on and save the file again. Expect: it applies within about a second; turn it off: no polling.
4. Switch off. Expect: the theme stays as selected, the mod adds nothing.

## chat

1. Switch on. Paste a text of 10,000+ characters into a channel chat. Expect: the box accepts it; a hint "Will be sent as N parts" shows above it.
2. Send. Expect: several messages arrive one after the other, cut at paragraph/line/space boundaries; nothing is silently lost (the server drops
   any single message over its limit, which is the reason for splitting).
3. Paste a long text with a fenced code block (` ``` `) crossing a cut. Expect: the block is closed at the end of one message and reopened with the
   same fence (and language) at the start of the next, never an empty block.
4. Short messages are sent as usual. Set a delay in the settings (for example 500 ms): parts arrive with a pause.
5. Switch off. Expect: the stock input limit and no hint.

## files

Compresses images that are over a size threshold (default 5 MB; maximum long edge 2560 px).

1. Switch on. On a **TS3 server** the only image upload route is the channel's **Files tab** (channel chat and private chat have no attach button
   there). Open a channel's Files tab and drop in an image larger than 5 MB. Expect: a notification "original size -> new size, resolution, format, quality";
   the uploaded file is smaller than the threshold. The same with the upload button of the tab.
2. In a chat of a **TS6 account** (chat file routes exist only there): drag, paste or attach (button) a large image. Expect: it is compressed and
   shown as the attachment chip; files below the threshold, GIF, SVG and non-images are untouched.
3. Try Output format WebP and the transparent-image options with a PNG that has transparency. Expect: transparency kept (WebP/PNG) or white background.
4. Switch off. Expect: stock behaviour (large images rejected by chat, no notification).

Note: the result has no EXIF or GPS data (always stripped).

## Everything off = vanilla

1. Switch every mod off (or restart without the launcher).
2. Expect: no added buttons, tabs, badges, menu entries, hints or notifications; Settings has the "Mods" entry only when started through the launcher;
   audio sounds as stock (status passthrough); nothing in the client reacts to Ctrl+K.
3. Optional automated confirmation: `node tools/test/run-all.mjs --cdp-port 9222` ends with a "vanilla" step that must PASS.

## Looks right in default and your own themes

Switch themes (Settings -> Appearance, or the theme mod's picker) and look at the Mods page and every visible piece: net HUD and popover, aware badges
and feed, layout tabs, power palette, audio popover, toasts. Expect: text readable, colours follow the theme (mods use the theme's own colours),
nothing clipped or overlapping in either the default theme or your extension themes; also at a narrow window width (the net HUD is the widest piece:
turn off its bandwidth part).

Note on the runner's vanilla step (`tools/test/run-all.mjs`): it first waits until no native request has been made for 1.2 s. The last core
test hot-reloads the core, and the new core's one-shot audio vanilla guard (`panel/core/x-audio.js:vanillaGuard`, one `GET /config` per page
load) could otherwise land inside the 600 ms "no polling" window and fail it intermittently. With `--examples` the vanilla step only
switches off mods that are still registered (example tests unregister theirs).

<img src="icon.png" width="96" align="right" alt="">

# teamspeak-6-mods

Opt-in mods for the stock **TeamSpeak 6 client on Linux**. Every mod has its own switch and is **off by default**; with
everything off you get the normal client.

## How it works

```
teamspeak-6-mods (launcher/ts6-mod)
 ├─ starts the stock TeamSpeak client, unchanged, with a small native library preloaded (LD_PRELOAD)
 │    └─ processes the audio you hear: compressor / limiter on the whole mix, or on each speaker
 │       separately (via a hook on the client's per-sender audio)
 └─ a Node script injects the JS mod framework into the client's UI over the Chrome DevTools Protocol
      └─ the mods show up in Settings → Mods
```

No TeamSpeak files are modified; everything is added at runtime and disappears when you close the client.

## Install

Quick: `ritz-get install teamspeak-6-mods`

Manual: needs Linux, the TeamSpeak 6 client (tested with 6.0.0-beta5.1 in `/opt/teamspeak`; `~/.local/opt/teamspeak` and the Flatpak are detected automatically, see [Flatpak](superdoc/features/flatpak.md); otherwise set `TS6MOD_TS_BIN`),
Node.js 22+, `gcc` and `make`, and PulseAudio or PipeWire's pulse layer for the audio mod. Then run:

```
./install.sh --install     # builds the native library, links ~/.local/bin/teamspeak-6-mods
./install.sh --remove      # undoes it
```

For development, `make -C native` and `launcher/ts6-mod` work straight from the repo.

## Use

Run `teamspeak-6-mods` (TeamSpeak must not already be running). Open **Settings → Mods**: each mod is a card with a switch;
switch it on and open the card for its settings. To go back to normal, switch the mods off or start TeamSpeak the usual way.

## Mods

| Mod | What it does |
|---|---|
| Audio | Automatic gain control (leveler, compressor, limiter), whole stream or per speaker, presets, per-user volume |
| Dashboard button | Direct button for the Dashboard (start page) |
| Connection quality | Ping / packet-loss readout in the top bar |
| Power tools | Copy-ID menu entries, command palette (Ctrl+K), hidden developer toggles |
| Server awareness | Talking badges on channels, idle times, join / leave feed |
| Layout | Chat tabs in the title bar (current channel first, reorderable), row density, hide clutter |
| Theme tools | Theme picker, one-click reload, live reload of the active theme |
| Split long messages | Splits long chat messages and raises the input limit |
| Compress images | Shrinks large images before upload |

## Your own mods

A mod is a folder with an `index.js` using a small API: [superdoc/features/ts6-mod-api.md](superdoc/features/ts6-mod-api.md).

## After a TeamSpeak update

Start the modded client and run `node tools/test/run-all.mjs`; it checks the UI anchors and the native audio signature and says what
needs fixing (see the docs).

## More

[Testing guide](superdoc/features/testing-guide.md) · [Docs overview](superdoc/architecture/overview.md)

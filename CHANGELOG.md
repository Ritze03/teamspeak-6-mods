# Changelog

All notable user-facing changes, newest first. Categories:

**Added** (new features),
**Fixed** (bug and behaviour fixes),
**Removed** (things taken out),
**Info** (notes worth knowing).

## 2026-11-11

### Added
- **Audio mode dropdown**: The Audio mod has an AGC dropdown (TS6Mods, Vanilla, Vanilla
  (Experimental)) instead of a master switch. It drives the client's own playback AGC too
  and restores your stock values when the mod is switched off.
- **Packet loss per direction**: The connection readout, its popover and the copied
  diagnostics show packet loss for download and upload separately.
- **Idle word toggle**: Server awareness has a "Show the word idle" switch.
- **Mods settings icon**: The Mods entry in Settings uses the project icon.

### Fixed
- **Compact connection readout**: The readout is narrower, so the bandwidth part fits the
  bottom bar instead of wrapping onto a clipped second line.
- **Frozen connection readout**: One lost connection-info request no longer freezes the
  readout; a stale value shows as empty.
- **Window dragging with chat tabs**: Empty title-bar space right of the chat tabs drags the
  window again; only the tabs themselves are clickable.
- **Talk circle for other channels**: The talk circle lights while someone's idle time is
  under one second, checked every second and ranked by recent activity, with a timeout on
  each request.
- **Image compress limit**: The compress threshold slider now tops out at 5 MB; larger saved
  values are clamped.

### Info
- **Test clients**: The test rig can run its clients in a headless Sway session, so they
  stay out of your desktop.

## 2026-11-10

### Added
- **First release**: Opt-in mods for the stock TeamSpeak 6 client on Linux, started with
  `teamspeak-6-mods`, with a **Settings > Mods** page of cards. Every mod has its own switch
  and is off by default; with everything off you get the normal client. Nothing in the
  TeamSpeak install is modified.
- **Audio mod**: Automatic gain control (leveler, compressor, limiter) on the whole sound
  you hear or on each speaker separately, with presets and a per-user audio popover. The
  defaults are tuned (per-speaker mode, target -32 dB, gate -60 dB, ceiling -12 dB) and the
  compressor starts off.
- **Dashboard button**: A direct button for the Dashboard (start page).
- **Connection quality**: A ping, packet-loss and bandwidth readout in the bottom bar, a
  sparkline popover, codec info, alerts and copyable diagnostics. Its position is a setting.
- **Power tools**: Copy-ID entries in context menus, a command palette (Ctrl+K) with local
  and join actions, and the hidden developer toggles.
- **Server awareness**: Talk circles light for people talking in other channels, shown
  from their polled idle time, plus a join/leave feed. Muted, mic-less and away clients are
  skipped.
- **Layout**: Chat tabs in the title bar (current channel first, drag to reorder, with
  channel icons or avatars), a live channel-tree density slider, hide switches for clutter
  and a style choice for the Create Channel button.
- **Theme tools**: A theme picker, a reload button and live reload of the active theme.
- **Split long messages**: Long chat messages are split at safe points (code fences stay
  intact), with a higher input limit.
- **Compress images**: Oversized images are shrunk before upload from chat drop, paste, the
  picker and the Files tab. The "Image compressed" toast is a setting, off by default.
- **Flatpak and tarball clients**: The launcher finds the client in `/opt`, `~/.local/opt`
  or the Flatpak, and detects a running Flatpak client.
- **ritz-get install**: `ritz-get install teamspeak-6-mods` builds and installs it, with a
  desktop entry.

### Fixed
- **Theme tree heights**: The channel tree is re-measured when you return to the connection
  view, and theme switches re-measure it, so rows no longer overlap.
- **Settings page scrolling**: The Mods settings page scrolls, and menu icons have a
  fallback.

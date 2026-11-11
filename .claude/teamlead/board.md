# Board

<!-- GENERATED from .state/board.json — do not hand-edit; use the board tools -->

| ✓ | ID | Task | Agent | Owns | State | Branch |
|:-:|:--:|------|-------|------|-------|--------|
|   | 35 | Files mod: verify a real Files-tab image upload on the local test server (needs upload permission granted via ServerQuery) | `tl-sonnet-medium` | *(read-only)* | blocked | — |

## Done

| ✓ | ID | Task | Agent | Owns | State | Branch |
|:-:|:--:|------|-------|------|-------|--------|
| x | 52 | Aware talk circle: never mark muted clients (mic muted/away/hardware off); better timing: recently-active clients re-asked first, faster clear, shorter lit hold | `tl-sonnet-medium` | `panel/mods/aware`, `panel/core/x-aware.js`, `superdoc/features/mod-aware.md` | merged | worktree-agent-a8c82387590049479 |
| x | 53 | Files mod: notifyDone default false | `tl-sonnet-low` | `panel/mods/files`, `superdoc/features/mod-files.md` | merged | worktree-agent-adf65bf8e862db899 |
| x | 54 | Layout title-bar tabs: start at the chat pane's x; first tab = current channel's chat (replaces server tab, follows channel moves, no duplicate); other tabs drag-reorderable | `tl-opus-medium` | `panel/mods/layout`, `panel/core/x-layout.js`, `superdoc/features/mod-layout.md` | merged | worktree-agent-adae00b4d4f647ccd |
| x | 55 | Layout: chat tabs keep their x when the chat pane is hidden (Settings etc.) — reuse last measured chat-header x | `tl-sonnet-medium` | `panel/mods/layout`, `panel/core/x-layout.js`, `superdoc/features/mod-layout.md` | merged | worktree-agent-adc717a8a64ee8907 |
| x | 56 | Audio defaults = user's current config (Voice preset + DSP defaults + default mode per_speaker) | `tl-sonnet-medium` | `native`, `panel/mods/audio`, `panel/core/x-audio.js`, `superdoc/features/agc.md`, `README.md` | merged | worktree-agent-a530d4a2b3ca14676 |
| x | 57 | Launcher: Flatpak TS6 support (flatpak run mode), auto-detect client install (/opt, ~/.local/opt, flatpak), detect any running TS instance incl. Flatpak | `tl-sonnet-medium` | `launcher`, `install.sh`, `teamspeak-6-mods.desktop`, `README.md`, `superdoc/features/ts6-mod-api.md`, `superdoc/features/flatpak.md`, `CLAUDE.md` | merged | worktree-agent-a95210445dd1847d7 |
| x | 58 | Layout chat tabs: show user avatars on user/DM tabs and the channel's custom icon on channel tabs (incl. pinned tab), fallback to current generic icon | `tl-sonnet-medium` | `panel/mods/layout`, `panel/core/x-layout.js`, `superdoc/features/mod-layout.md` | merged | worktree-agent-a7f9514c24e1c7a90 |
| x | 59 | Files mod: 'compress images larger than' setting max 5 MB (TS6 upload limit), clamp stored values | `tl-sonnet-medium` | `panel/mods/files`, `superdoc/features/mod-files.md` | merged | worktree-agent-a346c1b7c955977ea |
| x | 60 | Net mod bottom bar: tighter spacing; bandwidth readout not showing when enabled — fix | `tl-sonnet-medium` | `panel/mods/net`, `panel/core/x-net.js`, `superdoc/features/mod-net.md` | merged | worktree-agent-a69d71573bf2905db |
| x | 61 | Net mod: show packet loss split into down (server→client) and up (client→server) values in the readout | `tl-sonnet-medium` | `panel/mods/net`, `panel/core/x-net.js`, `superdoc/features/mod-net.md` | merged | worktree-agent-aa0b7b71253febbb3 |

### How it was solved

- **52** d6938af. canTalk = !inputMuted && inputHardware!==false && !inputDeactivated && !away (excluded from candidates and from marks, re-synced on property events); outputMuted and isTalker are not used (isTalker is unreliable). Lit if idle+age < talkHold (new setting, 1.5 s), or idle<300 ms and age < I+0.5 s (slack until the next answer). Per-client period: lit 1 tick, <30 s 2, <5 min 4, else 12; ask never-asked first, then due lit clients, then the highest overdue ratio. Sync every 300 ms.
- **53** a0fb266. notifyDone default false in both DEF objects + doc table.
- **54** b2622e2. Pinned tab = connection.currentChannelItem (as the stock "Show current Channel Chat" button), opened by appController.showItem(ch,'Chat'); a duplicate channel-chat item is dropped in the snapshot. Strip left = chat header .tsv-bar-item x (anchor layout.chatPane), min toolbar right+12, ResizeObserver; narrow: shrink, then scroll, then hide. Server tabs removed (switch servers via the sidebar icons). tabOrder in api.storage keyed serverUuid|u:uid / c:chid, written only on drop/close. Pointer drag with drop line. Lead fixed the README and guide wording.
- **55** place() stores the rounded chat-header x (frame.rect().chatLeft, only when a visible chat pane exists) as api.storage tabsX; strip left = min(max(toolbar floor, tabsX), right-60), so Settings/Dashboard keep the last chat x and a stale value can't overflow. b30c262, hot-reloaded; tests deferred.
- **56** Changed ts6dsp_default_params (target -32, gate -60, ratio 1, ceiling -12), cfg_default mode per_speaker, Voice preset values, README/agc.md tables; hook test now POSTs mode whole explicitly, ceiling check -12. DSP unit tests pass; build/libts6mod.so rebuilt atomically, panel hot-reloaded. cd868dd.
- **57** Launcher discovery: TS6MOD_TS_BIN > TS6MOD_FLATPAK(_ID) > /opt > ~/.local/opt > flatpak com.teamspeak.TeamSpeak (Flathub, binary /app/extra/TeamSpeak). Flatpak mode: flatpak run --env=LD_PRELOAD/TS6MOD_PORT/TS6MOD_EXE --filesystem=<so dir>:ro. Exports TS6MOD_EXE (native is_main_process gate was silently off for non-/opt installs). Running check: any */TeamSpeak, flatpak ps, port 5899 fallback; main_pid tolerates wrapper args. TS6MOD_DRYRUN. Doc flatpak.md. Untested on real Flatpak; glibc-version risk documented. 8328482.
- **58** x-layout imageOf(): chat/pinned items carry img from the Vue item's .image ({type:'url',src} = tsic:// cached icon/avatar URL, +ts-frame=1 like stock), reactive via the existing snapshot $watch. Tab renders 20px round <img>, onerror/empty -> api.icon('channel'|'client'). No extra requests. Verified live: 3 tsic images load in real client. ad33455.
- **59** limitMB slider 1-5 step 1; clamped to <=5 on read in cfg(), settings get and card status (stored value untouched until slider moves); effLimit already derives from it. d779c08, hot-reloaded.
- **60** Root cause: bandwidth block wrapped to a clipped 2nd row (hud flex-wrap, height 21px, overflow hidden) because 7ch ping/loss boxes filled the 228px bottom bar. Fix: ping/loss min-width 6ch, bw values 5.5ch, gaps 6/4px, tighter bottom padding; still fixed-width. 286c9c0. Not hot-reloaded (client was closed).
- **61** x-net already exposed lossUp/lossDown (client2server/server2clientPacketlossTotal); HUD loss now two 5ch tabular boxes ↓x.x% ↑x.x% (fmtPctShort, '–' when missing, per-direction error colour), popup + diagnostics show both, alerts keep max of directions; gaps 4/2px so typical values + bandwidth fit 228px. Verified live: one row, 133px without bandwidth. 3a5cb68.

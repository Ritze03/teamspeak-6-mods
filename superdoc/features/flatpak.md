# Flatpak and non-/opt clients

`launcher/ts6-mod` finds the TeamSpeak 6 client itself, so the desktop entry (`Exec=teamspeak-6-mods %u`) works without any env var
for the Flathub package and for a tarball unpacked outside `/opt`.

Why: a user runs the Flatpak build; before this, they had to unpack the tarball by hand and set `TS6MOD_TS_BIN`, and the launcher did
not notice the still-running Flatpak instance (it holds TeamSpeak's local port 5899), so the modded client logged "Address already in
use" and the control port never came up.

## Discovery order

1. `TS6MOD_TS_BIN` (explicit, always wins; native mode).
2. `TS6MOD_FLATPAK=1` or `TS6MOD_FLATPAK_ID=<id>` set: Flatpak mode.
3. `/opt/teamspeak/TeamSpeak`, then `~/.local/opt/teamspeak/TeamSpeak` (first executable wins).
4. The Flatpak app, if `flatpak list --app --columns=application` shows the id.
5. Otherwise: "client not found" with the places looked at.

`install.sh` runs the same checks but only prints a note on a miss.

## Flatpak mode

Flathub app id: `com.teamspeak.TeamSpeak` (the single TeamSpeak entry on Flathub; its releases list is 6.0.0-beta*, so it is TS6; the
TS3 client is not on Flathub under another id). Its manifest installs the client at `/app/extra/TeamSpeak` (an extra-data download
unpacked at install time) and grants `--share=network`, so loopback ports are shared with the host. Override the id with
`TS6MOD_FLATPAK_ID` if it ever changes.

The launcher runs (values shown with placeholders):

```
flatpak run --env=LD_PRELOAD=<repo>/build/libts6mod.so --env=TS6MOD_PORT=<ctl> --env=TS6MOD_EXE=/app/extra/TeamSpeak \
  --filesystem=<repo>/build:ro com.teamspeak.TeamSpeak --remote-debugging-port=<cdp> "$@"
```

- `--env` (not a host-side `LD_PRELOAD=`) because the variable must reach the app inside the sandbox, not `flatpak` itself.
- `--filesystem=<dir>:ro` makes the module visible in the sandbox; it is a per-run grant, no permanent override is written.
- `TS6MOD_EXE` is how the native module recognises the main process (it compares `/proc/self/exe`); inside the sandbox that is
  `/app/extra/TeamSpeak`. For native mode the launcher now exports the discovered client path as `TS6MOD_EXE` too, so a
  `~/.local/opt` install works (the default used to be `/opt/teamspeak/TeamSpeak` only).
- The CDP injector and the page wait are unchanged. The main-process lookup matches `/app/extra/TeamSpeak ... --remote-debugging-port=<cdp>`
  in the host's `/proc` and tolerates the Flathub wrapper's own `--ozone-platform` flags in front of ours.
- `TS6MOD_WRAP` prefixes the `flatpak run` command. `TS6MOD_PROFILE_DIR` is refused in Flatpak mode (the sandbox ignores a changed
  `HOME`; run a second client from a tarball instead).

## Already-running check

Without `TS6MOD_PROFILE_DIR` the launcher refuses to start when it sees any `.../TeamSpeak` main process without a debug port, a
client on our CDP port, `flatpak ps` listing the app id ("already running (Flatpak ...)"), or, when no TeamSpeak process is visible at
all, a listener on TCP 5899. Reason: a second start is swallowed by the running instance and the module cannot be preloaded late.

## Sandbox paths

The native module writes its config and log under `XDG_CONFIG_HOME` / `XDG_STATE_HOME`; in the sandbox those are
`~/.var/app/<id>/config/ts6-mods/agc.json` and `~/.var/app/<id>/.local/state/ts6-mods/ts6mod.log` (so settings are separate from a
native install). Nothing on the host reads these files: the control API and the Mods page use the loopback port, which agrees
between launcher, module and injector via `TS6MOD_PORT`.

## Known limits and unverified assumptions

- Not yet tested against a real Flatpak (none was available when written). Assumed: loopback is shared (`--share=network`, per the
  manifest), `flatpak run --env/--filesystem` as above, `/proc/<pid>/cmdline` of sandboxed processes readable by the same user.
- glibc: the module needs only `libm`/`libc`, but is linked against the **build host's** glibc symbol versions (a rolling distro can
  need `GLIBC_2.38` for `__isoc23_*` and `GLIBC_2.43` for `sqrtf`/`log10f`). The Flatpak runtime's glibc must be at least as new;
  check with `objdump -T build/libts6mod.so | grep -o 'GLIBC_[0-9.]*' | sort -uV | tail -1`. If it is too new, the dynamic loader
  prints a preload error and the client starts unmodded (no control port); build on an older host/container to fix.
- The per-speaker hook matches an exact byte signature of build `6.0.0-beta5.1` and turns itself off on any other build (whole-stream
  mode still works). The Flatpak ships whatever build Flathub has at that time.
- `StartupWMClass=TeamSpeak` in the desktop entry is unchanged and may not match the Flatpak window class; only task-bar grouping is
  affected.
- Test it without starting a client: `TS6MOD_DRYRUN=1 launcher/ts6-mod` prints the command (a fake `flatpak` on `PATH` works for
  checking discovery).

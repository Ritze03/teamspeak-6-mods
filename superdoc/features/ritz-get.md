# ritz-get install

`install.sh` (repo root) makes the repo installable by ritz-get (spec v1, written by the ritz-get project). ritz-get clones the repo,
runs `./install.sh --install --yes` (cwd = clone, stdin closed) on install and every update, and `--remove --yes` to uninstall.
Run by hand: `./install.sh --install` / `--remove`.

## What it does

- `check_tools`: `gcc` and `make` (missing -> `missing:` lines, exit 3). Node >= 22 and the TeamSpeak client are runtime
  dependencies: only a `note:` line, never a failure.
- `build`: `make -C native OUT=../build/.libts6mod.so.new`, then `mv -f` to `build/libts6mod.so`.
  Why: a running client has the old library mapped via `LD_PRELOAD`; overwriting it in place would crash it, a rename keeps the old inode alive.
  `native/Makefile:OUT` defaults to `libts6mod.so`, so `make -C native` (dev builds, tests) is unchanged. `build/` is git-ignored;
  the static DSP lib (`native/dsp/libts6dsp.a`) and objects are covered by the existing `*.a` / `*.o` ignores.
- `install_files`: symlink `~/.local/bin/teamspeak-6-mods` -> `launcher/ts6-mod`. Nothing else is written outside the clone.
- The desktop entry `teamspeak-6-mods.desktop` is not installed by `install.sh`; ritz-get installs it on request and rewrites `Exec`/`Icon`/`Name`.

## Launcher

`launcher/ts6-mod` resolves the repo with `readlink -f "$0"`, so it works through the symlink. It loads `build/libts6mod.so` if present,
else `native/libts6mod.so` (rebuilding that one by `make -C native` when its sources are newer, as before).

## Files created outside the clone at run time (kept on remove)

`$XDG_CONFIG_HOME/ts6-mods/` (agc.json) and `$XDG_STATE_HOME/ts6-mods/` (ts6mod.log), written by the native module
(`native/ts6mod.c:init_paths`). `TS6MOD_PROFILE_DIR` has no default: it is only used when the user sets it.

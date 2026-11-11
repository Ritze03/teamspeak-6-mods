#!/usr/bin/env bash
# headless-sway.sh: a headless Sway compositor for TS6 test clients, so they never appear on (or touch) the user's desktop.
#   up | down | status | env | run -- CMD... | shot [file.png]
# HARD RULE: never Hyprland headless (crashes the user's main session). Sway only. See superdoc/features/test-rig.md "Headless Sway".
set -uo pipefail
# the real home, not $HOME: test clients run with HOME pointed into a profile dir
REALHOME=$(getent passwd "$(id -u)" | cut -d: -f6)
D=${TS6_SWAY_DIR:-$REALHOME/tmp/ts6-sway}
SOCK=$D/sway.sock
RT=${XDG_RUNTIME_DIR:-/run/user/$(id -u)}
mkdir -p "$D"

# sway's environment: nothing of the user's session leaks in (no nesting into Hyprland / X11)
swayenv() { env -u DISPLAY -u WAYLAND_DISPLAY -u HYPRLAND_INSTANCE_SIGNATURE -u WAYLAND_SOCKET -u I3SOCK \
  XDG_RUNTIME_DIR="$RT" SWAYSOCK="$SOCK" "$@"; }
msg() { SWAYSOCK=$SOCK swaymsg "$@"; }
alive() { [ -S "$SOCK" ] && msg -t get_version >/dev/null 2>&1; }
die() { echo "headless-sway: $*" >&2; exit 1; }
# pid of OUR sway: the process that owns the socket (never a pattern match on command lines)
xdisp() { cut -d" " -f1 "$D/display"; }
wl() { cut -d" " -f2 "$D/display"; }
swaypid() { ss -xlpH "src = $SOCK" 2>/dev/null | grep -o 'pid=[0-9]*' | head -1 | cut -d= -f2; }

cmd_up() {
  alive && { echo "headless-sway: already up" >&2; return 0; }
  cat > "$D/config" <<CFG
output HEADLESS-1 resolution 1920x1080 position 0 0
xwayland force
default_border none
focus_follows_mouse no
CFG
  rm -f "$SOCK" "$D/display"
  # WLR_RENDERER=pixman: software rendering, does not touch the GPU.
  ( swayenv WLR_BACKENDS=headless WLR_LIBINPUT_NO_DEVICES=1 WLR_RENDERER="${TS6_SWAY_RENDERER:-pixman}" \
      ccorral -- sway -c "$D/config" > "$D/sway.log" 2>&1 & ) >/dev/null 2>&1
  local i; for ((i = 0; i < 40; i++)); do alive && break; sleep 0.25; done
  alive || die "sway did not start (see $D/sway.log)"
  # DISPLAY (Xwayland) and WAYLAND_DISPLAY (auto-named socket): ask sway's own child environment
  msg exec "echo \$DISPLAY \$WAYLAND_DISPLAY > $D/display" >/dev/null
  for ((i = 0; i < 40; i++)); do [ -s "$D/display" ] && break; sleep 0.25; done
  [ -s "$D/display" ] || die "no DISPLAY from sway's Xwayland (see $D/sway.log)"
  echo "headless-sway: up (DISPLAY $(xdisp), WAYLAND_DISPLAY $(wl), SWAYSOCK $SOCK)" >&2
}
cmd_env() {
  alive || die "not up (run: $0 up)"
  printf 'export WAYLAND_DISPLAY=%s SWAYSOCK=%s DISPLAY=%s\nunset HYPRLAND_INSTANCE_SIGNATURE\n' "$(wl)" "$SOCK" "$(xdisp)"
}
cmd_run() {
  [ "${1:-}" = -- ] && shift
  [ $# -gt 0 ] || die "usage: run -- CMD..."
  alive || cmd_up || exit 1
  exec env -u HYPRLAND_INSTANCE_SIGNATURE WAYLAND_DISPLAY="$(wl)" SWAYSOCK="$SOCK" DISPLAY="$(xdisp)" "$@"
}
cmd_shot() {
  alive || die "not up"
  local f=${1:-$D/shot.png}
  WAYLAND_DISPLAY=$(wl) grim "$f" && echo "$f"
}
cmd_down() {
  local p; p=$(swaypid)
  alive && msg exit >/dev/null 2>&1
  if [ -n "$p" ]; then
    for _ in 1 2 3 4 5 6 7 8; do kill -0 "$p" 2>/dev/null || break; sleep 0.25; done
    kill -0 "$p" 2>/dev/null && kill "$p" 2>/dev/null
  fi
  rm -f "$SOCK" "$D/display"
  echo "headless-sway: down" >&2
}
case ${1:-} in
  up) cmd_up ;; down) cmd_down ;; env) cmd_env ;;
  status) if alive; then echo "up (DISPLAY $(xdisp), WAYLAND_DISPLAY $(wl))"; else echo down; exit 1; fi ;;
  run) shift; cmd_run "$@" ;; shot) shift; cmd_shot "$@" ;;
  *) echo "usage: headless-sway.sh up | down | status | env | run -- CMD... | shot [file.png]"; exit 2 ;;
esac

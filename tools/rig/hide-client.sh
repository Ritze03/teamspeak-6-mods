#!/usr/bin/env bash
# hide-client.sh <cdp-port>...: move the window of the isolated test client on each CDP port to the hidden Hyprland special
# workspace $TS6TEST_WORKSPACE (default special:ts6test), silently (focus untouched). Fallback for when the user's hyprland config
# has no windowrule for test clients (that rule moves the window from its first frame; this move happens after it appeared, so the
# window flashes on the desktop for a moment). No-op without Hyprland. Never touches the user's real client (matched by CDP port only).
# See superdoc/features/test-rig.md "Hidden test windows".
WS=${TS6TEST_WORKSPACE:-special:ts6test}
command -v hyprctl >/dev/null 2>&1 && hyprctl version >/dev/null 2>&1 || exit 0
find_window() { # find_window <pid> -> "<address> <workspace name>"
  hyprctl clients -j | node -e 'const p=+process.argv[1];let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{const c=JSON.parse(s).find(c=>c.pid===p);if(c)console.log(c.address+" "+c.workspace.name)})' "$1"
}
for port in "$@"; do
  addr=
  for ((i = 0; i < 60; i++)); do   # the window appears a few seconds after the process
    pid=$(pgrep -f -- "--remote-debugging-port=$port( |\$)" | head -1)
    [ -n "$pid" ] && addr=$(find_window "$pid") && [ -n "$addr" ] && break
    sleep 0.5
  done
  [ -n "$addr" ] || { echo "hide-client: no window for CDP port $port" >&2; continue; }
  case $addr in *" $WS") ;; *) hyprctl dispatch "hl.dsp.window.move({workspace=\"$WS\", follow=false, window=\"address:${addr%% *}\"})" >/dev/null ;; esac
done

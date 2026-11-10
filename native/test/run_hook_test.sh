#!/usr/bin/env bash
# Hook test without TeamSpeak: harness -> (preloaded dlsym hook) -> PipeWire null sink, recorded from its monitor.
# Phases of 4 s: AGC off, AGC on (default params), AGC off. Checks: off = bit-exact, on = peaks <= ceiling.
set -eu
here="$(cd "$(dirname "$0")" && pwd)"; native="$here/.."; work="${TS6MOD_TEST_DIR:-$HOME/tmp/ts6-agc/hooktest}"
mkdir -p "$work/cfg" "$work/state"; rm -f "$work/cfg/ts6-mods/agc.json"
make -C "$native" >/dev/null; cc -O2 -Wall -Wextra "$here/hook_harness.c" -o "$work/harness" -lm -ldl
port=38996; api=127.0.0.1:$port
mod=$(pactl load-module module-null-sink sink_name=ts6test channel_map=front-left,front-right rate=48000 format=s16le)
trap 'pactl unload-module '"$mod"' 2>/dev/null; kill $rec $h 2>/dev/null || true' EXIT
pw-record -P '{ stream.capture.sink=true }' --target ts6test --format s16 "$work/rec.wav" & rec=$!
sleep 1
XDG_CONFIG_HOME="$work/cfg" XDG_STATE_HOME="$work/state" TS6MOD_EXE="$work/harness" TS6MOD_PORT=$port \
  LD_PRELOAD="$native/libts6mod.so" "$work/harness" ts6test 14 & h=$!
sleep 4.2;  curl -s -X POST -d '{"enabled":true}' $api/config >/dev/null; echo "t=4: enabled"; sleep 0.2
curl -s $api/meters >/dev/null; sleep 3.6
curl -s $api/status; echo; curl -s $api/meters; echo
curl -s -X POST -d '{"enabled":false}' $api/config >/dev/null; echo "t=8: disabled"
wait $h; kill -INT $rec; wait $rec 2>/dev/null || true
python3 "$here/analyze_hook_test.py" "$work/rec.wav"

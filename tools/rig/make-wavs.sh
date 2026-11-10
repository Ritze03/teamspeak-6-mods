#!/usr/bin/env bash
# Generates the rig's test WAVs (48 kHz mono s16) into $RIG_DIR/wav (default ~/tmp/ts6-rig/wav). Needs only ffmpeg.
#   bursty.wav  speech-like: 0.9 s "words" every 1.5 s, 4.5 Hz syllable modulation, and a sharp 15 ms onset spike at the
#               start of every word (about -0.2 dBFS peak, ~15 dB above the body peaks) = TS's start-of-speech peaking
#   quiet.wav   same body without the spike, RMS scaled to about -35 dBFS
#   tone.wav    1 kHz sine at -20 dBFS, 8 s (calibration)
set -euo pipefail
D=${RIG_DIR:-$HOME/tmp/ts6-rig}/wav
mkdir -p "$D"
FF="ffmpeg -hide_banner -loglevel error -y"
SR=48000

# voice: 6 harmonics of a ~120 Hz fundamental with vibrato, plus a little noise (fricative-ish)
VOICE='((sin(2*PI*120*t+2*sin(2*PI*0.9*t))+0.5*sin(2*PI*240*t+4*sin(2*PI*0.9*t))+0.33*sin(2*PI*360*t+6*sin(2*PI*0.9*t))+0.25*sin(2*PI*480*t)+0.2*sin(2*PI*600*t)+0.16*sin(2*PI*720*t))/2.2+0.08*(random(0)-0.5))'
U='mod(t,1.5)'
GATE="between($U,0,0.9)*min(1,(0.9-$U)/0.05)"
SYL="(0.15+0.85*(0.5-0.5*cos(2*PI*4.5*$U)))"
BODY="$VOICE*$GATE*$SYL"
SPIKE="5*exp(-$U/0.005)*between($U,0,0.015)*sin(2*PI*900*t)"   # sharp onset transient

gen() { $FF -f lavfi -i "aevalsrc='$2':s=$SR:d=${3:-12}" -ac 1 -c:a pcm_s16le "$1"; }
stat() { ffmpeg -hide_banner -nostats -i "$1" -af volumedetect -f null - 2>&1 | sed -n "s/.*$2: \(-\?[0-9.]*\) dB.*/\1/p"; }
gain() { $FF -i "$1" -af "volume=${2}dB" -c:a pcm_s16le "$3"; }

gen "$D/bursty.wav" "0.2*($BODY+$SPIKE)"   # spike ~ -0.7 dBFS, body peaks ~ -13 dBFS
gen "$D/.quiet.raw.wav" "0.5*$BODY"
$FF -f lavfi -i "sine=f=1000:r=$SR:d=8" -af volume=-1.94dB -ac 1 -c:a pcm_s16le "$D/tone.wav"


# quiet: whole-file RMS -35 dBFS (pauses included; about -30 dBFS while a word is playing)
mv=$(stat "$D/.quiet.raw.wav" mean_volume)
gain "$D/.quiet.raw.wav" "$(echo "-35 - ($mv)" | bc -l)" "$D/quiet.wav"
rm -f "$D"/.*.raw.wav

for f in bursty quiet tone; do
  printf '%-8s peak %s dBFS  mean(RMS) %s dBFS\n' "$f" "$(stat "$D/$f.wav" max_volume)" "$(stat "$D/$f.wav" mean_volume)"
done

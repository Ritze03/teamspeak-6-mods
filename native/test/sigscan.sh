#!/usr/bin/env bash
# Scan the installed TeamSpeak binary for the per-speaker hook signature (playback_sender_data).
# Prints the match count and each file offset; exits 0 iff exactly one match (what the inline hook
# needs). Run by tools/test/run-all.mjs if present. See superdoc/features/per-speaker-hook.md.
#   TS6MOD_TS_BIN=/path/to/TeamSpeak native/test/sigscan.sh
set -eu
bin="${TS6MOD_TS_BIN:-/opt/teamspeak/TeamSpeak}"
if [ ! -r "$bin" ]; then echo "sigscan: cannot read $bin" >&2; exit 2; fi

python3 - "$bin" <<'PY'
import sys, re
binpath = sys.argv[1]
# Full signature: prologue (push rbp/r15/r14/r13/r12/rbx; sub rsp,0x1a8) + enough body to be unique:
#   mov [rsp+0x20],r8 ; mov rax,[rdi] ; movzx eax,[rax+0x3be4] ; cmp ecx,1
sig = bytes.fromhex('55 41 57 41 56 41 55 41 54 53 48 81 EC A8 01 00 00 '
                    '4C 89 44 24 20 48 8B 07 0F B6 80 E4 3B 00 00 83 F9 01'.replace(' ', ''))
data = open(binpath, 'rb').read()
offs = [m.start() for m in re.finditer(re.escape(sig), data)]
print('signature matches: %d' % len(offs))
for o in offs:
    print('  file offset 0x%x' % o)
sys.exit(0 if len(offs) == 1 else 1)
PY

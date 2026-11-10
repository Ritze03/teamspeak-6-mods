import sys, wave, numpy as np
w = wave.open(sys.argv[1]); n = w.getnchannels(); a = np.frombuffer(w.readframes(w.getnframes()), dtype='<i2').reshape(-1, n)[:, 0].astype(np.int64)
sr = w.getframerate(); assert sr == 48000
def gen(k):
    p = k % 48000
    t = k / 48000.0
    v = np.where(p < 38400, 0.0316 * np.sin(2*np.pi*300.0*t), 2.0 * np.sin(2*np.pi*200.0*t))
    return np.rint(np.clip(v, -1, 1) * 32767.0).astype(np.int64)
# align: the recording starts with digital silence; the first sample above 100 is where the reference gets above 100
nz = np.nonzero(np.abs(a) > 100)[0]; start = nz[0] if len(nz) else 0
g0 = np.nonzero(np.abs(gen(np.arange(400))) > 100)[0][0]; s0 = start - g0   # first audible sample of the reference
sig = a[s0:]; ref = gen(np.arange(len(sig)))
def seg(lo, hi): return sig[int(lo*sr):int(hi*sr)], ref[int(lo*sr):int(hi*sr)]
# time of the enable/disable events relative to the signal start is only known to about +-0.3 s: skip a guard band
for name, (lo, hi) in (('phase1 AGC off', (0.5, 3.8)), ('phase3 AGC off (after disable)', (9.0, 13.0))):
    x, r = seg(lo, hi); print('%-34s bit-exact: %s (max |diff| %d samples of %d)' % (name, bool((x == r).all()), np.abs(x - r).max(), len(x)))
x, r = seg(5.0, 7.6)
db = lambda v: 20*np.log10(max(v, 1) / 32768.0)
pk = np.abs(x).max()
print('phase2 AGC on : input peak %.2f dBFS -> output peak %.2f dBFS, ceiling -12.00: %s' % (db(np.abs(r).max()), db(pk), 'PASS' if db(pk) <= -11.99 else 'FAIL'))

"""Leave-one-animal-out choice of the somaHandRF counting threshold on Soma-corrected
counts. Reads pools/*.json written by extract.js (each counted ImageJ TIFF replayed through
the worker: "base" exactly as saved, "pool" with every candidate and its model score)."""
import sys, numpy as np
from common import load, score
V = [d for d in load('normal') if d['reviewed']]
TS = np.round(np.arange(0.15, 0.56, 0.01), 2)
cache = {(d['name'], t): score([c for c in d['pool'] if (c.get('modelScore') or 0) >= t], d['truth'], 10) for d in V for t in TS}
rows = []
for a in sorted({d['animal'] for d in V}):
    tr = [d for d in V if d['animal'] != a]; te = [d for d in V if d['animal'] == a]
    t = min(TS, key=lambda t: (np.mean([abs(cache[(d['name'], t)]['err']) for d in tr]), t)); print('without', a, '->', t)
    rows += [(cache[(d['name'], t)], cache[(d['name'], 0.52)]) for d in te]
for label, ss in (('0.52', [b for _, b in rows]), ('held out', [s for s, _ in rows])):
    tp = sum(s['tp'] for s in ss); fp = sum(s['fp'] for s in ss); fn = sum(s['fn'] for s in ss); e = np.array([s['err'] for s in ss])
    print(f'{label}: F1 {2*tp/(2*tp+fp+fn):.3f} P {tp/(tp+fp):.2f} R {tp/(tp+fn):.2f} mean|err| {100*np.abs(e).mean():.1f}% within10% {int((np.abs(e)<=.1).sum())}/{len(e)} bias {100*e.mean():+.1f}%')
print('all animals:', min(TS, key=lambda t: (np.mean([abs(cache[(d['name'], t)]['err']) for d in V]), t)))

"""Calibrate the threshold on ONE corrected image of an animal (same mode), score the animal's other images."""
import sys, os, json, numpy as np
sys.path.insert(0, 'cnn'); from common import score
RUN = sys.argv[1]
meta = [m for m in json.load(open('data/meta.json')) if m['reviewed']]
truth = {m['name']: [dict(x=float(x), y=float(y)) for x, y in np.load(f"data/{m['name']}.npz")['pts']] for m in meta}
P = {}
for a in '15 16 17 18 19'.split(): P.update(json.load(open(f'{RUN}/pred_{a}.json')))
TH = np.round(np.arange(0.05, 0.5, 0.005), 3)
cnt = {m['name']: np.array([sum(c[2] >= t for c in P[m['name']]) for t in TH]) for m in meta}
R = lambda m: 15 if m['mode'] == 'donut' else 10
for scope in ['animal+mode', 'animal']:
  for mode in ['normal', 'donut']:
    errs, f1s, n = [], [], 0
    for m in [m for m in meta if m['mode'] == mode]:
        cal = [c for c in meta if c['animal'] == m['animal'] and c['name'] != m['name'] and (scope == 'animal' or c['mode'] == mode)]
        if not cal: continue
        es, fs = [], []
        for c in cal:   # each possible calibration image, averaged
            ratio = cnt[c['name']] / len(truth[c['name']])
            t = TH[np.argmin(np.abs(ratio - 1))]
            s = score([dict(x=q[0], y=q[1]) for q in P[m['name']] if q[2] >= t], truth[m['name']], R(m)); es.append(abs(s['err'])); fs.append(s['F1'])
        errs.append(np.mean(es)); f1s.append(np.mean(fs)); n += 1
    e = np.array(errs); print(f'calibrated on one other {scope:11} image  {mode:6}  mean|err| {100*e.mean():4.1f}%  within10 {(e<=.1).sum()}/{n}  F1 {np.mean(f1s):.3f}')

"""Calibrate the threshold on one region of the image (hand count there), apply to the rest of the image."""
import sys, os, json, numpy as np
sys.path.insert(0, 'cnn'); from common import score
RUN = sys.argv[1]; NS = int(sys.argv[2]) if len(sys.argv) > 2 else 4
meta = [m for m in json.load(open('data/meta.json')) if m['reviewed']]
P = {}
for a in '15 16 17 18 19'.split():
    if os.path.exists(f'{RUN}/pred_{a}.json'): P.update(json.load(open(f'{RUN}/pred_{a}.json')))
TH = np.round(np.arange(0.05, 0.5, 0.005), 3)
res = {'normal': [], 'donut': []}
for m in meta:
    if m['name'] not in P: continue
    T = np.load(f"data/{m['name']}.npz")['pts']; p = np.array(P[m['name']]).reshape(-1, 3)
    # strips with equal numbers of hand dots, along x
    edges = np.quantile(T[:, 0], np.linspace(0, 1, NS + 1)); edges[0] = -1; edges[-1] = 1e9
    errs = []
    for k in range(NS):
        inT = (T[:, 0] > edges[k]) & (T[:, 0] <= edges[k + 1]); inP = (p[:, 0] > edges[k]) & (p[:, 0] <= edges[k + 1])
        cnt = np.array([(p[inP, 2] >= t).sum() for t in TH]); t = TH[np.argmin(np.abs(cnt - inT.sum()))]
        rest = ((p[~inP, 2] >= t).sum()); errs.append(rest / max(1, (~inT).sum()) - 1)
    res[m['mode']].append(np.mean(np.abs(errs)))
for k, v in res.items():
    v = np.array(v); print(f'{k:6} calibrated on 1/{NS} of the image: mean|err| on the rest {100*v.mean():4.1f}%  within10 {(v<=.1).sum()}/{len(v)}')

"""Score against the user's own decisions: dots added by hand, auto dots deleted outright, auto dots kept."""
import sys, os, json, numpy as np
from scipy.spatial import cKDTree
sys.path.insert(0, 'cnn'); from common import assign, score
RUN, POOLS = sys.argv[1], sys.argv[2]
meta = [m for m in json.load(open('data/meta.json')) if m['reviewed']]
P = {}
for a in '15 16 17 18 19'.split(): P.update(json.load(open(f'{RUN}/pred_{a}.json')))
B = json.load(open('baseline.json'))
TH = np.round(np.arange(0.05, 0.5, 0.0125), 4)
R = lambda m: 15 if m['mode'] == 'donut' else 10
truth = {m['name']: [dict(x=float(x), y=float(y)) for x, y in np.load(f"data/{m['name']}.npz")['pts']] for m in meta}
def mae(ms, t): return np.mean([abs(sum(c[2] >= t for c in P[m['name']]) / len(truth[m['name']]) - 1) for m in ms])
thr = {}
for m in meta:
    others = [o for o in meta if o['animal'] != m['animal'] and o['mode'] == m['mode']]
    thr[m['name']] = min(TH, key=lambda t: mae(others, t))
for mode in ['normal', 'donut']:
    agg = {k: [0, 0] for k in ['added', 'kept', 'deleted']}; aggB = {k: [0, 0] for k in agg}
    for m in [m for m in meta if m['mode'] == mode]:
        d = json.load(open(f"{POOLS}/{m['name']}.tif.json".replace('.tif.json', '.json'))) if os.path.exists(f"{POOLS}/{m['name']}.json") else None
        r = R(m); T = d['truth']; rem = set(d['removedAutoIds'])
        delpos = [c for c in d['savedAuto'] if c['id'] in rem]
        TT = np.array([[c['x'], c['y']] for c in T]); tt = cKDTree(TT)
        deleted = [c for c in delpos if not tt.query_ball_point([c['x'], c['y']], r)]   # deleted outright, not moved
        for lab, pred in (('net', [dict(x=c[0], y=c[1]) for c in P[m['name']] if c[2] >= thr[m['name']]]), ('now', [dict(x=x, y=y) for x, y in B[m['name']]])):
            A = agg if lab == 'net' else aggB
            i, j = assign(pred, T, r); hit = set(j.tolist()); unmatched = [pred[k] for k in set(range(len(pred))) - set(i.tolist())]
            for k, c in enumerate(T):
                key = 'kept' if c['source'] == 'auto' else 'added'; A[key][0] += k in hit; A[key][1] += 1
            if unmatched:
                tu = cKDTree(np.array([[c['x'], c['y']] for c in unmatched]))
                for c in deleted: A['deleted'][0] += bool(tu.query_ball_point([c['x'], c['y']], r)); A['deleted'][1] += 1
            else: A['deleted'][1] += len(deleted)
    print(mode)
    for k, lab in (('added', 'your hand-added cells found'), ('kept', 'kept auto cells found'), ('deleted', 'deleted spots still marked')):
        print(f'  {lab:30} network {agg[k][0]:5}/{agg[k][1]:<5} {100*agg[k][0]/max(1,agg[k][1]):5.1f}%   current tool {aggB[k][0]:5}/{aggB[k][1]:<5} {100*aggB[k][0]/max(1,aggB[k][1]):5.1f}%')

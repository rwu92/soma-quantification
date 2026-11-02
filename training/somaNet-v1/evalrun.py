import sys, os, json, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from common import score
DATA, RUN = sys.argv[1], sys.argv[2]
meta = [m for m in json.load(open(f'{DATA}/meta.json')) if m['reviewed']]
truth = {m['name']: [dict(x=float(x), y=float(y)) for x, y in np.load(f"{DATA}/{m['name']}.npz")['pts']] for m in meta}
preds = {a: json.load(open(f'{RUN}/pred_{a}.json')) for a in '15 16 17 18 19'.split() if os.path.exists(f'{RUN}/pred_{a}.json')}
TH = np.round(np.arange(0.05, 0.6, 0.0125), 3)
def dedupe(p, d):
    if d <= 0 or not len(p): return p
    p = sorted(p, key=lambda c: -c[2]); keep = []
    for c in p:
        if all((c[0] - k[0]) ** 2 + (c[1] - k[1]) ** 2 > d * d for k in keep): keep.append(c)
    return keep
def held(m, t, d=0):
    p = [c for c in preds[m['animal']][m['name']] if c[2] >= t]
    return [dict(x=c[0], y=c[1]) for c in dedupe(p, d)]
R = lambda m: 15 if m['mode'] == 'donut' else 10
def table(ms, t_of, d=0):
    S = [(m, score(held(m, t_of(m), d), truth[m['name']], R(m))) for m in ms]
    tp = sum(s['tp'] for _, s in S); fp = sum(s['fp'] for _, s in S); fn = sum(s['fn'] for _, s in S); e = np.array([s['err'] for _, s in S])
    return dict(F1=2 * tp / (2 * tp + fp + fn), P=tp / (tp + fp), R=tp / (tp + fn), mae=np.abs(e).mean(), bias=e.mean(), w10=int((np.abs(e) <= .1).sum()), n=len(S)), S
ms = [m for m in meta if m['animal'] in preds]
D = float(os.environ.get('DEDUPE', 0))
def pick(others, key):
    return min(TH, key=lambda t: table(others, lambda m: t, D)[0][key] if key == 'mae' else -table(others, lambda m: t, D)[0][key])
for crit in ['mae', 'F1']:
  for scope in ['all', 'mode']:
    th = {}
    for a in preds:
        for mode in ['normal', 'donut']:
            others = [m for m in ms if m['animal'] != a and (scope == 'all' or m['mode'] == mode)]
            th[(a, mode)] = pick(others, crit)
    for mode in ['normal', 'donut']:
        r, S = table([m for m in ms if m['mode'] == mode], lambda m: th[(m['animal'], m['mode'])], D)
        print(f'{crit:3} thr-from-{scope:4} {mode:6}  F1 {r["F1"]:.3f} P {r["P"]:.2f} R {r["R"]:.2f}  mean|err| {100*r["mae"]:4.1f}%  bias {100*r["bias"]:+5.1f}%  within10 {r["w10"]}/{r["n"]}')
if os.environ.get('V'):
    th = {a: pick([m for m in ms if m['animal'] != a], 'mae') for a in preds}
    for m in ms:
        s = score(held(m, th[m['animal']], D), truth[m['name']], R(m)); print(f"  {m['name']:24} hand {len(truth[m['name']]):4}  net {s['tp']+s['fp']:4}  err {100*s['err']:+5.1f}%  F1 {s['F1']:.3f}  thr {th[m['animal']]}")
# count head: keep the K strongest peaks, K = predicted count x a scale learned on the other animals
if any('#count' in k for a in preds for k in preds[a]):
    def topk(m, sc):
        p = sorted(preds[m['animal']][m['name']], key=lambda c: -c[2]); k = int(round(preds[m['animal']][m['name'] + '#count'] * sc))
        return [dict(x=c[0], y=c[1]) for c in dedupe(p, D)[:k]]
    def tab2(ms2, sc_of):
        S = [score(topk(m, sc_of(m)), truth[m['name']], R(m)) for m in ms2]
        tp = sum(s['tp'] for s in S); fp = sum(s['fp'] for s in S); fn = sum(s['fn'] for s in S); e = np.array([s['err'] for s in S])
        return dict(F1=2 * tp / (2 * tp + fp + fn), P=tp / (tp + fp), R=tp / (tp + fn), mae=np.abs(e).mean(), bias=e.mean(), w10=int((np.abs(e) <= .1).sum()), n=len(S)), S
    SC = np.round(np.arange(0.8, 1.25, 0.01), 2)
    for scope in ['all', 'mode']:
        sc = {}
        for a in preds:
            for mode in ['normal', 'donut']:
                others = [m for m in ms if m['animal'] != a and (scope == 'all' or m['mode'] == mode)]
                sc[(a, mode)] = min(SC, key=lambda s: tab2(others, lambda m: s)[0]['mae'])
        for mode in ['normal', 'donut']:
            r, S = tab2([m for m in ms if m['mode'] == mode], lambda m: sc[(m['animal'], m['mode'])])
            print(f'count-head scale-from-{scope:4} {mode:6}  F1 {r["F1"]:.3f} P {r["P"]:.2f} R {r["R"]:.2f}  mean|err| {100*r["mae"]:4.1f}%  bias {100*r["bias"]:+5.1f}%  within10 {r["w10"]}/{r["n"]}')
    if os.environ.get('V'):
        for m in ms:
            s = score(topk(m, sc[(m['animal'], m['mode'])]), truth[m['name']], R(m)); print(f"  {m['name']:24} hand {len(truth[m['name']]):4}  net {s['tp']+s['fp']:4}  err {100*s['err']:+5.1f}%  F1 {s['F1']:.3f}")

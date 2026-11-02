import json, glob, os, re, numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree
SP = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
def load(mode=None):
    out = []
    for f in sorted(glob.glob(f'{SP}/pools/*.json')):
        d = json.load(open(f))
        if mode and d['mode'] != mode: continue
        man = sum(1 for c in d['truth'] if c['source'] != 'auto'); d['reviewed'] = man + len(d['removedAutoIds']) > 0
        d['animal'] = re.match(r'(\d+)', d['name']).group(1); d['section'] = d['name'].split('__')[0]; d['chan'] = d['name'].split('__')[1]
        out.append(d)
    return out
def otsu(v, B=128):
    v = np.asarray(v, float)
    if len(v) < 20: return None
    lo, hi = v.min(), v.max()
    if not hi > lo: return None
    h = np.zeros(B); k = np.clip(np.floor((v - lo) / (hi - lo) * B).astype(int), 0, B - 1); np.add.at(h, k, 1)
    tot = len(v); s = (np.arange(B) * h).sum(); wB = sB = 0.0; best = -1; thr = 0
    for i in range(B):
        wB += h[i]
        if not wB: continue
        wF = tot - wB
        if not wF: break
        sB += i * h[i]; mB = sB / wB; mF = (s - sB) / wF; q = wB * wF * (mB - mF) ** 2
        if q > best: best = q; thr = i
    return lo + (thr + 1) / B * (hi - lo)
def page_output(cells, mode):
    """What Soma shows: in Donut mode the automatic brightness floor, as on the page."""
    if mode != 'donut': return cells
    v = [c.get('baseContrast', c['contrast']) if c.get('baseContrast') is not None else c['contrast'] for c in cells if not c.get('donutRescue') and not c.get('axonHeavy')]
    f = otsu(v); f = 0 if f is None else round(f)
    keep = lambda c: (c.get('reviewDonut') and (c.get('reviewScore') or 0) >= .45) or c.get('modelScore') is not None or not (f > 0 and c['contrast'] < f)
    return [c for c in cells if keep(c)]
def assign(a, b, r):
    """Optimal one-to-one matching of points a to b within r. Returns matched index arrays."""
    if not len(a) or not len(b): return np.array([], int), np.array([], int)
    A = np.array([[c['x'], c['y']] for c in a]); Bp = np.array([[c['x'], c['y']] for c in b])
    t = cKDTree(Bp); pairs = t.query_ball_point(A, r)
    rows = sorted({i for i, p in enumerate(pairs) if p}); cols = sorted({j for p in pairs for j in p})
    if not rows: return np.array([], int), np.array([], int)
    ri = {i: k for k, i in enumerate(rows)}; ci = {j: k for k, j in enumerate(cols)}
    cost = np.full((len(rows), len(cols)), 1e6)
    for i in rows:
        for j in pairs[i]: cost[ri[i], ci[j]] = np.hypot(*(A[i] - Bp[j]))
    rr, cc = linear_sum_assignment(cost); ok = cost[rr, cc] < 1e6
    return np.array(rows)[rr[ok]], np.array(cols)[cc[ok]]
def score(pred, truth, r):
    i, j = assign(pred, truth, r); tp = len(i); fp = len(pred) - tp; fn = len(truth) - tp
    return dict(tp=tp, fp=fp, fn=fn, P=tp / max(1, len(pred)), R=tp / max(1, len(truth)), F1=2 * tp / max(1, 2 * tp + fp + fn), err=len(pred) / max(1, len(truth)) - 1)

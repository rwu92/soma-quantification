"""Train, validate and export the hand-count soma classifier (somaHandRF v1).

Everything the browser implementation must reproduce is defined in features():
dimensionless / image-normalised values only, stable ranks, fixed neighbour radius.
"""
import json, glob, re, os, sys, hashlib, numpy as np, sklearn
from scipy.spatial import cKDTree
from scipy.optimize import linear_sum_assignment
from sklearn.ensemble import RandomForestClassifier

S = os.environ['SCR']; T = json.load(open(f'{S}/gt/truth.json'))
FEATS = ['areaN', 'widthN', 'minorN', 'majorN', 'aspect', 'zMeanN', 'zPeakN', 'contrastSigma', 'contrastBg', 'contrastOtsu',
         'contrastRank', 'zRank', 'areaRank', 'nnDistN', 'nnBrighter', 'neighbours16']
NEIGH_R = 16.0

def otsu(v, B=128):
    # identical to workerAutoFloorValue() in soma-detector-worker.js
    if len(v) < 20: return None
    lo, hi = float(v.min()), float(v.max())
    if not hi > lo: return None
    h = np.zeros(B)
    k = np.clip(np.floor((v - lo) / (hi - lo) * B).astype(int), 0, B - 1); np.add.at(h, k, 1)
    total = len(v); s = (np.arange(B) * h).sum(); wB = sB = 0.0; best = -1; thr = 0
    for i in range(B):
        wB += h[i]
        if not wB: continue
        wF = total - wB
        if not wF: break
        sB += i * h[i]; mB = sB / wB; mF = (s - sB) / wF; q = wB * wF * (mB - mF) ** 2
        if q > best: best = q; thr = i
    return lo + (thr + 1) / B * (hi - lo)

def rank(a):
    order = np.argsort(a, kind='stable'); r = np.empty(len(a)); r[order] = np.arange(len(a)); return r / max(len(a) - 1, 1)

def features(cells, dMin, snr):
    g = lambda key, d=0.0: np.array([c.get(key) if c.get(key) is not None else d for c in cells], float)
    xy = np.column_stack([g('x'), g('y')]); ct, sig, bg, z0, pk, area = g('contrast'), g('sigma', 1), g('bg', 1), g('z0'), g('peak'), g('area')
    n = len(cells)
    if n > 1:
        tree = cKDTree(xy); dd, ii = tree.query(xy, k=2); nn = dd[:, 1]; nb = (ct[ii[:, 1]] > ct).astype(float)
        neigh = np.array([len(x) - 1 for x in tree.query_ball_point(xy, NEIGH_R)], float)
    else:
        nn = np.full(n, np.inf); nb = np.zeros(n); neigh = np.zeros(n)
    f = otsu(ct); f = f if f is not None and f > 0 else (float(np.median(ct)) if n and np.median(ct) > 0 else 1.0)
    base = np.pi * (dMin / 2) ** 2
    return np.column_stack([area / base, g('width') / dMin, g('minor') / dMin, g('major') / dMin, g('aspect'), z0 / snr, pk / snr,
                            ct / np.maximum(sig, 1e-6), ct / np.maximum(bg, 1e-6), ct / f, rank(ct), rank(z0), rank(area), nn / dMin, nb, neigh])

def image_quality(cells, snr=None):
    """Label-free: median contrast of the brightest quarter of candidates / median local background of all candidates."""
    if not cells: return 0.0
    ct = np.array([c.get('contrast') or 0.0 for c in cells]); bg = np.array([c.get('bg') or 0.0 for c in cells])
    top = np.sort(ct)[::-1][:max(1, len(ct) // 4)]
    return float(np.median(top) / max(float(np.median(bg)), 1e-6))

res = {}
for f in sorted(glob.glob(f'{S}/pool2/snr1_*.json')): res.update(json.load(open(f)))
views = []
for sec in sorted(res, key=lambda k: [int(x) for x in re.findall(r'\d+', k)]):
    rec = res[sec]; meta = json.load(open(f'{S}/capgt/{sec}/meta.json')); runs = {r['params']['detectKey']: r['params'] for r in meta['runs']}
    slot = {f'c{int(re.search(r"_C(\d)\.tif$", fn).group(1))}': f'c{k}' for k, fn in enumerate(rec['file'])}
    for ch, pts in sorted(T['truth'].get(sec, {}).items()):
        if not pts or ch not in slot: continue
        v = rec['views'][slot[ch]]; p = runs[slot[ch]]
        if v['mode'] == 'axon': continue
        c = v['cells']; xy = np.array([[q['x'], q['y']] for q in c]); P = np.array(pts)
        d = np.sqrt(((xy[:, None] - P[None]) ** 2).sum(-1)); cost = np.where(d <= 8, d, 1e6); r, k = linear_sum_assignment(cost)
        lab = np.zeros(len(c), bool); lab[r[cost[r, k] < 1e6]] = True
        views.append(dict(sec=sec, ch=ch, animal=sec.split('-')[0], n=len(P), X=features(c, p['dMin'], p['snr']), y=lab,
                          q=image_quality(c, p['snr']), dMin=p['dMin'], snr=p['snr'], cells=c))

print('label-free image quality (brightest-quarter contrast / median background):')
for ch in ['c0', 'c1', 'c2']:
    qs = sorted(v['q'] for v in views if v['ch'] == ch); print(f'  {ch}: {" ".join(f"{q:.2f}" for q in qs)}')

CONFIGS = {'compact': dict(n_estimators=60, min_samples_leaf=40, max_depth=12), 'medium': dict(n_estimators=100, min_samples_leaf=30, max_depth=14)}

def choose_threshold(tr, cfg):
    X = np.vstack([v['X'] for v in tr]); y = np.concatenate([v['y'] for v in tr])
    rf = RandomForestClassifier(**cfg, max_features='sqrt', oob_score=True, bootstrap=True, n_jobs=-1, random_state=0).fit(X, y)
    oob = np.nan_to_num(rf.oob_decision_function_[:, 1]); best = None
    for t in np.round(np.arange(0.20, 0.81, 0.01), 2):
        off = 0; errs = []
        for v in tr: pv = oob[off:off + len(v['y'])]; off += len(v['y']); errs.append((pv >= t).sum() / v['n'] - 1)
        s = (float(np.mean(np.abs(errs))), float(t))
        if best is None or s < best: best = s
    return rf, best[1]

def f1(pairs):
    tp = sum((k & v['y']).sum() for v, k in pairs); fp = sum((k & ~v['y']).sum() for v, k in pairs); n = sum(v['n'] for v, _ in pairs)
    return 2 * tp / (2 * tp + fp + n - tp)

def validate(vs, cfg):
    out = []
    for a in sorted({v['animal'] for v in vs}):
        tr = [v for v in vs if v['animal'] != a]; te = [v for v in vs if v['animal'] == a]
        rf, t = choose_threshold(tr, cfg)
        for v in te:
            keep = rf.predict_proba(v['X'])[:, 1] >= t
            out.append(dict(sec=v['sec'], ch=v['ch'], animal=a, hand=v['n'], tool=int(keep.sum()), threshold=t, keep=keep, v=v))
    return out

def summarise(out):
    e = np.array([o['tool'] / o['hand'] - 1 for o in out])
    return dict(images=len(out), within5=int((np.abs(e) <= 0.05).sum()), within10=int((np.abs(e) <= 0.10).sum()), meanAbsErr=float(np.abs(e).mean()),
                medianAbsErr=float(np.median(np.abs(e))), worstAbsErr=float(np.abs(e).max()), bias=float(e.mean()), f1=float(f1([(o['v'], o['keep']) for o in out])),
                handTotal=int(sum(o['hand'] for o in out)), toolTotal=int(sum(o['tool'] for o in out)))

train_views = [v for v in views if v['ch'] in ('c1', 'c2')]
results = {}
for name, cfg in CONFIGS.items():
    out = validate(train_views, cfg); s = summarise(out); results[name] = (cfg, out, s)
    print(f'{name:8s} held-out: within5% {s["within5"]}/{s["images"]}  within10% {s["within10"]}  mean|err| {100*s["meanAbsErr"]:.1f}%  worst {100*s["worstAbsErr"]:.0f}%  bias {100*s["bias"]:+.1f}%  F1 {s["f1"]:.3f}')
name = 'compact' if results['compact'][2]['meanAbsErr'] <= results['medium'][2]['meanAbsErr'] + 0.005 else 'medium'
cfg, out, summary = results[name]
print('chosen config:', name, cfg)

# Final model: all C1 + C2 training images, threshold from out-of-bag predictions
rf, thr = choose_threshold(train_views, cfg)
def export_tree(est):
    t = est.tree_; val = t.value[:, 0, :]; p1 = val[:, 1] / np.maximum(val.sum(1), 1e-12)
    return {'l': t.children_left.tolist(), 'r': t.children_right.tolist(), 'f': t.feature.tolist(),
            't': [float(x) if f >= 0 else 0 for x, f in zip(t.threshold.tolist(), t.feature.tolist())], 'p': p1.tolist()}
trees = [export_tree(e) for e in rf.estimators_]
q_c12 = [v['q'] for v in train_views]
model = {
    'id': 'somaHandRF-v1', 'features': FEATS, 'threshold': thr, 'neighbourRadiusPx': NEIGH_R,
    'validatedDomain': {'pixelSizeUm': 1.25, 'dMinPx': 10, 'detectionMode': 'normal', 'singleChannelOnly': True,
                        'minImageQuality': round(float(min(q_c12)), 3), 'maxImageQuality': round(float(max(q_c12)), 3), 'imageQualityDefinition': 'median contrast of the brightest quarter of candidates divided by the median local background of all candidates'},
    'training': {'images': [f"{v['sec']} C={v['ch'][1]}" for v in train_views], 'handPoints': int(sum(v['n'] for v in train_views)),
                 'candidates': int(sum(len(v['y']) for v in train_views)), 'positives': int(sum(v['y'].sum() for v in train_views)),
                 'labelRule': 'candidate matched to a Fiji multi-point hand count within 8 px (optimal one-to-one assignment)',
                 'excluded': 'C=0 (all sections): low image quality; Axon-heavy views; A3-S5 (no points)',
                 'sklearn': sklearn.__version__, 'params': dict(cfg, max_features='sqrt', bootstrap=True, random_state=0),
                 'thresholdRule': 'minimise mean |count error| of out-of-bag predictions over training images'},
    'validation': {'scheme': 'leave-one-animal-out (A1, A2, A3); model and threshold refit without the held-out animal',
                   'heldOut': summary, 'perImage': [dict({k: o[k] for k in ('sec', 'ch', 'animal', 'hand', 'tool', 'threshold')}, quality=round(o['v']['q'], 3)) for o in out]},
    'trees': trees}
blob = json.dumps(model, separators=(',', ':'))
model['sha256'] = hashlib.sha256(blob.encode()).hexdigest()
os.makedirs(f'{S}/model', exist_ok=True)
json.dump(model, open(f'{S}/model/somaHandRF-v1.json', 'w'), separators=(',', ':'))
print(f'domain {model["validatedDomain"]}')
print(f'final threshold {thr}  trees {len(trees)}  nodes {sum(len(t["f"]) for t in trees)}  size {len(blob)/1e6:.2f} MB  minImageQuality {model["validatedDomain"]["minImageQuality"]}')

# Parity fixture: the browser implementation must reproduce these features and probabilities exactly
fx = []
for v in train_views[:2]:
    pv = rf.predict_proba(v['X'])[:, 1]
    fx.append({'sec': v['sec'], 'ch': v['ch'], 'dMin': v['dMin'], 'snr': v['snr'], 'cells': [{k: c.get(k) for k in ('x', 'y', 'area', 'width', 'minor', 'major', 'aspect', 'z0', 'peak', 'contrast', 'sigma', 'bg')} for c in v['cells']],
               'features': v['X'].tolist(), 'prob': pv.tolist(), 'kept': int((pv >= thr).sum()), 'quality': v['q']})
json.dump(fx, open(f'{S}/model/parity_fixture.json', 'w'))
# held-out predictions on C=0 for the record (not used for training or validation claims)
c0 = [v for v in views if v['ch'] == 'c0']
e0 = [((rf.predict_proba(v['X'])[:, 1] >= thr).sum() / v['n'] - 1, v['q']) for v in c0]
lo, hi = model['validatedDomain']['minImageQuality'], model['validatedDomain']['maxImageQuality']
print('C=0 with final model:', ' '.join(f'{100*e:+.0f}%(q={q:.2f},{"IN" if lo <= q <= hi else "out"})' for e, q in e0))

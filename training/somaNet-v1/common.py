"""One-to-one matching of predicted dots to hand dots (Hungarian assignment within r px) and scores."""
import numpy as np
from scipy.optimize import linear_sum_assignment
from scipy.spatial import cKDTree
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

import json, numpy as np, torch, torch.nn as nn, torch.nn.functional as F
DATA = None
LOCAL = False
def boxmean(a, r):
    """Mean over a (2r+1)^2 window, edges mirrored (numpy 'symmetric')."""
    p = np.pad(a.astype(np.float64), r + 1, mode='symmetric')
    c = p.cumsum(0).cumsum(1); k = 2 * r + 1
    s = c[k:, k:] - c[:-k, k:] - c[k:, :-k] + c[:-k, :-k]
    return (s / (k * k))[:a.shape[0], :a.shape[1]].astype(np.float32)
def prep(img):
    """uint16 full-res -> 2x mean-binned, 2 channels: fixed 12-bit scale and per-image robust scale."""
    h, w = img.shape; h2, w2 = h // 2, w // 2
    a = img[:h2 * 2, :w2 * 2].astype(np.float32).reshape(h2, 2, w2, 2).mean((1, 3))
    lo, hi = np.percentile(a, [1, 99.8]); r = np.clip((a - lo) / max(1, hi - lo), 0, 1.5)
    ch = [np.sqrt(a / 4095.0), r]
    if LOCAL:
        m = boxmean(a, 15); v = np.maximum(boxmean(a * a, 15) - m * m, 0)
        ch.append(np.clip((a - m) / np.sqrt(v + (0.02 * max(1, hi - lo)) ** 2), -3, 6) / 3)
    return np.stack(ch).astype(np.float32)
def heat(pts, h2, w2, sigma):
    hm = np.zeros((h2, w2), np.float32); R = int(3 * sigma) + 1
    yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    for x, y in pts / 2.0:
        cx, cy = int(round(x)), int(round(y)); fx, fy = x - cx, y - cy
        g = np.exp(-((xx - fx) ** 2 + (yy - fy) ** 2) / (2 * sigma ** 2))
        y0, y1, x0, x1 = cy - R, cy + R + 1, cx - R, cx + R + 1
        gy0, gx0 = max(0, -y0), max(0, -x0); y0c, x0c = max(0, y0), max(0, x0); y1c, x1c = min(h2, y1), min(w2, x1)
        if y1c <= y0c or x1c <= x0c: continue
        hm[y0c:y1c, x0c:x1c] = np.maximum(hm[y0c:y1c, x0c:x1c], g[gy0:gy0 + y1c - y0c, gx0:gx0 + x1c - x0c])
    return hm
BN = True
def block(i, o):
    n = (lambda c: nn.BatchNorm2d(c)) if BN else (lambda c: nn.Identity())
    return nn.Sequential(nn.Conv2d(i, o, 3, padding=1), n(o), nn.ReLU(inplace=True), nn.Conv2d(o, o, 3, padding=1), n(o), nn.ReLU(inplace=True))
class UNet(nn.Module):
    def __init__(s, cin=2, c=(8, 16, 32, 48), nout=1):
        super().__init__()
        s.e1, s.e2, s.e3, s.e4 = block(cin, c[0]), block(c[0], c[1]), block(c[1], c[2]), block(c[2], c[3])
        s.d3, s.d2, s.d1 = block(c[3] + c[2], c[2]), block(c[2] + c[1], c[1]), block(c[1] + c[0], c[0])
        s.out = nn.Conv2d(c[0], nout, 1); nn.init.constant_(s.out.bias, -4.0)
    def forward(s, x):
        e1 = s.e1(x); e2 = s.e2(F.max_pool2d(e1, 2)); e3 = s.e3(F.max_pool2d(e2, 2)); e4 = s.e4(F.max_pool2d(e3, 2))
        u = lambda t: F.interpolate(t, scale_factor=2, mode='nearest')
        d3 = s.d3(torch.cat([u(e4), e3], 1)); d2 = s.d2(torch.cat([u(d3), e2], 1)); d1 = s.d1(torch.cat([u(d2), e1], 1))
        return s.out(d1)
def focal(logit, gt, a=2, b=4):
    p = torch.sigmoid(logit).clamp(1e-4, 1 - 1e-4); pos = gt.ge(0.99).float(); neg = 1 - pos
    pl = -torch.log(p) * (1 - p) ** a * pos; nl = -torch.log(1 - p) * p ** a * (1 - gt) ** b * neg
    return (pl.sum() + nl.sum()) / pos.sum().clamp(min=1)
def peaks(prob, thr, k=3):
    """prob: HxW numpy at half res. Local maxima >= thr; returns full-res coords and scores (subpixel by 3x3 centroid)."""
    t = torch.from_numpy(prob)[None, None]; m = F.max_pool2d(t, k, 1, k // 2)
    ys, xs = np.nonzero(((t == m) & (t >= thr))[0, 0].numpy())
    out = []
    for y, x in zip(ys, xs):
        y0, y1, x0, x1 = max(0, y - 1), min(prob.shape[0], y + 2), max(0, x - 1), min(prob.shape[1], x + 2); w = prob[y0:y1, x0:x1]
        gy, gx = np.mgrid[y0:y1, x0:x1]; s = w.sum()
        out.append(((gx * w).sum() / s * 2 + 1, (gy * w).sum() / s * 2 + 1, prob[y, x]))  # bin centre -> full res
    return np.array(out).reshape(-1, 3)

def density(pts, h2, w2, sigma=2.0):
    """Each dot spread as a unit-mass gaussian at half res (sums to the count)."""
    d = heat(pts, h2, w2, sigma) * 0  # shape
    R = int(3 * sigma) + 1; yy, xx = np.mgrid[-R:R + 1, -R:R + 1]
    for x, y in pts / 2.0:
        cx, cy = int(round(x)), int(round(y)); g = np.exp(-((xx - (x - cx)) ** 2 + (yy - (y - cy)) ** 2) / (2 * sigma ** 2)); g /= g.sum()
        y0, x0 = cy - R, cx - R; gy0, gx0 = max(0, -y0), max(0, -x0); y0c, x0c = max(0, y0), max(0, x0); y1c, x1c = min(h2, cy + R + 1), min(w2, cx + R + 1)
        if y1c <= y0c or x1c <= x0c: continue
        d[y0c:y1c, x0c:x1c] += g[gy0:gy0 + y1c - y0c, gx0:gx0 + x1c - x0c]
    return d
def dens_loss(raw, gt):
    """raw: logits channel; predicted density = softplus(raw)/100. Count error on 8x8 blocks plus whole crop."""
    d = F.softplus(raw) / 100.0
    b = F.avg_pool2d(d, 8) * 64; bg = F.avg_pool2d(gt, 8) * 64
    return ((b - bg) ** 2).mean() * 10 + ((d.sum((2, 3)) - gt.sum((2, 3))).abs() / (gt.sum((2, 3)) + 3)).mean()

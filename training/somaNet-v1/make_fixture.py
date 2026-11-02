"""Parity fixture for tests: a 96x80 synthetic image -> network input (prep) and PyTorch probabilities.
usage: make_fixture.py NET.pt OUT.json  (env LOCAL, CH)"""
import sys, os, json, base64, numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import net as N; N.BN = False; N.LOCAL = os.environ.get('LOCAL', '0') == '1'
pt, out = sys.argv[1], sys.argv[2]; C = eval(os.environ.get('CH', '(8,16,32,48)'))
w, h = 96, 80; yy, xx = np.mgrid[0:h, 0:w]; a = 150 + 2 * xx + 3 * yy
for cx, cy, r, amp in [[25, 25, 7, 1900], [58, 24, 9, 2600], [42, 56, 6, 1500], [75, 58, 8, 900], [12, 66, 6, 500]]:
    a = a + amp * np.exp(-((xx - cx) ** 2 + (yy - cy) ** 2) / (2 * (r / 2.3) ** 2))
raw = np.clip(np.round(a), 0, 4095).astype(np.uint16)
cin = (3 if N.LOCAL else 2) + 1
m = N.UNet(cin, C, 1); m.load_state_dict(torch.load(pt, map_location='cpu')); m.eval()
res = {}
for donut in (0, 1):
    x = N.prep(raw); H, W = x.shape[1:]; x = np.concatenate([x, np.full((1, H, W), float(donut), np.float32)])
    with torch.no_grad(): p = torch.sigmoid(m(torch.from_numpy(x)[None]))[0, 0].numpy()   # 40x48: already multiples of 8
    res['donut' if donut else 'normal'] = dict(prob=base64.b64encode(p.astype('<f4').tobytes()).decode(), peaks=N.peaks(p, 0.05).tolist())
json.dump(dict(w=w, h=h, raw=base64.b64encode(raw.astype('<u2').tobytes()).decode(), **res), open(out, 'w'))
print(out, {k: len(v['peaks']) for k, v in res.items() if isinstance(v, dict)})

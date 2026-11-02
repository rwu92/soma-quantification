"""Average held-out probability maps of several runs. usage: ens.py OUT ANIMAL RUN:LOCAL:CH ..."""
import sys, os, json, numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import net as N; N.BN = False
OUT, hold = sys.argv[1], sys.argv[2]; specs = [s.split(':') for s in sys.argv[3:]]
nets = []
for run, loc, ch in specs:
    N.LOCAL = loc == '1'; m = N.UNet(4 if N.LOCAL else 3, eval(ch), 1).to('mps'); m.load_state_dict(torch.load(f'{run}/net_{hold}.pt')); m.eval(); nets.append((m, N.LOCAL))
res = {}
with torch.no_grad():
    for meta in json.load(open('data/meta.json')):
        if meta['animal'] != hold or not meta['reviewed']: continue
        z = np.load(f"data/{meta['name']}.npz"); acc = None
        for m, loc in nets:
            N.LOCAL = loc; x = N.prep(z['img']); H, W = x.shape[1:]
            x = np.concatenate([x, np.full((1, H, W), float(meta['mode'] == 'donut'), np.float32)])
            xt = torch.from_numpy(np.pad(x, ((0, 0), (0, (-H) % 8), (0, (-W) % 8)), mode='reflect'))[None].to('mps')
            p = torch.sigmoid(m(xt))[0, 0, :H, :W].cpu().numpy(); acc = p if acc is None else acc + p
        res[meta['name']] = N.peaks(acc / len(nets), 0.03).tolist()
os.makedirs(OUT, exist_ok=True); json.dump(res, open(f'{OUT}/pred_{hold}.json', 'w'))

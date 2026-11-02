import sys, os, json, time, numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import net as NETMOD; NETMOD.BN = os.environ.get('BN', '0') == '1'; NETMOD.LOCAL = os.environ.get('LOCAL', '0') == '1'
from net import *
DATA, OUT, hold = sys.argv[1], sys.argv[2], sys.argv[3]
iters = int(os.environ.get('ITERS', 3000)); sigma = float(os.environ.get('SIGMA', 1.5)); C = eval(os.environ.get('CH', '(8,16,32,48)'))
dev = 'mps'; torch.manual_seed(0); rng = np.random.default_rng(0)
meta = [m for m in json.load(open(f'{DATA}/meta.json')) if m['reviewed']]
DENS = os.environ.get('DENS') == '1'; MODEIN = os.environ.get('MODEIN') == '1'; LR = float(os.environ.get('LR', 2e-3)); NO = 2 if DENS else 1
X, Y, N = [], [], []
for m in meta:
    if m['animal'] == hold: continue
    z = np.load(f"{DATA}/{m['name']}.npz"); x = prep(z['img']); x = np.concatenate([x, np.full((1,) + x.shape[1:], float(m['mode'] == 'donut'), np.float32)]) if MODEIN else x; X.append(x); Y.append(np.stack([heat(z['pts'], *x.shape[1:], sigma)] + ([density(z['pts'], *x.shape[1:])] if DENS else []))); N.append(m['name'])
CIN = (3 if NETMOD.LOCAL else 2) + (1 if MODEIN else 0); net = UNet(CIN, C, NO).to(dev); opt = torch.optim.AdamW(net.parameters(), 2e-3, weight_decay=1e-4)
sched = torch.optim.lr_scheduler.OneCycleLR(opt, LR, total_steps=iters)
P, B = 160, 16; t0 = time.time()
for it in range(iters):
    xb, yb = [], []
    for _ in range(B):
        i = rng.integers(len(X)); x, y = X[i], Y[i]; H, W = y.shape[1:]
        r, c = rng.integers(H - P), rng.integers(W - P); xa = x[:, r:r + P, c:c + P]; ya = y[:, r:r + P, c:c + P]
        k = rng.integers(4); xa = np.rot90(xa, k, (1, 2)); ya = np.rot90(ya, k, (1, 2))
        if rng.random() < .5: xa = xa[:, :, ::-1]; ya = ya[:, :, ::-1]
        g = np.exp(rng.normal(0, .25)); xa = xa * np.array([g ** .5, g] + [1] * (CIN - 2), np.float32)[:, None, None]
        xb.append(xa.copy()); yb.append(ya.copy())
    xb = torch.from_numpy(np.stack(xb)).to(dev); yb = torch.from_numpy(np.stack(yb)).to(dev)
    o = net(xb); loss = focal(o[:, :1], yb[:, :1]) + (dens_loss(o[:, 1:2], yb[:, 1:2]) if DENS else 0); opt.zero_grad(); loss.backward(); torch.nn.utils.clip_grad_norm_(net.parameters(), 1.0); opt.step(); sched.step()
    if it % 500 == 0: print(hold, it, round(loss.item(), 3), round(time.time() - t0), flush=True)
os.makedirs(OUT, exist_ok=True); torch.save(net.state_dict(), f'{OUT}/net_{hold}.pt')
from predict import predict_all
predict_all(net, DATA, OUT, hold, dev, MODEIN)
print('done', hold, round(time.time() - t0))

import sys, os, json, numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import net as NETMOD; NETMOD.BN = os.environ.get('BN', '0') == '1'; NETMOD.LOCAL = os.environ.get('LOCAL', '0') == '1'
from net import *
def predict_all(net, DATA, OUT, hold, dev='mps', modein=False):
    net.eval(); res = {}
    with torch.no_grad():
        for m in json.load(open(f'{DATA}/meta.json')):
            z = np.load(f"{DATA}/{m['name']}.npz"); x = prep(z['img']); H, W = x.shape[1:]
            if modein: x = np.concatenate([x, np.full((1, H, W), float(m['mode'] == 'donut'), np.float32)])
            ph, pw = (-H) % 8, (-W) % 8; xt = torch.from_numpy(np.pad(x, ((0, 0), (0, ph), (0, pw)), mode='reflect'))[None].to(dev)
            o = net(xt)[0, :, :H, :W]; prob = torch.sigmoid(o[0]).cpu().numpy()
            res[m['name']] = peaks(prob, 0.03).tolist()
            if o.shape[0] > 1: res[m['name'] + '#count'] = float((F.softplus(o[1]) / 100).sum())
    json.dump(res, open(f'{OUT}/pred_{hold}.json', 'w'))
if __name__ == '__main__':
    DATA, OUT, hold = sys.argv[1:4]; C = eval(os.environ.get('CH', '(8,16,32,48)'))
    MI = os.environ.get('MODEIN') == '1'; net = UNet((3 if NETMOD.LOCAL else 2) + (1 if MI else 0), C, 2 if os.environ.get('DENS') == '1' else 1).to('mps'); net.load_state_dict(torch.load(f'{OUT}/net_{hold}.pt')); predict_all(net, DATA, OUT, hold, 'mps', MI)

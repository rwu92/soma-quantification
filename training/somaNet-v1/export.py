"""Fold batch norm into the convolutions and write the weights as JSON (base64 float32)."""
import sys, os, json, base64, hashlib, numpy as np, torch
sys.path.insert(0, os.path.dirname(__file__))
import net as NETMOD
LOCAL = os.environ.get('LOCAL', '0') == '1'
pt, out, cin = sys.argv[1], sys.argv[2], int(sys.argv[3]); bn = os.environ.get('BN', '0') == '1'
C = eval(os.environ.get('CH', '(8,16,32,48)')); NETMOD.BN = bn
m = NETMOD.UNet(cin, C, 1); m.load_state_dict(torch.load(pt, map_location='cpu')); m.eval()
b64 = lambda a: base64.b64encode(np.ascontiguousarray(a, np.float32).tobytes()).decode()
layers = {}
for blk in ['e1', 'e2', 'e3', 'e4', 'd3', 'd2', 'd1']:
    seq = getattr(m, blk)
    for tag, ci, ni in (('a', 0, 1), ('b', 3, 4)):
        conv = seq[ci]; w = conv.weight.detach().double().numpy(); b = conv.bias.detach().double().numpy()
        n = seq[ni]
        if isinstance(n, torch.nn.BatchNorm2d):
            s = n.weight.detach().double().numpy() / np.sqrt(n.running_var.double().numpy() + n.eps)
            w = w * s[:, None, None, None]; b = (b - n.running_mean.double().numpy()) * s + n.bias.detach().double().numpy()
        layers[f'{blk}.{tag}'] = dict(o=w.shape[0], i=w.shape[1], w=b64(w), b=b64(b))
w = m.out.weight.detach().numpy(); layers['out'] = dict(o=w.shape[0], i=w.shape[1], w=b64(w), b=b64(m.out.bias.detach().numpy()))
model = dict(id=os.environ.get('MID', 'somaNet-v1'), cin=cin, local=LOCAL, ch=list(C), validatedDomain=dict(dMinPx=10, pixelSizeUm=1.235, bitDepth=12), layers=layers)
s = json.dumps(model, separators=(',', ':')); model['sha256'] = hashlib.sha256(s.encode()).hexdigest()
json.dump(model, open(out, 'w'), separators=(',', ':')); print(out, len(s) // 1024, 'KB')

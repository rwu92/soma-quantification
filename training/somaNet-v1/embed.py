"""Write the somaNet weights and calibration into assets/soma-detector-worker.js.
usage: python3 embed.py NORMAL.json DONUT.json CALIBRATION.json
NORMAL/DONUT are export.py outputs; the calibration holds the per-mode thresholds."""
import sys, json, re, os, hashlib
normal, donut, cal = (json.load(open(f)) for f in sys.argv[1:4])
models = {k: {f: m[f] for f in ('cin', 'local', 'ch', 'layers')} for k, m in (('normal', normal), ('donut', donut))}
body = json.dumps(models, separators=(',', ':'), sort_keys=True)
net = dict(id='somaNet-v1', sha256=hashlib.sha256(body.encode()).hexdigest(), validatedDomain=normal['validatedDomain'], models=models)
p = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'assets', 'soma-detector-worker.js')
s = open(p).read()
for tag, obj in (('SOMA_NET_WEIGHTS', net), ('SOMA_NET_CALIBRATION', cal)):
    s, n = re.subn(r'/\*%s\*/.*?/\*END_%s\*/' % (tag, tag), lambda m: '/*%s*/%s/*END_%s*/' % (tag, json.dumps(obj, separators=(',', ':')), tag), s, flags=re.S)
    assert n == 1, tag
open(p, 'w').write(s); print('embedded', net['id'], net['sha256'][:12], cal)

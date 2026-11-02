import sys, os, glob, json, re, numpy as np
sys.path.insert(0, os.path.dirname(__file__))
from tiffpx import read_pixels
OLD = sys.argv[1]; OUT = sys.argv[2]
tifs = {os.path.basename(p): p for p in glob.glob(f'{OLD}/counted/**/*.tif', recursive=True)}
meta = []
for f in sorted(glob.glob(f'{OLD}/pools/*.json')):
    d = json.load(open(f)); n = d['name']
    man = sum(1 for c in d['truth'] if c['source'] != 'auto'); rev = man + len(d['removedAutoIds']) > 0
    img = read_pixels(tifs[n])
    pts = np.array([[c['x'], c['y']] for c in d['truth']], np.float32)
    np.savez_compressed(f'{OUT}/{n[:-4]}.npz', img=img.astype(np.uint16), pts=pts)
    meta.append(dict(name=n[:-4], mode=d['mode'], reviewed=rev, animal=re.match(r'(\d+)', n).group(1), n=len(pts), auto_kept=len(pts)-man))
    print(n, img.shape, img.min(), np.percentile(img, [50, 99, 99.9]).round(), len(pts))
json.dump(meta, open(f'{OUT}/meta.json', 'w'), indent=1)

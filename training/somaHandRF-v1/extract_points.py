"""Step 1: read Fiji multi-point counts from ImageJ TIFF overlays and write pixel-only per-section TIFFs.

usage: SCR=<work dir> python extract_points.py "<folder of counted TIFFs>"
Writes <work>/gt/truth.json and <work>/gt/tiffs/A<animal>-S<section>_C<channel>.tif
"""
import sys, os, glob, re, json, tifffile, roifile
D, OUT = sys.argv[1], os.path.join(os.environ['SCR'], 'gt')
os.makedirs(os.path.join(OUT, 'tiffs'), exist_ok=True)
truth, groups = {}, {}
for p in sorted(glob.glob(os.path.join(D, '*.tif'))):
    n = os.path.basename(p)
    m = re.search(r'NTSR1-Flp (\d+) ?\+,\+ (\d+)(?:-MaxIP)?\.nd2 - C=(\d)', n)
    if not m: continue
    key, ch = f'A{m.group(1)}-S{m.group(2)}', int(m.group(3))
    with tifffile.TiffFile(p) as t:
        img = t.pages[0].asarray(); ij = t.imagej_metadata or {}
        items = []
        for k in ('Overlays', 'ROI'):
            v = ij.get(k)
            if v is not None: items += v if isinstance(v, list) else [v]
        pts = []
        for b in items:
            r = roifile.ImagejRoi.frombytes(b)
            if r.roitype.name == 'POINT': pts += [[float(x), float(y)] for x, y in r.coordinates()]
    groups.setdefault(key, {})[ch] = dict(file=n, shape=img.shape, nPoints=len(pts))
    if pts: truth.setdefault(key, {})[f'c{ch}'] = pts
    tifffile.imwrite(os.path.join(OUT, 'tiffs', f'{key}_C{ch}.tif'), img)
json.dump({'groups': groups, 'truth': truth}, open(os.path.join(OUT, 'truth.json'), 'w'))
print(len(truth), 'sections with points')

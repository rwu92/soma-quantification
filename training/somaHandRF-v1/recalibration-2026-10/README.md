# somaHandRF v1 recalibration (2026-10)

Moves the counting threshold from 0.52 to 0.27 (`SOMA_HAND_RF_CALIBRATION` in `assets/soma-detector-worker.js`);
the trees are unchanged. Inputs: Soma ImageJ TIFF exports ("ImageJ TIFF · all") that were counted by correcting
Soma's output; each holds the analysed pixels and the saved analysis (cells kept, removed and added by hand, run
parameters). Images with no hand edits are treated as not reviewed and left out. Research data are not included.

1. `extract.js <tif> <out.json> <worker.js> <pool-worker.js>` replays one TIFF through the worker twice: exactly as
   saved ("base", which reproduces the saved candidate count) and as an open pool ("pool"). The pool worker is the
   app's worker with `poolAll` patched in so that classifier and legacy-forest decisions are kept as scores rather
   than applied (`make_pool_worker.py <worker.js> <out.js>` makes it). `runall.js` runs a list, N at a time.
2. `calibrate.py` (with `common.py`) chooses the threshold leaving each animal out in turn and reports held-out
   count error, precision, recall and F1 (cells matched to hand dots within 10 px, one to one).

Result: mean |count error| 22.1% -> 9.4%, within 10% on 3 -> 13 of 19 images, bias -22% -> +1%; F1 0.874 -> 0.864.
Donut mode was examined the same way (13 images): a random forest or boosted trees on the detector's candidates,
with or without ring-shape measurements from the pixels and duplicate suppression, did not beat the current rules
held out by animal (F1 0.80-0.815 vs 0.813), and the automatic floor is already at its best setting.

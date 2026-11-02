# somaHandRF v1 — training and validation pipeline

Reproduces `docs/models/somaHandRF-v1.*` and the `SOMA_HAND_RF` constant embedded in
`assets/soma-detector-worker.js`. Hand-count images are research data and are not included.

Requirements: Python 3 with numpy, scipy, scikit-learn 1.9.1, tifffile, roifile; Node 22 with puppeteer-core;
Google Chrome. Set `SCR` to a working directory.

1. `extract_points.py "<counted TIFF folder>"` — Fiji multi-point overlays -> `gt/truth.json`; pixel-only TIFFs named
   `A<animal>-S<section>_C<channel>.tif` so the app loads each section as one multichannel image.
2. `capture_gt.js` — drives the app in headless Chrome (pixel size 1.25 µm/px), runs "Analyse section" and records the
   exact detector request for every view plus the decoded pixels (`APP_ROOT`, `OUT_DIR=$SCR/capgt`, `PX_UM`, `FILES`).
3. `replay.js` — replays those requests through the worker in Node. Candidate pool for training:
   `CAP_DIR=$SCR/capgt SINGLES_ONLY=1 REBUILD_GUIDES=1 FILTERS_OPEN=1 node replay.js assets/soma-detector-worker.js new $SCR/pool2/snr1_1.json`
   (area and width limits disabled; fibre screening and elongation limit on). `train_final.py` reads `$SCR/pool2/snr1_*.json`
   and `$SCR/capgt/*/meta.json`, and writes `$SCR/model/`.
4. `train_final.py` — labels candidates by optimal one-to-one matching to hand points (<= 8 px), trains on C=1/C=2,
   validates leave-one-animal-out (model and threshold refit per fold), trains the final model, chooses the threshold from
   out-of-bag predictions, and exports the model, validation record and parity fixture.
5. `make_card.py <out.md>` — writes the model card from the exported record.

`tests/test_model_parity.js` checks that the browser implementation reproduces scikit-learn's probabilities and kept
count on a recorded image (`tests/fixtures/somaHandRF-v1-parity.json`).

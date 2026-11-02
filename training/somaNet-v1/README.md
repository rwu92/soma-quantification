# somaNet v1 training

Builds the cell-centre networks embedded in `assets/soma-detector-worker.js` (see
`docs/models/somaNet-v1.card.md`). Research data are not included. Needs Python with torch, numpy and scipy
(an Apple-silicon GPU is used through `mps`).

1. Extract each hand-corrected Soma TIFF with `../somaHandRF-v1/recalibration-2026-10/extract.js` (gives the
   saved analysis: final dots, removed auto dots, mode). `prep.py <dir with pools/ and counted/> <data dir>` then
   writes one `.npz` per view (pixels and final dots) and `meta.json` (mode, animal, reviewed = has hand edits).
2. `loao.sh RUN` trains one network per held-out animal with `train.py` (`net.py`: U-Net, input preparation,
   heat-map targets, focal loss, peak finding) and writes held-out dots per animal. Settings by environment:
   - Normal model: `LOCAL=1 MODEIN=1 BN=0 LR=1e-3 ITERS=6000 CH="(12,24,48,64)"`
   - Donut model: `LOCAL=0 MODEIN=1 BN=0 LR=1e-3 ITERS=6000 CH="(8,16,32,48)"`
3. `evalrun.py <data> RUN` scores the held-out dots (threshold chosen on the other animals); `decisions.py RUN
   <pools>` scores them against the user's own edits (cells added, auto dots deleted); `calib_sim.py` and
   `region_sim.py` test calibrating on another view of the same animal or on part of the same image; `ens.py`
   averages networks.
4. Final networks: `train.py <data> runs/final_normal all` (and `final_donut`) with the settings above;
   `export.py NET.pt OUT.json CIN` folds the weights into JSON; the threshold is the one giving zero count bias on
   the training views. `embed.py NORMAL.json DONUT.json CALIBRATION.json` writes both into the worker, and
   `make_fixture.py` makes `tests/fixtures/somaNet-v1-parity.json` (merge the Normal model's `normal` and the Donut
   model's `donut` entries).

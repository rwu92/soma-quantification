# somaNet v1 — model card

Cell-centre networks used by Soma Quantification (`assets/soma-detector-worker.js`, `SOMA_NET`), the default
cell classifier ("Cell-centre network") for single-channel Normal and Donut views. Merged views and Axon-heavy
keep their own rules. Validation record: `docs/models/somaNet-v1.validation.json`. Training code:
`training/somaNet-v1/`.

## What it does

Two small U-Nets, one for Normal views and one for Donut views, each read the analysed channel binned 2x2 and
output, for every 2x2 block, the probability that the user would put a dot there. Cells are the local maxima
(3x3 blocks) at or above the calibrated threshold, placed by the centroid of the 3x3 neighbourhood. Each centre
takes the size and brightness measurements of the nearest unused detector candidate within 0.6 x the minimum
diameter; a centre with none is measured in a disc of the minimum diameter against the local background model.
Cells carry `modelScore`, so the automatic brightness floor does not drop them; a floor set by hand does (with
"Apply brightness floor: All modes").

| | Normal | Donut |
|---|---|---|
| Inputs | sqrt(value / 4095); value scaled to the image's 1-99.8 percentiles; local contrast (31 x 31 bins); view flag | sqrt(value / 4095); 1-99.8 percentile scale; view flag |
| Channels per level | 12, 24, 48, 64 | 8, 16, 32, 48 |
| Threshold | **0.2025** | **0.185** |

Runs on the GPU with WebGPU (about 0.5-1 s for a 4000 x 1800 image); without WebGPU the same arithmetic runs in
JavaScript (about a minute). Both give the same cells as PyTorch (checked to 1e-5 in the tests and on full images in
the browser: 484 and 463 cells, identical to Python).

## Training data

Hand-corrected Soma ImageJ TIFF exports of one tissue preparation (a fluorescent reporter line; five animals), counted by
correcting Soma's output: 19 Normal views (FITC, Cy5, CY3; 7,952 dots) and 13 Donut views (Cy5; 5,297 dots).
Views without hand edits were treated as not reviewed and left out. Target: a Gaussian (sigma 1.5 bins) at each
final dot; CenterNet focal loss; 6,000 steps of 16 random 160 x 160 crops with rotations, flips and brightness
changes. Pixel size 1.235 um, 12-bit camera; minimum diameter 10 px. Outside that (minimum diameter not 9-11 px)
the run is flagged as not validated.

## Validation (leave one animal out)

Each animal's views were counted by networks trained on the other four, the threshold chosen on those four.
Dots matched one to one within 10 px (Normal) or 15 px (Donut).

| | Mean count error | Within 10% | Bias | F1 | Precision | Recall |
|---|---|---|---|---|---|---|
| Normal, somaNet | **7.4%** | 14/19 | -3.2% | 0.861 | 0.87 | 0.85 |
| Normal, somaHandRF v1 at 0.27 | 9.4% | 13/19 | +0.7% | 0.864 | 0.86 | 0.87 |
| Donut, somaNet | **12.5%** | 6/13 | +3.2% | 0.793 | 0.78 | 0.80 |
| Donut, rules + automatic floor | 14.0% | 5/13 | -1.9% | 0.813 | 0.82 | 0.81 |

F1 favours the old tools here: about 70% of the final Donut dots are dots of the old tool that the user kept. Against
the user's own decisions (held out):

| | Cells the user added by hand, found | Spots the user deleted, still marked |
|---|---|---|
| Normal, somaNet / old | 63% / 43% | 1 of 11 / 11 of 11 |
| Donut, somaNet / old | 75% / 34% | 118 of 410 / 410 of 410 |

## Limits

- The remaining error varies from image to image and from region to region within an image, not by animal:
  calibrating the threshold on another corrected view of the same animal, or on one corrected region of the same
  image, did not reduce it (Normal 11.8% and 9-11%). The networks reach about 7% (Normal) and 11% (Donut) even on
  the images they were trained on, which puts the limit at how consistently cells are called.
- Faint cells in dim patches of otherwise bright tissue are the most common misses.
- Trained on one prep, one microscope and 12-bit data. Other stains, objectives or bit depths need checking against
  hand counts before the counts are trusted.
- The final networks (trained on all five animals) were calibrated to zero count bias on the training views; the
  leave-one-animal-out networks showed the same bias on held-out and on training views (Donut +1.7% / +1.9%,
  Normal -1.5% / -0.6%).

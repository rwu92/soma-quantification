# Model card: somaHandRF v1

Soma classifier used by Soma Quantification (`assets/soma-detector-worker.js`, `SOMA_HAND_RF`).
Model SHA-256: `90241fcc6abba35a2f28e69ed097e3e70d5e29876fcc3f2898ff430ef145a41c`

## What it does
For single-channel Normal-mode analyses, every candidate the detector keeps with the **area and width limits
disabled** (fibre screening and the elongation limit still applied) is scored by a random forest. Candidates with
probability >= **0.27** are counted (0.52 when trained; recalibrated in 2026-10, see below). The classifier replaces the area and width limits and the automatic
brightness floor for those analyses. Merges/colocalisation, Donut and Axon-heavy analyses use the rule-based filters
and are **not** covered by this validation.

## Inputs (16 features, no raw camera intensity)
`areaN`, `widthN`, `minorN`, `majorN`, `aspect`, `zMeanN`, `zPeakN`, `contrastSigma`, `contrastBg`, `contrastOtsu`, `contrastRank`, `zRank`, `areaRank`, `nnDistN`, `nnBrighter`, `neighbours16`.
Sizes are divided by the minimum soma diameter (px); signal by the detection threshold, local noise or local
background; three features are within-image ranks; neighbour features use a 16 px radius.

## Training data
- Images: 26 single-channel images (C=1 and C=2) from 15 sections of animals 1, 2 and 3:
  A1-S2 C=1, A1-S2 C=2, A1-S3 C=1, A1-S3 C=2, A1-S4 C=1, A1-S4 C=2, A1-S5 C=1, A1-S5 C=2, A1-S6 C=1, A1-S6 C=2, A2-S1 C=1, A2-S1 C=2, A2-S2 C=1, A2-S2 C=2, A2-S3 C=1, A2-S3 C=2, A2-S5 C=1, A2-S5 C=2, A2-S6 C=1, A2-S6 C=2, A3-S1 C=1, A3-S1 C=2, A3-S2 C=2, A3-S3 C=2, A3-S4 C=1, A3-S4 C=2.
- Labels: candidate matched to a Fiji multi-point hand count within 8 px (optimal one-to-one assignment). 7045 hand points, 15898 candidates, 6674 positives.
- Excluded: C=0 (all sections): low image quality; Axon-heavy views; A3-S5 (no points).
- Hand counts: Fiji multi-point, on max projections (C=1 and C=2), made by more than one person.
- scikit-learn 1.9.1; parameters `{"n_estimators": 60, "min_samples_leaf": 40, "max_depth": 12, "max_features": "sqrt", "bootstrap": true, "random_state": 0}`.
- Threshold rule: minimise mean |count error| of out-of-bag predictions over training images.
- Reproduce: `train_final.py` (training/validation/export) and `make_card.py` (this card).

## Validation
leave-one-animal-out (A1, A2, A3); model and threshold refit without the held-out animal. Every number below is for images from the animal the model **and** threshold were not fitted on.

| Metric | Value |
|---|---|
| Held-out images | 26 |
| Within ±5% of hand count | 8 |
| Within ±10% | 14 |
| Mean absolute count error | 10.2% |
| Median absolute count error | 9.8% |
| Worst image | 35% |
| Mean bias | -1.1% |
| Cell-level F1 (8 px, one-to-one) | 0.845 |
| Total hand / tool | 7045 / 6863 |

| Section | Channel | Held-out animal | Hand | Tool | Error | Image quality |
|---|---|---|---|---|---|---|
| A1-S2 | C=1 | A1 | 241 | 301 | +25% | 7.25 |
| A1-S2 | C=2 | A1 | 261 | 266 | +2% | 10.43 |
| A1-S3 | C=1 | A1 | 401 | 355 | -11% | 5.86 |
| A1-S3 | C=2 | A1 | 263 | 233 | -11% | 8.97 |
| A1-S4 | C=1 | A1 | 350 | 388 | +11% | 5.79 |
| A1-S4 | C=2 | A1 | 299 | 273 | -9% | 9.14 |
| A1-S5 | C=1 | A1 | 398 | 376 | -6% | 7.58 |
| A1-S5 | C=2 | A1 | 197 | 202 | +3% | 8.87 |
| A1-S6 | C=1 | A1 | 282 | 222 | -21% | 11.26 |
| A1-S6 | C=2 | A1 | 191 | 164 | -14% | 12.30 |
| A2-S1 | C=1 | A2 | 483 | 424 | -12% | 5.35 |
| A2-S1 | C=2 | A2 | 304 | 254 | -16% | 8.55 |
| A2-S2 | C=1 | A2 | 189 | 190 | +1% | 12.08 |
| A2-S2 | C=2 | A2 | 138 | 141 | +2% | 12.38 |
| A2-S3 | C=1 | A2 | 382 | 419 | +10% | 5.55 |
| A2-S3 | C=2 | A2 | 273 | 230 | -16% | 8.20 |
| A2-S5 | C=1 | A2 | 233 | 256 | +10% | 12.89 |
| A2-S5 | C=2 | A2 | 148 | 154 | +4% | 12.25 |
| A2-S6 | C=1 | A2 | 315 | 276 | -12% | 10.22 |
| A2-S6 | C=2 | A2 | 185 | 186 | +1% | 10.57 |
| A3-S1 | C=1 | A3 | 221 | 299 | +35% | 5.77 |
| A3-S1 | C=2 | A3 | 144 | 151 | +5% | 9.35 |
| A3-S2 | C=2 | A3 | 259 | 240 | -7% | 6.91 |
| A3-S3 | C=2 | A3 | 171 | 191 | +12% | 9.30 |
| A3-S4 | C=1 | A3 | 433 | 392 | -9% | 6.95 |
| A3-S4 | C=2 | A3 | 284 | 280 | -1% | 8.49 |

## Validated domain
- Pixel size 1.25 µm/px, minimum soma diameter 10 px (±1 px), Normal mode, single channel.
- Image quality = median contrast of the brightest quarter of candidates divided by the median local background of all candidates; validated range 8.11–57.03 (the 2026-10 recalibration images; the original training images spanned 5.348–12.89).
  Analyses outside it are labelled "OUTSIDE validated range" in the app and `insideValidatedRange: false` in the run JSON.

## Recalibration (2026-10)
The trees are unchanged; only the counting threshold moved, from 0.52 to **0.27** (`SOMA_HAND_RF_CALIBRATION` in the worker).
19 single-channel Normal images from five more animals (Cy5 and FITC; pixel size 1.235 µm; image quality 8.1-57)
were counted in Soma by correcting its output (1,845 cells added, 90 removed; 94% of removals were dots moved, not cells rejected).
At 0.52 the tool found 22% too few cells on average (3 of 19 images within 10%), on images inside the old quality range as
well as outside it: these counts are consistently more liberal than the training counts. Choosing the threshold on four
animals and testing on the fifth, in turn (chosen 0.26-0.31):

| | mean \|count error\| | median | within 10% | bias | precision | recall | F1 |
|---|---|---|---|---|---|---|---|
| 0.52 | 22.1% | 20.1% | 3/19 | -22.1% | 1.00 | 0.78 | 0.874 |
| 0.27 (held out) | 9.4% | 7.7% | 13/19 | +0.7% | 0.86 | 0.87 | 0.864 |

Cells matched to hand dots within 10 px. The validated image-quality range is now that of these images, 8.11-57.03.
A retrained model (with the old score as an input) and ring-shape measurements did no better than the new threshold.

## Known limitations
- The hand counts were made by more than one person. Count agreement is bounded by the consistency of the hand counts.
- C=0 excluded from training and validation: weak cell-to-background contrast; 12 of 13 C=0 images fall outside the validated quality range.
- Not validated for Donut or Axon-heavy mode, colocalisation counts, other markers, magnifications or pixel sizes.
- About 7% of hand-counted cells never became detector candidates; the classifier cannot recover those.

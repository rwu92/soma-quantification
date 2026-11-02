# Soma Quantification: methods

This document describes how Soma Quantification (version 1.0.0) finds, classifies and counts somata. The
interface asks only for the pixel size; every other setting is fixed or set automatically. Every value used
in an analysis is written to that analysis's run record (`*_run.json`), and that record is what to report.

1. [Image input](#1-image-input)
2. [Tissue and background](#2-tissue-and-background)
3. [Candidate somata](#3-candidate-somata)
4. [Classification](#4-classification)
5. [Detection modes](#5-detection-modes)
6. [Colocalisation (merged channels)](#6-colocalisation-merged-channels)
7. [Hand correction](#7-hand-correction)
8. [Regions](#8-regions)
9. [Outputs and provenance](#9-outputs-and-provenance)
10. [Validation and limitations](#10-validation-and-limitations)
11. [Draft methods paragraph](#11-draft-methods-paragraph)

## 1. Image input

- **ND2** files are read with the `nd2` Python package (0.11.3) and numpy (2.4.6) running in the browser
  through Pyodide 314.0.6 (Python 3.14.2). Channel names and pixel size come from the file metadata.
  The points of a multipoint file can be opened as separate images.
- **Z stacks** are reduced to a maximum-intensity projection over all planes or over planes the user
  selects. Optionally the planes are first lined up with the middle plane:
  - shifts are found by phase correlation in overlapping 256-pixel squares and interpolated between them
  - planes are moved by whole pixels, never resampled, so intensities stay as recorded
- **TIFF** (8-, 16- or 32-bit) and **PNG/JPEG** are read directly, without a pixel size (see section 3).
  Files differing only by a channel tag
  (`_C1`, `_ch2`, …) form the channels of one image; an RGB file is split into three channels.
- Analysis always uses the full native resolution and the original pixel values. A reduced-resolution
  copy may be used for display only. Positions are reported in native pixels and, when the pixel size is
  known, in micrometres.

## 2. Tissue and background

- **Tissue mask.** Empty slide is separated from tissue so that detection is not attempted on bare slide.
  Bare slide is uniform rather than black. A background window straddling the tissue edge would
  underestimate the local noise and turn faint texture at the edge into false detections. Nothing is
  counted outside the tissue or within an **edge margin** (default 48 px) of it.
- **Local background** is the 10th percentile of intensities in a window of radius 3 × the largest soma
  diameter, computed on a subsampled grid and interpolated.
- **Local noise** is 1.4826 × the median absolute deviation of the background-subtracted image, in
  tiles of 6 × the largest soma diameter, with a lower bound of 0.45 × the typical tile value.
- Each pixel then has a **z-score**: (intensity − local background) / local noise.

## 3. Candidate somata

Expected soma size is set from the pixel size: **smallest** and **largest soma diameter** 12 and 35 µm,
**narrowest soma** 9 µm, converted to pixels. The pixel size is read from ND2 metadata and from TIFFs
exported by this tool; it cannot be entered by hand. Images without one are analysed with 16 and 44 px,
and 8 px. That is outside the network's validated range (smallest diameter 9–11 px), which the run
record flags.

1. **Signal mask:** pixels with z above the **signal threshold** (default 4.0).
2. **Saturated somata:** pixels at the image's maximum value (within 0.1%) inside tissue are added to the
   mask when they make up less than 5% of the tissue, i.e. when saturation means a bright cell rather than
   an over-exposed channel.
3. **Soma-width filter:** a morphological opening of radius 0.375 × the **narrowest soma** (default 8 px)
   removes processes thinner than a soma.
4. **Fibre screening:** before any splitting, whole connected structures that are long, of nearly
   constant width and narrow (fibre bundles) are discarded. Splitting them first would yield round
   fragments that pass per-fragment shape tests.
5. **Splitting touching somata:** cell centres (seeds) are local maxima at least **clump splitting** ×
   smallest diameter apart (default 0.72 × 16 px). They come from two sources:
   - the smoothed distance transform of the mask
   - a difference-of-Gaussians blob filter of the z-score image

   Seeds closer than 1.2 × that distance are merged. The mask is then divided between the seeds by a
   watershed.
6. **Measurement** of every candidate:
   - area
   - width (twice the largest inscribed radius)
   - short and long axes and their ratio
   - z-score statistics
   - contrast above local background
   - for merges, each channel's signal inside the soma
7. **Shape and signal limits** (when a classifier does not replace them, see 4):
   - area between 1.0 × π(smallest/2)² and 1.8 × π(largest/2)²
   - width at least the narrowest soma
   - elongation (long/short axis) at most 5.0
   - a brightness floor in the image's own units, placed automatically (not applied to cells found by the
     network, section 4)

Each candidate also gets a **confidence**: its distance to the nearest decision limit, from 0 to 1.

## 4. Classification

Which candidates are counted in single-channel Normal and Donut views is decided by the cell-centre network
somaNet v1. The classifier's identity, SHA-256 and threshold are recorded in the run record.

- **Cell-centre network, somaNet v1**, for single-channel Normal and Donut views. Two small
  U-Nets, one per mode, read the analysed channel binned 2 × 2. They output the probability that a person
  would place a cell at each location. Cells are local maxima at or above a calibrated threshold (Normal
  0.2025, Donut 0.185). Each centre takes the measurements of the nearest detector candidate within 0.6 ×
  the smallest diameter; a centre without one is measured in a disc of the smallest diameter. The networks
  run on the GPU (WebGPU) where available and otherwise in JavaScript, with the same results (agreement
  with the PyTorch originals is checked to 1e-5). Training, validation and limits:
  [`models/somaNet-v1.card.md`](models/somaNet-v1.card.md).
- **Rules:** merged views are counted with the limits in section 3.7 and the colocalisation test in
  section 6.

The code also contains an earlier classifier, the hand-count forest somaHandRF v1, documented in
[`models/somaHandRF-v1.card.md`](models/somaHandRF-v1.card.md) and kept for comparison. In short: a random
forest of 60 trees scores candidates from 16 size-, signal- and neighbourhood-normalised features, counting
those ≥ 0.27. It is not offered in this version's interface.

## 5. Detection modes

Each channel is analysed in Normal or Donut mode, chosen automatically from the image and changeable with
the mode buttons under Detection. A channel too dense with axons to tell somata from fibres is flagged.

- **Normal:** the steps above.
- **Donut:** for cytoplasmic markers such as TH, where the unstained nucleus makes a soma a bright ring.
  - Enclosed dark cavities up to 0.70 × π(largest/2)² are filled before the soma-width filter.
  - Gaps of 1–3 px in the ring are closed first.
  - An additional rescue adds well-separated somata whose rim is incomplete, while rejecting fibre-like
    arcs.
- **Axon-heavy** (in the code, not offered in this version's interface): for channels dense with labelled
  axons and neuropil.
  - Cell locations are not discovered in the target channel. Candidate centres come from the image's
    other channels.
  - The target channel must be bright in a soma-sized neighbourhood at that location.
  - It must also look soma-like rather than fibre-like there. Gradient directions in a soma-sized annulus
    are tested: a fibre gives aligned edges (high coherence, low orientation entropy), a soma edges in
    many directions.

## 6. Colocalisation (merged channels)

For a merge of two or three channels the candidate mask is built from the strongest z-score among the
selected channels, so that no one channel acts as gatekeeper. Each candidate is then tested for genuine
overlap.

1. Each channel is put on a common scale: (intensity − local background) / that channel's 0.1–99.8
   percentile range. Local noise is deliberately not used here, because it is unstable in dense neuropil.
2. A pixel's **white-overlap score** is the smaller of the channels' values multiplied by the ratio of the
   smaller to the larger. Both channels must be enriched, and in balance: a broad weak partner or a strongly
   tinted pixel scores low.
3. A soma is **positive in the merge** when the fraction of its pixels above the white-overlap strength
   (default 0.06) is at least the **white overlap area** (default 30%), and its whiteness is above the
   colocalisation floor. A fraction is used rather than a mean, so that a fibre of the other colour
   crossing a cell does not make it positive.
4. An optional **bleed-through** correction (default 0) raises the threshold for the partner channel by a
   fixed fraction of the soma's signal in the primary channel, so signal leaking from one channel into the
   other is not read as co-expression. It should be measured on single-label control sections and kept
   fixed within a cohort.

## 7. Hand correction

Automatic counts can be corrected:
- add a soma
- remove somata under the brush, or every soma inside a drawn loop
- clear a view

The run record reports automatic, added and removed cells separately, and the cells table marks each soma's
source. A soma removed in a merge is also removed from the merge's single channels.

## 8. Regions

Regions such as SN and VTA are drawn as freehand outlines; a region may have several outlines and holes,
and regions do not overlap. Each soma is assigned to the region containing its centre. Counts are
reported per region and per hemisphere (left or right half of the image).

## 9. Outputs and provenance

- **Cells table** (`*_cells.csv`), one row per soma:
  - position (px and µm)
  - area, width, axes, aspect ratio
  - region and hemisphere
  - confidence
  - source (automatic, added by hand, or copied from another view)
  - per-channel signal
  - colocalisation measures for merges
- **Summary** (`summary_by_region.csv`): counts per image, view, region and hemisphere.
- **Run record** (`*_run.json`):
  - tool name and version
  - date
  - source file names with checksums
  - pixel size
  - every detection and colocalisation parameter
  - classifier identity, SHA-256 and threshold, and whether the image lies within the classifier's
    validated domain
  - counts (total, automatic, added and removed by hand)
  - why rejected candidates were rejected
- **ImageJ TIFF:** the image with one point ROI per soma (Fiji/ImageJ). It also stores the full analysis,
  so it reopens in Soma Quantification with its counts.

## 10. Validation and limitations

Both classifiers were validated by leaving one animal out: the model and its threshold were fitted on
the other animals and tested on the held-out one.

| Classifier, mode | Mean absolute count error | Images within 10% | Bias | Cell-level F1 |
|---|---|---|---|---|
| somaNet v1, Normal | 7.4% | 14 of 19 | −3.2% | 0.861 |
| somaNet v1, Donut | 12.5% | 6 of 13 | +3.2% | 0.793 |
| somaHandRF v1 (threshold 0.27), Normal | 9.4% | 13 of 19 | +0.7% | 0.864 |

Limitations (details in the model cards):
- The models were trained on one microscope, 12-bit data and a pixel size of about 1.24 µm, with the
  smallest soma diameter at 10 px. Analyses outside that domain are flagged in the run record. Other
  stains, objectives, pixel sizes or bit depths should be checked against hand counts before their counts
  are relied on.
- The hand counts were made by more than one person; agreement is bounded by how consistently cells are called.
- Faint cells in dim patches of otherwise bright tissue are the most frequent misses.
- Merged-view (colocalisation) and Axon-heavy counts use rules and are not covered by the model
  validation.

## 11. Draft methods paragraph

Adapt this to your analysis, filling in the bracketed values from your run records.

> Somata were counted with Soma Quantification v1.0.0 (https://github.com/rwu92/soma-quantification), a
> browser-based tool. [ND2] images were reduced to maximum-intensity projections of the Z stack. For each
> channel the local background (10th percentile within a window of three maximum soma diameters) and
> noise (median absolute deviation) were estimated. Pixels more than [4.0] noise units above background
> formed a signal mask, which was filtered for soma width, screened for fibre bundles and divided between
> touching somata by watershed segmentation. Expected soma diameters were 12–35 µm. Cell
> centres were classified with the cell-centre network somaNet v1 ([Normal/Donut] mode), validated
> against hand counts by leave-one-animal-out cross-validation (mean absolute count error 7.4% Normal,
> 12.5% Donut). Colocalised cells were those in which at least [30]% of the soma showed balanced signal in
> both channels. Automatic counts were reviewed and corrected by hand [N added, M removed]. Somata were
> assigned to [SN and VTA] by outlines drawn on each section. Parameters, classifier version and file
> checksums were recorded for every analysis.

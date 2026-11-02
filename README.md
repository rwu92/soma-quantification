# Soma Quantification

Counts neuronal cell bodies (somata) in fluorescence microscopy images, in the browser. It was built
for tyrosine hydroxylase (TH) and reporter labelling in the substantia nigra (SN) and ventral tegmental
area (VTA), and handles single channels, merges (colocalisation) and regions drawn by hand.

**Open it:** https://rwu92.github.io/soma-quantification/
**Version:** 1.0.0 (see [Citing](#citing))

Everything runs on your own computer. Images are read and analysed in the browser tab and are never
uploaded anywhere.

## Contents

- [Quick start](#quick-start)
- [Inputs](#inputs)
- [Workflow](#workflow)
- [Outputs](#outputs)
- [Keys and mouse](#keys-and-mouse)
- [Citing](#citing)
- [Documentation](#documentation)
- [Repository layout](#repository-layout)
- [Development](#development)
- [Licence](#licence)

## Quick start

**In the browser.** Open https://rwu92.github.io/soma-quantification/ in a current Chrome, Edge,
Firefox or Safari. Chrome and Edge run the cell-centre network on the GPU (WebGPU); other browsers run the
same arithmetic in JavaScript, which gives identical results but takes longer.

**Offline, from a copy of this repository.** Everything the tool needs is in the repository, including the
Python runtime that reads ND2 files, so it works without an internet connection.

```bash
git clone https://github.com/rwu92/soma-quantification.git
cd soma-quantification
python3 serve.py 8000
```

Then open http://localhost:8000. On macOS you can double-click `START_HERE.command` instead. The page has
to be served like this, rather than opened as a file, because browsers do not run its workers from
`file://` addresses.

## Inputs

- **Nikon ND2** (`.nd2`), including multipoint files, read with the
  [nd2](https://github.com/tlambert03/nd2) Python package running in the page (Pyodide). Z stacks are shown
  and analysed as a **maximum-intensity projection**, of all planes or of planes you choose; planes can be
  lined up first when a stack is offset. Pixel size and channel names are taken from the file.
- **TIFF** (`.tif`, `.tiff`): 8-, 16- or 32-bit, greyscale or RGB (the first image of a multi-page file).
  The ImageJ TIFFs this tool exports, and ZIPs of them, reopen with their counts.
- **PNG and JPEG**.

A greyscale file is one channel. Files that differ only by a channel tag at the end of the name (`_C1`,
`_C2`, `-ch1` …) are put together as the channels of one image; an RGB file is split into its red, green
and blue channels.

Several files can be loaded at once; each image (section) keeps its own channels, counts, regions and
undo history. Analysis always uses the image at its full native resolution. The **Display** setting only
lowers the resolution of what is drawn on screen, to save memory with very large images.

## Workflow

1. **Load images** by dropping them on the page or with **+ Add** in the Images card.
2. **Pixel size** is read from ND2 files and from TIFFs exported by this tool. The expected soma sizes
   (12–35 µm) and every other detection setting follow from it automatically. Other TIFF, PNG and JPEG
   files carry no pixel size here: they are analysed with sizes in pixels (16–44 px), outside the
   cell-centre network's validated range, and the run record says so.

3. **Choose what to count**: a single channel, or a merge of two or three channels (counts cells positive
   in every selected channel), using the channel buttons or the number keys 1–9.
4. **Analyse** the selected view, the whole section, or all loaded images.
5. **Correct by hand**:
   - **Add** (A): click to add a soma.
   - **Remove** (R): click to remove one. Press R or click Remove again for the **remove lasso**, which
     removes every soma inside a loop.
   - **Clear** empties the counts of the view on screen.
   - **Undo** (Ctrl+Z) reverses any step.
6. **Draw regions** (SN, VTA, or your own) with the **Lasso** tool. Counts are reported per region.
   Regions can be trimmed (scissors), single outlines deleted, or all regions cleared.
7. **Export** the counts, the run record and ImageJ TIFFs (see [Outputs](#outputs)).

**Side by side** (P) shows every channel and merge of the image at the same place and zoom, for judging
colocalisation by eye; edits work in any panel.

## Outputs

| Export | Contents |
|---|---|
| Cells (`*_cells.csv`) | One row per counted soma: position (native pixels and µm), area, width, short and long axes, aspect ratio, region, hemisphere (left or right half of the image), confidence, source (automatic, added by hand, or copied from another view), the signal in each channel, and for merges the colocalisation measures. |
| Summary (`summary_by_region.csv`) | Counts per image and view, by region and hemisphere, with the number added by hand and, for merges, the number positive in both channels. |
| Run record (`*_run.json`) | Everything needed to report or repeat the analysis: tool name and version, every parameter, the classifier used with its SHA-256, source file names with checksums, pixel size, counts (automatic, added and removed by hand) and the reasons candidates were rejected. |
| ImageJ TIFF (Selected, Section, All) | The image with each soma as a point ROI, readable in Fiji/ImageJ. The file also stores the analysis, so it reopens in this tool with its counts. |
| Counted image (`*_counted.png`) | The view on screen with its markers. |

## Keys and mouse

| | |
|---|---|
| A / R / L | Add, Remove (again: remove lasso), Lasso |
| P | Side by side |
| H | Hide everything except the image (move the pointer to an edge to bring panels back) |
| + / − or pinch | Zoom |
| Arrow keys, or Space + left drag | Pan |
| 1–9 | Show a channel; hold several for their merge |
| Ctrl+Z | Undo |
| Esc | Close a window, leave Hide UI |

With Add and Remove, a plain left drag also pans and a click acts. Every key except 1–9, Ctrl+Z and Esc can
be changed in **Settings** (gear icon), which also holds edge panning and the side-by-side crosshair.

## Citing

Please cite the version you used (shown in every run record, `version` field), for example:

> rwu92. *Soma Quantification* (version 1.0.0) [Computer software]. https://github.com/rwu92/soma-quantification

GitHub shows a ready-made citation from [`CITATION.cff`](CITATION.cff) under **Cite this repository**. For a
permanent DOI, connect the repository to [Zenodo](https://zenodo.org/account/settings/github/); each
GitHub release then gets its own DOI.

[`docs/METHODS.md`](docs/METHODS.md) describes the method in detail and ends with a draft methods
paragraph to adapt.

## Documentation

- [`docs/METHODS.md`](docs/METHODS.md): how somata are detected, classified and colocalised; regions;
  outputs; validation; limitations.
- [`docs/models/somaNet-v1.card.md`](docs/models/somaNet-v1.card.md): the cell-centre networks (the default
  classifier), their training and leave-one-animal-out validation.
- [`docs/models/somaHandRF-v1.card.md`](docs/models/somaHandRF-v1.card.md): the hand-count random forest
  (optional classifier) and its validation.
- [`training/`](training/): code that trained and validated both models. Research images are not included.

## Repository layout

```
index.html                     the tool
assets/apps/soma.js            the page's code, built from src/soma/
assets/soma-detector-worker.js detection, classifiers (models embedded) and colocalisation, in a web worker
assets/toolkit-core.js/.css    shared file reading (ND2, TIFF), progress and interface helpers
assets/nd2-*.py, *.mjs         ND2 reading in Pyodide
assets/vendor/                 Pyodide 314.0.6 with nd2 and numpy, JSZip, pako, UTIF
src/soma/                      source of assets/apps/soma.js, in parts
docs/                          methods and model cards
training/                      model training and validation code
tests/                         detector and model-parity tests, with their fixtures
scripts/build.py               assembles assets/apps/soma.js from src/soma/
serve.py, START_HERE.command   local server
```

## Development

```bash
python3 scripts/build.py          # rebuild assets/apps/soma.js after editing src/soma/
python3 scripts/build.py --check  # confirm it is up to date
node tests/test_soma_worker.js    # run the detector on a synthetic image and compare with the stored result
node tests/test_model_parity.js   # embedded models match their validation records and reproduce scikit-learn / PyTorch
```

## Licence

MIT; see [`LICENSE`](LICENSE). The bundled third-party software keeps its own licences; see
[`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

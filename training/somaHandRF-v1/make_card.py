"""Write docs/models/somaHandRF-v1.card.md from the exported model record."""
import json, os, sys
S = os.environ['SCR']; OUT = sys.argv[1]
m = json.load(open(f'{S}/model/somaHandRF-v1.json'))
s = m['validation']['heldOut']; d = m['validatedDomain']; t = m['training']
rows = '\n'.join(f"| {r['sec']} | C={r['ch'][1]} | {r['animal']} | {r['hand']} | {r['tool']} | {100*(r['tool']/r['hand']-1):+.0f}% | {r['quality']:.2f} |"
                 for r in m['validation']['perImage'])
card = f"""# Model card: somaHandRF v1

Soma classifier used by Soma Quantification (`assets/soma-detector-worker.js`, `SOMA_HAND_RF`).
Model SHA-256: `{m['sha256']}`

## What it does
For single-channel Normal-mode analyses, every candidate the detector keeps with the **area and width limits
disabled** (fibre screening and the elongation limit still applied) is scored by a random forest. Candidates with
probability >= **{m['threshold']}** are counted. The classifier replaces the area and width limits and the automatic
brightness floor for those analyses. Merges/colocalisation, Donut and Axon-heavy analyses use the rule-based filters
and are **not** covered by this validation.

## Inputs ({len(m['features'])} features, no raw camera intensity)
{', '.join(f'`{f}`' for f in m['features'])}.
Sizes are divided by the minimum soma diameter (px); signal by the detection threshold, local noise or local
background; three features are within-image ranks; neighbour features use a {m['neighbourRadiusPx']:.0f} px radius.

## Training data
- Images: {len(t['images'])} single-channel images (C=1 and C=2) from 15 sections of animals 1, 2 and 3:
  {', '.join(t['images'])}.
- Labels: {t['labelRule']}. {t['handPoints']} hand points, {t['candidates']} candidates, {t['positives']} positives.
- Excluded: {t['excluded']}.
- Hand counts: Fiji multi-point, on max projections (C=1 and C=2), made by more than one person.
- scikit-learn {t['sklearn']}; parameters `{json.dumps(t['params'])}`.
- Threshold rule: {t['thresholdRule']}.
- Reproduce: `train_final.py` (training/validation/export) and `make_card.py` (this card).

## Validation
{m['validation']['scheme']}. Every number below is for images from the animal the model **and** threshold were not fitted on.

| Metric | Value |
|---|---|
| Held-out images | {s['images']} |
| Within ±5% of hand count | {s['within5']} |
| Within ±10% | {s['within10']} |
| Mean absolute count error | {100*s['meanAbsErr']:.1f}% |
| Median absolute count error | {100*s['medianAbsErr']:.1f}% |
| Worst image | {100*s['worstAbsErr']:.0f}% |
| Mean bias | {100*s['bias']:+.1f}% |
| Cell-level F1 (8 px, one-to-one) | {s['f1']:.3f} |
| Total hand / tool | {s['handTotal']} / {s['toolTotal']} |

| Section | Channel | Held-out animal | Hand | Tool | Error | Image quality |
|---|---|---|---|---|---|---|
{rows}

## Validated domain
- Pixel size {d['pixelSizeUm']} µm/px, minimum soma diameter {d['dMinPx']} px (±1 px), Normal mode, single channel.
- Image quality = {d['imageQualityDefinition']}; validated range {d['minImageQuality']}–{d['maxImageQuality']} (range of the training images).
  Analyses outside it are labelled "OUTSIDE validated range" in the app and `insideValidatedRange: false` in the run JSON.

## Known limitations
- The hand counts were made by more than one person. Count agreement is bounded by the consistency of the hand counts.
- C=0 excluded from training and validation: weak cell-to-background contrast; 12 of 13 C=0 images fall outside the validated quality range.
- Not validated for Donut or Axon-heavy mode, colocalisation counts, other markers, magnifications or pixel sizes.
- About 7% of hand-counted cells never became detector candidates; the classifier cannot recover those.
"""
open(OUT, 'w').write(card)
print('wrote', OUT)

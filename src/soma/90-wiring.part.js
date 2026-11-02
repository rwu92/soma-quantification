/* ---------------------------- wiring ------------------------------------ */
ToolkitCore.ui.bindFileDrop({ zone: $('drop'), input: $('fileInput'), dragClass: 'over', pageOverlayClass: null, onPageDragChange: on => $('pageDrop').classList.toggle('open', on), onFiles: files => { handleFiles(files); $('fileInput').value = ''; } });
$('addImages').onclick = () => $('fileInput').click();
$('copyCounts').onclick = copyRegionCounts;
['dMin', 'dMax', 'thin'].forEach(id => $(id).addEventListener('input', () => { S.sizesTouched = true; }));
const SIGNAL_INPUTS = ['dMin', 'dMax', 'snr', 'thin', 'split', 'edge', 'fillHoles', 'satRescue', 'legacyForests'];
const FILTER_INPUTS = ['maxAspect', 'areaLo', 'areaHi', 'colocThr', 'minFill', 'bleed', 'cellModel'];
SIGNAL_INPUTS.forEach(id => $(id).addEventListener('input', () => {
    syncLabels();
    checkSizes();
    checkSnr();
    drawOverlay();
    markDirty(true);
}));
FILTER_INPUTS.forEach(id => $(id).addEventListener('input', () => {
    syncLabels();
    clearTimeout(window._ft);
    window._ft = setTimeout(refilter, 180);
}));
['colocThr', 'bleed', 'minFill'].forEach(id => $(id).addEventListener('input', () => {
    syncLabels();
    clearTimeout(window._ct);
    window._ct = setTimeout(() => { refilter(); }, 180);
}));
$('polarity').onchange = () => {
    if (!S.image) {
        return;
    }
    S.sections.forEach(sec => { sec.channels = null; }); // force a re-decode
    const i = S.idx;
    S.idx = -1;
    activate(i);
    setStatus('Re-reading with the chosen polarity…');
};
$('pxSize').addEventListener('input', () => {
    syncLabels();
    describeImage();
    checkSizes();
    $('pxSrc').textContent = +$('pxSize').value > 0 ? 'set by hand' : 'not set';
});
$('runSelectedBtn').onclick = () => {
    if (S.image && !S.busy && !S.run)
        holdRun('the analysis of ' + S.image.name, runSelectedNow);
};
async function runSelectedNow() {
    await settleAutoModes(S.image);
    if (!S.image || S.busy)
        return;
    markDirty(false);
    tabProgressStart('selected');
    try {
        /* A selected Axon-heavy run first fills any missing Normal/Donut guide
           analyses once, saves them, then reuses those exact saved detections. */
        await ensureAxonGuideAnalysesForSelection();
        /* A channel too dense with axons is counted too; the status says to check it. */
        const dense = axonDenseReason(S.image, $('chDetect').value);
        if (await runAnalysis() != null) {
            await finalizeSectionReview(S.image);
            if (dense)
                setStatus(`Analysis saved. ${dense}, so check this count: some fibres may be counted as somata.`);
        }
    }
    finally {
        tabProgressFinish();
    }
}
$('runBtn').onclick = () => runSection();
$('runAllBtn').onclick = () => runAll();
/* Soma size is a property of the neuron, not of the file.  Once the pixel size
   is known the px settings follow from it, which stops the commonest and most
   damaging mistake: carrying settings tuned on a downscaled export over to the
   full-resolution original, where every soma is several times larger.        */
const SOMA_UM = { min: 12, max: 35, narrow: 9 };
function fitSizes() {
    const px = +$('pxSize').value;
    if (!(px > 0)) {
        setStatus('Set the pixel size first, or load an ND2 so it can be read from the file.');
        return;
    }
    const dMin = Math.round(SOMA_UM.min / px), dMax = Math.round(SOMA_UM.max / px);
    const nar = Math.round(SOMA_UM.narrow / px);
    const clampTo = (el, v) => { el.value = Math.max(+el.min, Math.min(+el.max, v)); return +el.value; };
    const a = clampTo($('dMin'), dMin), b = clampTo($('dMax'), dMax), c = clampTo($('thin'), nar);
    $('split').value = 72;
    syncLabels();
    drawOverlay();
    markDirty(true);
    checkSizes();
    setStatus(`Sizes set for ${px} µm/px: somata ${a}–${b} px, narrowest ${c} px. Analyse to apply.`);
}
/* A low threshold is not a harmless "catch more, prune later" setting.  It
   enlarges the mask itself, so neighbouring somata fuse into one object and
   are then counted once.  Below about 3 sigma that starts costing real cells,
   which no amount of manual pruning can get back.                          */
function checkSnr() {
    const v = +$('snr').value / 10, el = $('snrWarn');
    if (!el)
        return;
    if (v < 3) {
        el.innerHTML = '<span class="warnc">Below 3&sigma; the mask grows enough that touching ' +
            'somata merge and get counted once. Lowering the threshold to catch more cells ' +
            'starts <em>losing</em> them here — pruning afterwards cannot recover a merge. ' +
            'Use the contrast floor instead if faint cells are being missed.</span>';
    }
    else
        el.innerHTML = '';
}
function checkSizes() {
    const px = +$('pxSize').value, el = $('sizeWarn');
    if (!(px > 0)) {
        el.textContent = '';
        return;
    }
    const lo = +$('dMin').value * px, hi = +$('dMax').value * px;
    if (lo > SOMA_UM.min * 2.2 || hi < SOMA_UM.max * 0.45 || lo < SOMA_UM.min * 0.35) {
        el.innerHTML = `<span class="warnc">Current settings look for somata ${lo.toFixed(0)}–${hi.toFixed(0)} µm across.
      Midbrain dopaminergic somata are roughly 15–25 µm. If that range is wrong the detector
      will fragment cells or merge them, and both show up as a high rejection rate.</span>`;
    }
    else
        el.innerHTML = `Looking for somata ${lo.toFixed(0)}–${hi.toFixed(0)} µm across.`;
}
/* A drag of a floor, or a key press on it, is one undo step, recorded as it
   starts: by the time the slider reports a move its old value is gone. */
let floorStepOpen = false;
[['minContrast', 'moved the brightness floor'], ['colocFloor', 'moved the colocalization floor']].forEach(([id, label]) => {
    const el = $(id), open = () => { if (!floorStepOpen && S.image && !el.disabled)
        snapshot(label); floorStepOpen = true; };
    el.addEventListener('pointerdown', open);
    el.addEventListener('keydown', e => { if (/^(Arrow|Page|Home|End)/.test(e.key))
        open(); });
    el.addEventListener('change', () => { floorStepOpen = false; });
});
$('colocFloor').addEventListener('input', () => {
    S.colocFloorTouched = true;
    S.colocFloorAuto = false;
    syncLabels();
    applyContrastFloor();
    drawColocHist();
});
$('colocFloorAuto').onclick = () => {
    snapshot('set the colocalization floor automatically');
    S.colocFloorTouched = false;
    if (placeColocFloorAutomatically()) {
        syncLabels();
        applyContrastFloor();
        drawColocHist();
    }
    else
        setStatus('Not enough colocalized detections to place the colocalization floor automatically.');
};
$('minContrast').addEventListener('input', () => {
    S.floorTouched = true;
    S.floorAuto = false;
    syncLabels();
    applyContrastFloor();
});
$('floorMode').addEventListener('change', () => {
    $('minContrast').disabled = !floorEnabled();
    syncLabels();
    applyContrastFloor();
    drawContrastHist();
});
$('minContrast').disabled = !floorEnabled();
$('floorAuto').onclick = () => {
    snapshot('set the brightness floor automatically');
    S.floorTouched = false;
    if (placeFloorAutomatically()) {
        syncLabels();
        applyContrastFloor();
    }
    else
        setStatus('Not enough detections to place the floor automatically.');
};
window.addEventListener('resize', () => { drawContrastHist(); drawColocHist(); });
/* Both floors sit in the hidden Advanced block: drawn while closed, their histograms had no width. */
$('advDetails').addEventListener('toggle', () => { if ($('advDetails').open) {
    drawContrastHist();
    drawColocHist();
} });
initModeButtons();
$('density').onchange = applyDensityChoice;
$('presetReset').onclick = () => { preset(16, 44, 40, 8, 72); $('density').value = 'auto'; applyDensityChoice(); };
$('fitSizes').onclick = fitSizes;
$('undoBtn').onclick = undo;
$('rgnAdd').onclick = () => {
    snapshot('added a region', { regions: true });
    addRegion();
    tool('lasso');
    setStatus('Click to place the outline, double-click to close it.');
};
$('copyCells').onclick = e => openCopyCountsMenu(e.currentTarget);
/* Clear: every soma counted in the view on screen goes, as one undo step that
   brings them all back. It is a fresh start, not a verdict on each soma, so
   nothing is logged as removed by hand. A view with no analysis behind it is
   dropped from the saved results, so it does not come back on reopening. */
$('clearCells').onclick = () => {
    if (!S.image || S.busy || !S.cells.length)
        return;
    const n = S.cells.length, value = $('chDetect').value;
    snapshot(`cleared ${n} somata`);
    S.cells = [];
    S.manualRemoved = 0;
    saveResult();
    if (!S.lastRun && !S.autoCount)
        S.results.delete(analysisKey(S.image, value));
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    renderFileList();
    if (sbsOpen())
        sbsDraw();
    setStatus(`Cleared ${n} somata from ${analysisSelectionLabel(S.image, value)}. Undo brings them back.`);
};
$('rgnDeleteOutline').onclick = () => {
    if (!S.regions.some(r => regionPolys(r).length)) {
        setStatus('There are no drawn region outlines to delete.');
        return;
    }
    tool('delRegion');
    setStatus('Delete outline: click inside or on the dashed boundary of the one outline you want to remove.');
};
$('rgnTrim').onclick = () => {
    if (S.tool === 'trim') {
        tool('add');
        return;
    }
    if (!S.regions.some(r => regionPolys(r).length)) {
        setStatus('There are no drawn regions to trim yet. Draw one with Lasso first.');
        return;
    }
    tool('trim');
    setStatus('Trim region: loop around the part of a region to cut away. Across an edge trims it, right through splits it, inside leaves a hole.');
};
$('rgnClear').onclick = () => {
    if (!S.regions.length)
        return;
    snapshot('cleared all regions', { regions: true });
    S.regions.splice(0, S.regions.length);
    if (S.image)
        S.image.regions = S.regions;
    S.activeRegion = -1;
    S.cells.forEach(c => c.region = -1);
    renderRegions();
    renderRegionTable();
    drawOverlay();
    saveResult();
};
/* Signal character differs between channels: where the neuropil is dense the
   local noise estimate is large, so a real soma never clears 4 sigma.  These
   two starting points were measured on your sections. Pick one, check it, then
   keep it fixed for the whole cohort.                                       */
function densityMode() { const v = ($('density') || {}).value; return v || 'auto'; }
function applyDensityChoice() {
    const mode = densityMode();
    if (mode === 'sparse') {
        $('snr').value = 40;
        $('minContrast').value = 120;
        syncLabels();
        checkSnr();
    }
    else if (mode === 'dense') {
        $('snr').value = 28;
        $('minContrast').value = 80;
        syncLabels();
        checkSnr();
    }
    else
        applyDensity();
    renderDensityNote();
    markDirty(true);
    drawOverlay();
}
function renderDensityNote() {
    const el = $('densityNote');
    if (!el || !S.image)
        return;
    const c = detectChannel();
    const src = (c && c.data) ? c : S.image.channels[0];
    if (!src || !src.data) {
        el.textContent = '';
        return;
    }
    const d = channelDensity(src), dense = d > DENSE_CUT;
    const forced = densityMode() !== 'auto';
    el.innerHTML = `Axon density ${d.toFixed(2)} — ${dense ? 'dense' : 'sparse'}` +
        (forced ? ` (overridden to ${densityMode()})` : `, so ${(+$('snr').value / 10).toFixed(1)}σ`) + '.';
}
function preset(dmin, dmax, snr, thin, split) {
    $('dMin').value = dmin;
    $('dMax').value = dmax;
    $('snr').value = snr;
    $('thin').value = thin;
    $('split').value = split;
    syncLabels();
    checkSnr();
    checkSizes();
    drawOverlay();
    markDirty(true);
}
/* Compact viewport-safe help bubbles. Kept separate from the legacy .q review-card class. */
const helpBubble = $('helpBubble');
let helpTarget = null;
function positionHelpBubble(el) {
    if (!el || !helpBubble)
        return;
    const text = el.getAttribute('data-tip') || '';
    if (!text) {
        hideHelpBubble();
        return;
    }
    helpTarget = el;
    helpBubble.textContent = text;
    helpBubble.classList.add('open', 'measuring');
    helpBubble.style.left = '8px';
    helpBubble.style.top = '8px';
    const a = el.getBoundingClientRect(), b = helpBubble.getBoundingClientRect();
    const m = 8, gap = 7;
    let left = a.left + a.width / 2 - b.width / 2;
    left = Math.max(m, Math.min(window.innerWidth - b.width - m, left));
    let top = a.top - b.height - gap;
    if (top < m)
        top = a.bottom + gap;
    top = Math.max(m, Math.min(window.innerHeight - b.height - m, top));
    helpBubble.style.left = Math.round(left) + 'px';
    helpBubble.style.top = Math.round(top) + 'px';
    helpBubble.classList.remove('measuring');
    el.setAttribute('aria-describedby', 'helpBubble');
}
function hideHelpBubble() {
    if (helpTarget)
        helpTarget.removeAttribute('aria-describedby');
    helpTarget = null;
    if (helpBubble)
        helpBubble.classList.remove('open', 'measuring');
}
document.querySelectorAll('.help-tip').forEach(el => {
    el.setAttribute('aria-label', 'More information');
    el.addEventListener('pointerenter', () => positionHelpBubble(el));
    el.addEventListener('pointerleave', hideHelpBubble);
    el.addEventListener('focus', () => positionHelpBubble(el));
    el.addEventListener('blur', hideHelpBubble);
});
window.addEventListener('resize', () => { if (helpTarget)
    positionHelpBubble(helpTarget); });
window.addEventListener('scroll', () => { if (helpTarget)
    positionHelpBubble(helpTarget); }, true);
/* Leaving the page loses every opened image, analysis and hand correction:
   nothing is kept outside this tab unless it was exported. As in Figure
   Workshop, the Tools link asks first (a misclick used to throw the session
   away without a word) and reload, closing the tab and Back get the browser's
   standard prompt, whenever anything is open. */
let somaLeaveConfirmed = false;
function somaWorkContents() {
    const results = [...S.results.values()];
    const manual = cells => (cells || []).filter(c => c && c.source === 'manual').length;
    let edits = results.reduce((n, r) => n + (r.removed || 0) + manual(r.cells), 0);
    if (S.image && !results.some(r => r.sectionKey === S.image.key))
        edits += (S.manualRemoved || 0) + manual(S.cells);
    return { images: (S.sections || []).length, analyses: results.length, edits };
}
function somaLeaveMessage(w) {
    const parts = [`${w.images} open image${w.images === 1 ? '' : 's'}`];
    if (w.analyses)
        parts.push(`${w.analyses} analys${w.analyses === 1 ? 'is' : 'es'}`);
    if (w.edits)
        parts.push(`${w.edits} hand correction${w.edits === 1 ? '' : 's'}`);
    const list = parts.length > 1 ? parts.slice(0, -1).join(', ') + ' and ' + parts[parts.length - 1] : parts[0];
    const when = S.lastExport ? new Date(S.lastExport.at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : '';
    const saved = S.lastExport ? `Last exported at ${when}; later changes are not saved.` : 'Nothing has been exported yet.';
    return `Leave Soma Quantification?\n\nYou have ${list}. ${saved}\n\nChoose Cancel to stay. To keep your work, use ImageJ TIFF: All under Export first: it reopens here with every dot.`;
}
{
    const toolsLink = document.querySelector('.toolkit-back');
    if (toolsLink)
        toolsLink.addEventListener('click', e => {
            const w = somaWorkContents();
            if (!w.images)
                return;
            if (!ToolkitCore.ui.confirm(somaLeaveMessage(w))) {
                e.preventDefault();
                return;
            }
            somaLeaveConfirmed = true;
        });
}
window.addEventListener('beforeunload', e => {
    if (somaLeaveConfirmed || !somaWorkContents().images)
        return;
    e.preventDefault();
    e.returnValue = '';
});
initWorker();
syncLabels();
/* The control starts live, showing the remembered choice, so it can be set
   before anything is open instead of sitting greyed out on a value it will not
   take. */
syncDisplayResolutionButtons();
checkSnr();
setEngine('', 'idle');
tool('add');

/* ---------------------------- analysis --------------------------------- */
function markDirty(on) {
    S.dirty = on;
    const selected = $('runSelectedBtn'), section = $('runBtn');
    if (selected)
        selected.classList.toggle('on', on);
    if (section)
        section.classList.toggle('on', on);
    if (on)
        setStatus('Settings changed — analyse to apply.');
}
function setBusy(on, msg) {
    S.busy = on;
    ['runSelectedBtn', 'runBtn', 'runAllBtn'].forEach(id => $(id).disabled = on || !S.image);
    if (on) {
        setEngine('busy', msg || 'working');
        if (msg)
            setStatus(msg + '…');
    }
}
/* A run takes several steps and is not busy between them, where a click on
   another image switched images and quietly ended the run. While one lasts,
   the image list and newly added files wait for it (S.run names it). */
async function holdRun(label, fn) {
    if (S.run)
        return undefined;
    S.run = label;
    try {
        return await fn();
    }
    finally {
        S.run = null;
    }
}
function setEngine(k, t) { $('engDot').className = 'dot ' + (k || ''); $('engTxt').textContent = t; }
function setStatus(t) { $('status').textContent = t; }
function sectionResultForValue(sec, value) {
    /* The CURRENTLY DISPLAYED view is always live.  Do not require S.lastRun:
       after restoring an older snapshot or changing view/mode, the visible
       cells can be perfectly valid even when lastRun is null/stale.  Requiring
       it made the Section analysis table silently fall back to an old cached
       snapshot while the slider was visibly changing the overlay/count above. */
    const selectedValue = $('chDetect') ? $('chDetect').value : null;
    const currentValue = S.activeAnalysisValue || selectedValue;
    if (sec && sec === S.image && value === currentValue && value === selectedValue) {
        return { sectionKey: sec.key, sectionName: sec.name,
            selection: analysisSelectionLabel(sec, value),
            modeSignature: analysisModeSignature(sec, value),
            cells: (S.cells || []), allCells: S.allCells, run: S.lastRun || null,
            regions: S.regions };
    }
    return S.results.get(analysisKey(sec, value));
}
function mergeConstituentIndices(value) {
    if (!/^m\d+(?:-\d+)+$/.test(value || ''))
        return [];
    return value.slice(1).split('-').map(Number).filter(Number.isInteger);
}
function renderSectionAnalysisSummary(sec = S.image) {
    const card = $('sectionAnalysisCard'), out = $('sectionAnalysisOut');
    if (!card || !out) {
        return;
    }
    if (!sec || !sec.analysisSummaryReady) {
        card.hidden = true;
        out.innerHTML = '';
        return;
    }
    const values = [];
    for (let i = 0; i < sec.channels.length; i++)
        values.push('c' + i);
    for (let k = 2; k <= sec.channels.length; k++) {
        const comb = (arr, start, left) => { if (!left) {
            values.push('m' + arr.join('-'));
            return;
        } for (let i = start; i <= sec.channels.length - left; i++)
            comb(arr.concat(i), i + 1, left - 1); };
        comb([], 0, k);
    }
    const rows = [];
    for (const v of values) {
        const r = sectionResultForValue(sec, v);
        if (r)
            rows.push({ value: v, label: analysisSelectionLabel(sec, v), result: r });
    }
    if (!rows.length) {
        card.hidden = true;
        out.innerHTML = '';
        return;
    }
    const esc = x => String(x).replace(/[&<>\"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;' }[c]));
    let html = '<div class="ana-block"><div class="ana-title">Counts by image / composite</div><table><thead><tr><th>View</th><th class="num">Cells</th></tr></thead><tbody>';
    for (const q of rows) {
        const dense = q.result.run && q.result.run.countedDespiteDensity ? axonDenseReason(sec, q.value) || 'Too dense with axons and neuropil to tell somata from fibres reliably' : '';
        html += `<tr${dense ? ` title="${esc(dense)}; check this count."` : ''}><td>${esc(q.label)}${dense ? ' <span class="ana-dense">dense</span>' : ''}</td><td class="num ana-strong">${q.result.cells.length}</td></tr>`;
    }
    html += '</tbody></table></div>';
    const merges = rows.filter(q => q.value[0] === 'm');
    if (merges.length) {
        const drawnRegions = (sec.regions || []).map((r, i) => ({ r, i, polys: regionPolys(r) }))
            .filter(x => x.polys.some(poly => poly && poly.length >= 3));
        const inRegion = (cell, rr) => regionIndexAt(sec.regions || [], cell.x, cell.y) === rr.i;
        if (drawnRegions.length) {
            html += '<div class="ana-block"><div class="ana-title">Merge → individual colocalization by region</div><table><thead><tr><th>Region</th><th>Composite</th><th class="num">Merge-positive</th><th>Percent colocalized</th></tr></thead><tbody>';
            for (const rr of drawnRegions) {
                const rname = (rr.r.name || ('Region ' + (rr.i + 1))).trim() || ('Region ' + (rr.i + 1));
                for (const q of merges) {
                    const idx = mergeConstituentIndices(q.value);
                    const n = q.result.cells.filter(c => inRegion(c, rr)).length, bits = [];
                    for (const i of idx) {
                        const r = sectionResultForValue(sec, 'c' + i);
                        if (!r)
                            continue;
                        const denom = r.cells.filter(c => inRegion(c, rr)).length;
                        const label = analysisSelectionLabel(sec, 'c' + i), pct = denom ? 100 * n / denom : 0;
                        bits.push(`${pct.toFixed(1)}% of ${esc(label)} (${denom})`);
                    }
                    if (bits.length)
                        html += `<tr><td>${esc(rname)}</td><td>${esc(q.label)}</td><td class="num ana-strong">${n}</td><td>${bits.join(' · ')}</td></tr>`;
                }
            }
            html += '</tbody></table></div>';
        }
        else {
            html += '<div class="ana-block"><div class="ana-title">Merge → individual colocalization</div><table><thead><tr><th>Composite</th><th class="num">Merge-positive</th><th>Percent colocalized</th></tr></thead><tbody>';
            for (const q of merges) {
                const idx = mergeConstituentIndices(q.value), n = q.result.cells.length, bits = [];
                for (const i of idx) {
                    const r = sectionResultForValue(sec, 'c' + i);
                    if (!r)
                        continue;
                    const label = analysisSelectionLabel(sec, 'c' + i), pct = r.cells.length ? 100 * n / r.cells.length : 0;
                    bits.push(`${pct.toFixed(1)}% of ${esc(label)}`);
                }
                if (bits.length)
                    html += `<tr><td>${esc(q.label)}</td><td class="num ana-strong">${n}</td><td>${bits.join(' · ')}</td></tr>`;
            }
            html += '</tbody></table></div>';
        }
    }
    out.innerHTML = html;
    card.hidden = false;
}
function axonGuideIndices(sec, targetIdx) {
    const out = [];
    if (!sec || !sec.channels)
        return out;
    for (let i = 0; i < sec.channels.length; i++)
        if (i !== targetIdx && channelMode(i, sec) !== 'axon')
            out.push(i);
    return out;
}
function exactGuideResult(sec, i) {
    if (!sec || !sec.channels || i < 0 || i >= sec.channels.length)
        return null;
    const mode = channelMode(i, sec);
    if (mode === 'axon')
        return null;
    return S.results.get(analysisKeyForChannelMode(sec, i, mode)) || null;
}
function savedAxonGuideGroups(sec, targetIdx) {
    return axonGuideIndices(sec, targetIdx).map(i => {
        const r = exactGuideResult(sec, i);
        return r ? { index: i, mode: channelMode(i, sec), name: (sec.channels[i] || {}).name || ('Channel ' + (i + 1)), cells: (r.cells || []).map(cloneCellSnapshot) } : null;
    }).filter(Boolean);
}
function orderedBatchAnalysisValues(sec, values) {
    const singles = [], axons = [], merges = [];
    for (const v of values) {
        if (/^c\d+$/.test(v)) {
            const i = +v.slice(1);
            (channelMode(i, sec) === 'axon' ? axons : singles).push(v);
        }
        else
            merges.push(v);
    }
    return singles.concat(axons, merges);
}
async function ensureAxonGuideAnalysesForSelection() {
    if (!S.image || S.busy)
        return 0;
    const sec = S.image, sel = parseDetect();
    if (sel.merge || channelMode(sel.idx[0], sec) !== 'axon')
        return 0;
    const targetValue = $('chDetect').value, targetIdx = sel.idx[0];
    const missing = axonGuideIndices(sec, targetIdx).filter(i => !exactGuideResult(sec, i));
    if (!missing.length)
        return 0;
    const originalViewMode = $('viewMode').value, originalMergePreview = !!S.mergePreview;
    let done = 0;
    saveResult();
    for (let k = 0; k < missing.length; k++) {
        const i = missing[k], value = 'c' + i;
        S.mergePreview = false;
        $('viewMode').value = 'image';
        $('chDetect').value = value;
        syncChannelButtons();
        renderModeButtons();
        restoreCurrentResult();
        if (densityMode() === 'auto')
            applyDensity(false);
        renderDensityNote();
        describeImage();
        if (analysisPageVisible()) {
            drawBase();
            drawOverlay();
            updateStats();
            renderRegions();
            renderRegionTable();
        }
        else
            backgroundBatchUiDirty = true;
        const label = analysisSelectionLabel(sec, value), mode = channelMode(i, sec);
        setStatus(`Preparing ${label} · ${modeLabel(mode)} guide analysis for Axon-heavy…`);
        analysisProgressStart(mode, `${label} · ${modeLabel(mode)} guide for Axon-heavy`);
        await paintAnalysisView();
        const n = await runAnalysis();
        if (n != null)
            done++;
    }
    $('chDetect').value = targetValue;
    $('viewMode').value = originalViewMode;
    S.mergePreview = originalMergePreview;
    syncChannelButtons();
    renderModeButtons();
    restoreCurrentResult();
    if (densityMode() === 'auto')
        applyDensity(false);
    renderDensityNote();
    describeImage();
    if (analysisPageVisible()) {
        drawBase();
        drawOverlay();
        updateStats();
        renderRegions();
        renderRegionTable();
    }
    else
        backgroundBatchUiDirty = true;
    return done;
}
async function runAnalysis() {
    if (!S.image || S.busy)
        return null;
    await settleAutoModes(S.image);
    if (!S.image || S.busy)
        return null;
    await ensureFullSectionPixels(S.image, 'analysis');
    if (densityMode() === 'auto')
        applyDensity(false);
    renderDensityNote();
    const ch = S.image.channels;
    const sel = parseDetect();
    const prim = sel.merge ? primaryOf(sel.idx) : sel.idx[0];
    /* Detection channel first, then only the partners this selection needs.
       Every extra channel costs a full background model, so channels the
       current question does not refer to are not sent at all.               */
    const partners = sel.merge ? sel.idx.filter(i => i !== prim) : [];
    const order = [prim].concat(partners);
    const arrays = order.map(i => ch[i].data);
    S.chanOrder = order;
    S.colocIdx = partners.map((_, k) => k + 1);
    S.compUsed = (sel.merge ? sel.idx : [prim]).map(i => ch[i].name);
    /* A channel marked too dense with axons is counted like any other, by every
       run; the run record keeps its density so the count can be checked. */
    const value = $('chDetect').value, dense = axonDenseReason(S.image, value);
    /* The view as it was before this analysis, so undo can bring it back. */
    snapshot('analysed ' + analysisSelectionLabel(S.image, value));
    const mode = sel.merge ? 'normal' : channelMode(prim);
    const p = paramsForMode(params(), mode);
    const modeLabel = mode === 'axon' ? 'Axon-heavy' : mode === 'donut' ? 'Donut' : 'Normal';
    const currentViewLabel = analysisSelectionLabel(S.image, $('chDetect').value);
    analysisProgressStart(mode, `${currentViewLabel} · ${modeLabel}`);
    setBusy(true, `Analysing ${currentViewLabel} · ${S.image.name}`);
    S.lastRun = { params: p, px: +$('pxSize').value, when: new Date().toISOString(),
        detect: (S.compUsed || []).join(' + '), detectionMode: mode };
    if (dense)
        S.lastRun.countedDespiteDensity = { density: S.image.axonDense[prim], limit: AUTO_AXON_HEAVY_DENSITY_CUT };
    const msg = { type: 'run', id: S.image.key, w: ch[0].w, h: ch[0].h,
        channels: arrays.map(a => a.slice(0)),
        params: Object.assign({}, p, { colocIdx: S.colocIdx || [], detectKey: $('chDetect').value }) };
    if (mode === 'axon') {
        const supportIdx = axonGuideIndices(S.image, prim), saved = savedAxonGuideGroups(S.image, prim), savedIdx = new Set(saved.map(g => g.index));
        const missing = supportIdx.filter(i => !savedIdx.has(i));
        if (saved.length)
            msg.supportCellGroups = saved.map(g => ({ mode: g.mode, name: g.name, cells: g.cells }));
        /* Normally batch/selected analysis has already produced every guide, so
           Axon-heavy receives only small saved cell lists. Raw channels are sent
           solely as a backwards-compatible fallback if a guide is genuinely
           missing (for example an older in-memory session). */
        msg.supportChannels = missing.map(i => ch[i].data.slice(0));
        msg.supportModes = missing.map(i => channelMode(i));
        msg.supportNames = missing.map(i => ch[i].name || ('Channel ' + (i + 1)));
    }
    const result = await workerClient.request(msg);
    return result ? S.cells.length : null;
}
function refilter() {
    if (!S.image || S.busy || !S.cells.length)
        return;
    const sel = parseDetect(), mode = sel.merge ? 'normal' : channelMode(sel.idx[0]);
    if (mode === 'axon' || !sectionHasFullPixels(S.image)) {
        runAnalysis().then(() => finalizeSectionReview(S.image)).catch(e => setStatus(e.message || String(e)));
        return;
    }
    snapshot('changed limits for ' + analysisSelectionLabel(S.image, $('chDetect').value));
    setBusy(true, 'Applying limits');
    workerClient.request({ type: 'refilter',
        params: Object.assign({}, paramsForMode(params(), mode), { colocIdx: S.colocIdx || [], detectKey: $('chDetect').value }) }).catch(err => { setBusy(false); setStatus(err.message || String(err)); });
}
let backgroundBatchUiDirty = false;
function analysisPageVisible() { return document.visibilityState !== 'hidden'; }
function refreshBackgroundBatchUi() {
    if (!backgroundBatchUiDirty || !analysisPageVisible() || !S.image)
        return;
    backgroundBatchUiDirty = false;
    syncChannelButtons();
    renderModeButtons();
    if (densityMode() === 'auto')
        applyDensity(false);
    renderDensityNote();
    describeImage();
    drawBase();
    drawOverlay();
    updateStats();
    renderRegions();
    renderRegionTable();
    renderSectionAnalysisSummary(S.image);
    syncDisplayResolutionButtons();
    if (analysisProgressState && $('apContext'))
        $('apContext').textContent = analysisProgressContextText();
}
document.addEventListener('visibilitychange', () => {
    if (analysisPageVisible())
        requestAnimationFrame(refreshBackgroundBatchUi);
});
function paintAnalysisView() { if (!analysisPageVisible())
    backgroundBatchUiDirty = true; return ToolkitCore.runtime.paint({ frames: 2, timeoutMs: 180, hiddenMode: 'skip' }); }
async function runEveryViewInCurrentSection() {
    if (!S.image || S.busy)
        return 0;
    const sec = S.image;
    await settleAutoModes(sec);
    if (S.image !== sec || S.busy)
        return 0;
    const original = $('chDetect').value;
    const originalViewMode = $('viewMode').value;
    const originalMergePreview = !!S.mergePreview;
    const listedValues = [...$('chDetect').options].map(o => o.value).filter(v => /^c\d+$|^m\d+(?:-\d+)+$/.test(v));
    /* Axon-heavy depends on saved Normal/Donut guide detections. Run all guide
       singles first, Axon-heavy singles second, then composites. This eliminates
       the old hidden duplicate guide-detector pass inside Axon-heavy. */
    const values = orderedBatchAnalysisValues(sec, listedValues);
    let done = 0;
    for (let viewIndex = 0; viewIndex < values.length; viewIndex++) {
        const value = values[viewIndex];
        if (S.image !== sec)
            break;
        tabProgressView(viewIndex, values.length);
        saveResult();
        /* Batch analysis must show the exact image being analysed.  Temporarily
           leave the opening full-merge Colour preview and draw from chDetect: one
           channel for cN, or that exact composite for mN-N. */
        S.mergePreview = false;
        $('viewMode').value = 'image';
        $('chDetect').value = value;
        syncChannelButtons();
        renderModeButtons();
        if (densityMode() === 'auto')
            applyDensity(false);
        renderDensityNote();
        describeImage();
        restoreCurrentResult();
        if (analysisPageVisible()) {
            drawBase();
            drawOverlay();
            updateStats();
            renderRegions();
            renderRegionTable();
        }
        else
            backgroundBatchUiDirty = true;
        const viewLabel = analysisSelectionLabel(sec, value);
        setStatus(`Preparing ${viewLabel} for analysis…`);
        markDirty(false);
        progress(true, 100 * done / Math.max(1, values.length));
        await paintAnalysisView();
        const n = await runAnalysis();
        tabProgressViewDone();
        if (n != null)
            done++;
    }
    saveResult();
    $('chDetect').value = original;
    $('viewMode').value = originalViewMode;
    S.mergePreview = originalMergePreview;
    syncChannelButtons();
    renderModeButtons();
    if (densityMode() === 'auto')
        applyDensity(false);
    renderDensityNote();
    describeImage();
    restoreCurrentResult();
    if (analysisPageVisible()) {
        drawBase();
        drawOverlay();
        updateStats();
        renderRegions();
        renderRegionTable();
    }
    else
        backgroundBatchUiDirty = true;
    markDirty(false);
    progress(false);
    renderFileList();
    return done;
}
/* " FITC (a) is dense with axons and neuropil; check its count." for a run's status. */
function denseViewsNote(sections) {
    const names = [];
    for (const sec of sections)
        (sec.channels || []).forEach((_, i) => {
            const r = S.results.get(analysisKey(sec, 'c' + i));
            if (r && r.run && r.run.countedDespiteDensity)
                names.push(sections.length > 1 ? `${analysisSelectionLabel(sec, 'c' + i)} (${sec.name})` : analysisSelectionLabel(sec, 'c' + i));
        });
    return names.length ? ` ${names.join(', ')} ${names.length === 1 ? 'is' : 'are'} dense with axons and neuropil, so check ${names.length === 1 ? 'its count' : 'their counts'}: some fibres may be counted as somata.` : '';
}
async function runSection() {
    if (!S.image || S.busy || S.run)
        return;
    return holdRun('the analysis of ' + S.image.name, runSectionNow);
}
async function runSectionNow() {
    const sec = S.image;
    tabProgressStart('section');
    try {
        const done = await runEveryViewInCurrentSection();
        sec.analysisSummaryReady = true;
        renderSectionAnalysisSummary(sec);
        await finalizeSectionReview(sec);
        setStatus(`Analysed ${done} channel/composite view${done === 1 ? '' : 's'} for ${sec.name}.${denseViewsNote([sec])}`);
    }
    finally {
        tabProgressFinish();
    }
}
async function runAll() {
    if (!S.sections.length || S.busy || S.run)
        return;
    return holdRun('the analysis of all images', runAllNow);
}
async function runAllNow() {
    const originalIdx = S.idx;
    const originalNames = S.image ? selectionNames() : [];
    let sectionsDone = 0, analysesDone = 0;
    tabProgressStart('all', S.sections.length);
    try {
        for (let i = 0; i < S.sections.length; i++) {
            tabProgressSection(i, S.sections.length);
            await activate(i);
            if (!S.image || S.idx !== i)
                continue;
            const n = await runEveryViewInCurrentSection();
            if (S.image) {
                S.image.analysisSummaryReady = true;
                renderSectionAnalysisSummary(S.image);
                await finalizeSectionReview(S.image);
            }
            analysesDone += n;
            sectionsDone++;
        }
        if (originalIdx >= 0 && originalIdx < S.sections.length) {
            tabProgressSection(S.sections.length, S.sections.length);
            await activate(originalIdx, originalNames);
            if (originalNames.length)
                selectChannelsByNames(originalNames);
            restoreCurrentResult();
            drawBase();
            drawOverlay();
            updateStats();
            renderRegions();
            renderRegionTable();
        }
        progress(false);
        renderFileList();
        setStatus(`Analysed all ${analysesDone} channel/composite views across ${sectionsDone} section${sectionsDone === 1 ? '' : 's'}.${denseViewsNote(S.sections)}`);
    }
    finally {
        tabProgressFinish();
    }
}
function cloneCellSnapshot(c) {
    if (!c || typeof c !== 'object')
        return c;
    const q = Object.assign({}, c);
    if (Array.isArray(c.z))
        q.z = c.z.slice();
    if (Array.isArray(c.coloc))
        q.coloc = c.coloc.slice();
    return q;
}
function saveResult(valueOverride = null) {
    if (!S.image)
        return;
    S.image.regions = S.regions;
    if (!S.lastRun && !S.cells.length && !S.autoCount && !S.manualRemoved) {
        renderFileList();
        return;
    }
    const value = valueOverride == null ? $('chDetect').value : valueOverride;
    const key = analysisKey(S.image, value);
    S.results.set(key, { sectionKey: S.image.key, sectionName: S.image.name, analysisValue: value,
        selection: analysisSelectionLabel(S.image, value), modeSignature: analysisModeSignature(S.image, value),
        regions: S.regions, cells: (S.cells || []).map(cloneCellSnapshot), allCells: Array.isArray(S.allCells) ? S.allCells.map(cloneCellSnapshot) : S.allCells, run: S.lastRun,
        removed: S.manualRemoved || 0, autoCount: S.autoCount || 0,
        rej: S.rej, seeds: S.seeds, decisions: S.decisions || [],
        chanOrder: S.chanOrder, colocIdx: S.colocIdx || [], compUsed: S.compUsed || [],
        floorValue: +$('minContrast').value, floorMin: +$('minContrast').min,
        floorMax: +$('minContrast').max, floorStep: +$('minContrast').step,
        floorTouched: !!S.floorTouched, floorAuto: !!S.floorAuto, autoFloorRef: S.autoFloorRef,
        colocFloorValue: +$('colocFloor').value, colocFloorTouched: !!S.colocFloorTouched, colocFloorAuto: !!S.colocFloorAuto, autoColocFloorRef: S.autoColocFloorRef,
        removedAutoIds: [...(S.removedAutoIds || [])],
        /* Which Z layers the analysed projection was made from (null: all). */
        zLayers: Array.isArray(S.image.zLayers) ? S.image.zLayers.slice() : null,
        zAlign: !!S.image.zAlign,
        w: S.image.channels[0].w, h: S.image.channels[0].h });
    renderFileList();
    renderModeButtons();
    if (S.image && S.image.analysisSummaryReady)
        renderSectionAnalysisSummary(S.image);
    ['expCells', 'expSummary', 'expRun', 'expPng'].forEach(id => $(id).disabled = !S.cells.length);
    syncTiffExportButtons();
}

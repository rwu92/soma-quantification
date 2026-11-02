'use strict';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const PALETTE = ['#5ad3b0', '#6fa8f5', '#e8b563', '#f2778a', '#c78bf0', '#7fd9e8', '#b6e07a', '#f0a06a'];
const S = {
    sections: [], idx: -1, image: null, cells: [], regions: [], activeRegion: -1,
    tool: 'add', zoom: 1, fit: 1, showOv: true, showRegions: true, busy: false, run: null, worker: null,
    z: null, soma: null, rej: null, seeds: 0, poly: [], queue: [], qi: 0, dirty: false,
    results: new Map(), lastRun: null, removedAutoIds: new Set(), activeAnalysisValue: null,
    colocFloorTouched: false, colocFloorAuto: false,
    autoFloorRef: null, autoColocFloorRef: null,
    /* Display-only state.  A newly loaded multichannel image opens as the full
       colour merge, so no individual channel button should appear selected even
       though chDetect still holds a sensible detector default underneath. */
    mergePreview: false,
    /* Last pointer position inside the microscopy viewport.  Keyboard zoom uses
       this screen-space point so the image location under the cursor stays put. */
    zoomCursor: null,
    /* Review display can use a half-resolution copy while all scientific
       coordinates remain in the original native pixel coordinate system. */
    displayScaleX: 1, displayScaleY: 1
};
/* ---------------------------- worker ---------------------------------- */
let workerClient = null;
function initWorker() {
    S.worker = new Worker('assets/soma-detector-worker.js');
    workerClient = ToolkitCore.worker.createRequestClient(S.worker, { onEvent: (m, e) => onWorkerMessage(e), isFinal: m => m.type === 'result', isError: m => m.type === 'error' });
    S.worker.onerror = e => { setEngine('err', 'worker failed'); setStatus('Worker error: ' + e.message); setBusy(false); workerClient?.close(new Error(e.message || 'Soma detector worker failed.')); resolveAllAutoDonutProbes('detector worker failed'); };
}
const autoDonutProbeResolvers = new Map();
function resolveAllAutoDonutProbes(reason) {
    for (const [token, r] of autoDonutProbeResolvers) {
        autoDonutProbeResolvers.delete(token);
        r({ type: 'autoDonutProbeResult', token, probe: null, error: reason });
    }
}
function onWorkerMessage(e) {
    const m = e.data;
    if (m.type === 'autoDonutProbeResult') {
        const r = autoDonutProbeResolvers.get(m.token);
        if (r) {
            autoDonutProbeResolvers.delete(m.token);
            r(m);
        }
        return;
    }
    if (m.type === 'stage') {
        setStatus(m.msg + '…');
        analysisProgressStage(m);
        tabProgressStage(m.msg, m.pct);
        return;
    }
    if (m.type === 'checkpoint') {
        analysisProgressCheckpoint(m.msg);
        return;
    }
    if (m.type === 'error') {
        setStatus('Detection failed: ' + m.msg);
        setEngine('err', 'error');
        setBusy(false);
        return;
    }
    if (m.type === 'result') {
        S.allCells = m.cells.map((c, i) => Object.assign(c, { id: i + 1, region: -1 }));
        fitContrastSlider();
        if (!S.floorTouched)
            placeFloorAutomatically();
        fitColocFloorSlider();
        if (parseDetect().merge && !S.colocFloorTouched)
            placeColocFloorAutomatically();
        drawColocHist();
        syncLabels();
        S.cells = S.allCells.filter(c => passesFloor(c) && passesColocFloor(c));
        syncColocFloorVisibility();
        S.manualRemoved = 0;
        S.removedAutoIds = new Set();
        updateUndo();
        S.autoCount = m.cells.length;
        if (!S.decisions)
            S.decisions = [];
        S.rej = m.rej;
        if (S.lastRun)
            S.lastRun.classifier = m.rej && m.rej.modelId
                ? Object.assign({ id: m.rej.modelId, sha256: m.rej.modelSha256, threshold: m.rej.modelThreshold, imageQuality: m.rej.modelImageQuality, insideValidatedRange: !!m.rej.modelInDomain },
                    m.rej.modelEngine ? { engine: m.rej.modelEngine, centres_on_detector_candidates: m.rej.netMatched, centres_measured_alone: m.rej.netOwn } : {})
                : { id: 'rules' };
        S.seeds = m.seeds;
        if (m.z) {
            S.z = m.z;
            S.soma = m.soma;
        }
        assignRegions();
        buildQueue();
        saveResult();
        drawBase();
        drawOverlay();
        updateStats();
        updateColoc();
        renderRegionTable();
        analysisProgressFinish(m);
        setBusy(false);
        setStatus(`${S.cells.length} somata · ${m.seeds} candidate seeds${m.cached ? ' · filters only' : ''}${m.rej && m.rej.modelId ? ` · ${m.rej.modelId}${m.rej.modelInDomain ? '' : (m.rej.modelEngine ? ' · minimum diameter OUTSIDE validated range' : ' · image quality OUTSIDE validated range')}` : ''}`);
        setEngine('ok', 'ready');
    }
}
/* ---------------------------- params ---------------------------------- */
function params() {
    const dMin = +$('dMin').value, dMax = Math.max(dMin + 2, +$('dMax').value);
    return {
        dMin, dMax,
        snr: +$('snr').value / 10,
        minWidth: +$('thin').value,
        minContrast: 0, /* applied on this side, live, from the slider */
        fillHoles: $('fillHoles').checked,
        satRescue: $('satRescue').checked,
        legacyForests: $('legacyForests').checked,
        cellModel: $('cellModel').value,
        colocMode: (parseDetect().merge ? 'coloc' : 'all'),
        colocThr: +$('colocThr').value / 100,
        minFill: +$('minFill').value / 100,
        bleed: +$('bleed').value / 100,
        thin: +$('thin').value * 0.375, // opening radius: deliberately a little
        // permissive so that a soma sitting right on
        // the limit is not erased before it can be
        // measured properly
        sep: +$('split').value / 100 * dMin,
        maxAspect: +$('maxAspect').value / 10,
        edgeMargin: +$('edge').value,
        areaLo: +$('areaLo').value, areaHi: +$('areaHi').value
    };
}
function um(px) {
    const s = +$('pxSize').value;
    return s > 0 ? ` · ${(px * s).toFixed(1)} µm` : '';
}
function syncLabels() {
    const dMin = +$('dMin').value;
    let dMax = +$('dMax').value;
    if (dMax <= dMin + 2) {
        dMax = dMin + 2;
        $('dMax').value = dMax;
    }
    const p = params();
    $('dMinV').textContent = dMin;
    $('dMinU').textContent = um(dMin);
    $('dMaxV').textContent = dMax;
    $('dMaxU').textContent = um(dMax);
    $('snrV').textContent = p.snr.toFixed(1);
    $('thinV').textContent = p.minWidth.toFixed(0);
    $('thinU').textContent = um(p.minWidth);
    $('splitV').textContent = p.sep.toFixed(0);
    $('edgeV').textContent = p.edgeMargin;
    $('edgeU').textContent = um(p.edgeMargin);
    const cf = contrastFloor(), cLo = +($('minContrast') || { min: 0 }).min || 0;
    $('minContrastV').textContent = (cf > cLo) ? ('\u2265 ' + cf) : 'off';
    const wf = colocFloor();
    if ($('colocFloorV'))
        $('colocFloorV').textContent = wf > 0 ? ('\u2265 ' + Math.round(wf * 100) + '%') : 'off';
    $('maxAspectV').textContent = p.maxAspect.toFixed(1);
    $('colocThrV').textContent = $('colocThr').value;
    $('minFillV').textContent = $('minFill').value;
    $('bleedV').textContent = $('bleed').value;
}
/* ------------------------- file loading -------------------------------- */
const EXT = n => (n.split('.').pop() || '').toLowerCase();
function sectionKeyOf(name) {
    return name.replace(/\.[^.]+$/, '').replace(/[_-]?C[_-]?\d+$/i, '').replace(/[_-]?ch\d+$/i, '');
}
function channelLabel(name) {
    const m = name.replace(/\.[^.]+$/, '').match(/(?:C|ch)[_-]?(\d+)$/i);
    return m ? ('Channel ' + m[1]) : name.replace(/\.[^.]+$/, '').slice(-18);
}
function handleFiles(list) {
    /* "._" files are the Finder metadata macOS writes beside each file on an
       exFAT or FAT drive: same name and extension, no image. Picked up with a
       folder, one joined its real file's section and broke its decode. */
    const all = [...list], sidecars = all.filter(f => String(f.name || '').startsWith('._')).length;
    const files = all.filter(f => !String(f.name || '').startsWith('._') && ['png', 'jpg', 'jpeg', 'tif', 'tiff', 'nd2', 'zip'].includes(EXT(f.name)));
    if (sidecars)
        setStatus(`Skipped ${sidecars} macOS “._” sidecar file${sidecars === 1 ? '' : 's'} (Finder metadata, not images).`);
    if (!files.length) {
        setStatus('Choose PNG, JPEG, TIFF or ND2 files, or a zip of TIFFs exported here.');
        return;
    }
    if (S.busy || S.run) {
        setStatus(`Wait for ${S.run || 'the current step'} to finish, then add the images again.`);
        return;
    }
    /* TIFFs saved here (loose or in their zip) are put back together as the
       images they came from (14-saved-tiffs); the rest open as usual. */
    gatherSavedTiffs(files).then(({ sets, rest }) => {
        const saved = sets.map(savedSet => ({ file: savedSet.heads[0].file, savedSet }));
        if (!saved.length && !rest.length) {
            setStatus('That zip holds no images.');
            return;
        }
        /* A multipoint ND2 first opens the points window (12-nd2-points); each
           point chosen there becomes a section of its own. */
        if (rest.some(f => EXT(f.name) === 'nd2')) {
            expandMultipointNd2(rest).then(entries => {
                if (entries.length || saved.length)
                    buildSections(saved.concat(entries));
                else
                    setStatus('No points were chosen, so nothing was opened.');
            }).catch(e => {
                setStatus('Could not check the ND2 for points (' + (e && e.message || e) + '); opened it whole.');
                buildSections(saved.concat(rest.map(file => ({ file }))));
            });
            return;
        }
        buildSections(saved.concat(rest.map(file => ({ file }))));
    }).catch(e => setStatus('Could not open those files (' + (e && e.message || e) + ').'));
}
/* Images opened later join the list: the ones already open stay, with their
   analyses, and the first new one is shown. An image already in the list is
   not added twice. */
function buildSections(entries) {
    const open = new Set(S.sections.map(s => s.key)), map = new Map(), already = new Set();
    for (const { file: f, point, savedSet } of entries) {
        const k = savedSet ? savedSet.name : point ? sectionKeyOf(f.name) + ' · ' + point.label : sectionKeyOf(f.name);
        if (open.has(k)) {
            already.add(k);
            continue;
        }
        if (!map.has(k))
            map.set(k, { key: k, name: k || f.name, files: [], state: '', channels: null, reviewChannels: null, displayResolution: 'full', displayResolutionManual: false, fullReleased: false, point: point || null });
        const sec = map.get(k);
        if (savedSet) {
            sec.savedSet = savedSet;
            sec.files = savedSet.heads.map(h => h.file);
            /* What it was exported from, so exporting it again files it the same way. */
            sec.sourceFiles = (savedSet.heads.find(h => h.state && h.state.sourceFiles) || { state: {} }).state.sourceFiles || null;
        }
        else
            sec.files.push(f);
    }
    for (const s of map.values())
        s.files.sort((a, b) => a.name.localeCompare(b.name));
    const added = [...map.values()], first = S.sections.length;
    S.sections = S.sections.concat(added);
    releaseSomaPointMounts(new Set(S.sections.filter(s => s.point).flatMap(s => s.files)));
    if (!added.length) {
        setStatus(already.size === 1 ? 'That image is already open.' : 'Those images are already open.');
        return;
    }
    renderFileList();
    if (already.size)
        setStatus(`Skipped ${already.size} image${already.size === 1 ? '' : 's'} already open.`);
    activate(first);
}
function resultsForSection(sec) {
    if (!sec)
        return [];
    return [...S.results.values()].filter(r => r && r.sectionKey === sec.key);
}
function renderFileList() {
    const el = $('fileList');
    el.innerHTML = '';
    el.hidden = !S.sections.length;
    $('drop').hidden = !!S.sections.length;
    $('addImages').hidden = !S.sections.length;
    $('fileCount').textContent = S.sections.length ? `${S.sections.length} section${S.sections.length > 1 ? 's' : ''}` : '';
    S.sections.forEach((s, i) => {
        const r = document.createElement('div');
        r.className = 'row' + (i === S.idx ? ' cur' : '');
        const saved = resultsForSection(s);
        const nSaved = saved.length;
        r.innerHTML = `<span class="nm" title="${s.files.map(f => f.name).join('\n')}">${s.name || '(section)'}</span>
      <span class="st ${nSaved ? 'done' : ''}">${nSaved ? (nSaved + ' saved') : s.savedSet ? s.files.length + ' TIFF' + (s.files.length === 1 ? '' : 's') : s.files.length + 'ch'}</span>`;
        r.onclick = () => openListed(i);
        const x = document.createElement('button');
        x.type = 'button';
        x.className = 'row-x';
        x.textContent = '×';
        x.title = 'Remove this image';
        x.setAttribute('aria-label', 'Remove ' + (s.name || 'this image'));
        x.onclick = e => {
            e.stopPropagation();
            askRemoveSection(i);
        };
        r.appendChild(x);
        el.appendChild(r);
    });
}
/* Removing an image from the session: the × on its row, after a warning that
   can be turned off ("Don't show this again", or in Settings). Its analyses,
   hand corrections, regions and undo steps go with it; its files are not
   touched. Not while something runs. */
let removePending = null;
function askRemoveSection(i) {
    const sec = S.sections[i];
    if (!sec)
        return;
    if (S.busy || S.run) {
        setStatus(`Wait for ${S.run || 'the current step'} to finish, then remove ${sec.name}.`);
        return;
    }
    if (!somaSettings.confirmRemove) {
        removeSection(i);
        return;
    }
    const n = resultsForSection(sec).length;
    $('removeText').textContent = `${sec.name || 'This image'} will be removed from this session, along with its ` +
        (n ? `${n} saved analys${n === 1 ? 'is' : 'es'}, ` : '') + 'hand corrections and regions. This cannot be undone. The files on your computer are not touched.';
    $('removeNoAsk').checked = false;
    removePending = sec;
    $('removeModal').classList.add('show');
    $('removeCancel').focus({ preventScroll: true });
}
function closeRemoveModal() {
    removePending = null;
    $('removeModal').classList.remove('show');
}
$('removeCancel').onclick = closeRemoveModal;
$('removeModal').addEventListener('pointerdown', e => { if (e.target === $('removeModal'))
    closeRemoveModal(); });
$('removeConfirm').onclick = () => {
    const i = S.sections.indexOf(removePending);
    if ($('removeNoAsk').checked) {
        somaSettings.confirmRemove = false;
        saveSomaSettings();
    }
    closeRemoveModal();
    removeSection(i);
};
/* While the warning is open its keys are its own: Esc cancels. */
window.addEventListener('keydown', e => {
    if (!$('removeModal').classList.contains('show'))
        return;
    e.stopImmediatePropagation();
    if (e.key === 'Escape') {
        e.preventDefault();
        closeRemoveModal();
    }
}, true);
function removeSection(i) {
    const sec = S.sections[i];
    if (!sec || S.busy || S.run)
        return;
    const wasOpen = i === S.idx;
    if (wasOpen && sbsOpen())
        closeSideBySide();
    for (const [k, r] of [...S.results])
        if (r && r.sectionKey === sec.key)
            S.results.delete(k);
    S.sections.splice(i, 1);
    if (!wasOpen) {
        if (i < S.idx)
            S.idx--;
        renderFileList();
        setStatus(`Removed ${sec.name}.`);
        return;
    }
    /* The open image: nothing of it is saved on the way out. Open its
       neighbour, or go back to the empty page if it was the last. */
    S.idx = -1;
    S.image = null;
    if (S.sections.length) {
        activate(Math.min(i, S.sections.length - 1));
        return;
    }
    Object.assign(S, { cells: [], queue: [], qi: 0, regions: [], activeRegion: -1, poly: [], lastRun: null, removedAutoIds: new Set(), activeAnalysisValue: null, mergePreview: false, dirty: false });
    for (const id of ['base', 'ov']) {
        const c = $(id);
        c.getContext('2d').clearRect(0, 0, c.width, c.height);
    }
    $('stage').style.display = 'none';
    $('blank').style.display = '';
    ['runSelectedBtn', 'runBtn', 'runAllBtn'].forEach(id => { $(id).disabled = true; });
    renderFileList();
    updateStats();
    renderRegions();
    renderRegionTable();
    updateUndo();
    setStatus(`Removed ${sec.name}. Drop images on the left to start again.`);
}
/* The thin bar over the image, and the site's loading bar with its
   percentage and tab title for the same work (an analysis has its own). */
let progressJob = null;
function progress(on, pct) {
    $('prog').classList.toggle('on', !!on);
    if (pct != null)
        ToolkitCore.ui.setProgress({ bar: $('prog').firstElementChild, pct });
    if (on && !progressJob && !tabAnalysisProgress)
        progressJob = ToolkitCore.progress.start(($('engTxt') && $('engTxt').textContent) || 'Working');
    else if (!on && progressJob) {
        progressJob.end();
        progressJob = null;
    }
    if (progressJob)
        progressJob.set(pct != null ? pct / 100 : null, $('engTxt') ? $('engTxt').textContent : null);
}
/* -------------------- full-resolution analysis / reduced review -------- */
/* Review display can be shown at a reduced resolution to save memory. The
   choice is display-only: analysis, thresholds and cell coordinates always use
   the native pixels. The last scale picked is remembered for new sections.   */
const REVIEW_SCALES = [0.25, 1 / 3, 0.5, 0.75];
const REVIEW_SCALE_KEY = 'soma.reviewScale';
function loadReviewScale() {
    try {
        const raw = localStorage.getItem(REVIEW_SCALE_KEY);
        if (raw === 'full')
            return { scale: 0.5, full: true };
        const hit = REVIEW_SCALES.find(s => Math.abs(s - +raw) < 1e-6);
        if (hit)
            return { scale: hit, full: false };
    }
    catch (e) { }
    return { scale: 0.5, full: false };
}
{
    const pref = loadReviewScale();
    S.reviewScale = pref.scale;
    /* Full is a choice like any other: if that is what was picked, the section
       being looked at stays native after its analysis. */
    S.reviewPrefersFull = pref.full;
}
function setPreferredReviewScale(scale) {
    if (scale)
        S.reviewScale = scale;
    S.reviewPrefersFull = !scale;
    try {
        localStorage.setItem(REVIEW_SCALE_KEY, scale ? String(scale) : 'full');
    }
    catch (e) { }
}
function reviewScaleLabel(scale) {
    return Math.round(scale * 100) + '%';
}
function sectionHasFullPixels(sec) {
    return !!(sec && Array.isArray(sec.channels) && sec.channels.length && sec.channels.every(c => c && c.data && c.data.length === c.w * c.h));
}
function sectionHasReviewPixels(sec) {
    return !!(sec && Array.isArray(sec.reviewChannels) && sec.reviewChannels.length === sec.channels.length && sec.reviewChannels.every(c => c && c.data && c.data.length === c.w * c.h));
}
/* Area-average weights along one axis: output pixel i covers source span
   [i/scale, (i+1)/scale), clipped to the image, each source pixel weighted by
   its overlap. At 50% this is the plain 2x2 mean the review copy always used. */
function reviewAxisWeights(sn, dn, scale) {
    const step = 1 / scale, idx = [], wts = [];
    for (let i = 0; i < dn; i++) {
        const a = i * step, b = Math.min(sn, (i + 1) * step), ii = [], ww = [];
        let tot = 0;
        for (let k = Math.floor(a); k < b; k++) {
            const w = Math.min(b, k + 1) - Math.max(a, k);
            if (w > 1e-9)
                ii.push(k), ww.push(w), tot += w;
        }
        idx.push(ii);
        wts.push(ww.map(w => w / tot));
    }
    return { idx, wts };
}
function downsampleForReview(c, scale) {
    const sw = c.w | 0, sh = c.h | 0, dw = Math.max(1, Math.ceil(sw * scale - 1e-9)), dh = Math.max(1, Math.ceil(sh * scale - 1e-9));
    const src = c.data, tmp = new Float32Array(dw * sh), out = new Float32Array(dw * dh);
    const X = reviewAxisWeights(sw, dw, scale), Y = reviewAxisWeights(sh, dh, scale);
    for (let y = 0; y < sh; y++) {
        const row = y * sw, orow = y * dw;
        for (let x = 0; x < dw; x++) {
            const ii = X.idx[x], ww = X.wts[x];
            let sum = 0;
            for (let k = 0; k < ii.length; k++)
                sum += src[row + ii[k]] * ww[k];
            tmp[orow + x] = sum;
        }
    }
    for (let y = 0; y < dh; y++) {
        const ii = Y.idx[y], ww = Y.wts[y], orow = y * dw;
        for (let x = 0; x < dw; x++) {
            let sum = 0;
            for (let k = 0; k < ii.length; k++)
                sum += tmp[ii[k] * dw + x] * ww[k];
            out[orow + x] = sum;
        }
    }
    const q = Object.assign({}, c, { w: dw, h: dh, data: out, reviewOnly: true, reviewScale: scale, nativeW: sw, nativeH: sh });
    return q;
}
/* Make sure a review copy exists at the requested scale. It can only be
   (re)built from native pixels; without them an existing copy is kept as is. */
function ensureReviewCopy(sec, scale = S.reviewScale) {
    if (!sec)
        return false;
    if (sectionHasReviewPixels(sec) && sec.reviewScale === scale)
        return true;
    if (!sectionHasFullPixels(sec))
        return sectionHasReviewPixels(sec);
    sec.reviewChannels = sec.channels.map(c => downsampleForReview(c, scale));
    sec.reviewScale = scale;
    return true;
}
function currentDisplayChannels(sec = S.image) {
    if (!sec || !sec.channels)
        return [];
    if (sec.displayResolution === 'reduced' && sectionHasReviewPixels(sec)) {
        /* Colours can be reassigned after the review copy was created. Keep the
           review metadata synchronized while its pixels remain independent. */
        sec.reviewChannels.forEach((c, i) => { if (sec.channels[i]) {
            c.name = sec.channels[i].name;
            c.color = sec.channels[i].color;
            c.inverted = sec.channels[i].inverted;
            c.fromMerge = sec.channels[i].fromMerge;
            c.top = sec.channels[i].top;
        } });
        return sec.reviewChannels;
    }
    return sec.channels;
}
function syncDisplayResolutionButtons() {
    const sel = $('displayScale');
    if (!sel)
        return;
    const sec = S.image, reduced = !!(sec && sec.displayResolution === 'reduced' && sectionHasReviewPixels(sec));
    const scale = reduced ? sec.reviewScale : null;
    sel.value = sec
        ? (reduced ? String(REVIEW_SCALES.find(s => s === scale) ?? S.reviewScale) : 'full')
        : (S.reviewPrefersFull ? 'full' : String(S.reviewScale));
    sel.classList.toggle('on', !!sec && reduced);
    /* Adjustable with no image open too, where it sets what review opens at --
       it used to sit greyed out showing a percentage that could not be changed.
       A running analysis is the only thing that locks it, and it says so rather
       than silently snapping back to the old value. */
    sel.disabled = !!S.busy;
    sel.title = S.busy
        ? 'Locked while an analysis is running. It can be changed as soon as that finishes.'
        : !sec
            ? `Review display resolution for the images you open: ${S.reviewPrefersFull ? 'Full' : reviewScaleLabel(S.reviewScale)}. Analysis always uses the native full-resolution pixels.`
            : reduced
                ? `${reviewScaleLabel(scale)} review display. Analysis and saved coordinates stay full resolution. Lower uses less memory.`
                : (sectionHasFullPixels(sec) ? 'Native full-resolution display is loaded. Pick a percentage to review at lower resolution and use less memory.' : 'Choosing Full reloads the native full-resolution pixels for review. Analysis is not rerun.');
}
async function decodeSectionFullChannels(sec) {
    const chans = sec.savedSet ? await decodeSavedTiffSet(sec) : [];
    sec.imagejImport = null;
    for (const f of sec.savedSet ? [] : sec.files) {
        /* The section's own Z layers, every time -- including the reload an
           analysis makes after the pixels were released -- so what is analysed
           is always what is shown. */
        const r = await decodeToGray(f, { zLayers: sec.zLayers || null, zAlign: sec.zAlign == null ? (zAutoAlignOn() ? 'auto' : false) : !!sec.zAlign, point: sec.point ? sec.point.index : null });
        if (Array.isArray(r))
            r.forEach(c => chans.push(c));
        else {
            const ex = r && r._imagej, st = ex && ex.somaState;
            const nm = st && st.selection ? String(st.selection) : channelLabel(f.name);
            const c = Object.assign(r, { name: nm, file: f.name });
            chans.push(c);
            if (ex && (ex.somaState || (ex.roiPoints && ex.roiPoints.length)))
                sec.imagejImport = { file: f, extras: ex };
        }
    }
    if (!chans.length)
        throw new Error('That section decoded to no channels.');
    const w = chans[0].w, h = chans[0].h;
    if (!(w > 0 && h > 0))
        throw new Error('That file decoded to an empty image.');
    if (chans.some(c => c.w !== w || c.h !== h))
        throw new Error('Channels in this section have different dimensions.');
    const old = sec.channels || [];
    chans.forEach((c, i) => {
        if (old[i]) {
            for (const k of ['color', '_autoDonutProbe', '_dens', '_cov'])
                if (old[i][k] != null)
                    c[k] = old[i][k];
        }
    });
    sec.channels = chans;
    sec.fullReleased = false;
    /* The first decode of a Z-stack looked for doubling: from now on the section
       keeps what it found, so every later decode shows the same pixels. */
    if (sec.zAlign == null) {
        sec.zAlign = !!chans[0].zAlign;
        sec.zAutoCheck = chans[0].zCheck || null;
    }
    return chans;
}
async function ensureFullSectionPixels(sec = S.image, reason = 'analysis') {
    if (!sec)
        return false;
    if (sectionHasFullPixels(sec))
        return true;
    const wasCurrent = S.image === sec, ownBusy = !S.busy;
    if (ownBusy)
        setBusy(true, `Reloading ${sec.name}`);
    setEngine('busy', 'restoring full-resolution ND2');
    setStatus(`Reloading ${sec.name} at full resolution for ${reason}…`);
    progress(true, 12);
    try {
        await decodeSectionFullChannels(sec);
        setEngine('ok', 'ready');
        if (wasCurrent) {
            fillChannelSelects();
            assignColours();
            renderChannelButtons();
            renderModeButtons();
            if (sec.displayResolution === 'full') {
                drawBase();
                fitView();
                drawOverlay();
            }
            syncDisplayResolutionButtons();
        }
        return true;
    }
    finally {
        progress(false);
        if (ownBusy)
            setBusy(false);
    }
}
function releaseFullSectionPixels(sec = S.image) {
    if (!sec || !sectionHasReviewPixels(sec) || !Array.isArray(sec.channels))
        return false;
    for (const c of sec.channels)
        c.data = null;
    sec.fullReleased = true;
    if (S.image === sec) {
        S.z = null;
        S.soma = null;
    }
    if (S.worker)
        S.worker.postMessage({ type: 'clearCache' });
    return true;
}
async function switchDisplayResolution(mode, manual = true, scale = S.reviewScale) {
    const sec = S.image;
    if (!sec || S.busy) {
        syncDisplayResolutionButtons();
        if (S.busy)
            setStatus('Display resolution cannot change while an analysis is running · try again when it finishes.');
        return;
    }
    if (manual)
        sec.displayResolutionManual = true;
    if (mode === 'reduced') {
        const label = reviewScaleLabel(scale);
        if (!(sectionHasReviewPixels(sec) && sec.reviewScale === scale)) {
            if (!sectionHasFullPixels(sec))
                await ensureFullSectionPixels(sec, label + ' review preparation');
            ensureReviewCopy(sec, scale);
        }
        sec.displayResolution = 'reduced';
        /* Once at least one analysis is safely stored, the review image is enough
           for interactive inspection. Drop the native channel arrays and worker
           intermediates; they can be restored from the original ND2 on demand. */
        if (resultsForSection(sec).length)
            releaseFullSectionPixels(sec);
        drawBase();
        fitView();
        drawOverlay();
        syncDisplayResolutionButtons();
        setStatus(label + ' review display · analyses and cell coordinates remain full resolution.');
    }
    else {
        sec.displayResolution = 'full';
        await ensureFullSectionPixels(sec, 'full-resolution review');
        drawBase();
        fitView();
        drawOverlay();
        syncDisplayResolutionButtons();
        setStatus('Full-resolution display restored · saved analyses were not rerun.');
    }
}
async function finalizeSectionReview(sec = S.image) {
    if (!sec || !sectionHasFullPixels(sec))
        return;
    /* The section being looked at follows the chosen preference, Full included.
       The rest of a batch is reduced regardless: holding native pixels for every
       section of a long run is the thing this reduction exists to avoid. */
    const keepFull = !!S.reviewPrefersFull && S.image === sec;
    if (S.image === sec)
        setStatus(`Analysis saved · preparing ${keepFull ? 'full-resolution' : reviewScaleLabel(S.reviewScale)} review display…`);
    if (!keepFull)
        ensureReviewCopy(sec);
    if (!sec.displayResolutionManual)
        sec.displayResolution = keepFull ? 'full' : 'reduced';
    if (sec.displayResolution === 'reduced')
        releaseFullSectionPixels(sec);
    if (S.image === sec) {
        if (analysisPageVisible())
            drawBase(), fitView(), drawOverlay(), syncDisplayResolutionButtons();
        else
            backgroundBatchUiDirty = true;
        setStatus(`Analysis saved · ${sec.displayResolution === 'reduced' ? reviewScaleLabel(sec.reviewScale || S.reviewScale) : 'full-resolution'} review display.`);
    }
}
/* Keep long analyses visible even when this page is in a background tab.
   The browser tab title shows only the overall percentage; this is UI-only and
   does not participate in detection or result state. */
let tabAnalysisProgress = null;
let analysisProgressState = null;
const ANALYSIS_STAGE_PCT = {
    'finding the tissue': 0.10, 'normalising background': 0.28, 'separating somata from processes': 0.50,
    'splitting clumps': 0.74, 'measuring': 0.90,
    'finding cells in the guide channels': 0.18, 'testing candidate brightness, then applying the anti-axon filter': 0.72
};
function analysisProgressContextText() {
    const t = tabAnalysisProgress;
    if (!t)
        return '';
    const bits = [];
    if (t.mode === 'all')
        bits.push(`section ${Math.min(t.total, t.sectionIndex + 1)} of ${t.total}`);
    if ((t.mode === 'all' || t.mode === 'section') && t.viewTotal > 1)
        bits.push(`view ${Math.min(t.viewTotal, t.viewIndex + 1)} of ${t.viewTotal}`);
    return bits.join(' · ');
}
function analysisProgressStart(mode, label) {
    const box = $('analysisProgress');
    if (!box)
        return;
    analysisProgressState = { mode: mode || 'normal', label: label || 'Analysis', pct: 0.03, log: [] };
    box.classList.add('on');
    $('apTitle').textContent = label || 'Analysis';
    $('apPct').textContent = '3%';
    $('apBar').style.width = '3%';
    $('apStage').textContent = 'Preparing analysis';
    $('apDetail').textContent = mode === 'axon' ? 'Preparing cross-channel guide data for Axon-heavy detection.' : mode === 'donut' ? 'Preparing the Donut detector and soma-size calibration.' : 'Preparing the Normal soma detector and image calibration.';
    $('apContext').textContent = analysisProgressContextText();
    $('apLog').innerHTML = '';
}
function analysisProgressStage(m) {
    const box = $('analysisProgress');
    if (!box)
        return;
    if (!analysisProgressState)
        analysisProgressStart('normal', 'Analysis');
    const st = analysisProgressState;
    const pct = Math.max(st.pct || 0, Math.min(0.96, Number.isFinite(m.pct) ? m.pct : (ANALYSIS_STAGE_PCT[String(m.msg || '').toLowerCase()] || 0.1)));
    st.pct = pct;
    if (st.stage && st.stage !== m.msg) {
        st.log.push(st.stage);
        if (st.log.length > 4)
            st.log.shift();
    }
    st.stage = m.msg || 'Working';
    $('apPct').textContent = Math.round(pct * 100) + '%';
    $('apBar').style.width = (pct * 100) + '%';
    $('apStage').textContent = st.stage;
    $('apDetail').textContent = m.detail || '';
    $('apContext').textContent = analysisProgressContextText();
    renderAnalysisProgressLog();
}
function analysisProgressCheckpoint(msg) {
    if (!analysisProgressState || !msg)
        return;
    analysisProgressState.log.push(msg);
    if (analysisProgressState.log.length > 4)
        analysisProgressState.log.shift();
    renderAnalysisProgressLog();
}
function renderAnalysisProgressLog() {
    const el = $('apLog');
    if (!el || !analysisProgressState)
        return;
    const rows = analysisProgressState.log.slice(-4).map(x => `<div>${String(x).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`);
    if (analysisProgressState.stage)
        rows.push(`<div class="current">${String(analysisProgressState.stage).replace(/[&<>]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]))}</div>`);
    el.innerHTML = rows.join('');
}
function analysisProgressFinish(m) {
    const box = $('analysisProgress');
    if (!box)
        return;
    if (!analysisProgressState)
        analysisProgressStart((S.lastRun && S.lastRun.detectionMode) || 'normal', 'Analysis');
    const mode = (S.lastRun && S.lastRun.detectionMode) || analysisProgressState.mode || 'normal';
    analysisProgressState.pct = 1;
    $('apPct').textContent = '100%';
    $('apBar').style.width = '100%';
    $('apStage').textContent = `Complete · ${S.cells.length} counted somata`;
    let detail = '';
    if (m.rej && m.rej.modelEngine && mode !== 'axon') {
        detail = `${S.cells.length} counted · cell centres found by ${m.rej.modelId} (${m.rej.modelEngine === 'webgpu' ? 'GPU' : 'JavaScript, no WebGPU'}) at threshold ${m.rej.modelThreshold} · ${m.rej.netMatched || 0} on detector candidates, ${m.rej.netOwn || 0} measured on their own${m.rej.modelInDomain ? '' : ' · minimum diameter OUTSIDE the validated 9-11 px, count not validated'}.`;
    }
    else if (mode === 'axon' && m.rej) {
        detail = `${m.rej.axonCandidates || m.seeds || 0} guide candidates · ${m.rej.axonWeak || 0} too dim · ${m.rej.axonLike || 0} axon-like rejected · ${S.cells.length} retained after the brightness floor.`;
    }
    else if (mode === 'donut' && m.rej) {
        detail = `${m.seeds || 0} candidate centers · ${m.rej.donutRescueGenerated || 0} donut-rescue candidates generated · ${m.rej.donutRescue || 0} rescue cells passed detector filters · ${S.cells.length} final counted.`;
    }
    else if (m.rej) {
        detail = m.rej.modelId
            ? `${m.seeds || 0} candidate centers · ${m.rej.model || 0} rejected by ${m.rej.modelId} · ${S.cells.length} counted · image quality ${(+m.rej.modelImageQuality).toFixed(2)} ${m.rej.modelInDomain ? '(inside validated range)' : '(OUTSIDE validated range — count not validated)'}.`
            : `${m.seeds || 0} candidate centers · ${m.rej.fibres || 0} fibre structures removed · ${m.cells.length} detector survivors · ${S.cells.length} retained after the brightness floor.`;
    }
    $('apDetail').textContent = detail;
    $('apContext').textContent = analysisProgressContextText();
    if (analysisProgressState.stage)
        analysisProgressState.log.push(analysisProgressState.stage);
    analysisProgressState.stage = 'Complete';
    renderAnalysisProgressLog();
}
function tabProgressStart(mode, total = 1) {
    if (progressJob) {
        progressJob.end();
        progressJob = null;
    }
    tabAnalysisProgress = { mode, total: Math.max(1, total), sectionIndex: 0, viewIndex: 0, viewTotal: 1, stage: 0,
        job: ToolkitCore.progress.start(mode === 'all' ? 'Analysing all images' : mode === 'section' ? 'Analysing the image' : 'Analysing') };
    renderTabProgress();
    if ($('apContext'))
        $('apContext').textContent = analysisProgressContextText();
}
function tabProgressSection(index, total) {
    if (!tabAnalysisProgress)
        return;
    tabAnalysisProgress.sectionIndex = Math.max(0, index || 0);
    tabAnalysisProgress.total = Math.max(1, total || tabAnalysisProgress.total || 1);
    tabAnalysisProgress.viewIndex = 0;
    tabAnalysisProgress.viewTotal = 1;
    tabAnalysisProgress.stage = 0;
    renderTabProgress();
    if ($('apContext'))
        $('apContext').textContent = analysisProgressContextText();
}
function tabProgressView(index, total) {
    if (!tabAnalysisProgress)
        return;
    tabAnalysisProgress.viewIndex = Math.max(0, index || 0);
    tabAnalysisProgress.viewTotal = Math.max(1, total || 1);
    tabAnalysisProgress.stage = 0;
    renderTabProgress();
    if ($('apContext'))
        $('apContext').textContent = analysisProgressContextText();
}
function tabProgressStage(msg, pct) {
    if (!tabAnalysisProgress)
        return;
    const legacy = {
        'finding the tissue': 0.08, 'normalising background': 0.28, 'separating somata from processes': 0.52,
        'splitting clumps': 0.76, 'measuring': 0.92
    };
    const key = String(msg || '').toLowerCase();
    const f = Number.isFinite(pct) ? pct : (legacy[key] != null ? legacy[key] : null);
    if (f != null) {
        tabAnalysisProgress.stage = Math.max(0, Math.min(1, f));
        renderTabProgress();
    }
}
function tabProgressViewDone() {
    if (!tabAnalysisProgress)
        return;
    tabAnalysisProgress.stage = 1;
    renderTabProgress();
}
function tabProgressFinish() {
    if (tabAnalysisProgress && tabAnalysisProgress.job)
        tabAnalysisProgress.job.end();
    tabAnalysisProgress = null;
}
function renderTabProgress() {
    const t = tabAnalysisProgress;
    if (!t)
        return;
    let f = 0;
    if (t.mode === 'all') {
        const within = (t.viewIndex + Math.max(0, Math.min(1, t.stage))) / Math.max(1, t.viewTotal);
        f = (t.sectionIndex + within) / Math.max(1, t.total);
    }
    else if (t.mode === 'section') {
        f = (t.viewIndex + Math.max(0, Math.min(1, t.stage))) / Math.max(1, t.viewTotal);
    }
    else
        f = Math.max(0, Math.min(1, t.stage));
    f = Math.max(0, Math.min(1, f));
    t.job.set(f, analysisProgressContextText() || null);
}
/* Bright objects on dark background, or dark on light?  Fluorescence signal is
   sparse, so a normal image has its median hard against the low end.  An
   inverted one has the median against the high end.  This ratio separates the
   two cleanly (about 0.9 inverted, under 0.25 normal) without assuming a bit
   depth or a display range.                                                  */
function polarityRatio(arr) {
    const step = Math.max(1, Math.floor(arr.length / 120000));
    const s = [];
    for (let i = 0; i < arr.length; i += step)
        s.push(arr[i]);
    s.sort((a, b) => a - b);
    const q = f => s[Math.floor(f * (s.length - 1))];
    const p1 = q(0.01), p50 = q(0.50), p99 = q(0.99);
    return (p50 - p1) / Math.max(p99 - p1, 1e-6);
}
function polarityChoice() { return ($('polarity') || { value: 'auto' }).value; }
function resolvePolarity(bright) {
    const mode = polarityChoice();
    if (mode === 'bright')
        return false;
    if (mode === 'dark')
        return true;
    return polarityRatio(bright) > 0.55;
}
/* An RGB file may be a single-colour LUT view of one channel, or a merge of
   two or three.  Counting "white" pixels in a merge is unreliable — a green
   fibre lying across a magenta soma makes it white too — so instead the merge
   is taken apart into its channels and the normal per-channel colocalisation
   does the work.                                                            */
function splitMode() { return ($('splitRGB') || { value: 'auto' }).value; }
function analyseColour(R, G, B) {
    const arr = [R, G, B], n = R.length, step = Math.max(1, Math.floor(n / 60000));
    const pk = a => {
        const s = [];
        for (let i = 0; i < n; i += step)
            s.push(a[i]);
        s.sort((x, y) => x - y);
        return s[Math.floor(0.995 * (s.length - 1))];
    };
    const peak = arr.map(pk), top = Math.max(peak[0], peak[1], peak[2], 1);
    const live = peak.map(v => v / top > 0.12);
    /* Two colour components carrying the same picture at different scale are one
       channel shown through a LUT — orange is red plus green, magenta is red plus
       blue.  Components that carry different pictures are different fluorophores.
       Correlation separates the two cleanly: 1.00 for a LUT, 0.6-0.9 for a merge. */
    function corr(a, b) {
        let sa = 0, sb = 0, c = 0;
        for (let i = 0; i < n; i += step) {
            sa += a[i];
            sb += b[i];
            c++;
        }
        const ma = sa / c, mb = sb / c;
        let num = 0, da = 0, db = 0;
        for (let i = 0; i < n; i += step) {
            const x = a[i] - ma, y = b[i] - mb;
            num += x * y;
            da += x * x;
            db += y * y;
        }
        if (da < 1e-9 || db < 1e-9)
            return 1;
        return num / Math.sqrt(da * db);
    }
    const group = [0, 1, 2];
    for (let i = 0; i < 3; i++)
        for (let j = i + 1; j < 3; j++) {
            if (!live[i] || !live[j])
                continue;
            if (corr(arr[i], arr[j]) >= 0.98) {
                const g = Math.min(group[i], group[j]), h = Math.max(group[i], group[j]);
                for (let k = 0; k < 3; k++)
                    if (group[k] === h)
                        group[k] = g;
            }
        }
    const seen = [], groups = [];
    for (let i = 0; i < 3; i++) {
        if (!live[i])
            continue;
        const g = group[i];
        let at = seen.indexOf(g);
        if (at < 0) {
            seen.push(g);
            groups.push({ idx: [i] });
        }
        else
            groups[at].idx.push(i);
    }
    const NAME = { '0': 'Red', '1': 'Green', '2': 'Blue', '01': 'Yellow', '02': 'Magenta',
        '12': 'Cyan', '012': 'White' };
    groups.forEach(g => { g.name = NAME[g.idx.join('')] || 'Channel'; });
    if (groups.length <= 1)
        return { kind: 'single' };
    return { kind: 'merge', groups: groups };
}
async function decodeToGray(file, opts = {}) {
    const ext = EXT(file.name);
    if (ext === 'tif' || ext === 'tiff')
        return decodeTiff(file);
    if (ext === 'nd2')
        return decodeNd2(file, opts.zLayers || null, opts.zAlign === 'auto' ? 'auto' : !!opts.zAlign, Number.isInteger(opts.point) ? opts.point : null);
    const bmp = await createImageBitmap(file);
    const w = bmp.width, h = bmp.height; // read before close(): a closed bitmap reports 0
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d', { willReadFrequently: true });
    g.drawImage(bmp, 0, 0);
    bmp.close();
    const d = g.getImageData(0, 0, w, h).data;
    const R = new Float32Array(w * h), G = new Float32Array(w * h), Bc = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        R[p] = d[i];
        G[p] = d[i + 1];
        Bc[p] = d[i + 2];
    }
    const hiC = new Float32Array(w * h), lumC = new Float32Array(w * h);
    for (let i = 0, p = 0; i < d.length; i += 4, p++) {
        hiC[p] = Math.max(d[i], d[i + 1], d[i + 2]);
        lumC[p] = 0.299 * d[i] + 0.587 * d[i + 1] + 0.114 * d[i + 2];
    }
    const inverted = resolvePolarity(hiC);
    const out = new Float32Array(w * h);
    let clipped = 0;
    if (inverted) {
        /* Darkness is the signal.  Use luminance rather than the darkest channel:
           in an inverted merge a single-label structure has one channel driven to
           zero, so the darkest-channel rule scores the neuropil above the somata
           and inverts the very contrast we are trying to measure.               */
        for (let i = 0; i < out.length; i++) {
            out[i] = 255 - lumC[i];
            if (lumC[i] <= 0)
                clipped++;
        }
    }
    else {
        for (let i = 0; i < out.length; i++) {
            out[i] = hiC[i];
            if (hiC[i] >= 255)
                clipped++;
        }
    }
    /* If this is a merge and splitting is allowed, hand back its channels        */
    const mode = splitMode();
    if (mode !== 'single') {
        const flip = v => inverted ? (255 - v) : v;
        const comps = [R, G, Bc].map(a => {
            if (!inverted)
                return a;
            const o = new Float32Array(a.length);
            for (let i = 0; i < a.length; i++)
                o[i] = 255 - a[i];
            return o;
        });
        const col = analyseColour(comps[0], comps[1], comps[2]);
        if (col.kind === 'merge') {
            const mk = (arr, name) => ({ w, h, data: arr, bits: 8, clipped: 0, inverted, rgb: true,
                name, note: 'from RGB merge', fromMerge: true, top: 255 });
            return col.groups.map(gp => {
                const a = new Float32Array(w * h);
                for (let i = 0; i < w * h; i++) {
                    let v = 0;
                    for (const k of gp.idx)
                        if (comps[k][i] > v)
                            v = comps[k][i];
                    a[i] = v;
                }
                return mk(a, gp.name);
            });
        }
    }
    return { w, h, data: out, bits: 8, clipped: clipped / out.length, inverted, rgb: true,
        note: inverted ? '8-bit source, inverted' : '8-bit source' };
}
function bytesToBase64(bytes) {
    let out = '';
    const CH = 0x8000;
    for (let i = 0; i < bytes.length; i += CH)
        out += String.fromCharCode(...bytes.subarray(i, i + CH));
    return btoa(out);
}
function base64ToBytes(s) {
    const bin = atob(s), out = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++)
        out[i] = bin.charCodeAt(i);
    return out;
}
function encodeSomaState(obj) { return bytesToBase64(new TextEncoder().encode(JSON.stringify(obj))); }
function decodeSomaState(s) {
    try {
        return JSON.parse(new TextDecoder().decode(base64ToBytes(s)));
    }
    catch (_) {
        return null;
    }
}
function parseImageJPointRoi(bytes) {
    if (!bytes || bytes.length < 64)
        return null;
    if (bytes[0] !== 73 || bytes[1] !== 111 || bytes[2] !== 117 || bytes[3] !== 116)
        return null; // Iout
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    if (bytes[6] !== 10)
        return null; // point ROI
    const top = v.getInt16(8, false), left = v.getInt16(10, false), n = v.getUint16(16, false);
    if (!n || 64 + n * 4 > bytes.length)
        return null;
    const points = [];
    const h2 = v.getInt32(60, false);
    let cntOff = -1;
    if (h2 > 0 && h2 + 52 <= bytes.length)
        cntOff = v.getInt32(h2 + 48, false);
    for (let i = 0; i < n; i++) {
        const x = left + v.getUint16(64 + i * 2, false), y = top + v.getUint16(64 + n * 2 + i * 2, false);
        let counter = 0;
        if (cntOff >= 0 && cntOff + (i + 1) * 4 <= bytes.length)
            counter = v.getInt32(cntOff + i * 4, false) & 0xff;
        points.push({ x, y, counter });
    }
    return points;
}
function parseImageJTiffExtras(buf) {
    try {
        const dv = new DataView(buf);
        if (buf.byteLength < 8)
            return null;
        const bo = dv.getUint16(0, true);
        let le;
        if (bo === 0x4949)
            le = true;
        else if (bo === 0x4d4d)
            le = false;
        else
            return null;
        if (dv.getUint16(2, le) !== 42)
            return null;
        const ifd = dv.getUint32(4, le);
        if (ifd <= 0 || ifd >= buf.byteLength)
            return null;
        const n = dv.getUint16(ifd, le), SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
        const entries = new Map();
        for (let i = 0; i < n; i++) {
            const off = ifd + 2 + i * 12;
            if (off + 12 > buf.byteLength)
                break;
            const tag = dv.getUint16(off, le), type = dv.getUint16(off + 2, le), count = dv.getUint32(off + 4, le), esz = SZ[type] || 1, total = esz * count;
            let base = off + 8;
            if (total > 4)
                base = dv.getUint32(off + 8, le);
            if (base >= 0 && base + total <= buf.byteLength)
                entries.set(tag, { type, count, total, base });
        }
        const rawTag = id => { const e = entries.get(id); return e ? new Uint8Array(buf, e.base, e.total) : null; };
        const descRaw = rawTag(270);
        let description = '';
        if (descRaw) {
            description = new TextDecoder().decode(descRaw);
            const z = description.indexOf('\0');
            if (z >= 0)
                description = description.slice(0, z);
        }
        let somaState = null;
        const sm = description.match(/(?:^|\n)SomaQuantState=([^\r\n]+)/);
        if (sm)
            somaState = decodeSomaState(sm[1].trim());
        let roiPoints = [];
        const cnt = rawTag(50838), meta = rawTag(50839);
        if (cnt && meta && cnt.byteLength >= 8 && meta.byteLength >= 12) {
            /* ImageJ's metadata: a header of (kind, how many) pairs, then the
               items in that order, their lengths in the counts tag. The dots
               are the "roi " item, after any colour tables of a composite. */
            const cv = new DataView(cnt.buffer, cnt.byteOffset, cnt.byteLength), mv = new DataView(meta.buffer, meta.byteOffset, meta.byteLength);
            const lens = [];
            for (let k = 0; k + 4 <= cnt.byteLength; k += 4)
                lens.push(cv.getUint32(k, le));
            const kinds = Math.floor((lens[0] - 4) / 8);
            let item = 1, at = lens[0];
            for (let k = 0; k < kinds && 8 + 8 * k <= meta.byteLength; k++) {
                const type = mv.getUint32(4 + 8 * k, le), many = mv.getUint32(8 + 8 * k, le);
                if (type === 0x726f6920 && lens[item] > 0 && at + lens[item] <= meta.byteLength) {
                    roiPoints = parseImageJPointRoi(meta.subarray(at, at + lens[item])) || [];
                    break;
                }
                for (let j = 0; j < many && item < lens.length; j++)
                    at += lens[item++];
            }
        }
        return { description, somaState, roiPoints };
    }
    catch (_) {
        return null;
    }
}
/* Most TIFFs exported from imaging software are uncompressed or PackBits, and
   those are simple enough to read here.  Doing so removes a network round trip
   on the common path — a CDN that fails to load used to mean the file simply
   would not open.  Anything compressed still falls through to the library.  */
function readTiffNative(buf, at = null) {
    const dv = new DataView(buf);
    if (buf.byteLength < 8)
        return null;
    const bo = dv.getUint16(0, true);
    let le;
    if (bo === 0x4949)
        le = true;
    else if (bo === 0x4d4d)
        le = false;
    else
        return null;
    if (dv.getUint16(2, le) !== 42)
        return null;
    /* at: a later page's IFD, from the page before it (its next). */
    const ifd = at == null ? dv.getUint32(4, le) : at;
    if (ifd <= 0 || ifd + 2 >= buf.byteLength)
        return null;
    const n = dv.getUint16(ifd, le);
    if (ifd + 2 + n * 12 + 4 > buf.byteLength)
        return null;
    const next = dv.getUint32(ifd + 2 + n * 12, le);
    const SZ = { 1: 1, 2: 1, 3: 2, 4: 4, 5: 8, 6: 1, 7: 1, 8: 2, 9: 4, 10: 8, 11: 4, 12: 8 };
    const tags = {};
    for (let i = 0; i < n; i++) {
        const off = ifd + 2 + i * 12;
        if (off + 12 > buf.byteLength)
            return null;
        const tag = dv.getUint16(off, le), type = dv.getUint16(off + 2, le);
        const count = dv.getUint32(off + 4, le), esz = SZ[type] || 1;
        const total = esz * count;
        let base = off + 8;
        if (total > 4) {
            base = dv.getUint32(off + 8, le);
            if (base + total > buf.byteLength)
                return null;
        }
        const vals = [];
        for (let k = 0; k < count && k < 4096; k++) {
            const a = base + k * esz;
            vals.push(type === 3 ? dv.getUint16(a, le) : type === 4 ? dv.getUint32(a, le) :
                type === 1 || type === 6 || type === 7 ? dv.getUint8(a) : dv.getUint16(a, le));
        }
        tags[tag] = vals;
    }
    const w = tags[256] && tags[256][0], h = tags[257] && tags[257][0];
    if (!w || !h)
        return null;
    const bits = (tags[258] && tags[258][0]) || 8;
    const comp = (tags[259] && tags[259][0]) || 1;
    const spp = (tags[277] && tags[277][0]) || 1;
    const planar = (tags[284] && tags[284][0]) || 1;
    if (planar !== 1)
        return null;
    if (comp !== 1 && comp !== 32773)
        return null; // leave compressed to the library
    if (bits !== 8 && bits !== 16 && bits !== 32)
        return null;
    const offs = tags[273], counts = tags[279];
    if (!offs || !counts)
        return null;
    const bpp = bits / 8 * spp, rowBytes = w * bpp;
    const out = new Uint8Array(h * rowBytes);
    let written = 0;
    for (let sIdx = 0; sIdx < offs.length; sIdx++) {
        const so = offs[sIdx], sc = counts[sIdx];
        if (so + sc > buf.byteLength)
            return null;
        const src = new Uint8Array(buf, so, sc);
        if (comp === 1) {
            if (written + src.length > out.length)
                return null;
            out.set(src, written);
            written += src.length;
        }
        else { // PackBits
            let i = 0;
            while (i < src.length && written < out.length) {
                const b = src[i++] | 0;
                const v = b > 127 ? b - 256 : b;
                if (v >= 0) {
                    for (let k = 0; k <= v && i < src.length && written < out.length; k++)
                        out[written++] = src[i++];
                }
                else if (v !== -128) {
                    const val = src[i++];
                    for (let k = 0; k < 1 - v && written < out.length; k++)
                        out[written++] = val;
                }
            }
        }
    }
    if (written < out.length * 0.9)
        return null;
    if (!le && bits > 8) { // host is little-endian
        const step = bits / 8;
        for (let i = 0; i + step <= out.length; i += step)
            for (let a = 0, b = step - 1; a < b; a++, b--) {
                const t = out[i + a];
                out[i + a] = out[i + b];
                out[i + b] = t;
            }
    }
    return { width: w, height: h, t258: [bits], t277: [spp], t339: tags[339] || [1], data: out, next };
}
function loadUTIF() { return ToolkitCore.imageIO.ensureTiff(); }
async function decodeTiff(file) {
    const buf = await file.arrayBuffer();
    const imagejExtras = parseImageJTiffExtras(buf);
    let ifd = null;
    try {
        ifd = readTiffNative(buf);
    }
    catch (_) {
        ifd = null;
    }
    if (!ifd) {
        let UTIF;
        try {
            UTIF = await loadUTIF();
        }
        catch (_) {
            throw new Error('This TIFF is compressed and the reader could not be fetched. ' +
                'Re-save it uncompressed, or export a PNG.');
        }
        const ifds = UTIF.decode(buf);
        UTIF.decodeImage(buf, ifds[0], ifds);
        ifd = ifds[0];
    }
    const w = ifd.width, h = ifd.height;
    const bits = (ifd.t258 && ifd.t258[0]) || 8;
    const spp = (ifd.t277 && ifd.t277[0]) || 1;
    const fmt = (ifd.t339 && ifd.t339[0]) || 1;
    const raw = ifd.data;
    const out = new Float32Array(w * h);
    let src;
    if (bits === 8)
        src = new Uint8Array(raw.buffer, raw.byteOffset, raw.length);
    else if (bits === 16)
        src = fmt === 2 ? new Int16Array(raw.buffer, raw.byteOffset, raw.length / 2)
            : new Uint16Array(raw.buffer, raw.byteOffset, raw.length / 2);
    else if (bits === 32)
        src = fmt === 3 ? new Float32Array(raw.buffer, raw.byteOffset, raw.length / 4)
            : new Uint32Array(raw.buffer, raw.byteOffset, raw.length / 4);
    else
        throw new Error(bits + '-bit TIFF is not supported');
    const hiC = new Float32Array(w * h), lumC = new Float32Array(w * h);
    const WT = [0.299, 0.587, 0.114];
    let Rc = null, Gc = null, Bc = null;
    if (spp >= 3) {
        Rc = new Float32Array(w * h);
        Gc = new Float32Array(w * h);
        Bc = new Float32Array(w * h);
    }
    for (let i = 0; i < w * h; i++) {
        let hi = -Infinity, lum = 0, wsum = 0;
        for (let s = 0; s < spp; s++) {
            const v = src[i * spp + s];
            if (v > hi)
                hi = v;
            const w2 = (spp === 3) ? WT[s] : 1 / spp;
            lum += v * w2;
            wsum += w2;
        }
        if (Rc) {
            Rc[i] = src[i * spp];
            Gc[i] = src[i * spp + 1];
            Bc[i] = src[i * spp + 2];
        }
        hiC[i] = hi;
        lumC[i] = lum / (wsum || 1);
    }
    const inverted = imagejExtras && imagejExtras.somaState ? false : resolvePolarity(hiC);
    if (Rc && splitMode() !== 'single') {
        let top = 0;
        for (let i = 0; i < w * h; i++)
            if (hiC[i] > top)
                top = hiC[i];
        const fl = a => {
            if (!inverted)
                return a;
            const o = new Float32Array(a.length);
            for (let i = 0; i < a.length; i++)
                o[i] = top - a[i];
            return o;
        };
        const fR = fl(Rc), fG = fl(Gc), fB = fl(Bc);
        const col = analyseColour(fR, fG, fB);
        if (col.kind === 'merge') {
            const comps = [fR, fG, fB];
            const mk = (arr, name) => ({ w, h, data: arr, bits, clipped: 0, inverted, rgb: true, name,
                note: bits + '-bit TIFF, from merge', fromMerge: true, top: top, _imagej: imagejExtras });
            return col.groups.map(gp => {
                const a = new Float32Array(w * h);
                for (let i = 0; i < w * h; i++) {
                    let v = 0;
                    for (const k of gp.idx)
                        if (comps[k][i] > v)
                            v = comps[k][i];
                    a[i] = v;
                }
                return mk(a, gp.name);
            });
        }
    }
    let clipped = 0, top = 0;
    if (inverted) {
        for (let i = 0; i < w * h; i++)
            if (hiC[i] > top)
                top = hiC[i];
        for (let i = 0; i < w * h; i++) {
            out[i] = top - lumC[i];
            if (lumC[i] <= 0)
                clipped++;
        }
    }
    else {
        const lim = bits === 8 ? 255 : (bits === 16 ? 65535 : Infinity);
        for (let i = 0; i < w * h; i++) {
            out[i] = hiC[i];
            if (hiC[i] >= lim)
                clipped++;
        }
    }
    return { w, h, data: out, bits, clipped: clipped / out.length, inverted, rgb: spp >= 3,
        note: bits + '-bit TIFF' + (inverted ? ', inverted' : ''), _imagej: imagejExtras };
}
let somaNd2Engine = null, pyPromise = null;
/* v3: nd2_plane_cached can max-project a chosen subset of Z layers.
   v4: it can line the layers up first (nd2_line_up, with the shared
   assets/nd2-z-align.py loaded ahead of this). The id changes with the
   signature, because the shared engine keeps helpers by id. */
const SOMA_ND2_HELPER_ID = 'soma-nd2-v4';
const SOMA_ND2_HELPER = String.raw `
import nd2, numpy as np, json, gc
_SOMA_DATA=None
_SOMA_AXES=None
_SOMA_INFO=None
_SOMA_ALIGNED=None
def nd2_prepare(path):
    global _SOMA_DATA, _SOMA_AXES, _SOMA_INFO
    nd2_release()
    with nd2.ND2File(path) as f:
        px=None
        try: px=float(f.voxel_size().x)
        except Exception: pass
        try: names=[c.channel.name for c in f.metadata.channels]
        except Exception: names=None
        attrs=f.attributes
        _SOMA_AXES=list(f.sizes.keys())
        _SOMA_INFO={"sizes":{k:int(v) for k,v in f.sizes.items()},
                    "channels":names,"px":px,"dtype":str(f.dtype),
                    "bitsSignificant":int(getattr(attrs,"bitsPerComponentSignificant",0) or getattr(attrs,"bitsPerComponentInMemory",0) or 0),
                    "bitsInMemory":int(getattr(attrs,"bitsPerComponentInMemory",0) or 0)}
        # Decode the multidimensional ND2 exactly once.  Per-channel extraction
        # below uses the same slicing/projection math as the previous nd2_plane().
        _SOMA_DATA=f.asarray()
    return json.dumps(_SOMA_INFO)
def _soma_select(frame,c,count,Y,X):
    frame=np.squeeze(np.asarray(frame))
    if frame.ndim==2: return frame
    if frame.shape[0]>=count and tuple(frame.shape[-2:])==(Y,X): return frame[c]
    if frame.shape[-1]>=count and tuple(frame.shape[:2])==(Y,X): return frame[...,c]
    raise RuntimeError("Unexpected ND2 frame shape %s." % (tuple(frame.shape),))
def nd2_prepare_point(path, position):
    # One point (P or V axis) of a multipoint ND2: its Z planes and channels only,
    # read frame by frame from the mounted file (a multipoint file can be far
    # bigger than memory). The array has axes Z, C, Y, X (no Z when there is one
    # plane), so lining up and projecting below are the same as for any ND2.
    # Any other axis (time) is taken at its first index, as Image Prep does.
    global _SOMA_DATA, _SOMA_AXES, _SOMA_INFO
    nd2_release()
    position=int(position)
    with nd2.ND2File(path) as f:
        sizes={str(k):int(v) for k,v in f.sizes.items()}
        px=None
        try: px=float(f.voxel_size().x)
        except Exception: pass
        try: names=[c.channel.name for c in f.metadata.channels]
        except Exception: names=None
        attrs=f.attributes
        coord=[a for a in sizes if a not in ("C","Y","X","S")]
        pos_axis="P" if "P" in sizes else ("V" if "V" in sizes else None)
        if pos_axis is None or not (0<=position<sizes[pos_axis]):
            raise RuntimeError("This ND2 has no point %d." % (position+1))
        nz=int(sizes.get("Z",1)); nc=int(sizes.get("C",1)); Y=int(sizes["Y"]); X=int(sizes["X"])
        out=np.empty((nz,nc,Y,X),dtype=f.dtype)
        for z in range(nz):
            seq=0; stride=1
            for a in reversed(coord):
                v=z if a=="Z" else (position if a==pos_axis else 0)
                seq+=v*stride; stride*=int(sizes[a])
            frame=f.read_frame(seq)
            for c in range(nc): out[z,c]=_soma_select(frame,c,nc,Y,X)
        _SOMA_AXES=["Z","C","Y","X"] if nz>1 else ["C","Y","X"]
        _SOMA_DATA=out if nz>1 else out[0]
        _SOMA_INFO={"sizes":{"Z":nz,"C":nc,"Y":Y,"X":X} if nz>1 else {"C":nc,"Y":Y,"X":X},
                    "channels":names,"px":px,"dtype":str(f.dtype),"position":position,"points":int(sizes[pos_axis]),
                    "bitsSignificant":int(getattr(attrs,"bitsPerComponentSignificant",0) or getattr(attrs,"bitsPerComponentInMemory",0) or 0),
                    "bitsInMemory":int(getattr(attrs,"bitsPerComponentInMemory",0) or 0)}
    return json.dumps(_SOMA_INFO)
def nd2_line_up(zsel=None, auto=0):
    # Lines the chosen Z layers (None: all) up with the middle one and keeps the
    # maximum of every channel for nd2_plane_cached(..., align=1). Any other axis
    # (time, points) is lined up on its own and then maximised, as below.
    # auto: look for doubling first (za_check) and line up only when there is some;
    # "applied" says which, "check" how doubled it looked.
    global _SOMA_ALIGNED
    a=_SOMA_DATA; ax=_SOMA_AXES
    if a is None or ax is None:
        raise RuntimeError("Soma ND2 array is not prepared.")
    key=tuple(int(z) for z in zsel) if zsel else None
    if _SOMA_ALIGNED is not None and _SOMA_ALIGNED[0]==key:
        return json.dumps(_SOMA_ALIGNED[2])  # already lined up, so doubled when checked
    _SOMA_ALIGNED=None
    others=[i for i,n in enumerate(ax) if n not in ("Z","C","Y","X")]
    v=np.transpose(a,others+[ax.index("Z")]+([ax.index("C")] if "C" in ax else [])+[ax.index("Y"),ax.index("X")])
    if "C" not in ax: v=v[...,None,:,:]
    zs=list(key) if key else list(range(v.shape[len(others)]))
    check=None
    if auto:
        check=max(za_check(lambda z,g=v[lead]:[g[z,k] for k in range(g.shape[1])],zs) for lead in np.ndindex(*v.shape[:len(others)]))
        if check<_ZA_DOUBLED:
            return json.dumps({"applied":False,"check":check,"layers":len(zs)})
    out=None; moved=0.0; measured=[]
    for lead in np.ndindex(*v.shape[:len(others)]):
        g=v[lead]
        m,info=za_max_aligned(lambda z:[g[z,k] for k in range(g.shape[1])],zs)
        out=m if out is None else [np.maximum(o,x) for o,x in zip(out,m)]
        moved=max(moved,info["maxShift"]); measured+=[f["measured"] for f in info["fields"].values()]
    summary={"applied":True,"check":check,"maxShift":moved,"measured":float(np.mean(measured)) if measured else 0.0,"layers":len(zs)}
    _SOMA_ALIGNED=(key,out,summary)
    return json.dumps(summary)
def nd2_plane_cached(c, zmode, zi, zsel=None, align=0):
    if _SOMA_DATA is None or _SOMA_AXES is None:
        raise RuntimeError("Soma ND2 array is not prepared.")
    if align:
        key=tuple(int(z) for z in zsel) if zsel else None
        if _SOMA_ALIGNED is None or _SOMA_ALIGNED[0]!=key:
            nd2_line_up(zsel)
        arr=np.asarray(_SOMA_ALIGNED[1][int(c)],dtype=np.float32)
        return arr.shape[1],arr.shape[0],arr.tobytes()
    a=_SOMA_DATA
    ax=_SOMA_AXES
    idx=[slice(None)]*a.ndim
    if "C" in ax: idx[ax.index("C")]=int(c)
    arr=a[tuple(idx)]
    if "Z" in ax:
        zpos=ax.index("Z")-(1 if ("C" in ax and ax.index("C")<ax.index("Z")) else 0)
        if zsel:
            arr=np.take(arr,[int(z) for z in zsel],axis=zpos).max(axis=zpos)
        else:
            arr=arr.max(axis=zpos) if zmode=="max" else np.take(arr,int(zi),axis=zpos)
    arr=np.asarray(arr,dtype=np.float32)
    while arr.ndim>2: arr=arr.max(axis=0)
    return arr.shape[1],arr.shape[0],arr.tobytes()
def nd2_release():
    global _SOMA_DATA, _SOMA_AXES, _SOMA_INFO, _SOMA_ALIGNED
    _SOMA_DATA=None; _SOMA_AXES=None; _SOMA_INFO=None; _SOMA_ALIGNED=None
    gc.collect()
`;
async function ensurePy() {
    if (pyPromise)
        return pyPromise;
    setEngine('busy', 'connecting shared ND2 engine');
    pyPromise = (async () => {
        somaNd2Engine = ToolkitCore.nd2.connectEngine({ start: true, onStatus: m => { if (m?.state === 'warming')
                setEngine('busy', (m.label || 'loading ND2 reader').replace(/…/g, '')); } });
        if (!somaNd2Engine)
            throw new Error('Shared ND2 engine is unavailable in this browser.');
        const engineInfo = await somaNd2Engine.ready();
        if (ToolkitCore.nd2.isMenuPrewarmed(engineInfo))
            setEngine('busy', 'reusing menu-prewarmed ND2 engine');
        setEngine('busy', 'preparing Soma ND2 helper');
        const za = await fetch('assets/nd2-z-align.py', { cache: 'no-store' });
        if (!za.ok)
            throw new Error(`Could not load the Z alignment helper (HTTP ${za.status}).`);
        await somaNd2Engine.ensureHelper(SOMA_ND2_HELPER_ID, (await za.text()) + '\n' + SOMA_ND2_HELPER);
        setEngine('ok', 'ready');
        return somaNd2Engine;
    })().catch(e => { pyPromise = null; somaNd2Engine = null; setEngine('', 'ND2 error'); throw e; });
    return pyPromise;
}
async function decodeNd2(file, zLayers = null, zAlign = false, point = null) {
    const engine = await ensurePy();
    /* A point of a multipoint ND2 is read from the mounted file (see
       somaPointsPath), frame by frame; any other ND2 is copied in, not mounted:
       Soma's reader maps the file and reads the whole stack into memory, and a
       mounted file cannot be mapped. */
    const onePoint = Number.isInteger(point);
    const path = onePoint ? await somaPointsPath(file) : engine.tempPath('soma_' + file.name.replace(/[^\w.]/g, '_'));
    if (!onePoint)
        await engine.writeFile(path, file);
    let prepared = false;
    try {
        const info = JSON.parse(String(await engine.run(SOMA_ND2_HELPER_ID, onePoint ? `nd2_prepare_point(${JSON.stringify(path)},${point})` : `nd2_prepare(${JSON.stringify(path)})`)));
        prepared = true;
        const nC = (info.sizes && info.sizes.C) || 1, nZ = Number(info.sizes && info.sizes.Z) || 1;
        const zmode = $('zHandling').value;
        /* Every layer is the plain maximum, exactly as before; a subset is the
           maximum over those layers only. */
        let zsel = Array.isArray(zLayers) ? [...new Set(zLayers.map(Number))].filter(z => Number.isInteger(z) && z >= 0 && z < nZ).sort((a, b) => a - b) : null;
        if (zsel && (!zsel.length || zsel.length >= nZ))
            zsel = null;
        /* Lining up needs two layers to compare; it is the maximum of the layers
           lined up with the middle one (assets/nd2-z-align.py, as in Image Prep). */
        /* zAlign 'auto' looks for doubling first and lines up only when it finds some. */
        const want = !!zAlign && zmode === 'max' && (zsel ? zsel.length : nZ) >= 2, auto = zAlign === 'auto';
        const zArg = zsel ? JSON.stringify(zsel) : 'None';
        const checked = want ? JSON.parse(String(await engine.run(SOMA_ND2_HELPER_ID, `nd2_line_up(${zArg},${auto ? 1 : 0})`))) : null;
        const align = !!checked && checked.applied !== false, lined = align ? checked : null;
        const chans = [];
        for (let c = 0; c < nC; c++) {
            const r = await engine.run(SOMA_ND2_HELPER_ID, `nd2_plane_cached(${c},${JSON.stringify(zmode)},0,${zArg},${align ? 1 : 0})`);
            const w = Number(r[0]), h = Number(r[1]), bytes = r[2] instanceof Uint8Array ? r[2] : new Uint8Array(r[2]);
            const buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
            chans.push({ w, h, data: new Float32Array(buf),
                name: (info.channels && info.channels[c]) || ('Channel ' + c),
                bits: 16, sourceBitDepth: Number(info.bitsSignificant || info.bitsInMemory) || ToolkitCore.data.bitDepthFromDtype(info.dtype) || 16, clipped: 0, inverted: false, note: onePoint ? `ND2 point ${point + 1}` : 'ND2', sourceFile: file.name, sourcePoint: onePoint ? point : null, zCount: nZ, zLayers: zsel, zAlign: lined, zCheck: auto ? checked : null, pixelSizeUm: Number(info.px) || 0 });
        }
        if (info.px) {
            $('pxSize').value = Number(info.px).toFixed(4);
            $('pxSrc').textContent = 'from ND2';
        }
        return chans;
    }
    finally {
        if (prepared)
            try {
                await engine.run(SOMA_ND2_HELPER_ID, 'nd2_release()');
            }
            catch (_) { }
        if (!onePoint)
            try {
                await engine.unlink(path);
            }
            catch (_) { }
    }
}
function defaultRegions() {
    return [
        { name: 'SN', color: PALETTE[0], polys: [] },
        { name: 'VTA', color: PALETTE[1], polys: [] }
    ];
}
function ensureSectionRegions(sec) {
    if (!sec.regions)
        sec.regions = defaultRegions();
    return sec.regions;
}
function selectionNames() {
    if (!S.image || !S.image.channels)
        return [];
    return selectedChannelIdx().map(i => (S.image.channels[i] || {}).name).filter(Boolean);
}
function selectionValueForNames(names) {
    if (!S.image || !Array.isArray(names) || !names.length)
        return null;
    const used = new Set(), idx = [];
    for (const wanted of names) {
        const target = String(wanted).trim().toLowerCase();
        let at = -1;
        for (let i = 0; i < S.image.channels.length; i++) {
            if (used.has(i))
                continue;
            if (String(S.image.channels[i].name || '').trim().toLowerCase() === target) {
                at = i;
                break;
            }
        }
        if (at < 0)
            return null;
        used.add(at);
        idx.push(at);
    }
    idx.sort((a, b) => a - b);
    return idx.length === 1 ? 'c' + idx[0] : 'm' + idx.join('-');
}
function selectChannelsByNames(names) {
    const value = selectionValueForNames(names);
    if (!value)
        return false;
    const sel = $('chDetect');
    if (!sel.querySelector('option[value="' + value + '"]'))
        return false;
    sel.value = value;
    syncChannelButtons();
    return true;
}
function analysisSelectionLabel(sec, value) {
    if (!sec || !sec.channels)
        return value || 'c0';
    const v = String(value || 'c0');
    const idx = v.charAt(0) === 'm'
        ? v.slice(1).split('-').map(Number).filter(i => i >= 0 && i < sec.channels.length)
        : [Math.max(0, Math.min(sec.channels.length - 1, +v.slice(1) || 0))];
    return idx.map(i => (sec.channels[i] || {}).name || ('Channel ' + (i + 1))).join(' + ');
}
function analysisModeSignature(sec, value) {
    if (!sec || !sec.channels)
        return 'normal';
    const v = String(value == null ? $('chDetect').value : value || 'c0');
    if (v.charAt(0) === 'm')
        return 'merge';
    const i = Math.max(0, Math.min(sec.channels.length - 1, +v.slice(1) || 0));
    const mode = channelMode(i, sec);
    if (mode !== 'axon')
        return mode;
    /* Axon-heavy depends on the modes of its guide channels.  Keep snapshots
       from different guide configurations separate instead of deleting them. */
    const guides = [];
    for (let j = 0; j < sec.channels.length; j++) {
        if (j === i)
            continue;
        const gm = channelMode(j, sec);
        if (gm !== 'axon')
            guides.push(j + ':' + gm);
    }
    return 'axon[' + guides.join(',') + ']';
}
function analysisKey(sec, value) {
    if (!sec)
        return '';
    const v = value == null ? $('chDetect').value : value;
    return sec.key + '::' + analysisSelectionLabel(sec, v) + '::' + analysisModeSignature(sec, v);
}
function analysisModeSignatureForChannelMode(sec, i, mode) {
    if (!sec || !sec.channels)
        return mode || 'normal';
    mode = mode || 'normal';
    if (mode !== 'axon')
        return mode;
    const guides = [];
    for (let j = 0; j < sec.channels.length; j++) {
        if (j === i)
            continue;
        const gm = channelMode(j, sec);
        if (gm !== 'axon')
            guides.push(j + ':' + gm);
    }
    return 'axon[' + guides.join(',') + ']';
}
function analysisKeyForChannelMode(sec, i, mode) {
    if (!sec || !sec.channels || i < 0 || i >= sec.channels.length)
        return '';
    const value = 'c' + i;
    return sec.key + '::' + analysisSelectionLabel(sec, value) + '::' + analysisModeSignatureForChannelMode(sec, i, mode);
}
function hasStoredModeAnalysis(sec, i, mode) {
    const key = analysisKeyForChannelMode(sec, i, mode);
    return !!(key && S.results.has(key));
}
function hasAnyStoredModeAnalysis(sec, i, mode) {
    if (!sec || !sec.channels || i < 0 || i >= sec.channels.length)
        return false;
    const selection = analysisSelectionLabel(sec, 'c' + i), want = mode || 'normal';
    for (const r of S.results.values()) {
        if (!r || r.sectionKey !== sec.key || r.selection !== selection)
            continue;
        const sig = String(r.modeSignature || 'normal');
        if (want === 'axon') {
            if (sig === 'axon' || sig.startsWith('axon['))
                return true;
        }
        else if (sig === want)
            return true;
    }
    return false;
}
function currentResult() {
    return S.image ? S.results.get(analysisKey(S.image, $('chDetect').value)) : null;
}
function restoreCurrentResult() {
    const prev = currentResult();
    S.regions = ensureSectionRegions(S.image);
    if (S.regions.length && (S.activeRegion < 0 || S.activeRegion >= S.regions.length))
        S.activeRegion = 0;
    if (prev) {
        /* A saved channel/composite is a complete analysis snapshot.  Restore the
           exact visible-cell list that was saved with it instead of rebuilding it
           through the CURRENT slider state.  Re-filtering here was the reason an
           analysed channel could come back with no dots after visiting another
           channel whose brightness range was different. */
        S.allCells = Array.isArray(prev.allCells) ? prev.allCells.slice() : null;
        S.cells = Array.isArray(prev.cells) ? prev.cells.slice() : [];
        S.lastRun = prev.run || null;
        S.manualRemoved = prev.removed || 0;
        S.autoCount = prev.autoCount || 0;
        S.rej = prev.rej || null;
        S.seeds = prev.seeds || 0;
        S.decisions = prev.decisions || [];
        $('expDecisions').disabled = !S.decisions.length;
        S.chanOrder = prev.chanOrder || null;
        S.colocIdx = prev.colocIdx || [];
        S.compUsed = prev.compUsed || [];
        S.floorTouched = !!prev.floorTouched;
        S.floorAuto = !!prev.floorAuto;
        S.colocFloorTouched = !!prev.colocFloorTouched;
        S.colocFloorAuto = !!prev.colocFloorAuto;
        S.autoFloorRef = isFinite(prev.autoFloorRef) ? +prev.autoFloorRef : null;
        S.autoColocFloorRef = isFinite(prev.autoColocFloorRef) ? +prev.autoColocFloorRef : null;
        S.removedAutoIds = new Set(prev.removedAutoIds || []);
        /* Restore the slider state belonging to this analysis.  New saves retain
           the exact range; the fallback keeps compatibility with results created
           earlier in the same session before this fix. */
        const el = $('minContrast');
        if (isFinite(prev.floorMin) && isFinite(prev.floorMax) && prev.floorMax > prev.floorMin) {
            el.min = String(prev.floorMin);
            el.max = String(prev.floorMax);
            el.step = String(isFinite(prev.floorStep) && prev.floorStep > 0 ? prev.floorStep : 1);
            const fv = isFinite(prev.floorValue) ? prev.floorValue : prev.floorMin;
            el.value = String(clamp(fv, prev.floorMin, prev.floorMax));
            drawContrastHist();
        }
        else {
            fitContrastSlider(prev.floorValue);
        }
        fitColocFloorSlider(prev.colocFloorValue);
        /* Older saved analyses did not store the Auto reference separately.
           Recover it once here; after this, manual slider moves never change it. */
        if (S.autoFloorRef == null)
            S.autoFloorRef = autoFloorSliderValue();
        if (parseDetect().merge && S.autoColocFloorRef == null)
            S.autoColocFloorRef = autoColocFloorSliderValue();
        /* Very old/incomplete snapshots may have allCells but no cells array.
           Only in that compatibility case reconstruct the visible population. */
        if (!Array.isArray(prev.cells) && S.allCells) {
            S.cells = S.allCells.filter(c => passesFloor(c) && passesColocFloor(c) && !S.removedAutoIds.has(c.id));
        }
    }
    else {
        S.cells = [];
        S.allCells = null;
        S.lastRun = null;
        S.manualRemoved = 0;
        S.autoCount = 0;
        S.rej = null;
        S.seeds = 0;
        S.decisions = [];
        $('expDecisions').disabled = true;
        S.chanOrder = null;
        S.colocIdx = [];
        S.compUsed = [];
        S.floorTouched = false;
        S.floorAuto = false;
        S.colocFloorTouched = false;
        S.colocFloorAuto = false;
        S.autoFloorRef = null;
        S.autoColocFloorRef = null;
        S.removedAutoIds = new Set();
        const el = $('minContrast');
        el.min = 0;
        el.max = 1000;
        el.step = 1;
        el.value = 0;
        const ce = $('colocFloor');
        if (ce)
            ce.value = 0;
        drawContrastHist();
    }
    S.marked = new Set();
    updateUndo();
    S.z = null;
    S.soma = null;
    assignRegions();
    buildQueue();
    syncColocFloorVisibility();
    syncLabels();
    drawContrastHist();
    ['expCells', 'expSummary', 'expRun', 'expPng'].forEach(id => { if ($(id))
        $(id).disabled = !S.cells.length; });
    syncTiffExportButtons();
    S.activeAnalysisValue = $('chDetect').value;
    return prev;
}
function jsonClone(v) { try {
    return JSON.parse(JSON.stringify(v));
}
catch (_) {
    return v;
} }
function importedPointCell(p, i, region = -1) {
    return { id: i + 1, x: +p.x, y: +p.y, area: 1, width: 1, minor: 1, major: 1, aspect: 1, conf: 1,
        source: 'auto', flag: false, region, contrast: 1, raw: 1, bg: 0, sig: 1, peak: 1, z: [] };
}
function modeFromSavedSignature(sig) { sig = String(sig || 'normal'); return sig === 'donut' ? 'donut' : sig.startsWith('axon') ? 'axon' : 'normal'; }
function applyImportedImageJState(sec) {
    if (sec && sec.savedSet)
        return applySavedTiffSet(sec);
    if (!sec || sec._imagejApplied || !sec.imagejImport)
        return false;
    const ex = sec.imagejImport.extras || {}, st = ex.somaState || null, points = Array.isArray(ex.roiPoints) ? ex.roiPoints : [];
    ensureChannelModes(sec);
    let result = null;
    if (st && st.result) {
        const saved = st.result, mode = modeFromSavedSignature(st.modeSignature || saved.modeSignature);
        /* A standalone TIFF no longer has the guide channels needed to rerun an
           Axon-heavy analysis.  Preserve that provenance in metadata/filename, but
           use Normal as the standalone UI mode so the saved dots remain reviewable. */
        sec.channelModes[0] = mode === 'donut' ? 'donut' : 'normal';
        sec.channelModeManual[0] = true;
        sec.channelModeAuto[0] = false;
        sec.regions = jsonClone(st.regions || saved.regions || defaultRegions());
        result = Object.assign({}, saved, {
            sectionKey: sec.key, sectionName: sec.name, selection: (sec.channels[0] || {}).name || st.selection || 'ImageJ TIFF',
            modeSignature: analysisModeSignature(sec, 'c0'),
            regions: sec.regions,
            cells: (saved.cells || []).map(cloneCellSnapshot),
            allCells: Array.isArray(saved.allCells) ? saved.allCells.map(cloneCellSnapshot) : (saved.cells || []).map(cloneCellSnapshot),
            importedFromImageJ: true, originalModeSignature: st.modeSignature || saved.modeSignature || 'normal'
        });
        if (isFinite(st.pixelSizeUm) && st.pixelSizeUm > 0) {
            $('pxSize').value = String(st.pixelSizeUm);
            $('pxSrc').textContent = 'from Soma TIFF';
        }
    }
    else if (points.length) {
        const counters = [...new Set(points.map(p => p.counter).filter(c => c > 0))].sort((a, b) => a - b), map = new Map();
        sec.regions = counters.map((c, i) => { map.set(c, i); return { name: 'Counter ' + c, color: PALETTE[i % PALETTE.length], polys: [] }; });
        if (!sec.regions.length)
            sec.regions = defaultRegions();
        const cells = points.map((p, i) => importedPointCell(p, i, map.has(p.counter) ? map.get(p.counter) : -1));
        result = { sectionKey: sec.key, sectionName: sec.name, selection: (sec.channels[0] || {}).name || 'ImageJ TIFF', modeSignature: 'normal',
            regions: sec.regions, cells: cells.map(cloneCellSnapshot), allCells: cells.map(cloneCellSnapshot), run: { importedImageJRoi: true },
            removed: 0, autoCount: cells.length, rej: null, seeds: cells.length, decisions: [], chanOrder: [0], colocIdx: [], compUsed: [],
            floorValue: 0, floorMin: 0, floorMax: 1, floorStep: 0.01, floorTouched: false, floorAuto: true, autoFloorRef: 0,
            colocFloorValue: 0, colocFloorTouched: false, colocFloorAuto: false, autoColocFloorRef: null, removedAutoIds: [],
            w: sec.channels[0].w, h: sec.channels[0].h, importedFromImageJ: true };
    }
    if (!result)
        return false;
    const key = analysisKey(sec, 'c0');
    S.results.set(key, result);
    sec.analysisSummaryReady = true;
    sec._imagejApplied = true;
    return true;
}
function openListed(i) {
    if (S.run && i !== S.idx && S.sections[i]) {
        setStatus(`Wait for ${S.run} to finish, then open ${S.sections[i].name}.`);
        return;
    }
    activate(i);
}
async function activate(i, wantedNames = null) {
    if (!S.sections[i])
        return;
    /* A click on another image while something runs used to do nothing at all. */
    if (S.busy) {
        if (i !== S.idx)
            setStatus(`Wait for the current step to finish (${$('engTxt').textContent}), then open ${S.sections[i].name}.`);
        return;
    }
    const carry = (wantedNames && wantedNames.length) ? wantedNames.slice() : (S.image ? selectionNames() : null);
    /* Remember where this section was being looked at before leaving it. */
    captureSectionView();
    if (S.idx >= 0)
        saveResult();
    S.idx = i;
    renderFileList();
    const sec = S.sections[i];
    setBusy(true, 'Loading ' + sec.name);
    progress(true, 10);
    try {
        if (!sec.channels) {
            await decodeSectionFullChannels(sec);
            progress(true, 90);
        }
        S.image = sec;
        ensureSectionRegions(sec);
        fillChannelSelects();
        assignColours();
        ensureChannelModes(sec);
        const importedImageJ = applyImportedImageJState(sec);
        if (sectionHasFullPixels(sec) && !importedImageJ)
            autoAssignAxonHeavyModes(sec);
        renderChannelButtons();
        renderModeButtons();
        S.compOn = null;
        if (!(carry && selectChannelsByNames(carry))) {
            if (sectionHasFullPixels(sec))
                applyChannelPlan();
            else {
                $('chDetect').value = 'c0';
                syncChannelButtons();
            }
        }
        /* The initial Colour display is the full merge.  Reflect that honestly in
           the channel buttons: no individual channel is selected while this passive
           merge preview is on screen.  chDetect remains available underneath for
           automatic density/mode setup and for the first explicit analysis. */
        S.mergePreview = ($('viewMode').value === 'color' && sec.channels.length > 1);
        syncChannelButtons();
        if (+$('pxSize').value > 0 && !S.sizesTouched)
            fitSizes();
        if (densityMode() === 'auto')
            applyDensity(false);
        renderDensityNote();
        describeImage();
        if (sectionHasFullPixels(sec) && !importedImageJ)
            sec._modeProbePending = true, sec._modeProbe = autoAssignDonutModes(sec).catch(() => { }).finally(() => { sec._modeProbePending = false; });
        const prev = restoreCurrentResult();
        if (importedImageJ && prev && sectionHasFullPixels(sec)) {
            ensureReviewCopy(sec);
            if (!sec.displayResolutionManual)
                sec.displayResolution = 'reduced';
            if (sec.displayResolution === 'reduced')
                releaseFullSectionPixels(sec);
        }
        $('stage').style.display = 'block';
        $('blank').style.display = 'none';
        if (analysisPageVisible()) {
            drawBase();
            restoreSectionView(sec);
            drawOverlay();
            updateStats();
            renderRegions();
            renderRegionTable();
            renderSectionAnalysisSummary(sec);
        }
        else
            backgroundBatchUiDirty = true;
        syncDisplayResolutionButtons();
        $('runSelectedBtn').disabled = false;
        $('runBtn').disabled = false;
        $('runAllBtn').disabled = false;
        markDirty(!prev);
        const autoLined = sec.zAutoCheck && sec.zAutoCheck.applied ? ` Its Z layers were doubled (shifted by up to ${Math.round(sec.zAutoCheck.maxShift)} px), so they were lined up; the Z button turns this off.` : '';
        setEngine('ok', 'ready');
        setStatus(sec.savedSet ? savedTiffSetStatus(sec) + autoLined : (prev ? (importedImageJ ? `Opened saved ImageJ TIFF · restored ${prev.cells.length} somata and dot ROIs.` : `Restored ${prev.cells.length} somata for ${analysisSelectionLabel(sec, $('chDetect').value)}`) : 'Loaded. Analyse when ready.') + autoLined);
    }
    catch (err) {
        setStatus(err.message);
        setEngine('err', 'load failed');
    }
    finally {
        progress(false);
        setBusy(false);
    }
}
function selectedChannelIdx() {
    const d = parseDetect();
    return d.idx && d.idx.length ? d.idx.slice() : [0];
}
function syncChannelButtons() {
    const box = $('channelButtons');
    if (!box || !S.image)
        return;
    scheduleChannelInk();
    /* The opening Colour view is a display preview of the full merge, not an
       analysis selection.  Keep every channel button visually off until the
       user picks a channel/composite or a batch analysis steps into a real view. */
    const active = S.mergePreview ? new Set() : new Set(selectedChannelIdx());
    [...box.children].forEach((b, i) => b.classList.toggle('on', active.has(i)));
}
function setChannelButtonsSelection(idx) {
    if (!S.image || !idx.length)
        return;
    /* A click leaves the passive full-merge preview and becomes an explicit
       analysis/display selection. */
    const wasPreview = S.mergePreview;
    S.mergePreview = false;
    idx = [...new Set(idx)].sort((a, b) => a - b);
    const sel = $('chDetect');
    const value = idx.length === 1 ? 'c' + idx[0] : 'm' + idx.join('-');
    if (value === sel.value) {
        if (wasPreview)
            sel.dispatchEvent(new Event('change'));
        return;
    }
    saveResult();
    if (!sel.querySelector('option[value="' + value + '"]')) {
        const o = document.createElement('option');
        o.value = value;
        o.textContent = value;
        sel.appendChild(o);
    }
    sel.value = value;
    syncChannelButtons();
    renderModeButtons();
    sel.dispatchEvent(new Event('change'));
}
function channelButtonColor(c, i) {
    const n = String((c && c.name) || '').toLowerCase();
    /* Button colours follow fluorophore identity, not display/composite position. */
    if (/dapi|hoechst|405/.test(n))
        return '#4aa3ff';
    if (/fitc|gfp|egfp|alexa[ _-]?488|af[ _-]?488|488/.test(n))
        return '#3cff7a';
    if (/cy3|tritc|alexa[ _-]?555|af[ _-]?555|alexa[ _-]?568|af[ _-]?568|555|561|568/.test(n))
        return '#ff5a4f';
    if (/cy5|alexa[ _-]?647|af[ _-]?647|647|far[ _-]?red/.test(n))
        return ToolkitCore.colors.farRedHex; // the Orange colour choice, exactly
    return (c && c.color) || CHANNEL_COLOURS[i % CHANNEL_COLOURS.length] || '#8d9aa9';
}
const AUTO_AXON_HEAVY_DENSITY_CUT = 0.18;
const AUTO_DONUT_RESCUE_FRAC_CUT = 0.045, AUTO_DONUT_RIM_FRAC_CUT = 0.060;
let autoDonutProbeSeq = 0;
function ensureChannelModes(sec = S.image) {
    if (!sec || !sec.channels)
        return [];
    const n = sec.channels.length;
    if (!Array.isArray(sec.channelModes) || sec.channelModes.length !== n)
        sec.channelModes = sec.channels.map(() => 'normal');
    if (!Array.isArray(sec.channelModeManual) || sec.channelModeManual.length !== n)
        sec.channelModeManual = sec.channels.map(() => false);
    if (!Array.isArray(sec.channelModeAuto) || sec.channelModeAuto.length !== n)
        sec.channelModeAuto = sec.channels.map(() => false);
    return sec.channelModes;
}
function channelMode(i, sec = S.image) { const m = ensureChannelModes(sec); return m[i] || 'normal'; }
function modeLabel(m) { return m === 'axon' ? 'Axon-heavy' : m === 'donut' ? 'Donut' : 'Normal'; }
function autoAxonHeavyEligible(sec, i) {
    if (!sec || !sec.channels || sec.channels.length < 2)
        return false;
    const c = sec.channels[i];
    if (!c || !c.data)
        return false;
    return channelDensity(c) >= AUTO_AXON_HEAVY_DENSITY_CUT;
}
/* A channel this dense with axons and neuropil is no longer switched to
   Axon-heavy: it is marked and counted in Normal mode, and every place that
   shows its count says to check it, until a mode is chosen for it by hand. */
function autoAssignAxonHeavyModes(sec = S.image) {
    if (!sec || !sec.channels)
        return;
    const modes = ensureChannelModes(sec), manual = sec.channelModeManual, auto = sec.channelModeAuto;
    sec.axonDense = sec.channels.map(() => null);
    for (let i = 0; i < sec.channels.length; i++) {
        if (manual[i])
            continue;
        if (autoAxonHeavyEligible(sec, i))
            sec.axonDense[i] = channelDensity(sec.channels[i]);
        if (sec.axonDense[i] != null || !(auto[i] && modes[i] === 'donut')) {
            modes[i] = 'normal';
            auto[i] = false;
        }
    }
}
/* Why this view's count needs checking, or null. Only a single channel marked
   too dense, whose mode nobody has chosen by hand. */
function axonDenseReason(sec, value) {
    const m = /^c(\d+)$/.exec(String(value || ''));
    if (!sec || !m)
        return null;
    const i = +m[1], d = sec.axonDense && sec.axonDense[i];
    if (d == null || (sec.channelModeManual && sec.channelModeManual[i]))
        return null;
    const name = (sec.channels[i] || {}).name || ('Channel ' + (i + 1));
    return `${name} is too dense with axons and neuropil to tell somata from fibres (density ${d.toFixed(2)}, limit ${AUTO_AXON_HEAVY_DENSITY_CUT.toFixed(2)})`;
}
function halfSampleChannelForProbe(c) {
    const w = c.w, h = c.h, nw = Math.max(1, Math.floor(w / 2)), nh = Math.max(1, Math.floor(h / 2)), src = c.data, out = new Float32Array(nw * nh);
    for (let y = 0; y < nh; y++)
        for (let x = 0; x < nw; x++) {
            const i = (y * 2) * w + x * 2;
            out[y * nw + x] = (src[i] + src[i + 1] + src[i + w] + src[i + w + 1]) * 0.25;
        }
    return { data: out, w: nw, h: nh };
}
const AUTO_DONUT_PROBE_TIMEOUT_MS = 180000;
function requestAutoDonutProbe(sec, i) {
    return new Promise(resolve => {
        const token = 'donut-' + (++autoDonutProbeSeq);
        /* Every exit resolves: a result, a worker-side failure (answered with
           probe:null), a crashed worker, or the timeout.  Analysis waits for
           this, so a probe that never answered used to stall it indefinitely. */
        const timer = setTimeout(() => {
            if (autoDonutProbeResolvers.has(token)) {
                autoDonutProbeResolvers.delete(token);
                resolve({ type: 'autoDonutProbeResult', token, probe: null, error: 'timed out' });
            }
        }, AUTO_DONUT_PROBE_TIMEOUT_MS);
        autoDonutProbeResolvers.set(token, m => { clearTimeout(timer); resolve(m); });
        try {
            const c = sec.channels[i], ds = halfSampleChannelForProbe(c);
            const p = params();
            const q = Object.assign({}, p, DONUT_ORIGINAL, { dMin: Math.max(4, p.dMin * 0.5), dMax: Math.max(8, p.dMax * 0.5), minWidth: Math.max(3, p.minWidth * 0.5), thin: Math.max(1, p.thin * 0.5), sep: Math.max(3, p.sep * 0.5), edgeMargin: Math.max(8, Math.round(p.edgeMargin * 0.5)) });
            S.worker.postMessage({ type: 'autoDonutProbe', token: token, index: i, channel: ds.data, w: ds.w, h: ds.h, params: q, alreadyHalf: true }, [ds.data.buffer]);
        }
        catch (err) {
            const r = autoDonutProbeResolvers.get(token);
            if (r) {
                autoDonutProbeResolvers.delete(token);
                r({ type: 'autoDonutProbeResult', token, probe: null, error: (err && err.message) || String(err) });
            }
        }
    });
}
/* Automatic Normal/Donut assignment is asynchronous.  Every analysis entry point
   must wait for it: otherwise a run started while the probe is still pending is
   silently analysed in the previous mode, so the same image could be counted
   as Normal or Donut depending only on how quickly Analyse was pressed. */
async function settleAutoModes(sec = S.image) {
    if (!sec || !sec._modeProbe)
        return;
    if (sec._modeProbePending) {
        setStatus('Checking channels for donut-shaped somata before analysis…');
        if ($('apStage')) {
            $('apStage').textContent = 'Checking channels for donut-shaped somata';
            $('apDetail').textContent = 'Automatic Normal/Donut assignment must finish first so every channel is analysed in its assigned mode.';
        }
    }
    await sec._modeProbe;
}
async function autoAssignDonutModes(sec = S.image) {
    if (!sec || !sec.channels || !S.worker)
        return;
    const modes = ensureChannelModes(sec), manual = sec.channelModeManual, auto = sec.channelModeAuto;
    const jobs = [];
    for (let i = 0; i < sec.channels.length; i++) {
        if (manual[i] || modes[i] === 'axon' || (sec.axonDense && sec.axonDense[i] != null))
            continue;
        jobs.push(requestAutoDonutProbe(sec, i).then(m => ({ i: i, m: m })));
    }
    const results = await Promise.all(jobs);
    if (S.image !== sec)
        return;
    let changed = false;
    for (const r of results) {
        const i = r.i;
        if (manual[i] || modes[i] === 'axon')
            continue;
        const pr = r.m && r.m.probe ? r.m.probe : null;
        if (!pr) {
            /* The channel keeps its current mode; say so rather than failing silently. */
            sec.channels[i]._autoDonutProbeError = (r.m && r.m.error) || 'no result';
            setStatus(`Automatic Donut check did not finish for ${sec.channels[i].name || 'channel ' + (i + 1)} (${sec.channels[i]._autoDonutProbeError}); it stays in ${modeLabel(modes[i])} mode.`);
            continue;
        }
        sec.channels[i]._autoDonutProbe = pr;
        const next = pr.eligible ? 'donut' : 'normal';
        if (modes[i] !== next) {
            modes[i] = next;
            invalidateModeResults(sec, i);
            changed = true;
        }
        auto[i] = !!pr.eligible;
    }
    if (changed || results.length) {
        renderModeButtons();
        restoreCurrentResult();
        drawBase();
        drawOverlay();
        updateStats();
        renderRegionTable();
    }
}
/* Normal and Donut sit under Detection; Axon-heavy has a hidden button and is not offered. */
function modeButtonEls() { return [...document.querySelectorAll('#modeButtons button, #modeButtonsAdv button')]; }
function renderModeButtons() {
    const wrap = $('modeChooser'), box = $('modeButtons'), note = $('modeNote'), lab = $('modeChannel'), labAdv = $('modeChannelAdv');
    if (!wrap || !box || !S.image)
        return;
    const idx = selectedChannelIdx();
    if (labAdv)
        labAdv.textContent = idx.length === 1 ? ((S.image.channels[idx[0]] || {}).name || ('Channel ' + (idx[0] + 1))) : '';
    if (idx.length !== 1) {
        lab.textContent = 'select one channel';
        modeButtonEls().forEach(b => { b.disabled = true; b.classList.remove('on', 'has-analysis'); b.title = ''; });
        note.textContent = 'Detection modes are stored per single channel.';
        return;
    }
    const i = idx[0], m = channelMode(i), ch = S.image.channels[i] || {}, name = ch.name || ('Channel ' + (i + 1)), isAuto = !!(S.image.channelModeAuto && S.image.channelModeAuto[i]);
    lab.textContent = name + (m === 'axon' ? ' · Axon-heavy' : '') + (isAuto ? ' · auto' : '') + (axonDenseReason(S.image, 'c' + i) ? ' · too dense' : '');
    modeButtonEls().forEach(b => {
        const bm = b.dataset.mode || 'normal';
        const storedExact = hasStoredModeAnalysis(S.image, i, bm);
        const storedAny = storedExact || hasAnyStoredModeAnalysis(S.image, i, bm);
        b.disabled = (bm === 'axon' && S.image.channels.length < 2);
        b.classList.toggle('on', bm === m);
        /* The gold check means "an analysis for this channel + mode is stored".
           It must not disappear merely because another guide channel changed mode.
           Exact-key matching is still used when restoring a result, so an older
           Axon-heavy snapshot is never silently substituted for the current guide
           configuration. */
        b.classList.toggle('has-analysis', storedAny);
        b.title = storedExact
            ? `${modeLabel(bm)} · saved analysis available for the current setup`
            : (storedAny ? `${modeLabel(bm)} · saved analysis stored from an earlier setup` : `${modeLabel(bm)} · no saved analysis yet`);
    });
    if ($('fillHoles'))
        $('fillHoles').checked = (m === 'donut');
    const dense = axonDenseReason(S.image, 'c' + i);
    if (dense)
        note.textContent = `${dense}. It is counted in ${modeLabel(m)} mode like any channel, but check the count: some fibres may be counted as somata.`;
    else if (m === 'axon' && isAuto) {
        const dens = channelDensity(ch);
        note.textContent = `Automatically selected Axon-heavy because this channel is strongly axon/neuropil-dense (density ${dens.toFixed(2)} ≥ ${AUTO_AXON_HEAVY_DENSITY_CUT.toFixed(2)}). You can still choose another mode manually.`;
    }
    else if (m === 'donut' && isAuto) {
        const q = ch._autoDonutProbe || {};
        const rf = isFinite(q.rescueFrac) ? (100 * q.rescueFrac).toFixed(1) : '—', mf = isFinite(q.rimFrac) ? (100 * q.rimFrac).toFixed(1) : '—';
        note.textContent = `Automatically selected Donut because the channel contains a repeated soma-sized rim phenotype (${q.rescue || 0} rescue rings; ${rf}% rescue fraction; ${mf}% rim fraction). You can still choose another mode manually.`;
    }
    else
        note.textContent = m === 'axon' ? 'Candidates come only from cells detected in the other Normal/Donut channels; this channel must pass both the brightness test and a balanced anti-axon morphology filter.' : m === 'donut' ? 'Uses the soma detector plus donut/rim reconstruction.' : 'Uses the standard soma detector.';
}
function invalidateModeResults(sec, changedIdx) {
    if (!sec)
        return;
    /* Results are keyed by channel + mode (and, for Axon-heavy, guide-mode
       signature), so changing a mode does not invalidate the section summary.
       Existing stored rows remain valid; an unanalyzed newly selected mode just
       has no exact row until that configuration is run. */
}
function setSelectedChannelMode(mode) {
    if (!S.image)
        return;
    const idx = selectedChannelIdx();
    if (idx.length !== 1)
        return;
    const i = idx[0], modes = ensureChannelModes(S.image);
    S.image.channelModeManual[i] = true;
    S.image.channelModeAuto[i] = false;
    if (modes[i] === mode) {
        renderModeButtons();
        setStatus(`${(S.image.channels[i] || {}).name || ('Channel ' + (i + 1))}: ${modeLabel(mode)} mode locked manually.`);
        return;
    }
    /* Preserve the analysis belonging to the OLD mode before changing the key. */
    saveResult(S.activeAnalysisValue || $('chDetect').value);
    modes[i] = mode;
    invalidateModeResults(S.image, i);
    renderModeButtons();
    restoreCurrentResult();
    drawBase();
    drawOverlay();
    updateStats();
    renderRegionTable();
    markDirty(true);
    setStatus(`${(S.image.channels[i] || {}).name || ('Channel ' + (i + 1))}: ${modeLabel(mode)} mode selected manually — analyse to apply. Previous mode results remain saved.`);
}
function initModeButtons() { modeButtonEls().forEach(b => b.onclick = () => setSelectedChannelMode(b.dataset.mode || 'normal')); }
/* Donut mode deliberately keeps the original v2.6.6 behaviour: the embedded
   donut-review and quality forests plus the original 0.40 area floor.  The
   hand-count classifier and the 1.00 area floor apply to Normal mode only. */
const DONUT_ORIGINAL = { areaLo: 0.40, legacyForests: true };
function paramsForMode(p, mode) { const q = Object.assign({}, p); q.detectionMode = mode || 'normal'; q.fillHoles = mode === 'donut'; q.axonHeavy = mode === 'axon'; if (q.fillHoles)
    Object.assign(q, DONUT_ORIGINAL); if (q.axonHeavy) {
    q.colocMode = 'all';
    q.axonMinNR = 0.40;
    q.axonAntiSigma = 1.8;
    q.axonAntiScore = 0.42;
    q.axonAntiCoherence = 0.92;
    q.axonAntiEntropy = 0.64;
} return q; }
function renderChannelButtons() {
    const box = $('channelButtons');
    if (!box || !S.image)
        return;
    box.innerHTML = '';
    S.image.channels.forEach((c, i) => {
        const b = document.createElement('button');
        b.type = 'button';
        b.textContent = c.name || ('Channel ' + (i + 1));
        b.style.setProperty('--ch', channelButtonColor(c, i));
        b.title = 'Click to turn ' + b.textContent + ' on or off' + (i < 9
            ? ` · key ${i + 1} shows it alone; hold several number keys together for their merge` : '');
        b.onclick = () => {
            /* From the opening merge, where no button is lit, a click shows that
               channel alone (the selection underneath may already be it). */
            if (S.mergePreview)
                return setChannelButtonsSelection([i]);
            const idx = selectedChannelIdx(), at = idx.indexOf(i);
            if (at >= 0) {
                if (idx.length === 1)
                    return;
                idx.splice(at, 1);
            }
            else
                idx.push(i);
            setChannelButtonsSelection(idx);
        };
        box.appendChild(b);
    });
    syncChannelButtons();
    renderModeButtons();
    renderZLayers();
}
/* ---- Z layers -------------------------------------------------------------
   A Z-stack ND2 is shown and analysed as the maximum over its layers. Which
   layers go into that maximum is chosen the way channels are: a row of toggle
   buttons, all on to start, at least one always on. The row appears while the
   Z button is hovered (or focused), and a drag across it sets every layer it
   passes to what the first one became, so a range takes one stroke. The
   choice belongs to the section. */
function sectionZCount(sec = S.image) {
    const ch = (sec && sec.channels) || [];
    return ch.length ? Math.max(1, ...ch.map(c => Number(c.zCount) || 1)) : 1;
}
function selectedZLayers(sec = S.image) {
    const n = sectionZCount(sec);
    const sel = Array.isArray(sec && sec.zLayers) ? sec.zLayers.filter(z => z >= 0 && z < n) : [];
    return sel.length ? sel.slice().sort((a, b) => a - b) : Array.from({ length: n }, (_, i) => i);
}
/* "all 12", "3–9 of 12", "1, 3, 5–7 of 12" -- layers counted from 1. */
function describeZLayers(layers, n) {
    if (!layers.length || layers.length >= n)
        return `all ${n}`;
    const runs = [];
    for (const z of layers) {
        const last = runs[runs.length - 1];
        if (last && z === last[1] + 1)
            last[1] = z;
        else
            runs.push([z, z]);
    }
    return runs.map(([a, b]) => a === b ? String(a + 1) : `${a + 1}\u2013${b + 1}`).join(', ') + ` of ${n}`;
}
let zPending = null, zCommitTimer = 0, zDrag = null;
/* Line up layers: a stitched point's Z layers can sit a few pixels apart, tile
   by tile, so the maximum shows every cell twice. The switch below the layers
   lines them up with the middle one before the maximum is taken (null: no
   change waiting). */
let zAlignPending = null;
const shownZAlign = sec => zAlignPending == null ? !!(sec && sec.zAlign) : zAlignPending;
/* What is being done to the Z layers right now (null: nothing). Lining up a large
   stitch takes several seconds, so a spinner covers the image meanwhile. */
let zWorkingText = null;
/* Every tool shares one setting: look for doubling when a Z-stack opens and line
   the layers up when some is found. On unless turned off in a Z window. */
const Z_AUTO_KEY = 'toolkit.zAutoAlign';
function zAutoAlignOn() { try {
    return localStorage.getItem(Z_AUTO_KEY) !== '0';
}
catch (_) {
    return true;
} }
function setZAutoAlign(on) { try {
    localStorage.setItem(Z_AUTO_KEY, on ? '1' : '0');
}
catch (_) { } }
function showZWorking(text) {
    zWorkingText = text || null;
    let o = $('zWorking');
    if (!o) {
        o = document.createElement('div');
        o.id = 'zWorking';
        o.className = 'z-working';
        o.setAttribute('role', 'status');
        o.innerHTML = '<i></i><span></span>';
        document.body.appendChild(o);
        window.addEventListener('resize', () => { if (zWorkingText)
            showZWorking(zWorkingText); });
    }
    o.hidden = !zWorkingText;
    if (!zWorkingText)
        return;
    const r = $('stageWrap').getBoundingClientRect();
    Object.assign(o.style, { left: r.left + 'px', top: r.top + 'px', width: r.width + 'px', height: r.height + 'px' });
    o.querySelector('span').textContent = zWorkingText;
}
function renderZLayers() {
    const row = $('zRow'), box = $('zLayers'), btn = $('zButton');
    if (!row || !box || !btn)
        return;
    const sec = S.image, n = sec ? sectionZCount(sec) : 1;
    /* Only a Z-stack has layers to choose. A TIFF, PNG or JPEG is one plane, so
       the button stays in its place in the row but is greyed out and opens nothing. */
    const stack = !!sec && n >= 2;
    row.hidden = false;
    row.classList.toggle('disabled', !stack);
    btn.disabled = !stack;
    if (!stack) {
        btn.textContent = 'Z';
        btn.classList.remove('on');
        btn.title = sec ? 'Z layers: this image is a single plane, so there are no layers to choose. Only Z-stack ND2 files have them.'
            : 'Z layers: open a Z-stack ND2 to choose which layers are projected.';
        return;
    }
    const on = new Set(zPending || selectedZLayers(sec));
    const desc = describeZLayers([...on].sort((a, b) => a - b), n);
    /* Short, like a channel name, so it fits beside them; lit like a selected
       channel only when a subset is in use. */
    const lined = shownZAlign(sec);
    btn.textContent = zWorkingText ? 'Z' : `Z ${on.size}/${n}${lined ? ' \u2261' : ''}`;
    btn.classList.toggle('busy', !!zWorkingText);
    btn.classList.toggle('on', on.size < n || lined);
    btn.title = `Z layers: ${desc}${lined ? ', lined up' : ''}. Hover to choose which are projected; click a layer, or drag across several.`;
    if (box.querySelectorAll('button[data-z]').length !== n) {
        box.innerHTML = '';
        for (let z = 0; z < n; z++) {
            const b = document.createElement('button');
            b.type = 'button';
            b.dataset.z = String(z);
            b.textContent = String(z + 1);
            b.title = `Layer ${z + 1}`;
            box.appendChild(b);
        }
        const hint = document.createElement('div');
        hint.className = 'z-hint';
        box.appendChild(hint);
        const align = document.createElement('button');
        align.type = 'button';
        align.className = 'z-align';
        box.appendChild(align);
        const auto = document.createElement('label');
        auto.className = 'z-auto';
        auto.title = 'Applies to every tool, for Z-stacks opened from now on. Each image can still be switched above.';
        auto.innerHTML = '<input type="checkbox"> Line up new Z-stacks when doubling is found';
        box.appendChild(auto);
    }
    box.querySelector('.z-hint').textContent = `${on.size >= n ? `Using all ${n} layers` : `Using layers ${desc}`}. Click or drag across layers; the image is the maximum over the ones that are on.`;
    box.querySelector('.z-auto input').checked = zAutoAlignOn();
    const al = box.querySelector('.z-align'), moved = Number(sec.channels?.[0]?.zAlign?.maxShift);
    al.classList.toggle('on', lined);
    al.setAttribute('aria-pressed', String(lined));
    al.classList.toggle('busy', !!zWorkingText);
    al.textContent = zWorkingText ? zWorkingText : lined ? `\u2261 Layers lined up${zAlignPending == null && Number.isFinite(moved) ? ` (moved up to ${Math.round(moved)} px)` : ''}` : '\u2261 Line up layers';
    al.title = lined ? 'Click to show the layers as recorded' : 'Seeing cells or fibres twice? Lines the Z layers up with the middle one, region by region, before their maximum is taken. Pixels are moved, never resampled.';
    box.querySelectorAll('button[data-z]').forEach(b => {
        const isOn = on.has(+b.dataset.z);
        b.classList.toggle('on', isOn);
        b.setAttribute('aria-pressed', String(isOn));
    });
}
/* A drag reports where the pointer is, not every button it crossed, and a
   quick stroke jumps straight over some of them. So every layer between the
   last one painted and this one is painted too: a stroke from 1 to 5 is 1-5. */
function paintZLayer(z) {
    const s = zDrag.set, from = zDrag.lastZ == null ? z : zDrag.lastZ;
    const step = z >= from ? 1 : -1;
    for (let k = from; ; k += step) {
        if (zDrag.paint)
            s.add(k);
        else if (!(s.size <= 1 && s.has(k)))
            s.delete(k); // at least one layer always stays on
        if (k === z)
            break;
    }
    zDrag.lastZ = z;
    zPending = [...s].sort((a, b) => a - b);
    renderZLayers();
}
function scheduleZCommit() {
    clearTimeout(zCommitTimer);
    zCommitTimer = setTimeout(commitZLayers, 450);
}
async function commitZLayers() {
    const sec = S.image;
    if (!sec || (!zPending && zAlignPending == null) || zDrag)
        return;
    /* A running analysis finishes on the layers it started with; the new
       choice is applied straight after. */
    if (S.busy) {
        zCommitTimer = setTimeout(commitZLayers, 500);
        return;
    }
    const n = sectionZCount(sec), want = (zPending || selectedZLayers(sec)).slice(), align = shownZAlign(sec);
    zPending = null;
    zAlignPending = null;
    const next = want.length >= n ? null : want;
    if (JSON.stringify(next) === JSON.stringify(sec.zLayers || null) && align === !!sec.zAlign) {
        renderZLayers();
        return;
    }
    const before = sec.zLayers || null, alignBefore = !!sec.zAlign;
    sec.zLayers = next;
    sec.zAlign = align;
    const label = describeZLayers(selectedZLayers(sec), n);
    setBusy(true, `${align ? 'Lining up and projecting' : 'Projecting'} Z layers: ${label}`);
    showZWorking(align ? 'Lining up Z layers\u2026' : 'Projecting Z layers\u2026');
    renderZLayers();
    progress(true, 15);
    try {
        await decodeSectionFullChannels(sec);
        /* The review copy and the detector's intermediates were made from the
           old projection. */
        sec.reviewChannels = null;
        if (sec.displayResolution === 'reduced')
            ensureReviewCopy(sec, sec.reviewScale || S.reviewScale);
        if (S.image === sec) {
            S.z = null;
            S.soma = null;
        }
        if (S.worker)
            S.worker.postMessage({ type: 'clearCache' });
        if (S.image === sec) {
            drawBase();
            drawOverlay();
        }
        setEngine('ok', 'ready');
        const stale = resultsForSection(sec).length > 0;
        if (stale)
            markDirty(true);
        const lined = sec.channels?.[0]?.zAlign;
        setStatus(`Showing Z layers: ${label}` + (lined ? `, lined up (moved up to ${Math.round(lined.maxShift)} px)` : '')
            + (stale ? ' \u00b7 saved analyses were made on other layers \u2014 analyse to update them.' : '.'));
    }
    catch (e) {
        sec.zLayers = before;
        sec.zAlign = alignBefore;
        setEngine('err', 'Z projection failed');
        setStatus('Could not project those layers: ' + (e && e.message || e));
    }
    finally {
        progress(false);
        setBusy(false);
        showZWorking(null);
        renderZLayers();
    }
}
(function wireZLayers() {
    const row = $('zRow'), box = $('zLayers');
    if (!row || !box)
        return;
    box.addEventListener('pointerdown', e => {
        const b = e.target.closest('button[data-z]');
        if (!b || !S.image)
            return;
        e.preventDefault();
        const set = new Set(zPending || selectedZLayers());
        zDrag = { paint: !set.has(+b.dataset.z), set };
        row.classList.add('dragging');
        clearTimeout(zCommitTimer);
        paintZLayer(+b.dataset.z);
    });
    document.addEventListener('pointermove', e => {
        if (!zDrag)
            return;
        const hit = document.elementFromPoint(e.clientX, e.clientY);
        const b = hit && hit.closest && hit.closest('#zLayers button[data-z]');
        if (b)
            paintZLayer(+b.dataset.z);
    });
    const end = () => {
        if (!zDrag)
            return;
        zDrag = null;
        row.classList.remove('dragging');
        scheduleZCommit();
    };
    document.addEventListener('pointerup', end);
    document.addEventListener('pointercancel', end);
    /* Keyboard: Enter or Space on a layer toggles it. A pointer click has
       already been handled on pointerdown, and reports detail > 0. */
    box.addEventListener('click', e => {
        const b = e.target.closest('button[data-z]');
        if (!b || e.detail > 0 || !S.image)
            return;
        zDrag = { paint: !new Set(zPending || selectedZLayers()).has(+b.dataset.z), set: new Set(zPending || selectedZLayers()) };
        paintZLayer(+b.dataset.z);
        zDrag = null;
        scheduleZCommit();
    });
    box.addEventListener('change', e => {
        if (e.target.closest('.z-auto'))
            setZAutoAlign(e.target.checked);
    });
    box.addEventListener('click', e => {
        if (!e.target.closest('.z-align') || !S.image)
            return;
        zAlignPending = !shownZAlign(S.image);
        renderZLayers();
        clearTimeout(zCommitTimer);
        zCommitTimer = setTimeout(commitZLayers, 60);
    });
})();
function fillChannelSelects() {
    const ch = S.image.channels, sel = $('chDetect'), keep = sel.value;
    sel.innerHTML = '';
    /* An n-channel section is n single-channel analyses plus every pairing of
       them.  Each is a different question with a different answer, so each gets
       its own entry rather than a composite plus a row of tick boxes.        */
    ch.forEach((c, i) => {
        const o = document.createElement('option');
        o.value = 'c' + i;
        o.textContent = c.name;
        sel.appendChild(o);
    });
    for (let i = 0; i < ch.length; i++)
        for (let j = i + 1; j < ch.length; j++) {
            const o = document.createElement('option');
            o.value = 'm' + i + '-' + j;
            o.textContent = ch[i].name + ' + ' + ch[j].name + ' \u2014 double positive';
            sel.appendChild(o);
        }
    if (ch.length > 2) {
        const o = document.createElement('option');
        o.value = 'm' + ch.map((_, i) => i).join('-');
        o.textContent = ch.map(c => c.name).join(' + ') + ' \u2014 positive in all';
        sel.appendChild(o);
    }
    if (keep && sel.querySelector('option[value="' + keep + '"]'))
        sel.value = keep;
    else
        sel.value = 'c0';
    $('detectRow').hidden = ch.length < 2;
    renderChannelButtons();
}
/* "c2" is channel 2 alone.  "m0-2" is the cells positive in both 0 and 2.   */
function parseDetect() {
    const ch = S.image ? S.image.channels : [];
    const v = String((($('chDetect') || {}).value) || '');
    if (v.charAt(0) === 'm') {
        const idx = v.slice(1).split('-').map(Number).filter(i => i >= 0 && i < ch.length);
        if (idx.length > 1)
            return { merge: true, idx: idx };
    }
    const one = v.charAt(0) === 'c' ? +v.slice(1) : 0;
    const lim = Math.max(ch.length - 1, 0);
    return { merge: false, idx: [Math.max(0, Math.min(lim, isFinite(one) ? one : 0))] };
}
/* Detect in the cleanest member of a pairing, then require the others.  A
   composite would let a neuropil-heavy partner lift the background and bury
   the very cells being counted.                                            */
function primaryOf(idx) {
    const ch = S.image.channels;
    let best = idx[0], bd = Infinity;
    for (const i of idx) {
        const d = channelDensity(ch[i]);
        if (d < bd) {
            bd = d;
            best = i;
        }
    }
    return best;
}
const CHANNEL_COLOURS = ['#ff3ce0', '#3cff7a', '#3ca8ff', '#ffb03c'];
/* How much of the frame a channel covers.  A channel carrying discrete somata
   lights up a small fraction; one that is mostly neuropil lights up most of it.
   Requiring positivity in a neuropil-dominated channel is close to meaningless —
   a soma there is dark in the merge because fibres lie over it, not because it
   expresses the marker.                                                       */
/* Axon density, measured rather than guessed.  A channel whose local
   background sits high relative to its bright end is carrying dense neuropil:
   the noise scale is then inflated by texture and a real soma never clears
   4 sigma.  Measured on these sections: 0.06-0.09 for channels that work at
   4.0 sigma, 0.19-0.22 for ones that need 2.8.                             */
/* Also kept against the pixels: a merge is measured through a stand-in object
   made afresh for every switch, which used to re-measure it each time. */
const densityMemo = new WeakMap();
function channelDensity(c) {
    if (c._dens != null)
        return c._dens;
    /* Pixels released for review and never measured: no density to give. */
    if (!c.data)
        return 0;
    if (densityMemo.has(c.data))
        return (c._dens = densityMemo.get(c.data));
    c._dens = measureChannelDensity(c);
    if (c.data)
        densityMemo.set(c.data, c._dens);
    return c._dens;
}
function measureChannelDensity(c) {
    const d = c.data, step = Math.max(1, Math.floor(d.length / 200000));
    const s = [];
    for (let i = 0; i < d.length; i += step)
        s.push(d[i]);
    s.sort((a, b) => a - b);
    const q = f => s[Math.floor(f * (s.length - 1))];
    const slide = q(0.05), peak = q(0.999);
    /* Measure inside tissue only: empty slide would otherwise drag the background
       estimate down and make a dense channel look sparse.                     */
    const cut = slide + 0.05 * (peak - slide);
    const tis = s.filter(v => v > cut);
    if (tis.length < 100) {
        return 0;
    }
    const bg = tis[Math.floor(0.35 * (tis.length - 1))];
    return (bg - slide) / Math.max(peak - slide, 1e-6);
}
const DENSE_CUT = 0.135;
function applyDensity(setFloor = true) {
    const c = detectChannel();
    const src = (c && c.data) ? c : (S.image && S.image.channels[0]);
    if (!src || !src.data)
        return null;
    const dens = channelDensity(src);
    const dense = dens > DENSE_CUT;
    $('snr').value = dense ? 28 : 40;
    if (setFloor)
        $('minContrast').value = dense ? 80 : 120;
    syncLabels();
    checkSnr();
    return { dens, dense };
}
function channelCoverage(c) {
    if (c._cov != null)
        return c._cov;
    const d = c.data, step = Math.max(1, Math.floor(d.length / 200000));
    const s = [];
    for (let i = 0; i < d.length; i += step)
        s.push(d[i]);
    s.sort((a, b) => a - b);
    const q = f => s[Math.floor(f * (s.length - 1))];
    const lo = q(0.10), hi = q(0.995), thr = lo + 0.25 * (hi - lo);
    let n = 0;
    for (const v of s)
        if (v > thr)
            n++;
    c._cov = n / s.length;
    return c._cov;
}
/* What to do with a freshly loaded multi-channel section: which channel to
   detect in, which channels the colocalisation rule should test.            */
function autoChannelPlan() {
    const ch = S.image.channels;
    if (ch.length < 2)
        return null;
    const cov = ch.map(channelCoverage);
    const sorted = cov.slice().sort((a, b) => a - b);
    const med = sorted[sorted.length >> 1];
    const informative = cov.map(v => !(v > 2 * med && v > 0.30));
    if (!informative.some(Boolean))
        informative.fill(true);
    let best = -1, bestCov = 2;
    ch.forEach((c, i) => { if (informative[i] && cov[i] < bestCov) {
        bestCov = cov[i];
        best = i;
    } });
    return { cov, informative, detect: best < 0 ? 0 : best,
        merged: ch.every(c => c.fromMerge) };
}
function applyChannelPlan() {
    const plan = autoChannelPlan();
    S.plan = plan;
    if (!plan)
        return;
    S.compOn = plan.informative.slice();
    $('chDetect').value = 'c' + plan.detect;
    syncChannelButtons();
    /* set it either way, so a rule chosen for one section does not leak into the
       next.  Channels split out of one merge are colocalisation by construction;
       separate files or ND2 channels are not, so they start on 'every soma'.   */
}
function assignColours() {
    const ch = S.image.channels;
    /* An image put back together from its TIFFs keeps the colours it had. */
    if (ch.every(c => c.savedColor)) {
        ch.forEach(c => { c.color = c.savedColor; });
        return;
    }
    if (ch.length === 2) {
        ch[0].color = '#ff00ff';
        ch[1].color = '#00ff00';
        return;
    }
    if (ch.length === 3) {
        ['#ff0000', '#00ff00', '#0000ff'].forEach((c, i) => { ch[i].color = c; });
        return;
    }
    /* Channels that came out of a merge get the pure colours they were merged
       from, so the picture can be put back together exactly.                  */
    const pure = ch.every(c => c.fromMerge);
    ch.forEach((c, i) => {
        if (c.color)
            return;
        if (pure && ch.length === 2)
            c.color = ['#ff00ff', '#00ff00'][i];
        else if (pure && ch.length === 3)
            c.color = ['#ff0000', '#00ff00', '#0000ff'][i];
        else if (ch.length === 2)
            c.color = ['#ff3ce0', '#3cff7a'][i];
        else if (ch.length === 3)
            c.color = ['#ff4444', '#3cff7a', '#4aa3ff'][i];
        else
            c.color = CHANNEL_COLOURS[i % CHANNEL_COLOURS.length];
    });
}
/* Which channels feed the composite. Defaults to all, but with three channels
   present you often want just two of them combined.                         */
function describeImage() {
    const dvi = +$('chDetect').value;
    const ch = S.image.channels, c = (dvi >= 0 ? ch[dvi] : null) || ch[0];
    const px = +$('pxSize').value;
    const sec = S.image || {}, files = sec.files || [], allNd2 = ch.length && ch.every(x => String(x.note || '').includes('ND2'));
    const filename = files.length === 1 ? files[0].name : (sec.name ? `${sec.name}${files.length ? ` (${files.length} files)` : ''}` : (c.sourceFile || 'Image'));
    ToolkitCore.ui.updateImageInfo('imageInfoHost', { filename, width: c.w, height: c.h, channelCount: ch.length, zCount: allNd2 ? (Number(c.zCount) || 1) : 1, projection: allNd2 && Number(c.zCount) > 1 ? 'max' : 'single', bitDepth: Number(c.sourceBitDepth) || c.bits, pixelSizeUm: px || Number(c.pixelSizeUm) || null });
    let warnings = [];
    const plan = S.plan;
    if (plan) {
        const names = ch.map(x => x.name);
        const dropped = names.map((name, i) => ({ name, i })).filter(x => !plan.informative[x.i]);
        if (dropped.length) {
            const msgs = dropped.map(x => `${x.name} is diffuse across ${Math.round(100 * plan.cov[x.i])}% of the frame, so it was excluded from the default rule. Turn it on to include it.`);
            warnings.push(`<span class="bad">${msgs.join('<br>')}</span>`);
        }
    }
    if (c.inverted) {
        warnings.push(`<span class="okc">Inverted automatically — dark somata on light.</span>`);
        if (c.rgb && ch.length === 1)
            warnings.push(`<span class="warnc">This looks like a single RGB merge. A merge collapses your fluorophores into one picture, so per-channel counts and colocalisation cannot be recovered from it — load the separate channels for that. Counting total somata from the merge is fine.</span>`);
    }
    if (c.clipped > 0.002)
        warnings.push(`<span class="warnc">${(c.clipped * 100).toFixed(1)}% of pixels are clipped at the top of the range. Intensity measurements on those somata are floors, not values — analyse the 16-bit source if you can.</span>`);
    $('imgMeta').innerHTML = warnings.join('<br>');
}
/* ------------------------ multipoint ND2 -------------------------------- */
/* A multipoint ND2 (one file, many M positions: a slide of several brains)
   opens the same points window as Image Prep before anything is analysed:
   every point at its stage position with a picture of it, grouped one group
   per brain with an ID and genotype, Mirror and Flip to match the slide, a
   click shows a point large. The points chosen become a section each, named
   "<file> · <ID genotype> · <point>", and each is read alone from the file
   (nd2_prepare_point), which is mounted rather than copied so files bigger
   than memory open. The window's pictures, groups and orientation are the
   shared ND2 helper's (assets/nd2-display-helper.py) and are remembered for
   the file exactly as in Image Prep, so a file grouped there opens grouped
   here. Splitting into ND2 files stays in Image Prep. */
const SOMA_POINTS_HELPER_ID = 'soma-points-v1';
const POINT_GROUP_COLOURS = ['#ff6b6b', '#4dabf7', '#51cf66', '#fcc419', '#cc5de8', '#ff922b', '#20c997', '#f06595', '#94d82d', '#748ffc', '#e599f7', '#63e6be'];
let somaPoints = null;
const somaPointMounts = new Map();
async function somaPointsEngine() {
    const engine = await ensurePy();
    /* The shared helper also points nd2 at the stand-in for memory mapping, so
       a mounted file can be read (frames by seeking). */
    await engine.ensureHelper(SOMA_POINTS_HELPER_ID, await ToolkitCore.nd2.loadSharedHelper());
    return engine;
}
async function runPoints(expr, globals = {}) {
    const engine = await somaPointsEngine();
    return engine.run(SOMA_POINTS_HELPER_ID, expr, globals, 'eval');
}
/* Where a multipoint file is mounted in the engine: once per file, kept while
   any of its points is open (every reload of a point reads it from there). */
async function somaPointsPath(file) {
    if (somaPointMounts.has(file))
        return somaPointMounts.get(file);
    const engine = await somaPointsEngine();
    const path = engine.tempPath('soma_points_' + somaPointMounts.size + '_' + file.name.replace(/[^\w.]/g, '_'));
    await engine.writeBrowserFile(path, file);
    somaPointMounts.set(file, path);
    return path;
}
function releaseSomaPointMounts(keep = new Set()) {
    for (const [file, path] of [...somaPointMounts]) {
        if (keep.has(file))
            continue;
        somaPointMounts.delete(file);
        if (somaNd2Engine)
            somaNd2Engine.unlink(path).catch(() => { });
    }
}
const pointsKey = file => `toolkit.nd2points:${file.name}:${file.size}`;
function readPointsMemory(file) { try {
    return JSON.parse(localStorage.getItem(pointsKey(file)) || 'null');
}
catch {
    return null;
} }
function savePointsMemory() {
    const P = somaPoints;
    if (!P)
        return;
    try {
        localStorage.setItem(pointsKey(P.file), JSON.stringify({ groups: P.groups, assign: P.assign, mirror: P.mirror, flip: P.flip }));
    }
    catch { }
}
/* The points' pictures are kept in this browser (the same store as Image
   Prep's), so a file opened again shows its map at once. */
let pointThumbDb = null;
function pointThumbStore(mode) {
    pointThumbDb = pointThumbDb || new Promise(resolve => {
        try {
            const r = indexedDB.open('toolkit-nd2-points', 1);
            r.onupgradeneeded = () => r.result.createObjectStore('thumbs');
            r.onsuccess = () => resolve(r.result);
            r.onerror = () => resolve(null);
        }
        catch {
            resolve(null);
        }
    });
    return pointThumbDb.then(db => { try {
        return db ? db.transaction('thumbs', mode).objectStore('thumbs') : null;
    }
    catch {
        return null;
    } });
}
const pointThumbKey = file => `${file.name}|${file.size}|${file.lastModified}|v1`;
async function readPointThumbs(file) {
    const store = await pointThumbStore('readonly');
    return store ? new Promise(resolve => { const r = store.get(pointThumbKey(file)); r.onsuccess = () => resolve(Array.isArray(r.result) ? r.result : null); r.onerror = () => resolve(null); }) : null;
}
async function savePointThumbs(file, thumbs) {
    const store = await pointThumbStore('readwrite');
    if (!store)
        return;
    const count = store.count();
    count.onsuccess = () => { if (count.result > 40)
        store.clear(); store.put(thumbs.slice(), pointThumbKey(file)); };
}
/* Width, height (and any further header numbers) and RGB rows from the engine, as a JPEG. */
function rgbPicture(bytes, headerWords = 2) {
    const u8 = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(u8.buffer, u8.byteOffset, headerWords * 4);
    const w = dv.getUint32(0, true), h = dv.getUint32(4, true);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    const img = c.getContext('2d').createImageData(w, h);
    for (let k = 0, j = headerWords * 4; k < w * h; k++, j += 3) {
        img.data[k * 4] = u8[j];
        img.data[k * 4 + 1] = u8[j + 1];
        img.data[k * 4 + 2] = u8[j + 2];
        img.data[k * 4 + 3] = 255;
    }
    c.getContext('2d').putImageData(img, 0, 0);
    return { url: c.toDataURL('image/jpeg', .88) };
}
/* Points named "1-3", "brain2_4" or "B 5" are grouped by what comes before the
   separator; names that do not split that way make one group. */
function autoPointGroups(names) {
    const keys = names.map(n => { const m = /^(.+?)[-_. ]+\S/.exec(String(n || '').trim()); return (m && m[1]) || null; }), distinct = [...new Set(keys)];
    if (keys.some(k => !k) || distinct.length < 2 || distinct.length >= names.length)
        return { groups: [{ id: '', genotype: '' }], assign: names.map(() => 0) };
    distinct.sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    return { groups: distinct.map(k => ({ id: k, genotype: '' })), assign: keys.map(k => distinct.indexOf(k)) };
}
function pointGroupLabel(g) { return [String((g && g.id) == null ? '' : g.id).trim(), String((g && g.genotype) == null ? '' : g.genotype).trim()].filter(Boolean).join(' '); }
function pointLabel(P, i) { const g = pointGroupLabel(P.groups[P.assign[i]]); return g ? `${g} · ${P.info.names[i]}` : P.info.names[i]; }
function escPointText(s) { return String(s).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c])); }
function pointPlacement(P) {
    const n = P.info.count, [fw, fh] = P.info.fieldUm || [P.info.width || 100, P.info.height || 100];
    const known = P.info.stage.every(v => Array.isArray(v) && Number.isFinite(v[0]) && Number.isFinite(v[1]));
    const cols = Math.max(1, Math.ceil(Math.sqrt(n)));
    return [...Array(n).keys()].map(i => {
        const cx = known ? P.info.stage[i][0] * (P.mirror ? -1 : 1) : (i % cols) * fw * 1.12, cy = known ? P.info.stage[i][1] * (P.flip ? -1 : 1) : Math.floor(i / cols) * fh * 1.12;
        return { x: cx - fw / 2, y: cy - fh / 2, w: fw, h: fh };
    });
}
function drawPointsMap() {
    const P = somaPoints, svg = $('nd2PointsMap');
    if (!P || !svg)
        return;
    const places = pointPlacement(P), pad = Math.max(...places.map(r => Math.max(r.w, r.h))) * .12;
    const x0 = Math.min(...places.map(r => r.x)) - pad, y0 = Math.min(...places.map(r => r.y)) - pad;
    const x1 = Math.max(...places.map(r => r.x + r.w)) + pad, y1 = Math.max(...places.map(r => r.y + r.h)) + pad;
    svg.setAttribute('viewBox', `${x0} ${y0} ${x1 - x0} ${y1 - y0}`);
    P.places = places;
    svg.innerHTML = places.map((r, i) => {
        const colour = POINT_GROUP_COLOURS[P.assign[i] % POINT_GROUP_COLOURS.length], fs = r.h * .16;
        return `<g class="pt${P.selected.has(i) ? ' sel' : ''}" data-i="${i}" transform="translate(${r.x} ${r.y})"><rect class="pt-bg" width="${r.w}" height="${r.h}"/><image width="${r.w}" height="${r.h}" preserveAspectRatio="none"${P.thumbs[i] ? ` href="${P.thumbs[i]}"` : ''}/><rect class="pt-ring" x="${-r.h * .03}" y="${-r.h * .03}" width="${r.w + r.h * .06}" height="${r.h * 1.06}"/><rect class="pt-frame" width="${r.w}" height="${r.h}" stroke="${colour}"/><text class="pt-name" x="${r.h * .06}" y="${r.h * .06 + fs}" font-size="${fs}">${escPointText(P.info.names[i])}</text></g>`;
    }).join('');
}
function syncPointsUi() {
    const P = somaPoints;
    if (!P)
        return;
    $('nd2PointsMap').querySelectorAll('.pt').forEach(g => g.classList.toggle('sel', P.selected.has(+g.dataset.i)));
    const host = $('nd2PointsGroups');
    const counts = P.groups.map((_, gi) => P.assign.filter(a => a === gi).length);
    const sig = JSON.stringify([P.groups.length, counts]);
    if (host.dataset.sig !== sig || !host.children.length) {
        host.dataset.sig = sig;
        host.innerHTML = P.groups.map((g, gi) => `<div class="pg-row" data-g="${gi}"><span class="pg-swatch" style="background:${POINT_GROUP_COLOURS[gi % POINT_GROUP_COLOURS.length]}"></span><input class="pg-id" placeholder="ID (e.g. ${gi + 1})" aria-label="Group ID"><input class="pg-geno" placeholder="Genotype" aria-label="Genotype"><div class="pg-foot"><span class="pg-count">${counts[gi]} point${counts[gi] === 1 ? '' : 's'}</span><button type="button" class="pg-select">Select</button><button type="button" class="pg-take" title="Move the selected points into this group">Move selected here</button>${counts[gi] ? '' : '<button type="button" class="pg-remove" title="Remove this empty group">Remove</button>'}</div></div>`).join('');
    }
    host.querySelectorAll('.pg-row').forEach(row => { const g = P.groups[+row.dataset.g], id = row.querySelector('.pg-id'), geno = row.querySelector('.pg-geno'); if (document.activeElement !== id)
        id.value = g.id; if (document.activeElement !== geno)
        geno.value = g.genotype; });
    const n = P.selected.size, bytes = n * (P.info.bytesPerPoint || 0);
    $('nd2PointsCount').textContent = `${n} of ${P.info.count} point${P.info.count === 1 ? '' : 's'} selected${bytes ? ` · ${(bytes / 1e9).toFixed(bytes > 1e10 ? 0 : 1)} GB of pixels` : ''}`;
    $('nd2PointsOpen').disabled = !n;
    if (P.view != null)
        $('nd2PointViewSelected').checked = P.selected.has(P.view);
    $('nd2PointsMirror').setAttribute('aria-pressed', String(!!P.mirror));
    $('nd2PointsFlip').setAttribute('aria-pressed', String(!!P.flip));
}
function pointsStatus(text, kind = '') { const el = $('nd2PointsStatus'); if (el) {
    el.textContent = text || '';
    el.className = 'nd2-points-status' + (kind ? ' ' + kind : '');
} }
async function loadPointThumbs(P) {
    const kept = await readPointThumbs(P.file).catch(() => null);
    if (kept && kept.length === P.info.count)
        kept.forEach((url, i) => { var _a, _b; if (url && !P.thumbs[i]) {
            P.thumbs[i] = url;
            (_b = (_a = $('nd2PointsMap')) === null || _a === void 0 ? void 0 : _a.querySelector(`.pt[data-i="${i}"] image`)) === null || _b === void 0 ? void 0 : _b.setAttribute('href', url);
        } });
    let made = 0;
    for (let i = 0; i < P.info.count; i++) {
        if (somaPoints !== P)
            return;
        if (P.thumbs[i])
            continue;
        pointsStatus(`Drawing point ${i + 1} of ${P.info.count}…`);
        try {
            const bytes = await runPoints('figure_nd2_point_thumb(str(_path),int(_p),int(_side))', { _path: P.path, _p: i, _side: 360 });
            P.thumbs[i] = rgbPicture(bytes).url;
            made++;
            if (somaPoints === P) {
                const im = $('nd2PointsMap').querySelector(`.pt[data-i="${i}"] image`);
                if (im)
                    im.setAttribute('href', P.thumbs[i]);
            }
        }
        catch (err) {
            console.warn('Point picture failed', i, err);
        }
    }
    if (made)
        savePointThumbs(P.file, P.thumbs.map(u => u || null)).catch(() => { });
    if (somaPoints === P)
        pointsStatus('');
}
/* One point large: the maximum over its Z planes, as recorded (doubled planes
   are lined up when the point is opened, if the switch says so). */
async function showPointView(i) {
    const P = somaPoints;
    if (!P)
        return;
    const n = P.info.count;
    i = ((i % n) + n) % n;
    P.view = i;
    const view = $('nd2PointView'), img = $('nd2PointViewImg'), note = $('nd2PointViewNote');
    view.hidden = false;
    const group = pointGroupLabel(P.groups[P.assign[i]]);
    $('nd2PointViewName').textContent = `${P.info.names[i]}${group ? ` · ${group}` : ''}  (${i + 1} of ${n})`;
    $('nd2PointViewSelected').checked = P.selected.has(i);
    const zs = P.info.z > 1 ? `all ${P.info.z} z-planes` : 'its one z-plane';
    const done = () => `Maximum of ${zs}, as recorded${P.align && P.info.z > 1 ? ' (doubled z-planes are lined up when it opens in Soma)' : ''}.`;
    P.views = P.views || new Map();
    if (P.views.has(i)) {
        img.src = P.views.get(i).url;
        note.textContent = done();
        return;
    }
    if (P.thumbs[i])
        img.src = P.thumbs[i];
    else
        img.removeAttribute('src');
    note.textContent = 'Drawing this point large…';
    const token = P.viewToken = (P.viewToken || 0) + 1;
    try {
        const v = rgbPicture(await runPoints('figure_nd2_point_view(str(_path),int(_p),int(_side),int(_a))', { _path: P.path, _p: i, _side: 1600, _a: 0 }), 3);
        P.views.set(i, v);
        if (somaPoints === P && P.viewToken === token && !view.hidden) {
            img.src = v.url;
            note.textContent = done();
        }
    }
    catch (err) {
        if (somaPoints === P && P.viewToken === token)
            note.textContent = `Could not draw this point: ${(err && err.message) || err}`;
    }
}
function closePointView() {
    if (somaPoints)
        somaPoints.view = null;
    $('nd2PointView').hidden = true;
}
function setPointsAlign(on) {
    const P = somaPoints;
    if (!P)
        return;
    P.align = !!on;
    setZAutoAlign(P.align);
    $('nd2PointsAlign').checked = P.align;
    if (P.view != null)
        showPointView(P.view);
}
/* Opens the window for one multipoint file; resolves with the chosen points
   ([{ index, name, group, label }]) or null when it is closed. */
async function openSomaPointsWindow(file, path, info) {
    const mem = readPointsMemory(file), auto = autoPointGroups(info.names);
    const fits = mem && Array.isArray(mem.assign) && mem.assign.length === info.count && Array.isArray(mem.groups) && mem.groups.length && mem.assign.every(a => a >= 0 && a < mem.groups.length);
    somaPoints = { file, path, info, thumbs: [], view: null, selected: new Set([...Array(info.count).keys()]),
        groups: fits ? mem.groups.map(g => { var _a, _b; return ({ id: String((_a = g.id) !== null && _a !== void 0 ? _a : ''), genotype: String((_b = g.genotype) !== null && _b !== void 0 ? _b : '') }); }) : auto.groups,
        assign: fits ? mem.assign.slice() : auto.assign, mirror: !!(mem && mem.mirror), flip: !!(mem && mem.flip), align: zAutoAlignOn() };
    const P = somaPoints;
    $('nd2PointsFile').textContent = file.name;
    const gb = (file.size / 1e9).toFixed(1), field = info.fieldUm ? ` · each ${(info.fieldUm[0] / 1000).toFixed(2)} × ${(info.fieldUm[1] / 1000).toFixed(2)} mm` : '';
    $('nd2PointsInfo').textContent = `${info.count} points · ${info.z} Z plane${info.z === 1 ? '' : 's'} · ${info.channels} channel${info.channels === 1 ? '' : 's'}${field} · ${gb} GB. Choose the points to quantify; each opens as an image of its own.`;
    pointsStatus('');
    $('nd2PointsAlign').checked = P.align;
    $('nd2PointsAlign').disabled = info.z < 2;
    closePointView();
    drawPointsMap();
    syncPointsUi();
    $('nd2PointsModal').classList.add('show');
    loadPointThumbs(P);
    return new Promise(resolve => { P.resolve = resolve; });
}
function closeSomaPointsWindow(result) {
    const P = somaPoints;
    if (!P)
        return;
    savePointsMemory();
    closePointView();
    somaPoints = null;
    $('nd2PointsModal').classList.remove('show');
    runPoints('figure_nd2_points_close()').catch(() => { });
    if (P.resolve)
        P.resolve(result);
}
/* Each ND2 is asked how many points it has; a file with one opens as before,
   a file with several opens the window, and its chosen points come back as
   one entry each. Other files pass through unchanged. */
async function expandMultipointNd2(files) {
    const out = [];
    for (const file of files) {
        if (EXT(file.name) !== 'nd2') {
            out.push({ file });
            continue;
        }
        setStatus(`Checking ${file.name} for multiple points…`);
        let info = null, path = null;
        try {
            path = await somaPointsPath(file);
            info = JSON.parse(String(await runPoints('figure_nd2_points(str(_path),str(_name))', { _path: path, _name: file.name })));
        }
        catch (e) {
            console.warn('Points check failed', file.name, e);
        }
        if (!info || !(info.count > 1)) {
            runPoints('figure_nd2_points_close()').catch(() => { });
            releaseSomaPointMounts(new Set([...somaPointMounts.keys()].filter(f => f !== file)));
            out.push({ file });
            continue;
        }
        setStatus(`${file.name} has ${info.count} points: choose the ones to quantify.`);
        const chosen = await openSomaPointsWindow(file, path, info);
        if (chosen && chosen.length) {
            if (chosen.align != null)
                setZAutoAlign(chosen.align);
            chosen.forEach(point => out.push({ file, point }));
        }
    }
    return out;
}
(function wirePointsWindow() {
    const svg = $('nd2PointsMap');
    if (!svg)
        return;
    /* Click a point to see it large; Shift-click toggles it; drag a box to
       select (Shift adds to the selection). */
    svg.addEventListener('pointerdown', e => {
        const P = somaPoints;
        if (!P || e.button !== 0)
            return;
        const hit = e.target.closest('.pt'), add = e.shiftKey || e.metaKey || e.ctrlKey;
        const base = add ? new Set(P.selected) : new Set();
        const toSvg = ev => { const pt = svg.createSVGPoint(); pt.x = ev.clientX; pt.y = ev.clientY; return pt.matrixTransform(svg.getScreenCTM().inverse()); };
        const start = toSvg(e);
        let m = null;
        const box = ev => { const p = toSvg(ev); return { x: Math.min(start.x, p.x), y: Math.min(start.y, p.y), r: Math.max(start.x, p.x), b: Math.max(start.y, p.y) }; };
        const move = ev => {
            if (!m && Math.hypot(ev.clientX - e.clientX, ev.clientY - e.clientY) < 5)
                return;
            if (!m) {
                m = document.createElementNS('http://www.w3.org/2000/svg', 'rect');
                m.setAttribute('class', 'marquee');
                svg.appendChild(m);
            }
            const r = box(ev);
            m.setAttribute('x', r.x);
            m.setAttribute('y', r.y);
            m.setAttribute('width', r.r - r.x);
            m.setAttribute('height', r.b - r.y);
        };
        const up = ev => {
            svg.removeEventListener('pointermove', move);
            svg.removeEventListener('pointerup', up);
            if (!m) {
                if (hit && !add)
                    return showPointView(+hit.dataset.i);
                if (hit) {
                    const i = +hit.dataset.i;
                    P.selected.has(i) ? P.selected.delete(i) : P.selected.add(i);
                }
                else if (!add)
                    P.selected = new Set();
                syncPointsUi();
                return;
            }
            m.remove();
            const r = box(ev);
            P.selected = new Set(base);
            P.places.forEach((q, i) => { if (q.x < r.r && q.x + q.w > r.x && q.y < r.b && q.y + q.h > r.y)
                P.selected.add(i); });
            syncPointsUi();
        };
        svg.addEventListener('pointermove', move);
        svg.addEventListener('pointerup', up);
    });
    $('nd2PointsAll').onclick = () => { if (somaPoints) {
        somaPoints.selected = new Set([...Array(somaPoints.info.count).keys()]);
        syncPointsUi();
    } };
    $('nd2PointsNone').onclick = () => { if (somaPoints) {
        somaPoints.selected = new Set();
        syncPointsUi();
    } };
    $('nd2PointsMirror').onclick = () => { if (somaPoints) {
        somaPoints.mirror = !somaPoints.mirror;
        drawPointsMap();
        syncPointsUi();
        savePointsMemory();
    } };
    $('nd2PointsFlip').onclick = () => { if (somaPoints) {
        somaPoints.flip = !somaPoints.flip;
        drawPointsMap();
        syncPointsUi();
        savePointsMemory();
    } };
    $('nd2PointsNewGroup').onclick = () => {
        const P = somaPoints;
        if (!P || !P.selected.size)
            return pointsStatus('Select the points for the new group first.', 'err');
        P.groups.push({ id: String(P.groups.length + 1), genotype: '' });
        P.selected.forEach(i => { P.assign[i] = P.groups.length - 1; });
        drawPointsMap();
        syncPointsUi();
        savePointsMemory();
    };
    const groups = $('nd2PointsGroups');
    groups.addEventListener('input', e => {
        const P = somaPoints, row = e.target.closest('.pg-row');
        if (!P || !row)
            return;
        const g = P.groups[+row.dataset.g];
        if (e.target.matches('.pg-id'))
            g.id = e.target.value;
        else if (e.target.matches('.pg-geno'))
            g.genotype = e.target.value;
        savePointsMemory();
    });
    groups.addEventListener('click', e => {
        const P = somaPoints, row = e.target.closest('.pg-row');
        if (!P || !row)
            return;
        const gi = +row.dataset.g;
        if (e.target.closest('.pg-select'))
            P.selected = new Set(P.assign.map((a, i) => a === gi ? i : -1).filter(i => i >= 0));
        else if (e.target.closest('.pg-take')) {
            P.selected.forEach(i => { P.assign[i] = gi; });
            drawPointsMap();
        }
        else if (e.target.closest('.pg-remove') && !P.assign.includes(gi)) {
            P.groups.splice(gi, 1);
            P.assign = P.assign.map(a => a > gi ? a - 1 : a);
            drawPointsMap();
        }
        else
            return;
        syncPointsUi();
        savePointsMemory();
    });
    $('nd2PointsCancel').onclick = () => closeSomaPointsWindow(null);
    $('nd2PointsAlign').onchange = e => setPointsAlign(e.target.checked);
    $('nd2PointViewBack').onclick = closePointView;
    $('nd2PointViewPrev').onclick = () => { if (somaPoints && somaPoints.view != null)
        showPointView(somaPoints.view - 1); };
    $('nd2PointViewNext').onclick = () => { if (somaPoints && somaPoints.view != null)
        showPointView(somaPoints.view + 1); };
    $('nd2PointViewSelected').onchange = e => {
        const P = somaPoints;
        if (!P || P.view == null)
            return;
        e.target.checked ? P.selected.add(P.view) : P.selected.delete(P.view);
        syncPointsUi();
    };
    /* While the window is open its keys are its own: arrows step through the
       points shown large, Esc goes back to the map (or closes the window), and
       nothing behind it reacts. */
    window.addEventListener('keydown', e => {
        const P = somaPoints;
        if (!P || !$('nd2PointsModal').classList.contains('show'))
            return;
        const typing = ['INPUT', 'TEXTAREA', 'SELECT'].includes((document.activeElement || {}).tagName) && document.activeElement.type !== 'checkbox';
        if (e.key === 'Escape')
            P.view != null ? closePointView() : closeSomaPointsWindow(null);
        else if (!typing && P.view != null && (e.key === 'ArrowLeft' || e.key === 'ArrowRight'))
            showPointView(P.view + (e.key === 'ArrowLeft' ? -1 : 1));
        else if (typing)
            return;
        e.stopImmediatePropagation();
        if (e.key === 'Escape' || e.key.startsWith('Arrow'))
            e.preventDefault();
    }, true);
    $('nd2PointsOpen').onclick = () => {
        const P = somaPoints;
        if (!P || !P.selected.size)
            return;
        const chosen = [...P.selected].sort((a, b) => a - b).map(i => ({ index: i, name: P.info.names[i], group: pointGroupLabel(P.groups[P.assign[i]]), label: pointLabel(P, i), count: P.info.count }));
        chosen.align = !!P.align;
        closeSomaPointsWindow(chosen);
    };
})();
/* ---------------- saved ImageJ TIFFs back into their image --------------
   The ImageJ TIFF export writes one TIFF per view of an image (a channel, or
   a merge of channels), each carrying that view's counts. Opened again, the
   TIFFs of one image, loose or still in the zip they were exported in, are put
   back together as that image: its channels in their order and colours, its
   merges as merges, each view with its saved counts. So the channel buttons,
   number keys and colocalisation review work as they did on the ND2.

   Since v2.78 a merge's TIFF holds all its channels and every TIFF lists the
   image's channels. Before, a merge's TIFF held one grey picture (the merge's
   sparsest channel) and only the views' names were recorded: the channels are
   then rebuilt from the single-channel TIFFs, and such a picture stands in for
   a channel only when it is the one channel of its merge with no TIFF. */
const SAVED_TIFF_EXT = ['tif', 'tiff'];
/* The images in a zip, as files. Folders inside it do not matter. */
async function filesInZip(zipFile) {
    await ToolkitCore.vendor.ensure('jszip');
    const zip = await JSZip.loadAsync(zipFile), out = [];
    for (const entry of Object.values(zip.files)) {
        const path = entry.name.replace(/\\/g, '/'), base = path.split('/').pop();
        if (entry.dir || !base || base.startsWith('._') || path.startsWith('__MACOSX/'))
            continue;
        if (!['png', 'jpg', 'jpeg', 'tif', 'tiff', 'nd2'].includes(EXT(base)))
            continue;
        out.push(new File([await entry.async('blob')], base, { lastModified: entry.date ? +entry.date : Date.now() }));
    }
    return out;
}
/* A TIFF saved by Soma: its embedded state (read from its start, where the
   export puts it), or, for a picture exported unanalysed before v2.78, only its
   name. Anything else is not one. */
async function readSavedTiffHead(file) {
    if (!SAVED_TIFF_EXT.includes(EXT(file.name)))
        return null;
    const start = new TextDecoder('latin1').decode(new Uint8Array(await file.slice(0, 4096).arrayBuffer()));
    if (start.includes('SomaQuantState=')) {
        const ex = parseImageJTiffExtras(await file.arrayBuffer());
        if (ex && ex.somaState && ex.somaState.sectionName)
            return { file, state: ex.somaState };
    }
    return /__not_analysed\.tiff?$/i.test(file.name) ? { file, state: null } : null;
}
/* Zips are opened, and the TIFFs saved by Soma are grouped by the image they
   came from; everything else is returned to be opened as usual. */
async function gatherSavedTiffs(files) {
    if (!files.some(f => EXT(f.name) === 'zip' || SAVED_TIFF_EXT.includes(EXT(f.name))))
        return { sets: [], rest: files };
    const flat = [];
    for (const f of files) {
        if (EXT(f.name) === 'zip')
            flat.push(...await filesInZip(f));
        else
            flat.push(f);
    }
    const heads = await Promise.all(flat.map(f => readSavedTiffHead(f).catch(() => null)));
    const groups = new Map(), rest = [], unnamed = [];
    flat.forEach((f, i) => {
        const h = heads[i];
        if (!h)
            rest.push(f);
        else if (h.state) {
            if (!groups.has(h.state.sectionName))
                groups.set(h.state.sectionName, []);
            groups.get(h.state.sectionName).push(h);
        }
        else
            unnamed.push(h);
    });
    /* An unanalysed picture from before v2.78 names its image only by the
       start of its file name. */
    for (const h of unnamed) {
        const prefix = h.file.name.split('__')[0], name = [...groups.keys()].find(k => safeExportName(k) === prefix);
        if (name)
            groups.get(name).push(h);
        else
            rest.push(h.file);
    }
    /* A lone merge TIFF from before v2.78 is one grey picture of no known
       channel: it opens as that picture, with its counts, as it always did. */
    const sets = [];
    for (const [name, list] of groups) {
        const st = list.length === 1 && list[0].state;
        if (st && !Array.isArray(st.channels) && String(savedViewValue(st) || '')[0] === 'm')
            rest.push(list[0].file);
        else
            sets.push({ name, heads: list });
    }
    return { sets, rest };
}
/* Every page of a TIFF as a grey picture. Soma's own TIFFs are read here
   page by page; one saved again elsewhere (compressed, say) gives its first
   page through the usual reader. */
async function savedTiffPlanes(file) {
    const buf = await file.arrayBuffer(), planes = [];
    let page = null, at = null, w = 0, h = 0;
    try {
        while ((page = readTiffNative(buf, at)) && planes.length < 64) {
            if (page.t258[0] !== 16 || page.t277[0] !== 1 || (planes.length && (page.width !== w || page.height !== h)))
                break;
            w = page.width;
            h = page.height;
            planes.push(Float32Array.from(new Uint16Array(page.data.buffer, page.data.byteOffset, w * h)));
            if (!page.next)
                break;
            at = page.next;
        }
    }
    catch (_) { }
    if (planes.length)
        return { w, h, planes };
    const one = await decodeTiff(file);
    return { w: one.w, h: one.h, planes: [one.data] };
}
const savedViewValue = st => {
    const v = String((st && (st.analysisValue || (st.result && st.result.analysisValue))) || '');
    return /^(?:c\d+|m\d+(?:-\d+)+)$/.test(v) ? v : null;
};
/* The image's channels from its TIFFs. Fills sec.savedSet.views (each view's
   value in the rebuilt image) and returns the channels. */
async function decodeSavedTiffSet(sec) {
    const set = sec.savedSet, slots = new Map(), views = [];
    const slot = i => { if (!slots.has(i)) slots.set(i, { name: null, color: null, data: null }); return slots.get(i); };
    let w = 0, h = 0, pixelSizeUm = 0;
    for (const head of set.heads) {
        const st = head.state, pic = await savedTiffPlanes(head.file);
        if (!w) {
            w = pic.w;
            h = pic.h;
        }
        if (pic.w !== w || pic.h !== h)
            throw new Error(`${head.file.name} is not the size of the other TIFFs of ${sec.name}.`);
        if (st && Array.isArray(st.channels))
            st.channels.forEach((c, i) => { const s = slot(i); s.name = s.name || c.name; s.color = s.color || c.color; });
        if (st && st.pixelSizeUm > 0)
            pixelSizeUm = +st.pixelSizeUm;
        const value = savedViewValue(st), idx = value ? valueIdx(value) : null;
        const names = st ? String(st.selection || '').split(' + ') : [head.file.name.split('__')[1] || head.file.name];
        if (idx)
            idx.forEach((i, k) => { if (names[k]) slot(i).name = slot(i).name || names[k]; });
        views.push({ head, value, idx, planes: pic.planes, name: names[0] });
    }
    /* Channels, and merges that hold all their channels. */
    for (const v of views)
        if (v.idx && v.planes.length === v.idx.length)
            v.idx.forEach((i, k) => { slot(i).data = slot(i).data || v.planes[k]; });
    /* Unanalysed pictures from before v2.78: the channel of that name. */
    for (const v of views)
        if (!v.idx) {
            let i = [...slots].find(([, s]) => s.name === v.name);
            i = i ? i[0] : (slots.size ? Math.max(...slots.keys()) + 1 : 0);
            const s = slot(i);
            s.name = s.name || v.name;
            s.data = s.data || v.planes[0];
        }
    /* A merge's one grey picture from before v2.78. */
    const same = (a, b) => { for (let i = 0; i < a.length; i += 61) if (a[i] !== b[i]) return false; return true; };
    for (const v of views)
        if (v.idx && v.planes.length !== v.idx.length) {
            const missing = v.idx.filter(i => !slot(i).data);
            if (missing.length === 1 && !v.idx.some(i => slot(i).data && same(slot(i).data, v.planes[0])))
                slot(missing[0]).data = v.planes[0];
        }
    /* Channels with no picture are left out, unless a merge needs them; those
       stay, blank. The rest close up, and every view follows its channels. */
    const used = new Set(views.flatMap(v => v.idx || []));
    const keep = [...slots.keys()].sort((a, b) => a - b).filter(i => slots.get(i).data || used.has(i));
    const at = new Map(keep.map((i, k) => [i, k]));
    set.channelIndex = at;
    set.blank = keep.filter(i => !slots.get(i).data).map(i => slots.get(i).name || 'Channel ' + (i + 1));
    set.views = views.map(v => ({ head: v.head, value: v.idx ? (v.idx.length === 1 ? 'c' + at.get(v.idx[0]) : 'm' + v.idx.map(i => at.get(i)).join('-')) : null }));
    set.pixelSizeUm = pixelSizeUm || null;
    return keep.map(i => {
        const s = slots.get(i), c = { w, h, data: s.data || new Float32Array(w * h), bits: 16, clipped: 0, inverted: false, rgb: false,
            name: s.name || 'Channel ' + (i + 1), note: '16-bit TIFF saved by Soma', savedColor: s.color || null,
            pixelSizeUm: pixelSizeUm || null, file: (set.heads[0] || {}).file?.name };
        /* Measured now: a restored image is reviewed with its full pixels released. */
        channelDensity(c);
        return c;
    });
}
/* The saved counts of every view, under the rebuilt image's channels. Each
   channel takes the mode its latest saved view was counted in. */
function applySavedTiffSet(sec) {
    if (sec._imagejApplied || !sec.savedSet || !sec.savedSet.views)
        return false;
    const set = sec.savedSet, at = set.channelIndex;
    const saved = set.views.filter(v => v.value && v.head.state && v.head.state.result)
        .sort((a, b) => String(a.head.state.generated || '').localeCompare(String(b.head.state.generated || '')));
    const modeOf = st => modeFromSavedSignature(st.modeSignature || st.result.modeSignature);
    ensureChannelModes(sec);
    for (const v of saved)
        if (v.value[0] === 'c') {
            const i = +v.value.slice(1);
            sec.channelModes[i] = modeOf(v.head.state);
            sec.channelModeManual[i] = true;
            sec.channelModeAuto[i] = false;
        }
    let regions = null;
    for (const v of saved) {
        const st = v.head.state, res = st.result, value = v.value;
        const sig = value[0] === 'm' ? 'merge' : analysisModeSignatureForChannelMode(sec, +value.slice(1), modeOf(st));
        const selection = analysisSelectionLabel(sec, value);
        regions = st.regions || res.regions || regions;
        S.results.set(sec.key + '::' + selection + '::' + sig, Object.assign({}, res, {
            sectionKey: sec.key, sectionName: sec.name, analysisValue: value, selection, modeSignature: sig,
            regions: jsonClone(st.regions || res.regions || []),
            cells: (res.cells || []).map(cloneCellSnapshot),
            allCells: Array.isArray(res.allCells) ? res.allCells.map(cloneCellSnapshot) : (res.cells || []).map(cloneCellSnapshot),
            chanOrder: Array.isArray(res.chanOrder) ? res.chanOrder.map(i => at.get(i)).filter(i => i != null) : null,
            importedFromImageJ: true, originalModeSignature: st.modeSignature || res.modeSignature || 'normal'
        }));
    }
    sec.regions = jsonClone(regions || defaultRegions());
    if (set.pixelSizeUm > 0) {
        $('pxSize').value = String(set.pixelSizeUm);
        $('pxSrc').textContent = 'from Soma TIFF';
    }
    set.restored = saved.length;
    sec.analysisSummaryReady = true;
    sec._imagejApplied = true;
    return saved.length > 0;
}
function savedTiffSetStatus(sec) {
    const set = sec.savedSet, n = set.restored || 0;
    const blank = set.blank && set.blank.length ? ` ${set.blank.join(' and ')} ${set.blank.length === 1 ? 'is' : 'are'} not in these TIFFs, so ${set.blank.length === 1 ? 'it is' : 'they are'} blank; TIFFs exported from v2.78 on keep every channel of a merge.` : '';
    return `Opened ${sec.name} from ${set.heads.length} saved TIFF${set.heads.length === 1 ? '' : 's'}: ${sec.channels.length} channel${sec.channels.length === 1 ? '' : 's'}, ${n} view${n === 1 ? '' : 's'} with counts restored.${blank}`;
}
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
/* ---------------------------- regions ---------------------------------- */
function addRegion(name) {
    const i = S.regions.length;
    /* polys, plural: a region can be drawn as several separate outlines, so the
       left and right side of a bilateral nucleus count as one group.        */
    S.regions.push({ name: name || ('Region ' + (i + 1)), color: PALETTE[i % PALETTE.length], polys: [] });
    S.activeRegion = i;
    renderRegions();
    return i;
}
function renderRegions() {
    const el = $('rgnList');
    el.innerHTML = '';
    S.regions.forEach((r, i) => {
        const d = document.createElement('div');
        d.className = 'rgn' + (i === S.activeRegion ? ' act' : '');
        d.innerHTML = `<span class="sw" style="background:${r.color}"></span>
      <input type="text" value="${r.name}">
      <span class="c">${S.cells.filter(c => c.region === i).length}</span>
      <button title="Delete entire region group">✕</button>`;
        const nameEl = d.querySelector('input');
        /* the row itself selects the region, so a click meant for the text field
           must not bubble up and steal focus                                     */
        nameEl.onpointerdown = e => e.stopPropagation();
        nameEl.onclick = e => {
            e.stopPropagation();
            S.activeRegion = i;
            if (S.tool !== 'lasso')
                tool('lasso');
            renderRegions();
            const el = $('rgnList').children[i].querySelector('input');
            el.focus();
            el.select();
        };
        const oldName = r.name;
        nameEl.oninput = e => { r.name = e.target.value; };
        nameEl.onchange = e => {
            const now = e.target.value;
            r.name = oldName;
            snapshot(`renamed ${oldName || 'a region'}`, { regions: true });
            r.name = now;
            if (S.image)
                S.image.regions = S.regions;
            renderRegions();
            renderRegionTable();
            saveResult();
        };
        nameEl.onkeydown = e => { if (e.key === 'Enter')
            e.target.blur(); };
        d.querySelector('button').onclick = e => {
            e.stopPropagation();
            snapshot(`deleted ${r.name || 'a region'}`, { regions: true });
            S.regions.splice(i, 1);
            S.cells.forEach(c => { if (c.region === i)
                c.region = -1;
            else if (c.region > i)
                c.region--; });
            S.activeRegion = Math.min(S.activeRegion, S.regions.length - 1);
            if (S.image)
                S.image.regions = S.regions;
            renderRegions();
            renderRegionTable();
            drawOverlay();
            saveResult();
        };
        /* Picking a region means drawing it next, so the Lasso comes up with it. */
        d.onclick = () => { S.activeRegion = i; if (S.tool !== 'lasso')
            tool('lasso'); renderRegions(); };
        el.appendChild(d);
    });
    $('rgnHint').textContent = S.regions.length ? `${S.regions.length}` : 'draw to add';
}
/* Regions used to hold a single outline; tolerate both shapes so a section
   saved before this change still opens.                                    */
function regionPolys(r) {
    if (!r)
        return [];
    if (r.polys)
        return r.polys;
    return (r.poly && r.poly.length) ? [r.poly] : [];
}
/* Holes: areas cut out of a region's outlines with Trim region. A point
   is in the region when it is inside one of its outlines and in none of its
   holes. */
function regionHoles(r) {
    return r && Array.isArray(r.holes) ? r.holes : [];
}
function pointInHoles(r, x, y) {
    return regionHoles(r).some(h => h && h.length > 2 && pointInPoly(x, y, h));
}
function pointInRegion(r, x, y) {
    return regionPolys(r).some(p => p && p.length > 2 && pointInPoly(x, y, p)) && !pointInHoles(r, x, y);
}
/* Nearest point on a closed polygon's boundary, and how far away it is.     */
/* Densify the full closed lasso boundary, including the implicit segment
   from the release point back to the start.  This matters when the user lets
   go before tracing the whole shape: that closing segment must also be kept
   out of existing regions. */
function densifyClosedPoly(poly, maxStep = 2) {
    if (!poly || poly.length < 2)
        return (poly || []).map(p => ({ x: p.x, y: p.y }));
    const out = [];
    for (let i = 0; i < poly.length; i++) {
        const a = poly[i], b = poly[(i + 1) % poly.length];
        const d = Math.hypot(b.x - a.x, b.y - a.y), n = Math.max(1, Math.ceil(d / maxStep));
        for (let k = 0; k < n; k++) {
            const t = k / n;
            out.push({ x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t });
        }
    }
    return out;
}
function pointInPoly(x, y, poly) {
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
        const xi = poly[i].x, yi = poly[i].y, xj = poly[j].x, yj = poly[j].y;
        if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi + 1e-12) + xi))
            inside = !inside;
    }
    return inside;
}
function pointSegDist2(px, py, a, b) {
    const vx = b.x - a.x, vy = b.y - a.y, wx = px - a.x, wy = py - a.y;
    const vv = vx * vx + vy * vy || 1e-12;
    let t = (wx * vx + wy * vy) / vv;
    t = t < 0 ? 0 : t > 1 ? 1 : t;
    const dx = px - (a.x + t * vx), dy = py - (a.y + t * vy);
    return dx * dx + dy * dy;
}
function findRegionOutlineAt(x, y) {
    /* Prefer a click inside an outline. If the user clicks directly on a dashed
       boundary, allow a small screen-space tolerance as well. */
    for (let ri = 0; ri < S.regions.length; ri++) {
        if (pointInHoles(S.regions[ri], x, y))
            continue;
        const ps = regionPolys(S.regions[ri]);
        for (let pi = 0; pi < ps.length; pi++) {
            const poly = ps[pi];
            if (poly.length >= 3 && pointInPoly(x, y, poly))
                return { ri, pi };
        }
    }
    const tol = Math.max(3, 8 / Math.max(S.zoom, 1e-6)), tol2 = tol * tol;
    let best = null, bestD = tol2;
    for (let ri = 0; ri < S.regions.length; ri++) {
        const ps = regionPolys(S.regions[ri]);
        for (let pi = 0; pi < ps.length; pi++) {
            const poly = ps[pi];
            if (poly.length < 2)
                continue;
            for (let k = 0; k < poly.length; k++) {
                const d = pointSegDist2(x, y, poly[k], poly[(k + 1) % poly.length]);
                if (d <= bestD) {
                    bestD = d;
                    best = { ri, pi };
                }
            }
        }
        /* On a hole's dashed edge: that hole, so deleting it fills it back in. */
        const hs = regionHoles(S.regions[ri]);
        for (let hi = 0; hi < hs.length; hi++) {
            const h = hs[hi];
            for (let k = 0; k < h.length; k++) {
                const d = pointSegDist2(x, y, h[k], h[(k + 1) % h.length]);
                if (d <= bestD) {
                    bestD = d;
                    best = { ri, hole: hi };
                }
            }
        }
    }
    return best;
}
/* The one region a point counts in: the first it lies in. Regions drawn with
   the lasso never overlap, so this only decides anything for outlines saved
   overlapping by an older version; every count uses it, so a cell is never
   counted in two regions. */
function regionIndexAt(regions, x, y) {
    for (let i = 0; i < regions.length; i++)
        if (pointInRegion(regions[i], x, y))
            return i;
    return -1;
}
function assignRegions() {
    for (const c of S.cells)
        c.region = regionIndexAt(S.regions, c.x, c.y);
}
function renderRegionTable() {
    const t = $('rgnTable');
    const di = 0, ci = colocIndex();
    const rows = [];
    const groups = S.regions.map((r, i) => ({ name: r.name, idx: i })).concat([{ name: 'Unassigned', idx: -1 }]);
    let head = '<tr><th>Region</th><th class="n">n</th>';
    if (ci >= 0)
        head += '<th class="n">double+</th>';
    head += '</tr>';
    for (const g of groups) {
        const cs = S.cells.filter(c => c.region === g.idx);
        if (!cs.length && g.idx === -1 && S.regions.length)
            continue;
        let r = `<tr><td>${g.name}</td><td class="n">${cs.length}</td>`;
        if (ci >= 0)
            r += `<td class="n">${cs.filter(isColoc).length}</td>`;
        rows.push(r + '</tr>');
    }
    t.innerHTML = head + rows.join('');
    updateCopyCounts();
}
function regionCountsText() {
    if (!S.regions.length)
        return '';
    return S.regions.map((r, i) => {
        const name = (r.name || ('Region ' + (i + 1))).trim() || ('Region ' + (i + 1));
        return `${name}: ${S.cells.filter(c => c.region === i).length}`;
    }).join('    ');
}
function updateCopyCounts() {
    const btn = $('copyCounts');
    if (!btn)
        return;
    const text = regionCountsText();
    btn.disabled = !text;
    btn.title = text ? 'Copy region counts: ' + text : 'Draw regions to copy their counts';
}
async function copyRegionCounts() {
    const text = regionCountsText();
    if (!text)
        return;
    try {
        await navigator.clipboard.writeText(text);
    }
    catch (_) {
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        ta.remove();
    }
    setStatus('Copied region counts: ' + text);
}
/* ---- Trim region: cut an area out of the drawn regions ----------------------
   Clicking Remove again turns it into a lasso that takes area away. Each outline
   the loop touches is drawn into a mask (the outline, minus its holes, minus the
   loop) and the mask's edges are traced back into outlines: a cut across an edge
   leaves a notched outline, one right through splits it in two, and one wholly
   inside leaves a hole. Rasterising copes with whatever shape a freehand loop
   takes, crossings included. Outlines the loop misses are kept exactly. */
const CUT_MAX_CELLS = 8e6, CUT_MIN_AREA = 6;
function ringBox(ring) {
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const p of ring) {
        if (p.x < x0)
            x0 = p.x;
        if (p.x > x1)
            x1 = p.x;
        if (p.y < y0)
            y0 = p.y;
        if (p.y > y1)
            y1 = p.y;
    }
    return { x0, y0, x1, y1 };
}
function boxesMeet(a, b) { return a.x0 <= b.x1 && b.x0 <= a.x1 && a.y0 <= b.y1 && b.y0 <= a.y1; }
function ringArea(ring) {
    let a = 0;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++)
        a += ring[j].x * ring[i].y - ring[i].x * ring[j].y;
    return a / 2;
}
function makeMaskCanvas(w, h) {
    if (typeof OffscreenCanvas !== 'undefined')
        return new OffscreenCanvas(w, h);
    const c = document.createElement('canvas');
    c.width = w;
    c.height = h;
    return c;
}
/* Edges between foreground and background pixels, joined into closed rings with
   the foreground on the right. Diagonal neighbours are kept apart (always the
   right turn), so every ring is simple. Outer rings come out with positive
   area, holes with negative. Coordinates are pixel corners. */
function traceMaskRings(m, W, H) {
    const VW = W + 1, out = new Map();
    const add = (x0, y0, x1, y1) => {
        const k = y0 * VW + x0;
        let a = out.get(k);
        if (!a)
            out.set(k, a = []);
        a.push(y1 * VW + x1);
    };
    for (let y = 0; y < H; y++)
        for (let x = 0; x < W; x++) {
            if (!m[y * W + x])
                continue;
            if (y === 0 || !m[(y - 1) * W + x])
                add(x, y, x + 1, y);
            if (x === W - 1 || !m[y * W + x + 1])
                add(x + 1, y, x + 1, y + 1);
            if (y === H - 1 || !m[(y + 1) * W + x])
                add(x + 1, y + 1, x, y + 1);
            if (x === 0 || !m[y * W + x - 1])
                add(x, y + 1, x, y);
        }
    const rings = [];
    const take = (k, want) => {
        const a = out.get(k);
        const i = want == null ? 0 : a.indexOf(want);
        if (i < 0)
            return -1;
        const e = a[i];
        a.splice(i, 1);
        if (!a.length)
            out.delete(k);
        return e;
    };
    while (out.size) {
        /* Start where only one edge leaves, so the ring closes exactly there. */
        let start = -1;
        for (const [k, a] of out)
            if (a.length === 1) {
                start = k;
                break;
            }
        if (start < 0)
            start = out.keys().next().value;
        const ring = [];
        let prev = start, cur = take(start, null);
        ring.push({ x: start % VW, y: Math.floor(start / VW) });
        for (let guard = 0; cur !== start && guard < 4 * W * H + 8; guard++) {
            const cx = cur % VW, cy = Math.floor(cur / VW), dx = cx - prev % VW, dy = cy - Math.floor(prev / VW);
            ring.push({ x: cx, y: cy });
            let next = -1;
            for (const [tx, ty] of [[-dy, dx], [dx, dy], [dy, -dx]]) {
                if (!out.has(cur))
                    break;
                next = take(cur, (cy + ty) * VW + (cx + tx));
                if (next >= 0)
                    break;
            }
            if (next < 0)
                break;
            prev = cur;
            cur = next;
        }
        if (ring.length >= 4)
            rings.push(ring);
    }
    return rings;
}
/* Douglas-Peucker on a closed ring, after dropping points on straight runs. */
function simplifyRing(ring, tol) {
    const n0 = ring.length, pts = [];
    for (let i = 0; i < n0; i++) {
        const a = ring[(i - 1 + n0) % n0], b = ring[i], c = ring[(i + 1) % n0];
        if ((b.x - a.x) * (c.y - b.y) !== (b.y - a.y) * (c.x - b.x))
            pts.push(b);
    }
    const n = pts.length;
    if (n < 4)
        return pts;
    let far = 0, fd = -1;
    for (let i = 1; i < n; i++) {
        const d = (pts[i].x - pts[0].x) ** 2 + (pts[i].y - pts[0].y) ** 2;
        if (d > fd) {
            fd = d;
            far = i;
        }
    }
    const keep = new Uint8Array(n + 1), t2 = tol * tol;
    keep[0] = keep[far] = keep[n] = 1;
    const at = i => pts[i % n];
    const stack = [[0, far], [far, n]];
    while (stack.length) {
        const [a, b] = stack.pop();
        let best = -1, bd = t2;
        for (let i = a + 1; i < b; i++) {
            const d = pointSegDist2(at(i).x, at(i).y, at(a), at(b));
            if (d > bd) {
                bd = d;
                best = i;
            }
        }
        if (best >= 0) {
            keep[best] = 1;
            stack.push([a, best], [best, b]);
        }
    }
    const res = [];
    for (let i = 0; i < n; i++)
        if (keep[i])
            res.push(pts[i]);
    return res;
}
/* An outline minus its holes minus other areas, traced back into outlines.
   `minus` holds areas as { polys, holes }: a hole in one of them is not part of
   it, so it is not taken away. Null when nothing is taken; otherwise the
   outlines and holes the result is made of. */
function traceDifference(poly, holes, minus) {
    const b = ringBox(poly), w = b.x1 - b.x0, h = b.y1 - b.y0;
    const s = Math.max(1, Math.sqrt((w + 4) * (h + 4) / CUT_MAX_CELLS));
    const ox = b.x0 - 2 * s, oy = b.y0 - 2 * s;
    const W = Math.ceil((w + 4 * s) / s) + 1, H = Math.ceil((h + 4 * s) / s) + 1;
    const cv = makeMaskCanvas(W, H), g = cv.getContext('2d', { willReadFrequently: true });
    g.setTransform(1 / s, 0, 0, 1 / s, -ox / s, -oy / s);
    const ringPath = (r, fresh = true) => {
        if (fresh)
            g.beginPath();
        g.moveTo(r[0].x, r[0].y);
        for (let i = 1; i < r.length; i++)
            g.lineTo(r[i].x, r[i].y);
        g.closePath();
    };
    g.fillStyle = '#fff';
    ringPath(poly);
    g.fill('nonzero');
    g.globalCompositeOperation = 'destination-out';
    for (const hole of holes) {
        ringPath(hole);
        g.fill('nonzero');
    }
    const count = () => {
        const d = g.getImageData(0, 0, W, H).data, m = new Uint8Array(W * H);
        let n = 0;
        for (let i = 0; i < m.length; i++)
            if (d[i * 4 + 3] >= 128) {
                m[i] = 1;
                n++;
            }
        return { m, n };
    };
    const before = count();
    for (const area of minus) {
        const keep = (area.holes || []).filter(r => r && r.length > 2);
        g.save();
        if (keep.length) {
            g.beginPath();
            g.rect(ox - 10, oy - 10, W * s + 20, H * s + 20);
            for (const r of keep)
                ringPath(r, false);
            g.clip('evenodd');
        }
        g.globalCompositeOperation = 'destination-out';
        for (const r of area.polys)
            if (r && r.length > 2) {
                ringPath(r);
                g.fill('nonzero');
            }
        g.restore();
    }
    const after = count();
    if (after.n === before.n)
        return null;
    const outer = [], inner = [], minArea = CUT_MIN_AREA / (s * s);
    for (const r of traceMaskRings(after.m, W, H)) {
        const a = ringArea(r);
        if (Math.abs(a) < minArea)
            continue;
        const simple = simplifyRing(r, 1);
        if (simple.length < 3)
            continue;
        const img = densifyClosedPoly(simple.map(p => ({ x: ox + p.x * s, y: oy + p.y * s })), 2);
        (a > 0 ? outer : inner).push(img);
    }
    return { outer, inner };
}
function cutOutline(poly, holes, cut) {
    return traceDifference(poly, holes, [{ polys: [cut] }]);
}
/* The crossing of ring A's segments near index ka with ring B's near kb that is
   closest to `near`, with where it falls on each; null if they do not cross. */
function edgesCrossNear(RA, ka, RB, kb, w, near) {
    let best = null, bd = Infinity;
    const na = RA.length, nb = RB.length;
    for (let da = -w; da <= w; da++) {
        const i = ((ka + da) % na + na) % na, a0 = RA[i], a1 = RA[(i + 1) % na];
        for (let db = -w; db <= w; db++) {
            const j = ((kb + db) % nb + nb) % nb, b0 = RB[j], b1 = RB[(j + 1) % nb];
            const rx = a1.x - a0.x, ry = a1.y - a0.y, sx = b1.x - b0.x, sy = b1.y - b0.y;
            const den = rx * sy - ry * sx;
            if (Math.abs(den) < 1e-12)
                continue;
            const qx = b0.x - a0.x, qy = b0.y - a0.y;
            const t = (qx * sy - qy * sx) / den, u = (qx * ry - qy * rx) / den;
            if (t < 0 || t > 1 || u < 0 || u > 1)
                continue;
            const x = a0.x + t * rx, y = a0.y + t * ry, d = (x - near.x) ** 2 + (y - near.y) ** 2;
            if (d < bd) {
                bd = d;
                best = { ka: i, ta: t, kb: j, tb: u, x, y };
            }
        }
    }
    return best;
}
/* Where a traced outline runs along another region's edge, make it that edge,
   vertex for vertex, so the two regions share one border: nothing between them
   and nothing claimed twice. Each run of points within `tol` of the same edge is
   replaced by the stretch of that edge between where the run starts and ends. */
function snapRingToBorders(ring, borders, tol) {
    const n = ring.length, t2 = tol * tol;
    const near = borders.map(r => ({ r, box: ringBox(r) }));
    const hit = ring.map(p => {
        let best = null, bd = t2;
        for (let bi = 0; bi < near.length; bi++) {
            const { r, box } = near[bi];
            if (p.x < box.x0 - tol || p.x > box.x1 + tol || p.y < box.y0 - tol || p.y > box.y1 + tol)
                continue;
            for (let k = 0; k < r.length; k++) {
                const a = r[k], c = r[(k + 1) % r.length];
                const vx = c.x - a.x, vy = c.y - a.y, vv = vx * vx + vy * vy || 1e-12;
                let t = ((p.x - a.x) * vx + (p.y - a.y) * vy) / vv;
                t = t < 0 ? 0 : t > 1 ? 1 : t;
                const qx = a.x + t * vx, qy = a.y + t * vy, d = (p.x - qx) ** 2 + (p.y - qy) ** 2;
                if (d <= bd) {
                    bd = d;
                    best = { bi, k, t, x: qx, y: qy };
                }
            }
        }
        return best;
    });
    /* Start where a run begins: a free point, or a change of edge. */
    const firstFree = hit.findIndex((h, i) => {
        const prev = hit[(i - 1 + n) % n];
        return !h || !prev || prev.bi !== h.bi;
    });
    if (firstFree < 0)
        /* All of it lies along one edge: it IS that outline. */
        return near[hit[0].bi].r.map(p => ({ x: p.x, y: p.y }));
    const out = [], push = p => {
        const last = out[out.length - 1];
        if (!last || Math.abs(last.x - p.x) > 1e-9 || Math.abs(last.y - p.y) > 1e-9)
            out.push({ x: p.x, y: p.y });
    };
    const along = (B, from, to, forward) => {
        const m = B.length, pts = [{ x: from.x, y: from.y }];
        if (forward) {
            if (!(from.k === to.k && to.t >= from.t))
                for (let k = (from.k + 1) % m, g = 0; g < m; k = (k + 1) % m, g++) {
                    pts.push(B[k]);
                    if (k === to.k)
                        break;
                }
        }
        else if (!(from.k === to.k && to.t <= from.t))
            for (let k = from.k, g = 0; g < m; k = (k - 1 + m) % m, g++) {
                pts.push(B[k]);
                if (k === (to.k + 1) % m)
                    break;
            }
        pts.push({ x: to.x, y: to.y });
        return pts;
    };
    const len = pts => { let L = 0; for (let i = 1; i < pts.length; i++)
        L += Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y); return L; };
    const items = [];
    for (let step = 0; step < n;) {
        const i = (firstFree + step) % n;
        if (!hit[i]) {
            items.push({ p: ring[i] });
            step++;
            continue;
        }
        const bi = hit[i].bi, run = [];
        while (step < n && hit[(firstFree + step) % n] && hit[(firstFree + step) % n].bi === bi) {
            run.push((firstFree + step) % n);
            step++;
        }
        const from = hit[run[0]], to = hit[run[run.length - 1]], B = near[bi].r;
        const drawnLen = len(run.map(j => ring[j]));
        const fwd = Math.abs(len(along(B, from, to, true)) - drawnLen) <= Math.abs(len(along(B, from, to, false)) - drawnLen);
        items.push({ bi, from, to, fwd });
    }
    /* Where one edge hands over to another, meet at the point where they
       actually cross, so no sliver is left between them. */
    for (let a = 0; a < items.length && items.length > 1; a++) {
        const A = items[a], Bn = items[(a + 1) % items.length];
        if (A.bi == null || Bn.bi == null || A.bi === Bn.bi)
            continue;
        const X = edgesCrossNear(near[A.bi].r, A.to.k, near[Bn.bi].r, Bn.from.k, 4, A.to);
        if (!X)
            continue;
        const RA = near[A.bi].r, RB = near[Bn.bi].r;
        const oldA = len(along(RA, A.from, A.to, A.fwd)), oldB = len(along(RB, Bn.from, Bn.to, Bn.fwd));
        const toA = { k: X.ka, t: X.ta, x: X.x, y: X.y }, fromB = { k: X.kb, t: X.tb, x: X.x, y: X.y };
        if (Math.abs(len(along(RA, A.from, toA, A.fwd)) - oldA) < 8 && Math.abs(len(along(RB, fromB, Bn.to, Bn.fwd)) - oldB) < 8) {
            A.to = toA;
            Bn.from = fromB;
        }
    }
    for (const it of items) {
        if (it.bi == null)
            push(it.p);
        else
            along(near[it.bi].r, it.from, it.to, it.fwd).forEach(push);
    }
    if (out.length > 1 && Math.abs(out[0].x - out[out.length - 1].x) < 1e-9 && Math.abs(out[0].y - out[out.length - 1].y) < 1e-9)
        out.pop();
    return out.length >= 3 ? out : ring;
}
/* A lasso loop added to region `ri`. Other regions keep what they have: the
   part of the loop over them is left out, and where the new outline meets them
   it follows their edge exactly. A region the loop surrounds becomes a hole in
   the new one; a hole of this region the loop covers is filled in. */
function addLassoArea(ri, loop) {
    const R = S.regions[ri], lb = ringBox(loop);
    const relevant = S.regions.filter((o, k) => k !== ri)
        .map(o => ({ polys: regionPolys(o).filter(p => p && p.length > 2), holes: regionHoles(o) }))
        .filter(o => o.polys.some(p => boxesMeet(ringBox(p), lb)));
    let outer = [loop], inner = [], trimmed = false;
    const res = relevant.length ? traceDifference(loop, [], relevant) : null;
    if (res) {
        trimmed = true;
        /* The loop itself too, so away from other regions the outline is
           exactly the stroke that was drawn, not its pixel tracing. */
        const borders = relevant.flatMap(o => o.polys.concat(o.holes)).filter(r => r && r.length > 2).concat([loop]);
        outer = res.outer.map(r => snapRingToBorders(r, borders, 2));
        inner = res.inner.map(r => snapRingToBorders(r, borders, 2));
    }
    if (!outer.length)
        return { added: 0, trimmed };
    if (!R.polys)
        R.polys = (R.poly && R.poly.length) ? [R.poly] : [];
    delete R.poly;
    R.polys.push(...outer);
    let holes = [];
    for (const h of regionHoles(R)) {
        const left = boxesMeet(ringBox(h), lb) ? traceDifference(h, [], [{ polys: [loop] }]) : null;
        holes = holes.concat(left ? left.outer : [h]);
    }
    holes = holes.concat(inner);
    if (holes.length)
        R.holes = holes;
    else
        delete R.holes;
    return { added: outer.length, trimmed };
}
/* Cut the loop out of every region it crosses. Returns the names of the regions
   it changed. */
function cutRegions(cut) {
    const cb = ringBox(cut), changed = [];
    for (const R of S.regions) {
        const polys = regionPolys(R), holes = regionHoles(R);
        let nextPolys = [], nextHoles = holes.slice(), touched = false;
        for (const poly of polys) {
            if (!poly || poly.length < 3 || !boxesMeet(ringBox(poly), cb)) {
                nextPolys.push(poly);
                continue;
            }
            const mine = holes.filter(hh => hh && hh.length > 2 && pointInPoly(hh[0].x, hh[0].y, poly));
            const res = cutOutline(poly, mine, cut);
            if (!res) {
                nextPolys.push(poly);
                continue;
            }
            touched = true;
            nextPolys = nextPolys.concat(res.outer);
            nextHoles = nextHoles.filter(hh => !mine.includes(hh)).concat(res.inner);
        }
        if (!touched)
            continue;
        R.polys = nextPolys;
        delete R.poly;
        if (nextHoles.length)
            R.holes = nextHoles;
        else
            delete R.holes;
        changed.push(R.name);
    }
    return changed;
}
function cloneRegionsForUndo(regions) {
    const ring = r => r.map(p => ({ x: p.x, y: p.y }));
    return regions.map(R => {
        const q = Object.assign({}, R, { polys: regionPolys(R).map(ring) });
        delete q.poly;
        if (R.holes)
            q.holes = R.holes.map(ring);
        return q;
    });
}
/* ------------------------- colocalisation ------------------------------ */
function colocIndex() {
    /* the partner named by the current selection, if it is a pairing */
    if (!S.colocIdx || !S.colocIdx.length)
        return -1;
    return S.colocIdx[0];
}
const HB = 48, HLO = -2, HHI = 22;
const LHB = 128, LHLO = -0.25, LHHI = 1.00;
const JHB = 128, JHLO = 0, JHHI = 1.00;
function hbin(v) { const i = Math.floor((v - HLO) / (HHI - HLO) * HB); return i < 0 ? 0 : (i >= HB ? HB - 1 : i); }
function lhbin(v) { const i = Math.floor((v - LHLO) / (LHHI - LHLO) * LHB); return i < 0 ? 0 : (i >= LHB ? LHB - 1 : i); }
function jhbin(v) { const i = Math.floor((v - JHLO) / (JHHI - JHLO) * JHB); return i < 0 ? 0 : (i >= JHB ? JHB - 1 : i); }
/* Fraction of this soma's pixels that clear a normalized local-contrast cut. */
function fillIn(c, k, thr) {
    if (!c.npx)
        return null;
    if (c.jhist) {
        let n = 0;
        for (let b = jhbin(thr); b < JHB; b++)
            n += c.jhist[k * JHB + b];
        return n / c.npx;
    }
    if (c.lhist) {
        let n = 0;
        for (let b = lhbin(thr); b < LHB; b++)
            n += c.lhist[k * LHB + b];
        return n / c.npx;
    }
    if (!c.hist)
        return null;
    let n = 0;
    for (let b = hbin(4); b < HB; b++)
        n += c.hist[k * HB + b];
    return n / c.npx;
}
function colocValue(c) {
    const k = colocIndex();
    if (k < 0)
        return null;
    const bleed = +$('bleed').value / 100;
    if (c.local && isFinite(c.local[k]))
        return c.local[k] - bleed * Math.max(0, c.local[0] || 0);
    return c.z && isFinite(c.z[k]) ? c.z[k] - bleed * (c.z[0] || 0) : null;
}
function colocFill(c) {
    const k = colocIndex();
    if (k < 0)
        return null;
    const bleed = +$('bleed').value / 100;
    const primaryLocal = c.local && isFinite(c.local[0]) ? Math.max(0, c.local[0]) : 0;
    const base = +$('colocThr').value / 100;
    const thr = base + bleed * primaryLocal;
    return fillIn(c, k, thr);
}
function isColoc(c) {
    const k = colocIndex();
    if (k < 0)
        return false;
    const f = colocFill(c);
    if (f == null) {
        const v = colocValue(c);
        return v != null && v >= +$('colocThr').value / 100;
    }
    return f >= +$('minFill').value / 100 && passesColocFloor(c);
}
function updateColoc() {
    const k = colocIndex();
    if (k < 0 || !S.cells.length) {
        $('colocOut').textContent = '';
        return;
    }
    const dbl = S.cells.filter(isColoc).length;
    const name = (S.compUsed || []).slice(1).join(' + ') || 'the partner channel';
    const fills = S.cells.map(colocFill).filter(v => v != null);
    const med = fills.length ? fills.slice().sort((a, b) => a - b)[fills.length >> 1] : null;
    $('colocOut').innerHTML = `<b>${dbl}</b> of ${S.cells.length} also positive in ${name} ` +
        `(${(100 * dbl / S.cells.length).toFixed(1)}%)` +
        (med != null ? ` · median fill ${(100 * med).toFixed(0)}%` : '');
}
/* ---------------------------- rendering -------------------------------- */
/* ---- Display colours, chosen the way Image Prep chooses them --------------
   The caption under the image names each shown channel in the colour it is
   drawn in, and each name is a button, exactly as on an Image Prep card:
   - a merge keeps its false-colour set (magenta + green for two channels, red,
     green and blue for three) and the choice is which channel gets which --
     a click swaps the pair, or trades one of three with another;
   - a single channel picks its own colour from Image Prep's swatches.
   Display only: detection and every measurement read the untouched channel
   data. Choices are kept per section, like per image in Image Prep. */
const PAIR_ROLES = ['magenta', 'green'], TRIPLE_ROLES = ['red', 'green', 'blue'];
const ROLE_HEX = Object.freeze({ magenta: '#ff00ff', green: '#00ff00', red: '#ff0000', blue: '#0000ff' });
const ROLE_LABEL = Object.freeze({ magenta: 'Magenta', green: 'Green', red: 'Red', blue: 'Blue' });
/* The same list, labels and colours as Image Prep's single-channel menu.
   A channel starts in the false colour its name implies (DAPI blue, FITC
   green, Cy3 red, Cy5 orange; Grays when the name says nothing) until another
   is picked; Source colour is the lighter tint its button carries. */
const SINGLE_LUTS = Object.freeze([
    { key: 'source', label: 'Source colour' },
    { key: 'gray', label: 'Grays', rgb: null },
    { key: 'mergeMagenta', label: 'Magenta', rgb: ToolkitCore.colors.mergeMagenta },
    { key: 'mergeGreen', label: 'Green', rgb: ToolkitCore.colors.mergeGreen },
    { key: 'tripleRed', label: 'Red', rgb: ToolkitCore.colors.tripleRed },
    { key: 'tripleBlue', label: 'Blue', rgb: ToolkitCore.colors.tripleBlue },
    { key: 'cyan', label: 'Cyan', rgb: ToolkitCore.colors.cyan },
    { key: 'yellow', label: 'Yellow', rgb: ToolkitCore.colors.yellow },
    { key: 'orange', label: 'Orange', rgb: ToolkitCore.colors.orange }
]);
function channelLabelAt(sec, i) {
    const c = sec && sec.channels && sec.channels[i];
    return (c && c.name) || ('Channel ' + (i + 1));
}
function mergeRoleSetFor(n) { return n === 2 ? PAIR_ROLES : (n === 3 ? TRIPLE_ROLES : null); }
function mergeRoleKey(idx) { return idx.slice().sort((a, b) => a - b).join(','); }
/* Which role each shown channel has. Kept per set of shown channels, the way
   each merge in Image Prep keeps its own; anything stale or incomplete falls
   back to the order the colours have always been handed out in. */
function mergeRolesFor(sec, idx) {
    const set = mergeRoleSetFor(idx.length);
    if (!set)
        return null;
    const saved = sec && sec.mergeRoles && sec.mergeRoles[mergeRoleKey(idx)];
    if (saved && idx.every(i => set.includes(saved[i])) && new Set(idx.map(i => saved[i])).size === idx.length)
        return idx.map(i => saved[i]);
    return idx.map((_, n) => set[n]);
}
function setMergeRoles(sec, idx, roles) {
    sec.mergeRoles = sec.mergeRoles || {};
    const entry = {};
    idx.forEach((i, n) => { entry[i] = roles[n]; });
    sec.mergeRoles[mergeRoleKey(idx)] = entry;
    drawBase();
    drawOverlay();
}
function swapMergeRoles(sec, idx) {
    const roles = mergeRolesFor(sec, idx);
    if (roles && roles.length === 2)
        setMergeRoles(sec, idx, [roles[1], roles[0]]);
}
/* One of three takes another's colour; that one takes its old colour. */
function tradeMergeRole(sec, idx, pos, targetRole) {
    const roles = mergeRolesFor(sec, idx), other = roles ? roles.indexOf(targetRole) : -1;
    if (!roles || other < 0 || other === pos)
        return;
    const next = roles.slice();
    next[other] = roles[pos];
    next[pos] = targetRole;
    setMergeRoles(sec, idx, next);
}
/* The colour each shown channel is drawn in, for a merge. */
function mergeColoursFor(sec, idx, show) {
    const roles = mergeRolesFor(sec, idx);
    if (roles)
        return roles.map(r => ROLE_HEX[r]);
    return show.map((c, i) => (c && c.color) || CHANNEL_COLOURS[i % CHANNEL_COLOURS.length]);
}
function defaultSingleLutKey(sec, i) {
    const n = String((sec && sec.channels && sec.channels[i] && sec.channels[i].name) || '').toLowerCase();
    if (/dapi|hoechst|405/.test(n))
        return 'tripleBlue';
    if (/fitc|gfp|egfp|alexa[ _-]?488|af[ _-]?488|488/.test(n))
        return 'mergeGreen';
    if (/cy3|tritc|alexa[ _-]?555|af[ _-]?555|alexa[ _-]?568|af[ _-]?568|555|561|568/.test(n))
        return 'tripleRed';
    if (/cy5|alexa[ _-]?647|af[ _-]?647|647|far[ _-]?red/.test(n))
        return 'orange';
    return 'gray';
}
function singleLutKey(sec, i) {
    const k = sec && sec.channelLuts && sec.channelLuts[i];
    if (k === 'custom' && sec.channelLutCustom && Array.isArray(sec.channelLutCustom[i]))
        return k;
    return SINGLE_LUTS.some(o => o.key === k) ? k : defaultSingleLutKey(sec, i);
}
/* A single channel's colour as 0-1 fractions, or null for grays. */
function singleLutRgb(sec, i) {
    const key = singleLutKey(sec, i);
    if (key === 'gray')
        return null;
    if (key === 'source') {
        const hex = channelButtonColor(sec.channels[i], i);
        return [1, 3, 5].map(k => parseInt(hex.slice(k, k + 2), 16) / 255);
    }
    if (key === 'custom')
        return sec.channelLutCustom[i].map(v => v / 255);
    const opt = SINGLE_LUTS.find(o => o.key === key);
    return opt && opt.rgb ? opt.rgb.map(v => v / 255) : null;
}
function setSingleLut(sec, i, key, customRgb = null) {
    sec.channelLuts = sec.channelLuts || [];
    if (key === 'custom') {
        sec.channelLutCustom = sec.channelLutCustom || [];
        sec.channelLutCustom[i] = customRgb;
    }
    if (key == null)
        delete sec.channelLuts[i];
    else
        sec.channelLuts[i] = key;
    scheduleChannelRedraw();
}
/* ---- Levels, as on an Image Prep channel button ---------------------------
   Black and white points, brightness, contrast and invert for each channel of
   the section, with Image Prep's own arithmetic (ToolkitCore.display.figurePrep)
   applied to the 0-255 value the channel is drawn with, alone and in merges.
   Display only, like the colours: detection and measurements read the channel
   data, never these. */
const FIGURE_PREP = ToolkitCore.display.figurePrep;
function channelLevels(sec, i) { return FIGURE_PREP.normalizeLevels(sec && sec.channelLevels && sec.channelLevels[i]); }
function levelsUntouched(l) { return l.min === 0 && l.max === 255 && !l.brightness && !l.contrast && !l.curve && !l.invert; }
/* The 256-entry table for a channel, or null while it is untouched. */
function channelLevelLut(sec, i) {
    const l = channelLevels(sec, i);
    return levelsUntouched(l) ? null : FIGURE_PREP.buildLut(l);
}
function setChannelLevels(sec, i, mutator) {
    sec.channelLevels = sec.channelLevels || [];
    sec.channelLevels[i] = FIGURE_PREP.normalizeLevels(mutator(channelLevels(sec, i)));
    scheduleChannelRedraw();
}
/* A slider or a drag asks many times a frame; the picture is drawn once. */
let channelRedrawPending = false;
function scheduleChannelRedraw() {
    refreshChannelPanel();
    if (channelRedrawPending)
        return;
    channelRedrawPending = true;
    requestAnimationFrame(() => {
        channelRedrawPending = false;
        drawBase();
        drawOverlay();
        refreshChannelPanel();
    });
}
/* What the channel's own picture is made of: its pixels as the 0-255 values
   the black and white points act on. */
const levelHistMemo = new WeakMap();
function channelLevelHistogram(sec, i) {
    const c = currentDisplayChannels(sec)[i];
    if (!c || !c.data)
        return null;
    let bins = levelHistMemo.get(c.data);
    if (!bins) {
        const { lo, hi } = cachedRange(c.data), span = (hi - lo) || 1, src = c.data;
        bins = new Float64Array(256);
        const step = Math.max(1, Math.floor(src.length / 2000000));
        for (let k = 0; k < src.length; k += step)
            bins[clamp(Math.round((src[k] - lo) / span * 255), 0, 255)]++;
        levelHistMemo.set(c.data, bins);
    }
    return bins;
}
/* Image Prep's Auto: the 0.1th and 99.8th percentiles of the nonzero values. */
function autoChannelLevels(sec, i) {
    const bins = channelLevelHistogram(sec, i);
    let total = 0;
    for (let v = 1; v < 256; v++)
        total += bins ? bins[v] : 0;
    if (!total)
        return { min: 0, max: 255 };
    const q = f => {
        const rank = Math.floor(f * (total - 1));
        let acc = 0;
        for (let v = 1; v < 256; v++) {
            acc += bins[v];
            if (acc > rank)
                return v;
        }
        return 255;
    };
    const lo = q(0.001), hi = q(0.998);
    return hi > lo ? { min: lo, max: hi } : { min: 0, max: 255 };
}
function drawChannelLevelHistogram(sec, i, cv) {
    const ctx = cv.getContext('2d'), pad = 6, base = cv.height - 12, top = 4, gw = cv.width - pad * 2, gh = base - top;
    ctx.fillStyle = '#050607';
    ctx.fillRect(0, 0, cv.width, cv.height);
    const bins = channelLevelHistogram(sec, i);
    if (!bins)
        return;
    const v = channelLevels(sec, i), x = k => pad + k * gw / 255, rgb = (singleLutRgb(sec, i) || [0.75, 0.78, 0.8]).map(f => Math.round(f * 255));
    const logs = Array.from(bins, n => Math.log1p(n)), mx = Math.max(1e-9, ...logs);
    ctx.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},.7)`;
    for (let k = 0; k < 256; k++) {
        const bh = logs[k] / mx * gh;
        ctx.fillRect(x(k) - gw / 512, base - bh, Math.max(1, gw / 256 + .3), bh);
    }
    ctx.fillStyle = 'rgba(0,0,0,.55)';
    ctx.fillRect(pad, top, x(v.min) - pad, gh);
    ctx.fillRect(x(v.max), top, pad + gw - x(v.max), gh);
    ctx.save();
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    for (const [at, colour] of [[v.min, 'rgba(160,172,184,.8)'], [v.max, 'rgba(255,255,255,.8)']]) {
        ctx.strokeStyle = colour;
        ctx.beginPath();
        ctx.moveTo(Math.round(x(at)) + .5, top);
        ctx.lineTo(Math.round(x(at)) + .5, base);
        ctx.stroke();
    }
    ctx.restore();
    const lut = FIGURE_PREP.buildLut(v);
    ctx.strokeStyle = 'rgba(255,255,255,.85)';
    ctx.lineWidth = 1.2;
    ctx.beginPath();
    for (let k = 0; k < 256; k++) {
        const yy = base - clamp(lut[k], 0, 255) / 255 * gh;
        k ? ctx.lineTo(x(k), yy) : ctx.moveTo(x(k), yy);
    }
    ctx.stroke();
    ctx.fillStyle = '#1b222b';
    ctx.fillRect(0, base, cv.width, cv.height - base);
    const tri = (k, fill) => { ctx.fillStyle = fill; ctx.strokeStyle = '#9aa7b4'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x(k), base + 1); ctx.lineTo(x(k) - 5, base + 10); ctx.lineTo(x(k) + 5, base + 10); ctx.closePath(); ctx.fill(); ctx.stroke(); };
    tri(v.min, '#000');
    tri(v.max, '#fff');
}
function singleLutHex(sec, i) {
    const f = singleLutRgb(sec, i);
    return f ? ToolkitCore.colors.rgbToHex(f.map(v => v * 255)) : '#d8dee6';
}
/* The popover itself is Image Prep's: the same classes, anchored under its
   button, kept on screen, closed by the next click outside it. */
let colourMenu = null;
function closeColourMenu() {
    if (colourMenu && colourMenu._away)
        document.removeEventListener('pointerdown', colourMenu._away);
    if (colourMenu)
        colourMenu.remove();
    colourMenu = null;
}
function mountColourMenu(button, menu) {
    document.body.appendChild(menu);
    const r = button.getBoundingClientRect(), mr = menu.getBoundingClientRect();
    menu.style.left = `${Math.max(8, Math.min(innerWidth - mr.width - 8, r.left))}px`;
    /* The buttons live in the bottom bar, so there is usually no room below:
       open above the button then, instead of being pushed up over it. */
    const below = r.bottom + 5, above = r.top - mr.height - 5;
    menu.style.top = `${Math.max(8, below + mr.height + 8 > innerHeight && above >= 8 ? above : Math.min(innerHeight - mr.height - 8, below))}px`;
    colourMenu = menu;
    // Added only if still open: one closed before this ran left a listener closing every later menu.
    menu._away = e => {
        if (colourMenu !== menu)
            document.removeEventListener('pointerdown', menu._away);
        else if (!menu.contains(e.target))
            closeColourMenu();
    };
    setTimeout(() => { if (colourMenu === menu)
        document.addEventListener('pointerdown', menu._away); }, 0);
}
function openTripleRoleMenu(button, sec, idx, pos) {
    closeColourMenu();
    const roles = mergeRolesFor(sec, idx), menu = document.createElement('div');
    menu.className = 'merge-role-menu';
    for (const roleKey of TRIPLE_ROLES.filter(r => r !== roles[pos])) {
        const b = document.createElement('button');
        b.type = 'button';
        b.innerHTML = ToolkitCore.channels.roleBadgeHtml(ROLE_LABEL[roleKey], ROLE_LABEL[roleKey]);
        b.onclick = e => { e.stopPropagation(); closeColourMenu(); tradeMergeRole(sec, idx, pos, roleKey); };
        menu.appendChild(b);
    }
    mountColourMenu(button, menu);
}
/* The channel button's panel, as on an Image Prep card: colour, histogram,
   black and white points, brightness, contrast, Auto, Reset and Invert. */
const CHANNEL_PANEL_FIELDS = Object.freeze([
    { key: 'min', label: 'Black', min: 0, max: 254 },
    { key: 'max', label: 'White', min: 1, max: 255 },
    { key: 'brightness', label: 'Bright', min: -100, max: 100 },
    { key: 'contrast', label: 'Contrast', min: -100, max: 100 }
]);
let channelPanel = null;
function refreshChannelPanel() {
    const cp = channelPanel;
    if (!cp || colourMenu !== cp.panel || !cp.panel.isConnected)
        return;
    const { panel, sec, i } = cp, v = channelLevels(sec, i), current = singleLutKey(sec, i);
    panel.querySelector('.chan-panel-head').innerHTML = ToolkitCore.channels.mergeLegendHtml([{ label: channelLabelAt(sec, i), color: singleLutHex(sec, i) }]);
    panel.querySelectorAll('button.chan-swatch').forEach(b => b.classList.toggle('current', b.dataset.lut === current));
    panel.querySelector('.chan-swatch-custom').classList.toggle('current', current === 'custom');
    panel.querySelectorAll('[data-lv-key]').forEach(el => {
        if (document.activeElement !== el)
            el.value = v[el.dataset.lvKey];
        panel.querySelector(`[data-lv-num="${el.dataset.lvKey}"]`).textContent = v[el.dataset.lvKey];
    });
    panel.querySelector('[data-level-action="invert"]').setAttribute('aria-pressed', String(!!v.invert));
    drawChannelLevelHistogram(sec, i, panel.querySelector('canvas'));
}
function openSingleLutMenu(button, sec, i) {
    closeColourMenu();
    const panel = document.createElement('div');
    panel.className = 'merge-role-menu chan-panel';
    const head = document.createElement('div');
    head.className = 'chan-panel-head';
    panel.appendChild(head);
    const row = document.createElement('div');
    row.className = 'chan-swatches';
    for (const opt of SINGLE_LUTS) {
        const hex = opt.key === 'source' ? channelButtonColor(sec.channels[i], i)
            : opt.rgb ? ToolkitCore.colors.rgbToHex(opt.rgb) : '#bec4cc';
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'chan-swatch';
        b.dataset.lut = opt.key;
        b.style.background = hex;
        b.title = opt.label;
        b.setAttribute('aria-label', opt.label);
        b.onclick = () => setSingleLut(sec, i, opt.key);
        row.appendChild(b);
    }
    const custom = document.createElement('label');
    custom.className = 'chan-swatch chan-swatch-custom';
    custom.title = 'Custom colour';
    const pick = document.createElement('input');
    pick.type = 'color';
    pick.setAttribute('aria-label', 'Custom colour');
    pick.value = singleLutHex(sec, i);
    pick.addEventListener('input', () => {
        const h = pick.value.replace('#', '');
        setSingleLut(sec, i, 'custom', [0, 2, 4].map(k => parseInt(h.slice(k, k + 2), 16)));
    });
    custom.appendChild(pick);
    row.appendChild(custom);
    panel.appendChild(row);
    const hist = document.createElement('canvas');
    hist.width = 232;
    hist.height = 76;
    hist.className = 'chan-hist';
    hist.title = 'Drag the triangles, or anywhere along the plot, to move the black and white points';
    /* A press takes the nearer of the two points, wherever it lands. */
    hist.addEventListener('pointerdown', down => {
        if (down.button !== 0)
            return;
        down.preventDefault();
        down.stopPropagation();
        const at = ev => {
            const r = hist.getBoundingClientRect(), px = (ev.clientX - r.left) * hist.width / Math.max(1, r.width);
            return clamp(Math.round((px - 6) / (hist.width - 12) * 255), 0, 255);
        };
        const v0 = channelLevels(sec, i), first = at(down), key = Math.abs(first - v0.min) <= Math.abs(first - v0.max) ? 'min' : 'max';
        const put = ev => {
            const n = at(ev);
            setChannelLevels(sec, i, cur => ({ ...cur, [key]: key === 'min' ? Math.min(n, cur.max - 1) : Math.max(n, cur.min + 1) }));
        };
        put(down);
        try {
            hist.setPointerCapture(down.pointerId);
        }
        catch (_) { }
        const up = () => { hist.removeEventListener('pointermove', put); hist.removeEventListener('pointerup', up); hist.removeEventListener('pointercancel', up); };
        hist.addEventListener('pointermove', put);
        hist.addEventListener('pointerup', up);
        hist.addEventListener('pointercancel', up);
    });
    panel.appendChild(hist);
    for (const f of CHANNEL_PANEL_FIELDS) {
        const r = document.createElement('label');
        r.className = 'chan-slider';
        const name = document.createElement('span');
        name.textContent = f.label;
        const input = document.createElement('input');
        input.type = 'range';
        input.min = String(f.min);
        input.max = String(f.max);
        input.step = '1';
        input.dataset.lvKey = f.key;
        const num = document.createElement('span');
        num.className = 'chan-num';
        num.dataset.lvNum = f.key;
        input.addEventListener('input', () => setChannelLevels(sec, i, cur => ({ ...cur, [f.key]: Math.round(Number(input.value)) })));
        r.append(name, input, num);
        panel.appendChild(r);
    }
    const actions = document.createElement('div');
    actions.className = 'chan-actions';
    const mk = (text, title, run) => { const b = document.createElement('button'); b.type = 'button'; b.textContent = text; b.title = title; b.onclick = run; actions.appendChild(b); return b; };
    mk('Auto', 'Set the black and white points from this channel\u2019s own histogram', () => setChannelLevels(sec, i, cur => ({ ...cur, ...autoChannelLevels(sec, i) })));
    mk('Reset', 'Back to the unadjusted picture in the colour its name gives it', () => { setChannelLevels(sec, i, () => ({})); setSingleLut(sec, i, null); });
    mk('Invert', 'Show this channel inverted: bright signal dark on a light background', () => setChannelLevels(sec, i, cur => ({ ...cur, invert: !cur.invert }))).dataset.levelAction = 'invert';
    panel.appendChild(actions);
    const note = document.createElement('div');
    note.className = 'chan-status';
    note.textContent = 'Display only: counts and measurements use the unadjusted channel.';
    panel.appendChild(note);
    mountColourMenu(button, panel);
    channelPanel = { panel, sec, i };
    refreshChannelPanel();
}
function colourButton(label, hex, title, run) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = 'tk-merge-swap';
    b.innerHTML = ToolkitCore.channels.mergeLegendHtml([{ label, color: hex }]);
    b.title = title;
    b.setAttribute('aria-label', title);
    b.onclick = () => run(b);
    return b;
}
/* show: the channel objects on screen; idx: their channel numbers; single:
   true when one channel is drawn on its own. */
function updateCompositeLegend(show, idx = [], single = false) {
    const el = $('compositeLegend');
    if (!el)
        return;
    const sec = S.image;
    el.innerHTML = '';
    if (!sec || !show || !show.length || (show.length < 2 && !single)) {
        el.classList.remove('on');
        return;
    }
    if (single) {
        const i = idx[0];
        el.appendChild(colourButton(channelLabelAt(sec, i), singleLutHex(sec, i),
            `${channelLabelAt(sec, i)} — colour, histogram and levels`, b => openSingleLutMenu(b, sec, i)));
        el.title = 'Click for this channel\u2019s colour, histogram and levels.';
    }
    else {
        const colours = mergeColoursFor(sec, idx, show), roles = mergeRolesFor(sec, idx);
        idx.forEach((i, pos) => {
            const label = channelLabelAt(sec, i);
            if (!roles) {
                const span = document.createElement('span');
                span.innerHTML = ToolkitCore.channels.mergeLegendHtml([{ label, color: colours[pos] }]);
                el.appendChild(span);
                return;
            }
            el.appendChild(colourButton(label, colours[pos], `${label} is ${ROLE_LABEL[roles[pos]]} — change it`,
                b => roles.length === 3 ? openTripleRoleMenu(b, sec, idx, pos) : swapMergeRoles(sec, idx)));
        });
        el.title = roles && roles.length === 3 ? 'Click a colour to give that channel one of the other two.'
            : roles ? 'Click either colour to swap magenta and green.' : '';
    }
    el.classList.add('on');
}
/* ---- Drawing the image, without the wait --------------------------------
   Switching channel or merge used to re-measure every shown channel's display
   range and recolour every pixel, each time: a tenth of a second for one
   channel, half a second for a three-channel merge. Now the ranges are measured
   once per channel, each drawn view is kept (up to VIEW_CACHE_BYTES), and the
   views a user is likely to want next are drawn while the app is idle, so a
   switch is normally just putting a finished picture on the canvas. The pixels
   are exactly what they were. */
const VIEW_CACHE_BYTES = 192 * 1024 * 1024;
const viewCache = { sec: null, map: new Map(), bytes: 0 };
const pixelIds = new WeakMap();
let pixelIdSeq = 0;
function pixelId(a) {
    let id = pixelIds.get(a);
    if (!id) {
        id = ++pixelIdSeq;
        pixelIds.set(a, id);
    }
    return id;
}
const rangeMemo = new WeakMap(), mergeRangeMemo = new WeakMap();
function cachedRange(a) {
    let r = rangeMemo.get(a);
    if (!r) {
        r = range(a);
        rangeMemo.set(a, r);
    }
    return r;
}
function cachedMergeRange(a) {
    let r = mergeRangeMemo.get(a);
    if (!r) {
        r = mergeNormalizeRange(a);
        mergeRangeMemo.set(a, r);
    }
    return r;
}
function clearViewCache() {
    viewCache.map.clear();
    viewCache.bytes = 0;
    viewCache.sec = null;
}
/* Views drawn from pixels the section no longer has -- other Z layers, the
   other display resolution -- can never be shown again. */
function pruneViewCache(sec) {
    if (viewCache.sec !== sec) {
        clearViewCache();
        viewCache.sec = sec;
        return;
    }
    const live = new Set(currentDisplayChannels(sec).filter(c => c && c.data).map(c => String(pixelId(c.data))));
    for (const [k, img] of viewCache.map) {
        const ids = k.split('|')[6].split(',').map(x => x.split(':')[0]);
        if (ids.some(id => !live.has(id))) {
            viewCache.map.delete(k);
            viewCache.bytes -= img.data.length;
        }
    }
}
function rememberView(sec, key, img) {
    pruneViewCache(sec);
    const old = viewCache.map.get(key);
    if (old)
        viewCache.bytes -= old.data.length;
    viewCache.map.set(key, img);
    viewCache.bytes += img.data.length;
    for (const [k, v] of viewCache.map) {
        if (viewCache.bytes <= VIEW_CACHE_BYTES || viewCache.map.size <= 1)
            break;
        viewCache.map.delete(k);
        viewCache.bytes -= v.data.length;
    }
}
function cachedView(sec, key) {
    if (viewCache.sec !== sec || !viewCache.map.has(key))
        return null;
    const img = viewCache.map.get(key);
    viewCache.map.delete(key);
    viewCache.map.set(key, img);
    return img;
}
/* Everything that decides what the base picture looks like, and a key that
   changes whenever any of it does. Null when there is nothing drawable. */
function baseViewSpec(mode, showIdx) {
    const sec = S.image;
    if (!sec)
        return null;
    const nativeCh = sec.channels || [], ch = currentDisplayChannels(sec), dv = +$('chDetect').value;
    const c = (dv >= 0 ? ch[dv] : null) || ch[0], native = nativeCh[0] || c;
    if (!c || !c.data || !(c.w > 0 && c.h > 0))
        return null;
    if (mode === 'color' && ch.length < 2)
        mode = 'image';
    showIdx = mode === 'color' ? ch.map((_, i) => i) : showIdx.filter(i => ch[i]);
    if (!showIdx.length)
        showIdx = [0];
    const show = showIdx.map(i => ch[i]);
    if (show.some(cc => !cc || !cc.data))
        return null;
    const merged = mode === 'color' || show.length > 1;
    const flip = !!show[0].inverted && ($('showAs') || { value: 'source' }).value !== 'signal';
    let colours = null, tint = null, rebuild = false;
    if (merged) {
        assignColours();
        colours = mergeColoursFor(sec, showIdx, show);
        rebuild = flip && show.every(cc => cc.fromMerge && cc.top);
    }
    else if (mode === 'image')
        tint = singleLutRgb(sec, showIdx[0]);
    const live = !merged && mode !== 'image' && (mode === 'z' || mode === 'mask');
    const ids = (merged || mode === 'image' ? show : [c]).map(cc => pixelId(cc.data) + (rebuild ? ':' + cc.top : ''));
    /* Each shown channel's levels (null while untouched); not for a merge
       rebuilt pixel for pixel from the file. */
    const luts = (merged && !rebuild) || mode === 'image' ? showIdx.map(i => channelLevelLut(sec, i)) : showIdx.map(() => null);
    const levelsKey = luts.some(Boolean) ? showIdx.map(i => JSON.stringify(channelLevels(sec, i))).join(';') : '';
    const key = live ? null : [merged ? 'm' : mode, flip ? 1 : 0, rebuild ? 1 : 0, c.w, c.h, showIdx.join(','),
        ids.join(','), colours ? colours.join(',') : '', tint ? tint.join(',') : '', levelsKey].join('|');
    return { sec, ch, c, native, mode, showIdx, show, merged, flip, colours, tint, rebuild, key, luts };
}
function renderBaseView(v) {
    const { c, show, merged, flip, mode } = v;
    const img = new ImageData(c.w, c.h);
    const d = img.data;
    if (merged) {
        const mergeColours = v.colours;
        if (v.rebuild) {
            /* Put the merge back together from its channels: no per-channel
               rescaling, so what you see is the file you loaded, pixel for pixel. */
            for (let p = 0; p < d.length; p += 4) {
                d[p] = 255;
                d[p + 1] = 255;
                d[p + 2] = 255;
                d[p + 3] = 255;
            }
            for (const [ci, cc] of show.entries()) {
                const col = mergeColours[ci] || '#ffffff', src = cc.data, top = cc.top || 255;
                const comp = [parseInt(col.slice(1, 3), 16), parseInt(col.slice(3, 5), 16),
                    parseInt(col.slice(5, 7), 16)].map(v => v > 127);
                for (let i = 0, p = 0; i < src.length; i++, p += 4) {
                    const v = clamp(255 * (top - src[i]) / top, 0, 255);
                    for (let k = 0; k < 3; k++)
                        if (comp[k] && v < d[p + k])
                            d[p + k] = v;
                }
            }
            return img;
        }
        /* Before a merge is drawn, every channel gets its own automatic display
           normalization (0.1–99.8% of nonzero pixels). Two channels remain magenta
           + green; three remain red + green + blue. The normalization changes only
           the display composite, never the data used for soma detection/counting. */
        const base = flip ? 255 : 0;
        for (let p = 0; p < d.length; p += 4) {
            d[p] = base;
            d[p + 1] = base;
            d[p + 2] = base;
            d[p + 3] = 255;
        }
        show.forEach((cc, ci) => {
            const { lo, hi } = cachedMergeRange(cc.data), span = (hi - lo) || 1;
            const col = mergeColours[ci] || '#ffffff';
            const cr = parseInt(col.slice(1, 3), 16) / 255, cg = parseInt(col.slice(3, 5), 16) / 255, cb = parseInt(col.slice(5, 7), 16) / 255;
            const src = cc.data, lut = v.luts && v.luts[ci];
            for (let i = 0, p = 0; i < src.length; i++, p += 4) {
                const v = lut ? lut[clamp(Math.round((src[i] - lo) / span * 255), 0, 255)] : clamp((src[i] - lo) / span, 0, 1) * 255;
                if (flip) {
                    const r = d[p] - v * (1 - cr), gg = d[p + 1] - v * (1 - cg), bb = d[p + 2] - v * (1 - cb);
                    d[p] = r < 0 ? 0 : r;
                    d[p + 1] = gg < 0 ? 0 : gg;
                    d[p + 2] = bb < 0 ? 0 : bb;
                }
                else {
                    const r = d[p] + v * cr, gg = d[p + 1] + v * cg, bb = d[p + 2] + v * cb;
                    d[p] = r > 255 ? 255 : r;
                    d[p + 1] = gg > 255 ? 255 : gg;
                    d[p + 2] = bb > 255 ? 255 : bb;
                }
            }
        });
        return img;
    }
    if (mode === 'image') {
        const src = show[0].data;
        const { lo, hi } = cachedRange(src);
        /* Grays, or the colour picked for this channel. On a light background
           the colour is subtracted from white, as the merges do, so strong
           signal still reads in that colour. */
        const tint = v.tint, lut = v.luts && v.luts[0];
        for (let i = 0, p = 0; i < src.length; i++, p += 4) {
            const v = lut ? lut[clamp(Math.round((src[i] - lo) / (hi - lo || 1) * 255), 0, 255)] : clamp((src[i] - lo) / (hi - lo || 1) * 255, 0, 255);
            if (!tint) {
                const g2 = flip ? 255 - v : v;
                d[p] = g2;
                d[p + 1] = g2;
                d[p + 2] = g2;
            }
            else if (flip) {
                d[p] = 255 - v * (1 - tint[0]);
                d[p + 1] = 255 - v * (1 - tint[1]);
                d[p + 2] = 255 - v * (1 - tint[2]);
            }
            else {
                d[p] = v * tint[0];
                d[p + 1] = v * tint[1];
                d[p + 2] = v * tint[2];
            }
            d[p + 3] = 255;
        }
        return img;
    }
    if (mode === 'z' && S.z) {
        for (let i = 0, p = 0; i < S.z.length; i++, p += 4) {
            const v = clamp(S.z[i] / 12 * 255, 0, 255);
            d[p] = v * 0.2;
            d[p + 1] = v;
            d[p + 2] = v * 0.75;
            d[p + 3] = 255;
        }
    }
    else if (mode === 'mask' && S.soma) {
        const src = c.data;
        const { lo, hi } = cachedRange(src);
        for (let i = 0, p = 0; i < src.length; i++, p += 4) {
            const v = clamp((src[i] - lo) / (hi - lo || 1) * 255, 0, 255) * 0.45;
            if (S.soma[i] === 1) {
                d[p] = v * 0.4 + 40;
                d[p + 1] = v * 0.4 + 190;
                d[p + 2] = v * 0.4 + 150;
            }
            else if (S.soma[i] === 2) {
                d[p] = v * 0.7 + 34;
                d[p + 1] = v * 0.5;
                d[p + 2] = v * 0.5 + 14;
            }
            else {
                d[p] = v;
                d[p + 1] = v;
                d[p + 2] = v;
            }
            d[p + 3] = 255;
        }
    }
    else {
        const src = c.data;
        const { lo, hi } = cachedRange(src);
        for (let i = 0, p = 0; i < src.length; i++, p += 4) {
            const v = clamp((src[i] - lo) / (hi - lo || 1) * 255, 0, 255);
            d[p] = v;
            d[p + 1] = v;
            d[p + 2] = v;
            d[p + 3] = 255;
        }
    }
    return img;
}
function drawBase() {
    if (!S.image)
        return;
    /* Colour shows every channel; otherwise the picture follows the detection
       selection, so choosing a channel or editing the composite visibly changes
       what you are looking at. */
    const v = baseViewSpec($('viewMode').value, parseDetect().idx);
    if (!v) {
        setStatus('That image has no usable display pixels.');
        return;
    }
    const { c, native } = v;
    updateCompositeLegend(v.show, v.showIdx, !v.merged && v.mode === 'image');
    /* Polarity is a display choice, not an analysis one.  Detection always runs
       on recovered signal; the picture can still be drawn the way the file looks,
       so an inverted section reads as dark somata on light.                    */
    S.lightBg = v.flip;
    let img = v.key ? cachedView(v.sec, v.key) : null;
    if (!img) {
        img = renderBaseView(v);
        if (v.key)
            rememberView(v.sec, v.key, img);
    }
    const cv = $('base');
    if (cv.width !== c.w)
        cv.width = c.w;
    if (cv.height !== c.h)
        cv.height = c.h;
    cv.style.width = native.w + 'px';
    cv.style.height = native.h + 'px';
    cv.getContext('2d').putImageData(img, 0, 0);
    S.displayScaleX = c.w / native.w;
    S.displayScaleY = c.h / native.h;
    /* Keep a reference to the exact displayed RGB buffer. drawOverlay() samples
       this (not the raw microscopy data) so marker contrast follows whatever the
       user is actually looking at, including normalized multichannel merges. */
    S.displayRGBA = img.data;
    S.displayW = c.w;
    S.displayH = c.h;
    const ov = $('ov');
    if (ov.width !== c.w)
        ov.width = c.w;
    if (ov.height !== c.h)
        ov.height = c.h;
    ov.style.width = native.w + 'px';
    ov.style.height = native.h + 'px';
    scheduleViewPrewarm();
    sbsAfterBase();
}
/* While the app is idle, draw the views a user is likely to switch to next:
   each channel alone, then the merges, nearest first, until the cache is full. */
let prewarmHandle = 0;
function scheduleViewPrewarm() {
    if (prewarmHandle)
        return;
    const idle = window.requestIdleCallback || (fn => setTimeout(() => fn({ timeRemaining: () => 50, didTimeout: false }), 120));
    prewarmHandle = idle(prewarmNextView, { timeout: 1500 });
}
function prewarmCandidates(n) {
    const out = [];
    for (let i = 0; i < n; i++)
        out.push([i]);
    for (let a = 0; a < n; a++)
        for (let b = a + 1; b < n; b++)
            out.push([a, b]);
    if (n === 3)
        out.push([0, 1, 2]);
    return out;
}
function prewarmNextView() {
    prewarmHandle = 0;
    const sec = S.image;
    if (!sec || S.busy || !sec.channels || sec.channels.length > 6)
        return;
    if ($('viewMode').value !== 'image' && $('viewMode').value !== 'color')
        return;
    /* A channel's density is measured the first time it is picked; do it now. */
    const unmeasured = sec.channels.find(c => c && c.data && c._dens == null);
    if (unmeasured) {
        channelDensity(unmeasured);
        scheduleViewPrewarm();
        return;
    }
    for (const idx of prewarmCandidates(sec.channels.length)) {
        const v = baseViewSpec('image', idx);
        if (!v || !v.key || (viewCache.sec === sec && viewCache.map.has(v.key)))
            continue;
        pruneViewCache(sec);
        if (viewCache.bytes + v.c.w * v.c.h * 4 > VIEW_CACHE_BYTES)
            return;
        /* Insert behind the views already in use, so prewarming never pushes
           out the one on screen. */
        const img = renderBaseView(v);
        const kept = [...viewCache.map];
        viewCache.map.clear();
        viewCache.map.set(v.key, img);
        for (const [k, im] of kept)
            viewCache.map.set(k, im);
        viewCache.bytes += img.data.length;
        scheduleViewPrewarm();
        return;
    }
}
/* Merge-only channel normalization. Each channel is stretched independently
   before colorization so a dim fluorophore is not visually buried by a brighter
   one. Exact-zero pixels are ignored; 0.1th percentile -> black and 99.8th -> white.
   This affects DISPLAY ONLY. Soma detection and intensity measurements still use
   the original channel data. */
function mergeNormalizeRange(a) {
    const step = Math.max(1, Math.floor(a.length / 300000));
    const hist = new Map();
    let total = 0, min = Infinity, max = -Infinity;
    for (let i = 0; i < a.length; i += step) {
        const v = a[i];
        if (!(v > 0) || !isFinite(v))
            continue;
        hist.set(v, (hist.get(v) || 0) + 1);
        total++;
        if (v < min)
            min = v;
        if (v > max)
            max = v;
    }
    if (total < 2 || !(max > min))
        return range(a);
    const vals = [...hist.keys()].sort((x, y) => x - y);
    const q = f => { const rank = Math.floor(Math.max(0, Math.min(1, f)) * Math.max(0, total - 1)); let acc = 0; for (const v of vals) {
        acc += hist.get(v);
        if (acc > rank)
            return v;
    } return vals[vals.length - 1]; };
    let lo = q(.001), hi = q(.998);
    if (!(hi > lo)) {
        lo = min;
        hi = max;
    }
    return hi > lo ? { lo, hi } : range(a);
}
/* Display range.  Empty slide is not black in the file — it carries camera
   offset and stray light — so a black point at the very bottom of the range
   leaves it a visible grey.  Put the black point just above the slide level
   instead: bare glass goes to true black, while unstained tissue, which sits
   above the slide, stays dark but visible.  If the frame is filled with
   tissue there is no slide level to find, so the old behaviour is kept.   */
function range(a) {
    const step = Math.max(1, Math.floor(a.length / 100000));
    const s = [];
    for (let i = 0; i < a.length; i += step)
        s.push(a[i]);
    s.sort((x, y) => x - y);
    const q = f => s[Math.floor(f * (s.length - 1))];
    const hi = q(0.999), slide = q(0.05);
    const cut = slide + 0.05 * (hi - slide);
    let below = 0;
    for (let i = 0; i < s.length; i++) {
        if (s[i] < cut)
            below++;
        else
            break;
    }
    const hasSlide = below / s.length > 0.08;
    return { lo: hasSlide ? cut : q(0.002), hi: hi };
}
function countMarkerScale() {
    const el = $('ringSize');
    return clamp((el ? +el.value : 100) / 100, 0.05, 1.60);
}
/* Count markers are display-only. 100% is deliberately identical to the
   original Soma Quantification marker: the cell's original radius and a 2 px
   coloured outline. When the user shrinks a marker, its radius is expressed as
   a percentage of that same original radius and the outline progressively
   thickens. At the minimum setting the stroke reaches the centre, so the marker
   becomes a dot instead of vanishing. A very small screen-space minimum radius prevents a marker from mathematically
   disappearing while still allowing the requested percentage to become genuinely tiny. */
function countMarkerGeometry(baseR) {
    const sc = countMarkerScale();
    const originalLine = Math.max(1, 2 / S.zoom);
    const originalOuter = baseR + originalLine * 0.5;
    const originalInner = Math.max(0, baseR - originalLine * 0.5);
    const minOuter = Math.min(originalOuter, 1.25 / S.zoom);
    const outer = sc === 1 ? originalOuter : Math.max(minOuter, originalOuter * sc);
    let inner;
    if (sc >= 1)
        inner = Math.max(0, outer - originalLine);
    else {
        const legacyHoleRatio = originalOuter > 0 ? originalInner / originalOuter : 0;
        const hollow = clamp((sc - 0.25) / 0.75, 0, 1);
        const holeRatio = legacyHoleRatio * Math.pow(hollow, 1.15);
        inner = outer * holeRatio;
    }
    const filled = sc <= 0.25 || inner <= 0.30 / S.zoom;
    return { sc, outer, inner, filled, lineWidth: Math.max(0.15 / S.zoom, outer - inner), pathR: (outer + inner) * 0.5 };
}
function drawCountMarker(g, c, col, baseR) {
    const geom = countMarkerGeometry(baseR);
    /* Exactly one visual treatment per status class. No background-dependent
       colours, no companion edge colour, and no merge-only centre dot. */
    g.save();
    if (geom.filled) {
        g.beginPath();
        g.arc(c.x, c.y, geom.outer, 0, 6.2832);
        g.fillStyle = col;
        g.fill();
    }
    else {
        g.beginPath();
        g.arc(c.x, c.y, geom.pathR, 0, 6.2832);
        g.strokeStyle = col;
        g.lineWidth = geom.lineWidth;
        g.stroke();
    }
    g.restore();
}
function markerBackgroundLumaFixed(c, baseR) {
    /* Sample a fixed, original-size neighbourhood so changing Ring size never
       changes the shade decision. */
    const rgba = S.displayRGBA, w = S.displayW | 0, h = S.displayH | 0;
    if (!rgba || !(w > 0 && h > 0))
        return null;
    let sum = 0, n = 0;
    const add = (x, y) => {
        const ix = Math.round(x * (S.displayScaleX || 1)), iy = Math.round(y * (S.displayScaleY || 1));
        if (ix < 0 || iy < 0 || ix >= w || iy >= h)
            return;
        const q = (iy * w + ix) * 4;
        sum += 0.2126 * rgba[q] + 0.7152 * rgba[q + 1] + 0.0722 * rgba[q + 2];
        n++;
    };
    add(c.x, c.y);
    const rr = Math.max(2, baseR);
    for (let k = 0; k < 16; k++) {
        const a = k * Math.PI / 8;
        add(c.x + Math.cos(a) * rr, c.y + Math.sin(a) * rr);
    }
    return n ? sum / n : null;
}
function markerStateForCell(c, autoFloor, autoWhiteFloor) {
    const isManual = (c.source === 'manual') || ((S.allCells || []).indexOf(c) < 0);
    if (isManual)
        return 'manual';
    /* Marker colour follows the automatic floor's actual acceptance rule, not a
       raw contrast comparison.  This matters for calibrated Donut-review rescues:
       those cells are intentionally accepted by the automatic analysis even when
       their raw centre-based contrast is below the numeric floor, so they remain
       green rather than appearing as misleading yellow dots in the default view.
       Yellow is reserved for detections that the automatic floor really excluded
       and that become visible only after the user lowers a floor manually. */
    const belowBrightnessAuto = floorEnabled() && autoFloor != null && !passesBrightnessAt(c, autoFloor);
    const ws = cellWhiteScore(c);
    const belowColocAuto = !!parseDetect().merge && autoWhiteFloor != null && ws != null && ws < autoWhiteFloor;
    return (belowBrightnessAuto || belowColocAuto) ? 'below' : 'auto';
}
function chooseGlobalMarkerShades(autoFloor, autoWhiteFloor, pal) {
    /* One shade per semantic group. We aggregate the fixed local backgrounds of
       every visible cell in that group, then choose whichever of the two nearby
       shades contrasts better with that group's median background. */
    const bg = { auto: [], below: [], manual: [] };
    for (const c of S.cells) {
        const state = markerStateForCell(c, autoFloor, autoWhiteFloor);
        const r = Math.max(3, (c.donutRescue && isFinite(c.displayR)) ? c.displayR : Math.sqrt(c.area / Math.PI));
        const v = markerBackgroundLumaFixed(c, r);
        if (v != null && isFinite(v))
            bg[state].push(v);
    }
    const lum = hex => {
        const r = parseInt(hex.slice(1, 3), 16), g = parseInt(hex.slice(3, 5), 16), b = parseInt(hex.slice(5, 7), 16);
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const out = {};
    for (const state of ['auto', 'below', 'manual']) {
        const pair = pal[state];
        const a = bg[state].sort((x, y) => x - y);
        const median = a.length ? a[Math.floor(a.length / 2)] : 128;
        out[state] = Math.abs(lum(pair.dark) - median) > Math.abs(lum(pair.light) - median) ? pair.dark : pair.light;
    }
    return out;
}
/* Region outlines and the loop being drawn, in image pixels on a context
   showing zoom screen pixels per image pixel (the main view and each side by
   side panel). */
/* Regions hidden with the Regions button are not drawn, but a loop being
   drawn always is. */
function drawRegionsAndLoop(g, zoom, light) {
    for (let i = 0; S.showRegions && i < S.regions.length; i++) {
        const r = S.regions[i], holes = regionHoles(r).filter(h => h && h.length > 2);
        /* A hole is outlined like the region and left unfilled. */
        g.save();
        if (holes.length) {
            g.beginPath();
            g.rect(-1e7, -1e7, 2e7, 2e7);
            for (const h of holes) {
                g.moveTo(h[0].x, h[0].y);
                for (const p of h.slice(1))
                    g.lineTo(p.x, p.y);
                g.closePath();
            }
            g.clip('evenodd');
        }
        for (const poly of regionPolys(r)) {
            if (poly.length < 2)
                continue;
            g.beginPath();
            g.moveTo(poly[0].x, poly[0].y);
            for (const p of poly.slice(1))
                g.lineTo(p.x, p.y);
            g.closePath();
            g.fillStyle = r.color + '12';
            g.fill();
        }
        g.restore();
        for (const poly of regionPolys(r).concat(holes)) {
            if (poly.length < 2)
                continue;
            g.beginPath();
            g.moveTo(poly[0].x, poly[0].y);
            for (const p of poly.slice(1))
                g.lineTo(p.x, p.y);
            g.closePath();
            g.strokeStyle = r.color;
            g.lineWidth = 2.5 / zoom;
            g.setLineDash([8 / zoom, 6 / zoom]);
            g.stroke();
            g.setLineDash([]);
        }
    }
    if (S.poly.length) {
        g.beginPath();
        g.moveTo(S.poly[0].x, S.poly[0].y);
        for (const p of S.poly.slice(1))
            g.lineTo(p.x, p.y);
        /* The remove lasso and Trim region take away, so their loop is red and dashed. */
        const cutting = S.tool === 'delLasso' || S.tool === 'trim';
        if (S.lassoing) {
            g.closePath();
            g.fillStyle = cutting ? 'rgba(242,119,138,.22)' : (S.regions[S.activeRegion] || { color: '#5ad3b0' }).color + '18';
            g.fill();
        }
        g.strokeStyle = cutting ? (light ? '#c01230' : '#f2778a') : light ? '#111' : '#fff';
        g.lineWidth = 2 / zoom;
        if (cutting)
            g.setLineDash([6 / zoom, 4 / zoom]);
        g.stroke();
        g.setLineDash([]);
    }
}
function drawOverlay() {
    if (!S.image)
        return;
    sbsAfterOverlay();
    const cv = $('ov'), g = cv.getContext('2d');
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, cv.width, cv.height);
    g.setTransform(S.displayScaleX || 1, 0, 0, S.displayScaleY || 1, 0, 0);
    drawRegionsAndLoop(g, S.zoom, S.lightBg);
    if (S.tool === 'del' && S.eraseCursor) {
        const rad = Math.max(6, +$('dMin').value * 0.8);
        g.beginPath();
        g.arc(S.eraseCursor.x, S.eraseCursor.y, rad, 0, 6.2832);
        g.strokeStyle = S.lightBg ? '#c01230' : '#f2778a';
        g.lineWidth = Math.max(1, 1.5 / S.zoom);
        g.setLineDash([5 / S.zoom, 4 / S.zoom]);
        g.stroke();
        g.setLineDash([]);
    }
    if ($('markerKeys'))
        $('markerKeys').hidden = !S.showOv;
    if (!S.showOv)
        return;
    /* Exactly three semantic marker states. Every cell in a state uses the same
       shade. The palette stays close to the original Soma Quantification colours;
       only a modest darker variant is available when the whole group sits on a
       bright background. Shade selection uses original-size sampling, so moving
       the Ring size slider cannot make colours fluctuate. */
    const PAL = {
        auto: { light: '#5ad3b0', dark: '#319f84' },
        below: { light: '#ffd84d', dark: '#c79b21' },
        manual: { light: '#6fa8f5', dark: '#477fc8' }
    };
    const autoFloor = (S.autoFloorRef != null && isFinite(S.autoFloorRef)) ? S.autoFloorRef : autoFloorSliderValue();
    const autoWhiteFloor = (S.autoColocFloorRef != null && isFinite(S.autoColocFloorRef)) ? S.autoColocFloorRef : autoColocFloorSliderValue();
    const STATE_COL = chooseGlobalMarkerShades(autoFloor, autoWhiteFloor, PAL), seen = {};
    for (const c of S.cells) {
        const state = markerStateForCell(c, autoFloor, autoWhiteFloor);
        const r = Math.max(3, (c.donutRescue && isFinite(c.displayR)) ? c.displayR : Math.sqrt(c.area / Math.PI));
        drawCountMarker(g, c, STATE_COL[state], r);
        seen[state] = true;
    }
    updateMarkerKeys(STATE_COL, seen);
    if (S.marked && S.marked.size) {
        g.strokeStyle = S.lightBg ? '#c01230' : '#f2778a';
        g.lineWidth = Math.max(1, 2.5 / S.zoom);
        for (const c of S.marked) {
            const r = Math.max(3, Math.sqrt(c.area / Math.PI)) * 1.7;
            g.beginPath();
            g.moveTo(c.x - r, c.y - r);
            g.lineTo(c.x + r, c.y + r);
            g.moveTo(c.x + r, c.y - r);
            g.lineTo(c.x - r, c.y + r);
            g.stroke();
        }
    }
}
/* The dot legend in the bottom bar, in the shades on screen. Yellow is listed
   only while some dot is yellow, which takes a floor lowered by hand below its
   automatic place; with the floors untouched there are two colours. */
function updateMarkerKeys(col, seen) {
    const box = $('markerKeys');
    if (!box)
        return;
    const rows = [['auto', 'detected'], ['below', 'below the automatic floor'], ['manual', 'added by hand']].filter(([k]) => k !== 'below' || seen.below);
    const sig = rows.map(([k]) => k + col[k]).join();
    if (box.dataset.sig === sig)
        return;
    box.dataset.sig = sig;
    box.innerHTML = rows.map(([k, t]) => `<span><i style="background:${col[k]}"></i>${t}</span>`).join('');
}
/* The brightness floor is a view on the result, not a reason to recompute one.
   Every candidate is kept; the slider chooses which of them count.          */
/* Which analyses the brightness floor applies to.  Default: Donut mode only,
   where rescue candidates include many dim false positives without it. */
function currentViewMode() {
    if (!S.image)
        return 'normal';
    const sel = parseDetect();
    return sel.merge ? 'merge' : channelMode(sel.idx[0]);
}
function floorEnabled() {
    const v = ($('floorMode') || {}).value || 'donut';
    return v === 'all' || (v === 'donut' && currentViewMode() === 'donut');
}
function contrastFloor() { if (!floorEnabled())
    return 0; return +($('minContrast') || { value: 0 }).value || 0; }
function passesBrightnessAt(c, f) {
    /* High-confidence calibrated Donut-review rescues are part of the accepted
       automatic population. Keep that detector decision intact at every floor. */
    if (c && c.reviewDonut && isFinite(c.reviewScore) && c.reviewScore >= 0.45)
        return true;
    /* Cells kept by the hand-count classifier were already judged on brightness
       relative to the image; its threshold replaces the automatic floor. */
    if (c && isFinite(c.modelScore))
        return true;
    return !(f > 0 && isFinite(c.contrast) && c.contrast < f);
}
/* A Normal-mode view is counted by the hand-count classifier, which has already
   judged how bright a soma must be; the automatic floor never second-guesses it
   (it is placed at the bottom there). A floor set by hand does apply: dimmer
   cells than it are dropped, as in every other mode. */
/* What counted this view, in words: the cell-centre network or the hand-count forest. */
function classifierLabel() {
    const id = (S.lastRun && S.lastRun.classifier && S.lastRun.classifier.id) || ($('cellModel') || {}).value || '';
    return /^somaNet/.test(id) ? 'cell-centre network' : 'hand-count classifier';
}
function classifierView() {
    return (S.allCells || []).some(c => c && isFinite(c.modelScore));
}
function floorSetByHand() {
    return !!S.floorTouched && !S.floorAuto;
}
function passesFloor(c) {
    /* The brightness floor and colocalization floor are independent gates.
       Merge candidates must pass BOTH. Ordinary detections excluded by the
       automatic floor can reappear only after the user lowers that floor; those
       newly revealed detections are drawn yellow. */
    const f = contrastFloor();
    if (c && isFinite(c.modelScore))
        return !floorSetByHand() || !(f > 0 && isFinite(c.contrast) && c.contrast < f);
    return passesBrightnessAt(c, f);
}
/* Where to put the floor without being asked.  The brightness of everything
   the detector found is bimodal — a faint population it should drop and a
   bright one it should keep — so Otsu's split lands between them.  Tested
   against hand counts on twenty sections it reaches F1 0.813 where the best
   possible per-image floor reaches 0.829, and no floor at all reaches 0.658. */
function autoFloorValue() {
    /* Donut rescue candidates are judged against the same automatic brightness
       floor as the ordinary population; they must not redefine that floor.  For
       reconstructed donuts use the pre-rim value only to PLACE the automatic
       split, while passesFloor() still uses the biologically relevant rim-aware
       contrast. */
    const v = (S.allCells || []).filter(c => !c.donutRescue && !c.axonHeavy)
        .map(c => isFinite(c.baseContrast) ? c.baseContrast : c.contrast).filter(isFinite);
    if (v.length < 20)
        return null;
    let lo = Infinity, hi = -Infinity;
    for (const x of v) {
        if (x < lo)
            lo = x;
        if (x > hi)
            hi = x;
    }
    if (!(hi > lo))
        return null;
    const B = 128, h = new Float64Array(B);
    for (const x of v) {
        let k = Math.floor((x - lo) / (hi - lo) * B);
        if (k < 0)
            k = 0;
        if (k >= B)
            k = B - 1;
        h[k]++;
    }
    const tot = v.length;
    let sum = 0;
    for (let i = 0; i < B; i++)
        sum += i * h[i];
    let wB = 0, sB = 0, best = -1, thr = 0;
    for (let i = 0; i < B; i++) {
        wB += h[i];
        if (!wB)
            continue;
        const wF = tot - wB;
        if (!wF)
            break;
        sB += i * h[i];
        const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) {
            best = between;
            thr = i;
        }
    }
    return lo + (thr + 1) / B * (hi - lo);
}
function autoFloorSliderValue() {
    const el = $('minContrast'), f = autoFloorValue();
    if (f == null || !el)
        return null;
    return Math.max(+el.min, Math.min(+el.max, Math.round(f)));
}
function placeFloorAutomatically() {
    const el = $('minContrast');
    if (el && classifierView()) {
        el.value = el.min;
        S.floorAuto = true;
        S.autoFloorRef = +el.min;
        return true;
    }
    const f = autoFloorSliderValue();
    if (f == null)
        return false;
    el.value = String(f);
    S.floorAuto = true;
    S.autoFloorRef = f;
    return true;
}
function fitContrastSlider(preferredValue = null) {
    const el = $('minContrast');
    const v = (S.allCells || []).map(c => c.contrast).filter(isFinite).sort((a, b) => a - b);
    if (!v.length) {
        el.min = 0;
        el.max = 1000;
        el.step = 1;
        if (preferredValue != null && isFinite(+preferredValue))
            el.value = String(clamp(+preferredValue, +el.min, +el.max));
        drawContrastHist();
        return;
    }
    /* Span the population, not the whole intensity range, so the travel is all
       useful.  At the far left nothing is dropped, which is the same as off.  */
    const lo = v[0], top = v[Math.floor(0.995 * (v.length - 1))];
    el.min = Math.max(0, Math.floor(lo * 0.92));
    el.max = Math.max(+el.min + 10, Math.round(top * 1.02));
    el.step = Math.max(1, Math.round((+el.max - +el.min) / 300));
    if (preferredValue != null && isFinite(+preferredValue))
        el.value = String(clamp(+preferredValue, +el.min, +el.max));
    else if (+el.value < +el.min || +el.value > +el.max)
        el.value = el.min;
    drawContrastHist();
}
/* Density of detections along the brightness axis, drawn like a traffic band:
   thin blue where detections are sparse, warm and tall where the cell
   population sits.  Everything left of the handle is dimmed — those are the
   ones currently being dropped.                                            */
function drawContrastHist() {
    const on = floorEnabled();
    if ($('minContrast')) {
        $('minContrast').disabled = !on;
        $('minContrast').closest('.histwrap')?.classList.toggle('off', !on);
    }
    renderContrastNote();
    const cv = $('contrastHist');
    if (!cv)
        return;
    const w = cv.clientWidth || 300, h = 52;
    if (cv.width !== w)
        cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    const vals = (S.allCells || []).map(c => c.contrast).filter(isFinite);
    const lo = +$('minContrast').min || 0, max = +$('minContrast').max || 1000;
    const span = Math.max(max - lo, 1e-6);
    if (!vals.length) {
        return;
    }
    const B = Math.max(24, Math.min(140, Math.floor(w / 3)));
    const bins = new Float64Array(B);
    for (const v of vals) {
        let k = Math.floor((v - lo) / span * B);
        if (k < 0)
            k = 0;
        if (k >= B)
            k = B - 1;
        bins[k]++;
    }
    let peak = 0;
    for (const b of bins)
        if (b > peak)
            peak = b;
    if (!peak)
        return;
    const floor = contrastFloor();
    const bw = w / B;
    for (let k = 0; k < B; k++) {
        const f = bins[k] / peak;
        const bh = Math.max(f > 0 ? 2 : 0, Math.round(f * (h - 6)));
        const x0 = k * bw, mid = lo + (k + 0.5) / B * span;
        const dropped = floor > 0 && mid < floor;
        /* blue -> green -> amber -> red as detections pile up */
        const hue = 210 - 150 * Math.min(1, Math.pow(f, 0.6));
        g.fillStyle = dropped ? `hsla(${hue},35%,32%,0.55)` : `hsl(${hue},72%,52%)`;
        g.fillRect(x0, h - bh - 2, Math.max(1, bw - 0.5), bh);
    }
    if (floor > 0) {
        const x = (floor - lo) / span * w;
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(0, 0, x, h);
        g.strokeStyle = '#fff';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
    }
}
function colocFloor() {
    const el = $('colocFloor');
    return el ? clamp((+el.value || 0) / 100, 0, 1) : 0;
}
function cellWhiteScore(c) {
    if (!c || !c.jhist || !c.npx || !(c.nC > 1))
        return null;
    const idx = (S.colocIdx && S.colocIdx.length) ? S.colocIdx : [1];
    let worst = 1, tested = 0;
    for (const k of idx) {
        if (!(k > 0 && k < c.nC))
            continue;
        let sum = 0, n = 0;
        const off = k * JHB;
        for (let b = 0; b < JHB; b++) {
            const ct = c.jhist[off + b] || 0;
            if (!ct)
                continue;
            const center = JHLO + (b + 0.5) / JHB * (JHHI - JHLO);
            sum += center * ct;
            n += ct;
        }
        if (n) {
            worst = Math.min(worst, sum / n);
            tested++;
        }
    }
    return tested ? clamp(worst, 0, 1) : null;
}
function passesColocFloor(c) {
    if (!parseDetect().merge || !c || c.source === 'manual')
        return true;
    const f = colocFloor();
    if (!(f > 0))
        return true;
    const v = cellWhiteScore(c);
    return v == null ? true : v >= f;
}
function autoColocFloorValue() {
    if (!parseDetect().merge)
        return null;
    const vals = (S.allCells || []).map(cellWhiteScore).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
    if (vals.length < 4)
        return null;
    let lo = vals[0], hi = vals[vals.length - 1];
    if (!(hi > lo + 1e-6))
        return Math.max(0, Math.min(1, lo * 0.8));
    const B = 96, h = new Float64Array(B);
    for (const x of vals) {
        let k = Math.floor((x - lo) / (hi - lo) * B);
        if (k < 0)
            k = 0;
        if (k >= B)
            k = B - 1;
        h[k]++;
    }
    let sum = 0;
    for (let i = 0; i < B; i++)
        sum += i * h[i];
    let wB = 0, sB = 0, best = -1, thr = 0;
    for (let i = 0; i < B; i++) {
        wB += h[i];
        if (!wB)
            continue;
        const wF = vals.length - wB;
        if (!wF)
            break;
        sB += i * h[i];
        const mB = sB / wB, mF = (sum - sB) / wF, between = wB * wF * (mB - mF) * (mB - mF);
        if (between > best) {
            best = between;
            thr = i;
        }
    }
    return clamp(lo + (thr + 1) / B * (hi - lo), 0, 1);
}
function fitColocFloorSlider(preferredValue = null) {
    const el = $('colocFloor');
    if (!el)
        return;
    el.min = 0;
    el.max = 100;
    el.step = 1;
    if (preferredValue != null && isFinite(+preferredValue))
        el.value = String(clamp(+preferredValue, 0, 100));
}
/* Distribution of cell-level whiteness scores.  This mirrors the brightness
   floor histogram: dense parts of the population rise higher, and scores below
   the active threshold are shaded out.  The x-axis is 0-100% whiteness. */
function drawColocHist() {
    const cv = $('colocHist');
    if (!cv)
        return;
    const w = cv.clientWidth || 300, h = 52;
    if (cv.width !== w)
        cv.width = w;
    cv.height = h;
    const g = cv.getContext('2d');
    g.clearRect(0, 0, w, h);
    if (!S.image || !parseDetect().merge)
        return;
    const vals = (S.allCells || []).map(cellWhiteScore).filter(v => v != null && isFinite(v));
    if (!vals.length)
        return;
    const B = Math.max(24, Math.min(100, Math.floor(w / 3)));
    const bins = new Float64Array(B);
    for (const v of vals) {
        let k = Math.floor(clamp(v, 0, 0.999999) * B);
        if (k < 0)
            k = 0;
        if (k >= B)
            k = B - 1;
        bins[k]++;
    }
    let peak = 0;
    for (const b of bins)
        if (b > peak)
            peak = b;
    if (!peak)
        return;
    const floor = colocFloor(), bw = w / B;
    for (let k = 0; k < B; k++) {
        const f = bins[k] / peak;
        const bh = Math.max(f > 0 ? 2 : 0, Math.round(f * (h - 6)));
        const x0 = k * bw, mid = (k + 0.5) / B;
        const dropped = floor > 0 && mid < floor;
        const hue = 210 - 150 * Math.min(1, Math.pow(f, 0.6));
        g.fillStyle = dropped ? `hsla(${hue},35%,32%,0.55)` : `hsl(${hue},72%,52%)`;
        g.fillRect(x0, h - bh - 2, Math.max(1, bw - 0.5), bh);
    }
    if (floor > 0) {
        const x = clamp(floor, 0, 1) * w;
        g.fillStyle = 'rgba(0,0,0,0.45)';
        g.fillRect(0, 0, x, h);
        g.strokeStyle = '#fff';
        g.lineWidth = 1;
        g.beginPath();
        g.moveTo(x, 0);
        g.lineTo(x, h);
        g.stroke();
    }
}
function autoColocFloorSliderValue() {
    const f = autoColocFloorValue(), el = $('colocFloor');
    if (f == null || !el)
        return null;
    return clamp(Math.round(f * 100) / 100, 0, 1);
}
function placeColocFloorAutomatically() {
    const f = autoColocFloorSliderValue(), el = $('colocFloor');
    if (f == null || !el)
        return false;
    el.value = String(Math.round(f * 100));
    S.colocFloorAuto = true;
    S.autoColocFloorRef = f;
    return true;
}
function syncColocFloorVisibility() {
    const wrap = $('colocFloorWrap');
    if (!wrap)
        return;
    const on = !!(S.image && parseDetect().merge);
    wrap.hidden = !on;
    if (!on) {
        $('colocFloorNote').textContent = '';
        drawColocHist();
        return;
    }
    const vals = (S.allCells || []).map(cellWhiteScore).filter(v => v != null && isFinite(v));
    const dropped = (S.allCells || []).filter(c => !passesColocFloor(c)).length;
    $('colocFloorNote').textContent = vals.length
        ? `${(S.cells || []).length} counted · ${dropped} below the colocalization floor${S.colocFloorAuto ? ' · placed automatically' : ''}`
        : 'Analyse this composite to calculate cell whiteness scores.';
    drawColocHist();
}
function applyContrastFloor() {
    if (!S.allCells)
        return;
    const manual = S.cells.filter(c => c.source === 'manual');
    const removed = S.removedAutoIds || new Set();
    S.cells = S.allCells.filter(c => passesFloor(c) && passesColocFloor(c) && !removed.has(c.id)).concat(manual);
    assignRegions();
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    updateColoc();
    drawContrastHist();
    syncColocFloorVisibility();
    /* Keep the current mode snapshot and Section analysis in lock-step with the
       live slider.  The renderer uses S.cells for the active row, so its count
       and any merge-to-individual percentages update on every input event. */
    saveResult();
    if (S.image && S.image.analysisSummaryReady)
        renderSectionAnalysisSummary(S.image);
    renderContrastNote();
}
/* What the floor is doing for the view on screen -- and, when it does not apply
   here, why, with the switch that makes it apply. A disabled slider used to look
   exactly like a working one, with only "off" beside it. */
function renderContrastNote() {
    const el = $('contrastNote');
    if (!el)
        return;
    el.textContent = '';
    if (!floorEnabled()) {
        if ((($('floorMode') || {}).value || 'donut') === 'off') {
            el.textContent = 'The brightness floor is off (Apply brightness floor below).';
            return;
        }
        const m = currentViewMode(), what = m === 'merge' ? 'a merge' : `in ${modeLabel(m)} mode`;
        el.append(m === 'normal'
            ? `Off in Normal mode: the ${classifierLabel()} has already judged how bright each soma must be. To drop dimmer ones too, `
            : `The floor applies to Donut-mode views only, and this view is ${what}. `);
        const b = document.createElement('button');
        b.type = 'button';
        b.className = 'linkish';
        b.textContent = m === 'normal' ? 'use the floor in all modes' : 'Apply it to all modes';
        b.onclick = () => {
            $('floorMode').value = 'all';
            $('floorMode').dispatchEvent(new Event('change'));
        };
        el.append(b);
        return;
    }
    if (!S.allCells) {
        el.textContent = 'Analyse this view to set its floor.';
        return;
    }
    const n = S.allCells.filter(c => !passesFloor(c)).length;
    const lowest = contrastFloor() <= (+$('minContrast').min || 0);
    el.textContent = classifierView() && (lowest || !floorSetByHand())
        ? `${S.cells.length} counted by the ${classifierLabel()} · drag the floor right to drop dimmer somata`
        : contrastFloor() > 0
            ? `${S.cells.length} counted · ${n} below the floor${S.floorAuto ? ' · placed automatically' : ''}`
            : `${S.cells.length} counted · floor off`;
}
function updateStats() {
    renderContrastNote();
    const auto = S.cells.filter(c => c.source === 'auto').length;
    $('sTotal').textContent = S.cells.length;
    $('sAuto').textContent = auto;
    $('sManual').textContent = S.cells.length - auto;
    $('sDropped').textContent = S.manualRemoved || 0;
    const copyable = !!(S.image && S.cells.length && copyTargets().length);
    $('copyCells').disabled = !copyable;
    $('copyCells').title = copyable ? 'Copy the somata counted here to another channel or merge of this image' : 'Analyse or add somata here to copy them to another channel';
    const clearable = !!(S.image && S.cells.length);
    $('clearCells').disabled = !clearable;
    $('clearCells').title = clearable ? `Clear all ${S.cells.length} somata counted in this view. Undo brings them back.` : 'Nothing counted here to clear';
    if (S.rej) {
        if (S.rej.axonCandidates != null) {
            const guides = (S.rej.axonGuideCounts || []).map(g => `${g.name} ${modeLabel(g.mode)}: ${g.count}`).join(' · ');
            $('rejOut').innerHTML = `Axon-heavy cross-channel — ${S.rej.axonCandidates} candidate soma locations from the guide channels; ${S.rej.axonWeak || 0} were too weak in this channel; ${S.rej.axonLike || 0} were rejected by the harsh anti-axon morphology filter; ${S.cells.length} counted. ${guides ? '<br>' + guides : ''}`;
        }
        else {
            $('rejOut').innerHTML = `Candidates rejected — ${S.rej.area} on area,
        ${S.rej.width} never wide enough, ${S.rej.aspect} too elongated,
        ${S.rej.contrast || 0} below the contrast floor,
        ${S.rej.holesFilled ? 'donut centres filled;' : ''}
        ${S.rej.satAdded ? 'saturated somata rescued;' : ''}
        ${S.rej.coloc ? S.rej.coloc + ' failing the colocalisation rule,' : ''}
        ${S.rej.fibres || 0} fibre structures dropped whole.
        ${S.rej.hasSlide === false ? 'No empty slide in frame, so the whole image was treated as tissue.'
                : S.rej.edgePixels ? 'Detection was suppressed outside the tissue and within the edge margin.' : ''}
        ${S.seeds} seeds were examined.`;
        }
    }
    renderRegions();
}
/* ------------------------------- settings -------------------------------- */
/* The shortcut keys, the side-by-side crosshair, panning and the warning before
   removing an image, chosen in the Settings window and kept in this browser.
   The number keys (channels), Esc and Ctrl+Z stay as they are. */
const SETTINGS_KEY = 'toolkit.soma.settings';
const KEY_ACTIONS = [
    ['add', 'Add tool', 'a'], ['remove', 'Remove tool (again: remove lasso)', 'r'],
    ['lasso', 'Lasso tool', 'l'], ['sideBySide', 'Side by side', 'p'],
    ['hideUi', 'Hide UI', 'h'], ['zoomIn', 'Zoom in', '+'], ['zoomOut', 'Zoom out', '-'],
    ['panLeft', 'Pan left', 'ArrowLeft'], ['panRight', 'Pan right', 'ArrowRight'], ['panUp', 'Pan up', 'ArrowUp'],
    ['panDown', 'Pan down', 'ArrowDown'], ['panDrag', 'Drag scroll', ' ']
];
const CROSS_DEFAULTS = { real: '#ffc23d', copy: '#ffffff', size: 14, width: 2, copies: true };
/* Edge panning on or off, and its speed in screen pixels per frame at the very
   edge. Dragging the view is one binding: the drag key (keys.panDrag, may be
   none) held with a mouse button (0 left, 1 middle, 2 right); Space + left by
   default. The left button alone is never a binding, as the tools need it. */
const PAN_DEFAULTS = { edge: false, edgeSpeed: 12, dragButton: 0 };
const somaSettings = loadSomaSettings();
function loadSomaSettings() {
    const keys = Object.fromEntries(KEY_ACTIONS.map(([a, , k]) => [a, k])), cross = { ...CROSS_DEFAULTS }, pan = { ...PAN_DEFAULTS };
    let confirmRemove = true;
    try {
        const s = JSON.parse(localStorage.getItem(SETTINGS_KEY) || 'null');
        if (s && s.keys)
            for (const a of Object.keys(keys))
                if (typeof s.keys[a] === 'string')
                    keys[a] = s.keys[a];
        if (s && s.cross)
            for (const k of Object.keys(cross))
                if (typeof s.cross[k] === typeof cross[k] && (typeof cross[k] !== 'string' || /^#[0-9a-f]{6}$/i.test(s.cross[k])))
                    cross[k] = s.cross[k];
        if (s && s.pan)
            for (const k of Object.keys(pan))
                if (typeof s.pan[k] === typeof pan[k] && (k !== 'dragButton' || [0, 1, 2].includes(s.pan[k])))
                    pan[k] = s.pan[k];
        if (s && typeof s.confirmRemove === 'boolean')
            confirmRemove = s.confirmRemove;
    }
    catch (_) { }
    if (pan.dragButton === 0 && !keys.panDrag)
        keys.panDrag = ' ';
    return { keys, cross, pan, confirmRemove };
}
function saveSomaSettings() {
    try {
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(somaSettings));
    }
    catch (_) { }
}
/* Letters match either case; + also answers to = and - to _, the keys they
   share on most keyboards. */
function keyIs(action, e) {
    const k = somaSettings.keys[action];
    if (!k)
        return false;
    const got = e.key.length === 1 ? e.key.toLowerCase() : e.key;
    return got === k || (k === '+' && got === '=') || (k === '-' && got === '_');
}
function keyLabel(k) {
    if (!k)
        return '—';
    return { ' ': 'Space', ArrowLeft: '←', ArrowRight: '→', ArrowUp: '↑', ArrowDown: '↓' }[k] || (k.length === 1 ? k.toUpperCase() : k);
}
const BUTTON_NAMES = ['left', 'middle', 'right'];
/* "Space + left drag", "middle drag". */
function dragLabel() {
    const k = somaSettings.keys.panDrag, b = BUTTON_NAMES[somaSettings.pan.dragButton];
    return (k ? keyLabel(k) + ' + ' + b : b[0].toUpperCase() + b.slice(1)) + ' drag';
}
/* Keys that cannot be given to an action: the channel numbers and what the
   browser or the page already needs. */
function keyNotAllowed(e) {
    if (/^[1-9]$/.test(e.key))
        return 'The number keys pick channels.';
    if (['Escape', 'Tab', 'Enter', 'Shift', 'Control', 'Alt', 'Meta', 'CapsLock', 'Dead'].includes(e.key) || e.ctrlKey || e.metaKey || e.altKey)
        return `${e.key === ' ' ? 'Space' : e.key} cannot be used here.`;
    return '';
}
/* The buttons that name a key follow the chosen keys. */
function refreshKeyHints() {
    const K = a => keyLabel(somaSettings.keys[a]).toLowerCase();
    $('tAdd').title = `Add (${K('add').toUpperCase()}): click to add a soma; drag to pan`;
    $('tLasso').title = `Lasso (${K('lasso').toUpperCase()}): drag a freehand loop around counted somata to assign them to the active region. Use it for SN and VTA.`;
    $('zIn').title = `Zoom in (${K('zoomIn')}, or pinch)`;
    $('zOut').title = `Zoom out (${K('zoomOut')}, or pinch)`;
    $('hideUiKey').textContent = keyLabel(somaSettings.keys.hideUi);
    const P = keyLabel(somaSettings.keys.sideBySide), H = keyLabel(somaSettings.keys.hideUi);
    $('sideBySide').title = `Every channel and merge side by side, at the same place and zoom, for judging colocalisation (${P}). Scroll or ${dragLabel()} to move all, Ctrl/pinch or + / − to zoom, Esc to close. Dots and regions can be edited in any panel.`;
    $('hideUi').title = `Hide everything but the image (${H}). ${H}, Esc or Show UI brings it back.`;
    $('showUi').title = `Show the controls again (${H} or Esc)`;
}
/* The cross that marks the pointer's place in side by side: the one under the
   pointer in its own colour and size, the copies in the other panels smaller
   and in theirs. The Settings preview draws through this too. */
function drawSbsCross(g, px, py, real) {
    const c = somaSettings.cross;
    if (!real && !c.copies)
        return;
    const a = real ? c.size : Math.max(4, c.size * 0.65), w = real ? c.width : Math.max(0.8, c.width * 0.55), gap = 3;
    g.save();
    for (const [col, lw, alpha] of [[real ? 'rgba(0,0,0,.8)' : 'rgba(0,0,0,.6)', w + 2, 1], [real ? c.real : c.copy, w, real ? 1 : 0.8]]) {
        g.globalAlpha = alpha;
        g.strokeStyle = col;
        g.lineWidth = lw;
        g.beginPath();
        g.moveTo(px - a, py);
        g.lineTo(px - gap, py);
        g.moveTo(px + gap, py);
        g.lineTo(px + a, py);
        g.moveTo(px, py - a);
        g.lineTo(px, py - gap);
        g.moveTo(px, py + gap);
        g.lineTo(px, py + a);
        g.stroke();
    }
    g.restore();
}
/* Whether a press starts a pan whatever the tool: the drag binding's button,
   with its key held if it has one. */
function dragPans(e) {
    return e.button === somaSettings.pan.dragButton && (!somaSettings.keys.panDrag || spaceHeld);
}
/* ---- The Settings window ---- */
let keyListening = null, dragKeyHeld = '', swallowClick = false;
/* Keys that are always the same, listed with the rest so every key is in one place. */
const FIXED_KEYS = [['Show channels (held together: their merge)', '1–9'], ['Undo', 'Ctrl+Z'], ['Close a window, leave Hide UI', 'Esc']];
function renderKeyList() {
    $('keyList').replaceChildren(...KEY_ACTIONS.filter(([act]) => act !== 'panDrag').map(([act, label]) => keyRow(act, label)),
        ...FIXED_KEYS.map(([label, key]) => {
            const row = document.createElement('div'), name = document.createElement('span'), b = document.createElement('span');
            row.className = 'key-row';
            name.textContent = label;
            b.className = 'key-btn key-fixed';
            b.textContent = key;
            row.append(name, b);
            return row;
        }));
    /* Drag scroll lives with the other panning settings. */
    $('dragScrollRow').replaceChildren(keyRow('panDrag', 'Drag scroll'));
}
function keyRow(act, label) {
    const row = document.createElement('div'), name = document.createElement('span'), b = document.createElement('button');
    row.className = 'key-row';
    name.textContent = label;
    b.type = 'button';
    b.className = 'key-btn' + (act === 'panDrag' ? ' key-combo' : '') + (keyListening === act ? ' listening' : '');
    b.textContent = keyListening === act
        ? (act === 'panDrag' ? (dragKeyHeld ? keyLabel(dragKeyHeld) + ' + click…' : 'Hold a key, click…') : 'Press a key…')
        : (act === 'panDrag' ? dragLabel() : keyLabel(somaSettings.keys[act]));
    b.onclick = () => {
        keyListening = keyListening === act ? null : act;
        dragKeyHeld = '';
        $('settingsMsg').textContent = !keyListening ? '' : act === 'panDrag'
            ? 'Hold the key you want (or none), then click with the mouse button that should drag. Esc keeps the old one.'
            : 'Press the new key, or Esc to keep the old one.';
        renderKeyList();
    };
    row.append(name, b);
    return row;
}
/* Gives a key to an action. Whatever had that key loses it; if that leaves the
   drag binding as the left button alone, it moves to the middle button. */
function assignKey(act, k) {
    const other = k && KEY_ACTIONS.find(([a]) => a !== act && somaSettings.keys[a] === k);
    let note = '';
    if (other) {
        somaSettings.keys[other[0]] = '';
        note = `${keyLabel(k)} was ${other[1]}; that now has no key.`;
        if (other[0] === 'panDrag' && somaSettings.pan.dragButton === 0) {
            somaSettings.pan.dragButton = 1;
            note = `${keyLabel(k)} was the drag key; dragging the view is now the middle button.`;
        }
    }
    somaSettings.keys[act] = k;
    return note;
}
function finishListening(note) {
    keyListening = null;
    dragKeyHeld = '';
    saveSomaSettings();
    renderKeyList();
    refreshKeyHints();
    $('settingsMsg').textContent = note || '';
}
function drawCrossPreview() {
    const cv = $('crossPreview'), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
    if (!(W > 0 && H > 0))
        return;
    cv.width = Math.round(W * dpr);
    cv.height = Math.round(H * dpr);
    const g = cv.getContext('2d'), half = (W - 6) / 2;
    g.setTransform(dpr, 0, 0, dpr, 0, 0);
    g.clearRect(0, 0, W, H);
    [[0, true, 'Under the pointer'], [half + 6, false, somaSettings.cross.copies ? 'Copy in another panel' : 'Copies hidden']].forEach(([x0, real, label]) => {
        g.fillStyle = '#05070a';
        g.fillRect(x0, 0, half, H);
        g.fillStyle = 'rgba(255,255,255,.5)';
        for (const [dx, dy] of [[.2, .32], [.78, .26], [.3, .8], [.82, .72]]) {
            g.beginPath();
            g.arc(x0 + dx * half, dy * H, 4, 0, Math.PI * 2);
            g.fill();
        }
        drawSbsCross(g, x0 + half / 2, H / 2, real);
        g.fillStyle = 'rgba(232,237,243,.85)';
        g.font = '10.5px system-ui, sans-serif';
        g.fillText(label, x0 + 7, 15);
    });
}
function syncCrossInputs() {
    const c = somaSettings.cross;
    $('crossReal').value = c.real;
    $('crossCopy').value = c.copy;
    $('crossSize').value = c.size;
    $('crossSizeV').textContent = c.size + ' px';
    $('crossWidth').value = c.width;
    $('crossWidthV').textContent = c.width + ' px';
    $('crossCopies').checked = c.copies;
    $('crossCopy').disabled = !c.copies;
}
function crossChanged() {
    saveSomaSettings();
    syncCrossInputs();
    drawCrossPreview();
    if (typeof SBS !== 'undefined' && SBS.open)
        sbsDraw();
}
function syncPanInputs() {
    const P = somaSettings.pan;
    $('edgePanOn').checked = P.edge;
    $('edgePanSpeed').value = P.edgeSpeed;
    $('edgePanSpeedV').textContent = String(P.edgeSpeed);
    $('edgePanSpeed').disabled = !P.edge;
    $('confirmRemoveOn').checked = somaSettings.confirmRemove;
}
function panChanged() {
    saveSomaSettings();
    syncPanInputs();
    refreshKeyHints();
}
function openSettings() {
    keyListening = null;
    $('settingsMsg').textContent = '';
    renderKeyList();
    syncCrossInputs();
    syncPanInputs();
    $('settingsModal').classList.add('show');
    requestAnimationFrame(drawCrossPreview);
    $('settingsClose').focus({ preventScroll: true });
}
function closeSettings() {
    keyListening = null;
    $('settingsModal').classList.remove('show');
    $('settingsBtn').focus({ preventScroll: true });
}
$('settingsBtn').onclick = openSettings;
$('settingsClose').onclick = closeSettings;
$('settingsModal').addEventListener('pointerdown', e => { if (e.target === $('settingsModal') && !keyListening)
    closeSettings(); });
$('resetKeys').onclick = () => {
    KEY_ACTIONS.forEach(([a, , k]) => { somaSettings.keys[a] = k; });
    somaSettings.pan.dragButton = PAN_DEFAULTS.dragButton;
    finishListening('Keys are back to the defaults.');
};
$('resetCross').onclick = () => {
    Object.assign(somaSettings.cross, CROSS_DEFAULTS);
    crossChanged();
};
$('crossReal').addEventListener('input', e => { somaSettings.cross.real = e.target.value; crossChanged(); });
$('crossCopy').addEventListener('input', e => { somaSettings.cross.copy = e.target.value; crossChanged(); });
$('crossSize').addEventListener('input', e => { somaSettings.cross.size = +e.target.value; crossChanged(); });
$('crossWidth').addEventListener('input', e => { somaSettings.cross.width = +e.target.value; crossChanged(); });
$('crossCopies').addEventListener('change', e => { somaSettings.cross.copies = e.target.checked; crossChanged(); });
$('edgePanOn').addEventListener('change', e => { somaSettings.pan.edge = e.target.checked; panChanged(); });
$('edgePanSpeed').addEventListener('input', e => { somaSettings.pan.edgeSpeed = +e.target.value; panChanged(); });
$('confirmRemoveOn').addEventListener('change', e => { somaSettings.confirmRemove = e.target.checked; panChanged(); });
$('resetPan').onclick = () => {
    somaSettings.pan.edge = PAN_DEFAULTS.edge;
    somaSettings.pan.edgeSpeed = PAN_DEFAULTS.edgeSpeed;
    panChanged();
};
/* While the window is open its keys are its own: the key being chosen, Esc
   to close, and nothing behind it reacts. Sliders and boxes in it keep theirs. */
window.addEventListener('keydown', e => {
    if (!$('settingsModal').classList.contains('show'))
        return;
    e.stopImmediatePropagation();
    if (keyListening) {
        e.preventDefault();
        if (e.key === 'Escape') {
            finishListening('');
            return;
        }
        const notAllowed = keyNotAllowed(e);
        if (notAllowed) {
            if (!['Shift', 'Control', 'Alt', 'Meta'].includes(e.key))
                $('settingsMsg').textContent = notAllowed;
            return;
        }
        const k = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        /* The drag binding waits for the click; the key is only held for now. */
        if (keyListening === 'panDrag') {
            if (dragKeyHeld !== k) {
                dragKeyHeld = k;
                renderKeyList();
            }
            return;
        }
        finishListening(assignKey(keyListening, k));
        return;
    }
    if (e.key === 'Escape') {
        e.preventDefault();
        closeSettings();
    }
}, true);
window.addEventListener('keyup', e => {
    if (keyListening === 'panDrag' && dragKeyHeld && (e.key.length === 1 ? e.key.toLowerCase() : e.key) === dragKeyHeld) {
        dragKeyHeld = '';
        renderKeyList();
    }
}, true);
/* Choosing the drag binding: the click that names the button, anywhere in the
   window, with the key (if any) that is held. */
window.addEventListener('pointerdown', e => {
    if (keyListening !== 'panDrag' || !$('settingsModal').classList.contains('show'))
        return;
    e.preventDefault();
    e.stopImmediatePropagation();
    /* The click that follows belongs to the choice, not to what it landed on. */
    swallowClick = true;
    if (e.button === 0 && !dragKeyHeld) {
        $('settingsMsg').textContent = 'The left button alone is what the tools use; hold a key with it, or click with the middle or right button.';
        return;
    }
    if (e.button > 2)
        return;
    somaSettings.pan.dragButton = e.button;
    finishListening(assignKey('panDrag', dragKeyHeld));
}, true);
window.addEventListener('click', e => {
    if (!swallowClick)
        return;
    swallowClick = false;
    e.preventDefault();
    e.stopImmediatePropagation();
}, true);
window.addEventListener('pointerup', () => setTimeout(() => { swallowClick = false; }, 0), true);
window.addEventListener('contextmenu', e => { if (keyListening === 'panDrag' || swallowClick)
    e.preventDefault(); }, true);
window.addEventListener('resize', () => { if ($('settingsModal').classList.contains('show'))
    drawCrossPreview(); });
syncPanInputs();
refreshKeyHints();
/* --------------------------- channel names ink --------------------------- */
/* Channel names in their channel's colour wherever they appear on the page:
   the fluorophores by name (DAPI, FITC, Cy3, Cy5 ...) and the open image's own
   channel names, in the colour of that channel's button (lightened, as the
   coloured legends are, when too dark to read). Text is wrapped as it
   arrives; boxes you type in, lists, pictures and the coloured legends that
   already carry the colour are left alone. */
const FLUOR_NAME_RE = String.raw`DAPI|Hoechst(?:\s?333\d\d)?|FITC|E?GFP|TRITC|Texas[\s-]?Red|Cy\s?[2357](?:\.5)?|Alexa(?:\s?Fluor)?[\s-]?(?:405|488|555|568|594|647)|AF[\s-]?(?:405|488|555|568|594|647)|Far[\s-]?red|tdTomato|mCherry`;
const INK_SKIP = 'script,style,textarea,input,select,option,canvas,svg,[contenteditable],.ch-ink,.tk-merge-part';
let inkRe = null, inkObserver = null, inkFrame = 0;
const inkKey = s => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function channelInkFor(name) {
    const k = inkKey(name), sec = S.image, ch = (sec && sec.channels) || [];
    for (let i = 0; i < ch.length; i++)
        if (inkKey(channelLabelAt(sec, i)) === k)
            return channelButtonColor(ch[i], i);
    if (/dapi|hoechst|405|fitc|gfp|488|cy\s?3|tritc|555|561|568|cy\s?5|647|far[\s-]?red/i.test(name))
        return channelButtonColor({ name: String(name).replace(/\s+/g, '') });
    const id = ToolkitCore.channels.inferIdentity(name);
    return id && id.key !== 'other' ? id.hex : null;
}
function inkRegex() {
    const sec = S.image, own = ((sec && sec.channels) || []).map((c, i) => channelLabelAt(sec, i))
        .filter(n => n && n.trim().length > 1 && !/^channel\s*\d+$/i.test(n.trim()))
        .map(n => n.trim().replace(/[.*+?^${}()|[\]\\]/g, '\\$&'))
        .sort((a, b) => b.length - a.length);
    return new RegExp(`(?<![A-Za-z0-9])(?:${[...own, FLUOR_NAME_RE].join('|')})(?![A-Za-z0-9])`, 'gi');
}
function inkTextNode(t) {
    const s = t.nodeValue;
    if (!s || s.length < 3)
        return;
    inkRe.lastIndex = 0;
    if (!inkRe.test(s))
        return;
    inkRe.lastIndex = 0;
    const frag = document.createDocumentFragment();
    let last = 0, m;
    while ((m = inkRe.exec(s))) {
        const hex = channelInkFor(m[0]);
        if (!hex)
            continue;
        if (m.index > last)
            frag.append(s.slice(last, m.index));
        const sp = document.createElement('span');
        sp.className = 'ch-ink';
        sp.dataset.ch = m[0];
        sp.style.setProperty('--ch-ink', ToolkitCore.channels.readableInk(hex));
        sp.textContent = m[0];
        frag.append(sp);
        last = m.index + m[0].length;
    }
    if (!last)
        return;
    if (last < s.length)
        frag.append(s.slice(last));
    t.replaceWith(frag);
}
function inkWithin(root) {
    if (root.nodeType === 3) {
        if (root.parentElement && !root.parentElement.closest(INK_SKIP))
            inkTextNode(root);
        return;
    }
    if (root.nodeType !== 1 || root.closest(INK_SKIP))
        return;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, { acceptNode: n => n.parentElement && !n.parentElement.closest(INK_SKIP) ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP });
    const list = [];
    while (walker.nextNode())
        list.push(walker.currentNode);
    list.forEach(inkTextNode);
}
function watchInk() { inkObserver.observe(document.body, { childList: true, subtree: true, characterData: true }); }
/* Its own wrapping is done with the watch off, so it never reacts to itself. */
function inkQuietly(fn) {
    inkObserver.disconnect();
    try {
        fn();
    }
    finally {
        watchInk();
    }
}
/* A new image brings new channel names and colours: recolour what is wrapped
   and look again for names that were not channel names before. */
function scheduleChannelInk() {
    if (inkFrame || !inkObserver)
        return;
    inkFrame = requestAnimationFrame(() => {
        inkFrame = 0;
        inkRe = inkRegex();
        inkQuietly(() => {
            document.querySelectorAll('.ch-ink').forEach(sp => {
                const hex = channelInkFor(sp.dataset.ch);
                if (hex)
                    sp.style.setProperty('--ch-ink', ToolkitCore.channels.readableInk(hex));
            });
            inkWithin(document.body);
        });
    });
}
inkRe = inkRegex();
inkObserver = new MutationObserver(recs => inkQuietly(() => {
    for (const r of recs) {
        if (r.type === 'characterData')
            r.target.isConnected && inkWithin(r.target);
        else
            r.addedNodes.forEach(n => n.isConnected && inkWithin(n));
    }
}));
inkQuietly(() => inkWithin(document.body));
/* ------------------------------ undo ------------------------------------
   One history per image, kept across channel and merge switches and new
   analyses (it used to be wiped by both). Each step holds what every view it
   touched was before it -- that view's saved analysis, cells, floors and
   decision log -- and the regions when it changed them; undo puts those back
   and shows the view the step was made in. Steps: adding and removing somata
   (here, in side by side, in the review grid), drawing, cutting, deleting,
   renaming and clearing regions, moving either floor or pressing its auto, and
   each analysis, including a failed one.
   ---------------------------------------------------------------------- */
const UNDO_LIMIT = 40;
function undoStack(sec = S.image) { return sec ? (sec.undo || (sec.undo = [])) : []; }
function viewBefore(sec, value) {
    const key = analysisKey(sec, value), r = S.results.get(key);
    return { key, value, before: r ? Object.assign({}, r, { cells: (r.cells || []).slice(), decisions: (r.decisions || []).slice() }) : null };
}
function snapshot(label, opts = {}) {
    const sec = S.image;
    if (!sec)
        return null;
    const value = $('chDetect').value;
    saveResult();
    const u = { label, value, items: [viewBefore(sec, value)], regions: opts.regions ? cloneRegionsForUndo(S.regions) : undefined };
    const st = undoStack(sec);
    st.push(u);
    if (st.length > UNDO_LIMIT)
        st.shift();
    updateUndo();
    return u;
}
/* Another view a step also writes to, recorded before it is written. */
function snapshotAlso(u, value) {
    if (u && S.image && !u.items.some(it => it.value === value))
        u.items.push(viewBefore(S.image, value));
}
/* A step that turned out to change nothing leaves no entry behind. */
function dropSnapshot(u) {
    const st = undoStack();
    if (u && st[st.length - 1] === u) {
        st.pop();
        updateUndo();
    }
}
const valueIdx = v => v[0] === 'c' ? [+v.slice(1)] : mergeConstituentIndices(v);
function undo() {
    const sec = S.image, st = undoStack(sec);
    if (!st.length) {
        setStatus('Nothing to undo.');
        return;
    }
    if (S.busy || S.run) {
        setStatus('Wait for the current step to finish, then undo.');
        return;
    }
    const u = st.pop();
    saveResult();
    for (const it of u.items) {
        if (it.before)
            S.results.set(it.key, it.before);
        else
            S.results.delete(it.key);
    }
    if (u.regions) {
        S.regions.splice(0, S.regions.length, ...u.regions);
        sec.regions = S.regions;
        S.activeRegion = Math.min(Math.max(S.activeRegion, 0), S.regions.length - 1);
    }
    /* The view on screen takes its restored state before anything can save over it. */
    restoreCurrentResult();
    const here = $('chDetect').value === u.value;
    if (!here)
        setChannelButtonsSelection(valueIdx(u.value));
    S.marked = new Set();
    assignRegions();
    renderRegions();
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    if (sec.analysisSummaryReady)
        renderSectionAnalysisSummary(sec);
    ['expCells', 'expSummary', 'expRun', 'expPng'].forEach(id => $(id).disabled = !S.cells.length);
    syncTiffExportButtons();
    renderFileList();
    updateUndo();
    setStatus(`Undid: ${u.label}${here ? '' : ` (in ${analysisSelectionLabel(sec, u.value)})`}. ${S.cells.length} somata.`);
}
function updateUndo() {
    const b = $('undoBtn');
    if (!b)
        return;
    const st = undoStack(), n = st.length;
    b.disabled = !n;
    b.title = n ? `Undo: ${st[n - 1].label}` : 'Nothing to undo';
}
/* --------------------------- decision log -------------------------------
   Every verdict you give — in the review grid or with the add/remove tools —
   is recorded with the full feature vector that produced the candidate.  This
   is the raw material for tuning: it says where your decision boundary
   actually sits, as opposed to where the defaults assume it sits.
   ---------------------------------------------------------------------- */
function detectChannel() {
    if (!S.image)
        return null;
    const ch = S.image.channels, sel = parseDetect();
    if (sel.merge) {
        const base = ch[primaryOf(sel.idx)] || ch[0];
        return { name: sel.idx.map(i => ch[i].name).join(' + '), data: base.data,
            bits: base.bits, clipped: base.clipped, w: base.w, h: base.h, inverted: base.inverted };
    }
    return ch[sel.idx[0]] || ch[0] || null;
}
function logDecision(c, verdict, into, channel) {
    if (!into && !S.decisions)
        S.decisions = [];
    const p = params(), dch = detectChannel();
    (into || S.decisions).push({
        section: S.image ? S.image.name : '',
        channel: channel != null ? channel : dch ? dch.name : '',
        verdict: verdict,
        x: c.x, y: c.y,
        width: c.width, minor: c.minor, major: c.major, aspect: c.aspect, area: c.area,
        z: (c.z && isFinite(c.z[0])) ? c.z[0] : '', peak: isFinite(c.peak) ? c.peak : '',
        raw: isFinite(c.raw) ? c.raw : '', bg: isFinite(c.bg) ? c.bg : '', sigma: isFinite(c.sig) ? c.sig : '',
        contrast: isFinite(c.contrast) ? c.contrast : '',
        conf: c.conf, source: c.source,
        p_dMin: p.dMin, p_dMax: p.dMax, p_snr: p.snr, p_minWidth: p.minWidth, p_minContrast: p.minContrast,
        p_sep: +p.sep.toFixed(2), p_maxAspect: p.maxAspect, p_edge: p.edgeMargin,
        px_um: +$('pxSize').value || '', cut: confCut(), when: new Date().toISOString()
    });
    $('expDecisions').disabled = false;
}
/* ---- Borderline tally ------------------------------------------------------
   Automatic detections close to a decision limit (confidence under 45%). Only
   the run export reports how many remain; the grid that showed them for review
   is gone. */
function buildQueue() { refreshQueue(); }
function confCut() { return 0.45; }
function refreshQueue() { S.queue = S.cells.filter(c => c.source === 'auto' && c.conf < confCut()); }
function centreOn(c) {
    if (!c)
        return;
    const ws = $('stageWrap');
    ws.scrollLeft = c.x * S.zoom - ws.clientWidth / 2;
    ws.scrollTop = c.y * S.zoom - ws.clientHeight / 2;
}
/* ---------------------------- view ------------------------------------- */
function fitView() {
    if (!S.image)
        return;
    const ws = $('stageWrap'), c = S.image.channels[0];
    if (!(c.w > 0 && c.h > 0))
        return;
    S.fit = Math.min((ws.clientWidth - 28) / c.w, (ws.clientHeight - 28) / c.h);
    S.zoom = S.fit;
    applyZoom();
}
/* Each section keeps where it was left: its magnification and the part of the
   image on screen. Switching files used to refit every time, so a 200% look at
   one section was thrown away the moment another was opened. The zoom is stored
   against the canvas width it was set at, so it survives a change of review
   resolution as the same magnification rather than the same number. */
function captureSectionView(sec = S.image) {
    /* Only a view that was actually put on screen for this section is worth
       keeping. Drawing is deferred while the page is in a background tab, so
       without this the zoom left over from the previous section would be stored
       against one that was never laid out. */
    if (!sec || sec !== S.image || !sec._viewReady || !(S.zoom > 0))
        return;
    const ws = $('stageWrap'), c = sec.channels && sec.channels[0];
    if (!ws || !c || !(c.w > 0))
        return;
    const sw = Math.max(1, ws.scrollWidth), sh = Math.max(1, ws.scrollHeight);
    sec._view = {
        zoom: S.zoom, basisW: c.w,
        fx: (ws.scrollLeft + ws.clientWidth / 2) / sw,
        fy: (ws.scrollTop + ws.clientHeight / 2) / sh
    };
}
function restoreSectionView(sec = S.image) {
    const v = sec && sec._view, c = sec && sec.channels && sec.channels[0];
    if (!v || !(v.zoom > 0) || !c || !(c.w > 0 && c.h > 0)) {
        fitView();
        return false;
    }
    const ws = $('stageWrap');
    S.fit = Math.min((ws.clientWidth - 28) / c.w, (ws.clientHeight - 28) / c.h);
    const basis = v.basisW > 0 ? v.basisW : c.w;
    S.zoom = clamp(v.zoom * (basis / c.w), S.fit * 0.5, 6);
    applyZoom();
    const place = () => {
        const sw = Math.max(1, ws.scrollWidth), sh = Math.max(1, ws.scrollHeight);
        ws.scrollLeft = clamp(v.fx * sw - ws.clientWidth / 2, 0, Math.max(0, sw - ws.clientWidth));
        ws.scrollTop = clamp(v.fy * sh - ws.clientHeight / 2, 0, Math.max(0, sh - ws.clientHeight));
    };
    place();
    requestAnimationFrame(place);
    return true;
}
/* The stage takes the zoomed size (what scrolling and centring see) and only
   the two canvases inside it are scaled. Scaling the stage as well made it
   zoom times too big, so at 4x three quarters of the scrollable area was
   empty and scrolling or zooming could land on black. */
/* The zoom button reads the magnification, screen pixels per image pixel (the
   display may hold the image at a reduced resolution), and fits on a click. */
function updateZoomReadout() {
    const z = sbsOpen() ? SBS.zoom : S.zoom;
    $('zFit').textContent = S.image && z > 0 ? Math.round(z * (S.displayScaleX || 1) * 100) + '%' : 'Fit';
}
function applyZoom() {
    const c = S.image.channels[0];
    S.image._viewReady = true;
    const st = $('stage');
    st.style.transform = '';
    st.style.width = (c.w * S.zoom) + 'px';
    st.style.height = (c.h * S.zoom) + 'px';
    for (const id of ['base', 'ov']) {
        $(id).style.transformOrigin = '0 0';
        $(id).style.transform = `scale(${S.zoom})`;
    }
    updateZoomReadout();
    drawOverlay();
}
function canvasPoint(e) {
    const r = $('ov').getBoundingClientRect();
    return { x: (e.clientX - r.left) * S.image.channels[0].w / r.width,
        y: (e.clientY - r.top) * S.image.channels[0].h / r.height };
}
function zoomAtScreenPoint(nextZoom, clientX, clientY) {
    if (!S.image)
        return;
    const ws = $('stageWrap'), ov = $('ov');
    nextZoom = clamp(nextZoom, S.fit * 0.5, 6);
    if (Math.abs(nextZoom - S.zoom) < 1e-9)
        return;
    /* Work in screen space instead of trying to infer the scroll geometry from
       the CSS transform.  Remember the fractional image point under the cursor,
       apply the new scale, then scroll by exactly the amount that point moved. */
    const before = ov.getBoundingClientRect();
    if (!(before.width > 0 && before.height > 0))
        return;
    if (!Number.isFinite(clientX) || !Number.isFinite(clientY)) {
        const wr = ws.getBoundingClientRect();
        clientX = wr.left + wr.width / 2;
        clientY = wr.top + wr.height / 2;
    }
    const fx = clamp((clientX - before.left) / before.width, 0, 1);
    const fy = clamp((clientY - before.top) / before.height, 0, 1);
    S.zoom = nextZoom;
    applyZoom();
    const after = ov.getBoundingClientRect();
    ws.scrollLeft += after.left + fx * after.width - clientX;
    ws.scrollTop += after.top + fy * after.height - clientY;
}
function keyboardZoom(factor) {
    if (sbsOpen()) {
        const p = S.zoomCursor;
        sbsZoomAt(p && p.sbs, factor, p && p.sbs ? { clientX: p.x, clientY: p.y } : null);
        return;
    }
    const p = S.zoomCursor;
    zoomAtScreenPoint(S.zoom * factor, p && p.x, p && p.y);
}
$('stageWrap').addEventListener('pointermove', e => {
    S.zoomCursor = { x: e.clientX, y: e.clientY };
});
$('stageWrap').addEventListener('pointerleave', () => { S.zoomCursor = null; });
/* Trackpad pinch, which browsers report as a Ctrl+wheel, and Ctrl/Cmd+wheel zoom
   about the pointer; a plain two-finger swipe or wheel scrolls the view. Safari
   reports a pinch as gesture events instead. One wheel notch is capped so a mouse
   zooms in steps rather than leaps. */
let pinchGesture = null;
function wheelZoomFactor(e, pageH) {
    const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? pageH : 1;
    return Math.exp(-clamp(e.deltaY * k, -50, 50) * 0.01);
}
$('stageWrap').addEventListener('wheel', e => {
    if (!(e.ctrlKey || e.metaKey) || !S.image)
        return;
    e.preventDefault();
    if (!pinchGesture)
        zoomAtScreenPoint(S.zoom * wheelZoomFactor(e, $('stageWrap').clientHeight), e.clientX, e.clientY);
}, { passive: false });
for (const el of [$('stageWrap'), $('sbs')]) {
    el.addEventListener('gesturestart', e => { e.preventDefault(); pinchGesture = { scale: 1 }; });
    el.addEventListener('gesturechange', e => {
        e.preventDefault();
        if (!pinchGesture || !S.image)
            return;
        const factor = e.scale / pinchGesture.scale;
        pinchGesture.scale = e.scale;
        if (sbsOpen())
            sbsZoomAt(S.zoomCursor && S.zoomCursor.sbs, factor, e);
        else
            zoomAtScreenPoint(S.zoom * factor, e.clientX, e.clientY);
    });
    el.addEventListener('gestureend', e => { e.preventDefault(); pinchGesture = null; });
}
/* Hide UI: only the counting area, filling the window (H, or the button); H, Esc
   or Show UI brings the rest back. The view keeps its place and zoom. */
function setUiHidden(on) {
    if (document.body.classList.contains('ui-hidden') === on)
        return;
    for (const side of Object.keys(peekParts))
        setPeek(side, false);
    const keep = S.image && !sbsOpen();
    if (keep)
        captureSectionView();
    document.body.classList.toggle('ui-hidden', on);
    $('hideUi').classList.toggle('on', on);
    if (keep)
        restoreSectionView();
    if (!on)
        $('viewBtn').focus({ preventScroll: true });
}
/* With the UI hidden, the pointer at an edge of the window brings that edge's
   panels back over the image; they slide away a moment after it leaves them,
   unless a box in them is being typed in. Not during a drag, so panning or a
   lasso that reaches the edge does not pull a panel over the image. */
const PEEK_EDGE = 10;
const peekParts = {
    left: () => [document.querySelector('.layout > aside:not(.right)')],
    right: () => [document.querySelector('.layout > aside.right')],
    top: () => [document.querySelector('.app > header'), document.querySelector('main > .bar'), $('viewMenu')]
};
const peekTimers = {};
function keepPeek(side) {
    clearTimeout(peekTimers[side]);
    peekTimers[side] = 0;
}
function setPeek(side, on) {
    keepPeek(side);
    if (on && side === 'top')
        document.body.style.setProperty('--peek-header-h', document.querySelector('.app > header').offsetHeight + 'px');
    document.body.classList.toggle('peek-' + side, on);
}
document.addEventListener('pointermove', e => {
    if (!document.body.classList.contains('ui-hidden'))
        return;
    const x = e.clientX, y = e.clientY, near = 16;
    for (const side of Object.keys(peekParts)) {
        const on = document.body.classList.contains('peek-' + side);
        const atEdge = side === 'left' ? x <= PEEK_EDGE : side === 'right' ? x >= window.innerWidth - 1 - PEEK_EDGE : y <= PEEK_EDGE;
        if (atEdge) {
            if (!on && !e.buttons)
                setPeek(side, true);
            else
                keepPeek(side);
            continue;
        }
        if (!on)
            continue;
        const parts = peekParts[side]().filter(Boolean);
        const over = parts.some(el => { const r = el.getBoundingClientRect(); return x >= r.left - near && x <= r.right + near && y >= r.top - near && y <= r.bottom + near; });
        const typing = parts.some(el => el.contains(document.activeElement) && typingTarget(document.activeElement));
        if (over || typing)
            keepPeek(side);
        else if (!peekTimers[side])
            peekTimers[side] = setTimeout(() => setPeek(side, false), 250);
    }
});
/* ---- The View menu ----
   Markers, regions, ring size, display resolution and Hide UI, one click away.
   Hovering the button with a mouse shows it for as long as the pointer is on
   the button or the menu; a click pins it open. Pinned, it stays while things
   are switched and closes on a click elsewhere, on Esc, or when the UI is
   hidden. The button names what is switched on. */
let viewMenuPinned = false, viewMenuTimer = 0;
function setViewMenu(open, pinned = open) {
    clearTimeout(viewMenuTimer);
    viewMenuTimer = 0;
    viewMenuPinned = open && pinned;
    $('viewMenu').hidden = !open;
    $('viewBtn').setAttribute('aria-expanded', String(open));
    $('viewBtn').classList.toggle('on', open);
}
function updateViewSummary() {
    const on = [['toggleOv', 'Markers'], ['toggleRgn', 'Regions']].filter(([id]) => $(id).classList.contains('on')).map(([, n]) => n);
    $('viewSummary').textContent = '· ' + (on.length ? on.join(', ') : 'image only');
}
$('viewBtn').onclick = () => setViewMenu(!viewMenuPinned);
const viewWrap = $('viewBtn').closest('.view-wrap');
viewWrap.addEventListener('pointerenter', e => {
    if (e.pointerType !== 'mouse')
        return;
    clearTimeout(viewMenuTimer);
    viewMenuTimer = 0;
    if ($('viewMenu').hidden)
        setViewMenu(true, false);
});
viewWrap.addEventListener('pointerleave', e => {
    if (e.pointerType !== 'mouse' || viewMenuPinned || $('viewMenu').hidden)
        return;
    /* A moment's grace, so the gap between button and menu can be crossed and
       an open dropdown list inside it does not close the menu. */
    viewMenuTimer = setTimeout(() => {
        const list = document.activeElement;
        const choosing = list && list.tagName === 'SELECT' && viewWrap.contains(list);
        if (!viewMenuPinned && !choosing && !viewWrap.matches(':hover'))
            setViewMenu(false);
    }, 250);
});
document.addEventListener('pointerdown', e => { if (!$('viewMenu').hidden && !e.target.closest('.view-wrap'))
    setViewMenu(false); });
window.addEventListener('keydown', e => {
    if (e.key === 'Escape' && !$('viewMenu').hidden) {
        e.preventDefault();
        e.stopImmediatePropagation();
        setViewMenu(false);
        $('viewBtn').focus({ preventScroll: true });
    }
}, true);
new MutationObserver(updateViewSummary).observe($('toggleOv'), { attributes: true, attributeFilter: ['class'] });
new MutationObserver(updateViewSummary).observe($('toggleRgn'), { attributes: true, attributeFilter: ['class'] });
updateViewSummary();
$('hideUi').onclick = () => {
    setViewMenu(false);
    setUiHidden(true);
};
$('showUi').onclick = () => setUiHidden(false);
/* ---- Panning ----------------------------------------------------------------
   The pan keys move the view (Shift for a bigger step), and the drag binding
   from Settings (Space + left drag unless changed) drags it with any tool.
   Side by side pans the same way. spaceHeld is whether the drag key is held. */
let spaceHeld = false, mainPan = null;
function setSpaceHeld(on) {
    spaceHeld = on;
    $('stageWrap').classList.toggle('pan-ready', on);
    $('sbs').classList.toggle('pan-ready', on);
}
/* dx, dy in screen pixels: how far the picture's content moves under the view. */
function panBy(dx, dy) {
    if (sbsOpen()) {
        SBS.cx += dx / SBS.zoom;
        SBS.cy += dy / SBS.zoom;
        sbsDraw();
        return;
    }
    const ws = $('stageWrap');
    ws.scrollLeft += dx;
    ws.scrollTop += dy;
}
function startMainPan(e) {
    const ws = $('stageWrap');
    e.preventDefault();
    mainPan = { x: e.clientX, y: e.clientY, left: ws.scrollLeft, top: ws.scrollTop };
    ws.classList.add('panning');
    try {
        $('ov').setPointerCapture(e.pointerId);
    }
    catch (_) { }
}
function endMainPan(e) {
    if (!mainPan)
        return false;
    mainPan = null;
    $('stageWrap').classList.remove('panning');
    try {
        $('ov').releasePointerCapture(e.pointerId);
    }
    catch (_) { }
    return true;
}
/* The middle button would start the browser's own autoscroll, and the right
   one its menu when it pans. */
$('ov').addEventListener('mousedown', e => { if (e.button === 1)
    e.preventDefault(); });
$('ov').addEventListener('contextmenu', e => { if (somaSettings.pan.dragButton === 2)
    e.preventDefault(); });
/* ---- Edge panning ----
   When switched on in Settings: with the pointer near an edge of the view, the
   view scrolls that way, faster the closer it is. While a lasso or a Remove
   sweep is being drawn, a pointer past the edge keeps it going, and the line
   follows as the image moves under the still pointer. */
const EDGE_ZONE = 90;
let edgePtr = null, edgeFrame = 0;
window.addEventListener('pointermove', e => {
    /* The move this loop sends itself so the line follows is not a new pointer. */
    if (!e.isTrusted)
        return;
    edgePtr = { x: e.clientX, y: e.clientY, id: e.pointerId, buttons: e.buttons, target: e.target };
    if (!edgeFrame && somaSettings.pan.edge && S.image)
        edgeFrame = requestAnimationFrame(edgePanTick);
}, { passive: true });
function edgePanTick() {
    edgeFrame = 0;
    const P = somaSettings.pan, p = edgePtr;
    if (!P.edge || !S.image || !p || mainPan || (sbsOpen() && SBS.drag))
        return;
    const sbs = sbsOpen(), view = sbs ? (SBS.lasso || SBS.erase || (S.zoomCursor && S.zoomCursor.sbs)) : null;
    const drawing = sbs ? !!(SBS.lasso || SBS.erase) : !!(S.lassoing || S.erasing);
    const box = sbs ? view && view.canvas : $('stageWrap');
    /* Not drawing, the pointer has to be over the view itself, not over a panel
       or menu laid on top of it. */
    if (!box || (!drawing && !box.contains(p.target)))
        return;
    const r = box.getBoundingClientRect(), near = d => clamp((EDGE_ZONE - d) / EDGE_ZONE, 0, 1);
    const dx = (near(r.right - p.x) - near(p.x - r.left)) * P.edgeSpeed, dy = (near(r.bottom - p.y) - near(p.y - r.top)) * P.edgeSpeed;
    if (!dx && !dy)
        return;
    const ws = $('stageWrap'), before = sbs ? SBS.cx + ',' + SBS.cy : ws.scrollLeft + ',' + ws.scrollTop;
    panBy(dx, dy);
    if (sbs)
        sbsClampView();
    if ((sbs ? SBS.cx + ',' + SBS.cy : ws.scrollLeft + ',' + ws.scrollTop) === before)
        return;
    edgeFrame = requestAnimationFrame(edgePanTick);
    if (drawing)
        (sbs ? view.canvas : $('ov')).dispatchEvent(new PointerEvent('pointermove', { clientX: p.x, clientY: p.y, pointerId: p.id, buttons: p.buttons, bubbles: true }));
}
$('ov').addEventListener('pointercancel', e => {
    pressPending = null;
    endMainPan(e);
});
window.addEventListener('keyup', e => { if (keyIs('panDrag', e))
    setSpaceHeld(false); });
window.addEventListener('blur', () => setSpaceHeld(false));
/* --------------------------- interaction -------------------------------- */
/* Delete every detection under the brush, not just the nearest, so a drag
   clears a region instead of one dot per gesture.                          */
function eraseAt(x, y, rad) {
    const r2 = rad * rad;
    let n = 0;
    for (let i = S.cells.length - 1; i >= 0; i--) {
        const c = S.cells[i];
        if ((c.x - x) * (c.x - x) + (c.y - y) * (c.y - y) <= r2) {
            logDecision(c, 'rejected_by_hand');
            if (c.source === 'auto') {
                if (!S.removedAutoIds)
                    S.removedAutoIds = new Set();
                S.removedAutoIds.add(c.id);
            }
            S.cells.splice(i, 1);
            S.manualRemoved = (S.manualRemoved || 0) + 1;
            n++;
        }
    }
    const also = removeFromLinkedViews([{ x, y, r: rad }], S.eraseUndo, 'rejected_by_hand');
    if (also.n) {
        S.eraseLinked = S.eraseLinked || new Map();
        also.views.forEach((k, name) => S.eraseLinked.set(name, (S.eraseLinked.get(name) || 0) + k));
    }
    if (n) {
        S.eraseCount = (S.eraseCount || 0) + n;
        drawOverlay();
        updateStats();
        saveResult();
    }
    return n;
}
/* The Add and Remove tools, for the main view and side by side alike. */
function addSomaAt(p) {
    const u = snapshot('added 1 soma'), dMin = +$('dMin').value;
    S.cells.push({ id: Date.now() % 1e6, x: p.x, y: p.y, area: Math.PI * (dMin / 2) ** 2,
        minor: dMin, major: dMin, aspect: 1, width: dMin, z: [NaN], peak: NaN, conf: 1, source: 'manual', flag: false, region: -1 });
    logDecision(S.cells[S.cells.length - 1], 'missed_by_detector');
    assignRegions();
    addToLinkedViews(S.cells[S.cells.length - 1], u);
}
/* Drag to sweep away a run of detections; one step covers the whole drag. */
function startErase(p, rad) {
    S.eraseUndo = snapshot('removed somata');
    S.erasing = true;
    S.eraseCount = 0;
    S.eraseLinked = null;
    eraseAt(p.x, p.y, rad);
}
function endErase() {
    S.erasing = false;
    const n = S.eraseCount || 0, also = { n: 0, views: S.eraseLinked || new Map() };
    also.views.forEach(k => { also.n += k; });
    if (!n && !also.n)
        dropSnapshot(S.eraseUndo);
    else if (also.n && S.eraseUndo) {
        S.eraseUndo.label = 'removed somata from ' + (also.views.size + 1) + ' views';
        updateUndo();
    }
    S.eraseUndo = null;
    S.eraseLinked = null;
    setStatus(n || also.n ? `Removed ${n} soma${n === 1 ? '' : 'ta'}.${linkedNote(also)}` : 'Nothing under the brush.');
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    saveResult();
}
function nearestCell(x, y, maxD) {
    let best = -1, bd = maxD * maxD;
    for (let i = 0; i < S.cells.length; i++) {
        const d = (S.cells[i].x - x) ** 2 + (S.cells[i].y - y) ** 2;
        if (d < bd) {
            bd = d;
            best = i;
        }
    }
    return best;
}
/* Add and Remove tell a click from a drag: a press waits, a move of more than
   a few pixels turns it into a pan, and a release without one is the click
   (add a soma, remove the somata under the brush). The lasso tools keep the
   drag for drawing. */
const CLICK_SLOP = 5;
let pressPending = null;
function clickTool(p) {
    const rad = Math.max(6, +$('dMin').value * 0.8);
    if (S.tool === 'add')
        addSomaAt(p);
    else if (S.tool === 'del') {
        startErase(p, rad);
        endErase();
    }
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    saveResult();
}
$('ov').addEventListener('pointerdown', e => {
    if (!S.image)
        return;
    if (dragPans(e)) {
        startMainPan(e);
        return;
    }
    if (e.button !== 0)
        return;
    const p = canvasPoint(e);
    if (S.tool === 'delRegion') {
        deleteRegionOutlineAt(p);
        return;
    }
    if (S.tool === 'lasso' || S.tool === 'delLasso' || S.tool === 'trim') {
        S.lassoing = true;
        S.poly = [p];
        try {
            $('ov').setPointerCapture(e.pointerId);
        }
        catch (_) { }
        drawOverlay();
        return;
    }
    const ws = $('stageWrap');
    e.preventDefault();
    pressPending = { x: e.clientX, y: e.clientY, left: ws.scrollLeft, top: ws.scrollTop, p };
    try {
        $('ov').setPointerCapture(e.pointerId);
    }
    catch (_) { }
});
$('ov').addEventListener('pointermove', e => {
    if (pressPending && Math.hypot(e.clientX - pressPending.x, e.clientY - pressPending.y) > CLICK_SLOP) {
        /* The press became a drag: pan from where it started. */
        mainPan = { x: pressPending.x, y: pressPending.y, left: pressPending.left, top: pressPending.top };
        pressPending = null;
        $('stageWrap').classList.add('panning');
    }
    if (mainPan) {
        const ws = $('stageWrap');
        ws.scrollLeft = mainPan.left - (e.clientX - mainPan.x);
        ws.scrollTop = mainPan.top - (e.clientY - mainPan.y);
        return;
    }
    if (S.erasing && S.image) {
        const p = canvasPoint(e);
        eraseAt(p.x, p.y, Math.max(6, +$('dMin').value * 0.8));
        S.eraseCursor = p;
        drawOverlay();
        return;
    }
    if (S.tool === 'del' && S.image) {
        S.eraseCursor = canvasPoint(e);
        drawOverlay();
        return;
    }
    if (!S.lassoing || !S.image)
        return;
    const p = canvasPoint(e);
    const last = S.poly[S.poly.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 3) {
        S.poly.push(p);
        drawOverlay();
    }
});
$('ov').addEventListener('pointerup', e => {
    if (pressPending) {
        const p = pressPending.p;
        pressPending = null;
        try {
            $('ov').releasePointerCapture(e.pointerId);
        }
        catch (_) { }
        clickTool(p);
        return;
    }
    if (endMainPan(e))
        return;
    if (S.erasing) {
        try {
            $('ov').releasePointerCapture(e.pointerId);
        }
        catch (_) { }
        endErase();
        return;
    }
    if (!S.lassoing)
        return;
    S.lassoing = false;
    try {
        $('ov').releasePointerCapture(e.pointerId);
    }
    catch (_) { }
    finishRegionLoop();
});
/* Delete outline: a click inside a region (or on its boundary) removes that
   outline; inside one of its holes, fills the hole back in. */
function deleteRegionOutlineAt(p) {
    const hit = findRegionOutlineAt(p.x, p.y);
    if (!hit) {
        setStatus('No region outline there. Click inside a drawn region or directly on its dashed boundary.');
        return;
    }
    const R = S.regions[hit.ri];
    if (!R.polys)
        R.polys = (R.poly && R.poly.length) ? [R.poly] : [];
    const name = R.name || ('Region ' + (hit.ri + 1));
    if (hit.hole != null) {
        /* Filling it back must not lay this region over one drawn inside it. */
        const hole = R.holes[hit.hole];
        const inside = S.regions.find((o, oi) => oi !== hit.ri && regionPolys(o).some(p => p.some(q => pointInPoly(q.x, q.y, hole))));
        if (inside) {
            setStatus(`${inside.name} is drawn inside that hole in ${name}, so it cannot be filled back in. Delete ${inside.name}'s outline there first.`);
            return;
        }
        snapshot(`filled a hole in ${name}`, { regions: true });
        R.holes.splice(hit.hole, 1);
        if (!R.holes.length)
            delete R.holes;
        S.activeRegion = hit.ri;
        if (S.image)
            S.image.regions = S.regions;
        assignRegions();
        renderRegions();
        renderRegionTable();
        drawOverlay();
        updateStats();
        saveResult();
        setStatus(`Filled a hole back into ${name}.`);
        return;
    }
    snapshot(`deleted a ${name} outline`, { regions: true });
    const [gone] = R.polys.splice(hit.pi, 1);
    delete R.poly;
    /* Its holes go with it. */
    if (R.holes) {
        R.holes = R.holes.filter(h => !(h.length && pointInPoly(h[0].x, h[0].y, gone)));
        if (!R.holes.length)
            delete R.holes;
    }
    S.activeRegion = hit.ri;
    if (S.image)
        S.image.regions = S.regions;
    assignRegions();
    renderRegions();
    renderRegionTable();
    drawOverlay();
    updateStats();
    saveResult();
    setStatus(`Deleted one ${name} outline. ${R.polys.length} outline${R.polys.length === 1 ? '' : 's'} remain in that region.`);
}
/* The end of a lasso or cut loop drawn in S.poly. */
function finishRegionLoop() {
    if (S.tool === 'trim') {
        finishTrim(S.poly);
        return;
    }
    if (S.tool === 'delLasso') {
        finishRemoveLasso(S.poly);
        return;
    }
    if (S.poly.length > 4) {
        let i = S.activeRegion;
        if (i < 0 || !S.regions[i])
            i = addRegion();
        const R = S.regions[i];
        /* Regions already drawn keep their ground: the new outline is what the
           loop covers outside them, and it borders them along their own edge. */
        const drawn = densifyClosedPoly(S.poly.map(p => ({ x: p.x, y: p.y })), 2);
        const step = snapshot(`drew ${R.name}`, { regions: true });
        const res = addLassoArea(i, drawn);
        if (!res.added) {
            dropSnapshot(step);
            S.poly = [];
            renderRegions();
            drawOverlay();
            setStatus(`That loop lies entirely inside other regions, so there is nothing to add to ${R.name}.`);
            return;
        }
        if (S.image)
            S.image.regions = S.regions;
        assignRegions();
        const n = S.cells.filter(c => c.region === i).length;
        const k = R.polys.length;
        setStatus(`${R.name}: ${n} somata across ${k} outline${k > 1 ? 's' : ''}.` +
            (res.trimmed ? ' Where it overlapped another region it stops at that region\'s edge.' : '') +
            ` Lasso again to add another side to the same group.`);
    }
    S.poly = [];
    renderRegions();
    renderRegionTable();
    drawOverlay();
    updateStats();
    saveResult();
}
function tool(t) {
    S.tool = t;
    $('stageWrap').dataset.tool = t;
    S.poly = [];
    if (typeof sbsSyncTool === 'function')
        sbsSyncTool();
    [['tAdd', 'add'], ['tDel', 'del'], ['tLasso', 'lasso']]
        .forEach(([id, v]) => $(id).classList.toggle('on', v === t || (id === 'tDel' && t === 'delLasso')));
    /* Remove clicked again is the remove lasso. */
    const del = $('tDel');
    del.classList.toggle('cut', t === 'delLasso');
    del.textContent = t === 'delLasso' ? '− Lasso' : 'Remove';
    del.title = t === 'delLasso'
        ? 'Remove lasso: loop around somata to remove every one inside. One undo restores them. Click again for the brush.'
        : 'Click to remove the somata under the brush; drag to pan. Click Remove again for a remove lasso that takes out every soma inside a loop.';
    if ($('rgnDeleteOutline'))
        $('rgnDeleteOutline').classList.toggle('on', t === 'delRegion');
    $('rgnTrim').classList.toggle('on', t === 'trim');
    // Regions are not edited unseen: a region tool shows them again.
    if ((t === 'lasso' || t === 'trim' || t === 'delRegion') && !S.showRegions)
        showRegions(true);
    if (t === 'lasso' && !S.regions.length) {
        addRegion('SN');
        addRegion('VTA');
        S.activeRegion = 0;
        renderRegions();
        setStatus('Loop around the SN somata, then pick VTA on the right and loop those.');
    }
    drawOverlay();
}
['tAdd', 'tDel', 'tLasso'].forEach((id, i) => {
    $(id).onclick = () => {
        const t = ['add', 'del', 'lasso'][i];
        tool(t === 'del' ? removeToolNext() : t);
    };
});
$('toggleOv').onclick = () => { S.showOv = !S.showOv; $('toggleOv').classList.toggle('on', S.showOv); drawOverlay(); };
function showRegions(on) {
    S.showRegions = on;
    $('toggleRgn').classList.toggle('on', on);
    drawOverlay();
}
$('toggleRgn').onclick = () => showRegions(!S.showRegions);
$('ringSize').addEventListener('input', () => {
    $('ringSizeV').textContent = $('ringSize').value + '%';
    drawOverlay();
});
$('zIn').onclick = () => { if (sbsOpen())
    return sbsZoomAt(null, 1.3, null); S.zoom = clamp(S.zoom * 1.3, S.fit * 0.5, 6); applyZoom(); };
$('zOut').onclick = () => { if (sbsOpen())
    return sbsZoomAt(null, 1 / 1.3, null); S.zoom = clamp(S.zoom / 1.3, S.fit * 0.5, 6); applyZoom(); };
$('displayScale').onchange = () => {
    const v = $('displayScale').value, scale = REVIEW_SCALES.find(s => String(s) === v);
    setPreferredReviewScale(scale || null);
    if (!S.image) {
        syncDisplayResolutionButtons();
        setStatus(`Images will open for review at ${scale ? reviewScaleLabel(scale) : 'full resolution'} · analysis always uses the native pixels.`);
        return;
    }
    switchDisplayResolution(scale ? 'reduced' : 'full', true, scale || S.reviewScale).catch(e => { syncDisplayResolutionButtons(); setStatus(e.message || String(e)); });
};
$('zFit').onclick = () => sbsOpen() ? sbsFit() : fitView();
$('viewMode').onchange = () => {
    S.mergePreview = !!(S.image && S.image.channels.length > 1 && $('viewMode').value === 'color');
    syncChannelButtons();
    renderModeButtons();
    drawBase();
    drawOverlay();
};
$('showAs').onchange = () => { drawBase(); drawOverlay(); };
$('chDetect').onchange = () => {
    /* An explicit analysis-selection change leaves the passive full-merge
       preview; the chosen channel/composite is now what the controls represent. */
    S.mergePreview = false;
    /* Native dropdown changes used to restore the destination immediately and
       could drop unsaved slider/manual state from the view being left. */
    if (S.activeAnalysisValue && S.activeAnalysisValue !== $('chDetect').value)
        saveResult(S.activeAnalysisValue);
    syncChannelButtons();
    renderModeButtons();
    if (densityMode() === 'auto')
        applyDensity(false);
    renderDensityNote();
    describeImage();
    if ($('viewMode').value === 'color')
        $('viewMode').value = 'image';
    const prev = restoreCurrentResult();
    syncColocFloorVisibility();
    drawBase();
    drawOverlay();
    updateStats();
    renderRegions();
    renderRegionTable();
    markDirty(!prev);
    const label = analysisSelectionLabel(S.image, $('chDetect').value);
    setStatus(prev ? `Restored ${prev.cells.length} somata for ${label}` : `${label} selected — analyse to apply.`);
};
window.addEventListener('resize', () => { if (S.image)
    fitView(); });
/* Where a key types: text boxes, number boxes, lists, editable text. A slider,
   tick box or button is not one, so moving a slider does not switch the shortcuts off. */
function typingTarget(t) {
    const tag = t && t.tagName;
    if (tag === 'SELECT' || tag === 'TEXTAREA' || (t && t.isContentEditable))
        return true;
    return tag === 'INPUT' && !/^(?:range|checkbox|radio|button|submit|reset|color|file)$/i.test(t.type || '');
}
window.addEventListener('keydown', e => {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        undo();
        return;
    }
    if (typingTarget(e.target))
        return;
    /* A slider, tick box or button keeps the focus after it is used, but takes no
       letters or numbers, so the shortcuts below still work straight after moving
       one; only its own arrow keys stay with it. */
    if (e.target && e.target.blur && /^(?:INPUT|BUTTON)$/.test(e.target.tagName) && !e.ctrlKey && !e.metaKey && !e.altKey && e.key.length === 1)
        e.target.blur();
    /* The keys below are the ones chosen in Settings (45-settings). */
    const plain = !e.ctrlKey && !e.metaKey && !e.altKey;
    if (plain && keyIs('panDrag', e)) {
        if (S.image) {
            e.preventDefault();
            if (!spaceHeld)
                setSpaceHeld(true);
        }
        return;
    }
    /* The pan keys move the view (Shift for a bigger step), except on a slider or
       option list, whose arrows are its own. */
    const panKey = plain && ['panLeft', 'panRight', 'panUp', 'panDown'].find(a => keyIs(a, e));
    if (panKey) {
        if (!S.image || (e.target && e.target.tagName === 'INPUT'))
            return;
        e.preventDefault();
        const view = sbsOpen() ? $('sbs') : $('stageWrap'), step = Math.min(view.clientWidth, view.clientHeight) * (e.shiftKey ? 0.5 : 0.12);
        panBy(panKey === 'panLeft' ? -step : panKey === 'panRight' ? step : 0, panKey === 'panUp' ? -step : panKey === 'panDown' ? step : 0);
        return;
    }
    /* Zoom in and out. Shift is allowed because + is Shift+= on most keyboards,
       while browser-level Ctrl/Cmd zoom is untouched. */
    if (plain && (keyIs('zoomIn', e) || keyIs('zoomOut', e))) {
        if (S.image) {
            e.preventDefault();
            keyboardZoom(keyIs('zoomIn', e) ? 1.3 : 1 / 1.3);
        }
        return;
    }
    const ci = channelKeyIndex(e);
    if (ci >= 0) {
        if (e.ctrlKey || e.metaKey || e.altKey || !S.image || ci >= S.image.channels.length)
            return;
        e.preventDefault();
        if (e.repeat)
            return;
        heldChannelKeys.add(ci);
        chordChannelKeys.add(ci);
        if (!channelKeyFrame) {
            /* Next frame, or 50 ms, whichever is first: a page in the
               background gets no frames. */
            const timer = setTimeout(applyHeldChannels, 50);
            channelKeyFrame = requestAnimationFrame(() => { clearTimeout(timer); applyHeldChannels(); });
            channelKeyTimer = timer;
        }
        return;
    }
    if (e.key === 'Escape' && document.body.classList.contains('ui-hidden') && !sbsOpen())
        setUiHidden(false);
    else if (!plain)
        return;
    else if (keyIs('hideUi', e))
        setUiHidden(!document.body.classList.contains('ui-hidden'));
    else if (keyIs('add', e))
        tool('add');
    else if (keyIs('remove', e))
        tool(removeToolNext());
    else if (keyIs('lasso', e))
        tool('lasso');
    else if (keyIs('sideBySide', e) && S.image)
        toggleSideBySide();
});
/* ---- Channel keys ----------------------------------------------------------
   1, 2, 3 ... show that channel; keys held together show their merge (1+2,
   1+2+3): a chord is every number key pressed since they were last all up, so
   a quick tap still counts and letting keys go never changes the view. Keys in
   one frame land as one choice, so a chord goes straight to its merge. Clicking with the Add tool while several are held adds the soma to each
   of those channels as well as to the merge on screen. */
const heldChannelKeys = new Set(), chordChannelKeys = new Set();
let channelKeyFrame = 0, channelKeyTimer = 0;
function channelKeyIndex(e) {
    const m = /^(?:Digit|Numpad)([1-9])$/.exec(e.code || '');
    return m ? +m[1] - 1 : -1;
}
function channelKeySet(keys) {
    const n = S.image && S.image.channels ? S.image.channels.length : 0;
    return [...keys].filter(i => i < n).sort((a, b) => a - b);
}
function heldChannelIdx() { return channelKeySet(heldChannelKeys); }
function applyHeldChannels() {
    if (!channelKeyFrame)
        return;
    cancelAnimationFrame(channelKeyFrame);
    clearTimeout(channelKeyTimer);
    channelKeyFrame = 0;
    const idx = channelKeySet(chordChannelKeys);
    if (!heldChannelKeys.size)
        chordChannelKeys.clear();
    if (idx.length)
        setChannelButtonsSelection(idx);
}
window.addEventListener('keyup', e => {
    const ci = channelKeyIndex(e);
    if (ci < 0)
        return;
    heldChannelKeys.delete(ci);
    if (!heldChannelKeys.size && !channelKeyFrame)
        chordChannelKeys.clear();
});
window.addEventListener('blur', () => { heldChannelKeys.clear(); chordChannelKeys.clear(); });
/* The analysis a channel would show if picked now, made the way saveResult()
   makes one for a channel with nothing in it yet but a hand-added soma. */
function emptyChannelResult(sec, value) {
    return { sectionKey: sec.key, sectionName: sec.name, analysisValue: value,
        selection: analysisSelectionLabel(sec, value), modeSignature: analysisModeSignature(sec, value),
        regions: S.regions, cells: [], allCells: null, run: null, removed: 0, autoCount: 0,
        rej: null, seeds: 0, decisions: [], chanOrder: null, colocIdx: [], compUsed: [],
        floorValue: 0, floorMin: 0, floorMax: 1000, floorStep: 1, floorTouched: false, floorAuto: false, autoFloorRef: null,
        colocFloorValue: 0, colocFloorTouched: false, colocFloorAuto: false, autoColocFloorRef: null,
        removedAutoIds: [], zLayers: Array.isArray(sec.zLayers) ? sec.zLayers.slice() : null, zAlign: !!sec.zAlign,
        w: sec.channels[0].w, h: sec.channels[0].h };
}
/* The other views an edit here also goes into: each channel of the merge on
   screen and each smaller merge inside it (a triple's pairs), and the channels
   whose number keys are held. */
function linkedViewValues() {
    const current = $('chDetect').value, held = heldChannelIdx(), targets = new Set();
    if (held.length >= 2)
        held.forEach(i => targets.add('c' + i));
    const idx = mergeConstituentIndices(current).sort((a, b) => a - b);
    for (let mask = 1; mask < (1 << idx.length) - 1; mask++) {
        const sub = idx.filter((_, k) => mask & (1 << k));
        targets.add(sub.length === 1 ? 'c' + sub[0] : 'm' + sub.join('-'));
    }
    targets.delete(current);
    return [...targets];
}
/* How close a soma in another view has to be to count as the same one. */
const linkedReach = () => Math.max(4, (+$('dMin').value || 10) * 0.6);
/* A soma added by hand also goes into the linked views. A channel that
   already has a soma there does not get a second. */
function addToLinkedViews(cell, u) {
    const sec = S.image;
    if (!sec)
        return;
    const near = linkedReach(), names = [], already = [];
    for (const value of linkedViewValues()) {
        const key = analysisKey(sec, value), res = S.results.get(key) || emptyChannelResult(sec, value), name = analysisSelectionLabel(sec, value);
        if ((res.cells || []).some(c => Math.hypot(c.x - cell.x, c.y - cell.y) < near)) {
            already.push(name);
            continue;
        }
        snapshotAlso(u, value);
        S.results.set(key, Object.assign({}, res, { cells: (res.cells || []).concat([cloneCellSnapshot(cell)]) }));
        names.push(name);
    }
    if (u && names.length) {
        u.label = 'added 1 soma to ' + (names.length + 1) + ' views';
        updateUndo();
    }
    if (names.length || already.length)
        setStatus(`Added a soma here${names.length ? ` and to ${names.join(', ')}` : ''}.${already.length ? ` ${already.join(', ')} already had one there.` : ''}`);
    if (sec.analysisSummaryReady)
        renderSectionAnalysisSummary(sec);
}
/* Removing works the same way: what is taken away here is taken away from the
   linked views too, wherever one of their somata lies inside a spot ({x, y, r}).
   Returns how many went from each view, by name. */
function removeFromLinkedViews(spots, u, verdict) {
    const sec = S.image, out = { n: 0, views: new Map() };
    if (!sec || !spots.length)
        return out;
    for (const value of linkedViewValues()) {
        const key = analysisKey(sec, value), res = S.results.get(key);
        const gone = res ? (res.cells || []).filter(c => spots.some(s => s.poly ? pointInPoly(c.x, c.y, s.poly) : (c.x - s.x) ** 2 + (c.y - s.y) ** 2 <= s.r * s.r)) : [];
        if (!gone.length)
            continue;
        snapshotAlso(u, value);
        const name = analysisSelectionLabel(sec, value), ch = sec.channels[+value.slice(1)], drop = new Set(gone), decisions = (res.decisions || []).slice();
        gone.forEach(c => logDecision(c, verdict, decisions, ch ? ch.name : name));
        const autoIds = gone.filter(c => c.source === 'auto').map(c => c.id);
        S.results.set(key, Object.assign({}, res, { cells: res.cells.filter(c => !drop.has(c)), decisions,
            removed: (res.removed || 0) + gone.length, removedAutoIds: [...new Set([...(res.removedAutoIds || []), ...autoIds])] }));
        out.views.set(name, gone.length);
        out.n += gone.length;
    }
    if (out.n && sec.analysisSummaryReady)
        renderSectionAnalysisSummary(sec);
    return out;
}
/* ---- Copy counts ------------------------------------------------------------
   The somata counted in the view on screen, copied into another channel or
   merge of the same image: where they are and how big, not this view's
   brightness measures, which do not belong to the other channel. They arrive
   as added by hand (blue), each noting where it came from (so does the cells
   export). Add keeps what the other view counted and skips somata it already
   has; Replace sets its own analysis aside (Analyse there, or undo, brings it
   back). One undo step covers it. */
function copyTargets() {
    const current = $('chDetect').value;
    return [...$('chDetect').options].map(o => o.value).filter(v => v !== current && /^c\d+$|^m\d+(?:-\d+)+$/.test(v));
}
function copiedCell(c, k, from) {
    return { id: (Date.now() % 1e6) * 1e4 + k, x: c.x, y: c.y, area: c.area, minor: c.minor, major: c.major, aspect: c.aspect, width: c.width,
        z: [NaN], peak: NaN, conf: 1, source: 'manual', copiedFrom: from, flag: false, region: regionIndexAt(S.regions, c.x, c.y) };
}
function copyCountsTo(value, replace) {
    const sec = S.image;
    if (!sec || !S.cells.length || S.busy)
        return;
    const from = analysisSelectionLabel(sec, $('chDetect').value), to = analysisSelectionLabel(sec, value);
    const u = snapshot(`copied ${S.cells.length} somata to ${to}`);
    snapshotAlso(u, value);
    const key = analysisKey(sec, value), had = S.results.get(key);
    const base = replace || !had ? emptyChannelResult(sec, value) : had, kept = (base.cells || []).slice(), near = linkedReach();
    let added = 0, skipped = 0;
    for (const c of S.cells) {
        if (kept.some(k => Math.abs(k.x - c.x) < near && Math.abs(k.y - c.y) < near && Math.hypot(k.x - c.x, k.y - c.y) < near)) {
            skipped++;
            continue;
        }
        kept.push(copiedCell(c, added, from));
        added++;
    }
    if (!added && !(replace && had)) {
        dropSnapshot(u);
        setStatus(`${to} already has a soma at every one of the ${S.cells.length} here; nothing copied.`);
        return;
    }
    S.results.set(key, Object.assign({}, base, { cells: kept }));
    const was = had ? (had.cells || []).length : 0;
    setStatus(`Copied ${added} somata from ${from} to ${to}${skipped ? ` (${skipped} already there)` : ''}${replace && had ? `, in place of the ${was} it had` : ''}. ${to} now counts ${kept.length}; undo takes it back.`);
    if (sec.analysisSummaryReady)
        renderSectionAnalysisSummary(sec);
    renderFileList();
}
function openCopyCountsMenu(button) {
    closeColourMenu();
    const sec = S.image, targets = copyTargets();
    if (!sec || !S.cells.length || !targets.length)
        return;
    const menu = document.createElement('div');
    menu.className = 'merge-role-menu copy-counts-menu';
    const head = document.createElement('div');
    head.className = 'copy-head';
    head.textContent = `Copy the ${S.cells.length} somata counted in ${analysisSelectionLabel(sec, $('chDetect').value)} to`;
    menu.appendChild(head);
    for (const value of targets) {
        const r = S.results.get(analysisKey(sec, value)), n = r ? (r.cells || []).length : 0;
        const row = document.createElement('div');
        row.className = 'copy-row';
        row.innerHTML = `<span class="nm"></span><span class="ct">${n ? n + ' counted' : 'none counted'}</span>`;
        row.querySelector('.nm').textContent = analysisSelectionLabel(sec, value);
        const act = (text, title, replace) => {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = text;
            b.title = title;
            b.onclick = e => { e.stopPropagation(); closeColourMenu(); copyCountsTo(value, replace); };
            row.appendChild(b);
        };
        if (n) {
            act('Add', `Add them to the ${n} counted there, skipping somata it already has`, false);
            act('Replace', `Use these instead of the ${n} counted there (undo brings them back)`, true);
        }
        else
            act('Copy', 'Copy them there', false);
        menu.appendChild(row);
    }
    mountColourMenu(button, menu);
}
function linkedNote(also) {
    if (!also || !also.n)
        return '';
    return ' Also from ' + [...also.views].map(([name, k]) => `${name} (${k})`).join(', ') + '.';
}
/* ---- Remove lasso --------------------------------------------------------
   Remove clicked again: a loop removes every soma inside it, here and the same
   somata in the linked views, as one undo step. */
function removeToolNext() {
    if (S.tool !== 'del')
        return 'del';
    setStatus('Remove lasso: loop around somata to remove every one inside. Click Remove again for the brush.');
    return 'delLasso';
}
function finishRemoveLasso(loop) {
    S.poly = [];
    if (!loop || loop.length <= 4) {
        drawOverlay();
        return;
    }
    const poly = loop.map(p => ({ x: p.x, y: p.y }));
    const step = snapshot('removed somata');
    let n = 0;
    for (let i = S.cells.length - 1; i >= 0; i--) {
        const c = S.cells[i];
        if (!pointInPoly(c.x, c.y, poly))
            continue;
        logDecision(c, 'rejected_by_hand');
        if (c.source === 'auto') {
            if (!S.removedAutoIds)
                S.removedAutoIds = new Set();
            S.removedAutoIds.add(c.id);
        }
        S.cells.splice(i, 1);
        S.manualRemoved = (S.manualRemoved || 0) + 1;
        n++;
    }
    const also = removeFromLinkedViews([{ poly }], step, 'rejected_by_hand');
    if (!n && !also.n) {
        dropSnapshot(step);
        drawOverlay();
        setStatus('No somata inside that loop.');
        return;
    }
    if (also.n && step) {
        step.label = 'removed somata from ' + (also.views.size + 1) + ' views';
        updateUndo();
    }
    setStatus(`Removed ${n} soma${n === 1 ? '' : 'ta'} inside the loop.${linkedNote(also)} Undo puts them back.`);
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    saveResult();
}
/* ---- Trim region ------------------------------------------------------------
   The Trim region button in the Regions card: a loop cuts that area out of the
   drawn regions. A loop across an edge trims it, one right through splits it,
   one inside leaves a hole. */
function finishTrim(loop) {
    S.poly = [];
    if (!loop || loop.length <= 4) {
        drawOverlay();
        return;
    }
    const cut = densifyClosedPoly(loop.map(p => ({ x: p.x, y: p.y })), 2);
    const step = snapshot('trimmed', { regions: true });
    const changed = cutRegions(cut);
    if (!changed.length) {
        dropSnapshot(step);
        drawOverlay();
        setStatus('That loop does not cross any drawn region, so nothing was trimmed.');
        return;
    }
    step.label = 'trimmed ' + changed.join(', ');
    updateUndo();
    if (S.image)
        S.image.regions = S.regions;
    assignRegions();
    renderRegions();
    renderRegionTable();
    drawOverlay();
    updateStats();
    saveResult();
    const counts = changed.map(name => {
        const i = S.regions.findIndex(r => r.name === name);
        return `${name} ${S.cells.filter(c => c.region === i).length}`;
    });
    setStatus(`Trimmed ${changed.join(' and ')}: now ${counts.join(', ')} somata. Undo puts it back.`);
}
/* ------------------------- side by side --------------------------------- */
/* Every channel and every merge of the open image at once, in a grid of
   panels that share one position and one zoom, for judging colocalisation by
   eye. Each panel is drawn exactly as the main view would draw that channel or
   merge (same colours, normalisation and background), from a bitmap made once
   per view, so panning and zooming only copy the visible part. Dragging or
   scrolling any panel moves them all; Ctrl/pinch or + / - zooms; a cross marks
   the pointer's place in every panel; each panel shows the somata counted in
   that view when it has been analysed and Markers is on. P or the button
   toggles it; Esc closes, and the main viewer takes the same place and zoom. A panel's x hides it; the bar at the bottom puts
   hidden ones back. With Add or Remove chosen, a click in a panel adds or
   removes a soma in that panel's view, exactly as in the main view (it becomes
   the selected view), so undo and a merge's channels work the same. The
   region tools draw, cut and delete outlines in any panel; regions belong to
   the image, so every panel shows them. */
const SBS = { open: false, cx: 0, cy: 0, zoom: 1, fit: 1, views: [], sec: null, keys: '', hover: null, drag: null, press: null, lasso: null, frame: 0, building: 0, hidden: new Set() };
function sbsOpen() { return SBS.open; }
function sbsCandidates(n) {
    /* Singles, pairs and the triple, as the number keys reach them; with more
       than four channels the singles alone. */
    return n <= 4 ? prewarmCandidates(n) : Array.from({ length: n }, (_, i) => [i]);
}
function sbsValue(idx) { return idx.length === 1 ? 'c' + idx[0] : 'm' + idx.join('-'); }
function sbsNative() { const c = S.image && S.image.channels && S.image.channels[0]; return c && c.w > 0 && c.h > 0 ? c : null; }
function sbsLayout() {
    const box = $('sbs'), n = SBS.views.length, nat = sbsNative();
    if (!n || !nat)
        return;
    const bar = box.querySelector('.sbs-restore'), W = box.clientWidth - 8, H = box.clientHeight - 8 - (bar ? bar.offsetHeight + 4 : 0), aspect = nat.w / nat.h;
    let best = 1, bestScore = -1;
    for (let cols = 1; cols <= n; cols++) {
        const rows = Math.ceil(n / cols), pw = W / cols - 4, ph = H / rows - 4, score = Math.min(pw, ph * aspect);
        if (score > bestScore) {
            bestScore = score;
            best = cols;
        }
    }
    box.style.gridTemplateColumns = `repeat(${best}, minmax(0, 1fr))`;
    box.style.gridTemplateRows = `repeat(${Math.ceil(n / best)}, minmax(0, 1fr))` + (bar ? ' auto' : '');
    const pw = W / best - 4, ph = H / Math.ceil(n / best) - 4;
    SBS.fit = Math.max(1e-4, Math.min(pw / nat.w, ph / nat.h) * 0.98);
}
function sbsClampView() {
    const nat = sbsNative();
    if (!nat)
        return;
    /* A centre that is not a number would draw every panel black. */
    if (!Number.isFinite(SBS.cx) || !Number.isFinite(SBS.cy)) {
        SBS.cx = nat.w / 2;
        SBS.cy = nat.h / 2;
    }
    if (!Number.isFinite(SBS.zoom))
        SBS.zoom = SBS.fit;
    SBS.zoom = clamp(SBS.zoom, SBS.fit * 0.5, 6);
    SBS.cx = clamp(SBS.cx, 0, nat.w);
    SBS.cy = clamp(SBS.cy, 0, nat.h);
}
async function sbsBuild() {
    const sec = S.image, nat = sbsNative();
    const box = $('sbs');
    if (!sec || !nat) {
        closeSideBySide();
        return;
    }
    const build = ++SBS.building;
    const all = sbsCandidates(sec.channels.length);
    const specs = all.filter(idx => !SBS.hidden.has(sbsValue(idx))).map(idx => ({ idx, v: baseViewSpec('image', idx) })).filter(s => s.v);
    const keys = specs.map(s => s.v.key).join('#') + '|' + [...SBS.hidden].join(',');
    if (SBS.sec === sec && SBS.keys === keys && SBS.views.length) {
        sbsDraw();
        return;
    }
    const views = [];
    for (const { idx, v } of specs) {
        let img = v.key ? cachedView(v.sec, v.key) : null;
        if (!img) {
            img = renderBaseView(v);
            if (v.key)
                rememberView(v.sec, v.key, img);
        }
        const bmp = await createImageBitmap(img);
        if (build !== SBS.building || !SBS.open) {
            bmp.close();
            views.forEach(x => x.bmp.close());
            return;
        }
        views.push({ idx, value: sbsValue(idx), bmp, sx: v.c.w / nat.w, sy: v.c.h / nat.h, light: !!v.flip,
            colours: v.merged ? v.colours : [singleLutHex(sec, idx[0])] });
    }
    const otherImage = !!SBS.sec && SBS.sec !== sec;
    SBS.views.forEach(x => x.bmp.close());
    SBS.views = views;
    SBS.sec = sec;
    SBS.keys = keys;
    box.innerHTML = '';
    for (const view of views) {
        const p = document.createElement('div');
        p.className = 'sbs-panel';
        const cv = document.createElement('canvas'), lab = document.createElement('div'), x = document.createElement('button');
        lab.className = 'sbs-label';
        x.type = 'button';
        x.className = 'sbs-close';
        x.textContent = '×';
        x.title = 'Hide this panel (the bar below brings it back)';
        x.setAttribute('aria-label', 'Hide ' + analysisSelectionLabel(sec, view.value));
        x.onclick = e => { e.stopPropagation(); SBS.hidden.add(view.value); sbsBuild(); };
        p.append(cv, lab, x);
        box.append(p);
        view.panel = p;
        view.canvas = cv;
        view.label = lab;
        sbsWirePanel(view);
    }
    /* The panels hidden, as buttons that bring each back. */
    const gone = all.filter(idx => SBS.hidden.has(sbsValue(idx)));
    if (gone.length) {
        const bar = document.createElement('div');
        bar.className = 'sbs-restore';
        const lead = document.createElement('span');
        lead.textContent = views.length ? 'Hidden:' : 'Every panel is hidden:';
        bar.append(lead);
        for (const idx of gone) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = '+ ' + analysisSelectionLabel(sec, sbsValue(idx));
            b.title = 'Show this panel again';
            b.onclick = () => { SBS.hidden.delete(sbsValue(idx)); sbsBuild(); };
            bar.append(b);
        }
        if (gone.length > 1) {
            const b = document.createElement('button');
            b.type = 'button';
            b.textContent = 'Show all';
            b.onclick = () => { SBS.hidden.clear(); sbsBuild(); };
            bar.append(b);
        }
        box.append(bar);
    }
    sbsLayout();
    if (otherImage) {
        SBS.zoom = SBS.fit;
        SBS.cx = nat.w / 2;
        SBS.cy = nat.h / 2;
    }
    sbsDraw();
}
function sbsCells(view) {
    const r = sectionResultForValue(S.image, view.value);
    return r && Array.isArray(r.cells) && (r.run || r.cells.length) ? r.cells : null;
}
function sbsLabel(view) {
    const sec = S.image, cells = sbsCells(view);
    view.label.innerHTML = '';
    view.idx.forEach((i, k) => {
        const dot = document.createElement('i');
        dot.style.background = view.colours[k] || '#ffffff';
        view.label.append(dot);
    });
    const name = document.createElement('span');
    name.textContent = analysisSelectionLabel(sec, view.value) + (cells ? ` · ${cells.length} counted` : '');
    view.label.append(name);
}
function sbsDraw() {
    if (SBS.frame)
        return;
    /* Next frame, or 50 ms, whichever is first: a page in the background
       gets no frames. */
    let timer = 0;
    const run = () => {
        cancelAnimationFrame(SBS.frame);
        clearTimeout(timer);
        SBS.frame = 0;
        sbsPaint();
    };
    SBS.frame = requestAnimationFrame(run);
    timer = setTimeout(run, 50);
}
function sbsPaint() {
    {
        if (!SBS.open || !SBS.views.length)
            return;
        sbsClampView();
        updateZoomReadout();
        const dpr = window.devicePixelRatio || 1, dMin = +$('dMin').value || 10;
        const ring = (+$('ringSize').value || 100) / 100;
        for (const view of SBS.views) {
            const cv = view.canvas, W = cv.clientWidth, H = cv.clientHeight;
            if (!(W > 0 && H > 0))
                continue;
            if (cv.width !== Math.round(W * dpr) || cv.height !== Math.round(H * dpr)) {
                cv.width = Math.round(W * dpr);
                cv.height = Math.round(H * dpr);
            }
            const g = cv.getContext('2d');
            g.setTransform(1, 0, 0, 1, 0, 0);
            g.fillStyle = view.light ? '#ffffff' : '#05070a';
            g.fillRect(0, 0, cv.width, cv.height);
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            /* Visible part of the image in native pixels, clipped to the image. */
            const nat = sbsNative(), z = SBS.zoom;
            const x0 = SBS.cx - W / 2 / z, y0 = SBS.cy - H / 2 / z;
            const ax = Math.max(0, x0), ay = Math.max(0, y0), bx = Math.min(nat.w, x0 + W / z), by = Math.min(nat.h, y0 + H / z);
            if (bx > ax && by > ay) {
                g.imageSmoothingEnabled = z * dpr / view.sx < 2;
                g.drawImage(view.bmp, ax * view.sx, ay * view.sy, (bx - ax) * view.sx, (by - ay) * view.sy,
                    (ax - x0) * z, (ay - y0) * z, (bx - ax) * z, (by - ay) * z);
            }
            /* Regions belong to the image, so every panel shows them, and the
               loop being drawn in any one of them. */
            g.setTransform(dpr * z, 0, 0, dpr * z, -x0 * z * dpr, -y0 * z * dpr);
            drawRegionsAndLoop(g, z, view.light);
            g.setTransform(dpr, 0, 0, dpr, 0, 0);
            const cells = S.showOv ? sbsCells(view) : null;
            if (cells) {
                /* Rings as in the main view: the soma's own size times Ring
                   size, teal when detected, blue when added by hand. */
                g.lineWidth = Math.max(1, Math.min(2.5, dMin * z * ring / 8));
                for (const [manual, col] of [[false, view.light ? '#319f84' : '#5ad3b0'], [true, view.light ? '#477fc8' : '#6fa8f5']]) {
                    g.strokeStyle = col;
                    g.beginPath();
                    for (const c of cells) {
                        if ((c.source === 'manual') !== manual)
                            continue;
                        const r = Math.max(2.5, Math.max(3, Math.sqrt((c.area || Math.PI * dMin * dMin / 4) / Math.PI)) * z * ring);
                        const px = (c.x - x0) * z, py = (c.y - y0) * z;
                        if (px < -r || py < -r || px > W + r || py > H + r)
                            continue;
                        g.moveTo(px + r, py);
                        g.arc(px, py, r, 0, Math.PI * 2);
                    }
                    g.stroke();
                }
            }
            if (SBS.hover) {
                /* The panel under the pointer gets the real cross, larger and in
                   its own colour; the copies in the other panels stay smaller, so
                   the real one is never lost among them (colours and size in
                   Settings). */
                drawSbsCross(g, (SBS.hover.x - x0) * z, (SBS.hover.y - y0) * z, view === (S.zoomCursor && S.zoomCursor.sbs));
            }
            sbsLabel(view);
        }
    }
}
function sbsFit() {
    const nat = sbsNative();
    if (!nat)
        return;
    SBS.zoom = SBS.fit;
    SBS.cx = nat.w / 2;
    SBS.cy = nat.h / 2;
    sbsDraw();
}
function sbsPoint(view, e) {
    const r = view.canvas.getBoundingClientRect(), z = SBS.zoom;
    return { x: SBS.cx + (e.clientX - r.left - r.width / 2) / z, y: SBS.cy + (e.clientY - r.top - r.height / 2) / z };
}
function sbsZoomAt(view, factor, e) {
    const before = view && e && Number.isFinite(e.clientX) && Number.isFinite(e.clientY) ? sbsPoint(view, e) : null;
    SBS.zoom = clamp(SBS.zoom * factor, SBS.fit * 0.5, 6);
    if (before) {
        /* Keep the image point under the pointer where it is. */
        const after = sbsPoint(view, e);
        SBS.cx += before.x - after.x;
        SBS.cy += before.y - after.y;
    }
    sbsDraw();
}
/* Makes a panel's view the selected one, so an edit there goes through the
   main view's own code: its undo step, its decision log, a merge's channels. */
function sbsSelectView(view) {
    if ($('chDetect').value !== view.value)
        setChannelButtonsSelection(view.idx);
    return $('chDetect').value === view.value;
}
function sbsAfterEdit() {
    refreshQueue();
    drawOverlay();
    updateStats();
    renderRegionTable();
    saveResult();
    sbsDraw();
}
function sbsWirePanel(view) {
    const cv = view.canvas;
    cv.addEventListener('mousedown', e => { if (e.button === 1)
        e.preventDefault(); });
    cv.addEventListener('contextmenu', e => { if (somaSettings.pan.dragButton === 2)
        e.preventDefault(); });
    cv.addEventListener('pointerdown', e => {
        /* The drag binding (Space + left drag unless changed) pans whatever the
           tool; nothing else drags the view. */
        const pan = dragPans(e);
        if (e.button !== 0 && !pan)
            return;
        if (pan)
            e.preventDefault();

        if (!pan && (S.tool === 'lasso' || S.tool === 'delLasso' || S.tool === 'trim' || S.tool === 'delRegion') && S.image && !S.busy) {
            e.preventDefault();
            const p = sbsPoint(view, e);
            if (S.tool === 'delRegion') {
                deleteRegionOutlineAt(p);
                sbsDraw();
                return;
            }
            SBS.lasso = view;
            S.lassoing = true;
            S.poly = [p];
            try {
                cv.setPointerCapture(e.pointerId);
            }
            catch (_) { }
            sbsDraw();
            return;
        }
        /* Add and Remove: a press waits; a drag pans, a click acts. */
        if (!pan) {
            e.preventDefault();
            SBS.press = { view, x: e.clientX, y: e.clientY, cx: SBS.cx, cy: SBS.cy };
            try {
                cv.setPointerCapture(e.pointerId);
            }
            catch (_) { }
            return;
        }
        SBS.drag = { x: e.clientX, y: e.clientY, cx: SBS.cx, cy: SBS.cy };
        try {
            cv.setPointerCapture(e.pointerId);
        }
        catch (_) { }
        view.panel.classList.add('dragging');
    });
    cv.addEventListener('pointermove', e => {
        const pr = SBS.press;
        if (pr && pr.view === view && Math.hypot(e.clientX - pr.x, e.clientY - pr.y) > CLICK_SLOP) {
            SBS.drag = { x: pr.x, y: pr.y, cx: pr.cx, cy: pr.cy };
            SBS.press = null;
            view.panel.classList.add('dragging');
        }
        if (SBS.erase === view && S.erasing) {
            const p = sbsPoint(view, e);
            eraseAt(p.x, p.y, Math.max(6, +$('dMin').value * 0.8));
            SBS.hover = p;
            sbsDraw();
            return;
        }
        if (SBS.lasso === view && S.lassoing) {
            const p = sbsPoint(view, e), last = S.poly[S.poly.length - 1];
            SBS.hover = p;
            if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 3 / Math.max(SBS.zoom, 1e-6))
                S.poly.push(p);
            sbsDraw();
            return;
        }
        if (SBS.drag) {
            SBS.cx = SBS.drag.cx - (e.clientX - SBS.drag.x) / SBS.zoom;
            SBS.cy = SBS.drag.cy - (e.clientY - SBS.drag.y) / SBS.zoom;
        }
        SBS.hover = sbsPoint(view, e);
        S.zoomCursor = { x: e.clientX, y: e.clientY, sbs: view };
        sbsDraw();
    });
    const end = e => {
        const pr = SBS.press;
        if (pr && pr.view === view) {
            SBS.press = null;
            if (e.type === 'pointerup' && (S.tool === 'add' || S.tool === 'del') && S.image && !S.busy && sbsSelectView(view)) {
                const p = sbsPoint(view, e);
                if (S.tool === 'add')
                    addSomaAt(p);
                else {
                    startErase(p, Math.max(6, +$('dMin').value * 0.8));
                    endErase();
                }
                sbsAfterEdit();
            }
            return;
        }
        if (SBS.erase === view && S.erasing) {
            SBS.erase = null;
            endErase();
            sbsDraw();
        }
        if (SBS.lasso === view && S.lassoing) {
            SBS.lasso = null;
            S.lassoing = false;
            finishRegionLoop();
            sbsDraw();
        }
        SBS.drag = null;
        view.panel.classList.remove('dragging');
    };
    cv.addEventListener('pointerup', end);
    cv.addEventListener('pointercancel', end);
    cv.addEventListener('pointerleave', () => {
        if (!SBS.drag) {
            SBS.hover = null;
            S.zoomCursor = null;
            sbsDraw();
        }
    });
    cv.addEventListener('wheel', e => {
        e.preventDefault();
        if (e.ctrlKey || e.metaKey) {
            if (!pinchGesture)
                sbsZoomAt(view, wheelZoomFactor(e, cv.clientHeight), e);
        }
        else {
            const k = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? cv.clientHeight : 1;
            SBS.cx += e.deltaX * k / SBS.zoom;
            SBS.cy += e.deltaY * k / SBS.zoom;
            SBS.hover = sbsPoint(view, e);
            sbsDraw();
        }
    }, { passive: false });
}
/* The pointer shows what a click in a panel will do. */
function sbsSyncTool() { $('sbs').dataset.tool = ['add', 'del', 'lasso', 'delLasso', 'trim', 'delRegion'].includes(S.tool) ? S.tool : 'pan'; }
function openSideBySide() {
    if (SBS.open || !S.image || !sbsNative())
        return;
    const nat = sbsNative(), ws = $('stageWrap'), ov = $('ov');
    /* Start where the main view is: its centre, and its magnification unless it
       was showing the whole image, in which case every panel shows it whole. */
    const r = ov.getBoundingClientRect(), wr = ws.getBoundingClientRect();
    const wasFit = !(S.zoom > (S.fit || 0) * 1.05);
    SBS.cx = r.width > 0 ? (wr.left + wr.width / 2 - r.left) * nat.w / r.width : nat.w / 2;
    SBS.cy = r.height > 0 ? (wr.top + wr.height / 2 - r.top) * nat.h / r.height : nat.h / 2;
    SBS.open = true;
    sbsSyncTool();
    $('sbs').hidden = false;
    $('stageWrap').classList.add('sbs-hidden');
    $('sideBySide').classList.add('on');
    sbsBuild().then(() => {
        if (!SBS.open)
            return;
        sbsLayout();
        SBS.zoom = wasFit ? SBS.fit : S.zoom;
        if (wasFit) {
            SBS.cx = nat.w / 2;
            SBS.cy = nat.h / 2;
        }
        sbsDraw();
    }).catch(err => { closeSideBySide(); setStatus('Side by side failed: ' + (err && err.message || err)); });
}
function closeSideBySide() {
    if (!SBS.open)
        return;
    SBS.open = false;
    SBS.building++;
    $('sbs').hidden = true;
    $('stageWrap').classList.remove('sbs-hidden');
    $('sideBySide').classList.remove('on');
    const nat = sbsNative(), zoom = SBS.zoom, cx = SBS.cx, cy = SBS.cy, fitted = SBS.zoom <= SBS.fit * 1.02;
    SBS.views.forEach(v => v.bmp.close());
    SBS.views = [];
    SBS.sec = null;
    SBS.keys = '';
    SBS.hover = null;
    $('sbs').innerHTML = '';
    /* The main view takes over the same place and magnification. */
    if (S.image && nat) {
        if (fitted)
            fitView();
        else {
            S.zoom = clamp(zoom, (S.fit || zoom) * 0.5, 6);
            applyZoom();
            centreOn({ x: cx, y: cy });
        }
    }
}
function toggleSideBySide() {
    if (SBS.open)
        closeSideBySide();
    else
        openSideBySide();
}
/* Called after the main view redraws: a new image, changed colours or display
   resolution rebuild the panels; new counts only redraw them. */
function sbsAfterBase() {
    if (SBS.open)
        sbsBuild().catch(() => { });
}
function sbsAfterOverlay() {
    if (SBS.open)
        sbsDraw();
}
$('sideBySide').onclick = toggleSideBySide;
window.addEventListener('keydown', e => {
    if (SBS.open && e.key === 'Escape' && !typingTarget(e.target)) {
        e.preventDefault();
        closeSideBySide();
    }
});
if (window.ResizeObserver)
    new ResizeObserver(() => { if (SBS.open) {
        sbsLayout();
        sbsDraw();
    } }).observe($('sbs'));
/* ---------------------------- exports ----------------------------------- */
function dl(blob, name) {
    S.lastExport = { at: Date.now(), name };
    const u = URL.createObjectURL(blob), a = document.createElement('a');
    a.href = u;
    a.download = name;
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(u), 2000);
}
function csvEscape(s) { return /[",\n]/.test(s) ? '"' + String(s).replace(/"/g, '""') + '"' : s; }
function baseName() { return (S.image ? S.image.name : 'section').replace(/[^\w.-]+/g, '_'); }
function cellsCsv() {
    const px = +$('pxSize').value, k = colocIndex();
    const chNames = S.chanOrder ? S.chanOrder.map(i => S.image.channels[i].name) : ['ch0'];
    const head = ['section', 'cell_id', 'x_px', 'y_px', 'x_um', 'y_um', 'area_px2', 'area_um2',
        'width_px', 'short_axis_px', 'long_axis_px', 'aspect', 'region', 'hemisphere', 'confidence', 'source', 'flagged',
        ...chNames.map(n => 'z_' + n.replace(/\W+/g, '_'))];
    if (k >= 0)
        head.push('coloc_balance', 'white_overlap_fraction', 'cell_whiteness_score', 'coloc_positive');
    const rows = [head.join(',')];
    const midX = S.image.channels[0].w / 2;
    for (const c of S.cells) {
        const r = [csvEscape(S.image.name), c.id, c.x.toFixed(2), c.y.toFixed(2),
            px ? (c.x * px).toFixed(2) : '', px ? (c.y * px).toFixed(2) : '',
            c.area.toFixed(0), px ? (c.area * px * px).toFixed(1) : '',
            (c.width || 0).toFixed(2), c.minor.toFixed(2), c.major.toFixed(2), c.aspect.toFixed(3),
            csvEscape(c.region >= 0 ? S.regions[c.region].name : ''),
            c.x < midX ? 'left' : 'right',
            c.conf.toFixed(3), c.copiedFrom ? 'copied from ' + c.copiedFrom : c.source, c.flag ? '1' : '0',
            ...(c.z || []).map(v => isFinite(v) ? v.toFixed(3) : '')];
        if (k >= 0) {
            const v = colocValue(c), f = colocFill(c), ws = cellWhiteScore(c);
            r.push(v != null && isFinite(v) ? v.toFixed(3) : '', f != null ? f.toFixed(3) : '', ws != null ? ws.toFixed(3) : '', isColoc(c) ? '1' : '0');
        }
        rows.push(r.join(','));
    }
    return rows.join('\n');
}
function summaryCsv() {
    const k = colocIndex();
    const head = ['section', 'region', 'hemisphere', 'n_somata', 'n_manual', 'n_flagged'];
    if (k >= 0)
        head.push('n_double_positive');
    /* Section-level totals belong to the section, not to a region row, so they are
       written once per section instead of being repeated on every line.        */
    head.push('section_auto_detected', 'section_removed_by_hand');
    const rows = [head.join(',')];
    for (const [key, res] of S.results) {
        let firstRow = true;
        const regions = res.regions.map((r, i) => ({ name: r.name, idx: i })).concat([{ name: '(unassigned)', idx: -1 }]);
        for (const g of regions) {
            const midX = (res.w || S.image.channels[0].w) / 2;
            for (const hemi of ['left', 'right']) {
                const cs = res.cells.filter(c => c.region === g.idx && ((c.x < midX) === (hemi === 'left')));
                if (!cs.length)
                    continue;
                const r = [csvEscape(key), csvEscape(g.name), hemi, cs.length,
                    cs.filter(c => c.source === 'manual').length, cs.filter(c => c.flag).length];
                if (k >= 0)
                    r.push(cs.filter(isColoc).length);
                r.push(firstRow ? (res.autoCount || '') : '', firstRow ? (res.removed || 0) : '');
                firstRow = false;
                rows.push(r.join(','));
            }
        }
    }
    return rows.join('\n');
}
async function checksum(file) {
    try {
        const b = await file.arrayBuffer();
        const h = await crypto.subtle.digest('SHA-256', b.slice(0, Math.min(b.byteLength, 4e6)));
        return [...new Uint8Array(h)].slice(0, 8).map(x => x.toString(16).padStart(2, '0')).join('');
    }
    catch (_) {
        return null;
    }
}
async function runJson() {
    const p = params();
    const px = +$('pxSize').value;
    const sums = {};
    for (const f of S.image.files)
        sums[f.name] = await checksum(f);
    return JSON.stringify({
        tool: 'soma-quantification', version: '1.0.0',
        generated: new Date().toISOString(),
        section: S.image.name,
        source_files: S.image.files.map(f => ({ name: f.name, bytes: f.size, sha256_prefix: sums[f.name] })),
        pixel_size_um: px || null,
        detection_channel: (detectChannel() || {}).name || '',
        polarity: polarityChoice(),
        inverted_detected: !!(detectChannel() || {}).inverted,
        channels: S.image.channels.map(c => ({ name: c.name, bits: c.bits, clipped_fraction: +c.clipped.toFixed(5) })),
        /* Which Z layers the analysed image is the maximum of, counted from 1. */
        z_projection: sectionZCount(S.image) > 1 ? { method: 'maximum', layers: selectedZLayers(S.image).map(z => z + 1), of: sectionZCount(S.image),
                /* Layers lined up with the middle one first (pixels moved, not resampled). */
                lined_up: S.image.channels?.[0]?.zAlign ? { max_shift_px: Math.round(S.image.channels[0].zAlign.maxShift), squares_measured: +S.image.channels[0].zAlign.measured.toFixed(2) } : null,
                /* The look for doubling made when the file opened (worst layer's median shift; 1 px or more is doubling). */
                doubling_check: S.image.zAutoCheck ? { worst_layer_shift_px: +Number(S.image.zAutoCheck.check || 0).toFixed(2), lined_up_automatically: !!S.image.zAutoCheck.applied } : null } : null,
        parameters_px: p,
        parameters_um: px ? {
            smallest_soma: +(p.dMin * px).toFixed(3), largest_soma: +(p.dMax * px).toFixed(3),
            minimum_width: +(p.thin * 2 * px).toFixed(3), minimum_separation: +(p.sep * px).toFixed(3),
            narrowest_soma: +(p.minWidth * px).toFixed(3),
            tissue_edge_margin: +(p.edgeMargin * px).toFixed(3)
        } : null,
        signal_threshold_sigma: p.snr,
        brightness_floor: { setting: ($('floorMode') || {}).value || 'donut', applied: floorEnabled(), value: floorEnabled() ? contrastFloor() : null,
            /* Normal mode: the hand-count classifier's cells are dropped only by a floor set by hand. */
            applied_to_classifier_cells: floorEnabled() && classifierView() && floorSetByHand() },
        donut_mode_definition: 'original v2.6.6 behaviour (embedded donut-review and quality forests, area floor 0.40); not validated against hand counts',
        cell_classifier: (S.lastRun && S.lastRun.classifier) || { id: p.cellModel || 'rules', note: 'not yet analysed with current settings' },
        colocalisation: colocIndex() >= 0 ? {
            channel: (S.compUsed || []).slice(1).join(' + '),
            method: 'pixelwise normalized white-overlap score',
            normalization_nonzero_percentiles: [0.001, 0.998],
            white_overlap_score_threshold: +$('colocThr').value / 100,
            minimum_white_overlap_fraction: +$('minFill').value / 100,
            cell_whiteness_floor: colocFloor(),
            cell_whiteness_floor_auto: !!S.colocFloorAuto,
            counting_rule: (parseDetect().merge ? 'positive in every selected channel and above the cell-level colocalization floor' : 'all somata'),
            bleedthrough_fraction: +$('bleed').value / 100
        } : null,
        counts: {
            total: S.cells.length,
            automatic: S.cells.filter(c => c.source === 'auto').length,
            hand_added: S.cells.filter(c => c.source === 'manual').length,
            hand_removed_from_automatic: S.manualRemoved || 0,
            borderline_remaining: S.queue ? S.queue.length : 0,
            borderline_confidence_cut: confCut(),
            flagged: S.cells.filter(c => c.flag).length,
            automatic_before_edits: S.autoCount || 0,
            seeds_examined: S.seeds,
            rejected: S.rej
        },
        /* A region is one or more outlines (polys). This read the old single
           "poly" field, which regions no longer have, so the run export threw
           every time. */
        regions: S.regions.map(r => ({ name: r.name, outlines: regionPolys(r).length,
            vertices: regionPolys(r).reduce((n, poly) => n + (poly ? poly.length : 0), 0),
            holes: regionHoles(r).length,
            n: S.cells.filter(c => c.region === S.regions.indexOf(r)).length }))
    }, null, 2);
}
/* ImageJ TIFF export doubles as a lightweight Soma save.  ImageJ sees a normal
   16-bit image plus a dot multipoint ROI.  Soma additionally stores a compact
   JSON state block in ImageDescription so the same TIFF can be reopened here
   with its saved cells, regions, floor and mode state already restored.      */
const ROI_COUNTERS = [2, 4, 6, 8, 10, 1, 3, 5];
function groupsForCells(cells, regions) {
    const out = [], used = new Set();
    (regions || []).forEach((r, i) => {
        const cs = (cells || []).filter(c => c.region === i);
        if (cs.length) {
            const counter = ROI_COUNTERS[out.length % ROI_COUNTERS.length];
            used.add(counter);
            out.push({ name: r.name || ('Region ' + (i + 1)), counter, cells: cs });
        }
    });
    const un = (cells || []).filter(c => !(Number.isInteger(c.region) && c.region >= 0 && c.region < (regions || []).length));
    if (un.length) {
        let counter = 1;
        while (used.has(counter))
            counter++;
        out.push({ name: 'Unassigned', counter, cells: un });
    }
    return out;
}
function buildCounterRoi(groups) {
    let cells = [], counters = [];
    groups.forEach(g => g.cells.forEach(c => { cells.push(c); counters.push(g.counter); }));
    const n = cells.length;
    if (!n)
        return null;
    if (n > 65535)
        throw new Error('An ImageJ point ROI holds at most 65,535 points.');
    const xs = cells.map(c => Math.round(c.x)), ys = cells.map(c => Math.round(c.y));
    const left = Math.min.apply(null, xs), top = Math.min.apply(null, ys);
    const right = Math.max.apply(null, xs) + 1, bottom = Math.max.apply(null, ys) + 1;
    const H2 = 64 + n * 4, CNT = H2 + 64;
    const buf = new ArrayBuffer(CNT + n * 4), v = new DataView(buf), u = new Uint8Array(buf);
    u[0] = 73;
    u[1] = 111;
    u[2] = 117;
    u[3] = 116; // Iout
    v.setInt16(4, 228);
    u[6] = 10;
    v.setInt16(8, top);
    v.setInt16(10, left);
    v.setInt16(12, bottom);
    v.setInt16(14, right);
    v.setInt16(16, n);
    v.setInt16(34, 3);
    u[52] = 2;
    v.setInt32(60, H2);
    for (let i = 0; i < n; i++)
        v.setInt16(64 + i * 2, xs[i] - left);
    for (let i = 0; i < n; i++)
        v.setInt16(64 + n * 2 + i * 2, ys[i] - top);
    v.setInt32(H2 + 48, CNT);
    for (let i = 0; i < n; i++)
        v.setInt32(CNT + i * 4, counters[i] & 0xff);
    return new Uint8Array(buf);
}
function compactResultForTiff(res) {
    return { analysisValue: res.analysisValue || null, selection: res.selection || '', modeSignature: res.modeSignature || 'normal',
        regions: jsonClone(res.regions || []), cells: (res.cells || []).map(cloneCellSnapshot),
        allCells: Array.isArray(res.allCells) ? res.allCells.map(cloneCellSnapshot) : null, run: jsonClone(res.run || null),
        removed: res.removed || 0, autoCount: res.autoCount || 0, rej: jsonClone(res.rej || null), seeds: res.seeds || 0,
        decisions: jsonClone(res.decisions || []), chanOrder: jsonClone(res.chanOrder || null), colocIdx: jsonClone(res.colocIdx || []), compUsed: jsonClone(res.compUsed || []),
        floorValue: res.floorValue, floorMin: res.floorMin, floorMax: res.floorMax, floorStep: res.floorStep,
        floorTouched: !!res.floorTouched, floorAuto: !!res.floorAuto, autoFloorRef: res.autoFloorRef,
        colocFloorValue: res.colocFloorValue, colocFloorTouched: !!res.colocFloorTouched, colocFloorAuto: !!res.colocFloorAuto, autoColocFloorRef: res.autoColocFloorRef,
        removedAutoIds: jsonClone(res.removedAutoIds || []), w: res.w, h: res.h };
}
/* Every TIFF also lists the image's channels (names and colours, in order),
   so the TIFFs of one image can be put back together as that image when they
   are opened again (14-saved-tiffs). A view never analysed carries this and no
   result: it reopens with no counts. */
function somaTiffState(sec, res, value) {
    const sig = (res && res.modeSignature) || analysisModeSignature(sec, value), mode = modeFromSavedSignature(sig);
    return { format: 'soma-imagej-save-v1', generated: new Date().toISOString(), sectionName: sec.name,
        selection: (res && res.selection) || analysisSelectionLabel(sec, value), analysisValue: value, mode, modeSignature: sig,
        channels: (sec.channels || []).map(c => ({ name: c.name, color: c.color || null })),
        pixelSizeUm: Number((sec.channels && sec.channels[0] && sec.channels[0].pixelSizeUm) || 0) || ((sec === S.image && +$('pxSize').value > 0) ? +$('pxSize').value : null),
        sourceFiles: (sec.sourceFiles || sec.files || []).map(f => ({ name: f.name, size: f.size, lastModified: f.lastModified || 0 })),
        regions: jsonClone((res && res.regions) || sec.regions || []), result: res ? compactResultForTiff(res) : null };
}
function imageChannelForValue(sec, value) {
    if (!sec || !sec.channels || !sec.channels.length)
        return null;
    const v = String(value || 'c0');
    if (v[0] !== 'm') {
        const i = Math.max(0, Math.min(sec.channels.length - 1, +v.slice(1) || 0));
        return sec.channels[i];
    }
    const idx = v.slice(1).split('-').map(Number).filter(i => i >= 0 && i < sec.channels.length);
    if (!idx.length)
        return sec.channels[0];
    let best = idx[0], bd = Infinity;
    for (const i of idx) {
        const d = channelDensity(sec.channels[i]);
        if (d < bd) {
            bd = d;
            best = i;
        }
    }
    return sec.channels[best];
}
function storedValueForResult(sec, res) {
    if (res && res.analysisValue && /^(?:c\d+|m\d+(?:-\d+)+)$/.test(res.analysisValue))
        return res.analysisValue;
    const label = String((res && res.selection) || '').split(' + ').map(x => x.trim()).filter(Boolean);
    if (!label.length)
        return 'c0';
    const used = new Set(), idx = [];
    for (const n of label) {
        let found = -1;
        for (let i = 0; i < sec.channels.length; i++)
            if (!used.has(i) && String(sec.channels[i].name).trim() === n) {
                found = i;
                break;
            }
        if (found < 0)
            return 'c0';
        used.add(found);
        idx.push(found);
    }
    return idx.length === 1 ? 'c' + idx[0] : 'm' + idx.join('-');
}
function safeExportName(s) { return String(s || 'analysis').replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 160) || 'analysis'; }
function sourceExportFolder(sec) {
    const embedded = sec && sec.imagejImport && sec.imagejImport.extras && sec.imagejImport.extras.somaState;
    const embeddedFiles = embedded && Array.isArray(embedded.sourceFiles) ? embedded.sourceFiles : [];
    const liveFiles = sec && Array.isArray(sec.files) ? sec.files : [];
    const savedFiles = sec && Array.isArray(sec.sourceFiles) ? sec.sourceFiles : [];
    const source = (liveFiles.find(f => /\.nd2$/i.test(f && f.name || '')) || savedFiles.find(f => /\.nd2$/i.test(f && f.name || '')) || embeddedFiles.find(f => /\.nd2$/i.test(f && f.name || '')) || liveFiles[0] || embeddedFiles[0] || {}).name || sec && sec.name || 'source';
    return safeExportName(String(source).replace(/\.[^.]+$/, ''));
}
/* Uncompressed little-endian TIFF carrying the image, ImageJ point ROI and an
   optional Soma state block in ImageDescription. A merge is written as an
   ImageJ composite: one page per channel, each with its display range and a
   colour table of its colour, so ImageJ shows it in colour and Soma can read
   every channel back. planes: [{ chan, lo, hi, color }]. */
function lutBytes(color) {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(String(color || '')) || [0, 'ff', 'ff', 'ff'];
    const rgb = [m[1], m[2], m[3]].map(x => parseInt(x, 16)), out = new Uint8Array(768);
    for (let k = 0; k < 3; k++)
        for (let i = 0; i < 256; i++)
            out[k * 256 + i] = Math.round(i * rgb[k] / 255);
    return out;
}
function imagejTiff(planes, roiBytes, somaState = null) {
    const n = planes.length, w = planes[0].chan.w, h = planes[0].chan.h;
    const stateLine = somaState ? 'SomaQuantState=' + encodeSomaState(somaState) + '\n' : '';
    const stack = n > 1 ? 'images=' + n + '\nchannels=' + n + '\nmode=composite\n' : 'images=1\n';
    const desc = new TextEncoder().encode('ImageJ=1.54p\n' + stack + 'min=' + planes[0].lo.toFixed(1) + '\nmax=' + planes[0].hi.toFixed(1) + '\n' + stateLine + '\0');
    /* ImageJ's own metadata: a header naming each kind of item and how many,
       then the items; their byte lengths go in the counts tag. */
    const items = [];
    if (n > 1) {
        const ranges = new Uint8Array(16 * n), rv = new DataView(ranges.buffer);
        planes.forEach((p, i) => { rv.setFloat64(16 * i, p.lo, true); rv.setFloat64(16 * i + 8, p.hi, true); });
        items.push([0x72616e67, [ranges]]); // rang
        items.push([0x6c757473, planes.map(p => lutBytes(p.color))]); // luts
    }
    if (roiBytes && roiBytes.length)
        items.push([0x726f6920, [roiBytes]]); // roi
    let counts = null, meta = null;
    if (items.length) {
        const parts = items.flatMap(it => it[1]), headLen = 4 + 8 * items.length;
        meta = new Uint8Array(headLen + parts.reduce((s, p) => s + p.length, 0));
        const mv = new DataView(meta.buffer);
        mv.setUint32(0, 0x494a494a, true);
        items.forEach(([type, list], k) => { mv.setUint32(4 + 8 * k, type, true); mv.setUint32(8 + 8 * k, list.length, true); });
        let o = headLen;
        for (const p of parts) {
            meta.set(p, o);
            o += p.length;
        }
        counts = new Uint8Array(4 * (1 + parts.length));
        const cv = new DataView(counts.buffer);
        cv.setUint32(0, headLen, true);
        parts.forEach((p, k) => cv.setUint32(4 + 4 * k, p.length, true));
    }
    const even = x => x + (x & 1);
    let off = 8;
    const descOff = off;
    off += even(desc.length);
    const cntOff = counts ? off : 0;
    if (counts)
        off += counts.length;
    const metaOff = meta ? off : 0;
    if (meta)
        off += even(meta.length);
    /* The first page carries the description and ImageJ's metadata. */
    const tagCount = k => k ? 8 : (counts ? 11 : 9), ifdOffs = [], dataOffs = [];
    for (let k = 0; k < n; k++) {
        ifdOffs.push(off);
        off += 2 + tagCount(k) * 12 + 4;
        dataOffs.push(off);
        off += w * h * 2;
    }
    const out = new Uint8Array(off), dv = new DataView(out.buffer);
    out[0] = 0x49;
    out[1] = 0x49;
    dv.setUint16(2, 42, true);
    dv.setUint32(4, ifdOffs[0], true);
    out.set(desc, descOff);
    if (counts)
        out.set(counts, cntOff);
    if (meta)
        out.set(meta, metaOff);
    planes.forEach((p, k) => {
        const ifdOff = ifdOffs[k], dataOff = dataOffs[k], NT = tagCount(k), src = p.chan.data;
        dv.setUint16(ifdOff, NT, true);
        let e = ifdOff + 2;
        const tag = (id, type, count, value) => { dv.setUint16(e, id, true); dv.setUint16(e + 2, type, true); dv.setUint32(e + 4, count, true); dv.setUint32(e + 8, value, true); e += 12; };
        tag(256, 3, 1, w);
        tag(257, 3, 1, h);
        tag(258, 3, 1, 16);
        tag(259, 3, 1, 1);
        tag(262, 3, 1, 1);
        if (!k)
            tag(270, 2, desc.length, descOff);
        tag(273, 4, 1, dataOff);
        tag(277, 3, 1, 1);
        tag(279, 4, 1, w * h * 2);
        if (!k && counts) {
            tag(50838, 4, counts.length / 4, cntOff);
            tag(50839, 1, meta.length, metaOff);
        }
        dv.setUint32(e, k + 1 < n ? ifdOffs[k + 1] : 0, true);
        for (let i = 0; i < w * h; i++) {
            const val = src[i];
            dv.setUint16(dataOff + i * 2, val < 0 ? 0 : (val > 65535 ? 65535 : Math.round(val)), true);
        }
    });
    return out;
}
function tiffPlane(ch) {
    const r = range(ch.data);
    return { chan: ch, lo: r.lo, hi: r.hi, color: ch.color };
}
function crc32(bytes) { return ToolkitCore.export.crc32(bytes); }
async function zipBlobs(entries) { return ToolkitCore.export.zip(entries, { compress: true }); }
async function buildImageJTiffForResult(sec, res) {
    const value = storedValueForResult(sec, res), hadFull = sectionHasFullPixels(sec);
    await ensureFullSectionPixels(sec, 'ImageJ TIFF export');
    /* A merge keeps all its channels (a composite); a channel is itself. */
    const chans = value[0] === 'm' ? valueIdx(value).map(i => sec.channels[i]) : [imageChannelForValue(sec, value)];
    if (!chans.length || chans.some(ch => !ch || !ch.data))
        throw new Error('Could not restore the full-resolution source image for ' + sec.name + '.');
    const groups = groupsForCells(res.cells || [], res.regions || sec.regions || []), roi = buildCounterRoi(groups), state = somaTiffState(sec, res, value);
    const tif = imagejTiff(chans.map(tiffPlane), roi, state), name = safeExportName(sec.name) + '__' + safeExportName(res.selection || analysisSelectionLabel(sec, value)) + '__' + safeExportName(modeFromSavedSignature(res.modeSignature)) + '.tif';
    if (!hadFull) {
        ensureReviewCopy(sec, sec.reviewScale || S.reviewScale);
        releaseFullSectionPixels(sec);
    }
    return { name, data: tif, groups };
}
/* ImageJ TIFF exports come in three scopes: the selected view, every view of
   the open image (section), or every image (all). "Only analysed views" (on by
   default, remembered) keeps them to views with an analysis or hand counts;
   off, each channel never analysed is exported too, as a plain TIFF: the
   picture alone, with no dots and no saved analysis, so reopening it starts
   fresh. */
const ONLY_ANALYSED_KEY = 'toolkit.soma.exportOnlyAnalysed';
function exportOnlyAnalysed() { return !$('expOnlyAnalysed') || $('expOnlyAnalysed').checked; }
function unanalysedChannelValues(sec) {
    const done = new Set(resultsForSection(sec).map(r => storedValueForResult(sec, r)));
    return (sec.channels || []).map((_, i) => 'c' + i).filter(v => !done.has(v));
}
/* What a scope would export: stored analyses, then (if asked) the channels
   with none. The view on screen counts as analysed once it has been saved. */
function tiffExportPlan(sections) {
    const only = exportOnlyAnalysed(), plan = [];
    for (const sec of sections) {
        for (const res of resultsForSection(sec))
            plan.push({ sec, res });
        if (!only)
            for (const value of unanalysedChannelValues(sec))
                plan.push({ sec, value });
    }
    return plan;
}
function syncTiffExportButtons() {
    const sec = S.image, only = exportOnlyAnalysed();
    if ($('expRoi'))
        $('expRoi').disabled = !sec || (only && !currentResult() && !resultsForSection(sec).some(r => storedValueForResult(sec, r) === $('chDetect').value));
    if ($('expRoiSection'))
        $('expRoiSection').disabled = !sec || !tiffExportPlan([sec]).length;
    if ($('expRoiAll'))
        $('expRoiAll').disabled = !(S.sections || []).length || !tiffExportPlan(S.sections).length;
}
async function buildPlainTiff(sec, value) {
    const hadFull = sectionHasFullPixels(sec);
    await ensureFullSectionPixels(sec, 'ImageJ TIFF export');
    const ch = imageChannelForValue(sec, value);
    if (!ch || !ch.data)
        throw new Error('Could not restore the full-resolution source image for ' + sec.name + '.');
    const tif = imagejTiff([tiffPlane(ch)], null, somaTiffState(sec, null, value));
    const name = safeExportName(sec.name) + '__' + safeExportName(analysisSelectionLabel(sec, value)) + '__not_analysed.tif';
    if (!hadFull) {
        ensureReviewCopy(sec, sec.reviewScale || S.reviewScale);
        releaseFullSectionPixels(sec);
    }
    return { name, data: tif };
}
async function exportSelectedImageJTiff() {
    if (!S.image)
        return;
    saveResult();
    const res = currentResult(), value = $('chDetect').value, sec = S.image;
    if (!res && (exportOnlyAnalysed() || value[0] === 'm')) {
        setStatus(exportOnlyAnalysed() ? 'Analyse the selected view before exporting it, or untick Only analysed views to export the picture alone.'
            : 'A merge that has not been analysed has no single picture to export; export its channels instead.');
        return;
    }
    const wasHalf = sec.displayResolution === 'reduced';
    try {
        setBusy(true, 'Preparing ImageJ TIFF');
        const out = res ? await buildImageJTiffForResult(sec, res) : await buildPlainTiff(sec, value);
        dl(new Blob([out.data], { type: 'image/tiff' }), out.name);
        setStatus(res ? `Exported ${res.cells.length} dot ROIs · Soma state embedded for reopening.` : 'Exported the picture alone (not analysed, no dots).');
    }
    catch (e) {
        setStatus(e.message || String(e));
    }
    finally {
        if (wasHalf && sectionHasReviewPixels(sec)) {
            sec.displayResolution = 'reduced';
            releaseFullSectionPixels(sec);
            drawBase();
            drawOverlay();
            syncDisplayResolutionButtons();
        }
        setBusy(false);
    }
}
async function exportImageJTiffs(scope) {
    if (scope === 'section' && !S.image)
        return;
    saveResult();
    const sections = scope === 'section' ? [S.image] : S.sections, plan = tiffExportPlan(sections);
    if (!plan.length) {
        setStatus(scope === 'section' ? 'This image has no analysed views to export.' : 'No saved analyses to export.');
        return;
    }
    const original = S.image, wasHalf = original && original.displayResolution === 'reduced', entries = [], oldPx = $('pxSize').value, oldPxSrc = $('pxSrc').textContent;
    setBusy(true, scope === 'section' ? 'Preparing ImageJ TIFFs of this image' : 'Preparing all ImageJ TIFFs');
    let analysed = 0, plain = 0, restored = null;
    /* Each image is restored to full resolution once for all its views and
       reduced again after its last one; restoring it per view read a large ND2
       again for every channel and merge. */
    const reduceRestored = () => {
        if (restored) {
            ensureReviewCopy(restored, restored.reviewScale || S.reviewScale);
            releaseFullSectionPixels(restored);
        }
        restored = null;
    };
    try {
        for (const [k, item] of plan.entries()) {
            const { sec, res } = item;
            setStatus(`ImageJ TIFF export ${k + 1}/${plan.length} · ${sec.name} · ${res ? res.selection || 'analysis' : analysisSelectionLabel(sec, item.value) + ' (not analysed)'}…`);
            progress(true, 5 + 85 * k / Math.max(1, plan.length));
            if (restored && restored !== sec)
                reduceRestored();
            if (!sectionHasFullPixels(sec)) {
                await ensureFullSectionPixels(sec, 'ImageJ TIFF export');
                restored = sec;
            }
            const out = res ? await buildImageJTiffForResult(sec, res) : await buildPlainTiff(sec, item.value);
            if (scope !== 'section')
                out.name = sourceExportFolder(sec) + '/' + out.name;
            entries.push(out);
            if (res)
                analysed++;
            else
                plain++;
        }
        setStatus(`Compressing ${entries.length} ImageJ TIFF${entries.length === 1 ? '' : 's'}…`);
        progress(true, 94);
        const zip = await zipBlobs(entries);
        dl(new Blob([zip], { type: 'application/zip' }), scope === 'section' ? safeExportName(original.name) + '_imagej_tiffs.zip' : 'soma_imagej_tiffs.zip');
        setStatus(`Exported ${analysed} analysed view${analysed === 1 ? '' : 's'}${plain ? ` and ${plain} picture${plain === 1 ? '' : 's'} not analysed` : ''} as ImageJ TIFFs${scope === 'section' ? ' of ' + original.name : ''}.`);
    }
    catch (e) {
        setStatus(e.message || String(e));
    }
    finally {
        reduceRestored();
        $('pxSize').value = oldPx;
        $('pxSrc').textContent = oldPxSrc;
        syncLabels();
        progress(false);
        setBusy(false);
        if (original === S.image && original) {
            if (wasHalf && sectionHasReviewPixels(original) && original.displayResolution !== 'reduced') {
                original.displayResolution = 'reduced';
                releaseFullSectionPixels(original);
            }
            describeImage();
            drawBase();
            drawOverlay();
            syncDisplayResolutionButtons();
        }
    }
}
function exportAllImageJTiffs() { return exportImageJTiffs('all'); }
$('expCells').onclick = () => dl(new Blob([cellsCsv()], { type: 'text/csv' }), baseName() + '_cells.csv');
$('expSummary').onclick = () => { saveResult(); dl(new Blob([summaryCsv()], { type: 'text/csv' }), 'summary_by_region.csv'); };
$('expRun').onclick = async () => dl(new Blob([await runJson()], { type: 'application/json' }), baseName() + '_run.json');
$('expRoi').onclick = exportSelectedImageJTiff;
$('expRoiAll').onclick = exportAllImageJTiffs;
$('expRoiSection').onclick = () => exportImageJTiffs('section');
try {
    const v = localStorage.getItem(ONLY_ANALYSED_KEY);
    if (v != null)
        $('expOnlyAnalysed').checked = v === '1';
}
catch (_) { }
$('expOnlyAnalysed').addEventListener('change', () => {
    try {
        localStorage.setItem(ONLY_ANALYSED_KEY, $('expOnlyAnalysed').checked ? '1' : '0');
    }
    catch (_) { }
    syncTiffExportButtons();
});
function decisionsCsv() {
    const seen = new Set(S.decisions.map(d => d.x + ',' + d.y));
    const rows = S.decisions.slice();
    /* every automatic detection you did NOT act on is itself a verdict: you left
       it in.  Without these the file only contains the hard cases and any fit
       would be trained on a biased slice.                                      */
    for (const c of S.cells) {
        if (c.source !== 'auto')
            continue;
        if (seen.has(c.x + ',' + c.y))
            continue;
        const p = params();
        rows.push({ section: S.image.name, channel: (detectChannel() || {}).name || '',
            /* never label these 'kept': you never saw them.  Only a verdict that
               actually passed under your eye counts as a decision.               */
            verdict: 'kept_unreviewed',
            x: c.x, y: c.y, width: c.width, minor: c.minor, major: c.major, aspect: c.aspect, area: c.area,
            z: (c.z && isFinite(c.z[0])) ? c.z[0] : '', peak: isFinite(c.peak) ? c.peak : '',
            raw: isFinite(c.raw) ? c.raw : '', bg: isFinite(c.bg) ? c.bg : '', sigma: isFinite(c.sig) ? c.sig : '',
            contrast: isFinite(c.contrast) ? c.contrast : '',
            conf: c.conf, source: c.source,
            p_dMin: p.dMin, p_dMax: p.dMax, p_snr: p.snr, p_minWidth: p.minWidth, p_minContrast: p.minContrast,
            p_sep: +p.sep.toFixed(2), p_maxAspect: p.maxAspect, p_edge: p.edgeMargin,
            px_um: +$('pxSize').value || '', cut: confCut(), when: '' });
    }
    if (!rows.length)
        return '';
    const cols = Object.keys(rows[0]);
    return [cols.join(',')].concat(rows.map(r => cols.map(k => {
        const v = r[k];
        return typeof v === 'number' ? (+v.toFixed(4)) : csvEscape(String(v == null ? '' : v));
    }).join(','))).join('\n');
}
$('expDecisions').onclick = () => {
    const csv = decisionsCsv();
    if (!csv) {
        setStatus('No manual corrections recorded yet — add or remove cells first.');
        return;
    }
    dl(new Blob([csv], { type: 'text/csv' }), baseName() + '_decisions.csv');
};
$('expPng').onclick = async () => {
    if (!S.image)
        return;
    const sec = S.image, wasHalf = sec.displayResolution === 'reduced';
    try {
        if (wasHalf) {
            sec.displayResolution = 'full';
            await ensureFullSectionPixels(sec, 'full-resolution PNG export');
            drawBase();
            drawOverlay();
        }
        const c = document.createElement('canvas');
        c.width = $('base').width;
        c.height = $('base').height;
        const g = c.getContext('2d');
        g.drawImage($('base'), 0, 0);
        g.drawImage($('ov'), 0, 0);
        await new Promise(resolve => c.toBlob(b => { if (b)
            dl(b, baseName() + '_counted.png'); resolve(); }, 'image/png'));
    }
    finally {
        if (wasHalf && S.image === sec) {
            sec.displayResolution = 'reduced';
            if (!sectionHasReviewPixels(sec))
                ensureReviewCopy(sec, sec.reviewScale || S.reviewScale);
            releaseFullSectionPixels(sec);
            drawBase();
            drawOverlay();
            syncDisplayResolutionButtons();
        }
    }
};
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

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

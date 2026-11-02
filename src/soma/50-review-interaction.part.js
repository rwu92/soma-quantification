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

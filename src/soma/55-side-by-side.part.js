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

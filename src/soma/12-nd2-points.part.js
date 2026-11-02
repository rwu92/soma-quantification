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

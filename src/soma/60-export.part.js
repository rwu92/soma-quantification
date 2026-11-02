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

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

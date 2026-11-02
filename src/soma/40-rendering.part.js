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

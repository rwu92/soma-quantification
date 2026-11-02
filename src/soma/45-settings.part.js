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

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

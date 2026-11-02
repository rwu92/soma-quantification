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

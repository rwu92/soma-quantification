// Replay captured detection requests through the worker in Node.
// usage: node replay.js <workerPath> <filterMode rf|none|<anything the worker understands>> <outJson>
const fs = require('fs'), vm = require('vm'), path = require('path');
const [workerPath, FILTER, outPath] = process.argv.slice(2);
const CAP = process.env.CAP_DIR;
let src = fs.readFileSync(workerPath, 'utf8');
if (process.env.PATCH_RF_SWITCH) {
  // Test-only switch for the unmodified worker: 'none' disables every forest.
  const a = 'if(!(cell.reviewDonut&&isFinite(cell.reviewScore)&&cell.reviewScore>=REVIEW_DONUT_RF.threshold) && rq<REVIEW_QUALITY_RF.threshold){';
  const b = 'if(baseProps&&p.fillHoles){';
  if (!src.includes(a) || !src.includes(b)) throw new Error('patch anchors missing');
  src = src.replace(a, "if(self.__FILTER!=='none' && " + a.slice(3)).replace(b, "if(baseProps&&p.fillHoles&&self.__FILTER!=='none'){");
}
const JHB = +(src.match(/JHB=(\d+)/) || [])[1], JHLO = +(src.match(/JHLO=([-\d.]+)/) || [])[1], JHHI = +(src.match(/JHHI=([-\d.]+)/) || [])[1];
if (![JHB, JHLO, JHHI].every(Number.isFinite)) throw new Error('JH constants');
if (!JHB) throw new Error('JH constants not found');
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;

function makeWorker() {
  const messages = [];
  const self = { postMessage: m => messages.push(m), __FILTER: FILTER };
  const ctx = { self, console, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array, Int16Array, Array, Math, Number, Object, String, Boolean, Map, Set, JSON, Date, Infinity, NaN, isFinite, isNaN, parseInt, parseFloat, Error, RegExp, Symbol, Promise };
  vm.createContext(ctx); vm.runInContext(src, ctx, { filename: 'worker.js' });
  return { run(msg) { messages.length = 0; self.onmessage({ data: msg }); const r = messages.find(m => m.type === 'result'); if (!r) { const e = messages.find(m => m.type === 'error'); throw new Error(e ? e.msg : 'no result'); } return r; } };
}

// ---- client-side floors, ported from assets/apps/soma.js ----
function otsu(v, B) {
  let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  if (!(hi > lo)) return null;
  const h = new Float64Array(B); for (const x of v) { let k = Math.floor((x - lo) / (hi - lo) * B); if (k < 0) k = 0; if (k >= B) k = B - 1; h[k]++; }
  let sum = 0; for (let i = 0; i < B; i++) sum += i * h[i];
  let wB = 0, sB = 0, best = -1, thr = 0;
  for (let i = 0; i < B; i++) { wB += h[i]; if (!wB) continue; const wF = v.length - wB; if (!wF) break; sB += i * h[i]; const mB = sB / wB, mF = (sum - sB) / wF, q = wB * wF * (mB - mF) * (mB - mF); if (q > best) { best = q; thr = i; } }
  return { lo, hi, thr };
}
function floorState(cells, prevValue) {
  const v = cells.map(c => c.contrast).filter(isFinite).sort((a, b) => a - b);
  let min = 0, max = 1000, value = prevValue;
  if (v.length) { const lo = v[0], top = v[Math.floor(0.995 * (v.length - 1))]; min = Math.max(0, Math.floor(lo * 0.92)); max = Math.max(min + 10, Math.round(top * 1.02)); if (value < min || value > max) value = min; }
  const pop = cells.filter(c => !c.donutRescue && !c.axonHeavy).map(c => isFinite(c.baseContrast) ? c.baseContrast : c.contrast).filter(isFinite);
  if (pop.length >= 20) { const o = otsu(pop, 128); if (o) value = Math.max(min, Math.min(max, Math.round(o.lo + (o.thr + 1) / 128 * (o.hi - o.lo)))); }
  return value;
}
function whiteScore(c, colocIdx) {
  if (!c || !c.jhist || !c.npx || !(c.nC > 1)) return null;
  const idx = colocIdx.length ? colocIdx : [1]; let worst = 1, tested = 0;
  for (const k of idx) { if (!(k > 0 && k < c.nC)) continue; let sum = 0, n = 0; const off = k * JHB;
    for (let b = 0; b < JHB; b++) { const ct = c.jhist[off + b] || 0; if (!ct) continue; sum += (JHLO + (b + 0.5) / JHB * (JHHI - JHLO)) * ct; n += ct; }
    if (n) { worst = Math.min(worst, sum / n); tested++; } }
  return tested ? clamp(worst, 0, 1) : null;
}
function colocFloorAuto(cells, colocIdx) {
  const vals = cells.map(c => whiteScore(c, colocIdx)).filter(v => v != null && isFinite(v)).sort((a, b) => a - b);
  if (vals.length < 4) return null;
  const lo = vals[0], hi = vals[vals.length - 1];
  if (!(hi > lo + 1e-6)) return clamp(Math.round(Math.max(0, Math.min(1, lo * 0.8)) * 100) / 100, 0, 1);
  const o = otsu(vals, 96);
  return clamp(Math.round(clamp(o.lo + (o.thr + 1) / 96 * (o.hi - o.lo), 0, 1) * 100) / 100, 0, 1);
}
const passesBright = (c, f) => (c.reviewDonut && isFinite(c.reviewScore) && c.reviewScore >= 0.45) || !(f > 0 && isFinite(c.contrast) && c.contrast < f);

const ONLY = process.env.ONLY ? process.env.ONLY.split(',') : null;
const files = fs.readdirSync(CAP).filter(d => fs.existsSync(path.join(CAP, d, 'meta.json')) && (!ONLY || ONLY.includes(d))).sort();
const out = {};
for (const fdir of files) {
  const meta = JSON.parse(fs.readFileSync(path.join(CAP, fdir, 'meta.json')));
  const chans = meta.channels.map((_, i) => { const b = fs.readFileSync(path.join(CAP, fdir, `ch${i}.bin`)); return new Float32Array(b.buffer, b.byteOffset, b.byteLength / 4); });
  const worker = makeWorker();
  const views = {};
  let floorValue = 0, colocValue = 0;
  for (const run of meta.runs) {
    const key = run.params.detectKey, merge = !/^c\d+$/.test(key);
    if (merge && process.env.SINGLES_ONLY) continue;
    const params = Object.assign({}, run.params, process.env.AREA_LO ? { areaLo: +process.env.AREA_LO } : {}, process.env.LEGACY ? { legacyForests: process.env.LEGACY === '1' } : {}, process.env.FILTERS_OPEN ? { areaLo: 0, areaHi: 1e9, minWidth: 0 } : {}, process.env.SNR_SCALE ? { snr: run.params.snr * +process.env.SNR_SCALE } : {}, process.env.CELL_MODEL ? { cellModel: process.env.CELL_MODEL } : {});
    const msg = { type: 'run', id: run.id, w: run.w, h: run.h, channels: run.chanOrder.map(i => chans[i].slice(0)), params, requestId: 'r' };
    if (run.params.axonHeavy) {
      msg.supportChannels = []; msg.supportModes = []; msg.supportNames = [];
      msg.supportCellGroups = (run.supportCellGroups || []).map(g => {
        if (FILTER === 'rf' && !process.env.REBUILD_GUIDES) return g;
        const ci = meta.channels.findIndex(c => c.name === g.name), v = views['c' + ci];
        if (!v) throw new Error('guide view missing for ' + g.name);
        return { mode: g.mode, name: g.name, cells: v.finalCells };
      });
    }
    const t0 = Date.now();
    const r = worker.run(msg);
    const cells = r.cells;
    floorValue = floorState(cells, floorValue);
    let final = cells.filter(c => passesBright(c, floorValue));
    let colocF = null;
    if (merge) {
      const colocIdx = run.params.colocIdx || [];
      const f = colocFloorAuto(cells, colocIdx); if (f != null) colocValue = Math.round(f * 100);
      colocF = clamp(colocValue / 100, 0, 1);
      final = final.filter(c => { if (!(colocF > 0)) return true; const v = whiteScore(c, colocIdx); return v == null ? true : v >= colocF; });
    }
    const slim = c => ({ x: c.x, y: c.y, area: c.area, minor: c.minor, major: c.major, aspect: c.aspect, width: c.width, raw: c.raw, bg: c.bg, sig: c.sig, contrast: c.contrast, baseContrast: c.baseContrast, z0: c.z && c.z[0], peak: c.peak, conf: c.conf, rq: c.reviewQuality, donutRescue: !!c.donutRescue, reviewDonut: !!c.reviewDonut, reviewScore: c.reviewScore, axonHeavy: !!c.axonHeavy, rules: c.ruleReject || null, modelScore: c.modelScore, width: c.width, sigma: c.sig, local0: c.local && c.local[0], npx: c.npx });
    views[key] = { key, mode: run.params.detectionMode, all: cells.length, final: final.length, floor: floorValue, colocFloor: colocF, rej: r.rej, seeds: r.seeds, finalCells: final.map(c => ({ x: c.x, y: c.y })),
      cells: cells.map(slim), ms: Date.now() - t0 };
    const ui = meta.views.find(v => v.value === key);
    console.log(fdir, key.padEnd(7), (run.params.detectionMode || '').padEnd(6), 'all', String(cells.length).padStart(4), 'final', String(final.length).padStart(4), '| UI all', ui && ui.all, 'final', ui && ui.final, '| rq-rej', r.rej.reviewQuality || 0, 'rescue-rej', r.rej.reviewRescueQuality || 0, `${Date.now() - t0}ms`);
  }
  out[fdir] = { name: meta.name, file: meta.file, channels: meta.channels, views };
}
fs.writeFileSync(outPath, JSON.stringify(out));

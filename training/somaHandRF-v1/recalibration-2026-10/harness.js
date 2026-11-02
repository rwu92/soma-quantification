'use strict';
/* Replays Soma's detector on the counted ImageJ TIFFs (their pixels and saved run
   parameters) and returns the per-image output after the page's automatic floor. */
const fs = require('fs'), vm = require('vm'), path = require('path');
function readTiff(file) {
  const b = fs.readFileSync(file), le = b.readUInt16LE(0) === 0x4949;
  const u16 = o => le ? b.readUInt16LE(o) : b.readUInt16BE(o), u32 = o => le ? b.readUInt32LE(o) : b.readUInt32BE(o);
  const ifd = u32(4), n = u16(ifd), tags = {};
  for (let i = 0; i < n; i++) {
    const o = ifd + 2 + i * 12, tag = u16(o), type = u16(o + 2), cnt = u32(o + 4);
    const sz = { 1: 1, 2: 1, 3: 2, 4: 4 }[type] || 1, inl = sz * cnt <= 4, base = inl ? o + 8 : u32(o + 8);
    const vals = []; for (let k = 0; k < Math.min(cnt, 100000); k++) vals.push(type === 3 ? u16(base + k * 2) : type === 4 ? u32(base + k * 4) : b[base + k]);
    tags[tag] = { type, cnt, base, vals };
  }
  const w = tags[256].vals[0], h = tags[257].vals[0], bits = tags[258].vals[0];
  const offs = tags[273].vals, counts = tags[279].vals, data = new Float32Array(w * h);
  let k = 0;
  for (let s = 0; s < offs.length; s++) for (let o = offs[s]; o < offs[s] + counts[s] && k < data.length; o += bits / 8) data[k++] = bits === 16 ? u16(o) : b[o];
  const desc = b.subarray(tags[270].base, tags[270].base + tags[270].cnt).toString('utf8').split('\0')[0];
  const m = desc.match(/(?:^|\n)SomaQuantState=([^\r\n]+)/);
  return { w, h, data, state: m ? JSON.parse(Buffer.from(m[1], 'base64').toString('utf8')) : null };
}
function loadWorker(workerPath) {
  const messages = [], self = { postMessage: m => messages.push(m) };
  const ctx = { self, console, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array, Uint32Array, Int32Array, Int16Array, Int8Array, Array, Math, Number, Object, String, Boolean, Map, Set, JSON, Date, Infinity, NaN, isFinite, isNaN, parseInt, parseFloat, Error, RangeError, TypeError, Symbol, Promise, BigInt, ArrayBuffer, DataView };
  vm.createContext(ctx); vm.runInContext(fs.readFileSync(workerPath, 'utf8'), ctx, { filename: workerPath });
  return { run(msg) { messages.length = 0; ctx.self.onmessage({ data: msg }); const r = [...messages].reverse().find(m => m.type === 'result' || m.type === 'error'); if (!r || r.type === 'error') throw new Error(r ? r.msg : 'no result'); return r; } };
}
/* The page's automatic brightness floor (40-rendering autoFloorValue / passesBrightnessAt). */
function otsuFloor(all) {
  const v = all.filter(c => !c.donutRescue && !c.axonHeavy).map(c => isFinite(c.baseContrast) ? c.baseContrast : c.contrast).filter(isFinite);
  if (v.length < 20) return null;
  let lo = Infinity, hi = -Infinity; for (const x of v) { if (x < lo) lo = x; if (x > hi) hi = x; }
  if (!(hi > lo)) return null;
  const B = 128, hh = new Float64Array(B); for (const x of v) { let k = Math.floor((x - lo) / (hi - lo) * B); if (k < 0) k = 0; if (k >= B) k = B - 1; hh[k]++; }
  const tot = v.length; let sum = 0; for (let i = 0; i < B; i++) sum += i * hh[i];
  let wB = 0, sB = 0, best = -1, thr = 0;
  for (let i = 0; i < B; i++) { wB += hh[i]; if (!wB) continue; const wF = tot - wB; if (!wF) break; sB += i * hh[i]; const mB = sB / wB, mF = (sum - sB) / wF, bt = wB * wF * (mB - mF) ** 2; if (bt > best) { best = bt; thr = i; } }
  return lo + (thr + 1) / B * (hi - lo);
}
function passesAt(c, f) {
  if (c && c.reviewDonut && isFinite(c.reviewScore) && c.reviewScore >= 0.45) return true;
  if (c && isFinite(c.modelScore)) return true;
  return !(f > 0 && isFinite(c.contrast) && c.contrast < f);
}
function pageOutput(cells, mode) {
  if (mode !== 'donut') return { shown: cells, floor: null };
  const f = otsuFloor(cells), fr = f == null ? 0 : Math.round(f);
  return { shown: cells.filter(c => passesAt(c, fr)), floor: fr };
}
/* One-to-one matching within r px (greedy by distance, enough for scoring). */
function match(a, b, r) {
  const pairs = [];
  for (let i = 0; i < a.length; i++) for (let j = 0; j < b.length; j++) { const d = Math.hypot(a[i].x - b[j].x, a[i].y - b[j].y); if (d <= r) pairs.push([d, i, j]); }
  pairs.sort((p, q) => p[0] - q[0]); const ua = new Set(), ub = new Set(), m = [];
  for (const [d, i, j] of pairs) if (!ua.has(i) && !ub.has(j)) { ua.add(i); ub.add(j); m.push([i, j, d]); }
  return { tp: m.length, fp: a.length - m.length, fn: b.length - m.length, m, ua, ub };
}
module.exports = { readTiff, loadWorker, pageOutput, match, otsuFloor, passesAt };

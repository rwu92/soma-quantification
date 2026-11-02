'use strict';
/* One image: Soma's run exactly as saved ("base") and an open candidate pool
   ("pool": size/width limits off, every classifier/forest decision kept as a score). */
const H = require('./harness.js'), fs = require('fs'), path = require('path');
const [, , file, outFile, workerPath, poolWorker] = process.argv;
const t = H.readTiff(file), st = t.state, r = st.result, name = path.basename(file), mode = st.mode;
const strip = c => { const o = {}; for (const [k, v] of Object.entries(c)) if (!['hist', 'lhist', 'jhist', 'local'].includes(k)) o[k] = k === 'z' ? (Array.isArray(v) || ArrayBuffer.isView(v) ? v[0] : v) : v; return o; };
const p = Object.assign({}, r.run.params, { colocIdx: [], detectKey: 'c0' });
const base = H.loadWorker(workerPath).run({ type: 'run', requestId: 'b', id: name, w: t.w, h: t.h, channels: [t.data], params: p });
const poolP = Object.assign({}, p, { areaLo: 0, areaHi: 1e6, minWidth: 0, poolAll: true });
const pool = H.loadWorker(poolWorker).run({ type: 'run', requestId: 'p', id: name, w: t.w, h: t.h, channels: [t.data], params: poolP });
const out = { name, mode, selection: r.selection || st.selection, w: t.w, h: t.h, px: st.pixelSizeUm, params: p,
  truth: (r.cells || []).map(c => ({ x: c.x, y: c.y, source: c.source })), removedAutoIds: r.removedAutoIds || [],
  savedAuto: (r.allCells || []).map(c => ({ x: c.x, y: c.y, id: c.id })), floorTouched: !!r.floorTouched, floorValue: r.floorValue,
  base: base.cells.map(strip), baseRej: base.rej, pool: pool.cells.map(strip), poolRej: pool.rej };
fs.writeFileSync(outFile, JSON.stringify(out));
console.log(name, mode, 'base', base.cells.length, 'pool', pool.cells.length);

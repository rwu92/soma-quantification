'use strict';
/* The models embedded in assets/soma-detector-worker.js are the validated ones,
   and the browser reproduces the original implementations on recorded inputs:
   somaHandRF v1 against scikit-learn, somaNet v1 against PyTorch.
   Run from the repository root: node tests/test_model_parity.js */
const fs = require('fs'), vm = require('vm'), crypto = require('crypto'), assert = require('assert');
(function somaHandRfParity() {
    const src = fs.readFileSync('assets/soma-detector-worker.js', 'utf8');
    const ctx = { self: { postMessage() { } }, console, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array,
        Uint32Array, Int32Array, Array, Math, Number, Object, String, Boolean, Map, Set, JSON, Date, Infinity, NaN, isNaN, isFinite, Error };
    vm.createContext(ctx); vm.runInContext(src, ctx, { filename: 'soma-detector-worker.js' });
    const fx = JSON.parse(fs.readFileSync('tests/fixtures/somaHandRF-v1-parity.json', 'utf8'));
    const meta = JSON.parse(fs.readFileSync('docs/models/somaHandRF-v1.validation.json', 'utf8'));
    const model = vm.runInContext('SOMA_HAND_RF', ctx);
    assert.equal(model.sha256, meta.sha256, 'embedded model must match its validation record');
    assert.equal(model.threshold, meta.threshold);
    const X = vm.runInContext('handRfFeatures', ctx)(fx.cells, fx.dMin, fx.snr), P = vm.runInContext('handRfProbability', ctx);
    let kept = 0, worst = 0;
    X.forEach((x, i) => { const p = P(x); worst = Math.max(worst, Math.abs(p - fx.prob[i])); if (p >= model.threshold) kept++; });
    assert.ok(worst < 1e-9, 'probabilities differ from scikit-learn by ' + worst);
    assert.equal(kept, fx.kept, 'kept count differs from scikit-learn');
    assert.ok(Math.abs(vm.runInContext('handRfImageQuality', ctx)(fx.cells) - fx.quality) < 1e-9, 'image-quality metric differs');
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /<option value="somaHandRF-v1">Hand-count forest \(somaHandRF v1\)<\/option>/, 'the hand-count classifier stays available');
    console.log('test_model_parity: somaHandRF v1 parity ok');
})();

/* ---- somaNet v1: cell-centre networks ----
   The embedded weights must be the validated ones, the JavaScript forward pass
   must reproduce PyTorch on a recorded input (the WebGPU path is checked
   against it in the browser), and the network's centres must become cells:
   matched to detector candidates for their measurements, measured on their
   own otherwise, kept only at or above the calibrated threshold. The rules and
   classifier paths must still answer within the same message. */
(function somaNetV1() {
    const src = fs.readFileSync('assets/soma-detector-worker.js', 'utf8') + '\n;self.__net={SOMA_NET,SOMA_NET_CALIBRATION,SomaNetEngine,netFilters,netApplies,finalCells};';
    const ctx = { self: { postMessage() { } }, console, atob, Float32Array, Float64Array, Uint8Array, Uint8ClampedArray, Uint16Array,
        Uint32Array, Int32Array, Array, Math, Number, Object, String, Boolean, Map, Set, JSON, Date, Infinity, NaN, isNaN, isFinite, Error, Promise };
    vm.createContext(ctx); vm.runInContext(src, ctx, { filename: 'soma-detector-worker.js' });
    const { SOMA_NET, SOMA_NET_CALIBRATION, SomaNetEngine, netFilters, netApplies, finalCells } = ctx.self.__net;
    const meta = JSON.parse(fs.readFileSync('docs/models/somaNet-v1.validation.json', 'utf8'));
    const canon = v => Array.isArray(v) ? '[' + v.map(canon).join(',') + ']' : v && typeof v === 'object'
        ? '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}' : JSON.stringify(v);
    assert.equal(SOMA_NET.sha256, meta.sha256, 'embedded network must match its validation record');
    assert.equal(crypto.createHash('sha256').update(canon(SOMA_NET.models)).digest('hex'), SOMA_NET.sha256, 'embedded weights were changed');
    assert.equal(SOMA_NET_CALIBRATION.normal, meta.thresholds.normal);
    assert.equal(SOMA_NET_CALIBRATION.donut, meta.thresholds.donut);
    const fx = JSON.parse(fs.readFileSync('tests/fixtures/somaNet-v1-parity.json', 'utf8'));
    const f32 = b => { const u = Buffer.from(b, 'base64'); return new Float32Array(u.buffer, u.byteOffset, u.length / 4); };
    const rb = Buffer.from(fx.raw, 'base64'), raw = new Uint16Array(rb.buffer, rb.byteOffset, rb.length / 2);
    for (const mode of ['normal', 'donut']) {
        const m = SOMA_NET.models[mode], inp = SomaNetEngine.prepare(raw, fx.w, fx.h, mode === 'donut', m);
        const prob = SomaNetEngine.forwardCPU(m, inp), ref = f32(fx[mode].prob);
        let worst = 0; for (let i = 0; i < ref.length; i++) worst = Math.max(worst, Math.abs(prob[i] - ref[i]));
        assert.ok(worst < 1e-5, `${mode}: probabilities differ from PyTorch by ${worst}`);
        const pk = SomaNetEngine.peaks(prob, inp, 0.05);
        assert.equal(pk.length, fx[mode].peaks.length, mode + ': peak count differs from PyTorch');
        pk.forEach((c, i) => assert.ok(Math.hypot(c.x - fx[mode].peaks[i][0], c.y - fx[mode].peaks[i][1]) < 1e-3, mode + ': peak position differs'));
    }
    /* Centres -> cells. */
    const p = { dMin: 10, fillHoles: false, cellModel: 'somaNet-v1', colocMode: 'all' };
    assert.ok(netApplies(p) && !netApplies(Object.assign({}, p, { colocMode: 'coloc' })) && !netApplies(Object.assign({}, p, { cellModel: 'somaHandRF-v1' })));
    const props = [{ x: 20, y: 20, area: 90, minor: 10, major: 11, width: 9, raw: 300, bg: 100, sig: 20, z: [10], peak: 12, nC: 1, npx: 90 },
        { x: 60, y: 40, area: 120, minor: 12, major: 13, width: 11, raw: 500, bg: 100, sig: 20, z: [20], peak: 25, nC: 1, npx: 120 }];
    const w = 80, h = 60, C = { raw: new Float32Array(w * h).fill(100), bg: new Float32Array(w * h).fill(90), sig: new Float32Array(w * h).fill(5), w, h };
    const t = SOMA_NET_CALIBRATION.normal;
    const net = { engine: 'cpu', dots: [{ x: 22, y: 21, score: t + .3 }, { x: 61, y: 39, score: t + .1 }, { x: 40, y: 50, score: t }, { x: 10, y: 50, score: t - .01 }] };
    const r = netFilters(props, p, net, C);
    assert.equal(r.cells.length, 3, 'centres at or above the threshold are counted');
    assert.equal(r.rej.model, 1); assert.equal(r.rej.netMatched, 2); assert.equal(r.rej.netOwn, 1);
    assert.deepEqual([r.cells[0].x, r.cells[0].y, r.cells[0].area, r.cells[0].contrast], [22, 21, 90, 200], 'a matched centre keeps its position and takes the candidate\'s measurements');
    assert.ok(r.cells.every(c => isFinite(c.modelScore)), 'network cells carry modelScore, so the automatic floor leaves them alone');
    assert.equal(r.cells[2].contrast, 10, 'an unmatched centre is measured in a disc against the local background');
    assert.equal(r.rej.modelId, 'somaNet-v1'); assert.equal(r.rej.modelThreshold, t);
    const cached = finalCells(props, p, Object.assign({}, C, { net: { normal: net } }));
    assert.ok(!cached.then, 'cached centres answer synchronously');
    assert.ok(!finalCells(props, Object.assign({}, p, { cellModel: 'rules' }), C).then, 'the rules path stays synchronous');
    /* The page offers it as the default and shows how it ran. */
    const html = fs.readFileSync('index.html', 'utf8');
    assert.match(html, /<option value="somaNet-v1" selected>Cell-centre network \(somaNet v1\)<\/option>/);
    assert.match(fs.readFileSync('src/soma/10-input-display.part.js', 'utf8'), /cell centres found by \$\{m\.rej\.modelId\} \(\$\{m\.rej\.modelEngine === 'webgpu' \? 'GPU' : 'JavaScript, no WebGPU'\}\)/);
    assert.match(fs.readFileSync('src/soma/00-bootstrap-worker.part.js', 'utf8'), /engine: m\.rej\.modelEngine, centres_on_detector_candidates: m\.rej\.netMatched/);
    assert.match(src, /@compute @workgroup_size\(16,8,1\)/, 'the WebGPU convolution must stay in the worker');
    console.log('test_model_parity: somaNet v1 ok');
})();

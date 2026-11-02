'use strict';
const $ = id => document.getElementById(id);
const clamp = (v, a, b) => v < a ? a : v > b ? b : v;
const PALETTE = ['#5ad3b0', '#6fa8f5', '#e8b563', '#f2778a', '#c78bf0', '#7fd9e8', '#b6e07a', '#f0a06a'];
const S = {
    sections: [], idx: -1, image: null, cells: [], regions: [], activeRegion: -1,
    tool: 'add', zoom: 1, fit: 1, showOv: true, showRegions: true, busy: false, run: null, worker: null,
    z: null, soma: null, rej: null, seeds: 0, poly: [], queue: [], qi: 0, dirty: false,
    results: new Map(), lastRun: null, removedAutoIds: new Set(), activeAnalysisValue: null,
    colocFloorTouched: false, colocFloorAuto: false,
    autoFloorRef: null, autoColocFloorRef: null,
    /* Display-only state.  A newly loaded multichannel image opens as the full
       colour merge, so no individual channel button should appear selected even
       though chDetect still holds a sensible detector default underneath. */
    mergePreview: false,
    /* Last pointer position inside the microscopy viewport.  Keyboard zoom uses
       this screen-space point so the image location under the cursor stays put. */
    zoomCursor: null,
    /* Review display can use a half-resolution copy while all scientific
       coordinates remain in the original native pixel coordinate system. */
    displayScaleX: 1, displayScaleY: 1
};
/* ---------------------------- worker ---------------------------------- */
let workerClient = null;
function initWorker() {
    S.worker = new Worker('assets/soma-detector-worker.js');
    workerClient = ToolkitCore.worker.createRequestClient(S.worker, { onEvent: (m, e) => onWorkerMessage(e), isFinal: m => m.type === 'result', isError: m => m.type === 'error' });
    S.worker.onerror = e => { setEngine('err', 'worker failed'); setStatus('Worker error: ' + e.message); setBusy(false); workerClient?.close(new Error(e.message || 'Soma detector worker failed.')); resolveAllAutoDonutProbes('detector worker failed'); };
}
const autoDonutProbeResolvers = new Map();
function resolveAllAutoDonutProbes(reason) {
    for (const [token, r] of autoDonutProbeResolvers) {
        autoDonutProbeResolvers.delete(token);
        r({ type: 'autoDonutProbeResult', token, probe: null, error: reason });
    }
}
function onWorkerMessage(e) {
    const m = e.data;
    if (m.type === 'autoDonutProbeResult') {
        const r = autoDonutProbeResolvers.get(m.token);
        if (r) {
            autoDonutProbeResolvers.delete(m.token);
            r(m);
        }
        return;
    }
    if (m.type === 'stage') {
        setStatus(m.msg + '…');
        analysisProgressStage(m);
        tabProgressStage(m.msg, m.pct);
        return;
    }
    if (m.type === 'checkpoint') {
        analysisProgressCheckpoint(m.msg);
        return;
    }
    if (m.type === 'error') {
        setStatus('Detection failed: ' + m.msg);
        setEngine('err', 'error');
        setBusy(false);
        return;
    }
    if (m.type === 'result') {
        S.allCells = m.cells.map((c, i) => Object.assign(c, { id: i + 1, region: -1 }));
        fitContrastSlider();
        if (!S.floorTouched)
            placeFloorAutomatically();
        fitColocFloorSlider();
        if (parseDetect().merge && !S.colocFloorTouched)
            placeColocFloorAutomatically();
        drawColocHist();
        syncLabels();
        S.cells = S.allCells.filter(c => passesFloor(c) && passesColocFloor(c));
        syncColocFloorVisibility();
        S.manualRemoved = 0;
        S.removedAutoIds = new Set();
        updateUndo();
        S.autoCount = m.cells.length;
        if (!S.decisions)
            S.decisions = [];
        S.rej = m.rej;
        if (S.lastRun)
            S.lastRun.classifier = m.rej && m.rej.modelId
                ? Object.assign({ id: m.rej.modelId, sha256: m.rej.modelSha256, threshold: m.rej.modelThreshold, imageQuality: m.rej.modelImageQuality, insideValidatedRange: !!m.rej.modelInDomain },
                    m.rej.modelEngine ? { engine: m.rej.modelEngine, centres_on_detector_candidates: m.rej.netMatched, centres_measured_alone: m.rej.netOwn } : {})
                : { id: 'rules' };
        S.seeds = m.seeds;
        if (m.z) {
            S.z = m.z;
            S.soma = m.soma;
        }
        assignRegions();
        buildQueue();
        saveResult();
        drawBase();
        drawOverlay();
        updateStats();
        updateColoc();
        renderRegionTable();
        analysisProgressFinish(m);
        setBusy(false);
        setStatus(`${S.cells.length} somata · ${m.seeds} candidate seeds${m.cached ? ' · filters only' : ''}${m.rej && m.rej.modelId ? ` · ${m.rej.modelId}${m.rej.modelInDomain ? '' : (m.rej.modelEngine ? ' · minimum diameter OUTSIDE validated range' : ' · image quality OUTSIDE validated range')}` : ''}`);
        setEngine('ok', 'ready');
    }
}

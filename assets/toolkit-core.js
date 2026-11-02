/* Toolkit shared core v2.6.0
   Shared infrastructure only: tool-specific scientific policies stay in each page. */
(function (global) {
    'use strict';
    const Core = { version: '2.6.0' };
    const clamp = (v, a, b) => Math.max(a, Math.min(b, Number(v) || 0));
    const cloneRgb = rgb => (Array.isArray(rgb) ? rgb : [255, 255, 255]).slice(0, 3).map(v => clamp(Math.round(v), 0, 255));
    const rgbHex = rgb => '#' + cloneRgb(rgb).map(v => v.toString(16).padStart(2, '0')).join('');
    // Single quotes are escaped too: every application-local copy of this helper
    // already did, and without it the shared version is unsafe in a single-quoted
    // attribute, which is the one place callers are most likely to assume it is safe.
    const escapeHtml = s => String(s ?? '').replace(/[&<>\"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '\"': '&quot;', "'": '&#39;' }[c]));
    /* The Pyodide runtime, NumPy and the nd2 reader are part of the site
       (assets/vendor/pyodide/v314.0.6/, checked against vendor-lock.json), so
       ND2 files open offline and on networks that block jsDelivr or PyPI. The
       CDN is a fallback only. The folder is found from this script's own
       address, which is right both in pages and in the engine worker. */
    const scriptHref = (global.document && global.document.currentScript && global.document.currentScript.src) || (global.location && global.location.href) || '';
    const localPyodide = (() => { try {
        return new URL('vendor/pyodide/v314.0.6/', /\/assets\//.test(scriptHref) ? scriptHref : new URL('assets/', scriptHref)).href;
    }
    catch {
        return null;
    } })();
    /* This file's own version, from the ?h= the page loaded it with (empty in
       a worker, or where the build has not tagged it). */
    const coreVersionTag = (() => { try {
        const src = global.document?.currentScript?.src || '';
        return src ? (new URL(src).searchParams.get('h') || '') : '';
    }
    catch {
        return '';
    } })();
    Core.nd2 = {
        packageSpec: 'nd2==0.11.3',
        nd2Wheel: 'nd2-0.11.3-py3-none-any.whl',
        localPyodideBase: localPyodide,
        pyodideBases: [localPyodide, 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/'].filter(Boolean),
        /* NumPy and the nd2 reader. From the site's own copy the wheels are
           loaded directly (no package index); from the CDN, micropip fetches
           nd2 from PyPI as before. */
        async loadNd2Packages(py, base) {
            if (base === this.localPyodideBase) {
                await py.loadPackage(['numpy', 'typing-extensions', base + this.nd2Wheel]);
                await py.runPythonAsync('import nd2');
                return;
            }
            await py.loadPackage(['numpy', 'micropip']);
            await py.runPythonAsync(`import micropip\ntry:\n    await micropip.install(["typing_extensions>=4.6.0", "${this.packageSpec}"], deps=False)\n    import nd2\nexcept Exception:\n    await micropip.install("${this.packageSpec}")\n    import nd2`);
        },
        /* The wheels the site's copy holds (beside nd2Wheel). */
        bundledWheels: ['numpy-2.4.6-cp314-cp314-pyemscripten_2026_0_wasm32.whl', 'typing_extensions-4.15.0-py3-none-any.whl', 'zstandard-0.25.0-cp314-cp314-pyemscripten_2026_0_wasm32.whl'],
        /* loadPyodide's options for a base. The site's copy holds only what the
           ND2 reader needs; every other package in Pyodide's list (micropip, and
           through it the TIFF and ND2 writers Image Prep's raw exports install)
           is pointed at the same release on the CDN, as it was before the
           runtime was bundled, instead of at files the site does not have. */
        async pyodideOptions(base) {
            if (base !== this.localPyodideBase)
                return { indexURL: base };
            const r = await fetch(base + 'pyodide-lock.json');
            if (!r.ok)
                throw new Error(`Could not load Pyodide's package list (HTTP ${r.status}).`);
            const lock = await r.json(), cdn = this.pyodideBases.find(b => b !== base) || 'https://cdn.jsdelivr.net/pyodide/v314.0.6/full/', here = new Set(this.bundledWheels);
            for (const p of Object.values(lock.packages || {}))
                if (p && p.file_name && !here.has(p.file_name) && !/^[a-z]+:/i.test(p.file_name))
                    p.file_name = cdn + p.file_name;
            return { indexURL: base, packageBaseUrl: base, lockFileContents: lock };
        },
        sharedHelperUrl: 'assets/nd2-display-helper.py',
        /* Spelled in two parts so the release build does not version it (?h=):
           the worker's own import names this file's version, and each naming
           the other's would never settle. The version that matters is added
           below, from this file's own. */
        engineWorkerUrl: ['assets', 'nd2-engine-worker.mjs'].join('/'),
        engineWorkerName: 'toolkit-nd2-engine-v2-4-0',
        /* The engine as this page starts it, at this file's version (?core=). The
           worker's import of this file carries the same version, written by the
           build: an untagged import could be answered from the browser's cache
           with an older toolkit-core.js, which paired v2.67's worker with a copy
           lacking pyodideOptions and stopped every ND2 from opening. The name
           carries the version too, so a tab left open from an earlier release
           keeps its own engine instead of blocking this one's. */
        engineWorkerUrlForPage() {
            const tag = coreVersionTag;
            return tag ? this.engineWorkerUrl + (this.engineWorkerUrl.includes('?') ? '&' : '?') + 'core=' + encodeURIComponent(tag) : this.engineWorkerUrl;
        },
        engineWorkerNameForPage() {
            const url = this.engineWorkerUrlForPage();
            let h = 0;
            for (let i = 0; i < url.length; i++)
                h = (Math.imul(h, 31) + url.charCodeAt(i)) | 0;
            return `${this.engineWorkerName}-${(h >>> 0).toString(36)}`;
        },
        async loadSharedHelper() {
            if (this._helperSource)
                return this._helperSource;
            const r = await fetch(this.sharedHelperUrl, { cache: 'no-cache' });
            if (!r.ok)
                throw new Error(`Could not load shared ND2 helper (HTTP ${r.status}).`);
            this._helperSource = await r.text();
            return this._helperSource;
        },
        async bootPyodide({ bases = this.pyodideBases, onStage = () => { }, timeoutMs = 90000 } = {}) {
            if (!('WebAssembly' in global))
                throw new Error('This browser does not support WebAssembly.');
            let last = null;
            for (const base of bases) {
                try {
                    onStage('runtime', .15, 'Starting Pyodide runtime…');
                    const mod = await Promise.race([
                        import(base + 'pyodide.mjs'),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('Pyodide loader timed out.')), Math.min(timeoutMs, 20000)))
                    ]);
                    const py = await Promise.race([
                        this.pyodideOptions(base).then(opts => mod.loadPyodide(opts)),
                        new Promise((_, rej) => setTimeout(() => rej(new Error('Pyodide runtime timed out.')), timeoutMs))
                    ]);
                    onStage('numpy', .38, 'Loading NumPy and the ND2 reader…');
                    await this.loadNd2Packages(py, base);
                    return { pyodide: py, base };
                }
                catch (e) {
                    last = e;
                }
            }
            throw last || new Error('Could not initialize Pyodide/ND2 runtime.');
        },
        menuPrewarmEngineId() { try {
            return global.sessionStorage?.getItem('toolkitNd2MenuEngineId') || null;
        }
        catch {
            return null;
        } },
        hasMenuPrewarmMarker() { return Boolean(this.menuPrewarmEngineId()); },
        isMenuPrewarmed(info) {
            const engineId = info?.engineId || info?.status?.engineId || null;
            return Boolean(engineId && this.menuPrewarmEngineId() === engineId);
        },
        connectEngine({ start = true, onStatus = null, onProgress = null } = {}) {
            this._lastConnectError = '';
            if (!global.location || !/^https?:$/.test(global.location.protocol)) {
                this._lastConnectError = `ND2 sharing requires http:// or https:// (current protocol: ${global.location?.protocol || 'unknown'}). Use START_HERE.command for local testing.`;
                return null;
            }
            const id = (global.crypto?.randomUUID?.() || ('c' + Date.now().toString(36) + Math.random().toString(36).slice(2))).replace(/[^A-Za-z0-9_-]/g, '');
            let worker = null, port = null, dedicated = false, constructorError = null;
            try {
                if ('SharedWorker' in global) {
                    try {
                        worker = new global.SharedWorker(this.engineWorkerUrlForPage(), { name: this.engineWorkerNameForPage(), type: 'module', credentials: 'same-origin', extendedLifetime: true });
                    }
                    catch (firstError) {
                        constructorError = firstError;
                        worker = new global.SharedWorker(this.engineWorkerUrlForPage(), { name: this.engineWorkerNameForPage(), type: 'module', credentials: 'same-origin' });
                    }
                    port = worker.port;
                    port.start();
                }
                else if ('Worker' in global) {
                    worker = new global.Worker(this.engineWorkerUrlForPage(), { type: 'module', credentials: 'same-origin' });
                    port = worker;
                    dedicated = true;
                }
                else {
                    this._lastConnectError = 'This browser exposes neither SharedWorker nor Worker.';
                    return null;
                }
            }
            catch (error) {
                this._lastConnectError = `Could not create ND2 worker: ${error?.message || error}${constructorError ? ` (extended-lifetime attempt: ${constructorError?.message || constructorError})` : ''}`;
                return null;
            }
            let seq = 0, status = null, closed = false;
            const pending = new Map(), statusListeners = new Set(), progressListeners = new Set();
            if (typeof onStatus === 'function')
                statusListeners.add(onStatus);
            if (typeof onProgress === 'function')
                progressListeners.add(onProgress);
            const failConnection = error => {
                const detail = String(error?.message || error || 'Shared ND2 worker failed to load.');
                this._lastConnectError = detail;
                status = { state: 'error', phase: 'worker', fraction: 0, label: 'Shared ND2 worker failed', error: detail };
                for (const fn of [...statusListeners])
                    try {
                        fn(status);
                    }
                    catch { }
                for (const q of pending.values())
                    q.reject(new Error(detail));
                pending.clear();
            };
            try {
                worker.addEventListener?.('error', ev => failConnection(ev?.error || new Error(ev?.message || 'ND2 worker script failed to load.')));
            }
            catch { }
            const handle = e => {
                const msg = e.data || {};
                if (msg.type === 'status') {
                    status = msg.status || msg;
                    for (const fn of [...statusListeners])
                        try {
                            fn(status);
                        }
                        catch { }
                    return;
                }
                if (msg.type === 'progress') {
                    for (const fn of [...progressListeners])
                        try {
                            fn(msg.progress || msg);
                        }
                        catch { }
                    return;
                }
                if (msg.type === 'rpc-result') {
                    const q = pending.get(msg.id);
                    if (!q)
                        return;
                    pending.delete(msg.id);
                    if (msg.ok)
                        q.resolve(msg.value);
                    else
                        q.reject(new Error(msg.error || 'ND2 worker request failed.'));
                }
            };
            port.addEventListener?.('message', handle);
            if (!port.addEventListener)
                port.onmessage = handle;
            const send = (op, payload = {}, transfer = []) => new Promise((resolve, reject) => {
                if (closed) {
                    reject(new Error('ND2 engine connection is closed.'));
                    return;
                }
                const rid = `${id}:${++seq}`;
                pending.set(rid, { resolve, reject });
                try {
                    port.postMessage({ type: 'rpc', id: rid, clientId: id, op, payload }, transfer);
                }
                catch (e) {
                    pending.delete(rid);
                    reject(e);
                }
            });
            const client = {
                id, dedicated,
                status: () => status,
                onStatus(fn) { if (typeof fn === 'function') {
                    statusListeners.add(fn);
                    if (status)
                        queueMicrotask(() => fn(status));
                } return () => statusListeners.delete(fn); },
                onProgress(fn) { if (typeof fn === 'function')
                    progressListeners.add(fn); return () => progressListeners.delete(fn); },
                async ready() { const info = await send('init'); return { ...(info || {}), engineId: info?.engineId || info?.status?.engineId || status?.engineId || null }; },
                ensureHelper(helperId, source) { return send('ensureHelper', { helperId: String(helperId), source: String(source) }); },
                run(helperId, code, globals = {}, mode = 'eval') { return send('run', { helperId: String(helperId), code: String(code), globals, mode }); },
                runGlobal(code, globals = {}, mode = 'exec') { return send('runGlobal', { code: String(code), globals, mode }); },
                async writeFile(path, data) {
                    let u8 = data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer());
                    const copy = u8.byteOffset === 0 && u8.byteLength === u8.buffer.byteLength ? u8 : new Uint8Array(u8);
                    const buf = copy.buffer;
                    return send('writeFile', { path: String(path), buffer: buf }, [buf]);
                },
                /* The file is mounted where the engine can read it in place (only the parts
                   asked for), so files bigger than memory open; copying is the fallback. */
                async writeBrowserFile(path, file) {
                    try {
                        const r = await send('mountFile', { path: String(path), file });
                        if (r?.mounted)
                            return true;
                    }
                    catch { }
                    return this.writeFile(path, new Uint8Array(await file.arrayBuffer()));
                },
                async readFile(path) { const v = await send('readFile', { path: String(path) }); return v instanceof Uint8Array ? v : new Uint8Array(v); },
                unlink(path) { return send('unlink', { path: String(path) }); },
                mkdirTree(path) { return send('mkdirTree', { path: String(path) }); },
                exists(path) { return send('exists', { path: String(path) }); },
                tempPath(name = 'file') { const safe = String(name).replace(/[^A-Za-z0-9_.-]+/g, '_').slice(-120) || 'file'; return `/tmp/tk_${id}_${safe}`; },
                close() { if (closed)
                    return; closed = true; try {
                    port.postMessage({ type: 'detach', clientId: id });
                }
                catch { } try {
                    port.close?.();
                }
                catch { } for (const q of pending.values())
                    q.reject(new Error('ND2 engine connection closed.')); pending.clear(); if (dedicated)
                    try {
                        worker.terminate();
                    }
                    catch { } }
            };
            port.postMessage({ type: 'attach', clientId: id, start: Boolean(start) });
            // Release only this page's helper namespace during a real navigation/close.
            // Keep it for BFCache so Back/Forward can resume without rebuilding page state.
            if (global.addEventListener) {
                global.addEventListener('pagehide', ev => {
                    if (ev?.persisted || closed)
                        return;
                    try {
                        port.postMessage({ type: 'detach', clientId: id });
                    }
                    catch { }
                }, { once: true });
            }
            return client;
        },
        async mountFile(py, file, { mountDir = '/toolkit_nd2', fallbackPath = '/tmp/toolkit.nd2' } = {}) {
            try {
                py.FS.unmount(mountDir);
            }
            catch { }
            try {
                py.FS.mkdir(mountDir);
            }
            catch { }
            try {
                py.FS.mount(py.FS.filesystems.WORKERFS, { files: [file] }, mountDir);
                return `${mountDir}/${file.name}`;
            }
            catch (_) {
                const bytes = new Uint8Array(await file.arrayBuffer());
                try {
                    py.FS.unlink(fallbackPath);
                }
                catch { }
                py.FS.writeFile(fallbackPath, bytes);
                return fallbackPath;
            }
        }
    };
    // If this tab arrived from a fully warmed Tools menu, immediately attach a
    // lightweight port to keep the already-running SharedWorker resident while the
    // user configures the tool. start:false never boots a replacement runtime if
    // the old worker is gone; if needed it creates only an idle worker shell until a tool requests the runtime.
    if (global.document && 'SharedWorker' in global && Core.nd2.hasMenuPrewarmMarker()) {
        queueMicrotask(() => { if (!Core.nd2._pageHold)
            Core.nd2._pageHold = Core.nd2.connectEngine({ start: false }); });
    }
    Core.colors = {
        green: [0, 255, 0], magenta: [255, 0, 255], cyan: [0, 255, 255], red: [255, 0, 0], blue: [0, 0, 255], yellow: [255, 255, 0], grayscale: [255, 255, 255], orange: [255, 128, 0],
        mergeGreen: [0, 255, 76], mergeMagenta: [255, 0, 255], tripleRed: [255, 0, 0], tripleBlue: [0, 0, 255], tripleGreen: [0, 255, 0]
    };
    Core.colors.lutPresets = Object.freeze([
        { key: 'original', label: 'Original / Source LUT', rgb: null },
        { key: 'grayscale', label: 'Grayscale', rgb: Core.colors.grayscale },
        { key: 'green', label: 'Green', rgb: Core.colors.green },
        { key: 'magenta', label: 'Magenta', rgb: Core.colors.magenta },
        { key: 'cyan', label: 'Cyan', rgb: Core.colors.cyan },
        { key: 'red', label: 'Red', rgb: Core.colors.red },
        { key: 'blue', label: 'Blue', rgb: Core.colors.blue },
        { key: 'yellow', label: 'Yellow', rgb: Core.colors.yellow },
        { key: 'orange', label: 'Orange', rgb: Core.colors.orange }
    ]);
    Core.colors.lutOptionsHtml = function ({ originalLabel = 'Original / Source LUT', originalValue = 'original', grayscaleValue = 'grayscale' } = {}) {
        return Core.colors.lutPresets.map(p => {
            const value = p.key === 'original' ? originalValue : (p.key === 'grayscale' ? grayscaleValue : p.key);
            const label = p.key === 'original' ? originalLabel : p.label;
            return `<option value=\"${value}\">${label}</option>`;
        }).join('');
    };
    Core.colors.rgbToHex = function (rgb) { const a = Array.isArray(rgb) ? rgb : [255, 255, 255]; return '#' + a.slice(0, 3).map(v => Math.max(0, Math.min(255, Math.round(Number(v) || 0))).toString(16).padStart(2, '0')).join(''); };
    /* Far-red channels are shown in orange -- Fiji's Orange LUT, (255,128,0),
       which is what far-red images exported from Fiji carry -- and the Orange
       colour choice IS that colour, so choosing Orange makes any image look
       exactly like a far-red channel. Three slightly different oranges used to
       stand for far red (#ff8a00 for its labels, #ff9a3c on Soma's channel
       buttons, #ff8000 for the Orange choice), so recolouring a far-red channel
       Orange visibly changed it. Everything that colours a far-red channel reads
       this one value. */
    Core.colors.farRed = Core.colors.orange;
    Core.colors.farRedHex = Core.colors.rgbToHex(Core.colors.farRed);
    Core.colors.hexToRgb = function (hex) { const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || '')); if (!m)
        return [255, 255, 255]; const n = parseInt(m[1], 16); return [(n >> 16) & 255, (n >> 8) & 255, n & 255]; };
    Core.colors.genericPresetOptionsHtml = function ({ includeOriginal = false, originalLabel = 'Source LUT', includeCustom = true } = {}) {
        const rows = [];
        if (includeOriginal)
            rows.push(`<option value=\"original\">${originalLabel}</option>`);
        for (const p of Core.colors.lutPresets) {
            if (p.key === 'original')
                continue;
            const label = p.key === 'grayscale' ? 'White / Grayscale' : p.label;
            rows.push(`<option value=\"${p.key}\">${label}</option>`);
        }
        if (includeCustom)
            rows.push('<option value=\"custom\">Custom color…</option>');
        return rows.join('');
    };
    Core.colors.presetKeyForHex = function (hex, { originalHex = null } = {}) {
        const h = String(hex || '').toLowerCase();
        if (originalHex && h === String(originalHex).toLowerCase())
            return 'original';
        for (const p of Core.colors.lutPresets) {
            if (!p.rgb || p.key === 'original')
                continue;
            if (Core.colors.rgbToHex(p.rgb).toLowerCase() === h)
                return p.key;
        }
        return 'custom';
    };
    Core.colors.syncPresetPicker = function (input) {
        if (!input || !input._tkLutSelect)
            return;
        input._tkLutSelect.value = Core.colors.presetKeyForHex(input.value, { originalHex: input._tkLutOriginalHex || null });
    };
    Core.colors.enhanceColorInput = function (input, { includeOriginal = null, originalHex = null, originalLabel = 'Source LUT' } = {}) {
        if (!input || input.type !== 'color')
            return null;
        if (input.dataset.tkLutEnhanced === '1') {
            Core.colors.syncPresetPicker(input);
            return input._tkLutSelect || null;
        }
        const sourceHex = originalHex || input.dataset.lutSource || null;
        const useOriginal = includeOriginal == null ? Boolean(sourceHex) : Boolean(includeOriginal);
        const parent = input.parentNode;
        if (!parent)
            return null;
        const wrap = document.createElement('span');
        wrap.className = 'tk-color-lut-control';
        parent.insertBefore(wrap, input);
        wrap.appendChild(input);
        const sel = document.createElement('select');
        sel.className = 'tk-color-lut-select';
        sel.setAttribute('aria-label', (input.getAttribute('aria-label') || input.title || 'Color') + ' preset');
        sel.innerHTML = Core.colors.genericPresetOptionsHtml({ includeOriginal: useOriginal, originalLabel });
        wrap.appendChild(sel);
        input.dataset.tkLutEnhanced = '1';
        input._tkLutSelect = sel;
        input._tkLutOriginalHex = sourceHex ? String(sourceHex).toLowerCase() : null;
        const setFromPreset = () => { const key = sel.value; if (key === 'custom')
            return; let hex = null; if (key === 'original')
            hex = input._tkLutOriginalHex;
        else {
            const p = Core.colors.lutPresets.find(x => x.key === key);
            if (p?.rgb)
                hex = Core.colors.rgbToHex(p.rgb);
        } if (!hex)
            return; input.value = hex; input.dispatchEvent(new Event('input', { bubbles: true })); input.dispatchEvent(new Event('change', { bubbles: true })); };
        sel.addEventListener('change', setFromPreset);
        input.addEventListener('input', () => Core.colors.syncPresetPicker(input));
        Core.colors.syncPresetPicker(input);
        return sel;
    };
    Core.colors.enhanceColorInputs = function (root = document, opts = {}) {
        const nodes = [];
        if (root?.matches?.('input[type=\"color\"]'))
            nodes.push(root);
        if (root?.querySelectorAll)
            nodes.push(...root.querySelectorAll('input[type=\"color\"]'));
        nodes.forEach(input => Core.colors.enhanceColorInput(input, opts));
        return nodes.length;
    };
    Core.colors.compositeSchemes = {
        mg: [{ name: 'Magenta', rgb: Core.colors.mergeMagenta }, { name: 'Green', rgb: Core.colors.mergeGreen }],
        cr: [{ name: 'Cyan', rgb: Core.colors.cyan }, { name: 'Red', rgb: Core.colors.red }],
        yb: [{ name: 'Yellow', rgb: Core.colors.yellow }, { name: 'Blue', rgb: Core.colors.blue }]
    };
    Core.colors.tripleScheme = [{ name: 'Red', rgb: Core.colors.tripleRed }, { name: 'Blue', rgb: Core.colors.tripleBlue }, { name: 'Green', rgb: Core.colors.tripleGreen }];
    /* Fluorophores and dyes by the name people put in file names and channel names, with
       their emission peak in nm. The colour and family come from the wavelength, so this
       stays one line per dye: to teach it a new one, add a name and its emission. The label
       shown stays the name as written (mKate2 stays mKate2). */
    const FLUOR_EMISSION = [
        ['ebfp2', 448], ['ebfp', 448], ['mtagbfp2', 454], ['tagbfp', 457], ['mturquoise2', 474], ['mturquoise', 474], ['cerulean', 475], ['mcerulean3', 479], ['ecfp', 475], ['azurite', 450],
        ['dapi', 461], ['hoechst', 461], ['draq5', 681], ['sytoxgreen', 523], ['sytoxblue', 480], ['propidiumiodide', 617], ['toproiii', 661], ['nissl', 500],
        ['egfp', 507], ['sfgfp', 510], ['gfp', 509], ['mneongreen', 517], ['mclover3', 515], ['clover', 515], ['zsgreen', 505], ['acgfp', 505], ['emerald', 509], ['mgreenlantern', 510],
        ['eyfp', 527], ['yfp', 527], ['mvenus', 528], ['venus', 528], ['mcitrine', 529], ['citrine', 529], ['ypet', 530], ['mgold', 529],
        ['mko2', 565], ['mkusabiraorange', 561], ['morange2', 565], ['dsred', 583], ['dsred2', 587], ['mruby3', 600], ['mruby2', 600], ['mscarlet3', 598], ['mscarleti', 593], ['mscarlet', 594],
        ['tdtomato', 581], ['mtomato', 581], ['mstrawberry', 596], ['mcherry', 610], ['mrfp', 607], ['rfp', 607], ['mapple', 592], ['mraspberry', 625], ['mplum', 649], ['mkate2', 633], ['mkate', 635], ['katushka', 635], ['mneptune', 650],
        ['irfp670', 670], ['irfp713', 713], ['irfp720', 720], ['miraffe', 670], ['smurf', 642],
        ['alexa350', 442], ['alexa405', 421], ['alexa430', 541], ['alexa488', 519], ['alexa514', 540], ['alexa532', 554], ['alexa546', 573], ['alexa555', 565], ['alexa568', 603], ['alexa594', 617], ['alexa633', 647], ['alexa647', 668], ['alexa680', 702], ['alexa700', 723], ['alexa750', 775],
        ['atto488', 523], ['atto550', 576], ['atto565', 592], ['atto594', 624], ['atto647n', 664], ['atto655', 684],
        ['cf405', 431], ['cf488', 515], ['cf568', 583], ['cf594', 615], ['cf640r', 664], ['cf680', 701],
        ['dylight405', 421], ['dylight488', 518], ['dylight550', 576], ['dylight650', 672], ['dylight755', 776],
        ['fitc', 519], ['tritc', 572], ['texasred', 615], ['rhodamine', 576], ['trite', 572], ['cy2', 506], ['cy3', 566], ['cy35', 596], ['cy5', 670], ['cy55', 694], ['cy7', 776],
        ['fluo4', 516], ['gcamp6', 513], ['gcamp7', 513], ['gcamp8', 513], ['gcamp', 513], ['rcamp', 585], ['jrgeco', 592], ['jgcamp', 513], ['tmrm', 573], ['mitotracker', 599], ['lysotracker', 511], ['phalloidin', 0]
    ];
    const FLUOR_RULES = [
        { key: 'dapi', name: 'DAPI', tokens: ['dapi', 'hoechst', '405', 'bfp'], hex: '#4a6eff' },
        { key: 'cfp', name: 'CFP', tokens: ['cfp', 'alexa430', 'alexa440', 'cyan'], hex: '#00dcff' },
        { key: 'fitc', name: 'FITC', tokens: ['fitc', 'gfp', '488', 'alexa488', 'zsgreen', 'green'], hex: '#00ff50' },
        { key: 'yfp', name: 'YFP', tokens: ['yfp', 'venus', 'yellow'], hex: '#ffeb00' },
        { key: 'cy3', name: 'Cy3', tokens: ['cy3', 'tritc', '555', '561', '568', 'alexa555', 'alexa568', 'orange'], hex: '#ff2d2d' },
        { key: 'texasred', name: 'Texas Red', tokens: ['tdtomato', 'texasred', 'mcherry', '594', 'alexa594', 'red'], hex: '#ff3b30' },
        { key: 'cy5', name: 'Cy5', tokens: ['cy5', '647', '640', 'alexa647'], hex: Core.colors.farRedHex }
    ];
    Core.channels = {
        fluorRules: FLUOR_RULES,
        normalizeName: s => String(s || '').trim().toLowerCase().replace(/[^a-z0-9]+/g, ''),
        fluorEmission: FLUOR_EMISSION,
        /* Family (and so the colour) for an emission wavelength. */
        familyForEmission(nm) { const e = Number(nm); if (!Number.isFinite(e) || e <= 0)
            return null; const key = e < 480 ? 'dapi' : e < 505 ? 'cfp' : e < 522 ? 'fitc' : e < 555 ? 'yfp' : e < 600 ? 'cy3' : e < 645 ? 'texasred' : 'cy5'; return FLUOR_RULES.find(x => x.key === key) || null; },
        /* The dye a name mentions, e.g. "slice3_mKate2_20x.tif" -> mKate2 at 633 nm. The
           longest match wins, so mScarlet-I is not read as mScarlet. */
        dyeInName(name) {
            const s = this.normalizeName(name);
            if (!s)
                return null;
            let best = null;
            for (const [token, nm] of FLUOR_EMISSION)
                if (s.includes(token) && (!best || token.length > best.token.length))
                    best = { token, nm };
            if (!best)
                return null;
            const fam = this.familyForEmission(best.nm);
            /* The name as written in the file, with its own capitals. */
            const raw = String(name || ''), at = raw.toLowerCase().replace(/[^a-z0-9]+/g, '').indexOf(best.token);
            let shown = best.token;
            if (at >= 0) {
                let seen = 0, start = -1, end = -1;
                for (let i = 0; i < raw.length; i++) {
                    if (!/[a-z0-9]/i.test(raw[i]))
                        continue;
                    if (seen === at)
                        start = i;
                    if (seen === at + best.token.length - 1) {
                        end = i + 1;
                        break;
                    }
                    seen++;
                }
                if (start >= 0 && end > start)
                    shown = raw.slice(start, end);
            }
            return { key: fam ? fam.key : 'other', name: shown, hex: fam ? fam.hex : '#ffffff', emissionNm: best.nm || 0, raw: shown };
        },
        inferIdentity(name, emissionNm) {
            const raw = String(name || '').trim(), s = this.normalizeName(raw);
            if (s.includes('farred'))
                return { key: 'cy5', name: 'Cy5', hex: Core.colors.farRedHex, raw };
            /* A named dye (mKate2, EBFP2, Alexa 647…) keeps its own name and takes its
               colour from its emission; the broader families below catch the rest. */
            const dye = this.dyeInName(raw);
            if (dye && dye.key !== 'other')
                return { ...dye, raw };
            for (const r of FLUOR_RULES)
                if (r.tokens.some(t => s.includes(t)))
                    return { key: r.key, name: r.name, hex: r.hex, raw };
            const e = Number(emissionNm);
            if (Number.isFinite(e) && e > 0) {
                const key = e < 480 ? 'dapi' : e < 510 ? 'cfp' : e < 555 ? 'fitc' : e < 590 ? 'yfp' : e < 640 ? 'cy3' : 'cy5', r = FLUOR_RULES.find(x => x.key === key);
                return { key: r.key, name: r.name, hex: r.hex, raw };
            }
            return { key: 'other', name: raw || 'Channel', hex: '#ffffff', raw };
        },
        canonicalDualRole(rgb) {
            const [r, g, b] = cloneRgb(rgb), norm = Math.hypot(r, g, b);
            if (norm < 24)
                return { role: null, confidence: 0 };
            const green = g / norm, magenta = (r + b) / (Math.SQRT2 * norm), threshold = .90;
            if (green >= threshold && green >= magenta)
                return { role: 'green', confidence: green };
            if (magenta >= threshold && magenta > green)
                return { role: 'magenta', confidence: magenta };
            return { role: null, confidence: Math.max(green, magenta) };
        },
        channelDescriptor(value) {
            if (Array.isArray(value))
                return { rgb: value, key: 'other', name: '', emissionNm: null };
            const src = value && typeof value === 'object' ? value : {};
            const rgb = Array.isArray(src.rgb) ? src.rgb : Array.isArray(src.color) ? src.color : [255, 255, 255];
            let key = String(src.key || src.identityKey || '').trim().toLowerCase();
            const name = String(src.name || src.label || src.channelName || '');
            const emissionNm = src.emissionNm ?? src.emission ?? src.wavelengthNm ?? null;
            if (!key || key === 'other')
                key = this.inferIdentity(name, emissionNm).key;
            return { rgb, key: key || 'other', name, emissionNm };
        },
        dualRolePriority(value) {
            const d = this.channelDescriptor(value), key = d.key;
            // Semantic M/G priorities. These deliberately dominate RGB similarity when
            // a fluorophore identity is known: red/orange/far-red families prefer
            // magenta; 488/FITC/GFP families prefer green; blue/DAPI/Hoechst are neutral
            // and take whichever role remains. Unknown/cyan/yellow channels fall back
            // to the native-color similarity score below.
            if (key === 'fitc')
                return { magenta: 0, green: 4, key, semantic: true };
            if (key === 'cy3' || key === 'texasred' || key === 'cy5')
                return { magenta: 4, green: 0, key, semantic: true };
            if (key === 'dapi')
                return { magenta: 0, green: 0, key, semantic: true };
            return { magenta: 0, green: 0, key, semantic: false };
        },
        dualRoleScores(value) {
            const d = this.channelDescriptor(value), [r, g, b] = cloneRgb(d.rgb), norm = Math.hypot(r, g, b);
            const priority = this.dualRolePriority(d);
            if (norm < 1)
                return { magenta: priority.magenta, green: priority.green, priority };
            // RGB similarity remains the fallback/tiebreaker for ambiguous identities.
            // The semantic priority above is intentionally stronger than this 0..1 term.
            return { magenta: priority.magenta + (r + b) / (Math.SQRT2 * norm), green: priority.green + g / norm, priority };
        },
        assignDual(indices, channelForIndex) {
            const [a, b] = indices;
            if (a == null || b == null)
                return { magentaIndex: a, greenIndex: b, preserved: [] };
            const da = this.channelDescriptor(channelForIndex(a)), db = this.channelDescriptor(channelForIndex(b));
            const sa = this.dualRoleScores(da), sb = this.dualRoleScores(db);
            const scoreAB = sa.magenta + sb.green; // a -> magenta, b -> green
            const scoreBA = sa.green + sb.magenta; // a -> green, b -> magenta
            // Exact/near ties retain deterministic file order. Otherwise choose the
            // orientation that best honors semantic identity, then native color.
            const swap = scoreBA > scoreAB + 1e-9;
            const magentaIndex = swap ? b : a, greenIndex = swap ? a : b;
            const ca = this.canonicalDualRole(da.rgb), cb = this.canonicalDualRole(db.rgb), preserved = [];
            if (ca.role && ((ca.role === 'magenta' && magentaIndex === a) || (ca.role === 'green' && greenIndex === a)))
                preserved.push(a);
            if (cb.role && ((cb.role === 'magenta' && magentaIndex === b) || (cb.role === 'green' && greenIndex === b)))
                preserved.push(b);
            return { magentaIndex, greenIndex, preserved, score: Math.max(scoreAB, scoreBA), identity: { [a]: sa.priority, [b]: sb.priority } };
        },
        primaryRoleScores(rgb) { const [r, g, b] = cloneRgb(rgb), n = Math.hypot(r, g, b) || 1; return { red: r / n, green: g / n, blue: b / n }; },
        assignTriple(indices, colorForIndex) {
            if (indices.length !== 3)
                return null;
            const perms = [['red', 'blue', 'green'], ['red', 'green', 'blue'], ['blue', 'red', 'green'], ['blue', 'green', 'red'], ['green', 'red', 'blue'], ['green', 'blue', 'red']];
            let best = perms[0], bestScore = -Infinity;
            for (const perm of perms) {
                let score = 0;
                for (let i = 0; i < 3; i++)
                    score += this.primaryRoleScores(colorForIndex(indices[i]))[perm[i]];
                if (score > bestScore) {
                    bestScore = score;
                    best = perm;
                }
            }
            const out = { score: bestScore };
            for (let i = 0; i < 3; i++)
                out[best[i] + 'Index'] = indices[i];
            return out;
        },
        identityInfo(value) {
            const d = this.channelDescriptor(value), rule = FLUOR_RULES.find(x => x.key === d.key), families = { dapi: 'blue-like', cfp: 'cyan-like', fitc: 'green-like', yfp: 'yellow-like', cy3: 'red/orange-like', texasred: 'red-like', cy5: 'far-red-like', other: 'native LUT' };
            return { ...d, label: rule?.name || (d.name || 'Channel'), family: families[d.key] || 'native LUT', hex: rule?.hex || rgbHex(d.rgb) };
        },
        identityBadgeHtml(value) {
            const x = this.identityInfo(value), hex = /^#[0-9a-f]{6}$/i.test(x.hex) ? x.hex : rgbHex(x.rgb);
            return `<span class="tk-channel-identity" style="--tk-chip-color:${hex}" title="Channel identity inferred from ND2 LUT, wavelength, or channel name">${escapeHtml(x.label)} · ${escapeHtml(x.family)}</span>`;
        },
        roleBadgeHtml(role, label) {
            const key = String(role || '').toLowerCase(), text = label || key.charAt(0).toUpperCase() + key.slice(1);
            return `<span class="tk-channel-role" data-role="${escapeHtml(key)}">${escapeHtml(text)}</span>`;
        },
        /* The same hue, lifted until it reads as text on a dark panel. A pure blue
           channel (0,0,255) is legible as a dot and almost invisible as a word,
           so the dot keeps the true colour and the label gets this. */
        readableInk(hex) {
            const m = /^#?([0-9a-f]{6})$/i.exec(String(hex || ''));
            if (!m)
                return '#e7edf4';
            const n = parseInt(m[1], 16), rgb = [n >> 16, (n >> 8) & 255, n & 255];
            /* Perceived lightness, not HSL lightness: yellow already reads at a
               level where blue does not. */
            const perceived = (.299 * rgb[0] + .587 * rgb[1] + .114 * rgb[2]) / 255, target = .52;
            if (perceived >= target)
                return rgbHex(rgb);
            /* Mix toward white. Perceived lightness is linear in the channels and
               the weights sum to 1, so the amount needed is exact and the hue is
               kept rather than recomputed. */
            const t = (target - perceived) / (1 - perceived);
            return rgbHex(rgb.map(v => Math.round(v + (255 - v) * t)));
        },
        /* A merge is drawn in false colours, so its caption has to say which name
           goes with which colour. Printing each channel's name IN the colour it
           was rendered in answers that at a glance, without a legend to read off
           to the side. parts: [{ label, rgb | color }]. */
        mergeLegendHtml(parts, { joiner = '+' } = {}) {
            const list = (parts || []).filter(Boolean);
            if (!list.length)
                return '';
            const chip = (p) => {
                const hex = p.color && /^#[0-9a-f]{3,8}$/i.test(p.color) ? p.color : rgbHex(p.rgb || [255, 255, 255]);
                const role = p.role ? ` data-role="${escapeHtml(String(p.role).toLowerCase())}"` : '';
                return `<span class="tk-merge-part" style="--tk-part-color:${hex};--tk-part-ink:${this.readableInk(hex)}"${role}><span class="tk-merge-dot"></span>${escapeHtml(p.label ?? '')}</span>`;
            };
            return `<span class="tk-merge-legend">${list.map(chip).join(`<span class="tk-merge-join">${escapeHtml(joiner)}</span>`)}</span>`;
        }
    };
    Core.display = {
        linearCurve: () => [[0, 0], [255, 255]],
        normalizeCurve(points) {
            const src = Array.isArray(points) ? points : this.linearCurve(), out = [];
            for (const p of src) {
                if (!Array.isArray(p) || p.length < 2)
                    continue;
                out.push([clamp(p[0], 0, 255), clamp(p[1], 0, 255)]);
            }
            out.sort((a, b) => a[0] - b[0]);
            const ded = [];
            for (const p of out) {
                if (ded.length && Math.abs(ded[ded.length - 1][0] - p[0]) < .01)
                    ded[ded.length - 1] = p;
                else
                    ded.push(p);
            }
            if (!ded.length || ded[0][0] > 0)
                ded.unshift([0, 0]);
            else
                ded[0][0] = 0;
            if (ded[ded.length - 1][0] < 255)
                ded.push([255, 255]);
            else
                ded[ded.length - 1][0] = 255;
            return ded;
        },
        defaultLevels() { return { min: 0, max: 255, brightness: 0, contrast: 0, curve: this.linearCurve(), invert: false }; },
        cloneLevels(v) { return { min: Number(v?.min ?? 0), max: Number(v?.max ?? 255), brightness: Number(v?.brightness ?? 0), contrast: Number(v?.contrast ?? 0), curve: this.normalizeCurve(v?.curve).map(p => p.slice()), invert: v?.invert === true }; },
        curveValue(points, x) { const p = this.normalizeCurve(points); x = clamp(x, 0, 255); for (let i = 1; i < p.length; i++) {
            if (x <= p[i][0]) {
                const a = p[i - 1], b = p[i], t = (x - a[0]) / Math.max(1e-9, b[0] - a[0]);
                return a[1] + (b[1] - a[1]) * t;
            }
        } return p[p.length - 1][1]; },
        toneValue(v, raw) { v = v || this.defaultLevels(); const lo = clamp(Number(v.min) || 0, 0, 254), hi = Math.max(lo + 1, clamp(Number(v.max) || 255, 1, 255)), b = clamp(Number(v.brightness) || 0, -100, 100) / 100, c = clamp(Number(v.contrast) || 0, -100, 100) / 100, f = Math.pow(2, c * 1.5); let x = (raw - lo) / (hi - lo); x = clamp(x, 0, 1); let y = this.curveValue(v.curve, x * 255) / 255; y = (y - .5) * f + .5 + b * .35; return clamp(y * 255, 0, 255); },
        levelLut(v) { const out = new Uint8Array(256); for (let i = 0; i < 256; i++)
            out[i] = Math.round(this.toneValue(v, i)); return out; },
        applyLevelsPlane(src, v, options) { const lut = this.levelLut(v), out = new Uint8Array(src.length); if (!options || (!options.invert && !options.respectStateInvert)) {
            for (let i = 0; i < src.length; i++)
                out[i] = lut[src[i]];
            return out;
        } const inv = Boolean(options.invert || (options.respectStateInvert && v?.invert === true)); if (!inv) {
            for (let i = 0; i < src.length; i++)
                out[i] = lut[src[i]];
            return out;
        } for (let i = 0; i < src.length; i++)
            out[i] = 255 - lut[src[i]]; return out; },
        histogram256(src, maxSamples = 350000) { const bins = new Uint32Array(256); if (!src)
            return bins; const sources = Array.isArray(src) ? src : [src]; for (const plane of sources) {
            if (!plane)
                continue;
            const step = Math.max(1, Math.floor(plane.length / maxSamples));
            for (let i = 0; i < plane.length; i += step)
                bins[plane[i]]++;
        } return bins; }
    };
    /* Image Prep's levels: black and white points, brightness and contrast, and
       optionally a tone curve and inversion. The curve reshapes the 0-255 range
       between the black and white points before brightness and contrast, as in
       the Slide Deck Builder it came from; it is only stored when it is not the
       straight line, and an untouched curve leaves the table exactly as before. */
    Core.display.figurePrep = {
        isLinearCurve(points) {
            const p = Core.display.normalizeCurve(points);
            return p.length === 2 && p[0][1] === 0 && p[1][1] === 255;
        },
        normalizeLevels(l) {
            const min = Math.min(254, Math.max(0, Math.round(Number(l?.min) || 0)));
            const max = Math.max(min + 1, Math.min(255, Math.round(Number(l?.max ?? 255))));
            const out = { min, max, brightness: Math.max(-100, Math.min(100, Math.round(Number(l?.brightness) || 0))), contrast: Math.max(-100, Math.min(100, Math.round(Number(l?.contrast) || 0))) };
            if (Array.isArray(l?.curve) && !this.isLinearCurve(l.curve))
                out.curve = Core.display.normalizeCurve(l.curve).map(p => [Math.round(p[0] * 10) / 10, Math.round(p[1] * 10) / 10]);
            if (l?.invert === true)
                out.invert = true;
            return out;
        },
        /* contrast and brightness as the table applies them, and back. */
        toneParams(n) { return { c: (259 * (n.contrast + 255)) / (255 * (259 - n.contrast)), b: n.brightness * 1.28 }; },
        buildLut(levels) {
            const n = this.normalizeLevels(levels), lut = new Uint8ClampedArray(256), span = n.max - n.min, { c, b } = this.toneParams(n);
            for (let v = 0; v < 256; v++) {
                let out = ((v - n.min) / span) * 255;
                if (n.curve)
                    out = Core.display.curveValue(n.curve, Math.max(0, Math.min(255, out)));
                out = c * (out - 128) + 128 + b;
                lut[v] = n.invert ? 255 - Math.max(0, Math.min(255, out)) : out;
            }
            return lut;
        },
        /* The curve's points where they are drawn on a histogram: input as the
           raw 0-255 value, output as the displayed value. */
        curveHandles(levels) {
            const n = this.normalizeLevels(levels), { c, b } = this.toneParams(n);
            return Core.display.normalizeCurve(n.curve).map((p, index) => {
                const o = Math.max(0, Math.min(255, c * (p[1] - 128) + 128 + b));
                return { index, raw: n.min + p[0] / 255 * (n.max - n.min), out: n.invert ? 255 - o : o };
            });
        },
        /* The stored curve point for a pointer at raw input `raw` and displayed
           output `out`: brightness, contrast and inversion undone. */
        curvePointAt(levels, raw, out) {
            const n = this.normalizeLevels(levels), { c, b } = this.toneParams(n);
            const shown = n.invert ? 255 - out : out;
            const x = Math.max(0, Math.min(255, (raw - n.min) / (n.max - n.min) * 255));
            const y = Math.max(0, Math.min(255, (shown - 128 - b) / Math.max(1e-6, c) + 128));
            return [x, y];
        },
        /* A curve with point `index` moved to (x, y); the ends move only up and
           down, and an inner point stays between its neighbours. */
        moveCurvePoint(curve, index, x, y) {
            const pts = Core.display.normalizeCurve(curve).map(p => p.slice());
            if (index <= 0)
                pts[0][1] = y;
            else if (index >= pts.length - 1)
                pts[pts.length - 1][1] = y;
            else {
                pts[index][0] = Math.max(pts[index - 1][0] + 1, Math.min(pts[index + 1][0] - 1, x));
                pts[index][1] = y;
            }
            return pts;
        },
        /* A curve with a point added at (x, y), and that point's index. */
        addCurvePoint(curve, x, y) {
            const pts = Core.display.normalizeCurve(curve).map(p => p.slice());
            if (x <= 1) {
                pts[0][1] = y;
                return { curve: pts, index: 0 };
            }
            if (x >= 254) {
                pts[pts.length - 1][1] = y;
                return { curve: pts, index: pts.length - 1 };
            }
            let at = 1;
            while (at < pts.length && pts[at][0] < x)
                at++;
            if (Math.abs(pts[at - 1][0] - x) < 1 || (pts[at] && Math.abs(pts[at][0] - x) < 1))
                return { curve: pts, index: Math.abs(pts[at - 1][0] - x) < 1 ? at - 1 : at };
            pts.splice(at, 0, [x, y]);
            return { curve: pts, index: at };
        },
        removeCurvePoint(curve, index) {
            const pts = Core.display.normalizeCurve(curve).map(p => p.slice());
            if (index > 0 && index < pts.length - 1)
                pts.splice(index, 1);
            return pts;
        }
    };
    Core.data = {
        bitDepthFromDtype(dtype) {
            const m = String(dtype || '').toLowerCase().match(/(?:u?int|float)(8|16|32|64)/);
            return m ? Number(m[1]) : null;
        },
        imageInfoRows({ filename = '', width = null, height = null, channelCount = null, zCount = null, projection = 'max', bitDepth = null, pixelSizeUm = null, sourceGroup = '', adjustments = '' } = {}) {
            const w = Number(width), h = Number(height), c = Number(channelCount), z = Number(zCount), bits = Number(bitDepth), px = Number(pixelSizeUm);
            const zText = Number.isFinite(z) && z > 0 ? (z > 1 ? (String(projection || '').toLowerCase().includes('max') ? `${z} Z → MaxIP` : `${z} Z planes`) : '1 Z plane') : '—';
            const rows = [
                ['File', String(filename || '—')],
                ['XY', Number.isFinite(w) && w > 0 && Number.isFinite(h) && h > 0 ? `${Math.round(w)} × ${Math.round(h)} px` : '—'],
                ['Channels', Number.isFinite(c) && c > 0 ? `${Math.round(c)} channel${Math.round(c) === 1 ? '' : 's'}` : '—'],
                ['Z', zText],
                ['Bit depth', Number.isFinite(bits) && bits > 0 ? `${Math.round(bits)}-bit source` : '—'],
                ['Pixel size', Number.isFinite(px) && px > 0 ? `${px.toFixed(px < 1 ? 4 : 3)} µm/px` : '—']
            ];
            /* Only when there is something to say, so a tool that passes
               neither sees exactly the rows it always saw. */
            if (String(sourceGroup || '').trim())
                rows.push(['Source group', String(sourceGroup).trim()]);
            if (String(adjustments || '').trim())
                rows.push(['Adjusted', String(adjustments).trim()]);
            return rows;
        },
        describe({ width, height, spatialScale = 1, bitDepth = null, intensity = 'display', projection = null, compression = null, format = null } = {}) {
            const parts = [];
            if (width && height)
                parts.push(`${Math.round(width)} × ${Math.round(height)}`);
            parts.push(spatialScale >= .999 ? 'Native XY' : `${Math.round(spatialScale * 100)}% XY`);
            if (projection)
                parts.push(projection);
            if (bitDepth)
                parts.push(`${bitDepth}-bit`);
            parts.push(intensity === 'raw' ? 'Raw intensity' : intensity === 'corrected' ? 'Processed intensity' : 'Display-adjusted');
            if (format)
                parts.push(String(format).toUpperCase());
            if (compression)
                parts.push(compression === 'lossless' ? 'Lossless encoding' : compression);
            return parts.join(' · ');
        },
        badgeHtml(spec) { return `<span class="tk-data-badge" title="Spatial resolution, intensity precision, intensity mapping, and file encoding are reported separately.">${this.describe(spec)}</span>`; }
    };
    Core.runtime = (() => {
        const queue = [];
        const channel = typeof MessageChannel !== 'undefined' ? new MessageChannel() : null;
        if (channel)
            channel.port1.onmessage = () => { const batch = queue.splice(0); for (const fn of batch)
                fn(); };
        const hidden = () => typeof document !== 'undefined' && document.visibilityState === 'hidden';
        const yieldTask = () => new Promise(resolve => { if (channel) {
            queue.push(resolve);
            channel.port2.postMessage(0);
        }
        else
            setTimeout(resolve, 0); });
        const paint = ({ frames = 1, timeoutMs = 180, hiddenMode = 'yield' } = {}) => {
            if (typeof document === 'undefined' || typeof requestAnimationFrame === 'undefined')
                return yieldTask();
            if (hidden())
                return hiddenMode === 'skip' ? Promise.resolve() : yieldTask();
            return new Promise(resolve => {
                let settled = false, timer = 0, remaining = Math.max(1, Number(frames) || 1);
                const finish = () => { if (settled)
                    return; settled = true; clearTimeout(timer); document?.removeEventListener?.('visibilitychange', vis); yieldTask().then(resolve); };
                const vis = () => { if (hidden())
                    finish(); };
                const frame = () => { if (--remaining <= 0)
                    finish();
                else
                    try {
                        requestAnimationFrame(frame);
                    }
                    catch {
                        finish();
                    } };
                document?.addEventListener?.('visibilitychange', vis);
                try {
                    requestAnimationFrame(frame);
                }
                catch {
                    finish();
                }
                timer = setTimeout(finish, Math.max(20, Number(timeoutMs) || 180));
            });
        };
        return { hidden, yieldTask, paint };
    })();
    Core.vendor = {
        _promises: new Map(),
        registry: {
            jszip: { url: 'assets/vendor/jszip-3.10.1.min.js', ready: () => typeof global.JSZip === 'function' },
            pptxgenjs: { url: 'assets/vendor/pptxgenjs-4.0.0.bundle.js', ready: () => typeof global.PptxGenJS === 'function' },
            xlsx: { url: 'assets/vendor/xlsx-0.18.5.full.min.js', ready: () => typeof global.XLSX !== 'undefined' },
            chart: { url: 'assets/vendor/chart-4.4.4.umd.js', ready: () => typeof global.Chart !== 'undefined' },
            /* UTIF reads self.pako once when it loads, so pako must be in place first or
               Deflate/ZIP-compressed TIFFs (the default in many graphing programs) fail. */
            pako: { url: 'assets/vendor/pako-inflate-2.1.0.min.js', ready: () => typeof global.pako?.inflate === 'function' },
            utif: { url: 'assets/vendor/utif-3.1.0.js', ready: () => Boolean(global.UTIF), requires: ['pako'] },
            jspdf: { url: 'assets/vendor/jspdf-2.5.2.umd.min.js', ready: () => Boolean(global.jspdf?.jsPDF) },
            /* Vector PDF export: the figure's SVG drawn into jsPDF, text kept as text. */
            svg2pdf: { url: 'assets/vendor/svg2pdf-2.8.1.umd.min.js', ready: () => typeof global.jspdf?.jsPDF?.API?.svg === 'function', requires: ['jspdf'] },
            /* Glyph outlines for "EPS text as outlines". */
            opentype: { url: 'assets/vendor/opentype-1.3.4.min.js', ready: () => typeof global.opentype?.parse === 'function' },
            pdfjsClassic: { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js', workerUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js', ready: () => Boolean(global.pdfjsLib?.SVGGraphics) },
            fzstd: { url: 'https://cdn.jsdelivr.net/npm/fzstd@0.1.1/umd/index.js', ready: () => Boolean(global.fzstd) },
            hashwasm: { url: 'https://cdn.jsdelivr.net/npm/hash-wasm@4', ready: () => Boolean(global.hashwasm) }
        },
        loadScript(url, readyTest) {
            if (readyTest?.())
                return Promise.resolve();
            const key = 'script:' + url;
            if (this._promises.has(key))
                return this._promises.get(key);
            const p = new Promise((resolve, reject) => {
                const absolute = new URL(url, document.baseURI).href;
                const existing = [...document.scripts].find(s => s.src === absolute);
                const done = () => readyTest && !readyTest() ? reject(new Error(`Loaded ${url}, but its API was unavailable.`)) : resolve();
                if (existing) {
                    if (existing.dataset.tkLoaded === '1' || readyTest?.()) {
                        resolve();
                        return;
                    }
                    existing.addEventListener('load', done, { once: true });
                    existing.addEventListener('error', () => reject(new Error(`Failed to load ${url}`)), { once: true });
                    return;
                }
                const s = document.createElement('script');
                s.src = url;
                s.async = true;
                s.onload = () => { s.dataset.tkLoaded = '1'; done(); };
                s.onerror = () => reject(new Error(`Failed to load ${url}`));
                document.head.appendChild(s);
            }).catch(e => { this._promises.delete(key); throw e; });
            this._promises.set(key, p);
            return p;
        },
        moduleRegistry: {
            pdfjs: { url: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.min.mjs', workerUrl: 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/4.10.38/pdf.worker.min.mjs' },
            ghostscript: { url: 'https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/gs.mjs', baseUrl: 'https://cdn.jsdelivr.net/npm/@jspawn/ghostscript-wasm@0.0.2/' },
            /* Image Prep's background removal runs this in a worker (assets/bg-remove-worker.js). */
            onnxruntime: { url: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/ort.all.min.mjs', baseUrl: 'https://cdn.jsdelivr.net/npm/onnxruntime-web@1.30.0/dist/' }
        },
        /* Trained models fetched at run time, pinned to a revision. BiRefNet-lite
           (MIT, Zheng et al. 2024): salient-object matting for background removal.
           gpu: the 1024 x 1024 export with its graph rewritten to run on WebGPU
           (jiabins0303; weights unchanged, half precision). cpu: a 512 x 512
           re-export (studioludens) that fits the 4 GB WebAssembly heap. */
        models: {
            birefnetLite: {
                licence: 'MIT',
                gpu: { url: 'https://huggingface.co/jiabins0303/birefnet-lite-1024-webgpu/resolve/1ad01cef0f4101a285c5a3e0bd7f15597d93403f/onnx/model_fp16.onnx', size: 1024, mb: 115 },
                cpu: { url: 'https://huggingface.co/studioludens/birefnet-lite-512/resolve/4a3c40c36c94093cc1e724d9ea428b8fa4b57dc7/onnx/model.onnx', size: 512, mb: 192 }
            }
        },
        sources: {
            limnd2: { version: '0.3.0', jsdelivr: 'https://cdn.jsdelivr.net/gh/Laboratory-Imaging/limnd2@{version}/src/limnd2/{path}', github: 'https://raw.githubusercontent.com/Laboratory-Imaging/limnd2/refs/tags/{version}/src/limnd2/{path}' }
        },
        ensure(name) { const spec = this.registry[name]; if (!spec)
            return Promise.reject(new Error(`Unknown shared library: ${name}`)); if (spec.requires?.length && !spec.ready())
            return Promise.all(spec.requires.map(dep => this.ensure(dep))).then(() => this.loadScript(spec.url, spec.ready)); return this.loadScript(spec.url, spec.ready); },
        ensureModule(name) { const spec = this.moduleRegistry[name]; if (!spec)
            return Promise.reject(new Error(`Unknown shared module: ${name}`)); return this.importModule(spec.url); },
        workerUrl(name) { return this.registry[name]?.workerUrl || this.moduleRegistry[name]?.workerUrl || ''; },
        sourceUrl(name, path, { mirror = 'jsdelivr', version = null } = {}) {
            const spec = this.sources[name];
            if (!spec)
                throw new Error(`Unknown shared source: ${name}`);
            const template = spec[mirror] || spec.jsdelivr || spec.github;
            if (!template)
                throw new Error(`No ${mirror} source configured for ${name}.`);
            return template.replace('{version}', encodeURIComponent(version || spec.version || '')).replace('{path}', String(path || '').split('/').map(encodeURIComponent).join('/'));
        },
        importModule(url) { const key = 'module:' + url; if (!this._promises.has(key))
            this._promises.set(key, import(url).catch(e => { this._promises.delete(key); throw e; })); return this._promises.get(key); }
    };
    Core.imageIO = {
        /* Safari (WebKit) refuses an image whose data: URL is more than a few tens of
           MB ("Not allowed to load local resource"), and a full-resolution
           microscopy panel as a PNG data URL is that size. So a large data: URL is
           decoded to a Blob here (base64 in chunks, never through fetch, which
           refuses it too) and the image is loaded from a blob: URL, released once
           it has loaded. The original string is kept as image.toolkitSrc, for code
           that saves or sends the image on. */
        BIG_DATA_URL: 8e6,
        dataUrlToBlob(url) {
            const comma = url.indexOf(','), head = url.slice(5, comma), type = head.split(';')[0] || 'application/octet-stream';
            if (!/;base64/i.test(head))
                return new Blob([decodeURIComponent(url.slice(comma + 1))], { type });
            const parts = [], CHUNK = 1 << 22;
            for (let i = comma + 1; i < url.length; i += CHUNK) {
                const s = atob(url.slice(i, i + CHUNK)), u = new Uint8Array(s.length);
                for (let k = 0; k < s.length; k++)
                    u[k] = s.charCodeAt(k);
                parts.push(u);
            }
            return new Blob(parts, { type });
        },
        loadImage(src, { decoding = null } = {}) {
            return new Promise((resolve, reject) => {
                const im = new Image();
                if (decoding)
                    im.decoding = decoding;
                let url = String(src || ''), temp = null;
                if (url.startsWith('data:') && url.length > this.BIG_DATA_URL) {
                    try {
                        temp = URL.createObjectURL(this.dataUrlToBlob(url));
                        im.toolkitSrc = url;
                        url = temp;
                    }
                    catch (_) {
                        temp = null;
                    }
                }
                im.onload = () => { if (temp)
                    URL.revokeObjectURL(temp); resolve(im); };
                im.onerror = () => { if (temp)
                    URL.revokeObjectURL(temp); reject(new Error(`Could not decode an image${src && String(src).length > 1e6 ? ` of ${Math.round(String(src).length / 1e6)} MB` : ''}.`)); };
                im.src = url;
            });
        },
        /* The source an image was loaded from, as loadImage was given it. */
        imageSource(im) { return im?.toolkitSrc || im?.src || ''; },
        /* A Blob from any image URL, data: ones decoded here (see loadImage). */
        async urlToBlob(url) { return String(url || '').startsWith('data:') ? this.dataUrlToBlob(String(url)) : (await fetch(url)).blob(); },
        extension(name = '') { const m = String(name || '').toLowerCase().match(/\.([^.]+)$/); return m ? m[1] : ''; },
        isTiff(fileOrName) { const name = typeof fileOrName === 'string' ? fileOrName : fileOrName?.name || ''; const type = typeof fileOrName === 'object' ? fileOrName?.type || '' : ''; return /\.tiff?$/i.test(name) || type === 'image/tiff'; },
        async readBytes(file) { if (file instanceof Uint8Array)
            return file; if (file instanceof ArrayBuffer)
            return new Uint8Array(file); if (file?.arrayBuffer)
            return new Uint8Array(await file.arrayBuffer()); throw new TypeError('Expected a File, Blob, ArrayBuffer, or Uint8Array.'); },
        async ensureTiff() { await Core.vendor.ensure('utif'); return global.UTIF; },
        async decodeTiffRgba(fileOrBuffer) {
            const bytes = await this.readBytes(fileOrBuffer), UTIF = await this.ensureTiff(), buf = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), ifds = UTIF.decode(buf);
            if (!ifds.length)
                throw new Error('No TIFF image found.');
            UTIF.decodeImage(buf, ifds[0], ifds);
            const rgba = new Uint8ClampedArray(UTIF.toRGBA8(ifds[0]));
            /* Only a TIFF with ExtraSamples (tag 338) has an alpha channel. Force the rest
               opaque: UTIF can leave a pixel at alpha 0 (e.g. the last pixel of some CMYK
               files), which would then punch a hole in exported figures. */
            if (!ifds[0].t338)
                for (let i = 3; i < rgba.length; i += 4)
                    rgba[i] = 255;
            return { width: ifds[0].width, height: ifds[0].height, rgba, ifd: ifds[0], ifds, bytes };
        },
        /* TIFF LZW (TIFF 6.0, section 13) as libtiff writes it: MSB-first codes of
           9–12 bits, ClearCode 256, EOI 257; the width grows once the next free code
           passes 511/1023/2047 and the table is cleared when it reaches 4094. */
        lzwEncode(data) {
            const out = [], next = new Int16Array(4096 * 256).fill(-1), used = [];
            let bitBuf = 0, bitCount = 0, width = 9, nextCode = 258;
            const emit = code => { bitBuf = (bitBuf << width) | code; bitCount += width; while (bitCount >= 8) { bitCount -= 8; out.push((bitBuf >>> bitCount) & 255); } bitBuf &= (1 << bitCount) - 1; };
            const reset = () => { for (const i of used) next[i] = -1; used.length = 0; nextCode = 258; width = 9; };
            emit(256);
            if (!data.length) { emit(257); if (bitCount) out.push((bitBuf << (8 - bitCount)) & 255); return new Uint8Array(out); }
            let prefix = data[0];
            for (let i = 1; i < data.length; i++) {
                const c = data[i], key = prefix * 256 + c, hit = next[key];
                if (hit >= 0) { prefix = hit; continue; }
                emit(prefix);
                next[key] = nextCode++; used.push(key);
                if (nextCode === 4094) { emit(256); reset(); }
                else if (nextCode === 512 || nextCode === 1024 || nextCode === 2048) width++;
                prefix = c;
            }
            emit(prefix);
            nextCode++;
            if (nextCode === 4094) { emit(256); reset(); }
            else if (nextCode === 512 || nextCode === 1024 || nextCode === 2048) width++;
            emit(257);
            if (bitCount) out.push((bitBuf << (8 - bitCount)) & 255);
            return new Uint8Array(out);
        },
        /* Print-ready TIFF: RGB (no alpha, which some journal systems reject), LZW,
           and the resolution stored in pixels per inch so it opens at its real size. */
        /* A note that survives every container we write. TIFF ASCII fields are
           7-bit by specification and PNG tEXt is Latin-1, so a description with
           typographic punctuation in it comes back as mojibake unless it is
           folded first. One rule for all of them, so what a reader shows is what
           was written. */
        asciiNote(text) {
            return String(text ?? '').normalize('NFKD')
                .replace(/[\u2018\u2019]/g, "'").replace(/[\u201c\u201d]/g, '"')
                .replace(/[\u2010-\u2015]/g, '-').replace(/\u00b7/g, '-')
                /* NFKD folds the micro sign U+00B5 to Greek mu U+03BC, so both have
                   to be caught or "um per pixel" silently loses its unit. */
                .replace(/\u00d7/g, 'x').replace(/[\u00b5\u03bc]/g, 'u').replace(/\u2192/g, '->')
                .replace(/\u2026/g, '...').replace(/[^\x09\x0a\x20-\x7e]/g, '');
        },
        encodeTiffRgb(rgba, width, height, { dpi = 300, software = 'Figure Workshop', description = '' } = {}) {
            const rowsPerStrip = Math.max(1, Math.floor(65536 / (width * 3))), strips = [];
            for (let y = 0; y < height; y += rowsPerStrip) {
                const rows = Math.min(rowsPerStrip, height - y), rgb = new Uint8Array(rows * width * 3);
                for (let i = 0, j = y * width * 4, n = rows * width; i < n; i++, j += 4) { rgb[i * 3] = rgba[j]; rgb[i * 3 + 1] = rgba[j + 1]; rgb[i * 3 + 2] = rgba[j + 2]; }
                strips.push(this.lzwEncode(rgb));
            }
            const enc = new TextEncoder(), sw = enc.encode(software + '\0'), tags = [];
            /* ImageDescription (270) is where ImageJ, Bio-Formats and exiftool all
               look for a free-text note, so a figure can carry its own provenance. */
            const descText = description ? this.asciiNote(description) : '';
            const desc = descText ? enc.encode(descText + '\0') : null;
            const T = (tag, type, count, value) => tags.push({ tag, type, count, value });
            T(256, 4, 1, width); T(257, 4, 1, height); T(258, 3, 3, 'bps'); T(259, 3, 1, 5); T(262, 3, 1, 2);
            if (desc)
                T(270, 2, desc.length, 'desc');
            T(273, 4, strips.length, 'offsets'); T(277, 3, 1, 3); T(278, 4, 1, rowsPerStrip); T(279, 4, strips.length, 'counts');
            T(282, 5, 1, 'xres'); T(283, 5, 1, 'yres'); T(284, 3, 1, 1); T(296, 3, 1, 2); T(305, 2, sw.length, 'software');
            const ifdSize = 2 + tags.length * 12 + 4, extra = { bps: 6, desc: desc && desc.length > 4 ? desc.length : 0, offsets: strips.length > 1 ? strips.length * 4 : 0, counts: strips.length > 1 ? strips.length * 4 : 0, xres: 8, yres: 8, software: sw.length > 4 ? sw.length : 0 };
            let pos = 8 + ifdSize; const at = {};
            for (const k of Object.keys(extra)) { at[k] = pos; pos += extra[k] + (extra[k] & 1); }
            const dataStart = pos, total = dataStart + strips.reduce((a, b) => a + b.length + (b.length & 1), 0), buf = new ArrayBuffer(total), dv = new DataView(buf), u8 = new Uint8Array(buf);
            u8[0] = 0x49; u8[1] = 0x49; dv.setUint16(2, 42, true); dv.setUint32(4, 8, true); dv.setUint16(8, tags.length, true);
            const stripOffsets = []; let off = dataStart;
            strips.forEach(st => { stripOffsets.push(off); u8.set(st, off); off += st.length + (st.length & 1); });
            const res = Math.round(dpi * 1000);
            dv.setUint32(at.xres, res, true); dv.setUint32(at.xres + 4, 1000, true); dv.setUint32(at.yres, res, true); dv.setUint32(at.yres + 4, 1000, true);
            [8, 8, 8].forEach((v, i) => dv.setUint16(at.bps + i * 2, v, true));
            if (strips.length > 1) strips.forEach((st, i) => { dv.setUint32(at.offsets + i * 4, stripOffsets[i], true); dv.setUint32(at.counts + i * 4, st.length, true); });
            if (extra.software) u8.set(sw, at.software);
            if (desc && extra.desc) u8.set(desc, at.desc);
            tags.forEach((t, i) => { const o = 10 + i * 12; dv.setUint16(o, t.tag, true); dv.setUint16(o + 2, t.type, true); dv.setUint32(o + 4, t.count, true);
                const v = t.value;
                if (v === 'offsets') dv.setUint32(o + 8, strips.length > 1 ? at.offsets : stripOffsets[0], true);
                else if (v === 'counts') dv.setUint32(o + 8, strips.length > 1 ? at.counts : strips[0].length, true);
                else if (v === 'software') { if (extra.software) dv.setUint32(o + 8, at.software, true); else u8.set(sw, o + 8); }
                else if (v === 'desc') { if (extra.desc) dv.setUint32(o + 8, at.desc, true); else u8.set(desc, o + 8); }
                else if (typeof v === 'string') dv.setUint32(o + 8, at[v], true);
                else if (t.type === 3) dv.setUint16(o + 8, v, true);
                else dv.setUint32(o + 8, v, true); });
            dv.setUint32(10 + tags.length * 12, 0, true);
            return u8;
        },
        /* PNG pHYs chunk (pixels per metre) so the PNG also opens at its real
           size, and an optional tEXt chunk carrying a note with the file. */
        pngWithDpi(bytes, dpi, description = '') {
            const crcTable = this._crcTable || (this._crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; }));
            const crc = b => { let c = 0xFFFFFFFF; for (let i = 0; i < b.length; i++) c = crcTable[(c ^ b[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; };
            const src = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes), dv = new DataView(src.buffer, src.byteOffset, src.byteLength), parts = [src.subarray(0, 8)];
            const ppm = Math.round(dpi / 0.0254), chunk = new Uint8Array(21), cv = new DataView(chunk.buffer);
            cv.setUint32(0, 9); chunk.set([0x70, 0x48, 0x59, 0x73], 4); cv.setUint32(8, ppm); cv.setUint32(12, ppm); chunk[16] = 1; cv.setUint32(17, crc(chunk.subarray(4, 17)));
            /* tEXt carries a keyword, a NUL, then the text; asciiNote keeps both
               inside what the format allows. */
            let textChunk = null;
            if (description) {
                const body = this.asciiNote(description), key = 'Description', total = key.length + 1 + body.length;
                textChunk = new Uint8Array(12 + total);
                const tv = new DataView(textChunk.buffer);
                tv.setUint32(0, total);
                textChunk.set([0x74, 0x45, 0x58, 0x74], 4);
                for (let i = 0; i < key.length; i++) textChunk[8 + i] = key.charCodeAt(i);
                textChunk[8 + key.length] = 0;
                for (let i = 0; i < body.length; i++) textChunk[9 + key.length + i] = body.charCodeAt(i) & 255;
                tv.setUint32(8 + total, crc(textChunk.subarray(4, 8 + total)));
            }
            for (let i = 8; i + 12 <= src.length;) { const len = dv.getUint32(i), type = String.fromCharCode(...src.subarray(i + 4, i + 8)), end = i + 12 + len;
                if (type !== 'pHYs' && !(type === 'tEXt' && textChunk)) parts.push(src.subarray(i, end));
                if (type === 'IHDR') { parts.push(chunk); if (textChunk) parts.push(textChunk); }
                i = end; }
            const out = new Uint8Array(parts.reduce((a, p) => a + p.length, 0)); let o = 0; parts.forEach(p => { out.set(p, o); o += p.length; }); return out;
        }
    };
    Core.worker = {
        createRequestClient(worker, { onEvent = () => { }, isFinal = m => m?.type === 'result', isError = m => m?.type === 'error' } = {}) {
            if (!worker)
                throw new Error('A Worker instance is required.');
            let seq = 0;
            const pending = new Map();
            const previous = worker.onmessage;
            worker.onmessage = e => {
                const m = e.data || {}, id = m.requestId;
                try {
                    onEvent(m, e);
                }
                catch (err) {
                    console.error(err);
                }
                if (id && pending.has(id)) {
                    const q = pending.get(id);
                    if (isError(m)) {
                        pending.delete(id);
                        q.reject(new Error(m.msg || m.error || 'Worker request failed.'));
                    }
                    else if (isFinal(m)) {
                        pending.delete(id);
                        q.resolve(m);
                    }
                }
                if (typeof previous === 'function')
                    try {
                        previous.call(worker, e);
                    }
                    catch (err) {
                        console.error(err);
                    }
            };
            const request = (message, { transfer = [], signal = null } = {}) => new Promise((resolve, reject) => {
                const requestId = message.requestId || `wr:${++seq}`;
                if (signal?.aborted) {
                    reject(signal.reason || new DOMException('Aborted', 'AbortError'));
                    return;
                }
                const cleanup = () => signal?.removeEventListener?.('abort', abort);
                const abort = () => { if (!pending.has(requestId))
                    return; pending.delete(requestId); cleanup(); reject(signal.reason || new DOMException('Aborted', 'AbortError')); };
                pending.set(requestId, { resolve: v => { cleanup(); resolve(v); }, reject: e => { cleanup(); reject(e); } });
                signal?.addEventListener?.('abort', abort, { once: true });
                try {
                    worker.postMessage({ ...message, requestId }, transfer);
                }
                catch (err) {
                    pending.delete(requestId);
                    cleanup();
                    reject(err);
                }
            });
            const close = (reason = new Error('Worker client closed.')) => { for (const q of pending.values())
                q.reject(reason); pending.clear(); };
            return { request, close, pendingCount: () => pending.size };
        }
    };
    Core.export = (() => {
        let table = null;
        const crc32 = bytes => { if (!table) {
            table = new Uint32Array(256);
            for (let n = 0; n < 256; n++) {
                let c = n;
                for (let k = 0; k < 8; k++)
                    c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
                table[n] = c >>> 0;
            }
        } let c = 0xffffffff; for (const b of bytes)
            c = table[(c ^ b) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
        const safeFilename = (value, fallback = 'file', mode = 'portable') => { const raw = String(value ?? fallback).trim(), cleaned = (mode === 'strict' ? raw.replace(/[^a-z0-9._-]+/gi, '_') : raw.replace(/[\/:*?"<>|]+/g, '_').replace(/\s+/g, '_')).replace(/^_+|_+$/g, ''); return cleaned || fallback; };
        const downloadBlob = (blob, name, revokeMs = 5000) => { const u = URL.createObjectURL(blob), a = document.createElement('a'); a.href = u; a.download = name; document.body.appendChild(a); a.click(); a.remove(); setTimeout(() => URL.revokeObjectURL(u), revokeMs); };
        const u16 = v => [v & 255, (v >>> 8) & 255], u32 = v => [v & 255, (v >>> 8) & 255, (v >>> 16) & 255, (v >>> 24) & 255];
        // zipStore historically read `bytes` while zip() reads `data`. Passing the
        // wrong shape used to produce a structurally valid archive full of 0-byte
        // entries that even `unzip -t` reports as clean, so a bad export looked
        // like a good one. Accept either key and throw on a missing payload.
        const entryBytes = entry => { const raw = entry?.bytes !== undefined ? entry.bytes : entry?.data; if (raw === undefined || raw === null)
            throw new Error(`ZIP entry "${entry?.name ?? '(unnamed)'}" has no data (expected a "data" or "bytes" property).`); return raw instanceof Uint8Array ? raw : new Uint8Array(raw); };
        // Entry names are normalised here rather than trusting every call site:
        // an absolute or "../" prefixed name would extract outside the target
        // directory. Backslashes are folded to "/" so Windows-style input cannot
        // smuggle a segment past the check.
        const entryName = name => { const parts = String(name ?? '').replace(/\\/g, '/').split('/').filter(p => p && p !== '.' && p !== '..'); if (!parts.length)
            throw new Error(`ZIP entry name "${name}" is empty after normalisation.`); return parts.join('/'); };
        const zipStore = files => { const enc = new TextEncoder(), parts = [], central = []; let offset = 0; for (const f of files) {
            const name = enc.encode(entryName(f.name)), data = entryBytes(f), crc = crc32(data), local = new Uint8Array([80, 75, 3, 4, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0]);
            parts.push(local, name, data);
            const cent = new Uint8Array([80, 75, 1, 2, 20, 0, 20, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(crc), ...u32(data.length), ...u32(data.length), ...u16(name.length), 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, ...u32(offset)]);
            central.push(cent, name);
            offset += local.length + name.length + data.length;
        } const centralOffset = offset, centralSize = central.reduce((a, x) => a + x.length, 0), end = new Uint8Array([80, 75, 5, 6, 0, 0, 0, 0, ...u16(files.length), ...u16(files.length), ...u32(centralSize), ...u32(centralOffset), 0, 0]); return new Blob([...parts, ...central, end], { type: 'application/zip' }); };
        const maybeDeflate = async (bytes) => { if (typeof CompressionStream === 'undefined')
            return { method: 0, data: bytes }; try {
            const cs = new CompressionStream('deflate-raw'), ab = await new Response(new Blob([bytes]).stream().pipeThrough(cs)).arrayBuffer();
            return { method: 8, data: new Uint8Array(ab) };
        }
        catch {
            return { method: 0, data: bytes };
        } };
        const zip = async (entries, { compress = true } = {}) => { const files = []; let localSize = 0, centralSize = 0; for (const ent of entries) {
            const name = new TextEncoder().encode(entryName(ent.name)), raw = entryBytes(ent), z = compress ? await maybeDeflate(raw) : { method: 0, data: raw }, crc = crc32(raw);
            files.push({ name, raw, z: z.data, method: z.method, crc, offset: localSize });
            localSize += 30 + name.length + z.data.length;
            centralSize += 46 + name.length;
        } const out = new Uint8Array(localSize + centralSize + 22), dv = new DataView(out.buffer); let o = 0; for (const f of files) {
            dv.setUint32(o, 0x04034b50, true);
            dv.setUint16(o + 4, 20, true);
            dv.setUint16(o + 6, 0x0800, true);
            dv.setUint16(o + 8, f.method, true);
            dv.setUint32(o + 14, f.crc, true);
            dv.setUint32(o + 18, f.z.length, true);
            dv.setUint32(o + 22, f.raw.length, true);
            dv.setUint16(o + 26, f.name.length, true);
            out.set(f.name, o + 30);
            out.set(f.z, o + 30 + f.name.length);
            o += 30 + f.name.length + f.z.length;
        } const centralOff = o; for (const f of files) {
            dv.setUint32(o, 0x02014b50, true);
            dv.setUint16(o + 4, 20, true);
            dv.setUint16(o + 6, 20, true);
            dv.setUint16(o + 8, 0x0800, true);
            dv.setUint16(o + 10, f.method, true);
            dv.setUint32(o + 16, f.crc, true);
            dv.setUint32(o + 20, f.z.length, true);
            dv.setUint32(o + 24, f.raw.length, true);
            dv.setUint16(o + 28, f.name.length, true);
            dv.setUint32(o + 42, f.offset, true);
            out.set(f.name, o + 46);
            o += 46 + f.name.length;
        } dv.setUint32(o, 0x06054b50, true); dv.setUint16(o + 8, files.length, true); dv.setUint16(o + 10, files.length, true); dv.setUint32(o + 12, o - centralOff, true); dv.setUint32(o + 16, centralOff, true); return out; };
        /* A stored zip put together from Blobs, for exports of any size. Nothing is
           copied into the page's memory: each file stays where the browser keeps
           it (on disk when large) and the zip is a list of parts. CRCs are read
           a chunk at a time. ZIP64 records are added past 4 GB or 65535 files.
           entries: [{ name, data: Blob | Uint8Array }]; onProgress(done, total). */
        const crcUpdate = (c, bytes) => { crc32(new Uint8Array(0)); for (let i = 0; i < bytes.length; i++)
            c = table[(c ^ bytes[i]) & 255] ^ (c >>> 8); return c; };
        /* Read in plain slices, not through blob.stream(): Safari failed reading a
           large stored Blob as a stream ("NotReadableError ... Too much data
           buffered"), which a 1.3 GB export hit. */
        const blobCrc = async (blob) => { let c = 0xffffffff; const STEP = 8 << 20; for (let off = 0; off < blob.size; off += STEP)
            c = crcUpdate(c, new Uint8Array(await blob.slice(off, Math.min(blob.size, off + STEP)).arrayBuffer())); return (c ^ 0xffffffff) >>> 0; };
        const zipBlobs = async (entries, onProgress = null) => {
            const enc = new TextEncoder(), parts = [], central = [], MAX32 = 0xffffffff, LIMIT = 0xffffffff;
            const now = new Date(), dosTime = (now.getHours() << 11) | (now.getMinutes() << 5) | (now.getSeconds() >> 1), dosDate = ((now.getFullYear() - 1980) << 9) | ((now.getMonth() + 1) << 5) | now.getDate();
            let offset = 0;
            for (let k = 0; k < entries.length; k++) {
                const ent = entries[k], name = enc.encode(entryName(ent.name));
                const blob = ent?.data instanceof Blob ? ent.data : new Blob([entryBytes(ent)]);
                const size = blob.size, crc = await blobCrc(blob), big = size >= LIMIT || offset >= LIMIT;
                const local = new DataView(new ArrayBuffer(30 + (big ? 20 : 0)));
                local.setUint32(0, 0x04034b50, true);
                local.setUint16(4, big ? 45 : 20, true);
                local.setUint16(6, 0x0800, true);
                local.setUint16(10, dosTime, true);
                local.setUint16(12, dosDate, true);
                local.setUint32(14, crc, true);
                local.setUint32(18, big ? MAX32 : size, true);
                local.setUint32(22, big ? MAX32 : size, true);
                local.setUint16(26, name.length, true);
                local.setUint16(28, big ? 20 : 0, true);
                if (big) {
                    local.setUint16(30, 1, true);
                    local.setUint16(32, 16, true);
                    local.setBigUint64(34, BigInt(size), true);
                    local.setBigUint64(42, BigInt(size), true);
                }
                const head = new Uint8Array(local.buffer);
                parts.push(head.subarray(0, 30), name, head.subarray(30), blob);
                const cent = new DataView(new ArrayBuffer(46 + (big ? 28 : 0)));
                cent.setUint32(0, 0x02014b50, true);
                cent.setUint16(4, big ? 45 : 20, true);
                cent.setUint16(6, big ? 45 : 20, true);
                cent.setUint16(8, 0x0800, true);
                cent.setUint16(12, dosTime, true);
                cent.setUint16(14, dosDate, true);
                cent.setUint32(16, crc, true);
                cent.setUint32(20, big ? MAX32 : size, true);
                cent.setUint32(24, big ? MAX32 : size, true);
                cent.setUint16(28, name.length, true);
                cent.setUint16(30, big ? 28 : 0, true);
                cent.setUint32(42, big ? MAX32 : offset, true);
                if (big) {
                    cent.setUint16(46, 1, true);
                    cent.setUint16(48, 24, true);
                    cent.setBigUint64(50, BigInt(size), true);
                    cent.setBigUint64(58, BigInt(size), true);
                    cent.setBigUint64(66, BigInt(offset), true);
                }
                const c = new Uint8Array(cent.buffer);
                central.push(c.subarray(0, 46), name, c.subarray(46));
                offset += 30 + name.length + (big ? 20 : 0) + size;
                onProgress?.(k + 1, entries.length);
            }
            const centralSize = central.reduce((n, x) => n + x.length, 0), n = entries.length;
            const zip64 = n >= 0xffff || offset >= LIMIT || centralSize >= LIMIT, tail = [];
            if (zip64) {
                const z = new DataView(new ArrayBuffer(56 + 20));
                z.setUint32(0, 0x06064b50, true);
                z.setBigUint64(4, 44n, true);
                z.setUint16(12, 45, true);
                z.setUint16(14, 45, true);
                z.setBigUint64(24, BigInt(n), true);
                z.setBigUint64(32, BigInt(n), true);
                z.setBigUint64(40, BigInt(centralSize), true);
                z.setBigUint64(48, BigInt(offset), true);
                z.setUint32(56, 0x07064b50, true);
                z.setBigUint64(64, BigInt(offset + centralSize), true);
                z.setUint32(72, 1, true);
                tail.push(new Uint8Array(z.buffer));
            }
            const end = new DataView(new ArrayBuffer(22));
            end.setUint32(0, 0x06054b50, true);
            end.setUint16(8, zip64 ? 0xffff : n, true);
            end.setUint16(10, zip64 ? 0xffff : n, true);
            end.setUint32(12, zip64 ? MAX32 : centralSize, true);
            end.setUint32(16, zip64 ? MAX32 : offset, true);
            tail.push(new Uint8Array(end.buffer));
            return new Blob([...parts, ...central, ...tail], { type: 'application/zip' });
        };
        const terms = { raw: 'Raw', display: 'Display-adjusted', corrected: 'Processed', annotated: 'Annotated', maxip: 'MaxIP', native: 'Native XY' };
        const safeStem = value => String(value || 'output').replace(/\.[^.]+$/, '').replace(/[\\/:*?"<>|]+/g, '_').replace(/\s+/g, ' ').trim().replace(/[ .]+$/, '') || 'output';
        const ext = format => { const f = String(format || '').trim().toLowerCase().replace(/^\./, ''); return f === 'tiff' ? 'tif' : f; };
        const filename = ({ source = 'output', channel = null, state = null, projection = null, role = null, format = 'png' } = {}) => { const bits = [safeStem(source)]; if (channel)
            bits.push(safeStem(channel)); if (role)
            bits.push(safeStem(role)); if (state)
            bits.push(safeStem(state)); if (projection)
            bits.push(safeStem(projection)); return bits.filter(Boolean).join('__') + '.' + ext(format); };
        const describe = ({ kind = 'image', format = null, spatialScale = 1, bitDepth = null, intensity = 'display', projection = null, compression = 'lossless' } = {}) => { const type = kind === 'channel' ? 'Channel' : kind === 'composite' ? 'Composite' : kind === 'analysis' ? 'Analysis results' : kind === 'presentation' ? 'Presentation' : kind === 'project' ? 'Project backup' : 'Image'; return [type, Core.data.describe({ spatialScale, bitDepth, intensity, projection, format, compression })].filter(Boolean).join(' · '); };
        return { crc32, safeFilename, downloadBlob, zipStore, zip, zipBlobs, terms, safeStem, ext, filename, describe };
    })();
    /* One loading bar for the whole site. Anything that can take more than a
       few seconds shows what it is doing, a bar and a percentage at the top of
       the window, and the tab's title starts with the percentage ("42% · Soma
       Quantification"), so it can be followed from another tab. Work over in
       half a second never shows. A page inside another (Image Prep and the
       Slide Deck in Figure Workshop) uses the top page's bar and title.
         const job = ToolkitCore.progress.start('Opening a.nd2');
         job.set(0.4, 'Reading pixels');  // fraction 0..1, optional detail
         job.step(3, 10);                 // or done of total
         job.end();
       or ToolkitCore.progress.run(label, async job => { ... }). */
    Core.progress = (() => {
        const jobs = [], PREFIX = /^\d{1,3}% · /;
        let el = null, seq = 0;
        function host() {
            try {
                const t = global.top;
                if (t && t !== global && t.ToolkitCore && t.ToolkitCore.progress)
                    return t.ToolkitCore.progress;
            }
            catch (_) { }
            return null;
        }
        function view() {
            if (el && el.isConnected)
                return el;
            const doc = global.document;
            if (!doc || !doc.body)
                return null;
            if (!doc.getElementById('tk-loadbar-style')) {
                const st = doc.createElement('style');
                st.id = 'tk-loadbar-style';
                st.textContent = '.tk-loadbar{position:fixed;top:10px;left:50%;transform:translateX(-50%);z-index:2147483000;box-sizing:border-box;width:min(440px,calc(100vw - 32px));padding:8px 12px 10px;border-radius:8px;background:rgba(14,18,24,.95);border:1px solid rgba(150,170,190,.3);box-shadow:0 10px 30px rgba(0,0,0,.45);color:#e7edf4;font:500 12px/1.3 system-ui,-apple-system,"Segoe UI",Roboto,Helvetica,Arial,sans-serif;pointer-events:none}'
                    + '.tk-loadbar[hidden]{display:none}.tk-loadbar-row{display:flex;gap:10px;align-items:baseline}'
                    + '.tk-loadbar-label{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}'
                    + '.tk-loadbar-pct{flex:none;font:600 12px/1.3 ui-monospace,SFMono-Regular,Menlo,monospace;font-variant-numeric:tabular-nums}'
                    + '.tk-loadbar-track{margin-top:7px;height:5px;border-radius:999px;background:rgba(255,255,255,.13);overflow:hidden}'
                    + '.tk-loadbar-fill{height:100%;width:0;border-radius:inherit;background:#6ee7a8;transition:width .2s ease}';
                doc.head.appendChild(st);
            }
            el = doc.createElement('div');
            el.className = 'tk-loadbar';
            el.setAttribute('role', 'progressbar');
            el.setAttribute('aria-valuemin', '0');
            el.setAttribute('aria-valuemax', '100');
            el.hidden = true;
            el.innerHTML = '<div class="tk-loadbar-row"><span class="tk-loadbar-label"></span><span class="tk-loadbar-pct">0%</span></div><div class="tk-loadbar-track"><div class="tk-loadbar-fill"></div></div>';
            doc.body.appendChild(el);
            return el;
        }
        function render() {
            const doc = global.document, job = [...jobs].reverse().find(j => j.shown);
            if (!doc)
                return;
            if (!job) {
                if (el)
                    el.hidden = true;
                if (PREFIX.test(doc.title))
                    doc.title = doc.title.replace(PREFIX, '');
                return;
            }
            const pct = Math.round(100 * job.f), v = view();
            if (v) {
                v.hidden = false;
                v.querySelector('.tk-loadbar-label').textContent = job.text ? `${job.label} · ${job.text}` : job.label;
                v.querySelector('.tk-loadbar-pct').textContent = pct + '%';
                v.querySelector('.tk-loadbar-fill').style.width = (100 * job.f).toFixed(1) + '%';
                v.setAttribute('aria-valuenow', String(pct));
                v.setAttribute('aria-label', job.label);
            }
            const title = `${pct}% · ${doc.title.replace(PREFIX, '')}`;
            if (doc.title !== title)
                doc.title = title;
        }
        function start(label, { quietMs = 500 } = {}) {
            const h = host();
            if (h)
                return h.start(label, { quietMs });
            const job = { id: ++seq, label: String(label || 'Working'), text: '', f: 0, shown: false, ended: false };
            jobs.push(job);
            job.timer = setTimeout(() => { job.shown = true; render(); }, Math.max(0, quietMs));
            const api = {
                set(f, text) {
                    if (job.ended)
                        return api;
                    if (f != null && Number.isFinite(Number(f)))
                        job.f = Math.max(0, Math.min(1, Number(f)));
                    if (text != null)
                        job.text = String(text);
                    if (job.shown)
                        render();
                    return api;
                },
                step(done, total, text) { return api.set(Number(total) > 0 ? Number(done) / Number(total) : null, text); },
                label(text) { job.label = String(text || job.label); if (job.shown)
                    render(); return api; },
                get fraction() { return job.f; },
                end() {
                    if (job.ended)
                        return;
                    job.ended = true;
                    clearTimeout(job.timer);
                    jobs.splice(jobs.indexOf(job), 1);
                    render();
                }
            };
            return api;
        }
        async function run(label, fn, opts) {
            const job = start(label, opts);
            try {
                return await fn(job);
            }
            finally {
                job.end();
            }
        }
        return { start, run };
    })();
    Core.ui = {
        alert(message) { global.alert?.(String(message ?? '')); },
        confirm(message) { return global.confirm ? global.confirm(String(message ?? '')) : true; },
        prompt(message, defaultValue = '') { return global.prompt ? global.prompt(String(message ?? ''), String(defaultValue ?? '')) : null; },
        error(error, { prefix = 'Error', consoleLog = true } = {}) { const text = error?.message || String(error || 'Unknown error'); if (consoleLog)
            console.error(error); this.alert(prefix ? `${prefix}: ${text}` : text); return text; },
        statusClass(state = '') { const s = String(state || '').toLowerCase(); return s === 'error' || s === 'err' ? 'error' : s === 'warning' || s === 'warn' ? 'warning' : s === 'busy' ? 'busy' : s === 'ok' || s === 'success' || s === 'ready' ? 'ok' : ''; },
        setStatus(el, label, { state = '', detail = '' } = {}) {
            if (typeof el === 'string')
                el = document.getElementById(el);
            if (!el)
                return;
            el.classList.add('tk-status');
            for (const c of ['ok', 'warning', 'error', 'busy'])
                el.classList.remove('tk-' + c);
            const c = this.statusClass(state);
            if (c)
                el.classList.add('tk-' + c);
            el.textContent = detail ? `${label} · ${detail}` : String(label || '');
        },
        setProgress({ bar, label, percent, pct = 0, text = '', state = 'busy' } = {}) {
            if (typeof bar === 'string')
                bar = document.getElementById(bar);
            if (typeof label === 'string')
                label = document.getElementById(label);
            if (typeof percent === 'string')
                percent = document.getElementById(percent);
            const p = Math.max(0, Math.min(100, Number(pct) || 0));
            if (bar) {
                bar.classList.add('tk-progress-bar');
                bar.style.width = p + '%';
            }
            if (label) {
                label.classList.add('tk-progress-label');
                label.textContent = String(text || '');
            }
            if (percent)
                percent.textContent = Math.round(p) + '%';
            return p;
        },
        renderDataBadges(target, specs = []) {
            if (typeof target === 'string')
                target = document.getElementById(target);
            if (!target)
                return;
            target.classList.add('tk-data-row');
            target.innerHTML = (Array.isArray(specs) ? specs : [specs]).filter(Boolean).map(x => Core.data.badgeHtml(x)).join('');
        },
        updateImageInfo(target, spec = null, { label = 'Image information' } = {}) {
            if (typeof target === 'string')
                target = document.getElementById(target);
            if (!target)
                return null;
            if (!this._imageInfoGlobal) {
                const pop = document.createElement('div');
                pop.className = 'tk-image-info-popover';
                pop.setAttribute('role', 'dialog');
                pop.setAttribute('aria-label', 'Image information');
                document.body.appendChild(pop);
                const svc = { pop, active: null };
                svc.close = () => { if (svc.active?.button)
                    svc.active.button.setAttribute('aria-expanded', 'false'); svc.active = null; pop.classList.remove('open'); };
                svc.position = () => { const a = svc.active; if (!a || !document.documentElement.contains(a.button)) {
                    svc.close();
                    return;
                } const r = a.button.getBoundingClientRect(), pad = 8, w = Math.min(pop.classList.contains('wide') ? 400 : 310, Math.max(230, innerWidth - 16)); pop.style.width = w + 'px'; const pr = pop.getBoundingClientRect(); let left = Math.min(innerWidth - pr.width - pad, Math.max(pad, r.right - pr.width)); let top = r.bottom + 7; if (top + pr.height > innerHeight - pad)
                    top = pop.classList.contains('wide') && r.top - pr.height - 7 < pad ? Math.max(pad, innerHeight - pad - pr.height) : Math.max(pad, r.top - pr.height - 7); pop.style.left = left + 'px'; pop.style.top = top + 'px'; };
                svc.open = (host, button) => { const data = host._tkImageInfoSpec; if (!data)
                    return; const rows = Core.data.imageInfoRows(data), acq = data.acquisition && typeof data.acquisition === 'object' ? data.acquisition : null, acqRows = Array.isArray(acq?.rows) ? acq.rows : [], acqText = String(acq?.text || '').trim(); pop.classList.toggle('wide', Boolean(acqRows.length || acqText)); pop.innerHTML = rows.map(([k, v]) => `<div class="tk-image-info-row"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('') + (acqRows.length || acqText ? `<div class="tk-image-info-head">Acquisition settings</div>` + acqRows.map(([k, v]) => `<div class="tk-image-info-row acq"><span>${escapeHtml(k)}</span><b>${escapeHtml(v)}</b></div>`).join('') + (acqText ? `<details class="tk-image-info-all"><summary>All recorded settings</summary><button type="button" class="tk-image-info-copy">Copy</button><pre>${escapeHtml(acqText)}</pre></details>` : '') : ''); pop.querySelector('.tk-image-info-all')?.addEventListener('toggle', () => requestAnimationFrame(svc.position)); pop.querySelector('.tk-image-info-copy')?.addEventListener('click', e => { const b = e.currentTarget, done = t => { b.textContent = t; setTimeout(() => { b.textContent = 'Copy'; }, 1400); }; const text = [...rows, ...acqRows].map(([k, v]) => `${k}: ${v}`).join('\n') + '\n\n' + acqText; navigator.clipboard?.writeText(text).then(() => done('Copied'), () => done('Copy failed')) ?? done('Copy failed'); }); if (svc.active?.button && svc.active.button !== button)
                    svc.active.button.setAttribute('aria-expanded', 'false'); svc.active = { host, button }; button.setAttribute('aria-expanded', 'true'); pop.classList.add('open'); requestAnimationFrame(svc.position); };
                document.addEventListener('pointerdown', e => { const a = svc.active; if (a && e.target !== a.button && !pop.contains(e.target))
                    svc.close(); });
                document.addEventListener('keydown', e => { if (e.key === 'Escape')
                    svc.close(); });
                global.addEventListener?.('resize', svc.position);
                global.addEventListener?.('scroll', svc.position, true);
                this._imageInfoGlobal = svc;
            }
            target.classList.add('tk-image-info-host');
            target._tkImageInfoSpec = spec || null;
            let btn = target.querySelector(':scope > .tk-image-info-btn');
            if (!btn) {
                btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'tk-image-info-btn';
                btn.textContent = 'i';
                btn.setAttribute('aria-expanded', 'false');
                target.appendChild(btn);
                btn.addEventListener('click', e => { e.stopPropagation(); const svc = Core.ui._imageInfoGlobal; if (svc.active?.button === btn) {
                    svc.close();
                    return;
                } svc.open(target, btn); });
            }
            btn.setAttribute('aria-label', label);
            btn.title = label;
            btn.hidden = !spec;
            if (!spec && this._imageInfoGlobal.active?.button === btn)
                this._imageInfoGlobal.close();
            else if (spec && this._imageInfoGlobal.active?.button === btn)
                this._imageInfoGlobal.open(target, btn);
            return { button: btn, close: () => this._imageInfoGlobal.close(), set: next => Core.ui.updateImageInfo(target, next, { label }) };
        },
        renderFileQueue(target, items = [], { name = x => x?.name || String(x || ''), state = () => 'queued', stateClass = () => '', datasetKey = 'q' } = {}) {
            if (typeof target === 'string')
                target = document.getElementById(target);
            if (!target)
                return;
            target.classList.add('tk-file-queue');
            target.innerHTML = '';
            (items || []).forEach((item, i) => { const row = document.createElement('div'); row.className = 'qrow tk-file-row'; row.dataset[datasetKey] = String(i); const n = document.createElement('div'); n.className = 'qname'; n.textContent = name(item, i); n.title = n.textContent; const st = document.createElement('div'); st.className = 'qstate ' + stateClass(item, i); st.textContent = state(item, i); row.append(n, st); target.appendChild(row); });
        },
        decorateCommon(root = document) {
            const add = (sel, cls) => root.querySelectorAll?.(sel).forEach(el => el.classList.add(cls));
            add('#queue,#batchList,#queueList,#fileList,.queue,.batch-list,.queue-list', 'tk-file-queue');
            add('.qrow,.batch-item,.queue-item,.file-row', 'tk-file-row');
            add('#status,#batchStatus,#workspaceStatus,#outputStatus,#previewStatus,#statusLine,.status-line', 'tk-status');
            add('.progress,.progress-wrap,.load-progress', 'tk-progress-host');
            add('.meta,.file-meta,.compact-meta,.info-box', 'tk-meta-block');
            root.querySelectorAll?.('.help-tip[data-tip],[data-help],[data-tooltip]').forEach(el => el.classList.add('tk-help-target'));
        },
        bindFileDrop({ zone, input, onFiles, onWarm = () => { }, pageOverlayClass = 'page-file-drag', dragClass = 'drag', accept = null, clickToOpen = true, onPageDragChange = () => { }, bindPage = true } = {}) {
            if (!zone || !onFiles)
                return () => { };
            const take = list => { const files = [...(list || [])]; const filtered = accept ? files.filter(accept) : files; if (filtered.length)
                onFiles(filtered); };
            const hasFiles = e => Array.from(e.dataTransfer?.types || []).includes('Files');
            const pageState = on => { if (pageOverlayClass)
                document.body?.classList.toggle(pageOverlayClass, on); onPageDragChange(Boolean(on)); };
            const click = e => { if (!clickToOpen)
                return; if (input && e?.target === input)
                return; onWarm(); input?.click(); };
            const over = e => { e.preventDefault(); zone.classList.add(dragClass); if (e.dataTransfer)
                e.dataTransfer.dropEffect = 'copy'; };
            const leave = () => zone.classList.remove(dragClass);
            let depth = 0;
            const drop = e => { e.preventDefault(); e.stopPropagation(); depth = 0; zone.classList.remove(dragClass); pageState(false); onWarm(); take(e.dataTransfer?.files); };
            zone.addEventListener('pointerenter', onWarm);
            zone.addEventListener('dragenter', onWarm);
            if (clickToOpen)
                zone.addEventListener('click', click);
            zone.addEventListener('dragover', over);
            zone.addEventListener('dragleave', leave);
            zone.addEventListener('drop', drop);
            const inputChange = () => take(input.files);
            input?.addEventListener('change', inputChange);
            const pEnter = e => { if (!hasFiles(e))
                return; e.preventDefault(); onWarm(); depth++; pageState(true); };
            const pOver = e => { if (!hasFiles(e))
                return; e.preventDefault(); if (e.dataTransfer)
                e.dataTransfer.dropEffect = 'copy'; pageState(true); };
            const pLeave = e => { if (!hasFiles(e))
                return; depth = Math.max(0, depth - 1); if (!depth)
                pageState(false); };
            const pDrop = e => { if (!hasFiles(e))
                return; e.preventDefault(); depth = 0; pageState(false); zone.classList.remove(dragClass); onWarm(); take(e.dataTransfer?.files); };
            if (bindPage) {
                global.addEventListener('dragenter', pEnter);
                global.addEventListener('dragover', pOver);
                global.addEventListener('dragleave', pLeave);
                global.addEventListener('drop', pDrop);
            }
            return () => { zone.removeEventListener('pointerenter', onWarm); zone.removeEventListener('dragenter', onWarm); if (clickToOpen)
                zone.removeEventListener('click', click); zone.removeEventListener('dragover', over); zone.removeEventListener('dragleave', leave); zone.removeEventListener('drop', drop); input?.removeEventListener('change', inputChange); if (bindPage) {
                global.removeEventListener('dragenter', pEnter);
                global.removeEventListener('dragover', pOver);
                global.removeEventListener('dragleave', pLeave);
                global.removeEventListener('drop', pDrop);
            } };
        },
        createEta({ label, alpha = .25, minSamples = 2 } = {}) {
            let started = performance.now(), done = 0, total = 0, lastTime = started, lastDone = 0, ema = null, samples = 0, timer = null;
            const fmt = s => { if (!Number.isFinite(s) || s < 0)
                return '—'; s = Math.max(0, Math.round(s)); if (s < 60)
                return `${s}s`; const m = Math.floor(s / 60), ss = s % 60; if (m < 60)
                return `${m}m ${String(ss).padStart(2, '0')}s`; return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`; };
            const render = () => { if (!label)
                return; if (done >= total && total > 0) {
                label.textContent = 'Estimated time remaining: done';
                return;
            } if (samples < minSamples || !ema) {
                label.textContent = 'Estimated time remaining: estimating…';
                return;
            } label.textContent = `Estimated time remaining: ${fmt(Math.max(0, total - done) * ema)}`; };
            const start = n => { total = Math.max(1, Number(n) || 1); done = 0; started = lastTime = performance.now(); lastDone = 0; ema = null; samples = 0; clearInterval(timer); timer = setInterval(render, 1000); render(); };
            const mark = n => { const now = performance.now(), inc = Math.max(0, Number(n) || 0); done = Math.min(total, done + inc); const delta = done - lastDone; if (delta > 0) {
                const sec = (now - lastTime) / 1000 / delta;
                ema = ema == null ? sec : alpha * sec + (1 - alpha) * ema;
                samples++;
                lastTime = now;
                lastDone = done;
            } render(); };
            const finish = () => { done = total; render(); clearInterval(timer); timer = null; };
            const stop = () => { clearInterval(timer); timer = null; if (label)
                label.textContent = 'Estimated time remaining: —'; };
            return { start, mark, finish, stop, render };
        }
    };
    if (global.document) {
        const run = () => Core.ui.decorateCommon(global.document);
        if (global.document.readyState === 'loading')
            global.document.addEventListener('DOMContentLoaded', run, { once: true });
        else
            queueMicrotask(run);
    }
    global.ToolkitCore = Core;
})(typeof window !== 'undefined' ? window : globalThis);

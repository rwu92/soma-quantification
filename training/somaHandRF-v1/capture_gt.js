// Drive the real app in headless Chrome: load each ND2, "Analyse section",
// record every detection request (params + channel order) and the final UI
// counts, and dump the decoded channel pixels for offline replay in Node.
const puppeteer = require('puppeteer-core');
const http = require('http'), fs = require('fs'), path = require('path');
const ROOT = process.env.APP_ROOT;
const OUT = process.env.OUT_DIR;
const FILES = JSON.parse(process.env.FILES); // array of file groups (one section each)
const PX = process.env.PX_UM || '';
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.mjs': 'text/javascript', '.css': 'text/css', '.py': 'text/plain', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };

const server = http.createServer((req, res) => {
  const url = decodeURIComponent(req.url.split('?')[0]);
  if (req.method === 'POST' && url.startsWith('/dump/')) {
    const dest = path.join(OUT, url.slice(6));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    const ws = fs.createWriteStream(dest);
    req.pipe(ws); ws.on('finish', () => { res.end('ok'); });
    return;
  }
  if (url.startsWith('/nd2/')) {
    const [gi, k] = url.slice(5).split('/').map(Number); const f = FILES[gi][k];
    res.writeHead(200, { 'Content-Type': 'application/octet-stream' });
    fs.createReadStream(f).pipe(res); return;
  }
  let p = path.join(ROOT, url === '/' ? 'index.html' : url);
  if (!fs.existsSync(p) && fs.existsSync(p + '.html')) p += '.html';
  if (!fs.existsSync(p) || fs.statSync(p).isDirectory()) { res.writeHead(404); res.end(); return; }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(p)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(p).pipe(res);
});

(async () => {
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  const browser = await puppeteer.launch({ executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome', headless: 'new', protocolTimeout: 0, args: ['--no-first-run', '--js-flags=--max-old-space-size=8192'] });
  for (let fi = 0; fi < FILES.length; fi++) {
    const tag = path.basename(FILES[fi][0]).replace(/_C\d\.tif$/, '');
    const page = await browser.newPage();
    const t0 = Date.now(), ts = () => ((Date.now() - t0) / 1000).toFixed(0) + 's';
    page.on('pageerror', e => console.log(tag, ts(), '[pageerror]', e.message));
    page.on('console', m => { if (m.type() === 'error') console.log(tag, ts(), '[console.error]', m.text().slice(0, 300)); });
    await page.evaluateOnNewDocument(() => {
      window.__runs = [];
      const orig = Worker.prototype.postMessage;
      Worker.prototype.postMessage = function (m, t) {
        if (m && m.type === 'run') {
          window.__runs.push({ id: m.id, w: m.w, h: m.h, params: m.params, chanOrder: (S.chanOrder || []).slice(),
            supportCellGroups: m.supportCellGroups || null, nSupportChannels: (m.supportChannels || []).length,
            supportModes: m.supportModes || [], supportNames: m.supportNames || [] });
        }
        return orig.call(this, m, t);
      };
    });
    await page.goto(`http://127.0.0.1:${port}/cell-quantification.html`);
    await page.evaluate(async (fi, names, px) => {
      if (px) { const el = document.getElementById('pxSize'); el.value = px; el.dispatchEvent(new Event('input', { bubbles: true })); }
      const dt = new DataTransfer();
      for (let k = 0; k < names.length; k++) { const b = await fetch('/nd2/' + fi + '/' + k).then(r => r.blob()); dt.items.add(new File([b], names[k])); }
      const inp = document.getElementById('fileInput'); inp.files = dt.files;
      inp.dispatchEvent(new Event('change', { bubbles: true }));
    }, fi, FILES[fi].map(f => path.basename(f)), PX);
    await page.waitForFunction(() => S.image && !S.busy && !document.getElementById('runBtn').disabled, { timeout: 0, polling: 1000 });
    console.log(tag, ts(), 'loaded', FILES[fi].map(f => path.basename(f)).join(' '), 'sections', await page.evaluate(() => S.sections.length), 'px', await page.evaluate(() => document.getElementById('pxSize').value), 'dMin', await page.evaluate(() => document.getElementById('dMin').value));
    await new Promise(r => setTimeout(r, 1500));
    await page.evaluate(() => { window.__done = false; runSection().then(() => { window.__done = true; }, e => { window.__done = 'ERR ' + e.message; }); });
    await page.waitForFunction(() => window.__done, { timeout: 0, polling: 2000 });
    console.log(tag, ts(), 'analysed', await page.evaluate(() => String(window.__done)));
    const meta = await page.evaluate(() => {
      const sec = S.image;
      const values = [...document.getElementById('chDetect').options].map(o => o.value).filter(v => /^c\d+$|^m\d+(?:-\d+)+$/.test(v));
      const views = values.map(v => {
        const r = sectionResultForValue(sec, v);
        return { value: v, label: analysisSelectionLabel(sec, v), final: r ? r.cells.length : null, all: r && r.allCells ? r.allCells.length : null };
      });
      return { name: sec.name, w: sec.channels[0].w, h: sec.channels[0].h,
        channels: sec.channels.map((c, i) => ({ name: c.name, mode: channelMode(i, sec), type: c.data ? c.data.constructor.name : null })),
        views, runs: window.__runs, ui: { minContrast: document.getElementById('minContrast').value } };
    });
    fs.mkdirSync(path.join(OUT, tag), { recursive: true });
    fs.writeFileSync(path.join(OUT, tag, 'meta.json'), JSON.stringify(Object.assign({ file: FILES[fi], px: PX }, meta), null, 1));
    const nch = meta.channels.length;
    for (let i = 0; i < nch; i++) {
      await page.evaluate(async (tag, i) => {
        await ensureFullSectionPixels(S.image, 'dump');
        const d = S.image.channels[i].data;
        await fetch(`/dump/${tag}/ch${i}.bin`, { method: 'POST', body: new Blob([d.buffer.slice(d.byteOffset, d.byteOffset + d.byteLength)]) });
      }, tag, i);
    }
    console.log(tag, ts(), 'dumped', JSON.stringify(meta.channels), JSON.stringify(meta.views));
    await page.close();
  }
  await browser.close();
  server.close();
})().catch(e => { console.error(e); process.exit(1); });

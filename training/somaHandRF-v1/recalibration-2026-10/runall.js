'use strict';
/* Runs extract.js over every listed image, N at a time. */
const { spawn } = require('child_process'), fs = require('fs'), path = require('path');
const [, , listFile, root, outDir, worker, poolWorker, n] = process.argv;
const files = fs.readFileSync(listFile, 'utf8').split('\n').filter(Boolean).map(f => path.join(root, f));
let next = 0, running = 0;
const start = () => {
  while (running < +n && next < files.length) {
    const f = files[next++], out = path.join(outDir, path.basename(f, '.tif') + '.json');
    if (fs.existsSync(out) && fs.statSync(out).size) continue;
    running++;
    const t0 = Date.now(), c = spawn('node', ['--max-old-space-size=1500', path.join(__dirname, 'extract.js'), f, out, worker, poolWorker], { stdio: ['ignore', 'pipe', 'pipe'] });
    let txt = ''; c.stdout.on('data', d => txt += d); c.stderr.on('data', d => txt += d);
    c.on('close', code => { running--; console.log(`${code === 0 ? 'ok ' : 'ERR'} ${((Date.now() - t0) / 1000).toFixed(0)}s ${txt.trim().split('\n').slice(-1)[0]}`); start(); if (!running && next >= files.length) console.log('all done'); });
  }
};
start();

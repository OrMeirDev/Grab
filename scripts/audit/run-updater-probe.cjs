#!/usr/bin/env node
// Runs updater-probe.cjs twice per pass (a restart in between, same throwaway profile).
//   node scripts/audit/run-updater-probe.cjs --app <checkout> --out <dir>
'use strict';
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const a = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) a[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
const APP = path.resolve(a.app);
const OUT = path.resolve(a.out);
fs.mkdirSync(OUT, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));
const shim = path.join(OUT, 'shim');
fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.build?.productName || pkg.name, version: pkg.version, main: 'main.cjs' }));
fs.writeFileSync(path.join(shim, 'main.cjs'), `require(${JSON.stringify(path.join(__dirname, 'updater-probe.cjs'))});\n`);
const electron = require(path.join(APP, 'node_modules', 'electron'));
const freePort = () => new Promise((resolve) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });

(async () => {
  for (const pass of ['generic', 'github']) {
    for (const run of [1, 2]) {
      const port = await freePort();
      const args = [shim, ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []), `--proxy-server=http://127.0.0.1:${port}`];
      const r = spawnSync(electron, args, { stdio: 'inherit', timeout: 120000, env: { ...process.env, GRAB_AUDIT_CONFIG: JSON.stringify({ app: APP, out: OUT, pass, run, port }) } });
      console.log(`pass ${pass} run ${run}: exit ${r.status}`);
    }
  }
})();

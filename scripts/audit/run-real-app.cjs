#!/usr/bin/env node
// Launches real-app-harness.cjs under Electron for one checkout (docs/audits/).
//
//   node scripts/audit/run-real-app.cjs --app <checkout> --media <HSSMT.mp4> --out <dir>
//        [--idle 300] [--remote-url <public test video>] [--remote-size 53961552] [--strace]
//        [--chromium-proxy]   every Electron/Chromium request (all network contexts, including the
//                             browser-process one used by the spellchecker and the updater) goes to
//                             the audit endpoint, which logs the host and refuses anything that is
//                             not a synthetic test host. Nothing is forwarded to the internet.
//
// The harness runs from a shim folder whose package.json carries the checkout's name, productName
// and version, so Electron builds the same default User-Agent as the installed app. --strace
// (Linux only) records every connect() of the whole process tree for process attribution; on
// Windows use windows/Capture-GrabConnections.ps1 alongside instead.
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const net = require('node:net');
const { spawn } = require('node:child_process');

const a = {};
for (let i = 2; i < process.argv.length; i++) if (process.argv[i].startsWith('--')) a[process.argv[i].slice(2)] = process.argv[i + 1] && !process.argv[i + 1].startsWith('--') ? process.argv[++i] : true;
const APP = path.resolve(a.app);
const OUT = path.resolve(a.out);
fs.mkdirSync(OUT, { recursive: true });
const pkg = JSON.parse(fs.readFileSync(path.join(APP, 'package.json'), 'utf8'));

const shim = path.join(OUT, 'shim');
fs.mkdirSync(shim, { recursive: true });
fs.writeFileSync(path.join(shim, 'package.json'), JSON.stringify({ name: pkg.name, productName: pkg.build?.productName || pkg.name, version: pkg.version, main: 'main.cjs' }, null, 2));
fs.writeFileSync(path.join(shim, 'main.cjs'), `require(${JSON.stringify(path.join(__dirname, 'real-app-harness.cjs'))});\n`);

const freePort = () => new Promise((resolve) => { const srv = net.createServer().listen(0, '127.0.0.1', () => { const { port } = srv.address(); srv.close(() => resolve(port)); }); });

(async () => {
const port = await freePort();
const electron = require(path.join(APP, 'node_modules', 'electron'));
const config = { port, chromiumProxy: !!a['chromium-proxy'], app: APP, out: OUT, tmp: fs.mkdtempSync(path.join(os.tmpdir(), 'ga-')), media: path.resolve(a.media), idle: Number(a.idle ?? 300), remoteUrl: a['remote-url'] || null, remoteSize: a['remote-size'] ? Number(a['remote-size']) : null };
const electronArgs = [shim, ...(process.platform === 'linux' && process.getuid?.() === 0 ? ['--no-sandbox'] : []),
  ...(config.chromiumProxy ? [`--proxy-server=http://127.0.0.1:${port}`] : [])];
const [cmd, args] = a.strace
  ? ['strace', ['-f', '-tt', '-e', 'trace=connect,execve', '-o', path.join(OUT, 'strace-connect.txt'), electron, ...electronArgs]]
  : [electron, electronArgs];
const child = spawn(cmd, args, { stdio: 'inherit', env: { ...process.env, GRAB_AUDIT_CONFIG: JSON.stringify(config) } });
child.on('exit', (code) => {
  // what Grab left in its temp folder at exit (cookie jars, lookup files), then remove it
  const left = fs.readdirSync(config.tmp).filter((n) => /^grab-/.test(n));
  fs.writeFileSync(path.join(OUT, 'tmp-at-exit.json'), JSON.stringify(left.flatMap((n) => {
    const p = path.join(config.tmp, n);
    return fs.statSync(p).isDirectory() ? [n + '/', ...fs.readdirSync(p).map((m) => `${n}/${m}`)] : [n];
  }), null, 2));
  fs.rmSync(config.tmp, { recursive: true, force: true });
  process.exit(code ?? 1);
});
})();

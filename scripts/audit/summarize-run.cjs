#!/usr/bin/env node
// Summarizes one run-real-app.cjs output folder (docs/audits/): endpoint requests grouped by
// scenario phase, and (Linux --strace) connect() calls grouped by process and destination.
//   node scripts/audit/summarize-run.cjs <out dir> [--json summary.json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const dir = path.resolve(process.argv[2]);
const jsonOut = process.argv.includes('--json') ? process.argv[process.argv.indexOf('--json') + 1] : null;
const lines = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const phases = lines(path.join(dir, 'phases.jsonl'));
const requests = lines(path.join(dir, 'requests.jsonl'));
const phaseAt = (at) => { let p = 'before-start'; for (const x of phases) if (x.at <= at) p = x.phase; return p; };
const scenarioOf = (phase) => phase.split(':')[0];

const out = { dir, phases: phases.map((p) => ({ at: p.at, phase: p.phase, ...Object.fromEntries(Object.entries(p).filter(([k]) => !['at', 'phase', 'tmp', 'tmpAfter'].includes(k))), grabTmp: (p.tmp || p.tmpAfter || []).filter((t) => t.startsWith('grab-')) })), byScenario: {}, connects: null };
for (const r of requests) {
  const s = scenarioOf(phaseAt(r.at));
  (out.byScenario[s] ||= []).push({
    t: r.at.slice(11, 23), via: r.via, method: r.method, host: r.host, path: r.path, queryKeys: r.queryKeys, status: r.status, bytes: r.bytes,
    clientClosed: r.clientClosed, range: r.range, cookies: r.cookieNames, userAgent: r.userAgent, referer: r.referer, origin: r.origin,
    acceptLanguage: r.acceptLanguage, authorization: r.authorization, setCookies: r.setCookieNames, otherHeaders: r.otherHeaders,
  });
}

// strace -f -tt -e trace=connect: "<pid> HH:MM:SS.us connect(fd, {sa_family=AF_INET, sin_port=htons(443), sin_addr=inet_addr("1.2.3.4")}, 16) = ..."
const st = path.join(dir, 'strace-connect.txt');
if (fs.existsSync(st)) {
  const text = fs.readFileSync(st, 'utf8');
  const agg = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\d+)\s+(\S+)\s+connect\(\d+, \{sa_family=(AF_INET6?|AF_UNIX)(?:, sin6?_port=htons\((\d+)\))?.*?(?:inet_addr\("([^"]+)"\)|inet_pton\(AF_INET6, "([^"]+)"\)|sun_path=(@?"[^"]*"))/.exec(line);
    if (!m) continue;
    const [, pid, , fam, port, v4, v6] = m;
    if (fam === 'AF_UNIX') continue; // local IPC (X11, dbus, Chromium internals)
    const dest = `${v4 || v6}:${port}`;
    const key = `${pid}|${dest}`;
    agg.set(key, (agg.get(key) || 0) + 1);
  }
  // map pids to programs via execve lines when strace recorded them; else leave the pid
  const prog = new Map();
  for (const line of text.split('\n')) {
    const m = /^(\d+)\s+\S+\s+execve\("([^"]+)"/.exec(line);
    if (m) prog.set(m[1], path.basename(m[2]));
  }
  out.connects = [...agg.entries()].map(([k, n]) => { const [pid, dest] = k.split('|'); return { pid, program: prog.get(pid) || null, dest, count: n }; });
}

if (jsonOut) fs.writeFileSync(path.resolve(jsonOut), JSON.stringify(out, null, 2));
for (const p of out.phases) console.log(`${p.at.slice(11, 23)} ${p.phase} ${JSON.stringify(Object.fromEntries(Object.entries(p).filter(([k]) => !['at', 'phase'].includes(k))))}`);
for (const [s, list] of Object.entries(out.byScenario)) {
  console.log(`\n== ${s}: ${list.length} request(s)`);
  for (const r of list) console.log(`  ${r.t} ${r.via} ${r.method} ${r.host}${r.path || ''}${r.queryKeys?.length ? '?<' + r.queryKeys.join(',') + '>' : ''} -> ${r.status}${r.range ? ' range=' + r.range : ''}${r.bytes != null ? ' bytes=' + r.bytes : ''}${r.clientClosed ? ' (client closed)' : ''} cookies=[${(r.cookies || []).join(',')}]${r.referer ? ' ref=' + r.referer : ''}${r.origin ? ' origin=' + r.origin : ''} ua=${(r.userAgent || '').replace(/^Mozilla\/5\.0 /, '').slice(0, 90)}`);
}
if (out.connects) {
  console.log('\n== connect() by pid/destination (AF_INET/AF_INET6 only)');
  for (const c of out.connects) console.log(`  pid ${c.pid} ${c.program || ''} -> ${c.dest} x${c.count}`);
}

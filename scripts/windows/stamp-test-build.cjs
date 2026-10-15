#!/usr/bin/env node
// CI test builds only (.github/workflows/windows-verify.yml): stamps the checked-out package.json
// with a test version and points the build's app updates at a feed on this machine instead of
// GitHub releases. The change is never committed: the production configuration in git keeps the
// GitHub feed, and a release build never runs this script.
//
// node scripts/windows/stamp-test-build.cjs --version 1.6.8-test.12 --feed http://127.0.0.1:47290/
const fs = require('fs');
const path = require('path');

const arg = (name) => { const i = process.argv.indexOf('--' + name); return i > 0 ? process.argv[i + 1] : undefined; };
const version = arg('version');
const feed = arg('feed');

// Refuse anything that could reach real users: a non-test version, or a feed off this machine.
if (!/^\d+\.\d+\.\d+-test\.\d+$/.test(version || '')) throw new Error(`not a test version: ${version}`);
const url = new URL(feed || 'invalid:');
if (url.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(url.hostname)) throw new Error(`the test feed must be on this machine: ${feed}`);

const file = path.join(__dirname, '..', '..', 'package.json');
const pkg = JSON.parse(fs.readFileSync(file, 'utf8'));
pkg.version = version;
pkg.build.publish = [{ provider: 'generic', url: url.href }];
fs.writeFileSync(file, JSON.stringify(pkg, null, 2) + '\n');
console.log(`package.json stamped for a test build: ${version}, updates from ${url.href}`);

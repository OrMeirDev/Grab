const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { createRequire } = require('node:module');
const browser = require('../electron/browser-session.cjs');
const { createLookupBudget } = require('../electron/lookup-budget.cjs');
const { mainHandlers, sender } = require('../test-support/main-handlers.cjs');
const shortBudget = { createLookupBudget: () => createLookupBudget(30) };
const page = 'https://www.mako.co.il/mako-vod-keshet/fixture';

test('a stuck extractor returns timeout and aborts its work', { timeout: 1500 }, async () => {
  let signal;
  const handlers = mainHandlers({ analyze: async (_url, options) => {
    signal = options?.signal;
    return new Promise(() => {});
  } }, {}, undefined, undefined, shortBudget);
  const result = await handlers.get('engine:analyze')({ sender }, 'https://lesson.example/');
  assert.equal(result.kind, 'timeout');
  assert.equal(signal.aborted, true);
});

test('a stuck Edge connection times out without starting a late page lookup', { timeout: 1500 }, async () => {
  let release;
  let navigations = 0;
  const session = { ...browser, connectBrowser: () => new Promise((resolve) => { release = resolve; }) };
  const handlers = mainHandlers({}, { findMedia: async (_url, options) => {
    await options.connect();
    navigations++;
    return { candidates: [] };
  } }, undefined, session, shortBudget);
  const result = await handlers.get('engine:analyze')({ sender }, page);
  assert.equal(result.kind, 'timeout');
  assert.equal(result.browser.name, 'Edge');
  release({});
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(navigations, 0);
});

test('a stuck page probe times out and the next lookup can complete', { timeout: 1500 }, async () => {
  let signal;
  let probes = 0;
  const handlers = mainHandlers({ analyze: async () => ({ ok: true, title: 'Episode' }) }, {
    findMedia: async (_url, options) => {
      if (++probes > 1) return { candidates: [{ url: 'https://cdn.example/episode.m3u8', kind: 'stream' }] };
      signal = options.signal;
      return new Promise(() => {});
    },
  }, undefined, undefined, shortBudget);
  assert.equal((await handlers.get('engine:analyze')({ sender }, page)).kind, 'timeout');
  assert.equal(signal.aborted, true);
  assert.equal((await handlers.get('engine:analyze')({ sender }, page)).ok, true);
});

test('the browser connection check also has a deadline', { timeout: 1500 }, async () => {
  const session = { ...browser, connectBrowser: () => new Promise(() => {}) };
  const handlers = mainHandlers({}, {}, undefined, session, shortBudget);
  const result = await handlers.get('browser:check')({}, page);
  assert.equal(result.ok, false);
  assert.equal(result.kind, 'timeout');
});

test('a large iframe list cannot trigger unlimited extractor attempts', { timeout: 1500 }, async () => {
  let attempts = 0;
  const handlers = mainHandlers({ analyze: async () => { attempts++; return { ok: false, kind: 'notmedia' }; } }, {
    findMedia: async () => ({ reusedTab: false, candidates: Array.from({ length: 100 }, (_, i) => ({ url: 'https://embed.example/player/' + i, kind: 'embed' })) }),
  });
  const result = await handlers.get('engine:analyze')({ sender }, page);
  assert.equal(result.ok, false);
  assert.equal(attempts, 8);
});

function stalledEngine() {
  const entry = path.join(__dirname, '../electron/engine.cjs');
  const nativeRequire = createRequire(entry);
  let child;
  const sandbox = { module: { exports: {} }, process, __dirname: path.dirname(entry), setTimeout, clearTimeout,
    require: (name) => name === 'child_process' ? { spawn: () => {
      child = new EventEmitter();
      child.stdout = new PassThrough();
      child.stderr = new PassThrough();
      child.kill = (signal) => { child.killedWith = signal; }; // No close event: still must settle.
      return child;
    } } : nativeRequire(name),
  };
  vm.runInNewContext(fs.readFileSync(entry, 'utf8'), sandbox, { filename: entry });
  return { engine: sandbox.module.exports, child: () => child };
}

test('an extractor process that never closes is killed at its deadline', { timeout: 1500 }, async () => {
  const fixture = stalledEngine();
  const result = await fixture.engine.analyze('https://fixture.example/video', { timeoutMs: 20 });
  assert.equal(result.kind, 'timeout');
  assert.equal(fixture.child().killedWith, 'SIGKILL');
});

test('aborting an in-flight extractor kills it and returns a result', { timeout: 1500 }, async () => {
  const fixture = stalledEngine();
  const controller = new AbortController();
  const pending = fixture.engine.analyze('https://fixture.example/video', { signal: controller.signal });
  controller.abort();
  assert.equal((await pending).kind, 'timeout');
  assert.equal(fixture.child().killedWith, 'SIGKILL');
});

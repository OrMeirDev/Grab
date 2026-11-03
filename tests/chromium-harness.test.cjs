const test = require('node:test');
const assert = require('node:assert/strict');
const { waitForDevToolsPort } = require('../test-support/chromium-harness.cjs');

function clock(read, timeoutMs = 1000) {
  let time = 0;
  return { read, timeoutMs, now: () => time, pause: async ms => { time += ms; } };
}

test('Chromium readiness waits through missing, locked and partially written endpoint files', async () => {
  const values = [Object.assign(new Error('not created'), { code: 'ENOENT' }),
    Object.assign(new Error('Windows sharing lock'), { code: 'EBUSY' }), '4567\n',
    '4567\n/devtools/browser/fixture-id\n'];
  let reads = 0;
  const endpoint = await waitForDevToolsPort('fixture', clock(() => {
    const value = values[reads++];
    if (value instanceof Error) throw value;
    return value;
  }));
  assert.equal(reads, 4);
  assert.equal(endpoint, 'ws://127.0.0.1:4567/devtools/browser/fixture-id');
});

test('a permanently locked or invalid endpoint fails within the startup deadline', async () => {
  const locked = Object.assign(new Error('locked'), { code: 'EBUSY' });
  let reads = 0;
  await assert.rejects(waitForDevToolsPort('fixture', clock(() => { reads++; throw locked; }, 300)),
    error => error.cause === locked && /readable DevTools endpoint/.test(error.message));
  assert.equal(reads, 3);
  for (const value of ['99999\n/devtools/browser/id', '4567\n', '4567\n/invalid']) {
    await assert.rejects(waitForDevToolsPort('fixture', clock(() => value, 300)), /readable DevTools endpoint/);
  }
});

test('unexpected filesystem errors are reported immediately', async () => {
  const failure = Object.assign(new Error('disk failure'), { code: 'EIO' });
  await assert.rejects(waitForDevToolsPort('fixture', clock(() => { throw failure; })), error => error === failure);
});

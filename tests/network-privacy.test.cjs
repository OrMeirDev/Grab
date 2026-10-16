const test = require('node:test');
const assert = require('node:assert/strict');
const { STAGING_ID, applicationUserAgent, configureApplicationPrivacy, configureSessionPrivacy, configureUpdaterPrivacy } = require('../electron/security/network-privacy.cjs');

test('application UA omits product versions while retaining the actual Chromium runtime', () => {
  const actual = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Grab/1.7.0 Chrome/152.0.0.0 Electron/44.7.2 Safari/537.36';
  const app = { userAgentFallback: actual };
  configureApplicationPrivacy(app);
  assert.equal(app.userAgentFallback, 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/152.0.0.0 Safari/537.36');
  assert.equal(applicationUserAgent(app.userAgentFallback), app.userAgentFallback);
});

test('every application session disables dictionary downloads as well as spelling', () => {
  const calls = [];
  const session = { setSpellCheckerLanguages: (v) => calls.push(['languages', v]),
    setSpellCheckerEnabled: (v) => calls.push(['enabled', v]), getUserAgent: () => 'Chrome/152 Electron/44.7.2', setUserAgent: (v) => calls.push(['ua', v]) };
  configureSessionPrivacy(session);
  assert.deepEqual(calls, [['languages', []], ['enabled', false], ['ua', 'Chrome/152']]);
});

test('the real updater final-header composition cannot disclose its installation ID', () => {
  const { AppUpdater } = require('electron-updater/out/AppUpdater');
  const first = { requestHeaders: { accept: 'application/json' }, logger: console };
  const second = { requestHeaders: null, logger: console };
  configureUpdaterPrivacy(first); configureUpdaterPrivacy(second);
  for (const updater of [first, second]) {
    const headers = AppUpdater.prototype.computeFinalHeaders.call(updater, { 'x-user-staging-id': 'installation-unique-value' });
    assert.equal(headers['x-user-staging-id'], STAGING_ID);
    assert.equal(updater.logger, null);
    assert.ok(!JSON.stringify(headers).includes('installation-unique-value'));
  }
  assert.equal(first.requestHeaders.accept, 'application/json');
});

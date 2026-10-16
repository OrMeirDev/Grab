const test = require('node:test');
const assert = require('node:assert/strict');
const { cookieMatchesUrl, filterScopedCookies } = require('../electron/domain/cookie-scope.cjs');
const cookie = (extra = {}) => ({ name: 'sid', value: 'secret', domain: '.example.test', path: '/video', secure: true, session: true, ...extra });

test('browser cookies are restricted by domain, host-only flag, path boundary and HTTPS', () => {
  assert.equal(cookieMatchesUrl(cookie(), 'https://cdn.example.test/video/part'), true);
  assert.equal(cookieMatchesUrl(cookie(), 'https://example.test/video'), true);
  assert.equal(cookieMatchesUrl(cookie(), 'http://cdn.example.test/video'), false);
  assert.equal(cookieMatchesUrl(cookie(), 'https://evil-example.test/video'), false);
  assert.equal(cookieMatchesUrl(cookie(), 'https://cdn.example.test/video-other'), false);
  assert.equal(cookieMatchesUrl(cookie({ hostOnly: true }), 'https://cdn.example.test/video'), false);
  assert.equal(cookieMatchesUrl(cookie({ domain: 'cdn.example.test', hostOnly: true }), 'https://cdn.example.test/video'), true);
  assert.equal(cookieMatchesUrl(cookie({ session: false, expirationDate: 1 }), 'https://example.test/video'), false);
});
test('cookie scope never promotes cookies from unrelated destinations', () => {
  const selected = filterScopedCookies(['https://cdn.example.test/video/file.m3u8'], [
    cookie({ name: 'accepted' }), cookie({ name: 'wrong-path', path: '/account' }),
    cookie({ name: 'wrong-domain', domain: 'other.test' }), cookie({ name: 'expired', session: false, expirationDate: 1 }),
  ]);
  assert.deepEqual(selected.map(c => c.name), ['accepted']);
});

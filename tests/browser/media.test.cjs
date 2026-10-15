const test = require('node:test');
const assert = require('node:assert/strict');
const media = require('../../extension/lib/media.js');

const now = 1_800_000_000_000;
const obs = (url, extra = {}) => ({ url, kind: media.classify({ url, contentType: extra.contentType }).kind, at: now, firstAt: extra.at || now, ...extra });
const rank = (list) => media.rank(list, { now });

test('classify recognizes HLS, DASH, direct files and opaque media by response metadata', () => {
  assert.equal(media.classify({ url: 'https://c.test/a/master.m3u8?token=1' }).kind, 'hls');
  assert.equal(media.classify({ url: 'https://c.test/play?id=9', contentType: 'application/vnd.apple.mpegurl; charset=utf-8' }).kind, 'hls');
  assert.equal(media.classify({ url: 'https://c.test/m.mpd' }).kind, 'dash');
  assert.equal(media.classify({ url: 'https://c.test/m', contentType: 'application/dash+xml' }).kind, 'dash');
  assert.equal(media.classify({ url: 'https://c.test/v.mp4?x=1' }).kind, 'file');
  assert.equal(media.classify({ url: 'https://c.test/stream/42', contentType: 'video/mp4' }).kind, 'opaque');
  assert.equal(media.classify({ url: 'https://c.test/stream/42', contentType: 'audio/mpeg' }).kind, 'opaque');
});

test('classify ignores segments, images, pixels, redirects, errors, non-http and license/idsync noise', () => {
  for (const url of ['https://c.test/seg-1.ts', 'https://c.test/a/chunk_12.mp4', 'https://c.test/v/init-0.mp4', 'https://c.test/x.m4s', 'https://c.test/t.vtt', 'https://c.test/p.gif', 'https://c.test/setuid', 'blob:https://c.test/uuid', 'file:///c:/a.mp4', 'javascript:1', 'https://js.stripe.com/v3/x.mp4']) {
    assert.equal(media.classify({ url }), null, url);
  }
  assert.equal(media.classify({ url: 'https://c.test/a.m3u8', status: 403 }), null);
  assert.equal(media.classify({ url: 'https://c.test/go/a.mp4', status: 302 }), null);
  assert.equal(media.classify({ url: 'https://c.test/x', contentType: 'image/gif' }), null);
  assert.equal(media.classify({ url: 'https://c.test/x', contentType: 'video/mp2t' }), null);
  assert.equal(media.classify({ url: 'https://c.test/x', contentType: 'text/html' }), null);
});

test('signed query parameters survive ranking byte for byte', () => {
  const url = 'https://cdn.test/hdntl=exp=1~acl=%2f*~hmac=ab/master.m3u8?sig=a%2Fb%2B%3D&Expires=17&Key-Pair-Id=K';
  const r = rank([obs(url, { fromPlayer: true })]);
  assert.equal(r.plausible[0].url, url);
});

test('the real video beats ads, tiny files, license calls and segments', () => {
  const r = rank([
    obs('https://ads.doubleclick.net/pre.mp4', { size: 3_000_000, at: now + 10 }),
    obs('https://cdn.test/ads/preroll.mp4?adid=7', { size: 4000, at: now + 20 }),
    obs('https://cdn.test/main/master.m3u8?t=1', { at: now }),
    obs('https://cdn.test/thumb-preview.mp4', { size: 90_000 }),
  ]);
  assert.equal(r.plausible[0].url, 'https://cdn.test/main/master.m3u8?t=1');
  assert.ok(!r.plausible.some((c) => /doubleclick|adid/.test(c.url)));
  assert.equal(r.ambiguous, false);
});

test('a player source confirmed in the DOM is preferred over background media', () => {
  const r = rank([
    obs('https://cdn.test/background-loop.mp4', { size: 5_000_000 }),
    obs('https://cdn.test/episode.mp4', { size: 5_000_000, fromPlayer: true }),
  ]);
  assert.equal(r.plausible[0].url, 'https://cdn.test/episode.mp4');
});

test('HLS master wins over the variant playlists the player requested next, even without telling names', () => {
  const r = rank([
    obs('https://cdn.test/v/ep1/master.m3u8?s=1', { at: now - 5000 }),
    obs('https://cdn.test/v/ep1/index.m3u8?s=1', { at: now }),
    obs('https://cdn.test/v/ep1/chunklist_720p.m3u8?s=1', { at: now + 1 }),
  ]);
  assert.deepEqual(r.plausible.map((c) => c.url), ['https://cdn.test/v/ep1/master.m3u8?s=1']);
  // Variants in a subfolder of the master's folder are subsumed too.
  const nested = rank([obs('https://cdn.test/v/master.m3u8', { at: now - 5000 }), obs('https://cdn.test/v/720p/index.m3u8', { at: now })]);
  assert.equal(nested.plausible.length, 1);
});

test('two unrelated streams in the same folder are both kept and reported as ambiguous', () => {
  const r = rank([obs('https://cdn.test/v/a.m3u8', { fromPlayer: true }), obs('https://cdn.test/v/b.m3u8', { fromPlayer: true })]);
  assert.equal(r.plausible.length, 2);
  assert.equal(r.ambiguous, true);
  const files = rank([obs('https://cdn.test/one.mp4', { size: 9_000_000, fromPlayer: true }), obs('https://cdn.test/two.mp4', { size: 9_000_000, fromPlayer: true })]);
  assert.equal(files.ambiguous, true);
});

test('the same media with a refreshed token is one candidate: the newest', () => {
  const r = rank([obs('https://cdn.test/m.m3u8?token=old', { at: now - 60000 }), obs('https://cdn.test/m.m3u8?token=new', { at: now })]);
  assert.equal(r.plausible.length, 1);
  assert.equal(r.plausible[0].url, 'https://cdn.test/m.m3u8?token=new');
});

test('the same URL seen twice merges: bigger size, player flag and observed request context are kept', () => {
  const ctx = { userAgent: 'UA', referer: 'https://site.test/p', origin: 'https://site.test' };
  const r = rank([
    { url: 'https://cdn.test/a.mp4', kind: 'file', size: 100, at: now, context: ctx, frameId: 0 },
    { url: 'https://cdn.test/a.mp4', kind: 'file', size: 9_000_000, at: now + 1, fromPlayer: true, context: { userAgent: 'UA', referer: 'https://site.test/p', origin: '' }, frameId: 0 },
  ]);
  const c = r.ranked[0];
  assert.equal(c.size, 9_000_000);
  assert.equal(c.fromPlayer, true);
  assert.equal(c.context.origin, 'https://site.test', 'the observed Origin is not replaced by a DOM-derived guess');
});

test('nothing plausible: weak candidates alone stay below the threshold', () => {
  assert.equal(rank([]).plausible.length, 0);
  assert.equal(rank([obs('https://x.test/ads/a.mp4', { size: 300 })]).plausible.length, 0);
  assert.equal(rank([{ url: 'https://x.test/stream/1', kind: 'embed' }]).ranked.length, 0);
  assert.equal(rank([obs('https://x.test/widevine/license.mp4')]).ranked.length, 0);
});

test('scope for cookies is exactly the media origin, its observed redirects and the player hosts', () => {
  const scope = media.scopeUrls({ url: 'https://cdn.test/a/m.m3u8?x=1', redirects: ['https://site.test/go/1', 'https://cdn.test/other'], hosts: ['seg.cdn2.test', 'cdn.test'] });
  assert.deepEqual(scope.map((u) => new URL(u).origin), ['https://cdn.test', 'https://site.test', 'https://seg.cdn2.test']);
  assert.deepEqual(media.scopeUrls({ url: 'javascript:1', redirects: ['blob:x'] }), []);
});

test('navigation URL comparison ignores only the fragment', () => {
  assert.equal(media.sameNavigationUrl('https://a.test/p?x=1#t=5', 'https://a.test/p?x=1'), true);
  assert.equal(media.sameNavigationUrl('https://a.test/p?x=1', 'https://a.test/p?x=2'), false);
  assert.equal(media.sameNavigationUrl('https://a.test/p', 'https://a.test/p/'), false);
});

test('redaction removes query values and CDN path tokens from text', () => {
  const text = media.redactUrl('failed https://cdn.test/hdntl=exp=1~hmac=zz/m.m3u8?sig=abc&Expires=9 now');
  assert.ok(!text.includes('abc') && !text.includes('hmac=zz'));
  assert.match(text, /sig=\[redacted\]/);
});

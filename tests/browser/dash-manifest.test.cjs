const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const media = require('../../extension/lib/media.js');
const policy = require('../../electron/domain/candidate-policy.cjs');
const { urlContentType } = require('../../electron/domain/content-type.cjs');
const { collectInPage } = require('../../extension/lib/collector.js');
const manifest = 'https://cdn.example/vod/2223260/Manifest.ism?token=a%2Fb';
const fragments = Array.from({ length: 276 }, (_, i) => `${manifest}&type=${i % 2 ? 'audio' : 'video'}&bitrate=5500000&id=1&start=${460000000 + i * 20000000}`);

test('DASH manifest is kept with its exact query while same-path audio/video fragments are rejected', () => {
  assert.equal(media.classify({ url: manifest }).kind, 'dash');
  assert.equal(media.classify({ url: manifest, contentType: 'application/dash+xml' }).kind, 'dash');
  assert.equal(policy.classify(manifest).kind, 'stream');
  assert.equal(urlContentType(manifest), 'video');
  for (const url of fragments) {
    assert.equal(media.classify({ url, contentType: 'video/mp4' }), null);
    assert.equal(policy.classify(url, 'video/mp4').reject, 'segment');
    assert.equal(policy.classifyPlayerSource(url).reject, 'segment');
  }
  assert.equal(media.rank([{ url: manifest, kind: 'dash', at: Date.now() }]).plausible[0].url, manifest);
  assert.equal(media.classify({ url: 'https://cdn.example/movie.mp4?start=10&type=video' }).kind, 'file');
});

test('late extension attachment recovers a manifest after hundreds of fragments without filling its candidate limit', () => {
  const result = vm.runInNewContext(`(${collectInPage.toString()})()`, {
    URL, document: { title: 'Lesson', URL: 'https://page.example/watch', baseURI: 'https://page.example/watch',
      querySelectorAll: () => [], querySelector: () => null },
    performance: { getEntriesByType: () => [...fragments, manifest].map(name => ({ name })) },
  });
  assert.deepEqual(Array.from(result.media), [manifest]);
});

test('Smooth manifest path remains a complete stream candidate and ordinary HLS/DASH remain supported', () => {
  for (const url of ['https://cdn.example/v.ism/Manifest?sig=x', 'https://cdn.example/v.mpd', 'https://cdn.example/v.m3u8']) {
    assert.ok(media.classify({ url }));
    assert.equal(policy.classify(url).kind, 'stream');
    assert.equal(urlContentType(url), 'video');
  }
});

// Pure renderer modules: link parsing, formatting, site search, row display rules.
import test from 'node:test';
import assert from 'node:assert/strict';
import { parseLinks } from '../src/domain/intake/parseLinks.js';
import { fmtDuration, fmtQuality, fmtSize, isAudio } from '../src/presentation/formatters.js';
import { siteInfo, siteLabel } from '../src/presentation/sitePresentation.js';
import { engineMessage, appUpdateMessage } from '../src/presentation/updateMessages.js';
import { errorLabel } from '../src/presentation/errorMessages.js';
import { searchTerms, searchSites, verdictOf } from '../src/features/sites/siteSearchPolicy.js';
import { rowState, lookupLine } from '../src/features/downloads/rowState.js';

test('parseLinks: one link per line, text before it becomes the label, signed queries kept', () => {
  assert.deepEqual(parseLinks('שיעור מספר 2: https://a.example/x?token=abc.def\nnothing here\r\nhttps://b.example/y'), [
    { url: 'https://a.example/x?token=abc.def', label: 'שיעור מספר 2' },
    { url: 'https://b.example/y', label: '' },
  ]);
  assert.deepEqual(parseLinks('Lesson 3 – https://c.example/z "quoted"'), [{ url: 'https://c.example/z', label: 'Lesson 3' }]);
  assert.deepEqual(parseLinks(''), []);
  assert.deepEqual(parseLinks('ftp://x.example/file'), []);
});

test('formatters', () => {
  assert.equal(fmtDuration(0), '');
  assert.equal(fmtDuration(61), '1:01');
  assert.equal(fmtDuration(3600 + 62), '1:01:02');
  assert.equal(fmtQuality(2160), '4K');
  assert.equal(fmtQuality(1440), '2K');
  assert.equal(fmtQuality(720), '720p');
  assert.equal(fmtSize(5 * 1024 * 1024), '5.0 MB');
  assert.equal(fmtSize(3 * 1024 ** 3), '3.00 GB');
  assert.equal(isAudio('a.MP3'), true);
  assert.equal(isAudio('a.mp4'), false);
});

test('site presentation: brand marks for known sites, letter badge otherwise', () => {
  assert.equal(siteInfo('Youtube').name, 'YouTube');
  assert.equal(siteInfo('YoutubeTab').name, 'YouTube');
  assert.deepEqual(siteInfo('Generic'), { name: 'Generic', color: '#8b8fa3', letter: 'G' });
  assert.equal(siteInfo(null), null);
  assert.equal(siteLabel('youtube'), 'יוטיוב');
  assert.equal(siteLabel('dailymotion'), 'Dailymotion');
});

test('update and error messages', () => {
  assert.equal(engineMessage(null, null), 'המנוע לא נמצא');
  assert.equal(engineMessage({ status: 'done', result: { ok: true, updated: true, after: '2026.10.01' } }), 'עודכן לגרסה 2026.10.01');
  assert.equal(engineMessage({ status: 'done', result: { busy: true } }), 'אי אפשר לעדכן בזמן הורדה');
  assert.equal(appUpdateMessage({ state: 'dev' }), 'בדיקת עדכונים פועלת רק בגרסה המותקנת.');
  assert.equal(errorLabel('protected', 'x'), 'הסרטון מוגן בהגנת העתקה (DRM), ואי אפשר להוריד אותו');
  assert.equal(errorLabel('weird', 'fallback'), 'fallback');
  assert.match(errorLabel('browserContext', 'x', { name: 'Brave' }), /Brave/);
  assert.equal(errorLabel('sessionRequired', 'x', { name: 'Edge' }), 'האתר דורש את Edge שבו אתה מחובר. פתח אותו, אשר את החיבור ונסה שוב');
  assert.match(errorLabel('sessionRequired', 'x', null), /הדפדפן/);
});

test('site search: links reduce to their name, adult sites only on exact search', () => {
  assert.deepEqual(searchTerms('https://www.dailymotion.com/video/x'), ['dailymotion']);
  assert.deepEqual(searchTerms('  Vimeo '), ['vimeo']);
  const sites = [{ name: 'Vimeo' }, { name: 'Dailymotion', broken: true }, { name: 'PornHub', adult: true }];
  assert.equal(searchSites(sites, '').listed.length, 2);
  assert.equal(verdictOf(searchSites(sites, 'vimeo').matches), 'ok');
  assert.equal(verdictOf(searchSites(sites, 'dailymotion').matches), 'broken');
  assert.equal(verdictOf(searchSites(sites, 'nothing').matches), 'no');
  const adult = searchSites(sites, 'pornhub');
  assert.equal(adult.shown.length, 0);
  assert.equal(adult.matches.length, 1);
  assert.equal(searchSites(sites, 'porn').matches.length, 0);
});

test('queue row display rules', () => {
  assert.deepEqual(rowState({ status: 'waiting' }), { isError: false, waiting: true, analyzing: true });
  assert.deepEqual(rowState({ status: 'error' }), { isError: true, waiting: false, analyzing: false });
  assert.equal(lookupLine({ status: 'waiting', label: 'שיעור 7' }), 'שיעור 7');
  assert.equal(lookupLine({ status: 'analyzing', phase: 'browser', phaseBrowser: 'Brave' }), 'מנסה דרך Brave שלך…');
  assert.equal(lookupLine({ status: 'analyzing', phase: 'page' }), 'מחפש את הסרטון בתוך הנגן שבעמוד…');
  assert.equal(lookupLine({ status: 'analyzing' }), 'מזהה סרטון…');
});

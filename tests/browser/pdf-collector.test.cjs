const test = require('node:test');
const assert = require('node:assert/strict');
const vm = require('node:vm');
const { collectInPage } = require('../../extension/lib/pdf.js');

function scan(resources, elements = []) {
  const result = vm.runInNewContext(`(${collectInPage.toString()})()`, {
    URL, location: { href: 'https://whop.test/course' },
    document: { baseURI: 'https://whop.test/course', title: 'Lesson', contentType: 'text/html', querySelectorAll: () => elements },
    performance: { getEntriesByType: type => { assert.equal(type, 'resource'); return resources; } },
  });
  return Array.from(result.links, c => c.url);
}

test('already-loaded Fetch/XHR originals survive absent DOM links with exact signed queries', () => {
  const signed = 'https://files.test/opaque?X-Amz-Signature=a%2Bb&response-content-type=application%2Fpdf';
  const named = 'https://files.test/other?response-content-disposition=inline%3B%20filename%3D%22lesson.pdf%22&sig=b%2Bc';
  const mime = 'https://files.test/no-extension?sig=c%2Bd';
  assert.deepEqual(scan([{ name: signed }, { name: named }, { name: mime, contentType: 'application/pdf' }]), [signed, named, mime]);
});

test('resource recovery requires positive PDF hints and rejects unsafe or unrelated URLs', () => {
  assert.deepEqual(scan([
    { name: 'https://files.test/untyped?sig=opaque' },
    { name: 'https://files.test/movie.mp4' },
    { name: 'https://files.test/nope', contentType: 'application/pdf-fake' },
    { name: 'blob:https://files.test/doc', contentType: 'application/pdf' },
    { name: 'https://user:secret@files.test/doc.pdf' },
    { name: 'https://files.test/doc.pdf?sig=a%2Bb#page=2' },
  ]), ['https://files.test/doc.pdf?sig=a%2Bb']);
});

test('resource timing is optional; ordinary DOM PDFs still work', () => {
  const element = { getAttribute: name => name === 'href' ? '/guide.pdf' : '', textContent: 'Guide' };
  assert.deepEqual(scan([], [element]), ['https://whop.test/guide.pdf']);
});

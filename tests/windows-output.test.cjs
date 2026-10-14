// Windows only, with the real bundled yt-dlp.exe (GRAB_TEST_YTDLP_DIR, e.g. the fetched bin/):
// file names on NTFS (device names, long Hebrew titles, deep folders, collisions with existing
// files and between jobs) and the permissions of the temporary cookie-jar folder.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const DIR = process.env.GRAB_TEST_YTDLP_DIR;
const skip = process.platform !== 'win32' ? 'Windows only' : !(DIR && fs.existsSync(path.join(DIR, 'yt-dlp.exe'))) && 'set GRAB_TEST_YTDLP_DIR (bin with yt-dlp.exe)';

test('Windows: real yt-dlp writes device names, long Hebrew titles, deep folders and collisions safely', { skip, timeout: 180000 }, async (t) => {
  const site = await require('./fixtures/media-site.cjs').start();
  const engine = require('../electron/engine.cjs');
  const { OutputAllocator } = require('../electron/infrastructure/output-allocator.cjs');
  engine.setUserBinDir(DIR);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-win-names-'));
  const allocator = new OutputAllocator();
  const download = async (id, folder, name) => {
    fs.mkdirSync(folder, { recursive: true });
    const outputBase = allocator.allocate(id, folder, name);
    const r = await engine.download({ url: site.base + '/public/clip.mp4', outputBase, format: 'mp4', quality: 'best', findOutput: (b) => allocator.findOutput(b) }, () => {}).done;
    assert.equal(r.ok, true, `${name}: ${r.error}`);
    assert.ok(fs.existsSync(r.file), r.file);
    t.diagnostic(`${JSON.stringify(name).slice(0, 60)} -> ${path.basename(r.file)} (${r.file.length} chars)`);
    return r.file;
  };
  try {
    for (const device of ['CON', 'nul', 'COM1', 'LPT9', 'aux.mp4']) {
      const file = await download('dev-' + device, root, device);
      assert.match(path.basename(file), /^_/, 'a device name gets a prefix');
    }
    const hebrew = 'הכשרת הפרימיום המקיפה שיעור מספר 12: ניתוח טכני מתקדם ותבניות מסחר '.repeat(5);
    await download('he', root, hebrew);
    const deep = path.join(root, ...Array.from({ length: 9 }, (_, i) => 'תיקייה-עמוקה-' + i));
    const deepFile = await download('deep', deep, hebrew);
    assert.ok(deepFile.length <= 259, `deep path stays under MAX_PATH (${deepFile.length})`);
    fs.writeFileSync(path.join(root, 'Lesson.mp4'), 'the user\'s own file');
    const first = await download('a', root, 'Lesson');
    const second = await download('b', root, 'Lesson');
    assert.equal(fs.readFileSync(path.join(root, 'Lesson.mp4'), 'utf8'), 'the user\'s own file', 'an existing file is never overwritten');
    assert.deepEqual([path.basename(first), path.basename(second)], ['Lesson (2).mp4', 'Lesson (3).mp4']);
  } finally {
    await site.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('Windows: the cookie jar folder is not readable by other users', { skip: process.platform !== 'win32' && 'Windows only' }, async (t) => {
  const { CookieVault } = require('../electron/infrastructure/cookie-vault.cjs');
  const vault = new CookieVault();
  const ref = vault.remember([{ domain: '.a.example', path: '/', name: 's', value: 'v' }]);
  await vault.withJar(ref, async (file) => {
    const acl = execFileSync('icacls', [path.dirname(file)], { encoding: 'utf8' });
    t.diagnostic(acl.trim().replace(/\r?\n\s*/g, ' | '));
    assert.doesNotMatch(acl, /\bEveryone\b|BUILTIN\\Users|Authenticated Users/i, 'no broad read access');
    assert.match(acl, new RegExp(os.userInfo().username, 'i'), 'the owner has access');
  });
});

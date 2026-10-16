const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { detectBrowsers } = require('../../electron/browser/browsers.cjs');
const { resolveBrowser, pickInstance, sanitizeBrowserSettings, hostMatches, urlHost, siteRules } = require('../../electron/browser/selection.cjs');

// A throwaway "Program Files" with fake executables, so detection is tested against real files.
function fakeMachine(layout) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'grab-browsers-'));
  const env = { LOCALAPPDATA: path.join(root, 'Local'), ProgramFiles: path.join(root, 'Program Files'), 'ProgramFiles(x86)': path.join(root, 'Program Files (x86)') };
  const make = (rel) => { const p = path.join(root, ...rel); fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, 'MZ'); return p; };
  return { root, env, make, layout, clean: () => fs.rmSync(root, { recursive: true, force: true }) };
}
const registry = (values) => ({ readDefaultValue: async (key) => values[key] ?? null, readValue: async (key, name) => values[key + '|' + name] ?? null });

test('detection: no browsers installed yields an empty list', async () => {
  const m = fakeMachine();
  try {
    const result = await detectBrowsers({ platform: 'win32', adapter: registry({}), env: m.env });
    assert.deepEqual(result.browsers, []);
  } finally { m.clean(); }
});

test('detection: per-user and machine-wide installs, deduplicated, with spaces in paths', async () => {
  const m = fakeMachine();
  try {
    const edge = m.make(['Program Files (x86)', 'Microsoft', 'Edge', 'Application', 'msedge.exe']);
    const chromeUser = m.make(['Local', 'Google', 'Chrome', 'Application', 'chrome.exe']);
    const chromeMachine = m.make(['Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe']);
    const reg = registry({
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe': `"${edge}"`, // registry value, quoted, also found by folder: one entry
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe': chromeUser,
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe': '%ProgramFiles%\\Google\\Chrome\\Application\\chrome.exe',
    });
    const { browsers } = await detectBrowsers({ platform: 'win32', adapter: reg, env: m.env });
    assert.deepEqual(browsers.map((b) => b.id), ['edge', 'chrome']);
    assert.equal(browsers[0].exe, path.normalize(edge));
    assert.ok(browsers[0].exe.includes(' '), 'path with spaces is kept intact');
    const chrome = browsers[1];
    assert.equal(chrome.installs.length, 2);
    assert.equal(chrome.exe, path.normalize(chromeUser), 'per-user install is preferred');
    assert.deepEqual(chrome.installs.map((i) => i.scope), ['user', 'machine']);
    assert.equal(path.normalize(chrome.installs[1].exe), path.normalize(chromeMachine));
  } finally { m.clean(); }
});

test('detection: registry entries pointing at missing files or non-executables are ignored', async () => {
  const m = fakeMachine();
  try {
    const notExe = m.make(['Local', 'junk', 'brave.txt']);
    const reg = registry({
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\brave.exe': path.join(m.root, 'gone', 'brave.exe'),
      'HKLM\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\chrome.exe': notExe,
      'HKCU\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\msedge.exe': 'msedge.exe', // relative: not trusted
    });
    const { browsers } = await detectBrowsers({ platform: 'win32', adapter: reg, env: m.env });
    assert.deepEqual(browsers, []);
  } finally { m.clean(); }
});

test('detection: Brave and the system default browser are recognized; other platforms list nothing', async () => {
  const m = fakeMachine();
  try {
    m.make(['Local', 'BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe']);
    const reg = registry({ 'HKCU\\Software\\Microsoft\\Windows\\Shell\\Associations\\UrlAssociations\\https\\UserChoice|ProgId': 'BraveHTML' });
    const win = await detectBrowsers({ platform: 'win32', adapter: reg, env: m.env });
    assert.deepEqual(win.browsers.map((b) => b.id), ['brave']);
    assert.equal(win.systemDefault, 'brave');
    const linux = await detectBrowsers({ platform: 'linux' });
    assert.deepEqual(linux, { browsers: [], systemDefault: null, platform: 'linux' });
  } finally { m.clean(); }
});

const installed = (...ids) => ids.map((id) => ({ id, name: id, exe: 'C:\\x\\' + id + '.exe' }));

test('precedence: explicit choice > site rule > global default > suggestion', () => {
  const settings = { browser: { defaultBrowser: 'brave', siteRules: [{ host: 'mako.co.il', browser: 'edge' }] } };
  const all = installed('edge', 'chrome', 'brave');
  const url = 'https://www.mako.co.il/video/1';
  assert.equal(resolveBrowser({ url, explicit: 'chrome', settings, installed: all }).source, 'explicit');
  assert.equal(resolveBrowser({ url, explicit: 'chrome', settings, installed: all }).browserId, 'chrome');
  assert.deepEqual([resolveBrowser({ url, settings, installed: all }).browserId, resolveBrowser({ url, settings, installed: all }).source], ['edge', 'site-rule']);
  assert.deepEqual([resolveBrowser({ url: 'https://other.test/', settings, installed: all }).browserId, resolveBrowser({ url: 'https://other.test/', settings, installed: all }).source], ['brave', 'global']);
  const none = resolveBrowser({ url: 'https://other.test/', settings: {}, installed: installed('chrome', 'brave'), systemDefault: 'brave' });
  assert.deepEqual([none.browserId, none.source], ['brave', 'suggested']);
  assert.equal(resolveBrowser({ url: 'https://other.test/', settings: {}, installed: installed('brave', 'chrome') }).browserId, 'chrome');
  assert.equal(resolveBrowser({ url: 'https://other.test/', settings: {}, installed: [] }).problem, 'none_installed');
});

test('mako rule: seeded to Edge, matches the real hostname only, never forces Edge elsewhere', () => {
  const all = installed('edge', 'brave');
  const settings = { browser: { defaultBrowser: 'brave' } }; // no saved rules: the built-in mako -> Edge rule applies
  const pick = (url) => resolveBrowser({ url, settings, installed: all });
  assert.equal(pick('https://mako.co.il/x').browserId, 'edge');
  assert.equal(pick('https://www.mako.co.il/x').browserId, 'edge');
  assert.equal(pick('https://vod.mako.co.il/x').browserId, 'edge');
  assert.equal(pick('https://MAKO.CO.IL./x').browserId, 'edge');
  for (const lookalike of ['https://notmako.co.il/', 'https://mako.co.il.evil.test/', 'https://evil.test/?u=mako.co.il', 'https://evil.test/mako.co.il', 'https://mako.co.il@evil.test/', 'https://example.com/']) {
    assert.equal(pick(lookalike).browserId, 'brave', lookalike);
  }
  assert.equal(urlHost('ftp://mako.co.il/'), '');
  assert.equal(hostMatches('mako.co.il', 'xmako.co.il'), false);
  // An explicit selection overrides the suggestion.
  assert.equal(resolveBrowser({ url: 'https://www.mako.co.il/x', explicit: 'brave', settings, installed: all }).browserId, 'brave');
});

test('a saved rule list replaces the seeded one; deleting the mako rule is respected', () => {
  const settings = { browser: { defaultBrowser: 'brave', siteRules: [] } };
  assert.equal(resolveBrowser({ url: 'https://www.mako.co.il/x', settings, installed: installed('edge', 'brave') }).browserId, 'brave');
  assert.deepEqual(siteRules({}), [{ host: 'mako.co.il', browser: 'edge' }]);
  const custom = { browser: { siteRules: [{ host: 'example.org', browser: 'chrome' }, { host: 'a.example.org', browser: 'edge' }] } };
  assert.equal(resolveBrowser({ url: 'https://a.example.org/', settings: custom, installed: installed('edge', 'chrome') }).browserId, 'edge', 'most specific rule wins');
});

test('a selected browser that is not installed is reported, never silently replaced', () => {
  const r = resolveBrowser({ url: 'https://www.mako.co.il/x', settings: {}, installed: installed('brave', 'chrome') });
  assert.equal(r.browserId, 'edge');
  assert.equal(r.available, false);
  assert.equal(r.problem, 'not_installed');
});

test('instances: one is used, several require a choice, remembered choice is honoured, no silent profile switch', () => {
  const a = { key: 'edge:a', browser: 'edge', instanceId: 'a' };
  const b = { key: 'edge:b', browser: 'edge', instanceId: 'b' };
  const c = { key: 'chrome:c', browser: 'chrome', instanceId: 'c' };
  assert.equal(pickInstance({ browserId: 'edge', instances: [a, c] }).instance, a);
  assert.equal(pickInstance({ browserId: 'brave', instances: [a, c] }).problem, 'not_connected');
  const choice = pickInstance({ browserId: 'edge', instances: [a, b, c] });
  assert.equal(choice.problem, 'choice_required');
  assert.deepEqual(choice.options, [a, b]);
  const settings = { browser: { instanceChoice: { edge: 'edge:b' } } };
  assert.equal(pickInstance({ browserId: 'edge', instances: [a, b], settings }).instance, b);
  const gone = pickInstance({ browserId: 'edge', instances: [a], settings });
  assert.equal(gone.problem, 'instance_disconnected');
  assert.equal(pickInstance({ browserId: 'edge', instances: [a, b], explicitInstance: 'edge:a', settings }).instance, a);
  assert.equal(pickInstance({ browserId: 'edge', instances: [b], explicitInstance: 'edge:a' }).problem, 'instance_disconnected');
});

test('saved browser settings are sanitized and persist only valid values', () => {
  const next = sanitizeBrowserSettings({
    defaultBrowser: 'brave',
    siteRules: [{ host: 'Mako.co.il', browser: 'edge' }, { host: 'mako.co.il', browser: 'chrome' }, { host: 'https://x.test/path', browser: 'edge' }, { host: 'ok.test', browser: 'firefox' }, { host: 'bad host', browser: 'edge' }],
    instanceChoice: { edge: 'edge:abc', chrome: 'edge:wrong-prefix', firefox: 'x' },
    instanceAliases: { 'edge:abc': 'עבודה'.repeat(30) },
  }, { instanceChoice: { brave: 'brave:z' } });
  assert.equal(next.defaultBrowser, 'brave');
  assert.deepEqual(next.siteRules, [{ host: 'mako.co.il', browser: 'edge' }]);
  assert.deepEqual(next.instanceChoice, { brave: 'brave:z', edge: 'edge:abc' });
  assert.equal(next.instanceAliases['edge:abc'].length, 40);
  assert.equal(sanitizeBrowserSettings({ defaultBrowser: 'firefox' }, { defaultBrowser: 'edge' }).defaultBrowser, null);
  assert.deepEqual(sanitizeBrowserSettings({ instanceChoice: { edge: null } }, next).instanceChoice, { brave: 'brave:z' });
});

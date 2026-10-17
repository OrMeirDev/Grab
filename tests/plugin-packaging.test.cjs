const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { getFileMatchers } = require('app-builder-lib/out/fileMatcher');

test('the real resource packager ships policy source and excludes compiled or unrelated inputs', () => {
  const root = path.resolve(__dirname, '..');
  const config = require('../package.json').build;
  const matchers = getFileMatchers(config, 'extraResources', path.join(root, 'release-proof'), {
    defaultSrc: root, macroExpander: (v) => v, customBuildOptions: {}, globalOutDir: path.join(root, 'release'),
  });
  const matcher = matchers.find((m) => m.from === path.join(root, 'engine-plugins'));
  assert.ok(matcher);
  const filter = matcher.createFilter();
  const accepts = (relative, directory = false) => filter(path.join(matcher.from, relative), { isDirectory: () => directory });
  for (const directory of ['grab', 'grab/yt_dlp_plugins', 'grab/yt_dlp_plugins/postprocessor']) assert.equal(accepts(directory, true), true, directory);
  assert.equal(accepts('grab/yt_dlp_plugins/postprocessor/grab_privacy.py'), true);
  for (const file of ['grab/yt_dlp_plugins/postprocessor/__pycache__/grab_privacy.cpython-312.pyc',
    'grab/yt_dlp_plugins/postprocessor/grab_privacy.pyc', 'secret.env', 'unreviewed.dll']) assert.equal(accepts(file), false, file);
  assert.equal(accepts('grab/yt_dlp_plugins/postprocessor/__pycache__', true), false);
});

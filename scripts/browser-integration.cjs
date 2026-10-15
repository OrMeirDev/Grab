// Developer CLI. Installed users perform these actions through Settings → Browser and extension.
const path = require('node:path');
const setup = require('../electron/browser/setup.cjs');
const { detectBrowsers } = require('../electron/browser/browsers.cjs');

async function main(args) {
  const [action = 'health', ...ids] = args;
  if (!['install', 'repair', 'health', 'uninstall'].includes(action) || ids.some((id) => !setup.BROWSER_IDS.includes(id))) {
    throw new Error('Usage: npm run browser:setup -- install|repair|health|uninstall [edge chrome brave]');
  }
  if (process.platform !== 'win32') throw new Error('Browser registration is supported on Windows. No changes made.');
  const sourceRoot = path.join(__dirname, '..');
  const appVersion = require('../package.json').version;
  if (action === 'uninstall') {
    await setup.uninstall();
    console.log('GRAB browser connection removed. Remove the unpacked extension from each browser as well.');
    return;
  }
  const detected = (await detectBrowsers()).browsers;
  if (action === 'install' || action === 'repair') {
    const browsers = ids.length ? ids : detected.map((b) => b.id);
    if (!browsers.length) throw new Error('No supported installed browser found.');
    const installed = await setup.install({ sourceRoot, appVersion, browsers });
    console.log('Load unpacked from: ' + installed.extensionDir);
    console.log('Extension ID: ' + installed.extensionId);
  }
  const report = await setup.health({ sourceRoot, appVersion, detected });
  for (const r of report.results) console.log(`${r.browser}: ${r.state}${r.problems.length ? ' (' + r.problems.join(', ') + ')' : ''}`);
  console.log('A disconnected status is not proof that the extension is missing. Test the live connection in GRAB Settings.');
}

main(process.argv.slice(2)).catch((error) => { console.error(error.message); process.exitCode = 1; });

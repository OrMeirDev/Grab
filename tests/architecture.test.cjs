// Import rules (see docs/architecture.md). A failing test here means a module reached across a
// boundary it must not cross; move the code, don't loosen the rule without updating the doc.
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NODE_BUILTINS = new Set(require('node:module').builtinModules.flatMap((m) => [m, 'node:' + m]));

function files(dir, re) {
  const out = [];
  if (!fs.existsSync(dir)) return out;
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) out.push(...files(p, re));
    else if (re.test(ent.name)) out.push(p);
  }
  return out;
}

// Every module specifier a file imports or requires.
function specifiers(file) {
  const src = fs.readFileSync(file, 'utf8');
  const out = [];
  for (const re of [/\bimport\s+(?:[^'"]*?\s+from\s+)?['"]([^'"]+)['"]/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g, /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (let m; (m = re.exec(src));) out.push(m[1]);
  }
  return out;
}

const rel = (file) => path.relative(ROOT, file).split(path.sep).join('/');
// The renderer area a file belongs to: app, components, design, domain, features/<name>, platform, presentation.
function area(file) {
  const parts = rel(file).split('/');
  if (parts[0] !== 'src') return null;
  if (parts.length === 2) return 'root';
  return parts[1] === 'features' ? `features/${parts[2]}` : parts[1];
}
const target = (file, spec) => (spec.startsWith('.') ? path.resolve(path.dirname(file), spec) : null);

const renderer = files(path.join(ROOT, 'src'), /\.(js|jsx|mjs)$/);

test('the renderer never reaches Node, Electron or the filesystem', () => {
  for (const file of renderer) {
    for (const spec of specifiers(file)) {
      assert.ok(!NODE_BUILTINS.has(spec) && spec !== 'electron', `${rel(file)} imports ${spec}`);
    }
  }
});

test('only the platform module touches the preload bridge', () => {
  for (const file of renderer) {
    if (rel(file) === 'src/platform/grabApi.js') continue;
    assert.doesNotMatch(fs.readFileSync(file, 'utf8'), /window\.grab\b/, rel(file));
  }
});

// Which renderer areas each area may import from (its own area is always allowed).
const ALLOWED = {
  domain: [],
  presentation: [],
  platform: [],
  design: [],
  components: ['design', 'presentation', 'app/routes'],
  app: ['components', 'design', 'domain', 'presentation', 'platform', 'features/*'],
  root: ['app', 'design'],
};
const FEATURE_DEPS = ['components', 'design', 'domain', 'presentation', 'platform'];
// Composition edges between features, kept explicit.
const CROSS_FEATURE = { 'features/downloads': ['features/intake'] };

test('renderer layers import only downward', () => {
  for (const file of renderer) {
    const from = area(file);
    for (const spec of specifiers(file)) {
      const t = target(file, spec);
      if (!t || !rel(t).startsWith('src/')) continue;
      const to = area(t.endsWith('.js') || t.endsWith('.jsx') ? t : t + '.js');
      if (to === from) continue;
      const allowed = from.startsWith('features/')
        ? [...FEATURE_DEPS, ...(CROSS_FEATURE[from] || [])]
        : ALLOWED[from] || [];
      const ok = allowed.some((a) => a === to || (a === 'features/*' && to.startsWith('features/')) || (a === 'app/routes' && rel(t).startsWith('src/app/routes')));
      assert.ok(ok, `${rel(file)} (${from}) may not import ${spec} (${to})`);
    }
  }
});

test('pure renderer modules (domain, presentation, policies) import no UI framework', () => {
  const pure = renderer.filter((f) => /^src\/(domain|presentation)\//.test(rel(f)) || /Policy\.js$|rowState\.js$/.test(f));
  assert.ok(pure.length >= 6);
  for (const file of pure) {
    for (const spec of specifiers(file)) {
      assert.ok(!/^(react|react-dom|lucide-react)/.test(spec), `${rel(file)} imports ${spec}`);
    }
  }
});

test('nothing imports the app shell except the entry point', () => {
  for (const file of renderer) {
    if (rel(file) === 'src/main.jsx') continue;
    for (const spec of specifiers(file)) assert.doesNotMatch(spec, /AppShell/, rel(file));
  }
});

// ---- main process ------------------------------------------------------------------------------
const main = files(path.join(ROOT, 'electron'), /\.cjs$/);
const mainArea = (file) => rel(file).split('/')[1].replace(/\.cjs$/, '');

test('main-process domain rules and contracts are pure (no Electron, filesystem, processes or network)', () => {
  const pure = main.filter((f) => ['domain'].includes(mainArea(f)) || rel(f) === 'electron/ipc/contracts.cjs');
  assert.ok(pure.length >= 3);
  for (const file of pure) {
    for (const spec of specifiers(file)) {
      assert.ok(spec.startsWith('./') || spec.startsWith('../domain/'), `${rel(file)} requires ${spec}`);
      const t = path.resolve(path.dirname(file), spec);
      assert.ok(rel(t).startsWith('electron/domain/') || rel(t) === 'electron/ipc/contracts.cjs', `${rel(file)} requires ${spec}`);
    }
  }
});

test('application services get Electron and the platform injected, never required', () => {
  for (const file of main.filter((f) => mainArea(f) === 'application')) {
    for (const spec of specifiers(file)) {
      assert.ok(spec !== 'electron' && !NODE_BUILTINS.has(spec), `${rel(file)} requires ${spec}`);
      assert.ok(!spec.startsWith('.') || /^\.\.?\/(domain|application)\//.test(spec) || /^\.\/[\w-]+\.cjs$/.test(spec), `${rel(file)} requires ${spec}`);
    }
  }
});

test('only the composition root, the window policy and the Electron adapters require electron', () => {
  const allowed = new Set(['electron/main.cjs', 'electron/preload.cjs', 'electron/hidden-probe.cjs']);
  for (const file of main) {
    if (specifiers(file).includes('electron')) assert.ok(allowed.has(rel(file)), `${rel(file)} requires electron`);
  }
});

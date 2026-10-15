// Which browser (and which connected profile) a download uses.
// Precedence: explicit choice for this download > saved site rule > saved global default >
// suggestion. A selected browser that is missing or disconnected is reported, never replaced.
const { isSupportedId } = require('./browsers.cjs');

// Rules a fresh install starts with. Once the user saves their own list, theirs replaces it.
const DEFAULT_SITE_RULES = [{ host: 'mako.co.il', browser: 'edge' }];

const normalizeHost = (value) => String(value || '').trim().toLowerCase().replace(/\.$/, '');
const HOST_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
const isRuleHost = (host) => HOST_RE.test(normalizeHost(host));

// The real hostname of an http(s) URL: "evil.test/?u=mako.co.il" or "notmako.co.il" do not match.
function urlHost(url) {
  try {
    const u = new URL(url);
    return /^https?:$/.test(u.protocol) ? normalizeHost(u.hostname) : '';
  } catch { return ''; }
}
const hostMatches = (ruleHost, host) => {
  const rule = normalizeHost(ruleHost);
  return !!rule && !!host && (host === rule || host.endsWith('.' + rule));
};

function siteRules(settings) {
  const saved = settings && settings.browser && settings.browser.siteRules;
  return Array.isArray(saved) ? saved.filter((r) => r && isRuleHost(r.host) && isSupportedId(r.browser)) : DEFAULT_SITE_RULES;
}

// Returns { browserId, source, available, problem?, installed }:
//   source: 'explicit' | 'site-rule' | 'global' | 'suggested' | 'none'
//   problem: 'not_installed' | 'none_installed'
function resolveBrowser({ url, explicit, settings, installed = [], systemDefault = null } = {}) {
  const have = new Set(installed.map((b) => b.id));
  const done = (browserId, source, extra = {}) => ({ browserId, source, available: have.has(browserId), ...(have.has(browserId) ? {} : { problem: 'not_installed' }), ...extra });
  if (explicit && isSupportedId(explicit)) return done(explicit, 'explicit');
  const host = urlHost(url);
  // The most specific rule (longest host) wins when several match.
  const rule = siteRules(settings).filter((r) => hostMatches(r.host, host)).sort((a, b) => b.host.length - a.host.length)[0];
  if (rule) return done(rule.browser, 'site-rule', { rule: { host: normalizeHost(rule.host), browser: rule.browser } });
  const saved = settings && settings.browser && settings.browser.defaultBrowser;
  if (saved && isSupportedId(saved)) return done(saved, 'global');
  const suggestion = (systemDefault && have.has(systemDefault) ? systemDefault : null) || ['edge', 'chrome', 'brave'].find((id) => have.has(id)) || null;
  if (suggestion) return done(suggestion, 'suggested');
  return { browserId: null, source: 'none', available: false, problem: 'none_installed' };
}

// Which connected profile of the chosen browser. Sessions of different profiles are different
// logins, so only a single obvious or previously remembered instance is used automatically.
// Returns { instance } or { problem: 'not_connected' | 'instance_disconnected' | 'choice_required', options }.
function pickInstance({ browserId, instances = [], settings, explicitInstance } = {}) {
  const mine = instances.filter((i) => i.browser === browserId);
  if (explicitInstance) {
    const hit = mine.find((i) => i.key === explicitInstance);
    return hit ? { instance: hit } : { problem: 'instance_disconnected', options: mine };
  }
  const remembered = settings && settings.browser && settings.browser.instanceChoice && settings.browser.instanceChoice[browserId];
  if (remembered) {
    const hit = mine.find((i) => i.key === remembered);
    return hit ? { instance: hit } : { problem: 'instance_disconnected', options: mine };
  }
  if (mine.length === 0) return { problem: 'not_connected', options: [] };
  if (mine.length === 1) return { instance: mine[0] };
  return { problem: 'choice_required', options: mine };
}

// Normalizes what the renderer may save, rejecting anything that is not a known browser or a plain host.
function sanitizeBrowserSettings(input, current = {}) {
  const out = { ...current };
  if (input && 'defaultBrowser' in input) out.defaultBrowser = isSupportedId(input.defaultBrowser) ? input.defaultBrowser : null;
  if (input && Array.isArray(input.siteRules)) {
    const seen = new Set();
    out.siteRules = input.siteRules.filter((r) => r && isRuleHost(r.host) && isSupportedId(r.browser))
      .map((r) => ({ host: normalizeHost(r.host), browser: r.browser }))
      .filter((r) => (seen.has(r.host) ? false : seen.add(r.host)))
      .slice(0, 50);
  }
  if (input && input.instanceChoice && typeof input.instanceChoice === 'object') {
    out.instanceChoice = { ...(current.instanceChoice || {}) };
    for (const [id, key] of Object.entries(input.instanceChoice)) {
      if (!isSupportedId(id)) continue;
      if (key === null) delete out.instanceChoice[id];
      else if (typeof key === 'string' && key.startsWith(id + ':') && key.length <= 100) out.instanceChoice[id] = key;
    }
  }
  if (input && input.instanceAliases && typeof input.instanceAliases === 'object') {
    out.instanceAliases = { ...(current.instanceAliases || {}) };
    for (const [key, alias] of Object.entries(input.instanceAliases)) {
      if (typeof key !== 'string' || key.length > 100) continue;
      if (!alias) delete out.instanceAliases[key];
      else if (typeof alias === 'string') out.instanceAliases[key] = alias.slice(0, 40);
    }
  }
  return out;
}

module.exports = { DEFAULT_SITE_RULES, siteRules, resolveBrowser, pickInstance, sanitizeBrowserSettings, urlHost, hostMatches, isRuleHost, normalizeHost };

// The desktop-side owner of browser integration: detection, selection, extension connections,
// discovery jobs, the handoff of one job's session context to the downloader, and "Send to GRAB".
// It holds the authoritative state of a browser-assisted lookup; the renderer only displays it.
const path = require('path');
const crypto = require('crypto');
const { execFile, spawn } = require('child_process');
const { EventEmitter } = require('events');
const protocol = require('../../extension/lib/protocol.js');
const media = require('../../extension/lib/media.js');
const { BrowserHub } = require('./hub.cjs');
const { discover, connectInstance, revealTab, BrowserError } = require('./discovery.cjs');
const { detectBrowsers, browserName } = require('./browsers.cjs');
const selection = require('./selection.cjs');
const setup = require('./setup.cjs');
const { siteKey } = require('../domain/site-policy.cjs');
const { filterScopedCookies } = require('../domain/cookie-scope.cjs');

const { DEADLINE_DEFAULTS, DEADLINE_LIMITS } = selection;

const defaultDeps = {
  isRunning: (browserId) => new Promise((resolve) => {
    const exe = { edge: 'msedge.exe', chrome: 'chrome.exe', brave: 'brave.exe' }[browserId];
    if (!exe || process.platform !== 'win32') return resolve(false);
    execFile('tasklist', ['/FI', `IMAGENAME eq ${exe}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true, timeout: 5000 },
      (err, out) => resolve(!err && out.toLowerCase().includes(`"${exe}"`)));
  }),
  // Argument array, no shell: the browser is started with no arguments and opens as the user normally does.
  launch: (exe) => { const child = spawn(exe, [], { detached: true, stdio: 'ignore' }); child.on('error', () => {}); child.unref(); },
  stopHost: (pid) => new Promise((resolve) => {
    if (!Number.isInteger(pid) || pid <= 0) return resolve();
    if (process.platform === 'win32') execFile('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true }, () => resolve());
    else { try { process.kill(pid, 'SIGTERM'); } catch { /* already exited */ } resolve(); }
  }),
};

const domainMatches = (host, domain) => {
  const d = String(domain).toLowerCase();
  const h = String(host).toLowerCase();
  return d.startsWith('.') ? h === d.slice(1) || h.endsWith(d) : h === d;
};

class BrowserService extends EventEmitter {
  constructor({ appVersion = '0', sourceRoot, integrationDir = setup.defaultIntegrationDir(), getSettings, saveSettings, notify = () => {}, askRenderer = async () => 'unavailable', acceptIncoming, engine, session, deps = {}, registry = setup.windowsRegistry } = {}) {
    super();
    Object.assign(this, { appVersion, sourceRoot, integrationDir, getSettings, saveSettings, notify, askRenderer, engine, session, registry });
    this.deps = { ...defaultDeps, ...deps };
    this.acceptIncoming = acceptIncoming || ((payload) => this.askRenderer('browser:incoming', payload, 3000));
    this.active = new Map(); // renderer item id -> { abort, jobId, instance }
    this.choices = new Map(); // token -> pending "which video?" choice
    this.incoming = new Map(); // ref -> { instanceKey, scopeKey, candidate, url, terminal }
    this.recentSends = new Map(); // normalized page url -> { ref, at }
    this.detected = { browsers: [], systemDefault: null };
    this.health = null;
    this.healthAt = 0;
    this.hub = null;
    this.startError = '';
    this.settingsWrites = Promise.resolve();
    this.cookieRefs = new Map(); // instance key -> this connection's opaque vault handles
  }

  // ---------------------------------------------------------------- lifecycle
  async init() {
    this.identity = setup.readExtensionIdentity(path.join(this.sourceRoot, 'extension'));
    this.hub = new BrowserHub({ integrationDir: this.integrationDir, allowedOrigins: [this.identity.origin], appVersion: this.appVersion });
    try { await this.hub.start(); } catch (e) { this.startError = String(e && e.message || e); }
    this.hub.on('instances', () => this.changed());
    this.hub.on('failure', () => this.changed());
    this.hub.on('disconnected', (inst) => this.dropInstanceSession(inst.key));
    this.hub.on('message', (inst, m) => { if (m.type === 'send-to-grab') this.onSend(inst, m); });
    await this.refresh();
    await this.autoRepair();
  }

  shutdown() {
    for (const entry of this.active.values()) entry.abort.abort();
    this.active.clear();
    for (const key of this.cookieRefs.keys()) this.dropInstanceSession(key);
    if (this.hub) this.hub.stop();
  }

  changed() { this.notify('browser:changed', null); this.emit('changed'); }

  async refresh() {
    this.detected = await detectBrowsers();
    await this.refreshHealth();
    this.changed();
    return this.state();
  }

  async refreshHealth() {
    this.health = await setup.health({ integrationDir: this.integrationDir, registry: this.registry, hub: this.hub, detected: this.detected.browsers, appVersion: this.appVersion, sourceRoot: this.sourceRoot, runtimeVerified: this.runtimeVerified });
    this.healthAt = Date.now();
  }

  // A previously set-up installation follows the app: new app version or moved program => repair quietly.
  async autoRepair() {
    const record = setup.readInstall(this.integrationDir);
    if (!record || !record.browsers || !record.browsers.length) return;
    const runtime = setup.resolveRuntime();
    this.runtimeVerified = false;
    if (record.appVersion === this.appVersion && record.runtime === runtime &&
      record.integrationVersion === setup.INTEGRATION_VERSION && record.extensionVersion === this.identity.version) {
      try {
        this.runtimeVerified = await setup.hostRuntimeIsCurrent({ runtime, sourceRoot: this.sourceRoot,
          integrationDir: this.integrationDir, appVersion: this.appVersion, hostRuntime: record.hostRuntime });
      } catch { /* repair below; report a stale connection if it cannot be repaired */ }
      if (this.runtimeVerified) return;
    }
    try {
      await setup.install({ sourceRoot: this.sourceRoot, integrationDir: this.integrationDir,
        browsers: record.browsers, appVersion: this.appVersion, registry: this.registry, runtime });
      this.runtimeVerified = true;
    } catch { /* shown by health */ }
    await this.refreshHealth();
  }

  // ---------------------------------------------------------------- settings and state
  settings() { return (this.getSettings() || {}).browser || {}; }

  deadlines() {
    const saved = this.settings();
    const out = {};
    for (const [key, fallback] of Object.entries(DEADLINE_DEFAULTS)) {
      const [lo, hi] = DEADLINE_LIMITS[key];
      out[key] = Number.isFinite(saved[key]) && saved[key] >= lo && saved[key] <= hi ? saved[key] : fallback;
    }
    return out;
  }

  setSettings(patch) {
    const saved = this.settingsWrites.then(() => this.applySettings(patch));
    this.settingsWrites = saved.catch(() => {});
    return saved;
  }

  async applySettings(patch) {
    const current = this.settings();
    const next = selection.sanitizeBrowserSettings(patch, current);
    for (const [key, [lo, hi]] of Object.entries(DEADLINE_LIMITS)) {
      if (patch && key in patch) {
        if (patch[key] === null) delete next[key];
        else if (Number.isFinite(patch[key]) && patch[key] >= lo && patch[key] <= hi) next[key] = Math.round(patch[key]);
      }
    }
    await this.saveSettings({ browser: next });
    this.changed();
    return this.state();
  }

  instanceLabel(inst) {
    const s = this.settings();
    const custom = s.instanceAliases && s.instanceAliases[inst.key];
    if (custom) return custom;
    if (inst.alias) return inst.alias;
    const same = this.hub.instances().filter((i) => i.browser === inst.browser).sort((a, b) => a.connectedAt - b.connectedAt);
    return same.length > 1 ? `${browserName(inst.browser)} · פרופיל ${same.findIndex((i) => i.key === inst.key) + 1}` : browserName(inst.browser);
  }

  state() {
    const s = this.settings();
    const instances = this.hub ? this.hub.instances() : [];
    const health = this.health || { results: [] };
    const effective = selection.resolveBrowser({ url: '', settings: { browser: { ...s, siteRules: [] } }, installed: this.detected.browsers, systemDefault: this.detected.systemDefault });
    return {
      supported: process.platform === 'win32',
      extensionId: health.extensionId || (this.identity && this.identity.id) || '',
      extensionDir: health.extensionDir || '',
      installed: !!health.installed,
      startError: this.startError,
      browsers: ['edge', 'chrome', 'brave'].map((id) => {
        const det = this.detected.browsers.find((b) => b.id === id);
        const h = health.results.find((r) => r.browser === id) || { state: 'not_detected', problems: [] };
        const problems = [...h.problems];
        if (this.identity?.version && instances.some((i) => i.browser === id && i.extVersion !== this.identity.version)) problems.push('extension_outdated');
        return {
          id, name: browserName(id), detected: !!det, systemDefault: this.detected.systemDefault === id,
          state: problems.length ? 'setup_problem' : instances.some((i) => i.browser === id) ? 'connected' : h.state === 'connected' ? 'unknown' : h.state, problems, failure: h.failure,
          instances: instances.filter((i) => i.browser === id).map((i) => ({ key: i.key, label: this.instanceLabel(i), extVersion: i.extVersion })),
        };
      }),
      settings: {
        defaultBrowser: s.defaultBrowser || null,
        siteRules: selection.siteRules({ browser: s }),
        instanceChoice: s.instanceChoice || {},
        instanceAliases: s.instanceAliases || {},
        ...this.deadlines(),
      },
      effectiveDefault: { browserId: effective.browserId, source: effective.source },
    };
  }

  resolve(url, { browser: explicit } = {}) {
    const r = selection.resolveBrowser({ url, explicit, settings: { browser: this.settings() }, installed: this.detected.browsers, systemDefault: this.detected.systemDefault });
    return { ...r, name: r.browserId ? browserName(r.browserId) : '' };
  }

  // The extension path is used only for a browser that has been set up; otherwise the legacy
  // remote-debugging lookup keeps working exactly as before.
  isSetUp(browserId) {
    const h = this.health && this.health.results.find((r) => r.browser === browserId);
    return !!h && h.registered && !h.problems.some((p) => p !== 'stale_version');
  }
  isConfigured(browserId) {
    return !!this.health?.results?.some((h) => h.browser === browserId && h.registered) ||
      !!setup.readInstall(this.integrationDir)?.browsers?.includes(browserId);
  }
  hasConnected(browserId) { return !!this.hub && this.hub.instances().some((i) => i.browser === browserId); }

  getInstanceFn(browserId, explicitInstance) {
    return () => selection.pickInstance({ browserId, instances: this.hub.instances(), settings: { browser: this.settings() }, explicitInstance });
  }

  browserEntry(browserId) {
    const det = this.detected.browsers.find((b) => b.id === browserId);
    return { id: browserId, name: browserName(browserId), exe: det ? det.exe : null };
  }

  // ---------------------------------------------------------------- setup, test
  async setup({ browsers } = {}) {
    const ids = (browsers && browsers.length ? browsers : this.detected.browsers.map((b) => b.id));
    if (!ids.length) return { ok: false, kind: 'noBrowser' };
    try {
      const r = await setup.install({ sourceRoot: this.sourceRoot, integrationDir: this.integrationDir, browsers: ids, appVersion: this.appVersion, registry: this.registry });
      this.runtimeVerified = true;
      await this.refresh();
      return { ok: true, extensionDir: r.extensionDir, extensionId: r.id || this.identity.id, state: this.state() };
    } catch (e) { return { ok: false, kind: 'setupFailed', error: String(e && e.message || e).slice(0, 200) }; }
  }

  async uninstall() {
    const pids = this.hub.instances().map((i) => this.hub.hostPid(i.key));
    await setup.uninstall({ integrationDir: this.integrationDir, registry: this.registry,
      beforeRemove: () => Promise.all(pids.map((pid) => this.deps.stopHost(pid))) });
    for (const key of this.cookieRefs.keys()) this.dropInstanceSession(key);
    await this.refresh();
    return this.state();
  }

  async test(browserId) {
    await this.refreshHealth();
    const h = this.health.results.find((r) => r.browser === browserId);
    if (!h || !h.detected) return { ok: false, kind: 'browserUnavailable' };
    if (!this.isSetUp(browserId)) return { ok: false, kind: 'notSetUp', problems: h.problems };
    const controller = new AbortController();
    try {
      const inst = await connectInstance({ hub: this.hub, browser: this.browserEntry(browserId), getInstance: this.getInstanceFn(browserId), settings: this.deadlines(), deps: this.deps, signal: controller.signal });
      if (this.identity?.version && inst.extVersion !== this.identity.version) throw new BrowserError('hostSetupError');
      const started = Date.now();
      await this.hub.request(inst.key, 'ping', {}, { timeoutMs: 4000 });
      return { ok: true, latencyMs: Date.now() - started, instance: { key: inst.key, label: this.instanceLabel(inst) } };
    } catch (e) {
      const kind = e instanceof BrowserError ? e.kind : 'extensionNotConnected';
      return { ok: false, kind, ...(e.options ? { options: e.options.map((i) => ({ key: i.key, label: this.instanceLabel(i) })) } : {}) };
    } finally { await this.refreshHealth(); this.changed(); }
  }

  // ---------------------------------------------------------------- analysis (discovery + validation)
  fail(kind, browser, extra = {}) { return { ok: false, kind, error: kind, browser: { id: browser.id, name: browser.name }, ...extra }; }

  mapError(error, browser) {
    if (!(error instanceof BrowserError)) return this.fail('extensionError', browser, { error: String(error && error.message || error).slice(0, 200) });
    const kindMap = { noVideo: 'noVideoBrowser', protectedMedia: 'protected', choiceRequired: 'browserChoice' };
    const extra = error.options ? { options: error.options.map((i) => ({ key: i.key, label: this.instanceLabel(i) })) } : {};
    if (protocol.JOB_STAGES.includes(error.jobStage)) extra.jobStage = error.jobStage;
    return this.fail(kindMap[error.kind] || error.kind, browser, extra);
  }

  releaseSession(reference) {
    this.session.forgetCookies?.(reference);
    for (const refs of this.cookieRefs.values()) refs.delete(reference);
  }

  dropInstanceSession(key) {
    for (const reference of this.cookieRefs.get(key) || []) this.session.forgetCookies?.(reference);
    this.cookieRefs.delete(key);
  }

  async cookiesFor(instance, scopeKey, candidate, signal) {
    const urls = media.scopeUrls(candidate);
    let reply;
    try { reply = await this.hub.request(instance.key, 'cookies-request', { jobId: scopeKey, urls }, { timeoutMs: 8000, signal }); }
    catch { throw new BrowserError(signal?.aborted ? 'cancelled' : 'browserDisconnected'); }
    if (signal?.aborted) throw new BrowserError('cancelled');
    if (reply.type !== 'cookies' || reply.jobId !== scopeKey || reply.available === false) throw new BrowserError('sessionExpired');
    return this.rememberSession(instance, urls, reply.cookies || []);
  }

  rememberSession(instance, urls, snapshot) {
    const cookies = filterScopedCookies(urls, snapshot)
      .map((c) => ({ name: c.name, value: c.value, domain: c.domain, hostOnly: c.hostOnly === true || (c.hostOnly === undefined && !c.domain.startsWith('.')), path: c.path || '/', secure: !!c.secure, httpOnly: !!c.httpOnly, session: !!c.session, expires: c.session ? -1 : c.expirationDate || 0 }));
    // A successful empty snapshot is different from a failed cookie request. Its handle
    // still binds this job to the chosen browser, so disconnect/restart requires rediscovery.
    const reference = this.session.rememberCookies(cookies, { source: 'extension:' + instance.key });
    if (!this.cookieRefs.has(instance.key)) this.cookieRefs.set(instance.key, new Set());
    this.cookieRefs.get(instance.key).add(reference);
    return reference;
  }

  async pageSession(instance, url, signal) {
    const jobId = protocol.newId('session');
    // Short links and privacy embeds resolve through youtube.com. Read that first-party
    // session before the extractor follows the redirect, not the short-link host's empty jar.
    const cookieUrl = /(^|\.)(youtu\.be|youtube-nocookie\.com)$/i.test(new URL(url).hostname) ? 'https://www.youtube.com/' : url;
    let reply;
    try { reply = await this.hub.request(instance.key, 'page-session-request', { jobId, url: cookieUrl }, { timeoutMs: 8000, signal }); }
    catch { throw new BrowserError(signal?.aborted ? 'cancelled' : 'browserDisconnected'); }
    if (signal?.aborted) throw new BrowserError('cancelled');
    if (reply.type !== 'cookies' || reply.jobId !== jobId || reply.available !== true) throw new BrowserError('sessionExpired');
    return { cookieRef: this.rememberSession(instance, [cookieUrl], reply.cookies || []),
      requestContext: { ...(reply.userAgent ? { userAgent: reply.userAgent } : {}), referer: cookieUrl } };
  }

  describeChoice(c) {
    try {
      const u = new URL(c.url);
      return `${{ hls: 'HLS', dash: 'DASH', file: 'קובץ', opaque: 'וידאו' }[c.kind] || ''} · ${u.hostname}`;
    } catch { return c.kind; }
  }

  restoreJob(ref, instanceKey, url) {
    if (!ref || !instanceKey || this.incoming.has(ref)) return;
    // Status routing only: neither a stale candidate nor an old cookie scope is restored.
    this.incoming.set(ref, { instanceKey, url, candidate: null, scopeKey: null, sendKey: null, terminal: '' });
  }

  /**
   * Browser-assisted lookup for one queue item. Returns an engine.analyze-like result.
   * opts: { itemId, browser (explicit id), instance (explicit key), ref (Send to GRAB), choice {token,index}, onPhase }
   */
  async analyze(url, opts = {}) {
    const itemId = opts.itemId != null ? opts.itemId : protocol.newId('item');
    const hint = opts.ref ? this.incoming.get(opts.ref) : null;
    const explicitBrowser = opts.browser || (hint && hint.instanceKey.split(':')[0]);
    const explicitInstance = opts.instance || (hint && hint.instanceKey);
    const sel = this.resolve(url, { browser: explicitBrowser });
    const browser = this.browserEntry(sel.browserId || 'edge');
    if (!sel.browserId || !sel.available) return this.fail('browserUnavailable', browser);
    if (!this.isSetUp(browser.id)) return this.fail('hostSetupError', browser);

    const previous = this.active.get(itemId);
    if (previous) previous.abort.abort();
    const abort = new AbortController();
    const onAbort = () => abort.abort();
    if (opts.signal?.aborted) abort.abort();
    else opts.signal?.addEventListener('abort', onAbort, { once: true });
    const entry = { abort, jobId: null, instance: null };
    this.active.set(itemId, entry);
    const cfg = this.deadlines();
    const phase = (name, extra = {}) => {
      this.notify('browser:phase', { id: itemId, phase: name, browser: { id: browser.id, name: browser.name }, ...(extra.instance ? { instance: this.instanceLabel(extra.instance) } : {}) });
      if (opts.ref && hint && name !== 'connecting') this.reportJob(opts.ref, { phase: name === 'discovering' || name === 'playback_required' ? 'discovering' : 'resolving' });
    };

    try {
      // YouTube's blob/segmented player need not expose a standalone media URL. Preserve the
      // selected profile, acquire its page cookies first, and let yt-dlp's YouTube extractor
      // resolve the original page. Never fall back to an anonymous extractor or a player scan.
      if (siteKey(url) === 'youtube' && !opts.choice) {
        phase('connecting');
        const instance = await connectInstance({ hub: this.hub, browser, getInstance: this.getInstanceFn(browser.id, explicitInstance), settings: cfg, deps: this.deps, signal: abort.signal });
        if (this.identity?.version && instance.extVersion !== this.identity.version) throw new BrowserError('hostSetupError');
        entry.instance = instance;
        phase('validating', { instance });
        const context = await this.pageSession(instance, url, abort.signal);
        let result;
        try {
          result = await this.session.withSessionCookies(context.cookieRef, (cookieFile) => this.engine.analyze(url, {
            cookieFile, requestContext: context.requestContext, signal: abort.signal, timeoutMs: cfg.probeMs,
          }));
          if (abort.signal.aborted) throw new BrowserError('cancelled');
        } catch (error) { this.releaseSession(context.cookieRef); throw error; }
        if (!result.ok) {
          this.releaseSession(context.cookieRef);
          return { ...result, ok: false, kind: result.httpStatus === 429 ? 'rateLimited' : result.kind || 'engineFailure', browser: { id: browser.id, name: browser.name } };
        }
        return { ...result, ...context, needsSession: true, sessionSource: 'browser', browser: { id: browser.id, name: browser.name }, instanceKey: instance.key };
      }
      let pendingChoice = opts.choice && this.choices.get(opts.choice.token);
      if (opts.choice) {
        // A video choice belongs to one page, queue item and browser session, and is single-use.
        if (!pendingChoice || pendingChoice.itemId !== itemId || pendingChoice.url !== url ||
          pendingChoice.instance.browser !== browser.id || (explicitInstance && pendingChoice.instance.key !== explicitInstance) ||
          Date.now() - pendingChoice.at > 10 * 60 * 1000 || !Number.isInteger(opts.choice.index) ||
          !pendingChoice.candidates[opts.choice.index]) return this.fail('videoChoiceExpired', browser);
        this.choices.delete(opts.choice.token);
      }
      let lastFailure = null;
      for (let round = 0; round < 2; round++) {
        let candidates;
        let discovery = null;
        let scopeKey;
        let instance;
        let title = '';
        if (pendingChoice) {
          ({ candidates, instance, scopeKey, title } = pendingChoice);
          if (!this.hub.instances().some((i) => i.key === instance.key)) throw new BrowserError('browserDisconnected');
          candidates = [candidates[opts.choice.index]].filter(Boolean);
          pendingChoice = null;
        } else if (round === 0 && hint && hint.candidate) {
          instance = await connectInstance({ hub: this.hub, browser, getInstance: this.getInstanceFn(browser.id, explicitInstance), settings: cfg, deps: this.deps, signal: abort.signal });
          candidates = [hint.candidate];
          scopeKey = hint.scopeKey;
          title = hint.title || '';
        } else {
          entry.jobId = protocol.newId('job');
          discovery = await discover({
            hub: this.hub, browser, url, getInstance: this.getInstanceFn(browser.id, explicitInstance), settings: cfg, deps: this.deps,
            signal: abort.signal, jobId: entry.jobId, refresh: round > 0 || !!opts.refresh,
            onPhase: (name, extra) => { if (extra?.instance) entry.instance = extra.instance; phase(name, extra || {}); },
          });
          entry.instance = discovery.instance;
          entry.jobId = discovery.jobId;
          instance = discovery.instance;
          scopeKey = discovery.jobId;
          title = discovery.title;
          const ranked = media.rank(discovery.candidates);
          if (!ranked.plausible.length) {
            return this.fail('noVideoBrowser', browser);
          }
          if (ranked.ambiguous && !opts.choice) {
            const token = protocol.newId('choice');
            const plausible = ranked.plausible.slice(0, 4);
            this.choices.set(token, { candidates: plausible, instance, scopeKey, title, url, itemId, at: Date.now() });
            for (const [k, v] of this.choices) if (Date.now() - v.at > 10 * 60 * 1000) this.choices.delete(k);
            return { ok: false, kind: 'videoChoice', error: 'multiple videos', token, browser: { id: browser.id, name: browser.name }, choices: plausible.map((c, index) => ({ index, label: this.describeChoice(c) })) };
          }
          candidates = ranked.plausible.slice(0, 3);
        }
        if (this.identity?.version && instance.extVersion !== this.identity.version) throw new BrowserError('hostSetupError');
        phase('validating', { instance });
        lastFailure = null;
        for (const c of candidates) {
          if (abort.signal.aborted) throw new BrowserError('cancelled');
          const expiry = this.engine.mediaExpiry ? this.engine.mediaExpiry(c.url) : null;
          if (expiry && expiry < Date.now() + 5000) { lastFailure = { kind: 'forbidden', httpStatus: 410 }; continue; }
          const cookieRef = await this.cookiesFor(instance, scopeKey, c, abort.signal);
          let r;
          try {
            r = await this.session.withSessionCookies(cookieRef, (cookieFile) => this.engine.analyze(c.url, {
              cookieFile, requestContext: c.context, referer: url, title: title || undefined, signal: abort.signal, timeoutMs: cfg.probeMs,
            }));
            if (abort.signal.aborted) throw new BrowserError('cancelled');
          } catch (error) { this.releaseSession(cookieRef); throw error; }
          // Rate limiting is not a session-expiry signal. Stop immediately, preserving queue backoff.
          if (['blocked', 'rateLimited'].includes(r.kind) || r.httpStatus === 429) {
            this.releaseSession(cookieRef);
            return { ...r, ok: false, kind: r.kind === 'blocked' && r.httpStatus !== 429 ? 'blocked' : 'rateLimited', browser: { id: browser.id, name: browser.name } };
          }
          if (r.ok) {
            return { ...r, mediaUrl: c.url, referer: c.context?.referer ?? url, requestContext: c.context, cookieRef, needsSession: true, sessionSource: 'browser', browser: { id: browser.id, name: browser.name }, instanceKey: instance.key };
          }
          this.releaseSession(cookieRef);
          lastFailure = r;
        }
        // An expired or refused signed URL gets ONE fresh discovery in the same session; never a loop.
        const stale = lastFailure && (['forbidden', 'private'].includes(lastFailure.kind) || [401, 403, 410].includes(lastFailure.httpStatus));
        if (!stale || round === 1) break;
        phase('discovering', { instance });
        opts = { ...opts, choice: undefined };
      }
      if (lastFailure && (['forbidden', 'private'].includes(lastFailure.kind) || [401, 403, 410].includes(lastFailure.httpStatus))) return this.fail('sessionExpired', browser);
      if (lastFailure && lastFailure.kind === 'cancelled') return this.fail('cancelled', browser);
      return { ...(lastFailure || {}), ok: false, kind: lastFailure && lastFailure.kind === 'probeTimeout' ? 'probeTimeout' : 'engineFailure', error: (lastFailure && lastFailure.error) || 'engine', browser: { id: browser.id, name: browser.name } };
    } catch (error) {
      return this.mapError(error, browser);
    } finally {
      opts.signal?.removeEventListener('abort', onAbort);
      if (this.active.get(itemId) === entry) this.active.delete(itemId);
    }
  }

  cancel(itemId) {
    const entry = this.active.get(itemId);
    if (!entry) return false;
    entry.abort.abort();
    return true;
  }

  revealPlayback(itemId) {
    const entry = this.active.get(itemId);
    if (!entry || !entry.instance || !entry.jobId) return false;
    return revealTab(this.hub, entry.instance, entry.jobId);
  }

  // ---------------------------------------------------------------- Send to GRAB
  async onSend(instance, m) {
    const page = m.url.split('#')[0];
    const sendKey = JSON.stringify([instance.key, page, m.candidate?.url || '']);
    let recent = this.recentSends.get(sendKey);
    const reply = (status, extra = {}) => this.hub.sendTo(instance.key, 'ack', { status, ...extra }, m.id);
    if (recent?.pending) { await recent.pending; recent = this.recentSends.get(sendKey); }
    if (recent && (!recent.terminal || Date.now() - recent.at < 120000)) { reply('duplicate', { ref: recent.ref }); return; }
    const ref = protocol.newId('ref');
    let release;
    const reservation = { ref, at: Date.now(), terminal: '', pending: new Promise((resolve) => { release = resolve; }) };
    // Reserve before queue intake: the coordinator may start analysis before its acknowledgment,
    // and a double-click must not create two jobs while the first acknowledgment is pending.
    this.recentSends.set(sendKey, reservation);
    this.incoming.set(ref, { instanceKey: instance.key, scopeKey: m.id, candidate: m.candidate || null, title: m.title || '', url: m.url, sendKey, terminal: '' });
    try {
      const sourceId = crypto.createHash('sha256').update(sendKey).digest('hex');
      const answer = await this.acceptIncoming({ ref, sourceId, url: m.url, title: m.title || '', browserId: instance.browser, instanceKey: instance.key, hasCandidate: !!m.candidate });
      const status = typeof answer === 'string' ? answer : answer?.status;
      if (status !== 'accepted') {
        this.incoming.delete(ref);
        this.recentSends.delete(sendKey);
        if (status === 'duplicate') reply('duplicate', answer?.ref ? { ref: answer.ref } : {});
        else reply('rejected', { reason: status === 'unavailable' ? 'app_not_ready' : 'refused' });
        return;
      }
      reply('accepted', { ref });
    } catch {
      this.incoming.delete(ref);
      this.recentSends.delete(sendKey);
      reply('rejected', { reason: 'app_not_ready' });
    } finally {
      reservation.pending = null;
      release();
    }
    for (const [k, v] of this.recentSends) if (v.terminal && Date.now() - v.at > 30 * 60 * 1000) {
      this.recentSends.delete(k);
      this.incoming.delete(v.ref);
    }
  }

  // Phase and terminal result of a Send-to-GRAB job, reported back to the browser that sent it.
  reportJob(ref, { phase = 'queued', terminal, reason } = {}) {
    const rec = this.incoming.get(ref);
    if (!rec || !this.hub) return false;
    if (rec.terminal) return false;
    if (terminal) {
      rec.terminal = terminal;
      const recent = this.recentSends.get(rec.sendKey);
      if (recent) recent.terminal = terminal;
    }
    return this.hub.sendTo(rec.instanceKey, 'job-status', { ref, phase: String(phase).slice(0, 40), ...(terminal ? { terminal } : {}), ...(reason ? { reason: String(reason).slice(0, 120) } : {}) });
  }
}

module.exports = { BrowserService, DEADLINE_DEFAULTS, DEADLINE_LIMITS };

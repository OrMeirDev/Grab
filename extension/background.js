// Grab extension service worker.
//
// Direction of everything: this worker opens the Native Messaging connection (the browser then
// starts the Grab native host, which dials the running desktop app). The app sends work back
// down that same connection. Browser startup alone never opens the Grab window.
//
// Privacy: webRequest is used observationally. Only requests that look like media are kept, in
// session storage (cleared when the browser closes), per tab, at most MAX_ITEMS for OBS_TTL_MS,
// and dropped on the next navigation of the tab. No general browsing history is recorded.
importScripts('lib/protocol.js', 'lib/media.js', 'lib/collector.js');

const P = self.GrabProtocol;
const M = self.GrabMedia;
const C = self.GrabCollector;

const EXT_VERSION = chrome.runtime.getManifest().version;
const OBS_TTL_MS = 10 * 60 * 1000;
const MAX_ITEMS = 20;
const MAX_REQUESTS = 400;
const SCOPE_TTL_MS = 15 * 60 * 1000;
const SCAN_INTERVAL_MS = 750;
const DEADLINE_MARGIN_MS = 1500;
const NO_VIDEO_AFTER_MS = 15000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------- identity
let identityPromise = null;
function identity() {
  if (!identityPromise) {
    identityPromise = chrome.storage.local.get(['instanceId', 'alias']).then(async (s) => {
      let { instanceId, alias } = s;
      if (!instanceId) {
        instanceId = 'i' + crypto.randomUUID().replace(/-/g, '');
        await chrome.storage.local.set({ instanceId });
      }
      return { instanceId, alias: alias || '' };
    });
  }
  return identityPromise;
}

// ---------------------------------------------------------------- native connection
let port = null;
let keepalive = null;
let reconnectTimer = null;
let backoff = 1000;
const conn = { state: 'idle', error: '', errorKind: '', appOnline: false, welcomed: false, since: Date.now() };
const jobs = new Map();
const pendingAck = new Map();

function setConn(patch) { Object.assign(conn, patch, { since: Date.now() }); }

function classifyDisconnect(text) {
  if (/not found|not registered/i.test(text)) return 'host_missing';
  if (/forbidden/i.test(text)) return 'origin_forbidden';
  if (/exited/i.test(text)) return 'host_exited';
  if (/start/i.test(text)) return 'host_start_failed';
  return text ? 'host_error' : 'closed';
}

async function connect() {
  if (port) return;
  const me = await identity();
  if (port) return;
  let mine;
  try { mine = chrome.runtime.connectNative(P.HOST_NAME); } catch (e) {
    setConn({ state: 'disconnected', error: String(e.message || e), errorKind: 'host_error' });
    scheduleReconnect();
    return;
  }
  port = mine;
  setConn({ state: 'connecting', error: '', errorKind: '', welcomed: false, appOnline: false });
  mine.onMessage.addListener((m) => { if (port === mine) onNative(m); });
  mine.onDisconnect.addListener(() => {
    const text = (chrome.runtime.lastError && chrome.runtime.lastError.message) || '';
    if (port !== mine) return; // a replaced connection must not tear down the new one
    port = null;
    clearInterval(keepalive);
    keepalive = null;
    setConn({ state: 'disconnected', error: text, errorKind: classifyDisconnect(text), welcomed: false, appOnline: false });
    abortAllJobs('disconnected');
    for (const [, resolve] of pendingAck) resolve({ status: 'offline' });
    pendingAck.clear();
    scheduleReconnect();
  });
  keepalive = setInterval(() => { if (port === mine) mine.postMessage(P.make('ping')); }, 20000);
  void me;
}

function scheduleReconnect() {
  if (reconnectTimer) return;
  // A missing registration will not fix itself quickly: poll gently, but keep polling so a repair is picked up.
  const slow = conn.errorKind === 'host_missing' || conn.errorKind === 'origin_forbidden';
  const delay = slow ? 30000 : backoff;
  backoff = Math.min(backoff * 2, 60000);
  reconnectTimer = setTimeout(() => { reconnectTimer = null; connect(); }, delay);
}

async function sendHello() {
  if (!port) return;
  const me = await identity();
  port.postMessage(P.make('hello', {
    instanceId: me.instanceId,
    ...(me.alias ? { alias: me.alias } : {}),
    extVersion: EXT_VERSION,
    protocol: P.PROTOCOL_VERSION,
    userAgent: navigator.userAgent.slice(0, 500),
  }));
}

function post(message) {
  if (!port || !conn.welcomed) return false;
  const check = P.validate(message, 'ext');
  if (!check.ok) { console.warn('[grab] refusing to send', check.error); return false; }
  try { port.postMessage(message); return true; } catch (e) { return false; }
}

function onNative(m) {
  const check = P.validate(m, 'app');
  if (!check.ok) return;
  switch (m.type) {
    case 'app-status':
      conn.appOnline = m.online;
      if (m.online) { conn.state = 'connecting'; sendHello(); } else { conn.state = 'app_offline'; conn.welcomed = false; abortAllJobs('app_offline'); }
      conn.since = Date.now();
      break;
    case 'welcome':
      backoff = 1000;
      setConn({ state: 'connected', welcomed: true, error: '', errorKind: '' });
      break;
    case 'error':
      if (m.code === 'protocol_version') setConn({ state: 'incompatible', errorKind: 'protocol_version', error: m.message || '' });
      else if (m.code === 'host_rejected') setConn({ state: 'rejected', errorKind: 'origin_forbidden', error: m.message || '' });
      break;
    case 'discover': startJob(m); break;
    case 'cancel': cancelJob(m.jobId, 'cancelled'); break;
    case 'reveal-tab': revealJobTab(m.jobId); break;
    case 'cookies-request': answerCookies(m); break;
    case 'ack': { const r = pendingAck.get(m.replyTo); if (r) { pendingAck.delete(m.replyTo); r({ status: m.status, ref: m.ref, reason: m.reason }); } break; }
    case 'job-status': recordSendStatus(m); break;
    default: break;
  }
}

// ---------------------------------------------------------------- per-tab observations
const tabLocks = new Map();
function withTab(tabId, fn) {
  const run = (tabLocks.get(tabId) || Promise.resolve()).catch(() => {}).then(() => fn());
  tabLocks.set(tabId, run);
  run.finally(() => { if (tabLocks.get(tabId) === run) tabLocks.delete(tabId); });
  return run;
}
const tabKey = (tabId) => 't:' + tabId;
async function loadTab(tabId) {
  const got = await chrome.storage.session.get(tabKey(tabId));
  return got[tabKey(tabId)] || null;
}
const saveTab = (tabId, rec) => chrome.storage.session.set({ [tabKey(tabId)]: rec });

async function currentTab(tabId) {
  let rec = await loadTab(tabId);
  if (!rec) {
    let url = '';
    try { url = (await chrome.tabs.get(tabId)).url || ''; } catch (e) { return null; }
    rec = { nav: 1, url, items: [], hosts: [] };
  }
  return rec;
}

function observe(tabId, obs) {
  return withTab(tabId, async () => {
    const rec = await currentTab(tabId);
    if (!rec) return;
    const now = Date.now();
    rec.items = rec.items.filter((o) => now - o.at < OBS_TTL_MS);
    const existing = rec.items.findIndex((o) => o.url === obs.url);
    if (existing >= 0) rec.items[existing] = { ...rec.items[existing], ...obs, size: Math.max(rec.items[existing].size || 0, obs.size || 0), firstAt: rec.items[existing].firstAt || rec.items[existing].at };
    else rec.items.push({ ...obs, firstAt: obs.at });
    if (rec.items.length > MAX_ITEMS) rec.items = rec.items.slice(-MAX_ITEMS);
    await saveTab(tabId, rec);
  });
}

function noteHost(tabId, host) {
  return withTab(tabId, async () => {
    const rec = await currentTab(tabId);
    if (!rec || rec.hosts.includes(host)) return;
    rec.hosts = [...rec.hosts, host].slice(-20);
    await saveTab(tabId, rec);
  });
}

chrome.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId !== 0) return;
  for (const [id, req] of requests) if (req.tabId === d.tabId) requests.delete(id);
  // A new document in this tab: observations of the previous page must not leak into it.
  withTab(d.tabId, async () => {
    const prev = await loadTab(d.tabId);
    await saveTab(d.tabId, { nav: ((prev && prev.nav) || 0) + 1, url: d.url, items: [], hosts: [] });
  });
});
chrome.tabs.onRemoved.addListener((tabId) => {
  for (const [id, req] of requests) if (req.tabId === tabId) requests.delete(id);
  withTab(tabId, () => chrome.storage.session.remove(tabKey(tabId)));
  for (const job of jobs.values()) if (job.tabId === tabId && job.owned) { job.owned = false; job.tabGone = true; }
});

// requestId -> in-flight request info. Memory only, tiny, discarded as soon as the request ends.
const requests = new Map();
const FILTER = { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest', 'media', 'other', 'object'] };
const SEGMENT_PATH = /\.(ts|m4s|cmfv|cmfa)$/i;

// One entry per request id. A redirect keeps the id but changes the URL (onBeforeRedirect, then the
// later events carry the new URL), so every event re-syncs the URL and records the hop it left behind.
function track(d, create = false) {
  if (d.tabId < 0) return null;
  let r = requests.get(d.requestId);
  if (!r) {
    if (!create) return null; // old document/request, or one whose start we did not observe
    if (requests.size >= MAX_REQUESTS) requests.delete(requests.keys().next().value);
    r = { tabId: d.tabId, frameId: d.frameId, url: d.url, redirects: [], context: null };
    requests.set(d.requestId, r);
  } else if (r.url !== d.url) {
    r.redirects.push(r.url);
    r.url = d.url;
  }
  return r;
}

chrome.webRequest.onBeforeRedirect.addListener((d) => {
  const r = requests.get(d.requestId);
  if (!r || !d.redirectUrl) return;
  if (r.url !== d.redirectUrl) { r.redirects.push(r.url); r.url = d.redirectUrl; }
}, { urls: ['http://*/*', 'https://*/*'], types: ['xmlhttprequest', 'media', 'other', 'object'] });

chrome.webRequest.onBeforeRequest.addListener((d) => {
  const r = track(d, true);
  if (!r) return;
  try {
    const u = new URL(d.url);
    if (SEGMENT_PATH.test(u.pathname)) noteHost(d.tabId, u.hostname);
  } catch (e) { /* ignore */ }
}, FILTER);

chrome.webRequest.onSendHeaders.addListener((d) => {
  const r = track(d);
  if (!r) return;
  // Only the non-secret playback headers are kept. Cookie and Authorization are never read here.
  const ctx = { userAgent: '', referer: '', origin: '' };
  for (const h of d.requestHeaders || []) {
    const n = h.name.toLowerCase();
    if (n === 'user-agent') ctx.userAgent = h.value || '';
    else if (n === 'referer') ctx.referer = h.value || '';
    else if (n === 'origin') ctx.origin = h.value || '';
  }
  if (!ctx.userAgent) ctx.userAgent = navigator.userAgent;
  r.context = ctx;
}, FILTER, ['requestHeaders', 'extraHeaders']);

chrome.webRequest.onHeadersReceived.addListener((d) => {
  const r = track(d);
  if (!r) return;
  const header = (name) => ((d.responseHeaders || []).find((h) => h.name.toLowerCase() === name) || {}).value || '';
  const contentRange = header('content-range').match(/\/(\d+)$/);
  const size = contentRange ? Number(contentRange[1]) : Number(header('content-length')) || 0;
  const cls = M.classify({ url: r.url, contentType: header('content-type'), status: d.statusCode, size });
  if (!cls) return;
  void observe(r.tabId, {
    url: r.url, kind: cls.kind, size, at: Date.now(), frameId: r.frameId,
    context: r.context || { userAgent: navigator.userAgent, referer: '', origin: '' },
    redirects: r.redirects.slice(-10),
  });
}, FILTER, ['responseHeaders']);

const forget = (d) => { requests.delete(d.requestId); };
chrome.webRequest.onCompleted.addListener(forget, FILTER);
chrome.webRequest.onErrorOccurred.addListener(forget, FILTER);

// ---------------------------------------------------------------- scanning a tab
async function freshObservations(tabId) {
  const rec = await loadTab(tabId);
  if (!rec) return { items: [], hosts: [] };
  const now = Date.now();
  return { items: rec.items.filter((o) => now - o.at < OBS_TTL_MS), hosts: rec.hosts || [] };
}

async function scanDom(tabId, startPlayback) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: C.collectInPage, args: [{ startPlayback }] });
  } catch (e) { return { media: [], players: 0, playing: 0, playRejected: 0, blob: 0, drm: false, title: '', embeds: [], failed: true }; }
  const out = { media: [], players: 0, playing: 0, playRejected: 0, blob: 0, drm: false, title: '', embeds: [], failed: false };
  for (const r of results) {
    const v = r && r.result;
    if (!v) continue;
    if (v.pageUrl && M.isNotPlayer(v.pageUrl)) continue;
    out.players += v.players; out.playing += v.playing; out.playRejected += v.playRejected; out.blob += v.blobPlayers;
    out.drm = out.drm || v.drm;
    if (r.frameId === 0 && v.title) out.title = v.title;
    for (const url of v.media) out.media.push({ url, frameId: r.frameId, referer: v.pageUrl });
    out.embeds.push(...v.embeds);
  }
  return out;
}

// Candidates for one tab: fresh network observations plus what the page's players expose now.
async function gather(tabId, { play = false } = {}) {
  const { items, hosts } = await freshObservations(tabId);
  const dom = await scanDom(tabId, play);
  const obs = items.map((o) => ({ ...o, hosts }));
  for (const m of dom.media) {
    const cls = M.classify({ url: m.url });
    if (!cls) continue;
    // The same address seen on the network keeps its observed request context; the page only confirms it is a player source.
    const seen = obs.find((o) => o.url === m.url || (o.redirects || []).includes(m.url));
    if (seen) { seen.fromPlayer = true; continue; }
    obs.push({ url: m.url, kind: cls.kind, size: 0, at: Date.now(), frameId: m.frameId, fromPlayer: true, context: { userAgent: navigator.userAgent, referer: m.referer || '', origin: '' }, redirects: [], hosts });
  }
  const ranked = M.rank(obs);
  return { ranked, dom, hosts };
}

const toWire = (c) => ({
  url: c.url, kind: c.kind, size: c.size || 0, at: c.at || 0, firstAt: c.firstAt || c.at || 0, fromPlayer: !!c.fromPlayer, frameId: c.frameId || 0,
  ...(c.context ? { context: { userAgent: c.context.userAgent || '', referer: c.context.referer || '', origin: c.context.origin || '' } } : {}),
  redirects: (c.redirects || []).slice(0, 10), hosts: (c.hosts || []).slice(0, 20),
});
const wireList = (ranked) => ranked.ranked.slice(0, 20).map(toWire);

// ---------------------------------------------------------------- cookie scopes
const scopes = new Map();
function registerScope(key, urls) {
  const origins = new Set();
  for (const u of urls) { try { origins.add(new URL(u).origin); } catch (e) { /* skip */ } }
  const now = Date.now();
  for (const [k, v] of scopes) if (now - v.at > SCOPE_TTL_MS) scopes.delete(k);
  scopes.set(key, { origins, at: now });
}

// Cookies are handed over only for URLs inside the scope the job itself established (the media
// URL, its observed redirects and the player's media hosts), and only the cookies the browser
// would send to that URL.
async function answerCookies(m) {
  const scope = scopes.get(m.jobId);
  const cookies = [];
  const seen = new Set();
  if (scope) {
    for (const url of m.urls) {
      let origin = '';
      try { origin = new URL(url).origin; } catch (e) { continue; }
      if (!scope.origins.has(origin)) continue;
      let list = [];
      try { list = await chrome.cookies.getAll({ url }); } catch (e) { list = []; }
      for (const c of list) {
        const key = `${c.domain}|${c.path}|${c.name}`;
        if (seen.has(key)) continue;
        seen.add(key);
        cookies.push({ name: c.name, value: c.value, domain: c.domain, path: c.path, secure: !!c.secure, httpOnly: !!c.httpOnly, hostOnly: !!c.hostOnly, session: !!c.session, expirationDate: c.expirationDate || 0 });
      }
    }
  }
  if (!post(P.make('cookies', { jobId: m.jobId, cookies: cookies.slice(0, 400) }, m.id))) console.warn('[grab] cookies reply not sent');
}

// ---------------------------------------------------------------- discovery jobs
const ownedKey = 'owned';
async function rememberOwned(tabId, add) {
  const got = await chrome.storage.session.get(ownedKey);
  const set = new Set(got[ownedKey] || []);
  if (add) set.add(tabId); else set.delete(tabId);
  await chrome.storage.session.set({ [ownedKey]: [...set] });
}

function abortAllJobs(reason) { for (const id of [...jobs.keys()]) cancelJob(id, reason, false); }

function cancelJob(jobId, reason, notify = true) {
  const job = jobs.get(jobId);
  if (!job) return;
  job.aborted = reason;
  finishJob(job);
  if (notify && reason !== 'cancelled') post(P.make('job-failed', { jobId, reason: P.REASONS.includes(reason) ? reason : 'extension_error' }));
}

function finishJob(job) {
  clearTimeout(job.timer);
  jobs.delete(job.id);
  if (job.owned && job.tabId != null) {
    const tabId = job.tabId;
    job.owned = false;
    // Only the temporary tab this job opened is ever closed; existing tabs are left alone.
    chrome.tabs.remove(tabId).catch(() => {}).finally(() => rememberOwned(tabId, false));
  }
}

async function revealJobTab(jobId) {
  const job = jobs.get(jobId);
  if (!job || job.tabId == null) return;
  try {
    const tab = await chrome.tabs.update(job.tabId, { active: true });
    if (tab && tab.windowId != null) await chrome.windows.update(tab.windowId, { focused: true });
  } catch (e) { /* tab gone */ }
}

async function findExistingTab(url) {
  const tabs = await chrome.tabs.query({});
  const matches = tabs.filter((t) => t.url && M.sameNavigationUrl(t.url, url));
  matches.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0));
  return matches[0] || null;
}

async function waitTabComplete(tabId, until) {
  while (Date.now() < until) {
    let tab;
    try { tab = await chrome.tabs.get(tabId); } catch (e) { return false; }
    if (tab.status === 'complete') return true;
    await sleep(250);
  }
  return false;
}

function startJob(m) {
  if (jobs.has(m.jobId)) return;
  const job = { id: m.jobId, url: m.url, refresh: !!m.refresh, tabId: null, owned: false, aborted: null, deadlineAt: Date.now() + m.deadlineMs - DEADLINE_MARGIN_MS, state: 'locating', timer: null };
  jobs.set(job.id, job);
  job.timer = setTimeout(() => {
    if (jobs.get(job.id) !== job) return;
    job.aborted = 'timeout';
    const reason = job.state === 'playback_required' ? 'playback_required' : 'timeout';
    finishJob(job);
    post(P.make('job-failed', { jobId: job.id, reason }));
  }, Math.max(1000, m.deadlineMs - DEADLINE_MARGIN_MS));
  runJob(job).catch((e) => {
    if (jobs.get(job.id) !== job) return;
    finishJob(job);
    post(P.make('job-failed', { jobId: job.id, reason: 'extension_error', message: String(e && e.message || e).slice(0, 200) }));
  });
}

const progress = (job, state) => { job.state = state; if (!job.aborted) post(P.make('progress', { jobId: job.id, state })); };
const alive = (job) => jobs.get(job.id) === job && !job.aborted;

function deliver(job, ranked, dom) {
  if (!alive(job)) return;
  const wire = wireList(ranked);
  const urls = [job.url, ...wire.flatMap((c) => [c.url, ...(c.redirects || []), ...(c.hosts || []).map((h) => 'https://' + h + '/')])];
  registerScope(job.id, urls);
  if (!wire.length && dom && dom.drm) { finishJob(job); post(P.make('job-failed', { jobId: job.id, reason: 'protected' })); return; }
  const sent = post(P.make('candidates', { jobId: job.id, candidates: wire, final: true, ...(dom && dom.title ? { title: dom.title.slice(0, 300) } : {}) }));
  finishJob(job);
  if (!sent) console.warn('[grab] candidates not delivered');
}

async function runJob(job) {
  progress(job, 'locating');
  // 1) An existing tab of this exact page: fresh, attributable observations and the page's own players.
  const existing = job.refresh ? null : await findExistingTab(job.url);
  if (!alive(job)) return;
  if (existing) {
    const g = await gather(existing.id, { play: false });
    if (!alive(job)) return;
    if (g.ranked.plausible.length) { deliver(job, g.ranked, g.dom); return; }
  }
  // 2) Re-probe in a temporary background tab owned by this job. The user's own tab is never reloaded.
  progress(job, 'opening');
  const tab = await chrome.tabs.create({ url: job.url, active: false });
  job.tabId = tab.id;
  job.owned = true;
  await rememberOwned(tab.id, true);
  if (!alive(job)) { finishJob(job); return; }
  progress(job, 'discovering');
  await waitTabComplete(tab.id, job.deadlineAt);
  const started = Date.now();
  let lastCount = -1;
  let lastChange = Date.now();
  let prompted = false;
  while (alive(job) && Date.now() < job.deadlineAt) {
    const g = await gather(tab.id, { play: true });
    if (!alive(job)) return;
    const count = g.ranked.ranked.length;
    if (count !== lastCount) { lastCount = count; lastChange = Date.now(); }
    if (g.ranked.plausible.length && Date.now() - lastChange > 2000 && Date.now() - started > 2500) { deliver(job, g.ranked, g.dom); return; }
    if (g.dom.drm && !count && Date.now() - started > 6000) { deliver(job, g.ranked, g.dom); return; }
    // A player that cannot start by itself (autoplay policy): ask the user, do not claim autoplay works.
    if (!prompted && !count && g.dom.players > 0 && g.dom.playing === 0 && Date.now() - started > 8000) {
      prompted = true;
      progress(job, 'playback_required');
    }
    if (prompted && count) { prompted = false; job.state = 'discovering'; }
    // A page with no player and no media request is not going to produce one: say so instead of waiting out the deadline.
    if (!count && !prompted && g.dom.players === 0 && !g.dom.blob && Date.now() - started > NO_VIDEO_AFTER_MS) {
      finishJob(job);
      post(P.make('job-failed', { jobId: job.id, reason: 'no_video' }));
      return;
    }
    await sleep(SCAN_INTERVAL_MS);
  }
}

// ---------------------------------------------------------------- "Send to GRAB" and popup
const sends = [];
function recordSendStatus(m) {
  const rec = sends.find((s) => s.ref === m.ref);
  if (!rec) return;
  rec.phase = m.phase;
  rec.terminal = m.terminal || '';
  rec.reason = m.reason || '';
  rec.at = Date.now();
}

async function sendToGrab(tabId, candidateUrl) {
  if (!conn.welcomed) return { status: 'offline', conn: publicConn() };
  const tab = await chrome.tabs.get(tabId);
  if (!tab.url || !P.isHttpUrl(tab.url)) return { status: 'rejected', reason: 'unsupported_page' };
  const g = await gather(tabId, { play: false });
  let chosen = candidateUrl ? g.ranked.ranked.find((c) => c.url === candidateUrl) : null;
  if (!chosen && !candidateUrl && g.ranked.plausible.length === 1) chosen = g.ranked.plausible[0];
  const message = P.make('send-to-grab', {
    url: tab.url,
    title: (g.dom.title || tab.title || '').slice(0, 300),
    ...(chosen ? { candidate: toWire(chosen) } : {}),
  });
  registerScope(message.id, [tab.url, ...(chosen ? M.scopeUrls(chosen) : [])]);
  const reply = new Promise((resolve) => { pendingAck.set(message.id, resolve); setTimeout(() => { if (pendingAck.delete(message.id)) resolve({ status: 'timeout' }); }, 8000); });
  if (!post(message)) { pendingAck.delete(message.id); return { status: 'offline' }; }
  const ack = await reply;
  if (ack.status === 'accepted' || ack.status === 'duplicate') {
    sends.unshift({ id: message.id, ref: ack.ref || '', url: tab.url, phase: 'accepted', terminal: '', reason: '', at: Date.now() });
    sends.length = Math.min(sends.length, 8);
  }
  return ack;
}

function publicConn() {
  return { state: conn.state, error: conn.error, errorKind: conn.errorKind, appOnline: conn.appOnline, welcomed: conn.welcomed, since: conn.since };
}

chrome.runtime.onMessage.addListener((msg, _sender, respond) => {
  (async () => {
    if (!msg || typeof msg.type !== 'string') return { ok: false };
    if (msg.type === 'popup:status') {
      const me = await identity();
      return { ok: true, conn: publicConn(), instanceId: me.instanceId, alias: me.alias, version: EXT_VERSION };
    }
    if (msg.type === 'popup:reconnect') {
      clearTimeout(reconnectTimer); reconnectTimer = null; backoff = 1000;
      clearInterval(keepalive); keepalive = null;
      if (port) { try { port.disconnect(); } catch (e) { /* ignore */ } port = null; }
      await connect();
      return { ok: true };
    }
    if (msg.type === 'popup:alias') {
      const alias = String(msg.alias || '').slice(0, 60);
      await chrome.storage.local.set({ alias });
      identityPromise = null;
      await identity();
      if (port && conn.welcomed) await sendHello();
      return { ok: true };
    }
    if (msg.type === 'popup:scan' && Number.isInteger(msg.tabId)) {
      const tab = await chrome.tabs.get(msg.tabId);
      const g = await gather(msg.tabId, { play: false });
      const sendState = sends.find((s) => s.url === tab.url) || null;
      return { ok: true, url: tab.url || '', title: g.dom.title || tab.title || '', candidates: g.ranked.plausible.slice(0, 6).map(toWire), ambiguous: g.ranked.ambiguous, blob: g.dom.blob > 0, drm: g.dom.drm, send: sendState };
    }
    if (msg.type === 'popup:send' && Number.isInteger(msg.tabId)) {
      return { ok: true, result: await sendToGrab(msg.tabId, typeof msg.candidateUrl === 'string' ? msg.candidateUrl : undefined) };
    }
    return { ok: false };
  })().then(respond, (e) => respond({ ok: false, error: String(e && e.message || e) }));
  return true;
});

// ---------------------------------------------------------------- startup
chrome.runtime.onStartup.addListener(() => { connect(); });
chrome.runtime.onInstalled.addListener(() => { connect(); });
chrome.alarms.create('grab-reconnect', { periodInMinutes: 0.5 });
chrome.alarms.onAlarm.addListener((a) => { if (a.name === 'grab-reconnect' && !port) connect(); });

// Close any temporary tab a previous worker instance opened and could not clean up.
chrome.storage.session.get(ownedKey).then(async (got) => {
  for (const id of got[ownedKey] || []) { if (![...jobs.values()].some((j) => j.tabId === id)) await chrome.tabs.remove(id).catch(() => {}); }
  await chrome.storage.session.set({ [ownedKey]: [...jobs.values()].filter((j) => j.owned).map((j) => j.tabId) });
}).catch(() => {});

connect();

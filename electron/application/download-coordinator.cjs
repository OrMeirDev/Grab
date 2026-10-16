// The one owner of the download queue (GRB-02). The renderer sends commands and shows snapshots;
// every state change, the lookup and download schedules, per-site blocks, the rest between
// YouTube downloads, retries and history records happen here.
//
// Scheduling (unchanged from the version that lived in React):
// - Lookups: one link at a time, with a 2–4 s random gap between consecutive lookups, so sites
//   don't flag Grab as a bot.
// - Downloads: one at a time, in queue order; after each one, YouTube downloads wait 5–10 s.
//   When that rest ends the next download starts by itself (GRB-01).
// - Blocks: when a site says "slow down" (HTTP 429: 'rateLimited') or "confirm you're not a bot"
//   ('blocked'), only that site's jobs wait, until the user resumes it; other sites carry on.
// - A failed download is retried once: a generic page is looked up again inside its player,
//   anything else is fetched again with fresh information.
//
// Everything outside is injected: discover, startDownload, history, settings, store, clock, random.
const { siteKey, sameLinkKey } = require('../domain/site-policy.cjs');
const { toPublic, toDurable, restore, requiresBrowserSession } = require('../domain/job.cjs');

const LOOKUP_GAP_MS = 2000; // plus up to the same again at random
const DOWNLOAD_REST_MS = 5000; // 5–10 seconds between YouTube downloads
const RETRY_LATER_MS = 3000; // the engine was being updated: try again shortly
const SAVE_DELAY_MS = 500;
// Answers that hold the site until "resume <site>".
const HOLDS_SITE = new Set(['blocked', 'rateLimited']);

const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

class DownloadCoordinator {
  // deps:
  //   discover(url, { forcePage, onPhase, signal }) -> lookup result (discovery-service.cjs)
  //   startDownload(plan, onProgress) -> { stop(), done } (download-runner.cjs)
  //   getSettings() -> Promise<{ folder, format, quality }>
  //   recordCompletion(entry) -> Promise (history)
  //   releaseContext(job) -> forget the job's private lookup data (cookies, info file, name)
  //   hasSession(cookieRef) -> whether that cookie snapshot is still usable (not expired, not
  //     dropped by a browser disconnect); checked before any network work for the job
  //   store: { load(), save(list) } for the durable queue (optional)
  //   onChange(snapshot), clock, random, newId
  constructor(deps) {
    this.d = { clock: realClock, random: Math.random, newId: () => globalThis.crypto.randomUUID(), onChange: () => {}, releaseContext: () => {}, reportJob: () => {}, ...deps };
    this.jobs = [];
    this.blocked = new Set();
    this.running = false; // "download until the queue is empty" is on
    this.active = null; // { jobId, attemptId, stop, stopped }
    this.attempts = 0;
    this.restUntil = 0;
    this.restTimer = null;
    this.lookup = null; // { jobId, controller }
    this.lookupTimer = null;
    this.lookupStreak = false;
    this.held = false;
    this.saveTimer = null;
    this.emitQueued = false;
    this.closed = false;
    this.seq = 0; // numbers the snapshots, so the renderer can drop an older one that arrives late
  }

  // ---- lifecycle ------------------------------------------------------------------------------

  async init() {
    const saved = this.d.store ? await this.d.store.load() : [];
    this.jobs = (Array.isArray(saved) ? saved : []).map(restore).filter(Boolean);
    for (const job of this.jobs) job.siteKey = job.siteKey || siteKey(job.url);
    this.changed({ save: false });
    this.pumpLookups();
  }

  // Stops lookups and downloads (closing Grab, installing an update). Running downloads are kept
  // as paused, so they resume where they stopped next time.
  async shutdown() {
    this.closed = true;
    this.held = true;
    this.clearTimers();
    this.lookup?.controller.abort();
    const active = this.active;
    if (active) {
      active.stopped = true;
      const job = this.find(active.jobId);
      if (job) job.status = 'paused';
      active.stop();
    }
    await this.flush();
  }

  // Downloading or looking up (the engine must not be replaced now).
  busy() { return this.running || !!this.active || !!this.lookup || this.jobs.some((j) => j.status === 'downloading'); }

  // ---- snapshots ------------------------------------------------------------------------------

  snapshot() {
    const live = (status) => ['waiting', 'analyzing', 'queued', 'downloading'].includes(status);
    return {
      seq: this.seq,
      jobs: this.jobs.map(toPublic),
      blockedSites: [...this.blocked].map((key) => ({
        key,
        othersActive: this.jobs.some((j) => j.siteKey !== key && live(j.status)),
      })),
      running: this.running,
      resting: !!this.restTimer,
      busy: this.busy(),
    };
  }

  // Coalesces the changes made in one turn into one snapshot, and saves the queue shortly after.
  changed({ save = true } = {}) {
    if (save) this.scheduleSave();
    this.seq++;
    if (this.emitQueued) return;
    this.emitQueued = true;
    queueMicrotask(() => { this.emitQueued = false; this.d.onChange(this.snapshot()); });
  }

  scheduleSave() {
    if (!this.d.store || this.saveTimer) return;
    this.saveTimer = this.d.clock.setTimeout(() => { this.saveTimer = null; this.flush(); }, SAVE_DELAY_MS);
  }

  async flush() {
    if (this.saveTimer) { this.d.clock.clearTimeout(this.saveTimer); this.saveTimer = null; }
    if (!this.d.store) return;
    try { await this.d.store.save(this.jobs.filter((j) => j.status !== 'done').map(toDurable).filter(Boolean)); } catch { /* next change saves again */ }
  }

  clearTimers() {
    for (const key of ['restTimer', 'lookupTimer', 'saveTimer']) {
      if (this[key]) { this.d.clock.clearTimeout(this[key]); this[key] = null; }
    }
  }

  // ---- commands from the renderer ---------------------------------------------------------------

  find(id) { return this.jobs.find((j) => j.id === id); }

  update(id, patch) {
    const job = this.find(id);
    if (!job) return null;
    Object.assign(job, typeof patch === 'function' ? patch(job) : patch);
    this.changed();
    return job;
  }

  // New links -> new jobs. A link already in the queue, or repeated in the same paste, is skipped.
  // nameEdited: the label is a name the user chose (re-download from history keeps it).
  add(links, { nameEdited = false, useBrowser = false, browser, instance, ref, sourceId, autoQueue = false } = {}) {
    const seen = new Set(this.jobs.filter((j) => !sourceId || !['done', 'error'].includes(j.status)).map((j) => sourceId ? j.sourceId : sameLinkKey(j.url)));
    let added = 0;
    for (const { url, label = '' } of links) {
      const key = sourceId || sameLinkKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      const session = !!(useBrowser || browser || ref || instance);
      this.jobs.push({ id: this.d.newId(), url, label, name: label, nameEdited, status: 'waiting', progress: 0, siteKey: siteKey(url), browserPick: browser || null, instancePick: instance || null, browserRef: ref || null, sourceId: sourceId || null, needsSession: session, sessionSource: session ? 'browser' : null, autoQueue });
      added++;
    }
    if (added) { this.changed(); this.pumpLookups(); }
    return { added, skipped: links.length - added };
  }

  rename(id, name) {
    const job = this.find(id);
    if (!job || job.status === 'downloading' || job.status === 'done') return;
    this.update(id, { name, nameEdited: true });
  }

  // Queues just this job; it joins the line behind anything already downloading. An explicit
  // click retries even a blocked site.
  downloadOne(id) {
    const job = this.find(id);
    if (!job || !['ready', 'paused', 'error', 'queued'].includes(job.status)) return;
    this.update(id, { status: 'queued' });
    this.blocked.delete(job.siteKey);
    this.running = true;
    this.changed();
    this.pumpDownloads();
    this.pumpLookups();
  }

  // Everything found or paused goes into the download line. Blocked sites stay blocked: their
  // jobs wait for "resume <site>" (GRB-14: a batch action doesn't lift other sites' blocks).
  downloadAll() {
    for (const job of this.jobs) if (job.status === 'ready' || job.status === 'paused') job.status = 'queued';
    this.running = true;
    this.changed();
    this.pumpDownloads();
  }

  pause(id) {
    const job = this.find(id);
    if (!job) return;
    if (job.status === 'downloading' && this.active?.jobId === id) {
      this.active.stopped = true;
      this.active.stop();
      this.update(id, { status: 'paused' });
    } else if (job.status === 'queued') {
      this.update(id, { status: 'paused' });
    }
  }

  resume(id) {
    const job = this.find(id);
    if (!job || job.status !== 'paused') return;
    this.update(id, { status: 'queued' });
    this.running = true;
    this.changed();
    this.pumpDownloads();
  }

  retry(id) {
    const job = this.find(id);
    if (!job || job.status !== 'error') return;
    if (job.analyzeFailed) {
      this.update(id, { status: 'waiting', analyzeFailed: false, error: null });
    } else if (job.mediaUrl || job.fromPage) {
      this.forget(job);
      this.update(id, { status: 'waiting', autoRetried: false, forcePage: true, autoQueue: true, error: null });
    } else {
      this.update(id, { status: 'queued', autoRetried: false, error: null, infoFile: null });
      this.running = true;
      this.changed();
      this.pumpDownloads();
    }
    this.pumpLookups();
  }

  remove(id) {
    const job = this.find(id);
    if (!job || job.status === 'analyzing') return;
    if (this.active?.jobId === id) { this.active.stopped = true; this.active.stop(); }
    this.jobs = this.jobs.filter((j) => j.id !== id);
    this.d.releaseContext(job, { finished: true });
    if (job.status !== 'done') this.report(job, { phase: 'cancelled', terminal: 'cancelled' });
    this.changed();
  }

  cancelLookup(id) {
    if (this.lookup?.jobId === id) this.lookup.controller.abort();
  }

  choose(id, index) {
    const job = this.find(id);
    const selected = job?.choiceOptions?.[index];
    if (!job || job.status !== 'error' || !selected) return;
    if (selected.kind === 'profile') { job.instancePick = selected.value; job.browserPick = selected.browser || job.browserPick; }
    else job.choice = { token: selected.token, index: selected.value };
    this.update(id, { status: 'waiting', error: null, analyzeFailed: false, choices: null, choiceOptions: null });
    this.pumpLookups();
  }

  browserPhase({ id, phase, browser, instance }) {
    if (this.find(id)?.status === 'analyzing') this.update(id, { bphase: phase, bbrowser: browser?.name || '', binstance: instance || '' });
  }

  report(job, report) { if (job.browserRef) this.d.reportJob(job.browserRef, report); }

  // Drag and drop: the job moves to where the target job is.
  move(fromId, toId) {
    const from = this.jobs.findIndex((j) => j.id === fromId);
    const to = this.jobs.findIndex((j) => j.id === toId);
    if (from < 0 || to < 0 || from === to) return;
    const [moved] = this.jobs.splice(from, 1);
    this.jobs.splice(to, 0, moved);
    this.changed();
  }

  resumeSite(key) {
    this.blocked.delete(key);
    if (this.jobs.some((j) => j.status === 'queued')) this.running = true;
    this.changed();
    this.pumpDownloads();
    this.pumpLookups();
  }

  // The finished file of a job (to reveal it), or null.
  fileOf(id) { return this.find(id)?.file || null; }

  // ---- internal helpers ---------------------------------------------------------------------------

  block(key) {
    if (this.blocked.has(key)) return;
    this.blocked.add(key);
    this.changed();
  }

  // Forgets the job's private lookup data (session cookies, info file, signed media address).
  forget(job) {
    this.d.releaseContext(job, { finished: false });
    Object.assign(job, { infoFile: null, infoAt: null, infoExpiresAt: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null });
  }

  // ---- lookups ------------------------------------------------------------------------------------

  nextLookup() { return this.jobs.find((j) => j.status === 'waiting' && !this.blocked.has(j.siteKey)); }

  pumpLookups() {
    if (this.held || this.lookup || this.lookupTimer) return;
    if (!this.nextLookup()) { this.lookupStreak = false; return; }
    if (!this.lookupStreak) { this.runLookup(); return; }
    const gap = LOOKUP_GAP_MS + this.d.random() * LOOKUP_GAP_MS;
    this.lookupTimer = this.d.clock.setTimeout(() => { this.lookupTimer = null; this.runLookup(); }, gap);
  }

  async runLookup() {
    if (this.held || this.lookup) return;
    const job = this.nextLookup(); // looked up again: its site may have been blocked during the gap
    if (!job) { this.lookupStreak = false; return; }
    this.lookupStreak = true;
    const controller = new AbortController();
    this.lookup = { jobId: job.id, controller };
    const { forcePage = false, autoQueue = false } = job;
    // Known to need the user's browser session: the lookup acquires it before contacting the site.
    const requireSession = requiresBrowserSession(job);
    this.update(job.id, { status: 'analyzing', error: null, signInHint: false, phase: forcePage ? 'page' : null, phaseBrowser: null, bphase: null, choices: null, fix: null });
    let info;
    try {
      info = await this.d.discover(job.url, {
        forcePage,
        requireSession,
        itemId: job.id, browser: job.browserPick, instance: job.instancePick, ref: job.browserRef, choice: job.choice,
        signal: controller.signal,
        onPhase: (phase, browser) => {
          const j = this.find(job.id);
          if (j?.status === 'analyzing') this.update(job.id, { phase, phaseBrowser: browser || null });
        },
      });
    } catch (error) {
      info = { ok: false, error: String(error.message || error) };
    }
    if (controller.signal.aborted) {
      if (info.ok) this.d.releaseContext(info, { finished: false });
      info = { ok: false, kind: 'cancelled', error: 'cancelled' };
    }
    job.choice = null;
    this.lookup = null;
    if (!this.closed) this.finishLookup(job.id, info, { autoQueue });
    this.pumpLookups();
  }

  finishLookup(id, info, { autoQueue }) {
    const job = this.find(id);
    if (!job) { this.d.releaseContext(info, { finished: true }); return; }
    if (!info.ok) {
      if (info.kind === 'cancelled') {
        this.update(id, { status: 'error', analyzeFailed: true, bphase: null, error: { stage: 'lookup', kind: 'cancelled', message: 'cancelled' } });
        this.report(job, { phase: 'cancelled', terminal: 'cancelled' });
        return;
      }
      if (info.kind === 'engineUpdating') {
        this.update(id, { status: 'waiting' });
        this.retryLater(() => this.pumpLookups());
        return;
      }
      if (HOLDS_SITE.has(info.kind)) {
        this.update(id, { status: 'waiting' }); // looked up again once the user resumes this site
        this.block(job.siteKey);
        return;
      }
      const choices = info.kind === 'browserChoice' ? (info.options || []).map((o) => ({ kind: 'profile', value: o.key, label: o.label, browser: info.browser?.id }))
        : info.kind === 'videoChoice' ? (info.choices || []).map((c) => ({ kind: 'video', token: info.token, value: c.index, label: c.label })) : null;
      this.update(id, {
        choices: choices?.map((c, index) => ({ index, label: c.label })), choiceOptions: choices,
        fix: ['browserUnavailable', 'extensionNotConnected', 'hostSetupError', 'wrongProfile'].includes(info.kind) ? 'settings' : null,
        status: 'error', analyzeFailed: true,
        error: { stage: 'lookup', kind: info.kind || null, message: info.error || '', browser: info.browser ? { ...(info.browser.id ? { id: info.browser.id } : {}), name: info.browser.name } : null },
        signInHint: !!info.browser && !info.browser.id && info.kind !== 'browserContext',
      });
      if (!choices) this.report(job, { phase: 'failed', terminal: 'failed', reason: info.kind });
      return;
    }
    this.forget(job);
    this.update(id, {
      status: autoQueue ? 'queued' : 'ready', forcePage: false, autoQueue: false, analyzeFailed: false, phase: null,
      site: info.site || null, duration: info.duration || null, height: info.height || null,
      thumbnail: info.thumbnail || null, title: info.title || null,
      name: job.nameEdited ? job.name : (job.label || info.title || ''),
      infoFile: info.infoFile || null, infoAt: info.infoAt || null, infoExpiresAt: info.infoExpiresAt || null,
      browserPick: info.browser?.id || job.browserPick || null, instancePick: info.instanceKey || job.instancePick || null, bphase: null, choices: null, choiceOptions: null, fix: null,
      // Found inside the page's player: download from that address, as the page does.
      mediaUrl: info.mediaUrl || null, referer: info.referer || null, fromPage: !!info.mediaUrl,
      cookieRef: info.cookieRef || null, requestContext: info.requestContext || null,
      // The lookup used cookies: without a live handle for them, look up again. Their source decides
      // whether that lookup must go through the user's browser (anything not labelled 'probe' does).
      needsSession: !!info.cookieRef || !!info.needsSession,
      sessionSource: info.cookieRef ? (info.sessionSource === 'probe' ? 'probe' : 'browser') : null,
    });
    this.report(job, { phase: autoQueue ? 'queued' : 'ready' });
    if (autoQueue) { this.running = true; this.changed(); this.pumpDownloads(); }
  }

  // Looks a job up again and queues it once found (inside the page's player when that is where it
  // came from); used when its session is gone. A job that needs the user's browser session is
  // looked up through that session only (see runLookup). Not counted as the automatic retry.
  relookup(job) {
    this.forget(job);
    this.update(job.id, { status: 'waiting', forcePage: !!job.fromPage, autoQueue: true });
    this.pumpLookups();
  }

  retryLater(fn) {
    const t = this.d.clock.setTimeout(() => fn(), RETRY_LATER_MS);
    return t;
  }

  // ---- downloads ------------------------------------------------------------------------------

  pumpDownloads() {
    if (!this.running || this.active || this.held) return;
    // Jobs from a blocked site stay queued and are skipped until the user resumes that site.
    const next = this.jobs.find((j) => j.status === 'queued' && !this.blocked.has(j.siteKey));
    if (!next) {
      this.running = false;
      if (this.restTimer) { this.d.clock.clearTimeout(this.restTimer); this.restTimer = null; }
      this.changed();
      return;
    }
    // Its session is gone (Grab restarted, or the browser disconnected and the snapshot was
    // dropped): look it up again first, never send the site a request without the session.
    if ((next.needsSession && (!next.cookieRef || (this.d.hasSession && !this.d.hasSession(next.cookieRef)))) || (next.fromPage && next.infoExpiresAt && next.infoExpiresAt <= this.d.clock.now() + 5000)) {
      this.relookup(next);
      this.pumpDownloads();
      return;
    }
    const isYouTube = !next.site || /youtube/i.test(next.site);
    const wait = this.restUntil - this.d.clock.now();
    if (isYouTube && wait > 0) {
      // The rest's end is a scheduler event of its own: it starts the next download (GRB-01).
      if (!this.restTimer) {
        this.restTimer = this.d.clock.setTimeout(() => { this.restTimer = null; this.changed(); this.pumpDownloads(); }, wait);
        this.changed();
      }
      return;
    }
    if (this.restTimer) { this.d.clock.clearTimeout(this.restTimer); this.restTimer = null; }
    this.startDownload(next);
  }

  startDownload(job) {
    const attemptId = ++this.attempts;
    const active = { jobId: job.id, attemptId, stopped: false, stop: () => { active.stopRequested = true; } };
    this.active = active;
    this.update(job.id, { status: 'downloading', speed: '', eta: '' });
    this.report(job, { phase: 'downloading' });
    (async () => {
      const settings = await this.d.getSettings();
      if (active.stopRequested) return { ok: false, stopped: true };
      const plan = {
        id: job.id, url: job.url, name: job.name, folder: settings.folder, format: settings.format, quality: settings.quality,
        infoFile: job.infoFile, infoAt: job.infoAt, infoExpiresAt: job.infoExpiresAt, mediaUrl: job.mediaUrl, referer: job.referer,
        cookieRef: job.cookieRef, requestContext: job.requestContext, outputBase: job.outputBase,
      };
      const run = this.d.startDownload(plan, (p) => {
        if (this.active !== active || active.stopped) return;
        const eta = p.eta && p.eta !== 'NA' && p.eta !== 'Unknown' ? p.eta : '';
        this.update(job.id, { progress: p.percent, speed: p.speed, eta });
      });
      active.stop = () => run.stop();
      if (run.outputBase) this.update(job.id, { outputBase: run.outputBase });
      const result = await run.done;
      return { ...result, format: settings.format };
    })()
      .catch((error) => ({ ok: false, error: String(error.message || error), kind: 'other', crashed: true }))
      .then((r) => this.finishDownload(active, r));
  }

  async finishDownload(active, r) {
    if (this.active === active) this.active = null;
    this.restUntil = this.d.clock.now() + DOWNLOAD_REST_MS + this.d.random() * DOWNLOAD_REST_MS;
    const job = this.find(active.jobId);
    if (!job || this.closed) { this.changed(); this.pumpDownloads(); return; }
    if (active.stopped || r.stopped) {
      // paused or removed by the user; nothing else changes
    } else if (r.ok) {
      const entry = { name: job.name, url: job.url, file: r.file || null, site: job.site || null, format: r.format };
      // What was actually delivered (resolution, video codec), when yt-dlp reported it (GRB-11).
      if (r.delivered?.height) entry.height = r.delivered.height;
      if (r.delivered?.vcodec) entry.vcodec = r.delivered.vcodec;
      try { await this.d.recordCompletion(entry); } catch { /* the file is saved even if history isn't */ }
      this.d.releaseContext(job, { finished: true });
      Object.assign(job, { infoFile: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null });
      this.update(job.id, { status: 'done', progress: 100, file: r.file || null, speed: '', eta: '' });
      this.report(job, { phase: 'completed', terminal: 'completed' });
    } else if (r.kind === 'engineUpdating') {
      this.update(job.id, { status: 'queued' });
      this.retryLater(() => this.pumpDownloads());
    } else if (r.kind === 'contextExpired') {
      // The session snapshot expired or was dropped (the browser disconnected) before anything was
      // sent: look it up again for a fresh one. This is not the job's one automatic retry.
      this.relookup(job);
    } else if (HOLDS_SITE.has(r.kind)) {
      this.update(job.id, { status: 'queued', infoFile: null }); // resumes from where it stopped
      this.block(job.siteKey);
    } else if (r.crashed || job.autoRetried) {
      this.update(job.id, { status: 'error', error: { stage: 'download', kind: r.kind || null, message: r.error || '' } });
      this.report(job, { phase: 'failed', terminal: 'failed', reason: r.kind });
    } else if (job.mediaUrl || job.fromPage || /^(generic|html5mediaembed)$/i.test(job.site || '')) {
      // One automatic retry. A generic page whose download failed often had its real video
      // inside the page's own player, so that retry looks there (refreshing expiring links)...
      this.forget(job);
      this.update(job.id, { status: 'waiting', autoRetried: true, forcePage: true, autoQueue: true });
      this.pumpLookups();
    } else {
      // ...otherwise it fetches fresh information in case the saved stream links expired.
      this.update(job.id, { status: 'queued', autoRetried: true, infoFile: null });
    }
    this.changed();
    this.pumpDownloads();
  }

  // ---- test seam ------------------------------------------------------------------------------

  // Shows the given rows as they are, with nothing running (screenshots and layout checks).
  seed(items, { blockedSites = [] } = {}) {
    this.held = true;
    this.clearTimers();
    this.jobs = items.map((x) => ({ ...x, id: String(x.id), siteKey: siteKey(x.url),
      error: x.status === 'error' ? { stage: 'lookup', kind: x.errorKind || null, message: x.errorMessage || '' } : null }));
    this.blocked = new Set(blockedSites);
    this.changed({ save: false });
  }
}

module.exports = { DownloadCoordinator, LOOKUP_GAP_MS, DOWNLOAD_REST_MS };

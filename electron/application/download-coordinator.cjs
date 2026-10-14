// The one owner of the download queue (GRB-02). The renderer sends commands and shows snapshots;
// every state change, the lookup and download schedules, per-site blocks, the rest between
// YouTube downloads, retries and history records happen here.
//
// Scheduling (unchanged from the version that lived in React):
// - Lookups: one link at a time, with a 2–4 s random gap between consecutive lookups, so sites
//   don't flag Grab as a bot.
// - Downloads: one at a time, in queue order; after each one, YouTube downloads wait 5–10 s.
//   When that rest ends the next download starts by itself (GRB-01).
// - Blocks: when a site says "slow down" (HTTP 429, "confirm you're not a bot"), only that site's
//   jobs wait, until the user resumes it; other sites carry on.
// - A failed download is retried once: a generic page is looked up again inside its player,
//   anything else is fetched again with fresh information.
//
// Everything outside is injected: discover, startDownload, history, settings, store, clock, random.
const { siteKey, sameLinkKey } = require('../domain/site-policy.cjs');
const { toPublic, toDurable, restore } = require('../domain/job.cjs');

const LOOKUP_GAP_MS = 2000; // plus up to the same again at random
const DOWNLOAD_REST_MS = 5000; // 5–10 seconds between YouTube downloads
const RETRY_LATER_MS = 3000; // the engine was being updated: try again shortly
const SAVE_DELAY_MS = 500;

const realClock = { now: () => Date.now(), setTimeout: (fn, ms) => setTimeout(fn, ms), clearTimeout: (t) => clearTimeout(t) };

class DownloadCoordinator {
  // deps:
  //   discover(url, { forcePage, onPhase, signal }) -> lookup result (discovery-service.cjs)
  //   startDownload(plan, onProgress) -> { stop(), done } (download-runner.cjs)
  //   getSettings() -> Promise<{ folder, format, quality }>
  //   recordCompletion(entry) -> Promise (history)
  //   releaseContext(job) -> forget the job's private lookup data (cookies, info file, name)
  //   store: { load(), save(list) } for the durable queue (optional)
  //   onChange(snapshot), clock, random, newId
  constructor(deps) {
    this.d = { clock: realClock, random: Math.random, newId: () => globalThis.crypto.randomUUID(), onChange: () => {}, releaseContext: () => {}, ...deps };
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
    try { await this.d.store.save(this.jobs.filter((j) => j.status !== 'done').map(toDurable)); } catch { /* next change saves again */ }
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
  add(links, { nameEdited = false } = {}) {
    const seen = new Set(this.jobs.map((j) => sameLinkKey(j.url)));
    let added = 0;
    for (const { url, label = '' } of links) {
      const key = sameLinkKey(url);
      if (seen.has(key)) continue;
      seen.add(key);
      this.jobs.push({ id: this.d.newId(), url, label, name: label, nameEdited, status: 'waiting', progress: 0, siteKey: siteKey(url) });
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
    this.changed();
  }

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
    Object.assign(job, { infoFile: null, infoAt: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null });
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
    this.update(job.id, { status: 'analyzing', error: null, signInHint: false, phase: forcePage ? 'page' : null, phaseBrowser: null });
    let info;
    try {
      info = await this.d.discover(job.url, {
        forcePage,
        signal: controller.signal,
        onPhase: (phase, browser) => {
          const j = this.find(job.id);
          if (j?.status === 'analyzing') this.update(job.id, { phase, phaseBrowser: browser || null });
        },
      });
    } catch (error) {
      info = { ok: false, error: String(error.message || error) };
    }
    this.lookup = null;
    if (!this.closed) this.finishLookup(job.id, info, { autoQueue });
    this.pumpLookups();
  }

  finishLookup(id, info, { autoQueue }) {
    const job = this.find(id);
    if (!job) { this.d.releaseContext(info, { finished: true }); return; }
    if (!info.ok) {
      if (info.kind === 'cancelled') { this.update(id, { status: 'waiting' }); return; }
      if (info.kind === 'engineUpdating') {
        this.update(id, { status: 'waiting' });
        this.retryLater(() => this.pumpLookups());
        return;
      }
      if (info.kind === 'blocked') {
        this.update(id, { status: 'waiting' }); // looked up again once the user resumes this site
        this.block(job.siteKey);
        return;
      }
      this.update(id, {
        status: 'error', analyzeFailed: true,
        error: { stage: 'lookup', kind: info.kind || null, message: info.error || '', browser: info.browser ? { name: info.browser.name } : null },
        signInHint: !!info.browser && info.kind !== 'browserContext',
      });
      return;
    }
    this.forget(job);
    this.update(id, {
      status: autoQueue ? 'queued' : 'ready', forcePage: false, autoQueue: false, analyzeFailed: false, phase: null,
      site: info.site || null, duration: info.duration || null, height: info.height || null,
      thumbnail: info.thumbnail || null, title: info.title || null,
      name: job.nameEdited ? job.name : (job.label || info.title || ''),
      infoFile: info.infoFile || null, infoAt: info.infoAt || null,
      // Found inside the page's player: download from that address, as the page does.
      mediaUrl: info.mediaUrl || null, referer: info.referer || null, fromPage: !!info.mediaUrl,
      cookieRef: info.cookieRef || null, requestContext: info.requestContext || null,
    });
    if (autoQueue) { this.running = true; this.changed(); this.pumpDownloads(); }
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
    (async () => {
      const settings = await this.d.getSettings();
      if (active.stopRequested) return { ok: false, stopped: true };
      const plan = {
        id: job.id, url: job.url, name: job.name, folder: settings.folder, format: settings.format, quality: settings.quality,
        infoFile: job.infoFile, infoAt: job.infoAt, mediaUrl: job.mediaUrl, referer: job.referer,
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
    } else if (r.kind === 'engineUpdating') {
      this.update(job.id, { status: 'queued' });
      this.retryLater(() => this.pumpDownloads());
    } else if (r.kind === 'contextExpired') {
      // The page's session snapshot expired (or Grab restarted): never download without it; look
      // the page up again for a fresh one. This is not the job's one automatic retry.
      this.forget(job);
      this.update(job.id, { status: 'waiting', forcePage: true, autoQueue: true });
      this.pumpLookups();
    } else if (r.kind === 'blocked') {
      this.update(job.id, { status: 'queued', infoFile: null }); // resumes from where it stopped
      this.block(job.siteKey);
    } else if (r.crashed || job.autoRetried) {
      this.update(job.id, { status: 'error', error: { stage: 'download', kind: r.kind || null, message: r.error || '' } });
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

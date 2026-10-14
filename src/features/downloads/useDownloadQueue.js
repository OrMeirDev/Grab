import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { api } from '../../platform/grabApi.js';
import { siteKey } from '../../domain/sites/siteKey.js';
import { siteInfo } from '../../presentation/sitePresentation.js';
import { errorLabel, LOOKUP_FAILED, DOWNLOAD_FAILED } from '../../presentation/errorMessages.js';

const LOOKUP_GAP_MS = 2000; // plus up to the same again at random
const DOWNLOAD_REST_MS = 5000; // 5–10 seconds between YouTube downloads
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let nextId = 1;
const newItem = (url, label, extra = {}) => ({ id: nextId++, url, label, name: label, status: 'waiting', progress: 0, ...extra });

// The download queue: lookups one at a time, downloads one at a time, per-site blocks.
export default function useDownloadQueue({ settings }) {
  const [queue, setQueue] = useState([]);
  const [running, setRunning] = useState(false);
  const queueRef = useRef(queue);
  queueRef.current = queue;

  const update = useCallback((id, patch) => {
    setQueue((q) => q.map((x) => (x.id === id ? { ...x, ...(typeof patch === 'function' ? patch(x) : patch) } : x)));
  }, []);

  useEffect(() => {
    if (!api) return undefined;
    // "Looking inside the page's player": shown on the item while that slower search runs.
    const offPhase = api.onLookupPhase ? api.onLookupPhase(({ url, phase, browser }) => {
      setQueue((q) => q.map((x) => (x.url === url && x.status === 'analyzing' ? { ...x, phase, phaseBrowser: browser } : x)));
    }) : null;
    const offProgress = api.onProgress(({ id, percent, speed, eta }) => {
      update(id, { progress: percent, speed, eta: eta && eta !== 'NA' && eta !== 'Unknown' ? eta : '' });
    });
    return () => { offProgress(); offPhase?.(); };
  }, [update]);

  // A block is per site: when YouTube blocks us, only YouTube items wait (each further request
  // would extend the block), while downloads from other sites carry on.
  const [blockedSites, setBlockedSites] = useState([]);
  const blockedRef = useRef(new Set());
  const isBlocked = (item) => blockedRef.current.has(siteKey(item.url));
  const setBlockedList = (set) => { blockedRef.current = set; setBlockedSites([...set]); };
  const triggerBlock = useCallback((key) => {
    if (blockedRef.current.has(key)) return;
    setBlockedList(new Set([...blockedRef.current, key]));
  }, []);
  const resumeSite = (key) => {
    const next = new Set(blockedRef.current);
    next.delete(key);
    setBlockedList(next);
    if (queueRef.current.some((x) => x.status === 'queued')) setRunning(true);
  };
  const clearBlocks = () => setBlockedList(new Set());

  // forcePage: go straight to looking inside the page's player (after a download from what
  // yt-dlp found at the link failed). autoQueue: download right away once found.
  const analyzeOne = useCallback(async (id, url, label, { forcePage = false, autoQueue = false } = {}) => {
    update(id, { status: 'analyzing', error: null, errorLabel: null, signInHint: false, phase: forcePage ? 'page' : null });
    let info;
    try { info = await api.analyze(url, { forcePage }); }
    catch (error) { info = { ok: false, error: error.message }; }
    if (!info.ok) {
      if (info.kind === 'blocked') {
        update(id, { status: 'waiting' }); // looked up again once the user resumes this site
        triggerBlock(siteKey(url));
        return;
      }
      update(id, { status: 'error', error: info.error, errorLabel: errorLabel(info.kind, LOOKUP_FAILED, info.browser), signInHint: !!info.browser && info.kind !== 'browserContext', analyzeFailed: true });
      return;
    }
    update(id, (x) => ({
      status: autoQueue ? 'queued' : 'ready', forcePage: false, autoQueue: false,
      analyzeFailed: false, site: info.site, duration: info.duration, height: info.height,
      thumbnail: info.thumbnail, title: info.title, name: x.nameEdited ? x.name : (label || info.title),
      infoFile: info.infoFile, infoAt: info.infoAt,
      // Found inside the page's player: download from that address, as the page does.
      mediaUrl: info.mediaUrl || null, referer: info.referer || null,
      cookieRef: info.cookieRef || null, requestContext: info.requestContext || null,
    }));
    if (autoQueue) setRunning(true);
  }, [update, triggerBlock]);

  // Lookup runner: one "waiting" link at a time with a randomized gap, so sites don't flag us as a bot.
  const lookupBusy = useRef(false);
  const runLookups = useCallback(async () => {
    if (lookupBusy.current) return;
    lookupBusy.current = true;
    let first = true;
    for (;;) {
      const next = queueRef.current.find((x) => x.status === 'waiting' && !isBlocked(x));
      if (!next) break;
      if (!first) await sleep(LOOKUP_GAP_MS + Math.random() * LOOKUP_GAP_MS);
      if (isBlocked(next)) continue; // its site got blocked while we waited
      first = false;
      await analyzeOne(next.id, next.url, next.label, { forcePage: !!next.forcePage, autoQueue: !!next.autoQueue });
      await sleep(0); // let the queue state settle before picking the next one
    }
    lookupBusy.current = false;
  }, [analyzeOne]);

  useEffect(() => {
    if (api && queue.some((x) => x.status === 'waiting' && !isBlocked(x))) runLookups();
  }, [queue, blockedSites, runLookups]);

  // New links -> new rows, skipping links already in the queue. Returns how many were skipped.
  const addLinks = (links) => {
    if (!api || !links.length) return 0;
    const existing = new Set(queueRef.current.map((x) => x.url));
    const fresh = links.filter((p) => !existing.has(p.url));
    setQueue((q) => [...q, ...fresh.map((p) => newItem(p.url, p.label))]);
    return links.length - fresh.length;
  };

  // Download again from history, keeping the name it was saved under.
  const requeue = (h) => {
    if (!queueRef.current.some((x) => x.url === h.url)) {
      setQueue((q) => [...q, newItem(h.url, h.name, { nameEdited: true })]);
    }
  };

  // Download runner: one video at a time, in queue order, with a short rest between YouTube videos.
  const [restUntil, setRestUntil] = useState(0);
  // The rest timer bumps this so the runner looks again when the rest ends (it is a dependency).
  const [restEnded, setRestEnded] = useState(0);
  useEffect(() => {
    if (!running || !api) return;
    if (queue.some((x) => x.status === 'downloading')) return;
    // Items from a blocked site stay queued and are skipped until the user resumes that site.
    const next = queue.find((x) => x.status === 'queued' && !blockedSites.includes(siteKey(x.url)));
    if (!next) { setRunning(false); return; }

    const isYouTube = !next.site || /youtube/i.test(next.site);
    const wait = restUntil - Date.now();
    if (isYouTube && wait > 0) {
      const t = setTimeout(() => setRestEnded((n) => n + 1), wait);
      return () => clearTimeout(t);
    }

    update(next.id, { status: 'downloading', speed: '', eta: '' });
    api.start({
      id: next.id, url: next.url, name: next.name, folder: settings.folder, format: settings.format, quality: settings.quality,
      infoFile: next.infoFile, infoAt: next.infoAt, mediaUrl: next.mediaUrl, referer: next.referer,
      cookieRef: next.cookieRef, requestContext: next.requestContext,
    }).then((r) => {
      setRestUntil(Date.now() + DOWNLOAD_REST_MS + Math.random() * DOWNLOAD_REST_MS);
      if (r.ok) {
        api.addHistory({ name: next.name, url: next.url, file: r.file, site: siteInfo(next.site)?.name || null, format: settings.format });
        return update(next.id, { status: 'done', progress: 100, file: r.file });
      }
      if (r.stopped) return; // paused or removed by the user
      if (r.kind === 'blocked') {
        update(next.id, { status: 'queued', infoFile: null }); // resumes from where it stopped
        return triggerBlock(siteKey(next.url));
      }
      // One automatic retry. A generic page whose download failed often had its real video inside
      // the page's own player, so that retry looks there; otherwise it fetches fresh info in case
      // the saved stream links expired.
      update(next.id, (x) => (x.autoRetried
        ? { status: 'error', error: r.error, errorLabel: errorLabel(r.kind, DOWNLOAD_FAILED) }
        : x.mediaUrl || /^(generic|html5mediaembed)$/i.test(x.site || '')
          ? { status: 'waiting', autoRetried: true, forcePage: true, autoQueue: true, infoFile: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null }
          : { status: 'queued', autoRetried: true, infoFile: null }));
    }).catch((error) => update(next.id, { status: 'error', error: error.message, errorLabel: DOWNLOAD_FAILED }));
  }, [queue, running, blockedSites, restUntil, restEnded, settings, update, triggerBlock]);

  const downloadAll = () => {
    if (!api) return;
    setQueue((q) => q.map((x) => (x.status === 'ready' || x.status === 'paused' ? { ...x, status: 'queued' } : x)));
    clearBlocks();
    setRunning(true);
  };

  const actions = {
    rename: (id, name) => update(id, { name, nameEdited: true }),
    // Queues just this row; it joins the line behind anything already downloading.
    downloadOne: (id) => {
      const item = queueRef.current.find((x) => x.id === id);
      update(id, { status: 'queued' });
      if (item) resumeSite(siteKey(item.url)); // an explicit click retries even a blocked site
      setRunning(true);
    },
    pause: (id) => { api.stop(id); update(id, { status: 'paused' }); },
    resume: (id) => { update(id, { status: 'queued' }); setRunning(true); },
    retry: (item) => {
      if (item.analyzeFailed) return update(item.id, { status: 'waiting', analyzeFailed: false, error: null });
      if (item.mediaUrl) return update(item.id, { status: 'waiting', autoRetried: false, forcePage: true, autoQueue: true, error: null, infoFile: null, mediaUrl: null, referer: null, cookieRef: null, requestContext: null });
      update(item.id, { status: 'queued', autoRetried: false, error: null, infoFile: null });
      setRunning(true);
    },
    remove: (id) => {
      const item = queueRef.current.find((x) => x.id === id);
      if (item?.status === 'downloading') api.stop(id);
      setQueue((q) => q.filter((x) => x.id !== id));
    },
    show: (item) => (item.file ? api.showFile(item.file) : api.openFolder(settings.folder)),
  };

  const move = (from, to) => setQueue((q) => { const c = [...q]; const [moved] = c.splice(from, 1); c.splice(to, 0, moved); return c; });

  const counts = useMemo(() => ({
    done: queue.filter((x) => x.status === 'done').length,
    failed: queue.filter((x) => x.status === 'error').length,
    pending: queue.filter((x) => ['ready', 'queued', 'paused', 'downloading'].includes(x.status)).length,
  }), [queue]);

  const downloading = queue.some((x) => x.status === 'downloading');
  return {
    queue,
    blockedSites: blockedSites.map((key) => ({
      key,
      othersActive: queue.some((x) => siteKey(x.url) !== key && ['waiting', 'analyzing', 'queued', 'downloading'].includes(x.status)),
    })),
    running,
    resting: running && restUntil > Date.now() && !downloading,
    busy: running || downloading,
    counts,
    actions,
    move,
    addLinks,
    requeue,
    downloadAll,
    resumeSite,
  };
}

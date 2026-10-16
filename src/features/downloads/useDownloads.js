import { useEffect, useMemo, useState } from 'react';
import { api } from '../../platform/grabApi.js';
import { errorLabel, LOOKUP_FAILED, DOWNLOAD_FAILED } from '../../presentation/errorMessages.js';

const EMPTY = { seq: -1, jobs: [], blockedSites: [], running: false, resting: false, busy: false };

// A job from the main process -> the row the queue shows (adds the Hebrew error label).
function toRow(job, draftName) {
  const row = { ...job, error: job.error?.message || null, errorLabel: null };
  if (job.error) row.errorLabel = errorLabel(job.error.kind, job.error.stage === 'download' ? DOWNLOAD_FAILED : LOOKUP_FAILED, job.error.browser);
  if (draftName !== undefined) row.name = draftName;
  return row;
}

// The download queue as the main process reports it, and the commands the user can give it.
// The queue's owner is the main process (electron/application/download-coordinator.cjs): this
// hook never schedules, retries or starts anything itself.
export default function useDownloads() {
  const [snap, setSnap] = useState(EMPTY);
  // Names being typed, shown at once while the main process catches up (keeps the cursor still).
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    const d = api?.downloads;
    if (!d) return undefined;
    // Snapshots are numbered; an older one (a slow reply) never replaces a newer one.
    const take = (s) => setSnap((cur) => (s && s.seq >= cur.seq ? s : cur));
    const off = d.onChange(take);
    d.snapshot().then(take).catch(() => {});
    return off;
  }, []);

  useEffect(() => {
    setDrafts((cur) => {
      const next = {};
      for (const job of snap.jobs) if (cur[job.id] !== undefined && cur[job.id] !== job.name) next[job.id] = cur[job.id];
      return Object.keys(next).length === Object.keys(cur).length ? cur : next;
    });
  }, [snap]);

  const queue = useMemo(() => snap.jobs.map((j) => toRow(j, drafts[j.id])), [snap, drafts]);

  const counts = useMemo(() => ({
    done: queue.filter((x) => x.status === 'done').length,
    failed: queue.filter((x) => x.status === 'error').length,
    pending: queue.filter((x) => ['ready', 'queued', 'paused', 'downloading'].includes(x.status)).length,
  }), [queue]);

  const d = api?.downloads;
  const actions = {
    rename: (id, name) => { setDrafts((cur) => ({ ...cur, [id]: name })); d?.rename(id, name); },
    downloadOne: (id) => d?.start(id),
    pause: (id) => d?.pause(id),
    resume: (id) => d?.resume(id),
    retry: (item) => d?.retry(item.id),
    cancelAnalyze: (id) => d?.cancelLookup(id),
    reveal: (id) => d?.revealPlayback(id),
    choose: (item, choice) => d?.choose(item.id, choice.index),
    remove: (id) => d?.remove(id),
    show: (item) => d?.show(item.id),
  };

  return {
    queue,
    blockedSites: snap.blockedSites,
    running: snap.running,
    resting: snap.resting,
    busy: snap.busy,
    counts,
    actions,
    // Drag and drop gives row positions; the main process is told which job goes where.
    move: (from, to) => { if (queue[from] && queue[to]) d?.move(queue[from].id, queue[to].id); },
    // -> how many of the links were already in the queue
    addLinks: async (links, options) => (d ? (await d.add(links.map(({ url, label }) => ({ url, label })), options)).skipped : 0),
    // Download again from history, keeping the name it was saved under.
    requeue: (h) => d?.add([{ url: h.url, label: h.name }], { nameEdited: true }),
    downloadAll: () => d?.startAll(),
    resumeSite: (key) => d?.resumeSite(key),
  };
}

// A download job: its states and what of it may leave the main process. Pure.
//
// States (the names the UI already uses):
//   waiting      -> its turn to be looked up
//   analyzing    -> being looked up (yt-dlp, then the page's player, then the user's browser)
//   ready        -> found; waits for "download"
//   queued       -> waits for its turn to download
//   downloading  -> yt-dlp (and ffmpeg) running
//   paused       -> stopped by the user, or interrupted by closing Grab; resumes on request
//   done         -> file saved and recorded in history
//   error        -> lookup or download failed (retry is offered)
// Exactly one owner moves jobs between these states: the DownloadCoordinator.

const STATES = ['waiting', 'analyzing', 'ready', 'queued', 'downloading', 'paused', 'done', 'error'];

// Fields the renderer sees. Session material (cookie handles, request headers), signed media
// addresses and lookup files never leave the main process.
const PUBLIC_FIELDS = ['id', 'url', 'label', 'name', 'status', 'progress', 'speed', 'eta', 'phase', 'phaseBrowser',
  'site', 'duration', 'height', 'thumbnail', 'title', 'file', 'signInHint', 'analyzeFailed'];

function toPublic(job) {
  const out = {};
  for (const key of PUBLIC_FIELDS) if (job[key] !== undefined && job[key] !== null) out[key] = job[key];
  if (job.status === 'error' && job.error) {
    out.error = { message: job.error.message || '', kind: job.error.kind || null, stage: job.error.stage, browser: job.error.browser || null };
  }
  return out;
}

// Fields kept across restarts. Not kept: cookies, request context, signed media URLs, lookup
// files (they expire, and they are sensitive).
const DURABLE_FIELDS = ['id', 'url', 'label', 'name', 'nameEdited', 'status', 'progress', 'site', 'siteKey', 'duration', 'height',
  'thumbnail', 'title', 'error', 'analyzeFailed', 'autoRetried', 'forcePage', 'autoQueue', 'fromPage', 'outputBase', 'signInHint'];

function toDurable(job) {
  const out = {};
  for (const key of DURABLE_FIELDS) if (job[key] !== undefined && job[key] !== null) out[key] = job[key];
  return out;
}

// A job saved by an earlier run of Grab, as it comes back: nothing is running any more, so a
// download that was running or queued is paused (the user resumes it), a lookup starts again,
// and finished jobs are left to history.
function restore(saved) {
  if (!saved || typeof saved !== 'object' || typeof saved.id !== 'string' || typeof saved.url !== 'string' || !STATES.includes(saved.status)) return null;
  if (saved.status === 'done') return null;
  const job = { ...toDurable(saved), progress: Number(saved.progress) || 0 };
  if (job.status === 'downloading' || job.status === 'queued') job.status = 'paused';
  if (job.status === 'analyzing') job.status = 'waiting';
  return job;
}

module.exports = { STATES, toPublic, toDurable, restore };

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

const { linkHasSecret, stripLinksInText } = require('./secrets.cjs');

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
// files and thumbnails (they expire, and they can carry signatures). needsSession records only
// that the lookup used a browser session, so the job is looked up again before it downloads.
const DURABLE_FIELDS = ['id', 'url', 'label', 'name', 'nameEdited', 'status', 'progress', 'site', 'siteKey', 'duration', 'height',
  'title', 'error', 'analyzeFailed', 'autoRetried', 'forcePage', 'autoQueue', 'fromPage', 'needsSession', 'outputBase', 'signInHint'];

// -> the job as saved in queue.json, or null when it can't be saved safely: a pasted link that
// itself carries a token, signature or credentials is not written to disk (that job is not
// restored after a restart).
function toDurable(job) {
  if (linkHasSecret(job.url)) return null;
  const out = {};
  for (const key of DURABLE_FIELDS) if (job[key] !== undefined && job[key] !== null) out[key] = job[key];
  if (out.error) out.error = { ...out.error, message: stripLinksInText(out.error.message) };
  return out;
}

// A job saved by an earlier run of Grab, as it comes back: nothing is running any more, so a
// download that was running or queued is paused (the user resumes it), a lookup starts again,
// and finished jobs are left to history.
function restore(saved) {
  if (!saved || typeof saved !== 'object' || typeof saved.id !== 'string' || typeof saved.url !== 'string' || !STATES.includes(saved.status)) return null;
  if (saved.status === 'done') return null;
  const durable = toDurable(saved);
  if (!durable) return null;
  const job = { ...durable, progress: Number(saved.progress) || 0 };
  if (job.status === 'downloading' || job.status === 'queued') job.status = 'paused';
  if (job.status === 'analyzing') job.status = 'waiting';
  return job;
}

module.exports = { STATES, toPublic, toDurable, restore };

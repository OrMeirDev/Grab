// Shapes of the records Grab stores (settings, history), and how a stored value that is old,
// partial or damaged is turned into a usable one. Pure.

const FORMATS = ['mp4', 'mp3'];
const QUALITIES = ['best', '1080', '720', '480'];
const HISTORY_LIMIT = 1000;

const str = (v, max) => (typeof v === 'string' ? v.slice(0, max) : null);

// Unknown keys are dropped, invalid values fall back to the defaults.
function normalizeSettings(raw, defaults) {
  const s = raw && typeof raw === 'object' ? raw : {};
  return {
    folder: str(s.folder, 1024) || defaults.folder,
    format: FORMATS.includes(s.format) ? s.format : defaults.format,
    quality: QUALITIES.includes(s.quality) ? s.quality : defaults.quality,
  };
}

// A history entry. id: entries saved before ids existed get one (makeId) the first time they load.
function normalizeHistoryEntry(e, makeId) {
  if (!e || typeof e !== 'object' || typeof e.url !== 'string') return null;
  return {
    id: str(e.id, 64) || makeId(),
    name: str(e.name, 500) || '',
    url: e.url.slice(0, 4096),
    file: str(e.file, 1024),
    site: str(e.site, 100),
    format: FORMATS.includes(e.format) ? e.format : 'mp4',
    completedAt: str(e.completedAt, 40) || new Date(0).toISOString(),
    ...(e.height ? { height: Number(e.height) || null } : {}),
    ...(e.vcodec ? { vcodec: str(e.vcodec, 40) } : {}),
  };
}

function normalizeHistory(raw, makeId) {
  return (Array.isArray(raw) ? raw : []).map((e) => normalizeHistoryEntry(e, makeId)).filter(Boolean).slice(0, HISTORY_LIMIT);
}

module.exports = { FORMATS, QUALITIES, HISTORY_LIMIT, normalizeSettings, normalizeHistory, normalizeHistoryEntry };

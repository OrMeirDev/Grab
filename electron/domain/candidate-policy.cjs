// What counts as a downloadable media source on a page, and in which order sources are tried.
// Shared by both page probes (hidden-probe.cjs, pageprobe.cjs) so they agree. Pure.
//
// DRM: a license request (Widevine/PlayReady/FairPlay) only marks the page as protected, so the
// user is told it can't be downloaded. Nothing here tries to get past it.

const FILE = /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|ogg|opus|wav|flac|aac)(\?|#|$)/i;
const MANIFEST = /\.(m3u8|mpd)(\?|#|$)/i;
const MEDIA_TYPE = /^(video\/|audio\/|application\/(vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/i;
// Pieces of a stream (the manifest is what's wanted) and common ad servers.
const SEGMENT = /\.(ts|m4s)(\?|#|$)|[/_-](seg|segment|chunk|frag)[-_]?\d|init[-_]?\d*\.mp4/i;
const ADS = /doubleclick|googlesyndication|googleads|imasdk|adnxs|adsystem|advert|\/ads?\//i;
const LICENSE = /widevine|playready|fairplay|\/license/i;

// How many sources a lookup checks with yt-dlp (each check can take seconds).
const CANDIDATE_BUDGET = 12;

// -> { kind: 'stream' | 'file' } or { reject: reason }
function classify(url, type = '') {
  if (typeof url !== 'string' || !/^https?:/i.test(url)) return { reject: 'not-http' };
  if (ADS.test(url)) return { reject: 'ad' };
  // Stream pieces are skipped by name and by type (some services give them odd names, e.g. ".dts").
  if (SEGMENT.test(url) || /mp2t|iso\.segment/i.test(type)) return { reject: 'segment' };
  if (MANIFEST.test(url) || /mpegurl|dash/i.test(type)) return { kind: 'stream' };
  if (FILE.test(url) || /^(video|audio)\//i.test(type)) return { kind: 'file' };
  return { reject: 'not-media' };
}

// A source a player element itself points at (its src). Without a media extension it is still
// almost certainly media, e.g. in a tab that loaded it before Grab attached, when no response type
// was seen. Such a source is kept as an unverified file; yt-dlp checks every candidate anyway.
function classifyPlayerSource(url) {
  const verdict = classify(url);
  return verdict.reject === 'not-media' ? { kind: 'file', unverified: true } : verdict;
}

// Player sources the network never confirmed, as candidates (see classifyPlayerSource).
function unconfirmedPlayerSources(playerSources, found) {
  const out = [];
  for (const url of playerSources) {
    if (found.has(url)) continue;
    const v = classifyPlayerSource(url);
    if (v.kind) out.push({ url, kind: v.kind, size: 0, fromPlayer: true, unverified: !!v.unverified });
  }
  return out;
}

// The player's own source first, then stream manifests, then the largest files.
function rankMedia(list) {
  return [...list].sort((a, b) => (!!b.fromPlayer - !!a.fromPlayer) || ((b.kind === 'stream') - (a.kind === 'stream')) || ((b.size || 0) - (a.size || 0)));
}

// Embedded players worth trying: other sites' frames that aren't ads, payments, captchas, etc.
function playerEmbeds(urls, pageUrl, isNotPlayer) {
  const host = (() => { try { return new URL(pageUrl).host; } catch { return ''; } })();
  return [...urls].filter((u) => {
    if (!/^https?:/i.test(u) || ADS.test(u) || isNotPlayer(u)) return false;
    try { return new URL(u).host !== host; } catch { return false; }
  });
}

// Candidates to check, in order: duplicates removed, at most CANDIDATE_BUDGET.
function budget(candidates, max = CANDIDATE_BUDGET) {
  const seen = new Set();
  const out = [];
  for (const c of candidates) {
    if (!c?.url || seen.has(c.url)) continue;
    seen.add(c.url);
    out.push(c);
    if (out.length >= max) break;
  }
  return out;
}

const isLicenseRequest = (url) => LICENSE.test(url || '');
const isMediaType = (type) => MEDIA_TYPE.test(type || '');

module.exports = { classify, classifyPlayerSource, unconfirmedPlayerSources, rankMedia, playerEmbeds, budget, isLicenseRequest, isMediaType, CANDIDATE_BUDGET };

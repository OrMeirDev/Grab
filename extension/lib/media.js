// Media classification and candidate ranking shared by the extension (to avoid keeping noise)
// and the desktop app (to decide which candidate is the real video). Plain UMD script.
// URLs are never rewritten: signed query parameters are kept byte for byte.
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  else root.GrabMedia = api;
}(typeof self !== 'undefined' ? self : this, function () {
  const FILE_EXT = /\.(mp4|webm|mov|m4v|mkv|mp3|m4a|ogg|ogv|opus|wav|flac|aac)$/i;
  const SEGMENT_EXT = /\.(ts|m4s|cmfv|cmfa|cmft|dts|vtt|srt|webvtt)$/i;
  const SEGMENT_NAME = /(?:^|[/_-])(?:seg|segment|chunk|frag|fragment)[-_]?\d|(?:^|\/)init[-_]?\d*\.mp4$|\/(?:init|header)\.mp4$/i;
  const SEGMENT_TYPE = /mp2t|iso\.segment|mp4-segment/i;
  const IMAGE_EXT = /\.(gif|png|jpe?g|webp|avif|svg|ico|bmp)$/i;
  const ADS = /doubleclick|googlesyndication|googleads|imasdk|adnxs|adsystem|advert|\/ads?\/|:\/\/ads?\.|moatads|adsafeprotected|scorecardresearch|pubmatic|taboola|outbrain/i;
  const LICENSE = /widevine|playready|fairplay|\/license(?:[/?]|$)/i;
  const NOT_PLAYER_HOST = /(^|\.)(stripe\.com|stripe\.network|stripecdn\.com|hcaptcha\.com|recaptcha\.net|sardine\.ai|paypal\.com|braintreegateway\.com|adyen\.com|challenges\.cloudflare\.com|accounts\.google\.com|appleid\.apple\.com|googletagmanager\.com|google-analytics\.com|intercom\.io|intercomcdn\.com|crisp\.chat|zdassets\.com|zendesk\.com|hotjar\.com|onetrust\.com|cookielaw\.org|cookiebot\.com)$/i;
  const IDENTITY_SYNC_PATH = /\/(?:setuid|usersync|cookie_sync|syncframe)(?:\.html?)?\/?$/i;
  const VARIANT_NAME = /(?:chunklist|media[_-]?\d|index[_-]?\d|playlist[_-]?\d|\d{3,4}p(?:[._/-]|$)|[_-]\d{3,4}k|_v\d|variant|audio_|subs?[_-])/i;

  const parse = (url) => { try { const u = new URL(url); return /^https?:$/.test(u.protocol) ? u : null; } catch { return null; } };

  const isNotPlayer = (url) => {
    const u = parse(url);
    if (!u) return true;
    return NOT_PLAYER_HOST.test(u.hostname) || IDENTITY_SYNC_PATH.test(u.pathname)
      || (/(^|\.)google\.com$/i.test(u.hostname) && u.pathname.startsWith('/recaptcha'));
  };
  const isLicense = (url) => LICENSE.test(String(url));

  // obs: { url, contentType?, size?, status? }. Returns { kind } or null to ignore.
  // kind: 'hls' | 'dash' | 'file' | 'opaque'. 'opaque' = media known only from response metadata.
  function classify(obs) {
    const u = parse(obs && obs.url);
    if (!u || isNotPlayer(obs.url)) return null;
    if (obs.status && (obs.status >= 400 || (obs.status >= 300 && obs.status < 400))) return null;
    const path = u.pathname;
    const type = String(obs.contentType || '').split(';')[0].trim().toLowerCase();
    if (/^image\//.test(type) || IMAGE_EXT.test(path)) return null;
    if (SEGMENT_EXT.test(path) || SEGMENT_NAME.test(path) || SEGMENT_TYPE.test(type)) return null;
    if (/\.m3u8$/i.test(path) || /mpegurl/.test(type)) return { kind: 'hls' };
    if (/\.mpd$/i.test(path) || /dash\+xml/.test(type)) return { kind: 'dash' };
    if (FILE_EXT.test(path)) return { kind: 'file' };
    if (/^(video|audio)\//.test(type)) return { kind: 'opaque' };
    return null;
  }

  const canonicalKey = (url) => { const u = parse(url); return u ? u.origin + u.pathname : String(url); };
  const dirOf = (url) => { const u = parse(url); return u ? u.origin + u.pathname.replace(/[^/]*$/, '') : ''; };
  const isVariantPlaylist = (url) => { const u = parse(url); return !!u && VARIANT_NAME.test(u.pathname.split('/').pop() || ''); };

  const sameNavigationUrl = (a, b) => {
    const x = parse(a); const y = parse(b);
    if (!x || !y) return false;
    x.hash = ''; y.hash = '';
    return x.href === y.href;
  };

  // Origins whose cookies may be offered for a candidate: only the media URL, the redirect hops
  // that were actually observed for it, and segment hosts the same player requested.
  function scopeUrls(candidate) {
    const urls = [candidate.url, ...(candidate.redirects || [])];
    for (const h of candidate.hosts || []) urls.push('https://' + h + '/');
    const seen = new Set();
    return urls.filter((u) => { const p = parse(u); if (!p) return false; if (seen.has(p.origin)) return false; seen.add(p.origin); return true; });
  }

  // observations: [{ url, kind, size, at, fromPlayer, frameId, context, redirects, hosts }]
  // Returns { ranked, plausible, ambiguous }.
  function rank(observations, { now = Date.now() } = {}) {
    const byUrl = new Map();
    for (const o of observations || []) {
      if (!o || !parse(o.url) || o.kind === 'embed' || isLicense(o.url)) continue;
      const prev = byUrl.get(o.url);
      byUrl.set(o.url, prev ? {
        ...prev, ...o,
        size: Math.max(prev.size || 0, o.size || 0),
        fromPlayer: !!(prev.fromPlayer || o.fromPlayer),
        at: Math.max(prev.at || 0, o.at || 0),
        context: (o.context && (o.context.origin || !prev.context)) ? o.context : prev.context,
        redirects: o.redirects || prev.redirects,
        hosts: o.hosts || prev.hosts,
      } : { ...o });
    }
    let list = [...byUrl.values()];
    // The same media with a refreshed token: keep the newest.
    const newest = new Map();
    for (const c of list) {
      const key = canonicalKey(c.url);
      if (!newest.has(key) || (c.at || 0) >= (newest.get(key).at || 0)) newest.set(key, c);
    }
    list = [...newest.values()];
    // Playlists of one stream (master + the variants the player then requested) live together: keep the
    // master. A master-looking name wins, a variant-looking name loses, then the one requested first
    // (a master is always requested before its variants).
    const MASTERISH = /(?:master|main|playlist|manifest|multi|abr|all)/i;
    const byDir = new Map();
    for (const c of list) {
      if (c.kind !== 'hls') continue;
      const dir = dirOf(c.url);
      (byDir.get(dir) || byDir.set(dir, []).get(dir)).push(c);
    }
    for (const group of byDir.values()) {
      if (group.length < 2) continue;
      const nameOf = (c) => { const u = parse(c.url); return (u && u.pathname.split('/').pop()) || ''; };
      const score = (c) => (MASTERISH.test(nameOf(c)) ? 3 : 0) - (isVariantPlaylist(c.url) ? 3 : 0) - (/^(?:index|chunklist|media|level|prog)/i.test(nameOf(c)) ? 1 : 0);
      group.sort((a, b) => score(b) - score(a) || (a.firstAt || a.at || 0) - (b.firstAt || b.at || 0));
      // Only when the winner is clearly the master: two unrelated streams in one folder both stay.
      for (const loser of group.slice(1)) if (score(group[0]) > score(loser)) list = list.filter((c) => c !== loser);
    }
    // A variant playlist is subsumed by the master playlist of the same stream.
    const masters = list.filter((c) => c.kind === 'hls' && !isVariantPlaylist(c.url));
    list = list.filter((c) => {
      if (c.kind !== 'hls') return true;
      const dir = dirOf(c.url);
      const named = isVariantPlaylist(c.url);
      return !masters.some((m) => {
        if (m === c) return false;
        const md = dirOf(m.url);
        // A variant-looking playlist near a master is that master's; so is any playlist in a deeper
        // folder that was requested after the master (the player fetches variants only after the master).
        if (named) return dir.startsWith(md) || md.startsWith(dir.replace(/[^/]*\/$/, ''));
        return dir !== md && dir.startsWith(md) && (m.firstAt || m.at || 0) < (c.firstAt || c.at || 0);
      });
    });
    const scored = list.map((c) => {
      let score = { hls: 50, dash: 50, file: 40, opaque: 30 }[c.kind] || 0;
      if (c.fromPlayer) score += 30;
      if (c.frameId === 0) score += 5;
      if (ADS.test(c.url)) score -= 60;
      if (c.size && c.size < 150000) score -= 35;
      else if (c.size) score += Math.min(10, Math.floor(c.size / 1048576));
      if (c.at && now - c.at < 120000) score += 3;
      return { ...c, score };
    }).sort((a, b) => b.score - a.score || (b.at || 0) - (a.at || 0));
    const top = scored[0];
    const plausible = top && top.score >= 30 ? scored.filter((c) => c.score >= 30 && c.score >= top.score - 20) : [];
    return { ranked: scored, plausible, ambiguous: plausible.length > 1 };
  }

  // Remove query values and path tokens from a URL for logs and error text.
  function redactUrl(url) {
    return String(url || '').replace(/https?:\/\/[^\s"'<>]+/gi, (m) => m
      .replace(/((?:hdntl|hdnea|hdnts)=)[^/?#\s]+/gi, '$1[redacted]')
      .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=[redacted]'));
  }

  return { classify, rank, canonicalKey, isNotPlayer, isLicense, isVariantPlaylist, sameNavigationUrl, scopeUrls, redactUrl, ADS };
}));

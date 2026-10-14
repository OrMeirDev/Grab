// Which site a link belongs to, from the URL alone so it works before the lookup finishes.
// Blocks are tracked per site key: "youtube", "tiktok", "vimeo", ...
export function siteKey(url) {
  try {
    const host = new URL(url).hostname.toLowerCase().replace(/^(www|m|mobile|vm)\./, '');
    if (/(^|\.)(youtube\.com|youtu\.be|youtube-nocookie\.com)$/.test(host)) return 'youtube';
    const parts = host.split('.');
    return parts.length > 1 ? parts[parts.length - 2] : host;
  } catch {
    return 'unknown';
  }
}

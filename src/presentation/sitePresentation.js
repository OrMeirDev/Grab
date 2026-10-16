// How sites are shown: brand marks for the well-known ones, Hebrew names for blocked-site banners.
import { siYoutube, siVimeo, siInstagram, siTiktok } from 'simple-icons';

// Brand marks from Simple Icons (CC0 SVG paths), drawn white on the brand color.
export const SITES = [
  { key: 'youtube', name: 'YouTube', color: '#ff0000', icon: siYoutube },
  { key: 'vimeo', name: 'Vimeo', color: '#1ab7ea', icon: siVimeo },
  { key: 'instagram', name: 'Instagram', color: '#ff0069', icon: siInstagram },
  { key: 'tiktok', name: 'TikTok', color: '#000000', icon: siTiktok },
];

// A site name from yt-dlp ("Youtube", "Generic", ...) -> { name, color, icon | letter }.
export function siteInfo(site) {
  if (!site) return null;
  const key = site.toLowerCase();
  return SITES.find((s) => key.includes(s.key)) || { name: site, color: '#8b8fa3', letter: site[0]?.toUpperCase() || '?' };
}

const SITE_LABELS = { youtube: 'יוטיוב', tiktok: 'טיקטוק', instagram: 'אינסטגרם', vimeo: 'Vimeo', facebook: 'פייסבוק', x: 'X', twitter: 'X' };
// A site key ("youtube") -> the name shown in Hebrew text.
export const siteLabel = (key) => SITE_LABELS[key] || key.charAt(0).toUpperCase() + key.slice(1);

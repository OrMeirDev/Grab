// Pasted text -> the links in it. Pure: no React, Electron or browser APIs.

export const URL_RE = /https?:\/\/[^\s<>"']+/;

// "שיעור מספר 2: https://..." -> { label: "שיעור מספר 2", url }
export function parseLinks(text) {
  return String(text || '').split(/\r?\n/).map((line) => {
    const m = line.match(URL_RE);
    if (!m) return null;
    const label = line.slice(0, m.index).replace(/[\s:–\-|]+$/, '').trim();
    return { url: m[0], label };
  }).filter(Boolean);
}

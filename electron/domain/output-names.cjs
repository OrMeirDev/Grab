// File names for downloads. Pure: no filesystem, no Electron.
//
// Windows rules: no <>:"/\|?* or control characters, no trailing dot or space, and no device
// name (CON, PRN, AUX, NUL, COM1-9, LPT1-9) even with an extension ("nul.mp4" opens the null device).

const INVALID = /[<>:"/\\|?*\u0000-\u001f]/g;
const RESERVED = /^(con|prn|aux|nul|com[1-9¹²³]|lpt[1-9¹²³])$/i;
// A name is cut to this many characters, leaving room for " (12)" and ".f137.mp4.part".
const MAX_NAME = 180;

function safeName(name) {
  let s = String(name ?? '').replace(INVALID, ' ').replace(/\s+/g, ' ').trim();
  s = s.slice(0, MAX_NAME).replace(/[. ]+$/, '');
  if (!s) return 'video';
  // "con", "con.txt", "CON " -> "_con..." (the device check ignores everything after the first dot)
  if (RESERVED.test(s.split('.')[0].trim())) s = '_' + s;
  return s;
}

// Windows paths longer than this need special handling in many tools (yt-dlp, ffmpeg, Explorer).
const MAX_PATH = 259;
// Room reserved after the base name for the longest temporary suffix yt-dlp writes.
const SUFFIX_ROOM = '.f999-999.webm.part'.length + ' (999)'.length;

// The longest base name that fits in folder, keeping the whole path under MAX_PATH.
function fitName(folder, name) {
  const room = MAX_PATH - String(folder).length - 1 - SUFFIX_ROOM;
  if (room < 8) return null; // the folder itself is too deep
  const s = safeName(name);
  return s.length <= room ? s : s.slice(0, room).replace(/[. ]+$/, '') || 'video';
}

// "name" -> "name (2)", "name (3)", ...
const numbered = (base, n) => (n < 2 ? base : `${base} (${n})`);

module.exports = { safeName, fitName, numbered, MAX_NAME };

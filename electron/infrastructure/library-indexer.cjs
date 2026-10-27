// The media files in the download folder, read without blocking the main process: asynchronous,
// three folder levels deep, at most MAX_FILES files, and a file that disappears or can't be read
// is skipped instead of failing the whole list.
const fs = require('fs');
const path = require('path');

const MEDIA = /\.(mp4|mkv|webm|mov|m4a|mp3|opus|wav|flac|pdf)$/i;
const MAX_DEPTH = 3;
const MAX_FILES = 5000;

async function listLibrary(dir, { fsImpl = fs, signal } = {}) {
  const p = fsImpl.promises;
  const out = [];
  const walk = async (d, depth) => {
    if (signal?.aborted || out.length >= MAX_FILES) return;
    let entries;
    try { entries = await p.readdir(d, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (signal?.aborted || out.length >= MAX_FILES) return;
      const file = path.join(d, ent.name);
      if (ent.isDirectory()) {
        if (depth < MAX_DEPTH) await walk(file, depth + 1);
      } else if (ent.isFile() && MEDIA.test(ent.name)) {
        try {
          const st = await p.stat(file);
          out.push({ file, name: ent.name, folder: path.relative(dir, d), size: st.size, modified: st.mtime.toISOString() });
        } catch { /* gone or not readable */ }
      }
    }
  };
  await walk(dir, 0);
  return out.sort((a, b) => b.modified.localeCompare(a.modified));
}

module.exports = { listLibrary, MEDIA };

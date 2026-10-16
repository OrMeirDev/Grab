// Chooses each download's file name in the download folder: safe on Windows, short enough for the
// path limit, and unique, so two jobs never write to, or claim, the same file. A job keeps its
// name for its whole life (its partial .part files are found again on resume).
const fs = require('fs');
const path = require('path');
const { fitName, numbered } = require('../domain/output-names.cjs');

class OutputAllocator {
  constructor({ fsImpl = fs } = {}) {
    this.fs = fsImpl;
    this.reserved = new Map(); // job id -> absolute base path (no extension)
  }

  // Lowercased names in folder that start with base followed by a dot (any extension, partials).
  taken(folder) {
    let names = [];
    try { names = this.fs.readdirSync(folder); } catch { /* folder not created yet */ }
    return names.map((n) => n.toLowerCase());
  }

  // -> absolute base path without extension, e.g. C:\Downloads\Grab\Lesson 2 (2)
  allocate(jobId, folder, name) {
    const existing = this.reserved.get(jobId);
    if (existing && path.dirname(existing) === path.resolve(folder)) return existing;
    const base = fitName(folder, name);
    if (!base) throw Object.assign(new Error('The download folder path is too long'), { kind: 'pathTooLong' });
    const names = this.taken(folder);
    const others = new Set([...this.reserved.entries()].filter(([id]) => id !== jobId).map(([, p]) => p.toLowerCase()));
    for (let n = 1; n < 1000; n++) {
      const candidate = numbered(base, n);
      const full = path.join(path.resolve(folder), candidate);
      const lower = candidate.toLowerCase() + '.';
      if (others.has(full.toLowerCase())) continue;
      if (names.some((x) => x.startsWith(lower))) continue;
      this.reserved.set(jobId, full);
      return full;
    }
    throw Object.assign(new Error('No free file name'), { kind: 'other' });
  }

  // A job restored after a restart claims the name it had.
  restore(jobId, base) { if (base) this.reserved.set(jobId, base); }
  release(jobId) { this.reserved.delete(jobId); }

  // The finished file of a base path when yt-dlp didn't report it: the one non-partial file.
  findOutput(base) {
    const dir = path.dirname(base);
    const prefix = path.basename(base).toLowerCase() + '.';
    let names = [];
    try { names = this.fs.readdirSync(dir); } catch { return null; }
    const hits = names.filter((n) => n.toLowerCase().startsWith(prefix) && !/\.(part|ytdl|temp|tmp)$|\.part-Frag\d+/i.test(n)
      && /^\.[a-z0-9]{2,5}$/i.test(n.slice(prefix.length - 1)));
    return hits.length === 1 ? path.join(dir, hits[0]) : null;
  }
}

module.exports = { OutputAllocator };

// A JSON file that is never left half-written: each save goes to a temporary file that replaces
// the real one in a single rename, the previous version is kept as <file>.bak, and saves are
// serialized. Loading falls back to the backup, then to the default, when a file is damaged.
const fs = require('fs');
const path = require('path');

class JsonStore {
  // normalize(value) -> the value to use, or throws when it is unusable.
  constructor(file, { fallback, normalize = (v) => v, fsImpl = fs } = {}) {
    this.file = file;
    this.fallback = fallback;
    this.normalize = normalize;
    this.fs = fsImpl.promises ? fsImpl : fs;
    this.chain = Promise.resolve();
  }

  async load() {
    for (const file of [this.file, this.file + '.bak']) {
      try {
        return this.normalize(JSON.parse(await this.fs.promises.readFile(file, 'utf8')));
      } catch { /* missing or damaged: try the next one */ }
    }
    return this.normalize(typeof this.fallback === 'function' ? this.fallback() : this.fallback);
  }

  save(value) {
    const run = () => this.write(value);
    const next = this.chain.then(run, run);
    this.chain = next.catch(() => {});
    return next;
  }

  async write(value) {
    const p = this.fs.promises;
    await p.mkdir(path.dirname(this.file), { recursive: true });
    const tmp = `${this.file}.${process.pid}.${Date.now()}.tmp`;
    const handle = await p.open(tmp, 'w');
    try {
      await handle.writeFile(JSON.stringify(value, null, 2));
      await handle.sync();
    } finally { await handle.close(); }
    try { await p.copyFile(this.file, this.file + '.bak'); } catch { /* first save */ }
    // Windows can briefly refuse the rename while an antivirus scans the old file.
    for (let attempt = 0; ; attempt++) {
      try { await p.rename(tmp, this.file); return; }
      catch (error) {
        if (attempt >= 4 || !['EPERM', 'EACCES', 'EBUSY'].includes(error.code)) {
          await p.rm(tmp, { force: true }).catch(() => {});
          throw error;
        }
        await new Promise((r) => setTimeout(r, 50 * (attempt + 1)));
      }
    }
  }
}

module.exports = { JsonStore };

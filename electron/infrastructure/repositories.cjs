// Settings and history, stored as atomic JSON files in the user's data folder.
const crypto = require('crypto');
const path = require('path');
const { JsonStore } = require('./json-store.cjs');
const { normalizeSettings, normalizeHistory, normalizeHistoryEntry, HISTORY_LIMIT } = require('../domain/records.cjs');

class SettingsRepository {
  constructor(dir, defaults) {
    this.defaults = defaults;
    this.store = new JsonStore(path.join(dir, 'settings.json'), { fallback: {}, normalize: (v) => normalizeSettings(v, defaults) });
    this.current = null;
    this.writes = Promise.resolve();
  }
  async get() { return this.current || (this.current = await this.store.load()); }
  update(patch) {
    const next = this.writes.then(() => this.apply(patch));
    this.writes = next.catch(() => {});
    return next;
  }
  async apply(patch) {
    const next = normalizeSettings({ ...(await this.get()), ...patch }, this.defaults);
    this.current = next;
    await this.store.save(next);
    return next;
  }
}

class HistoryRepository {
  constructor(dir) {
    this.store = new JsonStore(path.join(dir, 'history.json'), { fallback: [], normalize: (v) => normalizeHistory(v, () => crypto.randomUUID()) });
    this.list = null;
    this.chain = Promise.resolve();
  }
  // Changes are applied one at a time, so two completions never overwrite each other.
  serial(fn) {
    const next = this.chain.then(fn, fn);
    this.chain = next.catch(() => {});
    return next;
  }
  async all() {
    if (!this.list) {
      const loaded = await this.store.load();
      if (!this.list) {
        this.list = loaded;
        // entries from before ids existed keep the ids they were just given
        if (loaded.length) await this.store.save(loaded);
      }
    }
    return this.list;
  }
  add(entry) {
    return this.serial(async () => {
      const e = normalizeHistoryEntry({ ...entry, id: crypto.randomUUID(), completedAt: new Date().toISOString() }, () => crypto.randomUUID());
      this.list = [e, ...(await this.all())].slice(0, HISTORY_LIMIT);
      await this.store.save(this.list);
      return e;
    });
  }
  clear() {
    return this.serial(async () => { this.list = []; await this.store.save([]); });
  }
  async has(file) { return !!file && (await this.all()).some((e) => e.file === file); }
}

module.exports = { SettingsRepository, HistoryRepository };

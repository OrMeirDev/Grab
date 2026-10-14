// Every engine process Grab has running (lookups, downloads, version and site-list queries), so
// an engine replacement or an app restart can see them, stop them and wait until they are gone.

class ProcessRegistry {
  constructor() { this.handles = new Set(); }

  add(handle) { this.handles.add(handle); }
  remove(handle) { this.handles.delete(handle); }
  get size() { return this.handles.size; }

  // Stops everything and waits (up to timeoutMs) for the trees to exit. Resolves true when all did.
  async stopAll(timeoutMs = 10000) {
    const pending = [...this.handles];
    for (const h of pending) h.stop('aborted');
    let timer;
    const timeout = new Promise((resolve) => { timer = setTimeout(() => resolve(false), timeoutMs); });
    const all = Promise.all(pending.map((h) => h.done)).then(() => true);
    try { return await Promise.race([all, timeout]); } finally { clearTimeout(timer); }
  }
}

module.exports = { ProcessRegistry };

// Length-prefixed JSON framing used by Native Messaging (browser <-> host, native byte order,
// little-endian on every platform Chromium supports) and reused on the local pipe to the app.
const MAX_FRAME_BYTES = 1024 * 1024;

function encodeFrame(message, max = MAX_FRAME_BYTES) {
  const body = Buffer.from(JSON.stringify(message), 'utf8');
  if (body.length > max) throw Object.assign(new Error('Frame too large'), { code: 'FRAME_TOO_LARGE' });
  const out = Buffer.allocUnsafe(4 + body.length);
  out.writeUInt32LE(body.length, 0);
  body.copy(out, 4);
  return out;
}

// Accepts arbitrary chunks (split or combined frames). Calls onMessage(object) for each valid
// frame and onError({ code }) for a bad one. A frame that is too large cannot be skipped
// safely (its body is never buffered), so the parser stops for good after reporting it.
class FrameParser {
  constructor({ max = MAX_FRAME_BYTES, onMessage, onError } = {}) {
    this.max = max;
    this.onMessage = onMessage || (() => {});
    this.onError = onError || (() => {});
    this.chunks = [];
    this.buffered = 0;
    this.need = null; // body length once the header is read
    this.dead = false;
  }

  push(chunk) {
    if (this.dead) return;
    this.chunks.push(chunk);
    this.buffered += chunk.length;
    for (;;) {
      if (this.dead) return;
      if (this.need === null) {
        if (this.buffered < 4) return;
        const buf = this.take(4);
        this.need = buf.readUInt32LE(0);
        if (this.need > this.max) {
          this.dead = true;
          this.chunks = [];
          this.buffered = 0;
          this.onError({ code: 'oversize', length: this.need });
          return;
        }
      }
      if (this.buffered < this.need) return;
      const body = this.take(this.need);
      this.need = null;
      let message;
      try { message = JSON.parse(body.toString('utf8')); } catch { this.onError({ code: 'malformed' }); continue; }
      if (message === null || typeof message !== 'object' || Array.isArray(message)) { this.onError({ code: 'malformed' }); continue; }
      this.onMessage(message);
    }
  }

  take(n) {
    const all = this.chunks.length === 1 ? this.chunks[0] : Buffer.concat(this.chunks);
    const out = all.subarray(0, n);
    const rest = all.subarray(n);
    this.chunks = rest.length ? [rest] : [];
    this.buffered = rest.length;
    return out;
  }
}

module.exports = { MAX_FRAME_BYTES, encodeFrame, FrameParser };

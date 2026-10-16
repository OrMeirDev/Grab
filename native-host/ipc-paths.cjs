// Where the desktop app and the native host meet. The pipe name is derived from the
// per-user integration directory, so two users (or two test directories) never share one, and
// a token file in that private directory authenticates both ends.
const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

function pipePath(integrationDir, platform = process.platform) {
  const id = crypto.createHash('sha256').update(path.resolve(integrationDir).toLowerCase()).digest('hex').slice(0, 16);
  if (platform === 'win32') return `\\\\.\\pipe\\grab-browser-${id}`;
  return path.join(integrationDir, `ipc-${id}.sock`);
}

function ensureToken(integrationDir) {
  const file = path.join(integrationDir, 'ipc-token');
  try {
    const existing = fs.readFileSync(file, 'utf8').trim();
    if (/^[0-9a-f]{64}$/.test(existing)) return existing;
  } catch { /* create below */ }
  fs.mkdirSync(integrationDir, { recursive: true });
  const token = crypto.randomBytes(32).toString('hex');
  fs.writeFileSync(file, token, { mode: 0o600 });
  return token;
}

function readToken(integrationDir) {
  try {
    const token = fs.readFileSync(path.join(integrationDir, 'ipc-token'), 'utf8').trim();
    return /^[0-9a-f]{64}$/.test(token) ? token : null;
  } catch { return null; }
}

// Challenge-response: the app sends a nonce, the host answers with an HMAC of it. The token itself
// never crosses the pipe, so a process squatting on the pipe name learns nothing.
const proof = (token, nonce) => crypto.createHmac('sha256', token).update(String(nonce)).digest('hex');
const proofMatches = (token, nonce, given) => {
  const want = Buffer.from(proof(token, nonce));
  const have = Buffer.from(String(given));
  return want.length === have.length && crypto.timingSafeEqual(want, have);
};

module.exports = { pipePath, ensureToken, readToken, proof, proofMatches };

// Only replay the non-secret playback headers we understand. Cookies retain their own
// domain/path scope in browser-session; arbitrary captured headers never become CLI options.
const FIELDS = { 'user-agent': 'userAgent', referer: 'referer', origin: 'origin' };
function normalizeContext(value) {
  const context = {};
  for (const key of Object.values(FIELDS)) {
    const text = value?.[key];
    if (typeof text === 'string' && text.length <= 8192 && !/[\x00-\x1f\x7f]/.test(text)) context[key] = text;
  }
  return context;
}

function contextFromHeaders(headers, userAgent = '') {
  // Empty values record that the *observed request* omitted Referer/Origin. In particular,
  // a no-referrer player must not acquire the enclosing page's URL later in the pipeline.
  const context = { userAgent, referer: '', origin: '' };
  for (const [name, value] of Object.entries(headers || {})) {
    const field = FIELDS[name.toLowerCase()];
    if (field) context[field] = Array.isArray(value) ? value[0] : value;
  }
  return normalizeContext(context);
}

// CDP's actual sent headers can arrive before or after requestWillBeSent. Redirects reuse
// request IDs, and IDs are only unique within a target session. Pair ExtraInfo in hop order,
// skipping hops that CDP explicitly says have no ExtraInfo.
class RequestContexts {
  constructor(getUserAgent, onContext) {
    this.getUserAgent = getUserAgent;
    this.onContext = onContext;
    this.ids = new Map();
    this.latest = new Map();
  }
  state(sessionId, requestId) {
    const key = `${sessionId}:${requestId}`;
    if (!this.ids.has(key)) this.ids.set(key, { hops: [], extras: [] });
    return this.ids.get(key);
  }
  publish(hop) {
    if (this.latest.get(hop.url) === hop) this.onContext(hop.url, hop.context);
  }
  drain(state) {
    let index = 0;
    for (const hop of state.hops) {
      // Recompute when a later redirect/response tells us an earlier hop had no ExtraInfo.
      // This also handles ExtraInfo arriving before either request event.
      hop.context = !hop.noExtra && index < state.extras.length
        ? contextFromHeaders(state.extras[index++], hop.baseContext.userAgent) : hop.baseContext;
      this.publish(hop);
    }
  }
  request(sessionId, details) {
    const request = details.request;
    if (!request?.url) return;
    const context = contextFromHeaders(request.headers, this.getUserAgent());
    const hop = { url: request.url, context, baseContext: context };
    this.latest.set(hop.url, hop);
    this.publish(hop);
    if (!details.requestId) return;
    const state = this.state(sessionId, details.requestId);
    if (details.redirectResponse && details.redirectHasExtraInfo === false && state.hops.length) state.hops.at(-1).noExtra = true;
    state.hops.push(hop);
    this.drain(state);
  }
  extra(sessionId, details) {
    if (!details.requestId) return;
    const state = this.state(sessionId, details.requestId);
    state.extras.push(details.headers);
    this.drain(state);
  }
  response(sessionId, details) {
    if (!details.requestId || details.hasExtraInfo !== false) return;
    const state = this.state(sessionId, details.requestId);
    const hop = state.hops.at(-1);
    if (hop) hop.noExtra = true;
    this.drain(state);
  }
  get(url) { return this.latest.get(url)?.context; }
}

function mediaExpiry(...urls) {
  const times = [];
  for (const url of urls) {
    if (typeof url !== 'string') continue;
    let decoded;
    try { decoded = decodeURIComponent(url); } catch { decoded = url; }
    for (const match of decoded.matchAll(/[?&~/=](?:exp|expire|expires)=(\d{10,13})(?=[~&#/]|$)/gi)) {
      const value = Number(match[1]);
      times.push(value < 1e12 ? value * 1000 : value);
    }
  }
  return times.length ? Math.min(...times) : null;
}

function redactMediaSecrets(text) {
  return String(text || '').replace(/https?:\/\/[^\s"'<>]+/gi, (url) => url
    .replace(/((?:hdntl|hdnea|hdnts)=)[^/?#\s]+/gi, '$1[redacted]')
    .replace(/([?&][^=&#\s]+)=([^&#\s]*)/g, '$1=[redacted]'));
}

module.exports = { normalizeContext, contextFromHeaders, RequestContexts, mediaExpiry, redactMediaSecrets };

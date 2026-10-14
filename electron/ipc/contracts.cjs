// Runtime checks for everything that crosses from the renderer into the main process. A request
// that doesn't match is rejected before any handler runs. Pure (no Electron, no filesystem).

class ContractError extends Error {
  constructor(message) { super(message); this.name = 'ContractError'; this.kind = 'contract'; }
}
const fail = (where, what) => { throw new ContractError(`${where}: ${what}`); };

const t = {
  string: ({ max = 2048, min = 0 } = {}) => (v, where) => {
    if (typeof v !== 'string') fail(where, 'expected text');
    if (v.length < min || v.length > max) fail(where, `text length must be ${min}-${max}`);
    return v;
  },
  oneOf: (...values) => (v, where) => (values.includes(v) ? v : fail(where, `expected one of ${values.join(', ')}`)),
  bool: () => (v, where) => (typeof v === 'boolean' ? v : fail(where, 'expected true/false')),
  int: ({ min = 0, max = Number.MAX_SAFE_INTEGER } = {}) => (v, where) => (Number.isInteger(v) && v >= min && v <= max ? v : fail(where, `expected a whole number ${min}-${max}`)),
  // An http(s) link the way a user pastes it; signed query strings are kept as they are.
  url: ({ max = 4096 } = {}) => (v, where) => {
    if (typeof v !== 'string' || v.length > max) fail(where, 'expected a link');
    let u;
    try { u = new URL(v); } catch { fail(where, 'expected a link'); }
    if (u.protocol !== 'http:' && u.protocol !== 'https:') fail(where, 'only http(s) links');
    if (u.username || u.password) fail(where, 'links with credentials are not accepted');
    return v;
  },
  id: () => t.string({ min: 1, max: 64 }),
  optional: (schema) => (v, where) => (v === undefined || v === null ? undefined : schema(v, where)),
  array: (item, { max = 1000 } = {}) => (v, where) => {
    if (!Array.isArray(v)) fail(where, 'expected a list');
    if (v.length > max) fail(where, `at most ${max} items`);
    return v.map((x, i) => item(x, `${where}[${i}]`));
  },
  // Only the listed keys are allowed; missing optional keys stay missing.
  object: (shape) => (v, where) => {
    if (!v || typeof v !== 'object' || Array.isArray(v)) fail(where, 'expected an object');
    for (const key of Object.keys(v)) if (!(key in shape)) fail(where, `unexpected field "${key}"`);
    const out = {};
    for (const [key, schema] of Object.entries(shape)) {
      const value = schema(v[key], `${where}.${key}`);
      if (value !== undefined) out[key] = value;
    }
    return out;
  },
};

// args: the values sent; schemas: one per accepted argument. Extra arguments are rejected.
function validateArgs(channel, schemas, args) {
  if (args.length > schemas.length) fail(channel, `expected at most ${schemas.length} argument(s)`);
  return schemas.map((schema, i) => schema(args[i], `${channel} argument ${i + 1}`));
}

module.exports = { t, validateArgs, ContractError };

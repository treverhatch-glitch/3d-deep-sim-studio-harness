/**
 * harness/hash.mjs — state hashes, in two tiers. Both hash the same bytes: canonical JSON (keys
 * sorted, no spaces) encoded as UTF-8.
 *
 *   hash64(state)     fast display hash: FNV-1a 64-bit, 16 hex chars. Pure JS, runs in a browser
 *                     and inside a cartridge (no imports). For the HUD, playtest reports and quick
 *                     "did it change?" checks. Not tamper-resistant: never use it to prove anything.
 *   sha256(state)     verification hash: SHA-256, 64 hex chars. For golden files, regressions,
 *                     exported trajectories and anything another party has to trust. Uses Node's
 *                     built-in crypto, loaded only when called, so this file stays browser-safe.
 *
 * tools/golden.py implements both, and `node qa/run-python.mjs qa/test-golden.py` proves Node and
 * Python agree on every golden file. Changing either function changes every golden: regenerate them
 * in the same commit (`npm run golden -- --update`, `node qa/check-regressions.mjs --update`).
 * See docs/HASH.md.
 */

/** Object keys in Unicode code-point order (Python's order), not UTF-16 unit order. */
export function compareKeys(a, b) {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i += 1) {
    const d = x[i].codePointAt(0) - y[i].codePointAt(0);
    if (d) return d;
  }
  return x.length - y.length;
}

/**
 * Canonical JSON text, built directly so nothing reorders it. JSON.stringify on an object puts
 * integer-like keys ("0", "2", "10") first in numeric order whatever order they were added in, so
 * the text is built here: keys in code-point order, no spaces, numbers as JavaScript writes them
 * (tools/golden.py writes numbers the same way), -0 as 0, NaN and Infinity as null, undefined
 * object fields left out and undefined array items as null.
 */
export function canonicalJson(value) {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number') return Number.isFinite(value) ? JSON.stringify(Object.is(value, -0) ? 0 : value) : 'null';
  if (typeof value === 'string' || typeof value === 'boolean') return JSON.stringify(value);
  if (typeof value.toJSON === 'function') return canonicalJson(value.toJSON());
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined || typeof v === 'function' ? 'null' : canonicalJson(v))).join(',')}]`;
  if (typeof value === 'object') {
    const keys = Object.keys(value).filter((k) => value[k] !== undefined && typeof value[k] !== 'function').sort(compareKeys);
    return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(value[k])}`).join(',')}}`;
  }
  return 'null';
}

/** Kept for callers that want a sorted copy; hashing uses canonicalJson. */
export function canonical(value) {
  return JSON.parse(canonicalJson(value));
}

/** The exact bytes both hashes read. */
export function canonicalBytes(state) {
  return new TextEncoder().encode(canonicalJson(state));
}

const FNV64_OFFSET = 0xcbf29ce484222325n;
const FNV64_PRIME = 0x100000001b3n;
const MASK64 = 0xffffffffffffffffn;

/** FNV-1a 64-bit over raw bytes (standard test vectors: "" -> cbf29ce484222325, "a" -> af63dc4c8601ec8c). */
export function fnv1a64(bytes) {
  let h = FNV64_OFFSET;
  for (const byte of bytes) {
    h ^= BigInt(byte);
    h = (h * FNV64_PRIME) & MASK64;
  }
  return h.toString(16).padStart(16, '0');
}

/** The display hash: FNV-1a 64-bit over the canonical UTF-8 bytes (one true 64-bit lane). */
export function hash64(state) {
  return fnv1a64(canonicalBytes(state));
}

/** SHA-256 over the canonical UTF-8 bytes. Node (or any runtime with node:crypto) only. */
export function sha256(state) {
  const crypto = globalThis.process?.getBuiltinModule?.('node:crypto');
  if (!crypto) throw new Error('sha256() needs Node 22.3 or newer (node:crypto); use hash64() for display in a browser.');
  return crypto.createHash('sha256').update(canonicalBytes(state)).digest('hex');
}

export const isHash64 = (value) => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);
export const isSha256 = (value) => typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

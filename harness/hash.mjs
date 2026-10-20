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

export function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') {
    return Object.keys(value).sort().reduce((acc, key) => {
      acc[key] = canonical(value[key]);
      return acc;
    }, {});
  }
  return value;
}

/** The exact bytes both hashes read. */
export function canonicalBytes(state) {
  return new TextEncoder().encode(JSON.stringify(canonical(state)));
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

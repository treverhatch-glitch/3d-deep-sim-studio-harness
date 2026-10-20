/**
 * harness/hash.mjs — the default 64-bit state hash for cartridges.
 *
 * Two 32-bit FNV-1a lanes over canonical JSON (keys sorted), printed as 16 hex chars.
 * tools/golden.py implements the same function, and `python3 qa/test-golden.py` proves
 * the two agree on every golden file. Changing this function changes every golden hash:
 * regenerate them in the same commit (`npm run golden -- --update`).
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

export function hash64(state) {
  const json = JSON.stringify(canonical(state));
  let h1 = 0x811c9dc5;
  let h2 = 0x811c9dc5 ^ 0x01000193;
  for (let i = 0; i < json.length; i++) {
    const c = json.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= c;
    h2 = Math.imul(h2, 0x01000193) >>> 0;
    h2 = (h2 + i) >>> 0;
  }
  return h1.toString(16).padStart(8, '0') + h2.toString(16).padStart(8, '0');
}

export const isHash64 = (value) => typeof value === 'string' && /^[0-9a-f]{16}$/.test(value);

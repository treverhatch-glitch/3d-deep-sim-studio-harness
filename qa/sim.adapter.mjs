/**
 * qa/sim.adapter.mjs — Generic 3D Deep-Sim Playtest Adapter Contract
 *
 * Implements the "Recursive Game Creator" (arXiv:2610.08621) programmatic player
 * interface + `?playtest=1` (`window.__sim`) inspection bridge.
 *
 * Any 3D simulation cartridge mounted in this studio template only needs to
 * expose `window.__sim` (in browser mode) or export a module matching this
 * adapter interface (in headless Node mode):
 *
 *   - init(seed: number): SimState
 *   - step(ticks?: number): SimState
 *   - dispatch(action: object): { ok: boolean, reason?: string }
 *   - getState(): SimState
 *   - serialize(): string
 *   - deserialize(rawJson: string): SimState
 *   - getHash(): string
 *   - invariants(state: SimState): Array<{ id: string, severity: 'P0'|'P1'|'P2', message: string }>
 */

/** Portable 32-bit FNV-1a hash over canonical quantized JSON. */
export function hashCanonicalState(value) {
  let h = 0x811c9dc5;
  const feed = (str) => {
    for (let i = 0; i < str.length; i++) {
      h ^= str.charCodeAt(i);
      h = Math.imul(h, 0x01000193) >>> 0;
    }
  };
  const walk = (v) => {
    if (v === null || v === undefined) return feed('null;');
    if (typeof v === 'number') {
      if (!Number.isFinite(v)) return feed('NaN;');
      return feed(`n:${Math.round(v * 1000)};`);
    }
    if (typeof v === 'boolean') return feed(v ? 'true;' : 'false;');
    if (typeof v === 'string') return feed(`s:${v};`);
    if (Array.isArray(v)) {
      feed(`[${v.length}:`);
      for (const item of v) walk(item);
      return feed(']');
    }
    if (typeof v === 'object') {
      const keys = Object.keys(v).sort();
      feed(`{${keys.length}:`);
      for (const k of keys) {
        feed(`${k}=`);
        walk(v[k]);
      }
      return feed('}');
    }
  };
  walk(value);
  return (h >>> 0).toString(16).padStart(8, '0');
}

/** Recursively scan any SimState object for NaN or Infinity values. */
export function findNonFiniteNumbers(obj, prefix = 'state', out = []) {
  if (typeof obj === 'number') {
    if (!Number.isFinite(obj)) out.push(`${prefix} is ${obj}`);
    return out;
  }
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj)) {
    obj.forEach((v, i) => findNonFiniteNumbers(v, `${prefix}[${i}]`, out));
    return out;
  }
  for (const [k, v] of Object.entries(obj)) {
    findNonFiniteNumbers(v, `${prefix}.${k}`, out);
  }
  return out;
}

/**
 * Default reference simulation adapter used when no external cartridge is mounted.
 * Models a minimal deterministic tick clock + seeded sfc32 RNG + entity array so
 * Stage 1 QA (`node qa/playtest.mjs`) can verify the entire harness out-of-the-box.
 */
export function createReferenceSimAdapter() {
  let state = null;

  function seedSfc32(seed) {
    let s = seed >>> 0;
    const splitmix = () => {
      s = (s + 0x9e3779b9) >>> 0;
      let z = s;
      z = Math.imul(z ^ (z >>> 16), 0x85ebca6b) >>> 0;
      z = Math.imul(z ^ (z >>> 13), 0xc2b2ae35) >>> 0;
      return (z ^ (z >>> 16)) >>> 0;
    };
    return [splitmix(), splitmix(), splitmix(), splitmix()];
  }

  function nextRngU32(rng) {
    const [a, b, c, d] = rng;
    const t = (((a + b) >>> 0) + d) >>> 0;
    rng[3] = (d + 1) >>> 0;
    rng[0] = (b ^ (b >>> 9)) >>> 0;
    rng[1] = (c + (c << 3)) >>> 0;
    rng[2] = (((c << 21) | (c >>> 11)) + t) >>> 0;
    return t;
  }

  return {
    name: 'generic-deep-sim-reference',

    init(seed = 42) {
      state = {
        version: 1,
        seed: seed >>> 0,
        tick: 0,
        rng: seedSfc32(seed),
        resources: { energy: 100, credits: 500 },
        entities: [
          { id: 1, kind: 'extractor', x: -4, z: 2, active: true, load: 0 },
          { id: 2, kind: 'relay', x: 4, z: -2, active: true, load: 0 },
        ],
        actionLogCount: 0,
      };
      return state;
    },

    step(ticks = 1) {
      if (!state) this.init(42);
      const count = Math.max(0, Math.floor(ticks));
      for (let i = 0; i < count; i++) {
        state.tick += 1;
        const roll = (nextRngU32(state.rng) % 100) / 100;
        for (const ent of state.entities) {
          if (!ent.active) continue;
          ent.load = Math.min(100, Math.round((ent.load + 1 + roll) * 100) / 100);
        }
        state.resources.credits += state.entities.length;
        state.resources.energy = Math.max(0, state.resources.energy - 0.25 + 0.25);
      }
      return state;
    },

    dispatch(action = { type: 'noop' }) {
      if (!state) this.init(42);
      state.actionLogCount += 1;
      if (action.type === 'spawn') {
        const nextId = state.entities.length + 1;
        state.entities.push({
          id: nextId,
          kind: action.kind || 'node',
          x: Number(action.x || 0),
          z: Number(action.z || 0),
          active: true,
          load: 0,
        });
        return { ok: true };
      }
      return { ok: true };
    },

    getState() {
      if (!state) this.init(42);
      return state;
    },

    serialize() {
      return JSON.stringify(this.getState());
    },

    deserialize(rawJson) {
      state = JSON.parse(rawJson);
      return state;
    },

    getHash() {
      return hashCanonicalState(this.getState());
    },

    /**
     * Universal + domain invariants checked during Stage 1 QA.
     */
    invariants(s = this.getState()) {
      const violations = [];
      const nonFinite = findNonFiniteNumbers(s);
      for (const pathMsg of nonFinite) {
        violations.push({
          id: 'SIM-NAN-001',
          severity: 'P0',
          message: `Non-finite number detected in simulation state: ${pathMsg}`,
        });
      }
      if (typeof s.tick !== 'number' || s.tick < 0) {
        violations.push({
          id: 'SIM-TICK-001',
          severity: 'P0',
          message: `Invalid simulation tick counter: ${s.tick}`,
        });
      }
      return violations;
    },
  };
}

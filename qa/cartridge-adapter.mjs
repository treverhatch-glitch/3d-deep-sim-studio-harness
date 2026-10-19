import { createInitialState, step, hashSimState } from '../cartridges/example-sim/index.mjs';

export function createCartridgeAdapter() {
  let state = createInitialState(1337);
  return {
    name: 'example-sim',
    init(seed = 1337) {
      state = createInitialState(seed);
      return state;
    },
    step(ticks = 1, action = null) {
      for (let i = 0; i < ticks; i++) state = step(state, i === 0 ? action : null);
      return state;
    },
    dispatch(action) {
      state = step(state, action);
      return { ok: true };
    },
    getState() { return state; },
    getHash() { return hashSimState(state); },
    serialize() { return JSON.stringify(state); },
    deserialize(raw) { state = JSON.parse(raw); return state; },
    invariants(s) {
      const findings = [];
      const blob = JSON.stringify(s);
      if (blob.includes('null') && /"(credits|energy|x|z)":null/.test(blob)) {
        findings.push({ id: 'NONFINITE', severity: 'P0', message: 'null numeric field' });
      }
      function walk(v, path) {
        if (typeof v === 'number' && !Number.isFinite(v)) {
          findings.push({ id: 'NONFINITE', severity: 'P0', message: `${path} is ${v}` });
        } else if (Array.isArray(v)) v.forEach((x, i) => walk(x, `${path}[${i}]`));
        else if (v && typeof v === 'object') Object.entries(v).forEach(([k, x]) => walk(x, `${path}.${k}`));
      }
      walk(s, 'state');
      return findings;
    },
  };
}

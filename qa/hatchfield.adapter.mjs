#!/usr/bin/env node
/**
 * qa/hatchfield.adapter.mjs — Unified `?playtest=1` (`window.__hatch` / `window.__sim`) Adapter
 *
 * Bridges automated QA and agents directly to the simulation state (following the
 * Recursive Game Creator closed-loop pattern and OhMyGame open-loop critique:
 * agents inspect and step simulation state directly rather than blindly clicking GUI pixels).
 *
 * Supports:
 *   1. Browser-mounted `window.__hatch` or `window.__sim` (when running with `?playtest=1`)
 *   2. Headless Node cartridge (`cartridges/example-sim/index.mjs`)
 *   3. Exact `{ seed, tick, description, actions }` deterministic replay
 */

import {
  createInitialState,
  step,
  replayToTick,
  hashSimState,
  mountPlaytestApi,
} from '../cartridges/example-sim/index.mjs';

export { createInitialState, step, replayToTick, hashSimState, mountPlaytestApi };

/**
 * Drive either a Playwright `page` (exposing `window.__hatch` or `window.__sim`)
 * or the local Node cartridge deterministically to `{ seed, tick, actions }`.
 */
export async function runDeterministicTrajectory({
  page = null,
  seed = 42069,
  tick = 120,
  description = 'Baseline deterministic trajectory',
  actions = [],
} = {}) {
  if (page) {
    const browserResult = await page.evaluate(
      ({ s, t, act }) => {
        const api = window.__hatch || window.__sim;
        if (!api) return { mounted: false };
        if (typeof api.replay === 'function') {
          return { mounted: true, ...api.replay({ seed: s, tick: t, actions: act }) };
        }
        if (typeof api.reset === 'function') api.reset(s);
        if (typeof api.step === 'function') api.step(t);
        const st = typeof api.getState === 'function' ? api.getState() : {};
        const h = typeof api.getHash === 'function' ? api.getHash() : 'browser';
        return { mounted: true, seed: s, tick: st.tick ?? t, hash: h, state: st };
      },
      { s: seed, t: tick, act: actions }
    );
    if (browserResult && browserResult.mounted) {
      return { mode: 'browser-window-api', description, ...browserResult };
    }
  }

  // Headless Node cartridge execution (and double-run determinism verification)
  const runA = replayToTick({ seed, tick, actions });
  const runB = replayToTick({ seed, tick, actions });
  const deterministic = runA.hash === runB.hash;

  return {
    mode: 'headless-cartridge',
    description,
    deterministic,
    seed,
    tick: runA.tick,
    hash: runA.hash,
    hashVerify: runB.hash,
    state: runA.state,
  };
}

/**
 * harness/cartridge.mjs — load any cartridge by name and drive it the same way everywhere.
 *
 * Every gate, playtest, replay, golden check, balance sweep and closed loop goes through
 * this file, so a new game only has to meet the contract in cartridges/README.md:
 *
 *   cartridges/<name>/index.mjs  createInitialState(seed, tuning?) · step(state, actions|null)
 *                                optional: invariants(state) · outcome(state) · hashState(state) · TUNING
 *   cartridges/<name>/qa.mjs     optional: scenarios { name: { seed, maxTicks, actions?, policy? } }
 *                                optional: createAdapter() for a custom or browser-backed adapter
 *
 * Pick the cartridge with --cartridge <name>, STUDIO_CARTRIDGE, studio/game.json (new-game writes it),
 * or "cartridge" in studio/gates.json (the template's fallback).
 */

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from './event.mjs';
import { hash64, sha256 } from './hash.mjs';

export const CARTRIDGES_DIR = path.join(REPO_ROOT, 'cartridges');
const GATES_FILE = path.join(REPO_ROOT, 'studio', 'gates.json');
const NAME_RE = /^[A-Za-z0-9_][A-Za-z0-9_-]{0,63}$/;

/** Game cartridges (folders with index.mjs). Folders starting with _ or . are templates, not games. */
export function listCartridges() {
  if (!fs.existsSync(CARTRIDGES_DIR)) return [];
  return fs
    .readdirSync(CARTRIDGES_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !/^[_.]/.test(d.name) && fs.existsSync(path.join(CARTRIDGES_DIR, d.name, 'index.mjs')))
    .map((d) => d.name)
    .sort();
}

/** The game this studio is building: studio/game.json, written by new-game (never frozen in a test run). */
export const GAME_FILE = path.join(REPO_ROOT, 'studio', 'game.json');
export function activeCartridge() {
  if (process.env.STUDIO_CARTRIDGE) return { name: process.env.STUDIO_CARTRIDGE, from: 'STUDIO_CARTRIDGE' };
  try {
    const g = JSON.parse(fs.readFileSync(GAME_FILE, 'utf8'));
    if (g.cartridge) return { name: g.cartridge, from: 'studio/game.json' };
  } catch {
    // no game file yet
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(GATES_FILE, 'utf8'));
    if (cfg.cartridge) return { name: cfg.cartridge, from: 'studio/gates.json' };
  } catch {
    // no config
  }
  const first = listCartridges()[0] || null;
  return { name: first, from: first ? 'first cartridge' : null };
}
export const isTemplateCartridge = (name) => !name || name === 'example-sim' || /^[_.]/.test(name);

export function defaultCartridgeName() {
  if (process.env.STUDIO_CARTRIDGE) return process.env.STUDIO_CARTRIDGE;
  try {
    const g = JSON.parse(fs.readFileSync(GAME_FILE, 'utf8'));
    if (g.cartridge) return g.cartridge;
  } catch {
    // no game file yet
  }
  try {
    const cfg = JSON.parse(fs.readFileSync(GATES_FILE, 'utf8'));
    if (cfg.cartridge) return cfg.cartridge;
  } catch {
    // no config: fall through
  }
  return listCartridges()[0] || null;
}

export function cartridgeFromArgv(argv = process.argv.slice(2)) {
  const i = argv.indexOf('--cartridge');
  if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1];
  return defaultCartridgeName();
}

function nonFinite(value, at = 'state', out = []) {
  if (out.length >= 5) return out;
  if (typeof value === 'number' && !Number.isFinite(value)) out.push(`${at} is ${value}`);
  else if (Array.isArray(value)) value.forEach((v, i) => nonFinite(v, `${at}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) nonFinite(v, `${at}.${k}`, out);
  return out;
}

function normalizeFindings(list, state) {
  const out = (Array.isArray(list) ? list : []).map((f) => ({
    id: String(f.id || 'INVARIANT'),
    severity: f.severity || 'P1',
    summary: String(f.summary || f.message || f.id || 'invariant failed'),
    tick: f.tick ?? state?.tick ?? null,
  }));
  for (const where of nonFinite(state)) {
    out.push({ id: 'NONFINITE', severity: 'P0', summary: where, tick: state?.tick ?? null });
  }
  return out;
}

/** Group [{ tick, action }] (or bare actions carrying .tick) into Map<tick, action[]>. */
export function groupActions(actions = []) {
  const byTick = new Map();
  for (const entry of actions || []) {
    if (!entry || typeof entry.tick !== 'number') continue;
    const action = entry.action ?? entry;
    const list = byTick.get(entry.tick) || [];
    list.push(action);
    byTick.set(entry.tick, list);
  }
  return byTick;
}

export async function loadCartridge(name = defaultCartridgeName()) {
  if (!name) throw new Error('No cartridge found. Create one with: npm run new-game <name>');
  if (!NAME_RE.test(name)) throw new Error(`Bad cartridge name "${name}"`);
  const dir = path.join(CARTRIDGES_DIR, name);
  const indexFile = path.join(dir, 'index.mjs');
  if (!fs.existsSync(indexFile)) throw new Error(`cartridges/${name}/index.mjs not found`);
  const mod = await import(pathToFileURL(indexFile).href);
  for (const fn of ['createInitialState', 'step']) {
    if (typeof mod[fn] !== 'function') throw new Error(`cartridges/${name}/index.mjs must export ${fn}()`);
  }
  const qaFile = path.join(dir, 'qa.mjs');
  const qa = fs.existsSync(qaFile) ? await import(pathToFileURL(qaFile).href) : {};
  const hashFn = mod.hashState || mod.hashSimState || hash64;
  const tuning = mod.TUNING ? { ...mod.TUNING } : {};

  const cart = {
    name,
    dir,
    tuning,
    hasTuning: Object.keys(tuning).length > 0,
    scenarios: qa.scenarios || {},
    browser: qa.browser || null,
    // 2.30b (J4): what the sim can do; each must be bound to input and shown in the browser build.
    simFeatures: Array.isArray(qa.simFeatures) ? qa.simFeatures : [],
    init: (seed, overrides) => mod.createInitialState(Number(seed) >>> 0, overrides ? { ...tuning, ...overrides } : undefined),
    step: (state, actions) => mod.step(state, actions && actions.length ? actions : null),
    invariants: (state) => normalizeFindings(mod.invariants ? mod.invariants(state) : [], state),
    hash: (state) => hashFn(state),
    // Verification hash: always the harness's SHA-256 of the canonical state, whatever the cartridge's display hash is.
    sha256: (state) => sha256(state),
    outcome: (state) => (mod.outcome ? mod.outcome(state) : state?.won ? 'won' : state?.lost ? 'lost' : null),
  };
  cart.createAdapter = () => (typeof qa.createAdapter === 'function' ? fillAdapter(qa.createAdapter(), cart) : makeAdapter(cart));
  return cart;
}

/** One deterministic run: seed + actions to `tick`. Stops at the first tick that throws or breaks an invariant. */
export function replay(cart, { seed = 1, tick = 100, actions = [], tuning } = {}) {
  let state = cart.init(seed, tuning);
  const byTick = groupActions(actions);
  let failingTick = null;
  let findings = [];
  let ticksRun = 0;
  for (let t = 1; t <= tick; t++) {
    try {
      state = cart.step(state, byTick.get(t) || null);
    } catch (err) {
      failingTick = t;
      findings = [{ id: 'STEP_THREW', severity: 'P0', summary: String(err?.message || err), tick: t }];
      break;
    }
    ticksRun = t;
    const found = cart.invariants(state);
    if (found.length) {
      failingTick = t;
      findings = found.map((f) => ({ ...f, tick: t }));
      break;
    }
  }
  return { cartridge: cart.name, seed, tick, ticksRun, failingTick, findings, outcome: cart.outcome(state), hash: cart.hash(state), sha256: cart.sha256(state), state };
}

/** Play a named scenario from qa.mjs (scripted actions and/or a pure policy) until won, lost or maxTicks. */
export function runScenario(cart, scenarioName, { seed, tuning } = {}) {
  const sc = typeof scenarioName === 'string' ? cart.scenarios[scenarioName] : scenarioName;
  if (!sc) throw new Error(`cartridge ${cart.name} has no scenario "${scenarioName}" in qa.mjs`);
  const runSeed = seed ?? sc.seed ?? 1;
  const maxTicks = sc.maxTicks ?? 1000;
  const scripted = groupActions(sc.actions || []);
  let state = cart.init(runSeed, tuning);
  const actions = [];
  let failingTick = null;
  let findings = [];
  let outcome = null;
  let ticksRun = 0;
  for (let t = 1; t <= maxTicks; t++) {
    const acts = [...(scripted.get(t) || [])];
    if (typeof sc.policy === 'function') {
      const extra = sc.policy(state, t);
      if (extra) acts.push(...(Array.isArray(extra) ? extra : [extra]));
    }
    for (const action of acts) actions.push({ tick: t, action });
    try {
      state = cart.step(state, acts);
    } catch (err) {
      failingTick = t;
      findings = [{ id: 'STEP_THREW', severity: 'P0', summary: String(err?.message || err), tick: t }];
      break;
    }
    ticksRun = t;
    const found = cart.invariants(state);
    if (found.length) {
      failingTick = t;
      findings = found.map((f) => ({ ...f, tick: t }));
      break;
    }
    outcome = cart.outcome(state);
    if (outcome) break;
  }
  return {
    cartridge: cart.name,
    scenario: typeof scenarioName === 'string' ? scenarioName : sc.name || 'inline',
    seed: runSeed,
    ticksRun,
    outcome,
    failingTick,
    findings,
    actions,
    // The whole run, not just where it ended: the actions the policy chose, tick by tick.
    actionsSha256: sha256(actions),
    hash: cart.hash(state),
    sha256: cart.sha256(state),
    state,
  };
}

function makeAdapter(cart) {
  let state = cart.init(1);
  return fillAdapter(
    {
      name: cart.name,
      init(seed = 1, tuning) {
        state = cart.init(seed, tuning);
        return state;
      },
      step(ticks = 1, action = null) {
        const first = action == null ? null : Array.isArray(action) ? action : [action];
        for (let i = 0; i < ticks; i++) state = cart.step(state, i === 0 ? first : null);
        return state;
      },
      getState: () => state,
      deserialize(raw) {
        state = JSON.parse(raw);
        return state;
      },
    },
    cart
  );
}

/** Fill in whatever a custom adapter leaves out, using the cartridge itself. */
function fillAdapter(adapter, cart) {
  const a = adapter;
  a.name = a.name || cart.name;
  a.dispatch = a.dispatch || ((action) => a.step(1, action));
  a.getHash = a.getHash || (() => cart.hash(a.getState()));
  a.serialize = a.serialize || (() => JSON.stringify(a.getState()));
  const own = a.invariants;
  a.invariants = (s) => {
    const base = cart.invariants(s);
    if (typeof own !== 'function') return base;
    const extra = normalizeFindings(own(s), {}).filter((f) => f.id !== 'NONFINITE');
    return [...base, ...extra];
  };
  return a;
}

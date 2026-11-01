#!/usr/bin/env node
/**
 * qa/fuzz.mjs — 2.66.0: generated play for every game cartridge, failures shrunk to a short repro. Advisory (not a gate).
 *
 *   npm run fuzz [-- --cartridge <name>] [--seeds N] [--ticks N] [--json]
 *   npm run fuzz -- --check                 read-only: no files, events or tasks; exit 1 on a finding (the soak-tier form)
 *   npm run fuzz -- --replay .studio/fuzz/findings/<id>.json      replay one finding (exit 1 while it still fails)
 *   npm run fuzz -- file <id> [--by <name>]                       file one suggested finding as a bug task now
 *
 * Per cartridge, seeded runs (STUDIO_FUZZ_SEEDS, default 20; STUDIO_FUZZ_TICKS, default 500; or "seeds"/"ticks" in
 * studio/fuzz.json). Actions come from the cartridge's optional `actions(state, rand)` export (qa.mjs, else index.mjs);
 * without it, a generic generator from its `actionTypes` declaration; with neither the cartridge is skipped with a note.
 * Each tick, with chance "rate" (0.25), the generator is asked for an action; everything played is recorded.
 * Checks: invariants() and a throwing step() every tick; every "saveEvery" (50) ticks a save/load round trip (the state
 * through JSON.stringify/parse must step to the same SHA-256 as the live state); determinism (the recorded run played
 * again from the same seed ends on the same SHA-256, and a step taken twice from one state agrees).
 * A failure is shrunk (ddmin over the recorded actions) and written to .studio/fuzz/findings/<id>.json in the
 * regression format (cartridge, seed, tick, actions), so a fixer can copy it into qa/regressions/. The id hashes the
 * cartridge, the check and the shrunk actions' types, so reruns update the same file instead of adding one.
 *
 * Filing (hands-off with a shadow week). studio/fuzz.json "mode":
 *   "suggest" (default)  new findings go to .studio/fuzz/suggestions.md and one fuzz.finding event (the daily digest
 *                        lists them); nothing is filed.
 *   "file"               one bug task per new finding id through the board (task.mjs addTask), never twice for an id.
 * "autoFileAfter": "<ISO date>" switches "suggest" to filing from that date. The first run writes it as first run + 7
 * days when it is absent; null keeps suggesting for good. studio/fuzz.ignore.json ([{ id, why }]) lists findings that
 * are intended behaviour: never suggested or filed (an entry with no why is not honoured).
 * Seeded RNG only (Mulberry32); no wall clock decides anything a run plays.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, readRecentEvents } from '../harness/event.mjs';
import { groupActions, listCartridges, loadCartridge } from '../harness/cartridge.mjs';
import { sha256 } from '../harness/hash.mjs';
import { writeAtomic } from '../harness/fsafe.mjs';

export const CONFIG_REL = 'studio/fuzz.json';
export const IGNORE_REL = 'studio/fuzz.ignore.json';
export const FUZZ_DIR_REL = '.studio/fuzz';
export const SHADOW_DAYS = 7;
export const DEFAULTS = Object.freeze({ mode: 'suggest', seeds: 20, ticks: 500, saveEvery: 50, rate: 0.25, shrinkBudget: 2000 });
const DAY = 86400000;
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const posInt = (...vals) => { for (const v of vals) { if (v === undefined || v === null || v === '') continue; const n = Number(v); if (Number.isFinite(n) && n >= 0) return Math.floor(n); } return 0; };
const rel = (root, f) => path.relative(root, f).replace(/\\/g, '/');

// ---------- config ----------

/** studio/fuzz.json with its defaults; env (STUDIO_FUZZ_SEEDS / STUDIO_FUZZ_TICKS) beats the file, flags beat env. */
export function readFuzzConfig({ root = REPO_ROOT, env = process.env, flags = {} } = {}) {
  const raw = readJson(path.join(root, CONFIG_REL)) || {};
  const rate = Number(flags.rate ?? raw.rate);
  return {
    raw,
    mode: raw.mode === 'file' ? 'file' : 'suggest',
    autoFileAfter: raw.autoFileAfter,
    seeds: posInt(flags.seeds, env.STUDIO_FUZZ_SEEDS, raw.seeds, DEFAULTS.seeds),
    ticks: posInt(flags.ticks, env.STUDIO_FUZZ_TICKS, raw.ticks, DEFAULTS.ticks),
    saveEvery: posInt(flags.saveEvery, raw.saveEvery, DEFAULTS.saveEvery),
    rate: Number.isFinite(rate) && rate > 0 && rate <= 1 ? rate : DEFAULTS.rate,
    shrinkBudget: posInt(raw.shrinkBudget, DEFAULTS.shrinkBudget),
    cartridges: Array.isArray(raw.cartridges) ? raw.cartridges.map(String) : null,
  };
}

/** suggest or file, and why. autoFileAfter in the past turns suggest into file; null or absent never does. */
export function effectiveMode(cfg, now = Date.now()) {
  if (cfg.mode === 'file') return { mode: 'file', why: `${CONFIG_REL} says "mode": "file"` };
  const at = typeof cfg.autoFileAfter === 'string' ? Date.parse(cfg.autoFileAfter) : NaN;
  if (Number.isFinite(at) && now >= at) return { mode: 'file', why: `the shadow week ended (autoFileAfter ${cfg.autoFileAfter})` };
  return { mode: 'suggest', why: Number.isFinite(at) ? `suggestions only until ${cfg.autoFileAfter} (autoFileAfter)` : `suggestions only (${CONFIG_REL} has no autoFileAfter date)` };
}

/** The first run starts the shadow week: autoFileAfter = now + 7 days, written only when the key is absent. */
export function startShadowWeek({ root = REPO_ROOT, now = Date.now() } = {}) {
  const file = path.join(root, CONFIG_REL);
  const raw = readJson(file) || { mode: DEFAULTS.mode };
  if (Object.prototype.hasOwnProperty.call(raw, 'autoFileAfter')) return null;
  raw.autoFileAfter = new Date(now + SHADOW_DAYS * DAY).toISOString();
  writeAtomic(file, `${JSON.stringify(raw, null, 2)}\n`);
  return raw.autoFileAfter;
}

/** studio/fuzz.ignore.json: { ids: Map(id -> why), unreasoned: [id] }. Accepts [{id, why}] or { ignore: [...] }. */
export function readIgnore(root = REPO_ROOT) {
  const j = readJson(path.join(root, IGNORE_REL));
  const list = Array.isArray(j) ? j : Array.isArray(j?.ignore) ? j.ignore : [];
  const ids = new Map();
  const unreasoned = [];
  for (const e of list) {
    if (!e?.id) continue;
    if (typeof e.why === 'string' && e.why.trim()) ids.set(String(e.id), e.why.trim());
    else unreasoned.push(String(e.id));
  }
  return { ids, unreasoned };
}

// ---------- seeded play ----------

/** Mulberry32 as a function returning [0, 1), with int(n) and pick(list) helpers for actions(). */
export function makeRand(seed) {
  let a = seed >>> 0;
  const rand = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  rand.int = (n) => Math.floor(rand() * Math.max(0, Math.floor(n)));
  rand.pick = (list) => (list && list.length ? list[rand.int(list.length)] : undefined);
  return rand;
}
const actionSeed = (seed) => (Math.imul(seed >>> 0, 2654435761) ^ 0x9e3779b9) >>> 0;

/** A generator from an actionTypes declaration: 'name' or { type, field: [choices] | { min, max } | constant }. */
export function generatorFromTypes(types) {
  const specs = (Array.isArray(types) ? types : []).map((t) => (typeof t === 'string' ? { type: t } : t)).filter((t) => t && typeof t.type === 'string');
  if (!specs.length) return null;
  return (_state, rand) => {
    const spec = specs[rand.int(specs.length)];
    const out = {};
    for (const [k, v] of Object.entries(spec)) {
      if (Array.isArray(v)) {
        const c = v[rand.int(v.length)];
        if (c !== null && c !== undefined) out[k] = c;
      } else if (v && typeof v === 'object' && Number.isFinite(v.min) && Number.isFinite(v.max)) out[k] = Math.floor(v.min) + rand.int(Math.floor(v.max) - Math.floor(v.min) + 1);
      else out[k] = v;
    }
    return out;
  };
}

/** Where a cartridge's actions come from: { gen, source } or { gen: null, why }. */
export function actionSource(cart) {
  if (typeof cart.actions === 'function') return { gen: cart.actions, source: 'actions()' };
  const g = generatorFromTypes(cart.actionTypes);
  if (g) return { gen: g, source: 'actionTypes' };
  return { gen: null, why: `no actions(state, rand) export and no actionTypes declared (cartridges/README.md, "Fuzz")` };
}

const copy = (s) => { try { return structuredClone(s); } catch { return s; } };
const stepOrThrow = (cart, state, acts) => { try { return { state: cart.step(state, copy(acts)) }; } catch (err) { return { error: String(err?.message || err) }; } };
const hashOf = (cart, s) => { try { return cart.sha256(s); } catch { return null; } };

/** The save/load round trip before tick t's step: the JSON copy must step to the live state's hash. */
function saveLoadCheck(cart, state, acts, t) {
  let text;
  try { text = JSON.stringify(state); } catch (err) { return { check: 'save-load', code: 'SAVE_THREW', severity: 'P1', tick: t, summary: `JSON.stringify(state) threw: ${String(err?.message || err)}` }; }
  const live = stepOrThrow(cart, copy(state), acts);
  const loaded = stepOrThrow(cart, JSON.parse(text), acts);
  const a = live.error ? `threw: ${live.error}` : hashOf(cart, live.state);
  const b = loaded.error ? `threw: ${loaded.error}` : hashOf(cart, loaded.state);
  if (a === b) return null;
  // Which one: the same state stepped twice must agree before a save/load difference means anything.
  const again = stepOrThrow(cart, copy(state), acts);
  const a2 = again.error ? `threw: ${again.error}` : hashOf(cart, again.state);
  if (a2 !== a) return { check: 'determinism', code: 'NONDETERMINISTIC', severity: 'P0', tick: t, summary: `the same state and actions stepped twice at tick ${t} gave different states (hidden state outside the sim state: a module-level variable, the clock, Math.random)` };
  return { check: 'save-load', code: 'SAVE_LOAD_DIVERGED', severity: 'P1', tick: t, summary: `a state saved and loaded through JSON at tick ${t} steps differently from the live one (${String(a).slice(0, 12)} vs ${String(b).slice(0, 12)}): something in the state does not survive JSON (undefined, Map/Set, NaN, a class instance)` };
}

/**
 * One run from `seed`: generated (gen) or replayed (list). Returns { finding, sha256, ticksRun, list, outcome }.
 * Stops at the first finding, or when the game is won or lost.
 */
export function play(cart, { seed, ticks, saveEvery = 0, rate = DEFAULTS.rate, gen = null, list = null }) {
  const byTick = list ? groupActions(list) : null;
  const rand = gen ? makeRand(actionSeed(seed)) : null;
  const rec = [];
  let state;
  try { state = cart.init(seed); } catch (err) { return { finding: { check: 'threw', code: 'INIT_THREW', severity: 'P0', tick: 0, summary: String(err?.message || err) }, list: rec, ticksRun: 0 }; }
  let ticksRun = 0;
  let outcome = null;
  for (let t = 1; t <= ticks; t++) {
    let acts = [];
    if (byTick) acts = byTick.get(t) || [];
    else if (gen && rand() < rate) {
      let got = null;
      try { got = gen(copy(state), rand); } catch (err) { return { finding: { check: 'threw', code: 'ACTIONS_THREW', severity: 'P2', tick: t, summary: `the cartridge's action generator threw: ${String(err?.message || err)}` }, list: rec, ticksRun }; }
      acts = (Array.isArray(got) ? got : got ? [got] : []).filter((a) => a && typeof a === 'object');
    }
    for (const action of acts) rec.push({ tick: t, action });
    if (saveEvery && t % saveEvery === 0) {
      const f = saveLoadCheck(cart, state, acts, t);
      if (f) return { finding: f, list: rec, ticksRun };
    }
    const r = stepOrThrow(cart, state, acts);
    if (r.error) return { finding: { check: 'threw', code: 'STEP_THREW', severity: 'P0', tick: t, summary: r.error }, list: rec, ticksRun };
    state = r.state;
    ticksRun = t;
    let found = [];
    try { found = cart.invariants(state); } catch (err) { found = [{ id: 'INVARIANTS_THREW', severity: 'P0', summary: String(err?.message || err) }]; }
    if (found.length) return { finding: { check: 'invariant', code: found[0].id, severity: found[0].severity || 'P1', tick: t, summary: found[0].summary }, list: rec, ticksRun };
    outcome = cart.outcome(state);
    if (outcome) break;
  }
  return { finding: null, sha256: hashOf(cart, state), list: rec, ticksRun, outcome };
}

/** Replay a fixed action list: its own finding, or a determinism finding when two replays end apart. */
export function reproduce(cart, list, opts) {
  const a = play(cart, { ...opts, gen: null, list });
  if (a.finding) return a.finding;
  const b = play(cart, { ...opts, gen: null, list });
  if (b.finding) return b.finding;
  if (a.sha256 !== b.sha256) return { check: 'determinism', code: 'NONDETERMINISTIC', severity: 'P0', tick: a.ticksRun, summary: `the same seed and actions played twice ended on different states (${String(a.sha256).slice(0, 12)} vs ${String(b.sha256).slice(0, 12)}): hidden state outside the sim state` };
  return null;
}

const sameFinding = (f, want) => Boolean(f) && f.check === want.check && f.code === want.code;

/** ddmin over the action list, keeping the same check and code. `budget` caps the replays. */
export function shrink(cart, list, want, opts, budget = DEFAULTS.shrinkBudget) {
  let calls = 0;
  const fails = (l) => { calls += 1; return sameFinding(reproduce(cart, l, opts), want); };
  if (fails([])) return { list: [], calls };
  let cur = list;
  let n = 2;
  while (cur.length >= 2 && calls < budget) {
    const size = Math.ceil(cur.length / n);
    const chunks = [];
    for (let i = 0; i < cur.length; i += size) chunks.push([i, Math.min(cur.length, i + size)]);
    let reduced = false;
    for (const [s, e] of chunks) {
      if (calls >= budget) break;
      const subset = cur.slice(s, e);
      if (subset.length < cur.length && fails(subset)) { cur = subset; n = 2; reduced = true; break; }
    }
    if (!reduced) {
      for (const [s, e] of chunks) {
        if (calls >= budget) break;
        const complement = [...cur.slice(0, s), ...cur.slice(e)];
        if (complement.length && complement.length < cur.length && fails(complement)) { cur = complement; n = Math.max(n - 1, 2); reduced = true; break; }
      }
    }
    if (!reduced) {
      if (n >= cur.length) break;
      n = Math.min(n * 2, cur.length);
    }
  }
  return { list: cur, calls };
}

/** The shrunk actions' signature: their types in order (ticks and values left out, so another seed finds the same id). */
export const signatureOf = (list) => (list || []).map((e) => String(e?.action?.type ?? e?.type ?? '?')).join('>');
export const findingId = (cartridge, f, list) => `F-${sha256([cartridge, f.check, f.code, signatureOf(list)]).slice(0, 12)}`;

/** Fuzz one cartridge: { name, skipped?, why?, runs, findings: [...] }. Pure: writes nothing. */
export function fuzzCartridge(cart, cfg) {
  const src = actionSource(cart);
  if (!src.gen) return { name: cart.name, skipped: true, why: src.why, runs: 0, findings: [] };
  const opts = { ticks: cfg.ticks, saveEvery: cfg.saveEvery, rate: cfg.rate };
  const byKey = new Map();
  let runs = 0;
  for (let i = 0; i < cfg.seeds; i++) {
    const seed = i + 1;
    runs += 1;
    const a = play(cart, { ...opts, seed, gen: src.gen });
    let f = a.finding;
    if (!f) {
      const b = play(cart, { ...opts, seed, list: a.list });
      if (b.finding) f = b.finding;
      else if (b.sha256 !== a.sha256) f = { check: 'determinism', code: 'NONDETERMINISTIC', severity: 'P0', tick: a.ticksRun, summary: `seed ${seed} played twice with the same actions ended on different states (${String(a.sha256).slice(0, 12)} vs ${String(b.sha256).slice(0, 12)}): hidden state outside the sim state` };
    }
    if (!f) continue;
    const key = `${f.check}|${f.code}`;
    if (byKey.has(key)) { byKey.get(key).alsoSeeds.push(seed); continue; }
    const s = shrink(cart, a.list, f, { ...opts, seed }, cfg.shrinkBudget);
    const last = reproduce(cart, s.list, { ...opts, seed }) || f;
    const failTick = last.tick ?? f.tick;
    byKey.set(key, {
      id: findingId(cart.name, f, s.list),
      cartridge: cart.name,
      check: f.check,
      code: f.code,
      severity: last.severity || f.severity || 'P1',
      summary: last.summary || f.summary,
      seed,
      tick: failTick,
      ticks: cfg.ticks,
      saveEvery: cfg.saveEvery,
      originalActions: a.list.length,
      actions: s.list,
      shrinkReplays: s.calls,
      alsoSeeds: [],
    });
  }
  return { name: cart.name, source: src.source, runs, findings: [...byKey.values()] };
}

// ---------- recording, suggesting, filing ----------

const fuzzDir = (root) => path.join(root, FUZZ_DIR_REL);
export const findingFile = (id, root = REPO_ROOT) => path.join(fuzzDir(root), 'findings', `${id}.json`);
export const replayCommand = (id) => `npm run fuzz -- --replay ${FUZZ_DIR_REL}/findings/${id}.json`;

/** Write or update .studio/fuzz/findings/<id>.json. Returns { record, isNew }. */
export function recordFinding(f, { root = REPO_ROOT, now = Date.now() } = {}) {
  const file = findingFile(f.id, root);
  const old = readJson(file);
  const at = new Date(now).toISOString();
  const keepOld = old && Array.isArray(old.actions) && old.actions.length <= f.actions.length;
  const { alsoSeeds, ...rest } = f;
  const record = {
    ...rest,
    ...(keepOld ? { seed: old.seed, tick: old.tick, actions: old.actions, originalActions: old.originalActions } : {}),
    // The regression format: cartridge, seed, tick and actions replay with harness/replay.mjs and qa/check-regressions.mjs.
    description: `${f.check} ${f.code}: ${f.summary}`.slice(0, 300),
    replay: replayCommand(f.id),
    firstSeen: old?.firstSeen || at,
    lastSeen: at,
    seenRuns: (old?.seenRuns || 0) + 1,
    ...(old?.task ? { task: old.task } : {}),
    ...(old?.suggested ? { suggested: old.suggested } : {}),
  };
  writeAtomic(file, `${JSON.stringify(record, null, 2)}\n`);
  return { record, isNew: !old };
}

const describeActions = (list) => (list.length ? list.map((e) => `tick ${e.tick} ${JSON.stringify(e.action)}`).join('; ') : 'none (the seed alone fails)');

/** Append one finding to .studio/fuzz/suggestions.md (once per id). */
export function suggestFinding(record, { root = REPO_ROOT, now = Date.now() } = {}) {
  const file = path.join(fuzzDir(root), 'suggestions.md');
  const old = fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '# Fuzz suggestions\n\nFindings from `npm run fuzz` not filed yet (shadow week, or "mode": "suggest" in studio/fuzz.json). File one now: `npm run fuzz -- file <id> --by <you>`. Intended behaviour: add `{ "id": "<id>", "why": "…" }` to studio/fuzz.ignore.json.\n';
  if (old.includes(`## ${record.id} `)) return false;
  const text = `${old.replace(/\n*$/, '\n')}\n## ${record.id} (${new Date(now).toISOString().slice(0, 10)}) ${record.cartridge}: ${record.check} ${record.code}\n- ${record.summary}\n- seed ${record.seed}, fails at tick ${record.tick}, ${record.actions.length} action(s) after shrinking (from ${record.originalActions}): ${describeActions(record.actions)}\n- replay: \`${record.replay}\`\n`;
  writeAtomic(file, text);
  return true;
}

/** Was this finding id ever filed? The record, then the event log (lanes share it). */
export function filedTask(id, { root = REPO_ROOT, events = null } = {}) {
  const r = readJson(findingFile(id, root));
  if (r?.task) return r.task;
  const ev = events || readRecentEvents(20000);
  const hit = ev.find((e) => e.type === 'task.added' && e.meta?.fuzz === id);
  return hit ? hit.task || 'filed' : null;
}

export const taskTitle = (r) => `Fix fuzz finding ${r.id}: ${r.cartridge} ${r.code} after ${r.actions.length} action${r.actions.length === 1 ? '' : 's'} (seed ${r.seed}; ${FUZZ_DIR_REL}/findings/${r.id}.json)`.slice(0, 180);

/** File one bug task for a finding through the board, never twice for an id. { task, already } or { error }. */
export async function fileFinding(record, { root = REPO_ROOT, by = 'fuzz' } = {}) {
  const prior = filedTask(record.id, { root });
  if (prior) return { task: prior, already: true };
  const { addTask } = await import('../harness/task.mjs');
  const pr = /^P[0-2]$/.test(record.severity) ? record.severity : 'P1';
  const t = addTask({ title: taskTitle(record), role: 'builder', priority: pr, agent: by, meta: { origin: 'agent', fuzz: record.id, cartridge: record.cartridge, check: record.check, code: record.code, seed: record.seed, finding: `${FUZZ_DIR_REL}/findings/${record.id}.json` } });
  if (!t || t.error) return { error: t?.message || 'not queued' };
  const id = t.id || (t.proposed ? `proposed ${t.proposed}` : 'proposed');
  const file = findingFile(record.id, root);
  const cur = readJson(file) || record;
  writeAtomic(file, `${JSON.stringify({ ...cur, task: id }, null, 2)}\n`);
  return { task: id, already: false, duplicate: Boolean(t.duplicate) };
}

/**
 * The whole pass: fuzz every cartridge, record findings, then suggest or file each new one (ignored ids skipped).
 * check: true writes nothing (no findings files, config, events or tasks).
 */
export async function runFuzz({ root = REPO_ROOT, env = process.env, flags = {}, names = null, check = false, now = Date.now() } = {}) {
  const cfg = readFuzzConfig({ root, env, flags });
  let shadowStarted = null;
  if (!check && cfg.autoFileAfter === undefined) {
    let lane = false;
    try { lane = (await import('../harness/worktree.mjs')).inLaneCopy(); } catch { lane = false; }
    if (!lane) { shadowStarted = startShadowWeek({ root, now }); cfg.autoFileAfter = shadowStarted; }
  }
  const mode = effectiveMode(cfg, now);
  const ignore = readIgnore(root);
  const wanted = names || cfg.cartridges || listCartridges();
  const results = [];
  for (const name of wanted) {
    let cart;
    try { cart = await loadCartridge(name); } catch (err) { results.push({ name, skipped: true, why: `could not load: ${String(err?.message || err)}`, runs: 0, findings: [] }); continue; }
    const t0 = performance.now();
    const r = fuzzCartridge(cart, cfg);
    r.ms = Math.round(performance.now() - t0);
    for (const f of r.findings) {
      f.ignored = ignore.ids.has(f.id) ? ignore.ids.get(f.id) : null;
      if (check) continue;
      const { record, isNew } = recordFinding(f, { root, now });
      f.isNew = isNew;
      f.replay = record.replay;
      if (f.ignored) continue;
      if (mode.mode === 'file') {
        const filed = await fileFinding(record, { root });
        f.task = filed.task || null;
        f.fileError = filed.error || null;
        if (!filed.already && filed.task) emitEvent({ type: 'fuzz.finding', agent: 'fuzz', status: 'warn', task: String(filed.task).startsWith('T-') ? filed.task : undefined, msg: `Fuzz ${record.cartridge}: ${record.check} ${record.code} after ${record.actions.length} action(s), seed ${record.seed}: filed ${filed.task} (${record.id})`, meta: { id: record.id, cartridge: record.cartridge, check: record.check, code: record.code, seed: record.seed, actions: record.actions.length, mode: 'file', task: filed.task } });
      } else if (!record.suggested) {
        suggestFinding(record, { root, now });
        const file = findingFile(record.id, root);
        writeAtomic(file, `${JSON.stringify({ ...record, suggested: new Date(now).toISOString() }, null, 2)}\n`);
        f.suggested = true;
        emitEvent({ type: 'fuzz.finding', agent: 'fuzz', status: 'warn', msg: `Fuzz ${record.cartridge}: ${record.check} ${record.code} after ${record.actions.length} action(s), seed ${record.seed}: suggested, not filed (${mode.why}) (${record.id})`, meta: { id: record.id, cartridge: record.cartridge, check: record.check, code: record.code, seed: record.seed, actions: record.actions.length, mode: 'suggest', until: typeof cfg.autoFileAfter === 'string' ? cfg.autoFileAfter : null } });
      }
    }
    results.push(r);
  }
  return { mode: mode.mode, why: mode.why, shadowStarted, autoFileAfter: cfg.autoFileAfter ?? null, seeds: cfg.seeds, ticks: cfg.ticks, saveEvery: cfg.saveEvery, unreasonedIgnores: ignore.unreasoned, results };
}

/** Replay one findings file: { reproduced, finding }. */
export async function replayFinding(file, { root = REPO_ROOT } = {}) {
  const spec = readJson(path.isAbsolute(file) ? file : path.join(root, file));
  if (!spec?.cartridge) throw new Error(`${file}: not a fuzz finding (no cartridge)`);
  const cart = await loadCartridge(spec.cartridge);
  const opts = { seed: Number(spec.seed), ticks: Number(spec.ticks || spec.tick || DEFAULTS.ticks), saveEvery: Number(spec.saveEvery || 0), rate: DEFAULTS.rate };
  const f = reproduce(cart, spec.actions || [], opts);
  return { reproduced: sameFinding(f, spec), finding: f, spec };
}

// ---------- CLI ----------

function parseFlags(argv) {
  const flags = {};
  const val = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : undefined; };
  for (const [k, name] of [['--seeds', 'seeds'], ['--ticks', 'ticks'], ['--save-every', 'saveEvery'], ['--rate', 'rate']]) if (val(k) !== undefined) flags[name] = val(k);
  return { flags, cartridge: val('--cartridge'), replay: val('--replay'), by: val('--by'), json: argv.includes('--json'), check: argv.includes('--check') };
}

async function main(argv) {
  const o = parseFlags(argv);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^#!.*\n\/\*\*\n?/, '').replace(/^ \* ?/gm, ''));
    return 0;
  }
  if (o.replay) {
    const r = await replayFinding(o.replay);
    if (o.json) console.log(JSON.stringify({ reproduced: r.reproduced, finding: r.finding }));
    else console.log(r.reproduced ? `[fuzz] still fails: ${r.finding.check} ${r.finding.code} at tick ${r.finding.tick}: ${r.finding.summary}` : `[fuzz] no longer fails the way it did (${r.spec.check} ${r.spec.code})${r.finding ? `; now: ${r.finding.check} ${r.finding.code}` : ''}`);
    return r.reproduced ? 1 : 0;
  }
  if (argv[0] === 'file') {
    const id = argv[1];
    const rec = id && readJson(findingFile(id));
    if (!rec) { console.error(`[fuzz] no finding ${id || '(give an id)'} in ${FUZZ_DIR_REL}/findings/`); return 2; }
    const r = await fileFinding(rec, { by: o.by || process.env.STUDIO_LOCK_OWNER || 'fuzz' });
    if (r.error) { console.error(`[fuzz] not filed: ${r.error}`); return 1; }
    if (!r.already) emitEvent({ type: 'fuzz.finding', agent: o.by || 'fuzz', status: 'warn', msg: `Fuzz finding ${id} filed by hand: ${r.task}`, meta: { id, cartridge: rec.cartridge, check: rec.check, code: rec.code, seed: rec.seed, actions: rec.actions.length, mode: 'file', task: r.task, byHand: true } });
    console.log(r.already ? `[fuzz] ${id} was already filed (${r.task}); not filed again` : `[fuzz] ${id} filed as ${r.task}`);
    return 0;
  }
  const res = await runFuzz({ flags: o.flags, names: o.cartridge ? [o.cartridge] : null, check: o.check });
  if (o.json) { console.log(JSON.stringify(res)); }
  else {
    if (res.shadowStarted) console.log(`[fuzz] first run: findings are suggestions until ${res.shadowStarted}, then filed as bug tasks (autoFileAfter in ${CONFIG_REL})`);
    for (const r of res.results) {
      if (r.skipped) { console.log(`[fuzz] ${r.name}: skipped, ${r.why}`); continue; }
      console.log(`[fuzz] ${r.name}: ${r.runs} seed(s) x ${res.ticks} ticks from ${r.source}, ${r.findings.length} finding(s) (${r.ms} ms)`);
      for (const f of r.findings) {
        const where = f.ignored ? `ignored (${f.ignored})` : o.check ? 'check only' : f.task ? `filed ${f.task}` : f.fileError ? `not filed: ${f.fileError}` : res.mode === 'file' ? 'filed' : 'suggested';
        console.log(`  ${f.id} ${f.check} ${f.code}: ${f.summary}\n    seed ${f.seed}, tick ${f.tick}, ${f.actions.length} action(s) (from ${f.originalActions}); ${where}${f.replay ? `; replay: ${f.replay}` : ''}`);
      }
    }
    if (res.unreasonedIgnores.length) console.log(`[fuzz] ${IGNORE_REL}: ${res.unreasonedIgnores.join(', ')} not honoured (each entry needs a "why")`);
    if (!o.check) console.log(`[fuzz] mode: ${res.mode} (${res.why}). Advisory: not a gate yet.`);
  }
  const open = res.results.flatMap((r) => r.findings).filter((f) => !f.ignored);
  return o.check && open.length ? 1 : 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exitCode = await main(process.argv.slice(2));
}

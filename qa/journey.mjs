#!/usr/bin/env node
/**
 * qa/journey.mjs — 2.78.0 (PU-55): a player-journey gate. Agent-built games often compile and pass their checks and still
 * don't play; this plays a whole journey through the game's public inputs and sets two traps for a game that only looks done.
 *
 * A journey is studio/journeys/<cartridge>/<id>.json:
 *   { id, seed, steps: [{ tick, action, args }], goal: { path, op: "eq|gte|lte|truthy", value }, saveAt, maxTicks, note }
 * "action" must be one of the cartridge's public controls (an action type the cartridge declares in actionTypes, one a real
 * input performs: qa.mjs browser.input(), or one the Game Bible's controls.json names in an "action" field). Anything else is
 * refused. For each journey:
 *   (a) play it from the seed with its inputs to maxTicks: the goal must hold;
 *   (b) no-input control: the same seed and ticks with no actions: the goal must NOT hold ("reached without playing");
 *   (c) fresh-process reopen: play to saveAt, save the state as the cartridge saves it (saveState/loadState exports, else
 *       canonical JSON), then in a NEW node process load it and continue to maxTicks: the SHA-256 state digest must equal (a)'s;
 *   (d) the sim stays inside the tick budget scripts/check-tick-budget.mjs uses (cartridge.json tickBudgetMs, else
 *       TICK_BUDGET_MS_PER_TICK, else 1 ms per tick), measured on the steps of this journey.
 * Each run (a, b, c's two halves) is its own node process, so nothing a module remembers in memory leaks between them.
 *
 * A game that isn't a cartridge gives { "command": "<runs one journey, prints one JSON line>" } instead; the line is
 * { goalMet, noInputGoalMet, digestA, digestReopen } and is judged the same way (docs/JOURNEYS.md).
 *
 *   node qa/journey.mjs [--cartridge <name>] [--json]
 * No journeys: passes with a WARN ("no journeys yet"). Exit 1 on any failure.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../harness/event.mjs';
import { canonicalJson } from '../harness/hash.mjs';
import { readJson } from '../harness/fsafe.mjs';

const SELF = fileURLToPath(import.meta.url);
const OPS = new Set(['eq', 'gte', 'lte', 'truthy']);
const MAX_TICKS_CAP = 200000;
const MARK = '@@journey@@ ';

/** Fix line per failure kind. */
export const JOURNEY_FIXES = {
  'goal-not-met': 'the journey played its inputs and the goal does not hold at maxTicks: node qa/journey.mjs shows the value it reached; fix the game so those public inputs do what the goal needs. Re-record the steps only when a sim change was intended, and say why in the commit; never loosen the goal to match a broken game',
  'no-input': 'the goal is reached without anyone playing (the same seed with no input): either the sim finishes by itself, or the goal is too easy; make the goal depend on what the player does, or fix the sim so it does not complete on its own',
  reopen: 'the state after save, a new process and load differs from the straight run: something outside the saved state changes the sim (a module-level variable or cache, a field the save drops, a field the load does not restore); keep it in the state and the save',
  'non-public-action': 'the journey names an action that is not a public control: use only what a player can do (an actionTypes entry in the cartridge\'s qa.mjs, an action qa.mjs browser.input() maps to a real key or click, or an "action" in studio/bible/controls.json); a journey never calls an internal function',
  'bad-journey': 'the journey file is malformed (the message names the field): it is { id, seed, steps: [{ tick, action, args }], goal: { path, op, value }, saveAt, maxTicks, note } or { command } (docs/JOURNEYS.md)',
  broke: 'the sim threw or broke an invariant while the journey played (the message names the tick): replay it with node harness/replay.mjs --trace and fix the sim there',
  'tick-budget': 'the sim is slower than its budget while the journey plays (tickBudgetMs in cartridges/<name>/cartridge.json, else TICK_BUDGET_MS_PER_TICK, else 1 ms): make the tick cheaper; raising the budget is a design call to hand back',
  command: 'the journey\'s command did not print one JSON line { goalMet, noInputGoalMet, digestA, digestReopen } or failed to run: run the command yourself from the repo root and fix what it prints (docs/JOURNEYS.md, "Games that are not cartridges")',
};

// ---------- pure helpers (also used by the self-test) ----------

/** Value at a JSON path such as "resources.credits" or "entities[0].x". */
export function getPath(obj, p) {
  let cur = obj;
  for (const part of String(p).split(/[.[\]]+/).filter(Boolean)) {
    if (cur === null || cur === undefined || typeof cur !== 'object') return undefined;
    cur = cur[part];
  }
  return cur;
}

/** Does the goal hold in this state? { ok, value } (value is what the path holds). */
export function evalGoal(state, goal) {
  const value = getPath(state, goal.path);
  let ok = false;
  if (goal.op === 'truthy') ok = Boolean(value);
  else if (goal.op === 'eq') ok = canonicalJson(value) === canonicalJson(goal.value);
  else if (goal.op === 'gte') ok = typeof value === 'number' && Number.isFinite(value) && value >= goal.value;
  else if (goal.op === 'lte') ok = typeof value === 'number' && Number.isFinite(value) && value <= goal.value;
  return { ok, value };
}

const isInt = (n) => Number.isInteger(n);

/** Problems in a journey object (empty = fine). A { command } journey needs only the command. */
export function validateJourney(j) {
  const bad = [];
  if (!j || typeof j !== 'object' || Array.isArray(j)) return ['the file is not a JSON object'];
  if (j.command !== undefined) {
    if (typeof j.command !== 'string' || !j.command.trim()) bad.push('"command" must be a non-empty string');
    return bad;
  }
  if (typeof j.id !== 'string' || !/^[A-Za-z0-9_][A-Za-z0-9_.-]{0,63}$/.test(j.id)) bad.push('"id" must be a short name (letters, digits, _ . -)');
  if (!Number.isFinite(j.seed)) bad.push('"seed" must be a number');
  if (!isInt(j.maxTicks) || j.maxTicks < 1 || j.maxTicks > MAX_TICKS_CAP) bad.push(`"maxTicks" must be a whole number from 1 to ${MAX_TICKS_CAP}`);
  if (!Array.isArray(j.steps)) bad.push('"steps" must be a list of { tick, action, args }');
  else j.steps.forEach((s, i) => {
    if (!s || typeof s !== 'object') return bad.push(`steps[${i}] must be an object`);
    if (!isInt(s.tick) || s.tick < 1 || (isInt(j.maxTicks) && s.tick > j.maxTicks)) bad.push(`steps[${i}].tick must be a whole number from 1 to maxTicks`);
    if (typeof s.action !== 'string' || !s.action) bad.push(`steps[${i}].action must be a control name`);
    if (s.args !== undefined && (!s.args || typeof s.args !== 'object' || Array.isArray(s.args))) bad.push(`steps[${i}].args must be an object`);
  });
  const g = j.goal;
  if (!g || typeof g !== 'object') bad.push('"goal" must be { path, op, value }');
  else {
    if (typeof g.path !== 'string' || !g.path) bad.push('goal.path must be a JSON path in the state');
    if (!OPS.has(g.op)) bad.push('goal.op must be eq, gte, lte or truthy');
    else if (g.op !== 'truthy' && g.value === undefined) bad.push(`goal.value is needed for "${g.op}"`);
    else if ((g.op === 'gte' || g.op === 'lte') && !Number.isFinite(g.value)) bad.push(`goal.value must be a number for "${g.op}"`);
  }
  if (!isInt(j.saveAt) || j.saveAt < 0 || (isInt(j.maxTicks) && j.saveAt >= j.maxTicks)) bad.push('"saveAt" must be a whole number from 0 to below maxTicks');
  return bad;
}


/** Is this action one of the cartridge's public controls? */
export function isPublicAction(cart, name, args = {}, bible = null) {
  const types = Array.isArray(cart.actionTypes) ? cart.actionTypes.map((t) => (typeof t === 'string' ? t : t?.type)) : [];
  if (types.includes(name)) return true;
  const listed = Array.isArray(bible?.controls) ? bible.controls.map((c) => c?.action) : [];
  if (listed.includes(name)) return true;
  try { if (cart.browser && typeof cart.browser.input === 'function' && cart.browser.input({ ...args, type: name })) return true; } catch { /* not an input */ }
  return false;
}

export function cartridgeBudget(root, name) {
  const v = Number(readJson(path.join(root, 'cartridges', name, 'cartridge.json'))?.tickBudgetMs);
  return Number.isFinite(v) && v > 0 ? v : null;
}

/** Judge what a { command } journey printed. Returns a list of { kind, message } failures. */
export function judgeCommandResult(r) {
  const out = [];
  if (!r || typeof r !== 'object') return [{ kind: 'command', message: 'no result' }];
  if (typeof r.goalMet !== 'boolean' || typeof r.noInputGoalMet !== 'boolean' || typeof r.digestA !== 'string' || typeof r.digestReopen !== 'string' || !r.digestA || !r.digestReopen) {
    return [{ kind: 'command', message: `the line needs goalMet (true/false), noInputGoalMet (true/false), digestA and digestReopen (non-empty text); got ${JSON.stringify(r).slice(0, 300)}` }];
  }
  if (!r.goalMet) out.push({ kind: 'goal-not-met', message: 'the played journey did not reach its goal' });
  if (r.noInputGoalMet) out.push({ kind: 'no-input', message: 'the goal is reached without playing (the same seed with no input met it)' });
  if (r.digestA !== r.digestReopen) out.push({ kind: 'reopen', message: `the state digest after a fresh-process reopen differs: ${r.digestA} vs ${r.digestReopen}` });
  return out;
}

// ---------- the worker: one run in its own node process ----------

async function work(job) {
  const { loadCartridge, groupActions } = await import('../harness/cartridge.mjs');
  const cart = await loadCartridge(job.cartridge);
  const mod = await import(pathToFileURL(path.join(cart.dir, 'index.mjs')).href);
  const save = (s) => { const t = typeof mod.saveState === 'function' ? mod.saveState(s) : canonicalJson(s); return typeof t === 'string' ? t : canonicalJson(t); };
  const load = (t) => (typeof mod.loadState === 'function' ? mod.loadState(t) : JSON.parse(t));
  const byTick = job.inputs ? groupActions((job.steps || []).map((s) => ({ tick: s.tick, action: { ...(s.args || {}), type: s.action } }))) : new Map();
  let state = job.resume != null ? load(job.resume) : cart.init(job.seed);
  const from = job.resume != null ? job.fromTick : 0;
  const play = (st, a, b) => {
    for (let t = a + 1; t <= b; t += 1) {
      try { st = cart.step(st, byTick.get(t) || null); } catch (e) { return { st, error: `tick ${t}: the sim threw: ${String(e?.message || e)}` }; }
      const found = cart.invariants(st);
      if (found.length) return { st, error: `tick ${t}: ${found[0].id} — ${found[0].summary}` };
    }
    return { st };
  };
  const r = play(state, from, job.until);
  const res = { error: r.error || null };
  state = r.st;
  if (!res.error) {
    res.digest = cart.sha256(state);
    const g = evalGoal(state, job.goal);
    res.goalMet = g.ok;
    res.goalValue = g.value === undefined ? null : g.value;
    if (job.save) res.saved = save(state);
    if (job.time) {
      let best = Infinity;
      for (let k = 0; k < 3; k += 1) {
        let st = cart.init(job.seed);
        const t0 = performance.now();
        for (let t = 1; t <= job.until; t += 1) st = cart.step(st, byTick.get(t) || null);
        best = Math.min(best, (performance.now() - t0) / job.until);
      }
      res.msPerTick = best;
    }
  }
  return res;
}

function spawnWorker(job) {
  const r = spawnSync(process.execPath, [SELF, '--worker'], { input: JSON.stringify(job), cwd: REPO_ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  const line = String(r.stdout || '').split('\n').reverse().find((l) => l.startsWith(MARK));
  if (!line) return { error: `the run produced no result (exit ${r.status}${r.error ? `, ${r.error.message}` : ''}): ${`${r.stderr || ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` };
  try { return JSON.parse(line.slice(MARK.length)); } catch { return { error: 'the run printed an unreadable result' }; }
}

// ---------- the checks ----------

function checkCartridgeJourney(name, j, cart, bible, root) {
  const fails = [];
  const infos = [];
  const add = (kind, message) => fails.push({ kind, message });
  const bad = validateJourney(j);
  if (bad.length) return { fails: [{ kind: 'bad-journey', message: bad.join('; ') }], infos };
  // Public controls only.
  for (const s of j.steps) {
    if (!isPublicAction(cart, s.action, s.args || {}, bible)) {
      add('non-public-action', `step at tick ${s.tick} names "${s.action}", which is not a public control of ${name}`);
      return { fails, infos };
    }
  }
  const base = { cartridge: name, seed: j.seed, steps: j.steps, goal: j.goal };
  // (a) played.
  const a = spawnWorker({ ...base, inputs: true, until: j.maxTicks, time: true });
  if (a.error) { add('broke', a.error); return { fails, infos }; }
  if (!a.goalMet) add('goal-not-met', `after ${j.maxTicks} ticks with its inputs, ${j.goal.path} is ${JSON.stringify(a.goalValue)} (goal: ${j.goal.op}${j.goal.op === 'truthy' ? '' : ` ${JSON.stringify(j.goal.value)}`})`);
  // (b) no-input control.
  const b = spawnWorker({ ...base, inputs: false, until: j.maxTicks });
  if (b.error) add('broke', `no-input control: ${b.error}`);
  else if (b.goalMet) add('no-input', `the goal is reached without playing: the same seed with no input has ${j.goal.path} = ${JSON.stringify(b.goalValue)} at tick ${j.maxTicks}`);
  // (c) fresh-process reopen.
  const pre = spawnWorker({ ...base, inputs: true, until: j.saveAt, save: true });
  if (pre.error) add('broke', `play to saveAt: ${pre.error}`);
  else {
    const post = spawnWorker({ ...base, inputs: true, resume: pre.saved, fromTick: j.saveAt, until: j.maxTicks });
    if (post.error) add('reopen', `the new process could not continue from the save: ${post.error}`);
    else if (post.digest !== a.digest) add('reopen', `state digest after save at tick ${j.saveAt}, a new process and load is ${String(post.digest).slice(0, 12)}…, the straight run's is ${String(a.digest).slice(0, 12)}…`);
  }
  // (d) tick budget.
  const own = cartridgeBudget(root, name);
  const budget = own ?? Number(process.env.TICK_BUDGET_MS_PER_TICK || 1);
  if (typeof a.msPerTick === 'number') {
    if (a.msPerTick > budget) add('tick-budget', `${a.msPerTick.toFixed(3)} ms/tick > ${budget} ms/tick`);
    else infos.push(`${a.msPerTick.toFixed(3)} ms/tick of ${budget}`);
  }
  if (!fails.length) infos.unshift(`goal met at tick ${j.maxTicks} (${j.steps.length} step(s)); no-input control did not reach it; reopen at tick ${j.saveAt} matches`);
  return { fails, infos };
}

function checkCommandJourney(j, id, root) {
  const bad = validateJourney(j);
  if (bad.length) return { fails: [{ kind: 'bad-journey', message: bad.join('; ') }], infos: [] };
  const r = spawnSync(j.command, { shell: true, cwd: root, encoding: 'utf8', windowsHide: true, timeout: 300000, maxBuffer: 64 * 1024 * 1024, env: { ...process.env, STUDIO_JOURNEY_ID: id } });
  if (r.error || r.status !== 0) return { fails: [{ kind: 'command', message: `the command exited ${r.status}${r.error ? ` (${r.error.message})` : ''}: ${`${r.stderr || r.stdout || ''}`.trim().split('\n').slice(-3).join(' | ').slice(0, 400)}` }], infos: [] };
  const line = String(r.stdout || '').split('\n').map((l) => l.trim()).reverse().find((l) => l.startsWith('{') && l.endsWith('}'));
  let parsed = null;
  try { parsed = line ? JSON.parse(line) : null; } catch { parsed = null; }
  if (!parsed) return { fails: [{ kind: 'command', message: 'the command printed no JSON line' }], infos: [] };
  const fails = judgeCommandResult(parsed);
  return { fails, infos: fails.length ? [] : ['command journey: goal met, no-input control did not reach it, reopen digest matches'] };
}

/** Run every journey for these names. Returns { ok, results: [{ name, id, fails, infos }], warns }. */
export async function runJourneys({ names, root = REPO_ROOT }) {
  const results = [];
  const warns = [];
  let cart = null;
  let cartName = null;
  const bible = readJson(path.join(root, 'studio', 'bible', 'controls.json'));
  for (const name of names) {
    const dir = path.join(root, 'studio', 'journeys', name);
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort() : [];
    if (!files.length) { warns.push(`no journeys yet for ${name} (studio/journeys/${name}/<id>.json): add one that plays the game from the start to its goal (docs/JOURNEYS.md)`); continue; }
    for (const f of files) {
      const id = f.replace(/\.json$/, '');
      const j = readJson(path.join(dir, f));
      let r;
      if (j === null) r = { fails: [{ kind: 'bad-journey', message: `${f} is not valid JSON` }], infos: [] };
      else if (j && typeof j === 'object' && j.command !== undefined) r = checkCommandJourney(j, id, root);
      else {
        try {
          if (cartName !== name) {
            const { loadCartridge } = await import('../harness/cartridge.mjs');
            cart = await loadCartridge(name);
            cartName = name;
          }
          r = checkCartridgeJourney(name, j, cart, bible, root);
        } catch (e) {
          r = { fails: [{ kind: 'bad-journey', message: `cartridge "${name}" could not be loaded: ${String(e?.message || e)}` }], infos: [] };
        }
      }
      results.push({ name, id, ...r });
    }
  }
  return { ok: results.every((r) => r.fails.length === 0), results, warns };
}

async function main() {
  const argv = process.argv.slice(2);
  const { cartridgeFromArgv, activeGame } = await import('../harness/cartridge.mjs');
  const names = [...new Set([cartridgeFromArgv(argv), argv.includes('--cartridge') ? null : activeGame().name].filter(Boolean))];
  const res = await runJourneys({ names });
  if (argv.includes('--json')) console.log(JSON.stringify(res));
  for (const w of res.warns) console.log(`[journey] WARN ${w}`);
  let problems = 0;
  for (const r of res.results) {
    if (!r.fails.length) { console.log(`[journey] PASS ${r.name}/${r.id}: ${r.infos.join('; ')}`); continue; }
    for (const f of r.fails) {
      problems += 1;
      console.error(`[journey] FAIL ${f.kind} ${r.name}/${r.id}: ${f.message}`);
      console.error(`[journey] Fix: ${JOURNEY_FIXES[f.kind]}`);
    }
  }
  if (!res.results.length) console.log('[journey] PASS no journeys yet (nothing to play; a warning, not a failure)');
  else console.log(problems ? `[journey] ${problems} problem(s)` : `[journey] PASS ${res.results.length} journey(s) played: goal met, no-input control failed to reach it, fresh-process reopen matches`);
  process.exit(problems ? 1 : 0);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(SELF)) {
  if (process.argv.includes('--worker')) {
    let raw = '';
    for await (const chunk of process.stdin) raw += chunk;
    let out;
    try { out = await work(JSON.parse(raw)); } catch (e) { out = { error: `the run threw: ${String(e?.message || e)}` }; }
    process.stdout.write(`\n${MARK}${JSON.stringify(out)}\n`);
  } else await main();
}

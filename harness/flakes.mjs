/**
 * harness/flakes.mjs — 2.69.0 (r): the flake triager and the test quarantine.
 *
 * The crew's orchestrator re-ran failing tests alone by hand to decide "load or real" (game:test was red in 81 of 200
 * runs; the repeat offenders were seeded/timeout tests). Now, when a merge train's verify or re-check is red, each
 * failing test FILE (harness/train-focus.mjs reads them from the log) is run again ALONE, on the same tree, up to twice
 * (a focused run, 2.65.3: run-gates --only with STUDIO_GATE_FOCUS):
 *   real         it fails alone (the first run);
 *   seed-flake   it passes alone and the game's tests use randomness without a fixed seed in that file
 *                (harness/test-rng.mjs findings, 2.67.0); no second run is needed;
 *   load-flake   it passes alone, and again under low load (STUDIO_TEST_WORKERS=1: one test worker);
 *   intermittent it passes alone once, then fails alone under low load (flaky with no named cause).
 *   load-sensitive (2.78.0, PU-56) it fails alone, then passes alone at low load once the machine is quiet (no other heavy
 *                job: harness/flake-quiet.mjs; waits up to STUDIO_FLAKE_QUIET_WAIT_MIN, 10). Fails there too: real. Quiet not
 *                reached in time: real, "unconfirmed under load" (never a pass without evidence). Listed in .studio/load-sensitive.json.
 *   timeout-flake (2.72.0) a game check's timeout-only red whose file passed when the check re-ran it alone at low load
 *                (harness/game-gates.mjs timeoutOnlyRerun, recordTimeoutFlakes below); the check counted green for it.
 *   port-collision (2.77.3, C2/B-108) the run's output shows a test server that couldn't take its port (EADDRINUSE,
 *                "Port N is already in use", strictPort; harness/test-ports.mjs): another verify ran the same test on
 *                the same fixed port. Its own kind: not real (it doesn't count against the lane), not flaky (never
 *                quarantined); the why names the port and says to give the test a free port.
 * 2.77.3 (H2, B-112): the triage ends at the first "real" label (the red is real; the train goes on to name the lane
 * as for any real red, instead of running the other files alone first), and a run refused as busy (no machine:heavy
 * slot within STUDIO_FLAKE_WAIT_MIN, 10) is "not run", never "real"; the triage stops there too.
 2.78.0 merged with 2.77.3, the order for one file: it fails alone -> a port collision in that output is
 * "port-collision" (the quiet wait isn't spent: the cause is named); else the PU-56 quiet low-load re-run (which counts
 * as an alone-run: it shows in the train's status as "flake check k of n" and waits at most STUDIO_FLAKE_WAIT_MIN for
 * a slot once the machine is quiet) gives load-sensitive / real / real "unconfirmed under load" (a collision in its own
 * output is "port-collision"). It passes alone -> a collision in the red run's output is "port-collision", else
 * seed-flake / load-flake / intermittent. A "not run" from any of these runs: no label, the triage stops.
 * What the train does with the labels: any "real" -> a real red (the lane is named). Every failing part
 * load-sensitive -> it lands and reports them (PU-56). Every failing file a port collision, OR a mix of port collisions
 * and load-sensitive files with at least one collision (portCollisionWait; for the mix every failed gate must have a
 * file part, as for the load-sensitive excuse) -> nobody is handed back and the lanes wait for the next train, as in
 * 2.77.3: a collision means that test never really ran on this tree, so it can't land on a load-sensitive excuse.
 * Each label is a line in .studio/flakes.jsonl ({ at, test, check, label, why, train, tree, runs, rng }). A test
 * labelled flaky (any label but "real") STUDIO_FLAKE_QUARANTINE_AFTER (3) times in STUDIO_FLAKE_WINDOW_DAYS (7) goes on
 * the quarantine list studio/quarantine.json ([{ test, label, since, why, by, evidence, task, status }]) as PROPOSED:
 * the harness never silences a test on its own authority, so a proposed entry is not skipped; it is listed by the
 * digest and `npm run flakes` until a person, an agent under the owner's delegation, or an outside agent (or a
 * Producer/Director session) on a person's permission confirms it (`npm run flakes -- confirm <test> --by <name>`,
 * harness/decider.mjs; never a worker). Then it is active: game checks get the active entries as
 * STUDIO_TEST_QUARANTINE (a JSON list of test files) for the game's runner to skip. Exception: "autoQuarantine": true in
 * studio/quarantine.json ({ "autoQuarantine": true, "tests": [...] }) or in the game's studio.gates.json (the owner's
 * or a game dev's choice; both files are guarded) makes the harness's entries active at once, still with evidence.
 * ONE fix task is filed either way (deduped by the entry's task and the board's same-title check). A real failure is
 * never quarantined.
 * The list silences a check, so a lane that changes it is tier C (harness/tiers.mjs SILENCERS, like the fuzz ignore
 * list): a game dev releases an entry (`npm run flakes -- release <test> --by <name>`), or an outside agent, or a
 * Producer/Director session, on a person's recorded permission (harness/decider.mjs); never a worker. The harness's
 * own additions are recorded with their evidence (a test.quarantined event) and shown in the daily digest.
 * STUDIO_FLAKE_TRIAGE=off turns the triage off; STUDIO_FLAKE_MAX_FILES (5) caps the files triaged per red run;
 * STUDIO_FLAKE_WAIT_MIN (10, 2.77.3) caps how long one alone-run waits for a machine:heavy slot.
 * 2.78.0 (C2c): from the start of its quiet wait to the end of its run, the quiet re-run holds new non-landing heavy work
 * (builder and lane verifies) back in the heavy queue (harness/heavy.mjs markQuietHold), so "alone" stays alone (no
 * other verify starts on the same fixed port, or loads the machine again); bounded by STUDIO_FLAKE_HOLD_MIN (default
 * the quiet wait + STUDIO_FLAKE_WAIT_MIN + STUDIO_GAME_GATE_TIMEOUT_MS; 0/off: no hold), released when the run ends,
 * ignored once its train's process is gone. Running verifies are never stopped: the quiet wait waits for them.
 * Imports only small modules (train.mjs and game-gates.mjs import this one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { focusFromLog, normTestPath } from './train-focus.mjs';
import { testRngFacts, gameFolder } from './test-rng.mjs';
import { portCollision, portCollisionWhy } from './test-ports.mjs';

export const FLAKES_REL = '.studio/flakes.jsonl';
export const QUARANTINE_REL = 'studio/quarantine.json';
// 2.72.0 (a): "timeout-flake": a timeout-only red whose files passed when re-run alone at low load (harness/timeout-rerun.mjs).
export const FLAKY = Object.freeze(['load-flake', 'seed-flake', 'intermittent', 'timeout-flake']);
// 2.78.0 (PU-56): "load-sensitive": fails alone while other work runs, passes alone at low load on a quiet machine.
// Not in FLAKY: it is a test that needs a quiet machine, not a flaky one, so it is listed (LOAD_SENSITIVE_REL), never quarantined.
export const LOAD_SENSITIVE_REL = '.studio/load-sensitive.json';
const DAY = 86400000;
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeAtomic = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, text); fs.renameSync(t, f); };

export const triageOn = (env = process.env) => !off(env.STUDIO_FLAKE_TRIAGE);
export function flakeRules(env = process.env) {
  return { after: Math.max(1, Math.floor(num(env.STUDIO_FLAKE_QUARANTINE_AFTER, 3))), days: num(env.STUDIO_FLAKE_WINDOW_DAYS, 7), maxFiles: Math.max(1, Math.floor(num(env.STUDIO_FLAKE_MAX_FILES, 5))), waitMin: num(env.STUDIO_FLAKE_WAIT_MIN, 10) };
}

/** The labels recorded so far (newest last). */
export function readFlakes(root) {
  try { return fs.readFileSync(path.join(root, FLAKES_REL), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
}
function appendFlake(root, row) {
  const f = path.join(root, FLAKES_REL);
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify(row)}\n`);
}

/** studio/quarantine.json as a list ([] when missing or unreadable; { tests: [...] } is accepted too). */
export function readQuarantine(root) {
  const j = readJson(path.join(root, QUARANTINE_REL), []);
  const list = Array.isArray(j) ? j : Array.isArray(j?.tests) ? j.tests : [];
  return list.filter((e) => e && typeof e.test === 'string' && e.test.trim());
}
/** Writes the list back in the file's own shape (a list, or { autoQuarantine, tests }). */
const writeQuarantine = (root, list) => {
  const raw = readJson(path.join(root, QUARANTINE_REL), null);
  const body = raw && !Array.isArray(raw) && typeof raw === 'object' ? { ...raw, tests: list } : list;
  writeAtomic(path.join(root, QUARANTINE_REL), `${JSON.stringify(body, null, 2)}\n`);
};
/** An entry the runner skips: confirmed (status "active"), or written by hand without a status. "proposed" isn't. */
export const isActive = (e) => !e.status || e.status === 'active';
/**
 * Does the harness's addition go active at once? "autoQuarantine": true in studio/quarantine.json or in the game's
 * studio.gates.json: { on, where }.
 */
export function autoQuarantine(root, env = process.env) {
  const q = readJson(path.join(root, QUARANTINE_REL), null);
  if (q && !Array.isArray(q) && q.autoQuarantine === true) return { on: true, where: QUARANTINE_REL };
  try {
    const g = gameFolder(root, env);
    if (g && readJson(path.join(root, g, 'studio.gates.json'), null)?.autoQuarantine === true) return { on: true, where: `${g}/studio.gates.json` };
  } catch {}
  return { on: false, where: null };
}

/** What game checks get as STUDIO_TEST_QUARANTINE: a JSON list of test files ('' when none). */
export function quarantineEnvValue(root) {
  const list = readQuarantine(root).filter(isActive).map((e) => normTestPath(e.test)).filter(Boolean);
  return list.length ? JSON.stringify([...new Set(list)]) : '';
}

/** Does a test-rng finding ('file:line kind') name this test file? Paths compare by their trailing segments. */
const samePath = (a, b) => { const x = normTestPath(a); const y = normTestPath(b); return x === y || x.endsWith(`/${y}`) || y.endsWith(`/${x}`); };
export function rngFindingsFor(test, facts) {
  return (facts?.items || []).filter((it) => samePath(String(it).replace(/:\d+\s.*$/, ''), test));
}

/** 2.78.0 (PU-56): minutes a quiet re-run may wait for the machine to be quiet (STUDIO_FLAKE_QUIET_WAIT_MIN, default 10). */
export const quietWaitMin = (env = process.env) => num(env.STUDIO_FLAKE_QUIET_WAIT_MIN, 10);
/**
 * 2.78.0 (C2c): minutes the quiet re-run may hold other heavy work back (harness/heavy.mjs markQuietHold), from the start
 * of its quiet wait to the end of its run: STUDIO_FLAKE_HOLD_MIN; default the quiet wait + STUDIO_FLAKE_WAIT_MIN (its
 * slot wait) + the game check's own timeout (STUDIO_GAME_GATE_TIMEOUT_MS, 600 s); 0 or off: no hold.
 */
export function flakeHoldMin(env = process.env) {
  const v = String(env.STUDIO_FLAKE_HOLD_MIN ?? '').trim();
  if (off(v)) return 0;
  if (v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
  return quietWaitMin(env) + flakeRules(env).waitMin + num(env.STUDIO_GAME_GATE_TIMEOUT_MS, 600000) / 60000;
}

/**
 * Label one failing test file: runAlone({ check, file, lowLoad, quiet?, quietWaitMin? }) -> { ok, text?, notRun?, quietUnreached? }
 * runs it alone on the same tree (notRun: refused before it ran, e.g. no machine:heavy slot: no label). A caller that
 * supports `quiet` (2.78.0, PU-56) waits (up to quietWaitMin) for a quiet machine first and returns { ok: false,
 * quietUnreached: true } without running when it never came; one that doesn't ignores the flag. redText: the red run's
 * output (2.77.3: a port collision there makes a file that passes alone "port-collision", not a load flake).
 * Merged order (2.78.0 with 2.77.3): fails alone -> a port collision in that output is "port-collision" (no quiet wait:
 * the cause is named); else the quiet low-load re-run decides load-sensitive / real / real "unconfirmed under load" (a
 * collision in the quiet run's own output is "port-collision" too). Passes alone -> a collision in the red run's output
 * is "port-collision", else seed-flake / load-flake / intermittent. A notRun from any run: label null, the triage stops.
 * Returns { label, why, runs: [{ ok, lowLoad, quiet? }], rng, port? } (label null with notRun when it didn't run).
 */
export function labelTest({ check, file, runAlone, rng = null, env = process.env, redText = '' }) {
  const runs = [];
  const first = runAlone({ check, file, lowLoad: false });
  if (first?.notRun) return { label: null, notRun: String(first.notRun).slice(0, 300), why: `not run alone (${String(first.notRun).slice(0, 200)})`, runs, rng: [] };
  runs.push({ ok: Boolean(first?.ok), lowLoad: false });
  if (!first?.ok) {
    // 2.77.3 (C2): the alone run names its cause (a port already in use): no quiet wait is spent on it.
    const pc = portCollision(first?.text || '', { file });
    if (pc) return { label: 'port-collision', why: portCollisionWhy(pc, { alone: true }), runs, rng: [], port: pc.port };
    // 2.78.0 (PU-56): "alone" isn't quiet while other verifies run: a red alone is confirmed at quiet low load first.
    const wait = quietWaitMin(env);
    const q = runAlone({ check, file, lowLoad: true, quiet: true, quietWaitMin: wait });
    if (q?.notRun) return { label: null, notRun: String(q.notRun).slice(0, 300), why: `failed alone; the quiet low-load re-run was not run (${String(q.notRun).slice(0, 200)})`, runs, rng: [] };
    if (q?.quietUnreached) {
      runs.push({ ok: false, lowLoad: true, quiet: false });
      return { label: 'real', why: `fails when run alone on the same tree; unconfirmed under load: a quiet machine was not reached within ${wait} min (STUDIO_FLAKE_QUIET_WAIT_MIN), so the failure is treated as real`, runs, rng: [] };
    }
    runs.push({ ok: Boolean(q?.ok), lowLoad: true, quiet: true });
    if (q?.ok) return { label: 'load-sensitive', why: 'fails when run alone while other work runs, passes alone at low load (one test worker) on a quiet machine: it needs a quiet machine (load-sensitive)', runs, rng: [] };
    const pcQ = portCollision(q?.text || '', { file });
    if (pcQ) return { label: 'port-collision', why: portCollisionWhy(pcQ, { alone: true }), runs, rng: [], port: pcQ.port };
    return { label: 'real', why: 'fails when run alone on the same tree, and again at quiet low load', runs, rng: [] };
  }
  const pcRed = portCollision(redText, { file });
  if (pcRed) return { label: 'port-collision', why: portCollisionWhy(pcRed, { alone: false }), runs, rng: [], port: pcRed.port };
  const found = rngFindingsFor(file, rng);
  if (found.length) return { label: 'seed-flake', why: `passes alone; the test uses randomness without a fixed seed (${found.slice(0, 2).join('; ')})`, runs, rng: found };
  const second = runAlone({ check, file, lowLoad: true });
  if (second?.notRun) return { label: null, notRun: String(second.notRun).slice(0, 300), why: `passed alone; the low-load run was not run (${String(second.notRun).slice(0, 200)})`, runs, rng: [] };
  runs.push({ ok: Boolean(second?.ok), lowLoad: true });
  if (second?.ok) return { label: 'load-flake', why: 'passes alone, and again under low load (one test worker): it failed only beside other work', runs, rng: [] };
  return { label: 'intermittent', why: 'passes alone once, then fails alone under low load: flaky with no named cause', runs, rng: [] };
}

/** 2.78.0 (PU-56): the list of load-sensitive tests, newest data per test: [{ test, check, first, last, count }]. */
export function readLoadSensitive(root) {
  const j = readJson(path.join(root, LOAD_SENSITIVE_REL), []);
  return (Array.isArray(j) ? j : Array.isArray(j?.tests) ? j.tests : []).filter((e) => e && typeof e.test === 'string');
}
function noteLoadSensitive(root, row) {
  const list = readLoadSensitive(root);
  const e = list.find((x) => x.check === row.check && samePath(x.test, row.test));
  if (e) { e.last = row.at; e.count = (e.count || 1) + 1; } else list.push({ test: row.test, check: row.check, first: row.at, last: row.at, count: 1 });
  writeAtomic(path.join(root, LOAD_SENSITIVE_REL), `${JSON.stringify(list, null, 2)}\n`);
}

/**
 * Does every failing part of a red carry one of `kinds` in this triage? subs: the red's sub-ids (gate:check:file); gates:
 * its failed gates; labels: the triage rows. Yes only when every failed gate has a file sub-id and every such file was
 * labelled with one of `kinds`. Same shape of test as harness/known-red.mjs knownRedCandidate. Returns { ok, tests, why }.
 */
function labelledExcuse({ subs = [], gates = [], labels = [] } = {}, kinds, name) {
  const fileOf = (s) => { const p = String(s || '').split(':'); return p.length >= 2 && /[\\/.]/.test(p[p.length - 1]) ? p.slice(p.length >= 3 ? 2 : 1).join(':').replace(/\\/g, '/') : null; };
  if (!subs.length) return { ok: false, tests: [], why: 'no failing test named' };
  const bad = subs.filter((s) => { const f = fileOf(s); return !f || !labels.some((l) => kinds.includes(l.label) && samePath(l.test, f)); });
  if (bad.length) return { ok: false, tests: [], why: `${bad.slice(0, 3).join(', ')} not ${name}` };
  const covered = new Set(subs.map((s) => String(s).split(':')[0]));
  const bare = gates.filter((g) => !covered.has(String(g).split(':')[0]));
  if (bare.length) return { ok: false, tests: [], why: `${bare.join(', ')} failed with no ${name} part` };
  return { ok: true, tests: subs, why: '' };
}
/** 2.78.0 (PU-56): may a red be excused for load? Only when every failing part is a load-sensitive file (its quiet low-load re-run passed). */
export const loadSensitiveExcuse = (a = {}) => labelledExcuse(a, ['load-sensitive'], 'load-sensitive');
/**
 * 2.78.0 merge with 2.77.3: a red whose every failing part is a port collision or load-sensitive, with at least one port
 * collision (each file labelled in this triage): nobody is handed back and the lanes wait for the next train, as for a
 * red only on port collisions (a collision means that check didn't really run, so it never lands).
 */
export function collisionWaitExcuse(a = {}) {
  const r = labelledExcuse(a, ['port-collision', 'load-sensitive'], 'a port collision or load-sensitive');
  if (r.ok && !(a.labels || []).some((l) => l.label === 'port-collision')) return { ok: false, tests: [], why: 'no port collision' };
  return r;
}

/**
 * After a red verify or re-check: label each failing test file (at most STUDIO_FLAKE_MAX_FILES; each once per `seen`
 * set, usually one per train), record the labels, and quarantine a test flaky `after` times in the window.
 * opts: { root, dir (the tree's checkout), text (the red run's output), train, tree, runAlone, seen, now, env, log,
 * emit, rng (test-rng facts; default: scanned in dir) }. Returns { labels: [row], quarantined: [entry] }, and (2.77.3)
 * real (the first file labelled real: the triage stops there), notRun ({ test, why }: a run refused as busy; it stops
 * there too), allPortCollision (every failing file was labelled port-collision), portCollisionWait (2.78.0: every failing
 * file was labelled port-collision or load-sensitive, at least one port-collision). runAlone also gets { k, of }.
 */
export function triageRed({ root, dir = root, text, train = '', tree = '', runAlone, seen = new Set(), now = Date.now(), env = process.env, log = () => {}, emit = emitEvent, rng } = {}) {
  const out = { labels: [], quarantined: [] }; // 2.77.3: + real (the file red alone), notRun, skipped, allPortCollision; 2.78.0: portCollisionWait
  if (!triageOn(env) || typeof runAlone !== 'function') return out;
  const f = focusFromLog(text);
  const pairs = [];
  for (const check of f.failed) for (const file of f.files[check] || []) if (!seen.has(`${check}|${file}`)) pairs.push({ check, file });
  if (!pairs.length) return out;
  const rules = flakeRules(env);
  const facts = rng === undefined ? testRngFacts(dir, env) : rng;
  const todo = pairs.slice(0, rules.maxFiles);
  for (let k = 0; k < todo.length; k += 1) {
    const { check, file } = todo[k];
    seen.add(`${check}|${file}`);
    let l;
    try { l = labelTest({ check, file, runAlone: (a) => runAlone({ ...a, k: k + 1, of: todo.length }), rng: facts, env, redText: text }); } catch (e) { if (e?.stopsTriage) throw e; log(`[flakes] ${file}: not triaged (${e.message})`); continue; }
    if (!l.label) {
      // 2.77.3 (H2): refused before it ran (busy): no label, and the rest would wait the same way.
      out.notRun = { test: normTestPath(file), check, why: l.notRun };
      log(`[flakes] ${normTestPath(file)} (${check}): ${l.why}: no label${todo.length > k + 1 ? `; ${todo.length - k - 1} more failing file(s) not run alone either` : ''}; the train goes on`);
      for (const p of pairs) seen.add(`${p.check}|${p.file}`); // not again in this train (its next reds would wait the same way)
      break;
    }
    const row = { at: new Date(now).toISOString(), test: normTestPath(file), check, label: l.label, why: l.why, train, tree, runs: l.runs, ...(l.rng.length ? { rng: l.rng } : {}), ...(l.port ? { port: l.port } : {}) };
    try { appendFlake(root, row); } catch {}
    if (row.label === 'load-sensitive') { try { noteLoadSensitive(root, row); } catch {} }
    out.labels.push(row);
    log(`[flakes] ${row.test} (${check}): ${row.label}: ${row.why}`);
    const q = maybeQuarantine(root, row, { now, env, emit });
    if (q) { out.quarantined.push(q); log(q.status === 'active' ? `[flakes] ${row.test} is quarantined (${q.why}; autoQuarantine in ${q.auto}); the game's runner skips it via STUDIO_TEST_QUARANTINE until a game dev releases it` : `[flakes] ${row.test} is PROPOSED for quarantine (${q.why}); it still runs until a person confirms: npm run flakes -- confirm ${row.test} --by <name>`); }
    if (row.label === 'real') {
      // 2.77.3 (H2, B-112): one file red alone is enough: the red is real, and the train goes on to name the lane.
      out.real = row.test;
      if (todo.length > k + 1 || pairs.length > todo.length) { out.skipped = pairs.length - k - 1; log(`[flakes] ${pairs.length - k - 1} more failing test file(s) not run alone: ${row.test} fails alone, so this red is real; the train goes on`); }
      for (const p of pairs) seen.add(`${p.check}|${p.file}`); // nor on this train's later reds (its re-checks)
      break;
    }
  }
  if (!out.real && !out.notRun && pairs.length > rules.maxFiles) log(`[flakes] ${pairs.length - rules.maxFiles} more failing test file(s) not triaged (STUDIO_FLAKE_MAX_FILES ${rules.maxFiles})`);
  out.allPortCollision = out.labels.length > 0 && !out.real && !out.notRun && pairs.length <= todo.length && out.labels.length === pairs.length && out.labels.every((r) => r.label === 'port-collision');
  // 2.78.0 merge: every failing file is a port collision or load-sensitive, at least one a collision (the lanes wait, see the header).
  out.portCollisionWait = out.labels.length > 0 && !out.real && !out.notRun && pairs.length <= todo.length && out.labels.length === pairs.length && out.labels.every((r) => r.label === 'port-collision' || r.label === 'load-sensitive') && out.labels.some((r) => r.label === 'port-collision');
  if (out.labels.length) {
    try { emit({ type: 'test.flake_triage', agent: 'train', status: out.labels.some((r) => r.label === 'real') ? 'blocked' : 'warn', msg: `${train ? `train ${train}: ` : ''}failing tests run alone: ${out.labels.map((r) => `${r.test} ${r.label}${r.port ? ` (port ${r.port})` : ''}`).join(', ')}`.slice(0, 600), meta: { train, tree, labels: out.labels.map(({ test, check, label, port }) => ({ test, check, label, ...(port ? { port } : {}) })) } }); } catch {}
  }
  return out;
}

/** A test flaky `after` times in the window goes on the list (once; never on a "real" label). Returns the new entry or null. */
export function maybeQuarantine(root, row, { now = Date.now(), env = process.env, emit = emitEvent } = {}) {
  if (!FLAKY.includes(row.label)) return null;
  const rules = flakeRules(env);
  const list = readQuarantine(root);
  if (list.some((e) => samePath(e.test, row.test))) return null;
  const since = now - rules.days * DAY;
  const hits = readFlakes(root).filter((r) => samePath(r.test, row.test) && FLAKY.includes(r.label) && (Date.parse(r.at) || 0) >= since);
  if (hits.length < rules.after) return null;
  const counts = {};
  for (const h of hits) counts[h.label] = (counts[h.label] || 0) + 1;
  const label = Object.entries(counts).sort((a, b) => b[1] - a[1])[0][0];
  const auto = autoQuarantine(root, env);
  const entry = { test: row.test, label, since: new Date(now).toISOString(), why: `labelled flaky ${hits.length} times in ${rules.days} days (${Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(', ')}); a real failure is never quarantined`, by: 'harness', status: auto.on ? 'active' : 'proposed', ...(auto.on ? { auto: auto.where } : {}), evidence: hits.slice(-5).map((h) => ({ at: h.at, label: h.label, train: h.train || null, tree: h.tree ? String(h.tree).slice(0, 12) : null })), task: null };
  writeQuarantine(root, [...list, entry]);
  const msg = auto.on
    ? `${entry.test} quarantined by the harness ("autoQuarantine": true in ${auto.where}): ${entry.why}. The game's runner skips it (STUDIO_TEST_QUARANTINE); a fix task is filed; a game dev releases it: npm run flakes -- release ${entry.test} --by <name>`
    : `${entry.test} proposed for quarantine: ${entry.why}. It still runs until a person confirms (npm run flakes -- confirm ${entry.test} --by <name>); a fix task is filed`;
  try { emit({ type: auto.on ? 'test.quarantined' : 'test.quarantine_proposed', agent: 'harness', to: 'producer', status: 'warn', msg: msg.slice(0, 600), meta: { test: entry.test, label, status: entry.status, auto: auto.where, evidence: entry.evidence, by: 'harness' } }); } catch {}
  return entry;
}

/**
 * ONE fix task per quarantined test the harness added: fileTask({ title, test, label }) -> { id, duplicate? } (the
 * board's addTask). An entry that already names a task is skipped. Returns the tasks filed or found.
 */
export async function fileQuarantineTasks(root, fileTask, { emit = emitEvent } = {}) {
  if (typeof fileTask !== 'function') return [];
  const list = readQuarantine(root);
  const done = [];
  let changed = false;
  for (const e of list) {
    if (e.task || e.by !== 'harness') continue;
    let t = null;
    try { t = await fileTask({ title: `Fix flaky test ${e.test} (${e.label}; quarantined by the harness)`, test: e.test, label: e.label }); } catch { t = null; }
    if (!t?.id || t.error || t.proposed) continue;
    e.task = t.id;
    changed = true;
    done.push({ test: e.test, task: t.id, duplicate: Boolean(t.duplicate) });
    if (!t.duplicate) { try { emit({ type: 'test.quarantine_task', agent: 'harness', task: t.id, to: 'producer', msg: `${t.id} filed to fix the quarantined test ${e.test} (${e.label})`, meta: { test: e.test, label: e.label } }); } catch {} }
  }
  if (changed) writeQuarantine(root, list);
  return done;
}

/** Confirm a proposed entry (the decider rules: never a worker): it goes active, and the game's runner skips it. */
export async function confirmQuarantine(root, test, { by, permission = '', why = '', env = process.env, emit = emitEvent } = {}) {
  const list = readQuarantine(root);
  const e = list.find((x) => samePath(x.test, test));
  if (!e) return { ok: false, message: `${test} is not on the quarantine list (${QUARANTINE_REL}).` };
  if (isActive(e)) return { ok: true, message: `${e.test} is already quarantined (active).` };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, env, action: 'quarantine', what: 'confirm a test quarantine' });
  if (!d.ok) return { ok: false, message: d.why };
  e.status = 'active';
  e.confirmed = { by: d.by, at: new Date().toISOString(), via: d.via, ...(d.via !== 'person' ? { recordedBy: d.recordedBy, permission: d.permission || null } : {}), ...(why ? { why: String(why).slice(0, 300) } : {}) };
  writeQuarantine(root, list);
  emit({ type: 'test.quarantined', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} confirmed the quarantine of ${e.test} (${e.label}; ${e.why})${d.via === 'autonomous' ? ' (autonomous mode: on the review list)' : d.via !== 'person' ? ` (recorded by ${d.recordedBy} on ${d.by}'s permission)` : ''}: the game's runner skips it (STUDIO_TEST_QUARANTINE)`.slice(0, 600), meta: { test: e.test, label: e.label, status: 'active', confirmedBy: d.by, via: d.via, evidence: e.evidence || [], by: e.by || null } });
  await logFlakeDecision({ d, test: e.test, why: why || e.why, evidence: `${e.label}, ${(e.evidence || []).length} label(s)`, undo: { kind: 'quarantine-release', test: e.test, text: `npm run flakes -- release ${e.test} --by <name>` } });
  return { ok: true, message: `Confirmed: ${e.test} is quarantined; the game's runner skips it from the next check. Release: npm run flakes -- release ${e.test} --by <name>.` };
}

/** 2.71.0 (x): one decision-log record (harness/decisions.mjs). Never throws. */
async function logFlakeDecision({ d, test, why, evidence, undo }) {
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'quarantine', subject: test, by: d.by, as: dm.asOf(d), why, evidence, undo }); } catch {}
}

/** Release an entry (a game dev, or an outside agent or a Producer/Director session on a person's permission; never a worker). */
export async function releaseQuarantine(root, test, { by, permission = '', why = '', env = process.env, emit = emitEvent } = {}) {
  const list = readQuarantine(root);
  const e = list.find((x) => samePath(x.test, test));
  if (!e) return { ok: false, message: `${test} is not on the quarantine list (${QUARANTINE_REL}).` };
  const { deciderCheck } = await import('./decider.mjs');
  const d = await deciderCheck({ by, permission, env, action: 'quarantine', what: 'release a quarantined test' });
  if (!d.ok) return { ok: false, message: d.why };
  writeQuarantine(root, list.filter((x) => x !== e));
  await logFlakeDecision({ d, test: e.test, why: why || 'released from quarantine', evidence: 'release', undo: { kind: 'quarantine-confirm', test: e.test, text: `the flake triager proposes it again on its next flaky run; npm run flakes -- confirm ${e.test} --by <name>` } });
  emit({ type: 'test.quarantine_released', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} released ${e.test} from quarantine${d.via !== 'person' ? ` (recorded by ${d.recordedBy} on ${d.by}'s permission)` : ''}${why ? `: ${why}` : ''}`.slice(0, 600), meta: { test: e.test, by: d.by, via: d.via, recordedBy: d.recordedBy, permission: d.permission || null, entry: e } });
  return { ok: true, message: `Released ${e.test} from quarantine; the game's runner runs it again from the next check.` };
}

/**
 * 2.72.0 (a): a game check's timeout-only red re-ran its files alone at low load (harness/game-gates.mjs): one
 * "timeout-flake" row per file that passed there ({ at, test, check, label, why, tree, runs }), then the same quarantine
 * rule as every flaky label (proposed after STUDIO_FLAKE_QUARANTINE_AFTER in the window). A file red alone isn't
 * labelled here (the check stays red; the triager labels it). Never throws; returns the rows written.
 */
export function recordTimeoutFlakes(root, { check, files = [], why = '', text = '', tree = '', now = Date.now(), env = process.env, emit = emitEvent, log = () => {} } = {}) {
  const rows = [];
  for (const file of files) {
    // 2.77.3 (C2): the check's output shows a port collision: that is why it timed out (never quarantined).
    const pc = portCollision(text, { file });
    const row = { at: new Date(now).toISOString(), test: normTestPath(file), check, label: pc ? 'port-collision' : 'timeout-flake', why: pc ? portCollisionWhy(pc, { alone: false }) : why || 'timed out in the check; passed when re-run alone at low load (one test worker)', ...(pc?.port ? { port: pc.port } : {}), train: String(env.STUDIO_LOCK_OWNER || '').startsWith('train-') ? String(env.STUDIO_LOCK_OWNER).replace(/^train-/, '').replace(/-re$/, '') : '', tree, runs: [{ ok: false, lowLoad: false, timeout: true }, { ok: true, lowLoad: true }] };
    try { appendFlake(root, row); rows.push(row); } catch {}
    try { const q = maybeQuarantine(root, row, { now, env, emit }); if (q) log(`[flakes] ${row.test} is ${q.status === 'active' ? 'quarantined' : 'PROPOSED for quarantine'} (${q.why})`); } catch {}
  }
  const tf = rows.filter((r) => r.label === 'port-collision');
  if (tf.length) log(`[flakes] ${tf.map((r) => r.test).join(', ')}: port-collision, not a timeout-flake (${tf[0].why.slice(0, 200)})`);
  if (rows.length) { try { emit({ type: 'test.timeout_flake', agent: String(env.STUDIO_LOCK_OWNER || 'gates').slice(0, 60), status: 'warn', msg: `${check}: ${rows.length} test file(s) timed out, then passed alone at low load (timeout-flake; green for those files only): ${rows.map((r) => r.test).slice(0, 5).join(', ')}`.slice(0, 600), meta: { check, files: rows.map((r) => r.test), tree: tree || null } }); } catch {} }
  return rows;
}

/** 2.72.0 (a): the digest's line for timeout-flakes in 24 h (from .studio/flakes.jsonl), or ''. */
export function timeoutFlakeDigestLine(root, { now = Date.now() } = {}) {
  if (!root) return '';
  const rows = readFlakes(root).filter((r) => r.label === 'timeout-flake' && (Date.parse(r.at) || 0) >= now - DAY);
  if (!rows.length) return '';
  const by = {};
  for (const r of rows) by[r.test] = (by[r.test] || 0) + 1;
  const top = Object.entries(by).sort((a, b) => b[1] - a[1]);
  return `${rows.length} timeout-only red${rows.length === 1 ? '' : 's'} in 24 h passed when re-run alone at low load (timeout-flake; counted green for that file only, the lane not blamed): ${top.slice(0, 3).map(([t, n]) => `${t}${n > 1 ? ` x${n}` : ''}`).join(', ')}${top.length > 3 ? ' …' : ''} (${FLAKES_REL}).`;
}

/** The digest's line: the harness's quarantine additions in 24 h, and how many tests are quarantined now. */
export function quarantineDigestLine(events, { now = Date.now(), root = null } = {}) {
  const added = (events || []).filter((e) => e.type === 'test.quarantined' && e.agent === 'harness' && (Date.parse(e.ts) || 0) >= now - DAY);
  const all = root ? readQuarantine(root) : [];
  const proposed = all.filter((e) => !isActive(e));
  const active = all.filter(isActive);
  const tf = timeoutFlakeDigestLine(root, { now }); // 2.72.0 (a)
  if (!added.length && !all.length) return tf;
  const head = added.length ? `The harness quarantined ${added.length} flaky test${added.length === 1 ? '' : 's'} in 24 h (autoQuarantine): ${added.slice(0, 3).map((e) => `${e.meta?.test || '?'} (${e.meta?.label || '?'}, ${(e.meta?.evidence || []).length} labels)`).join(', ')}${added.length > 3 ? ' …' : ''}.` : '';
  const prop = proposed.length ? `Proposed for quarantine, still running until you confirm: ${proposed.slice(0, 3).map((e) => `${e.test} (${e.label}, ${(e.evidence || []).length} labels)`).join(', ')}${proposed.length > 3 ? ' …' : ''} (npm run flakes -- confirm <test> --by <you>).` : '';
  const tail = active.length ? `${active.length} test${active.length === 1 ? '' : 's'} quarantined (${QUARANTINE_REL}; npm run flakes; release: npm run flakes -- release <test> --by <you>).` : '';
  return [head, prop, tail, tf].filter(Boolean).join(' ');
}

export function statusText(root, now = Date.now(), env = process.env) {
  const q = readQuarantine(root);
  const days = flakeRules(env).days;
  const recent = readFlakes(root).filter((r) => (Date.parse(r.at) || 0) >= now - days * DAY);
  const by = {};
  for (const r of recent) (by[r.test] ||= {})[r.label] = ((by[r.test] || {})[r.label] || 0) + 1;
  const act = q.filter(isActive);
  const prop = q.filter((e) => !isActive(e));
  const row = (e) => `  ${e.test}  ${e.label}  since ${String(e.since).slice(0, 16)}  by ${e.by || '?'}${e.confirmed ? `, confirmed by ${e.confirmed.by}` : ''}${e.task ? `  fix: ${e.task}` : ''}  (${e.why})`;
  const lines = [act.length ? `Quarantined (${QUARANTINE_REL}; the game's runner skips them via STUDIO_TEST_QUARANTINE):` : 'No test is quarantined.'];
  for (const e of act) lines.push(row(e));
  if (prop.length) { lines.push(`Proposed by the harness, still running until confirmed (npm run flakes -- confirm <test> --by <name>):`); for (const e of prop) lines.push(row(e)); }
  lines.push(Object.keys(by).length ? `Labels in ${days} days (${FLAKES_REL}):` : `No flake labels in ${days} days.`);
  for (const [t, c] of Object.entries(by)) lines.push(`  ${t}  ${Object.entries(c).map(([k, v]) => `${k} ${v}`).join(', ')}`);
  return lines.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const { mainRoot } = await import('./worktree.mjs');
  const root = mainRoot();
  if (!argv.length || argv[0] === 'status') { console.log(statusText(root)); process.exit(0); }
  if (argv[0] === 'confirm' && argv[1] && flag('by')) {
    const r = await confirmQuarantine(root, argv[1], { by: flag('by'), permission: flag('permission') || '', why: flag('why') || '' });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  if (argv[0] === 'release' && argv[1] && flag('by')) {
    const r = await releaseQuarantine(root, argv[1], { by: flag('by'), permission: flag('permission') || '', why: flag('why') || '' });
    (r.ok ? console.log : console.error)(r.message);
    process.exit(r.ok ? 0 : 1);
  }
  console.error('Usage: npm run flakes [-- status] | npm run flakes -- confirm|release <test file> --by <name> [--permission "<their words or a link>"] [--why "…"]');
  process.exit(2);
}

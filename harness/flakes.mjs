/**
 * harness/flakes.mjs — the flake triager and the test quarantine.
 *
 * When a merge train's verify or re-check is red, each failing test FILE (harness/train-focus.mjs reads them from the log) is
 * run again ALONE on the same tree (a focused run: run-gates --only with STUDIO_GATE_FOCUS), up to twice, and labelled:
 *   real           it fails alone; the triage stops at the first one (the train goes on to name the lane);
 *   seed-flake     it passes alone and the file uses randomness without a fixed seed (harness/test-rng.mjs findings);
 *   load-flake     it passes alone, and again under low load (STUDIO_TEST_WORKERS=1: one test worker);
 *   intermittent   it passes alone once, then fails alone under low load (flaky with no named cause);
 *   load-sensitive it fails alone, then passes alone at low load once the machine is quiet (no other heavy job:
 *                  harness/flake-quiet.mjs; waits up to STUDIO_FLAKE_QUIET_WAIT_MIN, 10). Listed in .studio/load-sensitive.json,
 *                  never quarantined. Fails there too: real. Quiet not reached in time: real, "unconfirmed under load" (never a
 *                  pass without evidence). A file with at least STUDIO_LOAD_SENSITIVE_TRUST (2) quiet-confirmed labels in
 *                  STUDIO_FLAKE_WINDOW_DAYS and no "real" since (loadSensitiveTrust) skips the quiet wait: a pass at low load
 *                  at once is "trusted: true" (it never counts toward trust); a fail goes on to the quiet re-run. 0/off: never trusted.
 *   timeout-flake  a game check's timeout-only red whose file passed when re-run alone at low load (harness/game-gates.mjs
 *                  timeoutOnlyRerun, recordTimeoutFlakes); the check counted green for it;
 *   port-collision the output shows a test server that couldn't take its port (EADDRINUSE, "Port N is already in use",
 *                  strictPort; harness/test-ports.mjs): another verify used the same fixed port. Not real, not flaky (never
 *                  quarantined); the why names the port.
 * Order for one file: fails alone -> a port collision in that output is "port-collision" (no quiet wait spent); else the quiet
 * low-load re-run (it counts as an alone-run and waits at most STUDIO_FLAKE_WAIT_MIN for a machine:heavy slot) gives
 * load-sensitive / real / real "unconfirmed under load" (a collision in its own output is "port-collision"). Passes alone ->
 * a collision in the red run's output is "port-collision", else seed-flake / load-flake / intermittent. A run refused as busy
 * (no slot within STUDIO_FLAKE_WAIT_MIN, 10) is "not run", never "real": no label, and the triage stops.
 * What the train does with the labels: any "real" -> a real red (the lane is named). Every failing part load-sensitive ->
 * it lands and reports them. Every failing file a port collision, or a mix of collisions and load-sensitive files with at
 * least one collision (portCollisionWait; every failed gate must have a file part) -> nobody is handed back and the lanes
 * wait for the next train: a collision means that test never really ran on this tree.
 *
 * Settings: STUDIO_FLAKE_TRIAGE=off turns the triage off; STUDIO_FLAKE_MAX_FILES (5) caps the files triaged per red run;
 * STUDIO_FLAKE_QUARANTINE_AFTER (3) in STUDIO_FLAKE_WINDOW_DAYS (7); STUDIO_FLAKE_HOLD_MIN (default the quiet wait +
 * STUDIO_FLAKE_WAIT_MIN + STUDIO_GAME_GATE_TIMEOUT_MS; 0/off: no hold): from the start of its quiet wait to the end of its run
 * the quiet re-run holds new non-landing heavy work back in the heavy queue (harness/heavy.mjs markQuietHold), so "alone"
 * stays alone; running verifies are never stopped. STUDIO_FLAKE_TOGETHER=off: one file at a time (see togetherOn); by default
 * a check with two or more failing files is triaged TOGETHER when the caller can (triageRed's `together`): ONE run of all of them
 * at low load, then ONE quiet low-load re-run of those still failing, labelled from the run's per-file result (game-gates'
 * "failing test files in <check>" line). A file that fails the quiet re-run beside others is "real" only once it fails by
 * itself (one at a time, up to the first real). A run that can't be split by file (names no failing file or one outside the
 * group, timed out, fell back to the whole check, or a port collision with several files failing) falls back to one run per file.
 *
 * Files: every label is a line in .studio/flakes.jsonl ({ at, test, check, label, why, train, tree, runs, rng }). A test
 * labelled flaky (any label but "real") STUDIO_FLAKE_QUARANTINE_AFTER times in the window goes on studio/quarantine.json
 * ([{ test, label, since, why, by, evidence, task, status }]) as PROPOSED: the harness never silences a test on its own
 * authority, so a proposed entry is not skipped; it is listed by the digest and `npm run flakes` until a person, an agent under
 * the owner's delegation, or an outside agent (or a Producer/Director session) on a person's permission confirms it
 * (`npm run flakes -- confirm <test> --by <name>`, harness/decider.mjs; never a worker). Then it is active: game checks get the
 * active entries as STUDIO_TEST_QUARANTINE (a JSON list of test files) for the game's runner to skip. "autoQuarantine": true in
 * studio/quarantine.json ({ "autoQuarantine": true, "tests": [...] }) or in the game's studio.gates.json (the owner's or a game
 * dev's choice; both files are guarded) makes the harness's entries active at once, still with evidence. ONE fix task is
 * filed either way. A real failure is never quarantined. The list silences a check, so a lane that changes it is tier C
 * (harness/tiers.mjs SILENCERS): a game dev releases an entry (`npm run flakes -- release <test> --by <name>`), or an outside
 * agent, or a Producer/Director session, on a person's recorded permission; never a worker. The harness's own additions are
 * recorded with their evidence (a test.quarantined event) and shown in the daily digest.
 * Imports only small modules (train.mjs and game-gates.mjs import this one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { focusFromLog, normTestPath } from './train-focus.mjs';
import { testRngFacts, gameFolder } from './test-rng.mjs';
import { portCollision, portCollisionWhy } from './test-ports.mjs';
import { readJson } from './fsafe.mjs';

export const FLAKES_REL = '.studio/flakes.jsonl';
export const QUARANTINE_REL = 'studio/quarantine.json';
// "timeout-flake": a timeout-only red whose files passed when re-run alone at low load (harness/timeout-rerun.mjs).
export const FLAKY = Object.freeze(['load-flake', 'seed-flake', 'intermittent', 'timeout-flake']);
// "load-sensitive": fails alone while other work runs, passes alone at low load on a quiet machine. Not in FLAKY: it needs a
// quiet machine, so it is listed (LOAD_SENSITIVE_REL), never quarantined.
export const LOAD_SENSITIVE_REL = '.studio/load-sensitive.json';
const DAY = 86400000;
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
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

/** Minutes a quiet re-run may wait for the machine to be quiet (STUDIO_FLAKE_QUIET_WAIT_MIN, default 10). */
export const quietWaitMin = (env = process.env) => num(env.STUDIO_FLAKE_QUIET_WAIT_MIN, 10);
/**
 * Minutes the quiet re-run may hold other heavy work back (harness/heavy.mjs markQuietHold): STUDIO_FLAKE_HOLD_MIN; default
 * the quiet wait + STUDIO_FLAKE_WAIT_MIN + the game check's timeout (STUDIO_GAME_GATE_TIMEOUT_MS, 600 s); 0 or off: no hold.
 */
export function flakeHoldMin(env = process.env) {
  const v = String(env.STUDIO_FLAKE_HOLD_MIN ?? '').trim();
  if (off(v)) return 0;
  if (v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0) return Number(v);
  return quietWaitMin(env) + flakeRules(env).waitMin + num(env.STUDIO_GAME_GATE_TIMEOUT_MS, 600000) / 60000;
}

/**
 * Label one failing test file: runAlone({ check, file, lowLoad, quiet?, quietWaitMin? }) -> { ok, text?, notRun?, quietUnreached? }
 * runs it alone on the same tree (notRun: refused before it ran, e.g. no machine:heavy slot: no label). A caller that supports
 * `quiet` waits (up to quietWaitMin) for a quiet machine first and returns { ok: false, quietUnreached: true } without running
 * when it never came; one that doesn't ignores the flag. redText: the red run's output (a port collision there makes a file
 * that passes alone "port-collision", not a load flake). The label order is in the header. A notRun from any run: label null,
 * the triage stops. Returns { label, why, runs: [{ ok, lowLoad, quiet? }], rng, port? } (label null with notRun when it didn't run).
 */
export function labelTest({ check, file, runAlone, rng = null, env = process.env, redText = '', trust = null }) {
  const runs = [];
  const first = runAlone({ check, file, lowLoad: false });
  if (first?.notRun) return { label: null, notRun: String(first.notRun).slice(0, 300), why: `not run alone (${String(first.notRun).slice(0, 200)})`, runs, rng: [] };
  runs.push({ ok: Boolean(first?.ok), lowLoad: false });
  if (!first?.ok) {
    // The alone run names its cause (a port already in use): no quiet wait is spent on it.
    const pc = portCollision(first?.text || '', { file });
    if (pc) return { label: 'port-collision', why: portCollisionWhy(pc, { alone: true }), runs, rng: [], port: pc.port };
    // A file already recorded load-sensitive often enough (loadSensitiveTrust) skips the quiet wait: it runs alone at low load
    // (one test worker) at once. Passes: load-sensitive, "trusted". Anything else: the quiet path below.
    if (trust?.trusted) {
      const t = runAlone({ check, file, lowLoad: true, trusted: true });
      if (t?.notRun) return { label: null, notRun: String(t.notRun).slice(0, 300), why: `failed alone; the low-load re-run was not run (${String(t.notRun).slice(0, 200)})`, runs, rng: [] };
      runs.push({ ok: Boolean(t?.ok), lowLoad: true, trusted: true });
      if (t?.ok) return { label: 'load-sensitive', trusted: true, why: `fails when run alone while other work runs, passes alone at low load (one test worker); trusted without a quiet machine: ${trust.why}`, runs, rng: [] };
      const pcT = portCollision(t?.text || '', { file });
      if (pcT) return { label: 'port-collision', why: portCollisionWhy(pcT, { alone: true }), runs, rng: [], port: pcT.port };
    }
    // "alone" isn't quiet while other verifies run: a red alone is confirmed at quiet low load first.
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

/** The list of load-sensitive tests, newest data per test: [{ test, check, first, last, count }]. */
export function readLoadSensitive(root) {
  const j = readJson(path.join(root, LOAD_SENSITIVE_REL), []);
  return (Array.isArray(j) ? j : Array.isArray(j?.tests) ? j.tests : []).filter((e) => e && typeof e.test === 'string');
}
/**
 * May this file's red alone skip the quiet wait? Yes when it is listed in .studio/load-sensitive.json and .studio/flakes.jsonl
 * has at least STUDIO_LOAD_SENSITIVE_TRUST (default 2; 0 or off: never) load-sensitive labels for it (same check) within
 * STUDIO_FLAKE_WINDOW_DAYS that a quiet machine confirmed (a trusted label never counts), and no "real" label for that file
 * (any check) since its first load-sensitive label. Returns { trusted, n, why }.
 */
export function loadSensitiveTrust(root, { test, check, now = Date.now(), env = process.env } = {}) {
  const v = String(env.STUDIO_LOAD_SENSITIVE_TRUST ?? '').trim();
  const need = off(v) ? 0 : Math.floor(num(v, 2));
  if (!need) return { trusted: false, n: 0, why: 'STUDIO_LOAD_SENSITIVE_TRUST is off' };
  const listed = readLoadSensitive(root).find((e) => (!e.check || e.check === check) && samePath(e.test, test));
  if (!listed) return { trusted: false, n: 0, why: `not in ${LOAD_SENSITIVE_REL}` };
  const rows = readFlakes(root).filter((r) => samePath(r.test, test));
  const sens = rows.filter((r) => r.label === 'load-sensitive' && (!r.check || r.check === check));
  const firstAt = Math.min(...[...sens.map((r) => Date.parse(r.at) || Infinity), Date.parse(listed.first || '') || Infinity]);
  const real = rows.find((r) => r.label === 'real' && (Date.parse(r.at) || 0) >= (Number.isFinite(firstAt) ? firstAt : 0));
  if (real) return { trusted: false, n: 0, why: `labelled real at ${real.at} after it was recorded load-sensitive` };
  const days = flakeRules(env).days;
  const n = sens.filter((r) => !r.trusted && (Date.parse(r.at) || 0) >= now - days * DAY).length;
  if (n < need) return { trusted: false, n, why: `${n} quiet-confirmed load-sensitive label(s) in ${days} days, ${need} needed (STUDIO_LOAD_SENSITIVE_TRUST)` };
  return { trusted: true, n, why: `recorded load-sensitive ${n} times in ${days} days on a quiet machine and never real since (STUDIO_LOAD_SENSITIVE_TRUST ${need})` };
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
/** May a red be excused for load? Only when every failing part is a load-sensitive file (its quiet low-load re-run passed). */
export const loadSensitiveExcuse = (a = {}) => labelledExcuse(a, ['load-sensitive'], 'load-sensitive');
/**
 * A red whose every failing part is a port collision or load-sensitive, with at least one port collision (each file labelled
 * in this triage): nobody is handed back and the lanes wait for the next train (a collision means that check didn't really run).
 */
export function collisionWaitExcuse(a = {}) {
  const r = labelledExcuse(a, ['port-collision', 'load-sensitive'], 'a port collision or load-sensitive');
  if (r.ok && !(a.labels || []).some((l) => l.label === 'port-collision')) return { ok: false, tests: [], why: 'no port collision' };
  return r;
}

/**
 * Several failing files of one check are triaged in one run (default ON; STUDIO_FLAKE_TOGETHER=off restores one file at a time:
 * qa/selftest-269r.mjs (c) and qa/selftest-2773b.mjs pin that path on purpose). The run is the game check's own run (bounded
 * by STUDIO_GAME_GATE_TIMEOUT_MS; a timeout can't be split by file, so `attribute` falls back to per-file runs), and the red
 * budget (STUDIO_TRAIN_RED_BUDGET_MIN) is checked before every run.
 */
export const togetherOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_FLAKE_TOGETHER ?? '').trim());

/**
 * Which files of a group run failed, from that run's output: { ok: true, failing, passing } or { ok: false, why } when it
 * can't be told file by file (the caller then runs them one at a time). A green run: every file passed.
 */
export function attribute(run, check, files) {
  if (run?.ok) return { ok: true, failing: [], passing: [...files] };
  const text = String(run?.text || '');
  if (/^Error: timed out after \d+ s/m.test(text)) return { ok: false, why: 'the run timed out' };
  if (/running the whole check instead/.test(text)) return { ok: false, why: 'the focused run fell back to the whole check' };
  const named = focusFromLog(text).files[check] || [];
  if (!named.length) return { ok: false, why: 'it names no failing test file' };
  const outside = named.filter((n) => !files.some((f) => samePath(f, n)));
  if (outside.length) return { ok: false, why: `it names ${outside.slice(0, 2).join(', ')}, not one of the files run` };
  const failing = files.filter((f) => named.some((n) => samePath(f, n)));
  return { ok: true, failing, passing: files.filter((f) => !failing.includes(f)) };
}

/** The label of a file that failed in the red run and passed when run again alone at low load. */
function passedLowLoad(file, { redText, rng, trust, together, runs }) {
  const pcRed = portCollision(redText, { file });
  if (pcRed) return { label: 'port-collision', why: portCollisionWhy(pcRed, { alone: false }), runs, rng: [], port: pcRed.port };
  const found = rngFindingsFor(file, rng);
  if (found.length) return { label: 'seed-flake', why: `passes alone at low load${together ? ` (with the other ${together - 1} failing file(s) of its check)` : ''}; the test uses randomness without a fixed seed (${found.slice(0, 2).join('; ')})`, runs, rng: found };
  if (trust?.trusted) return { label: 'load-sensitive', trusted: true, why: `fails in the verify while other work runs, passes alone at low load (one test worker${together ? `, with the other ${together - 1} failing file(s) of its check` : ''}); trusted without a quiet machine: ${trust.why}`, runs, rng: [] };
  return { label: 'load-flake', why: `passes alone at low load (one test worker${together ? `, with the other ${together - 1} failing file(s) of its check` : ''}): it failed only beside other work`, runs, rng: [] };
}

/**
 * Label the failing files of ONE check together (see the header). runAlone({ check, files, lowLoad, quiet?, quietWaitMin?,
 * together: true }) runs them in one run. Returns { labels: [{ file, ...label }], notRun?, perFile: [files to label one at a time], why? }.
 */
export function labelGroup({ check, files, runAlone, rng = null, env = process.env, redText = '', trusts = {}, log = () => {} }) {
  const labels = [];
  const n = files.length;
  const first = runAlone({ check, files, lowLoad: true, together: true });
  if (first?.notRun) return { labels, notRun: String(first.notRun).slice(0, 300), why: `not run alone together (${String(first.notRun).slice(0, 200)})`, perFile: [] };
  const a = attribute(first, check, files);
  if (!a.ok) { log(`[flakes] ${check}: the ${n} failing files run together can't be told apart (${a.why}): each runs alone instead`); return { labels, perFile: [...files], why: a.why }; }
  const run1 = (f) => ({ ok: !a.failing.includes(f), lowLoad: true, together: n });
  for (const f of a.passing) labels.push({ file: f, ...passedLowLoad(f, { redText, rng, trust: trusts[f], together: n, runs: [run1(f)] }) });
  if (!a.failing.length) return { labels, perFile: [] };
  const pc1 = portCollision(first?.text || '', {});
  if (pc1 && a.failing.length > 1) { log(`[flakes] ${check}: a port collision with ${a.failing.length} files failing together: each runs alone instead`); return { labels, perFile: [...a.failing], why: 'a port collision with more than one file failing' }; }
  if (pc1) { const f = a.failing[0]; const pc = portCollision(first.text, { file: f }); labels.push({ file: f, label: 'port-collision', why: portCollisionWhy(pc, { alone: true }), runs: [run1(f)], rng: [], port: pc.port }); return { labels, perFile: [] }; }
  // Still failing at low load: the quiet low-load re-run, together.
  const Q = a.failing;
  const m = Q.length;
  const wait = quietWaitMin(env);
  const q = runAlone({ check, files: Q, lowLoad: true, quiet: true, quietWaitMin: wait, together: true });
  if (q?.notRun) return { labels, notRun: String(q.notRun).slice(0, 300), why: `failed alone at low load; the quiet low-load re-run was not run (${String(q.notRun).slice(0, 200)})`, perFile: [] };
  if (q?.quietUnreached) {
    for (const f of Q) labels.push({ file: f, label: 'real', why: `fails alone at low load on the same tree${m > 1 ? ` (with ${m - 1} other failing file(s) of its check)` : ''}; unconfirmed under load: a quiet machine was not reached within ${wait} min (STUDIO_FLAKE_QUIET_WAIT_MIN), so the failure is treated as real`, runs: [run1(f), { ok: false, lowLoad: true, quiet: false, together: m }], rng: [] });
    return { labels, perFile: [] };
  }
  const b = attribute(q, check, Q);
  if (!b.ok) { log(`[flakes] ${check}: the quiet re-run of ${m} files together can't be told apart (${b.why}): each runs alone instead`); return { labels, perFile: [...Q], why: b.why }; }
  const pcQ = b.failing.length ? portCollision(q?.text || '', {}) : null;
  if (pcQ && b.failing.length > 1) return { labels: [...labels, ...b.passing.map((f) => ({ file: f, label: 'load-sensitive', why: quietWhy(m), runs: [run1(f), { ok: true, lowLoad: true, quiet: true, together: m }], rng: [] }))], perFile: [...b.failing], why: 'a port collision with more than one file failing' };
  const runQ = (f) => [run1(f), { ok: !b.failing.includes(f), lowLoad: true, quiet: true, together: m }];
  for (const f of b.passing) labels.push({ file: f, label: 'load-sensitive', why: quietWhy(m), runs: runQ(f), rng: [] });
  if (pcQ) { const f = b.failing[0]; const pc = portCollision(q.text, { file: f }); labels.push({ file: f, label: 'port-collision', why: portCollisionWhy(pc, { alone: true }), runs: runQ(f), rng: [], port: pc.port }); return { labels, perFile: [] }; }
  if (m === 1) { const f = b.failing[0]; labels.push({ file: f, label: 'real', why: 'fails alone at low load on the same tree, and again at quiet low load', runs: runQ(f), rng: [] }); return { labels, perFile: [] }; }
  // Failed beside the others even at quiet low load: "real" only once it fails by itself (a file that fails only next to other
  // test files is not this lane's red). One at a time, until the first real.
  for (const f of b.failing) {
    const c = runAlone({ check, files: [f], lowLoad: true, quiet: true, quietWaitMin: wait, together: true });
    if (c?.notRun) return { labels, notRun: String(c.notRun).slice(0, 300), why: `failed at quiet low load with the others; its run alone was not run (${String(c.notRun).slice(0, 200)})`, perFile: [] };
    if (c?.quietUnreached) { labels.push({ file: f, label: 'real', why: `fails at quiet low load with ${m - 1} other failing file(s) of its check; unconfirmed alone: a quiet machine was not reached within ${wait} min (STUDIO_FLAKE_QUIET_WAIT_MIN), so the failure is treated as real`, runs: [...runQ(f), { ok: false, lowLoad: true, quiet: false }], rng: [] }); return { labels, perFile: [] }; }
    const runsC = [...runQ(f), { ok: Boolean(c?.ok), lowLoad: true, quiet: true }];
    if (c?.ok) { labels.push({ file: f, label: 'load-flake', why: `fails beside the other failing files of its check, even at quiet low load, and passes by itself at quiet low load: it failed only beside other work`, runs: runsC, rng: [] }); continue; }
    const pc = portCollision(c?.text || '', { file: f });
    if (pc) { labels.push({ file: f, label: 'port-collision', why: portCollisionWhy(pc, { alone: true }), runs: runsC, rng: [], port: pc.port }); return { labels, perFile: [] }; }
    labels.push({ file: f, label: 'real', why: `fails alone at low load on the same tree, and again by itself at quiet low load`, runs: runsC, rng: [] });
    return { labels, perFile: [] };
  }
  return { labels, perFile: [] };
}
const quietWhy = (m) => `fails alone at low load while other work runs, passes alone at low load (one test worker${m > 1 ? `, with ${m - 1} other failing file(s) of its check` : ''}) on a quiet machine: it needs a quiet machine (load-sensitive)`;

/**
 * After a red verify or re-check: label each failing test file (at most STUDIO_FLAKE_MAX_FILES; each once per `seen` set,
 * usually one per train), record the labels, and quarantine a test flaky `after` times in the window.
 * opts: { root, dir (the tree's checkout), text (the red run's output), train, tree, runAlone, seen, now, env, log, emit, rng
 * (test-rng facts; default: scanned in dir), together (runAlone takes { files: [...] }: see labelGroup) }. runAlone also gets
 * { k, of }. Returns { labels: [row], quarantined: [entry] }, plus real (the first file labelled real: the triage stops
 * there), notRun ({ test, why }: a run refused as busy; stops there too), allPortCollision (every failing file was a
 * port-collision), portCollisionWait (every failing file was a port-collision or load-sensitive, at least one port-collision).
 */
export function triageRed({ root, dir = root, text, train = '', tree = '', runAlone, seen = new Set(), now = Date.now(), env = process.env, log = () => {}, emit = emitEvent, rng, together = false } = {}) {
  const out = { labels: [], quarantined: [] }; // also real, notRun, skipped, allPortCollision, portCollisionWait
  if (!triageOn(env) || typeof runAlone !== 'function') return out;
  const f = focusFromLog(text);
  const pairs = [];
  for (const check of f.failed) for (const file of f.files[check] || []) if (!seen.has(`${check}|${file}`)) pairs.push({ check, file });
  if (!pairs.length) return out;
  const rules = flakeRules(env);
  const facts = rng === undefined ? testRngFacts(dir, env) : rng;
  const todo = pairs.slice(0, rules.maxFiles);
  // A check's failing files run together (one run, then one quiet re-run) when the caller can (`together`).
  const units = [];
  if (together && togetherOn(env)) {
    const by = new Map();
    for (const p of todo) { if (!by.has(p.check)) by.set(p.check, []); by.get(p.check).push(p.file); }
    for (const [check, files] of by) units.push(files.length > 1 ? { check, files } : { check, file: files[0] });
  } else for (const p of todo) units.push(p);
  const trustOf = (check, file) => { try { return loadSensitiveTrust(root, { test: normTestPath(file), check, now, env }); } catch { return null; } };
  const stopAll = () => { for (const p of pairs) seen.add(`${p.check}|${p.file}`); };
  let done = 0; // files labelled or tried so far (for the "more not run" counts)
  // One label: recorded, quarantine rule, the "real" stop. Returns true when the triage stops.
  const record = (check, file, l) => {
    const row = { at: new Date(now).toISOString(), test: normTestPath(file), check, label: l.label, why: l.why, train, tree, runs: l.runs, ...(l.rng?.length ? { rng: l.rng } : {}), ...(l.port ? { port: l.port } : {}), ...(l.trusted ? { trusted: true } : {}) };
    try { appendFlake(root, row); } catch {}
    if (row.label === 'load-sensitive') { try { noteLoadSensitive(root, row); } catch {} }
    out.labels.push(row);
    log(`[flakes] ${row.test} (${check}): ${row.label}: ${row.why}`);
    const q = maybeQuarantine(root, row, { now, env, emit });
    if (q) { out.quarantined.push(q); log(q.status === 'active' ? `[flakes] ${row.test} is quarantined (${q.why}; autoQuarantine in ${q.auto}); the game's runner skips it via STUDIO_TEST_QUARANTINE until a game dev releases it` : `[flakes] ${row.test} is PROPOSED for quarantine (${q.why}); it still runs until a person confirms: npm run flakes -- confirm ${row.test} --by <name>`); }
    if (row.label === 'real' && !out.real) out.real = row.test;
    return row.label === 'real';
  };
  const notRunStop = (check, file, why, more, said) => {
    // Refused before it ran (busy): no label, and the rest would wait the same way.
    out.notRun = { test: normTestPath(file), check, why };
    log(`[flakes] ${normTestPath(file)} (${check}): ${said}: no label${more > 0 ? `; ${more} more failing file(s) not run alone either` : ''}; the train goes on`);
    stopAll(); // not again in this train (its next reds would wait the same way)
  };
  const realStop = () => {
    // One file red alone is enough: the red is real, and the train goes on to name the lane.
    const left = pairs.length - done;
    if (left > 0) { out.skipped = left; log(`[flakes] ${left} more failing test file(s) not run alone: ${out.real} fails alone, so this red is real; the train goes on`); }
    stopAll(); // nor on this train's later reds (its re-checks)
  };
  const single = (check, file, k, of) => {
    seen.add(`${check}|${file}`);
    done += 1;
    let l;
    try { l = labelTest({ check, file, runAlone: (a) => runAlone({ ...a, k, of }), rng: facts, env, redText: text, trust: trustOf(check, file) }); } catch (e) { if (e?.stopsTriage) throw e; log(`[flakes] ${file}: not triaged (${e.message})`); return 'next'; }
    if (!l.label) { notRunStop(check, file, l.notRun, pairs.length - done, l.why); return 'stop'; }
    return record(check, file, l) ? 'real' : 'next';
  };
  let stopped = false;
  for (let k = 0; k < units.length && !stopped; k += 1) {
    const u = units[k];
    if (u.file) { const r = single(u.check, u.file, k + 1, units.length); if (r === 'real') realStop(); stopped = r !== 'next'; continue; }
    for (const file of u.files) seen.add(`${u.check}|${file}`);
    const trusts = Object.fromEntries(u.files.map((file) => [file, trustOf(u.check, file)]));
    let g;
    try { g = labelGroup({ check: u.check, files: u.files, runAlone: (a) => runAlone({ ...a, file: a.files[0], k: k + 1, of: units.length }), rng: facts, env, redText: text, trusts, log }); } catch (e) { if (e?.stopsTriage) throw e; log(`[flakes] ${u.check}: ${u.files.length} files not triaged (${e.message})`); done += u.files.length; continue; }
    let real = false;
    for (const l of g.labels) { done += 1; if (record(u.check, l.file, l)) real = true; }
    if (g.notRun) { const left = u.files.filter((file) => !g.labels.some((l) => l.file === file)); done += left.length; notRunStop(u.check, left[0] || u.files[0], g.notRun, pairs.length - done, g.why); stopped = true; break; }
    if (real) { done += g.perFile.length; realStop(); stopped = true; break; }
    for (const file of g.perFile) {
      const r = single(u.check, file, k + 1, units.length);
      if (r === 'real') { realStop(); stopped = true; break; }
      if (r === 'stop') { stopped = true; break; }
    }
  }
  if (!out.real && !out.notRun && pairs.length > rules.maxFiles) log(`[flakes] ${pairs.length - rules.maxFiles} more failing test file(s) not triaged (STUDIO_FLAKE_MAX_FILES ${rules.maxFiles})`);
  out.allPortCollision = out.labels.length > 0 && !out.real && !out.notRun && pairs.length <= todo.length && out.labels.length === pairs.length && out.labels.every((r) => r.label === 'port-collision');
  // Every failing file is a port collision or load-sensitive, at least one a collision (the lanes wait, see the header).
  out.portCollisionWait = out.labels.length > 0 && !out.real && !out.notRun && pairs.length <= todo.length && out.labels.length === pairs.length && out.labels.every((r) => r.label === 'port-collision' || r.label === 'load-sensitive') && out.labels.some((r) => r.label === 'port-collision');
  if (out.labels.length) {
    try { emit({ type: 'test.flake_triage', agent: 'train', status: out.labels.some((r) => r.label === 'real') ? 'blocked' : 'warn', msg: `${train ? `train ${train}: ` : ''}failing tests run alone${units.some((x) => x.files) ? ' (a check\'s failing files together)' : ''}: ${out.labels.map((r) => `${r.test} ${r.label}${r.trusted ? ' (trusted)' : ''}${r.port ? ` (port ${r.port})` : ''}`).join(', ')}`.slice(0, 600), meta: { train, tree, labels: out.labels.map(({ test, check, label, port, trusted }) => ({ test, check, label, ...(port ? { port } : {}), ...(trusted ? { trusted: true } : {}) })) } }); } catch {}
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

/** One decision-log record (harness/decisions.mjs). Never throws. */
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
 * A game check's timeout-only red re-ran its files alone at low load (harness/game-gates.mjs): one "timeout-flake" row per
 * file that passed there ({ at, test, check, label, why, tree, runs }), then the same quarantine rule as every flaky label.
 * A file red alone isn't labelled here (the check stays red; the triager labels it). Never throws; returns the rows written.
 */
export function recordTimeoutFlakes(root, { check, files = [], why = '', text = '', tree = '', now = Date.now(), env = process.env, emit = emitEvent, log = () => {} } = {}) {
  const rows = [];
  for (const file of files) {
    // The check's output shows a port collision: that is why it timed out (never quarantined).
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

/** The digest's line for timeout-flakes in 24 h (from .studio/flakes.jsonl), or ''. */
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
  const tf = timeoutFlakeDigestLine(root, { now });
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

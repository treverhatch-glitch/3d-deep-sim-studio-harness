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
 * STUDIO_FLAKE_TRIAGE=off turns the triage off; STUDIO_FLAKE_MAX_FILES (5) caps the files triaged per red run.
 * Imports only small modules (train.mjs and game-gates.mjs import this one).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent } from './event.mjs';
import { focusFromLog, normTestPath } from './train-focus.mjs';
import { testRngFacts, gameFolder } from './test-rng.mjs';

export const FLAKES_REL = '.studio/flakes.jsonl';
export const QUARANTINE_REL = 'studio/quarantine.json';
export const FLAKY = Object.freeze(['load-flake', 'seed-flake', 'intermittent']);
const DAY = 86400000;
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
const num = (v, d) => (String(v ?? '').trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeAtomic = (f, text) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, text); fs.renameSync(t, f); };

export const triageOn = (env = process.env) => !off(env.STUDIO_FLAKE_TRIAGE);
export function flakeRules(env = process.env) {
  return { after: Math.max(1, Math.floor(num(env.STUDIO_FLAKE_QUARANTINE_AFTER, 3))), days: num(env.STUDIO_FLAKE_WINDOW_DAYS, 7), maxFiles: Math.max(1, Math.floor(num(env.STUDIO_FLAKE_MAX_FILES, 5))) };
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

/**
 * Label one failing test file: runAlone({ check, file, lowLoad }) -> { ok } runs it alone on the same tree.
 * Returns { label, why, runs: [{ ok, lowLoad }], rng }.
 */
export function labelTest({ check, file, runAlone, rng = null }) {
  const runs = [];
  const first = runAlone({ check, file, lowLoad: false });
  runs.push({ ok: Boolean(first?.ok), lowLoad: false });
  if (!first?.ok) return { label: 'real', why: 'fails when run alone on the same tree', runs, rng: [] };
  const found = rngFindingsFor(file, rng);
  if (found.length) return { label: 'seed-flake', why: `passes alone; the test uses randomness without a fixed seed (${found.slice(0, 2).join('; ')})`, runs, rng: found };
  const second = runAlone({ check, file, lowLoad: true });
  runs.push({ ok: Boolean(second?.ok), lowLoad: true });
  if (second?.ok) return { label: 'load-flake', why: 'passes alone, and again under low load (one test worker): it failed only beside other work', runs, rng: [] };
  return { label: 'intermittent', why: 'passes alone once, then fails alone under low load: flaky with no named cause', runs, rng: [] };
}

/**
 * After a red verify or re-check: label each failing test file (at most STUDIO_FLAKE_MAX_FILES; each once per `seen`
 * set, usually one per train), record the labels, and quarantine a test flaky `after` times in the window.
 * opts: { root, dir (the tree's checkout), text (the red run's output), train, tree, runAlone, seen, now, env, log,
 * emit, rng (test-rng facts; default: scanned in dir) }. Returns { labels: [row], quarantined: [entry] }.
 */
export function triageRed({ root, dir = root, text, train = '', tree = '', runAlone, seen = new Set(), now = Date.now(), env = process.env, log = () => {}, emit = emitEvent, rng } = {}) {
  const out = { labels: [], quarantined: [] };
  if (!triageOn(env) || typeof runAlone !== 'function') return out;
  const f = focusFromLog(text);
  const pairs = [];
  for (const check of f.failed) for (const file of f.files[check] || []) if (!seen.has(`${check}|${file}`)) pairs.push({ check, file });
  if (!pairs.length) return out;
  const rules = flakeRules(env);
  const facts = rng === undefined ? testRngFacts(dir, env) : rng;
  for (const { check, file } of pairs.slice(0, rules.maxFiles)) {
    seen.add(`${check}|${file}`);
    let l;
    try { l = labelTest({ check, file, runAlone, rng: facts }); } catch (e) { log(`[flakes] ${file}: not triaged (${e.message})`); continue; }
    const row = { at: new Date(now).toISOString(), test: normTestPath(file), check, label: l.label, why: l.why, train, tree, runs: l.runs, ...(l.rng.length ? { rng: l.rng } : {}) };
    try { appendFlake(root, row); } catch {}
    out.labels.push(row);
    log(`[flakes] ${row.test} (${check}): ${row.label}: ${row.why}`);
    const q = maybeQuarantine(root, row, { now, env, emit });
    if (q) { out.quarantined.push(q); log(q.status === 'active' ? `[flakes] ${row.test} is quarantined (${q.why}; autoQuarantine in ${q.auto}); the game's runner skips it via STUDIO_TEST_QUARANTINE until a game dev releases it` : `[flakes] ${row.test} is PROPOSED for quarantine (${q.why}); it still runs until a person confirms: npm run flakes -- confirm ${row.test} --by <name>`); }
  }
  if (pairs.length > rules.maxFiles) log(`[flakes] ${pairs.length - rules.maxFiles} more failing test file(s) not triaged (STUDIO_FLAKE_MAX_FILES ${rules.maxFiles})`);
  if (out.labels.length) {
    try { emit({ type: 'test.flake_triage', agent: 'train', status: out.labels.some((r) => r.label === 'real') ? 'blocked' : 'warn', msg: `${train ? `train ${train}: ` : ''}failing tests run alone: ${out.labels.map((r) => `${r.test} ${r.label}`).join(', ')}`.slice(0, 600), meta: { train, tree, labels: out.labels.map(({ test, check, label }) => ({ test, check, label })) } }); } catch {}
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
  emit({ type: 'test.quarantined', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} confirmed the quarantine of ${e.test} (${e.label}; ${e.why})${d.via !== 'person' ? ` (recorded by ${d.recordedBy} on ${d.by}'s permission)` : ''}: the game's runner skips it (STUDIO_TEST_QUARANTINE)`.slice(0, 600), meta: { test: e.test, label: e.label, status: 'active', confirmedBy: d.by, via: d.via, evidence: e.evidence || [], by: e.by || null } });
  return { ok: true, message: `Confirmed: ${e.test} is quarantined; the game's runner skips it from the next check. Release: npm run flakes -- release ${e.test} --by <name>.` };
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
  emit({ type: 'test.quarantine_released', agent: String(d.recordedBy || d.by).slice(0, 60), to: 'producer', msg: `${d.by} released ${e.test} from quarantine${d.via !== 'person' ? ` (recorded by ${d.recordedBy} on ${d.by}'s permission)` : ''}${why ? `: ${why}` : ''}`.slice(0, 600), meta: { test: e.test, by: d.by, via: d.via, recordedBy: d.recordedBy, permission: d.permission || null, entry: e } });
  return { ok: true, message: `Released ${e.test} from quarantine; the game's runner runs it again from the next check.` };
}

/** The digest's line: the harness's quarantine additions in 24 h, and how many tests are quarantined now. */
export function quarantineDigestLine(events, { now = Date.now(), root = null } = {}) {
  const added = (events || []).filter((e) => e.type === 'test.quarantined' && e.agent === 'harness' && (Date.parse(e.ts) || 0) >= now - DAY);
  const all = root ? readQuarantine(root) : [];
  const proposed = all.filter((e) => !isActive(e));
  const active = all.filter(isActive);
  if (!added.length && !all.length) return '';
  const head = added.length ? `The harness quarantined ${added.length} flaky test${added.length === 1 ? '' : 's'} in 24 h (autoQuarantine): ${added.slice(0, 3).map((e) => `${e.meta?.test || '?'} (${e.meta?.label || '?'}, ${(e.meta?.evidence || []).length} labels)`).join(', ')}${added.length > 3 ? ' …' : ''}.` : '';
  const prop = proposed.length ? `Proposed for quarantine, still running until you confirm: ${proposed.slice(0, 3).map((e) => `${e.test} (${e.label}, ${(e.evidence || []).length} labels)`).join(', ')}${proposed.length > 3 ? ' …' : ''} (npm run flakes -- confirm <test> --by <you>).` : '';
  const tail = active.length ? `${active.length} test${active.length === 1 ? '' : 's'} quarantined (${QUARANTINE_REL}; npm run flakes; release: npm run flakes -- release <test> --by <you>).` : '';
  return [head, prop, tail].filter(Boolean).join(' ');
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

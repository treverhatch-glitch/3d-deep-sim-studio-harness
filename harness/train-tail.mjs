/**
 * harness/train-tail.mjs — 2.67.0 (f): the proactive chain-tail fixer in the merge train (the owner's idea).
 *
 * A stacked chain (lanes linked by `task add --after` / `task block --until`, harness/train-deps.mjs) sometimes passes
 * only as a whole plus one more fix: train 13 bisected such a chain apart, handed back its first lane and landed one
 * lane; an outside agent then wrote the missing fix by hand (T-141). Now (STUDIO_TRAIN_CHAIN_TAIL, default on):
 *   1. when a train starts with a chain (or with lanes that declare pin moves, Pin-Moves:), BEFORE its verify it builds
 *      main + the chain in a second scratch copy and runs the chain's touched test files there (the 2.65.3 focus
 *      machinery: run-gates --only with STUDIO_GATE_FOCUS) and the pins' report on main and on the chain (the pin
 *      diff). Before, not beside: the verify is one blocking run holding a gate slot and, for a game, the
 *      machine:heavy lock, so a second suite beside it would wait for them or double the load (load-scaled timeouts,
 *      skewed ETAs) on the crew's 2-core-per-agent machines. The focused run is seconds to a minute, and the tail task
 *      is on the board before the verify starts, so a builder works on it while the verify runs;
 *   2. red there (and not something the train's own pin refresh fixes, tried in that copy): ONE "chain tail" task,
 *      a builder bug task stacked on the chain's last lane (--after it), its hand-off note naming the failing tests,
 *      the pin diff and how to bring the chain into the copy. Never a second one for the same chain and failure
 *      signature (.studio/train/chain-tails.json);
 *   3. the verify then red on exactly those tests: the whole chain is deferred, "waiting for its tail <ID>", nobody
 *      handed back, and later trains leave it out (no verify spent) until the tail is queued; then the chain and the
 *      tail go in together (the tail's --after keeps it behind the chain's last lane). Red on any other test: as
 *      before (pin refresh, prefix bisection).
 * The tail's own start is not held by its --after on the chain it fixes (harness/task-hold.mjs chainTail).
 * Code only: which tests failed, the signature and every decision come from the logs. Never imports train.mjs or
 * task.mjs (train.mjs imports this; the board operations come in as the train's deps).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { focusFromLog, focusCommand, normTestPath } from './train-focus.mjs';
import { boardStates } from './train-deps.mjs';
import { writeAtomic } from './fsafe.mjs';

/** STUDIO_TRAIN_CHAIN_TAIL (default on): off keeps 2.66.0 (no proactive check, no tail, a red chain bisects). */
export const chainTailOn = (env = process.env) => !/^(off|0|false|no)$/i.test(String(env.STUDIO_TRAIN_CHAIN_TAIL || '').trim());

const tailsFile = (root) => path.join(root, '.studio', 'train', 'chain-tails.json');

/** The chain tails the train filed: [{ key, sig, tail, chain, last, tests, pins, train, at, log, waiting? }]. */
export function readTails(root) {
  try { const j = JSON.parse(fs.readFileSync(tailsFile(root), 'utf8')); return Array.isArray(j) ? j : []; } catch { return []; }
}

/** Change the records (only the train calls this, under the train lock). */
export function updateTails(root, fn) {
  const list = readTails(root);
  const r = fn(list);
  const f = tailsFile(root);
  try {
    fs.mkdirSync(path.dirname(f), { recursive: true });
    writeAtomic(f, `${JSON.stringify(list, null, 2)}\n`);
  } catch {}
  return r;
}

/**
 * The chains among this train's lanes (in train order): the groups of lanes linked by --after dependencies within the
 * train, of two or more lanes, or of one lane that declares pin moves. pinsOf(lane) -> [pins]; tails: the records (a
 * recorded tail in a group is part of it, not of its key). Returns [{ lanes, tasks, key, core, last, pins }].
 */
export function trainChains(set, depMap, { pinsOf = () => [], tails = [] } = {}) {
  const idx = new Map(set.map((l, i) => [l.task, i]));
  const parent = set.map((_, i) => i);
  const find = (i) => { while (parent[i] !== i) { parent[i] = parent[parent[i]]; i = parent[i]; } return i; };
  for (const l of set) for (const d of depMap?.get?.(l.task) || []) if (idx.has(d)) parent[find(idx.get(l.task))] = find(idx.get(d));
  const groups = new Map();
  set.forEach((l, i) => { const r = find(i); groups.set(r, [...(groups.get(r) || []), l]); });
  const tailIds = new Set(tails.map((t) => t.tail));
  const out = [];
  for (const lanes of groups.values()) {
    const pins = {};
    for (const l of lanes) { const p = pinsOf(l) || []; if (p.length) pins[l.task] = p; }
    if (lanes.length < 2 && !Object.keys(pins).length) continue;
    const coreLanes = lanes.filter((l) => !tailIds.has(l.task));
    const core = (coreLanes.length ? coreLanes : lanes).map((l) => l.task);
    out.push({ lanes, tasks: lanes.map((l) => l.task), core, key: [...core].sort().join(','), last: lanes[lanes.length - 1], pins });
  }
  return out;
}

/** A test file by its path: under a tests/ or __tests__/ folder, or named *.test.* / *.spec.*. */
export const isTestFile = (f) => /(^|\/)(__tests__|tests?)\//.test(f) || /[._-](test|spec)\.[A-Za-z0-9]+$/.test(f);

/** The test files among a chain's changed files (inside the game's folder when there is one). */
export function touchedTests(files, gameRoot = null) {
  return [...new Set((files || []).map((f) => String(f).replace(/\\/g, '/')).filter((f) => (!gameRoot || f.startsWith(`${gameRoot}/`)) && isTestFile(f)))];
}

const esc = (s) => String(s).replace(/[.+^${}()|[\]\\?*]/g, '\\$&');
/** Does a game check's command run from the game's folder (cd <game> && ..., npm --prefix <game> ...)? */
export const runsInGameFolder = (command, gameRoot) => Boolean(gameRoot) && new RegExp(`(^|&&|;)\\s*cd\\s+["']?(\\./)?${esc(gameRoot)}/?["']?\\s*(&&|;)|--prefix[= ]["']?(\\./)?${esc(gameRoot)}/?["']?(\\s|$)`).test(String(command || '').replace(/\\/g, '/'));

/**
 * The STUDIO_GATE_FOCUS map that runs these test files in each game check that can run single files (its manifest
 * "focus" command, or a clear vitest/jest/node --test command): { focus | null, skipped: [{ id, why }] }. Paths are
 * given from the game's folder when the check's command runs there.
 */
export function chainFocus(gates, files, gameRoot = null) {
  const focus = {};
  const skipped = [];
  if (!files.length) return { focus: null, skipped };
  for (const g of gates || []) {
    if (!g?.id || !g.command) continue;
    const rel = files.map((f) => (runsInGameFolder(g.command, gameRoot) && f.startsWith(`${gameRoot}/`) ? f.slice(gameRoot.length + 1) : f)).map((f) => normTestPath(f));
    const fc = focusCommand(g, rel);
    if (fc.cmd) focus[`game:${g.id}`] = rel;
    else skipped.push({ id: `game:${g.id}`, why: fc.why });
  }
  return { focus: Object.keys(focus).length ? focus : null, skipped };
}

/** The failing tests a run's log names, as "<check>: <test>" (or "<check>: <file>" when only files are named). */
export function failingTests(text) {
  const f = focusFromLog(text);
  const tests = [];
  for (const id of f.failed) {
    const names = f.tests[id] || [];
    if (names.length) for (const n of names) tests.push(`${id}: ${n}`);
    else for (const x of f.files[id] || []) tests.push(`${id}: ${x}`);
  }
  return { tests: [...new Set(tests)], checks: f.failed };
}

/** A failing test's identity: its check and name, without the message after the name ("…: expected 10, got 11"). */
export const testKey = (t) => String(t).split(': ').slice(0, 2).join(': ').replace(/\s+/g, ' ').trim();

/** The failure signature of a chain: the sorted failing tests (else the failing checks), hashed. */
export function tailSignature(tests, checks = []) {
  const base = tests.length ? tests.map(testKey) : checks.map((c) => `check ${c}`);
  return crypto.createHash('sha1').update([...new Set(base)].sort().join('\n')).digest('hex').slice(0, 10);
}

/**
 * Do these red-verify tests all belong to the chain tails found red in this train? Returns the tails whose tests
 * explain every failing test ([] when one is unexplained, or the verify names none).
 */
export function tailsExplaining(verifyTests, tails = []) {
  if (!verifyTests.length || !tails.length) return [];
  const keys = verifyTests.map(testKey);
  const used = tails.filter((t) => keys.some((k) => (t.tests || []).map(testKey).includes(k)));
  const covered = new Set(used.flatMap((t) => (t.tests || []).map(testKey)));
  return keys.every((k) => covered.has(k)) ? used : [];
}

const listWords = (a, cap = 3) => `${a.slice(0, cap).join('; ')}${a.length > cap ? ` (+${a.length - cap} more)` : ''}`;

/** The tail task's title (a builder bug task). */
export function tailTitle(core, tests, checks = []) {
  const what = tests.length ? listWords(tests.map(testKey), 2) : checks.join(', ') || 'its checks';
  return `Bug: chain tail for ${core.join(', ')}: ${what} fail only on the combined chain`.slice(0, 200);
}

/** One line per moved pin: "total: 1 -> 4 (declared by T-1, T-2)" / "(NOT declared)" / "(an invariant)". */
export const pinDiffLines = (moved = []) => moved.map((m) => `${m.pin}: ${m.from} -> ${m.to} (${m.invariant ? 'an invariant pin: never refreshed' : m.declaredBy.length ? `declared by ${m.declaredBy.join(', ')}` : 'NOT declared by any lane of the chain'})`);

/** The tail's hand-off note (studio/handoffs/<tail>.md): what failed, the pin diff, and how to work it. */
export function tailNote({ tail, train, chain, tests, checks, pins, log, main, pinsRun }) {
  const L = [
    `# ${tail}: chain tail for ${chain.map((c) => c.task).join(', ')} (filed by merge train ${train})`,
    '',
    `Before its verify, the merge train built ${main} + the chain (${chain.map((c) => c.task).join(', then ')}) in a scratch copy and ran the chain's touched test files${pinsRun ? ' and the pins\' report' : ''} there. These fail on the combined tree (and the train's own pin refresh doesn't fix them):`,
    ...(tests.length ? tests.map((t) => `- ${t}`) : checks.map((c) => `- ${c} (failed without naming a test)`)),
    '',
    pins?.length ? `Pin diff (${main} -> ${main} + the chain, from the pins' report):` : pinsRun ? 'Pin diff: no pinned value moved.' : 'Pin diff: the game declares no pins.',
    ...(pins?.length ? pinDiffLines(pins).map((l) => `- ${l}`) : []),
    '',
    `Log: ${log}`,
    '',
    `How to work it: your copy starts from ${main}. Bring the chain in first, in order:`,
    ...chain.map((c) => `    git merge --no-edit ${c.head}   # ${c.task}`),
    `Then fix the failing tests there (without undoing the chain's changes), commit the fix, run npm run verify, and queue it: npm run task -- done ${tail} --train.`,
    `This task is stacked on ${chain[chain.length - 1].task} (--after). Until it is queued the chain waits for it (nobody is handed back); then the train lands the chain and this tail together.`,
    '',
  ];
  return L.join('\n');
}

/** Why a chain lane waits for its tail (deferral and upfront wait). */
export const tailWaitWhy = (r) => `it is part of the chain ${(r.chain || []).join(', ')}, waiting for its tail ${r.tail} (the chain fails ${listWords((r.tests || []).map(testKey), 2) || 'its checks'} without it); the chain and ${r.tail} go in together once ${r.tail} is queued. Nobody is handed back`;

/**
 * The chains still waiting for an open tail, for `npm run lanes`: one note each. A tail done (landed) or no longer on
 * the board ends the wait.
 */
export function chainTailNotes(root) {
  if (!chainTailOn()) return [];
  const recs = readTails(root).filter((r) => r.waiting && r.tail);
  if (!recs.length) return [];
  const st = boardStates(root) || { open: new Set(), done: new Set() };
  return recs.filter((r) => st.open.has(r.tail) && !st.done.has(r.tail)).map((r) => `chain ${r.chain.join(', ')} waits for its tail ${r.tail} (chain tail, train ${r.train}: ${listWords((r.tests || []).map(testKey), 2) || 'its checks'}); it lands with ${r.tail} once ${r.tail} is queued (task done ${r.tail} --train)`);
}

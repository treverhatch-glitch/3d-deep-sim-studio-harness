/**
 * harness/handback-facts.mjs — hand-back facts written by the harness, ahead of the agent's prose.
 *
 * Compressed hand-offs lose the artifact trail first (which files changed, what ran, what failed). So every hand-back (task pause, the merge train's drop, the watcher, a session that ended
 * holding its task) starts with a block the harness writes from git and the gate logs, never from the agent:
 *
 *   Hand-back facts (written by the harness from git and the gate logs; the note after them is the agent's or the train's):
 *   - Changed files since <base> (N): a, b, … (+K more)        git diff --name-only <task base>, plus untracked files
 *   - Gates run (<where>, <when>): PASS x, FAIL y               the newest gate run since the task started
 *   - Failure signature: <gate>: <first failing test line> [sig <hash>]
 *   - Failing sub-ids: game:test:<file>, golden:<file>, …        which parts failed (harness/gate-subids.mjs)
 *   - First divergence: tick N, <subsystem>.<field> a -> b      a red golden's (harness/divergence.mjs)
 *   - Timeout-flakes: <files>                                   timed out, passed alone at low load
 *   - Failing seed: <n>                                         only when the log names one
 *   - Test randomness (advisory|required): N finding(s): …      harness/test-rng.mjs, only when it finds any
 *   - Last verify log: <path>
 *   - Lane: <paths> (copy .lanes/<agent>, branch <b>)          from studio/task-holds.json / the task's add
 *   - Commits since <base> (N): <sha> <subject>; …; and K more  git log, the task's own copy (or --grep <ID>)
 *   - Last verify: green|red (<failing gate>) | not run         from the gate evidence above
 *   - Next command: <the exact command to run next>             from the above, never from the note
 *     (the last four lines (Lane to Next command) are left out of the merge train's drop note, whose reason names its own next step)
 *   End of hand-back facts.
 *
 * Where the gate evidence comes from, newest wins: a log the note itself names ("Full log: …" / "Log: …", the train's
 * verify), a refused `task done` (recordGateRefusal, .studio/handback-facts/<task>.json), the holder's own verify
 * record (.studio/gates/<owner>[-full].json with .studio/verify-running/<owner>.*.log or .studio/gates/out/<gate>.log).
 * Facts never block a hand-back: any failure leaves the note as it was. A note that already has the block is unchanged.
 * The block is compact (FACTS_MAX; at most FILES_SHOWN files and COMMITS_CAP commits listed, fewer when it doesn't fit,
 * the rest as "(+K more)" / "and K more"): task pause cuts the prose
 * after it so the whole entry stays under its cap (task.mjs HANDBACK_ENTRY_MAX).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { testRngFacts } from './test-rng.mjs';
import { subIdsFromLog } from './gate-subids.mjs';
import { divergenceFromLog, divergenceText } from './divergence.mjs';
import { timeoutFlakesFromLog } from './timeout-rerun.mjs';
import { seenBefore, seenLine } from './error-memory.mjs';
import { laneOf } from './task-hold.mjs';
import { readJson } from './fsafe.mjs';
import { noteMissingPaths, noteMissingLine, recordNoteUnverified } from './said-vs-did.mjs';

export const FACTS_HEAD = 'Hand-back facts (written by the harness from git and the gate logs; the note after them is the agent\'s or the train\'s):';
export const FACTS_END = 'End of hand-back facts.';
export const FILES_CAP = 30;
export const COMMITS_CAP = 5;
// The block must fit the hand-back's own cap (task.mjs HANDBACK_ENTRY_MAX, under 3k with the prose), so it is
// kept compact: at most FILES_SHOWN files and COMMITS_CAP commits listed ("and N more"), lines and the whole block capped.
export const FILES_SHOWN = 12;
export const FACTS_MAX = 1600;
// Fewer files and commits listed, in turn, until the block fits FACTS_MAX (then compactFacts shortens lines).
const LIST_STEPS = [[FILES_SHOWN, COMMITS_CAP], [8, 4], [5, 3], [3, 2]];
const SUBJECT_MAX = 72;
const REFUSALS_DIR = () => path.join(STUDIO_STATE_DIR, 'handback-facts');
const BOOKKEEPING = /^(studio|\.studio|\.lanes|node_modules|qa\/reports)(\/|$)/;
const slash = (p) => String(p || '').split(path.sep).join('/');
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const git = (cwd, ...a) => spawnSync('git', a, { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const mainRootOf = () => (process.env.STUDIO_MAIN_ROOT ? path.resolve(process.env.STUDIO_MAIN_ROOT) : REPO_ROOT);
const safeName = (s) => String(s || '').replace(/[^\w.-]/g, '_');

/** The commit and time a task started from: its first task.start since it was last done or reopened (done-check's taskBase). */
export function taskStart(taskId) {
  let start = null;
  for (const e of readRecentEvents(20000)) {
    if (e.task !== taskId) continue;
    if (e.type === 'task.done' || e.type === 'task.forced' || e.type === 'task.reopened') start = null;
    else if (e.type === 'task.start' && !start) start = { head: e.meta?.head || null, at: Date.parse(e.ts) || 0 };
  }
  return start;
}

/** Where the task's work is: the given dir, the holder's lane copy (its session record, or .lanes/<agent>), else this checkout. */
export function workDir(agent, dir = null) {
  if (dir && fs.existsSync(dir)) return dir;
  const root = mainRootOf();
  if (agent && /^[\w.-]+$/.test(agent)) {
    const s = readJson(path.join(STUDIO_STATE_DIR, 'agents', `${agent}.json`));
    const fromSession = s?.copy?.dir ? path.join(root, s.copy.dir) : null;
    if (fromSession && fs.existsSync(path.join(fromSession, '.git'))) return fromSession; // a lane has its own .git
    const lane = path.join(root, '.lanes', agent);
    if (fs.existsSync(path.join(lane, '.git'))) return lane;
  }
  return REPO_ROOT;
}

/** Files the task changed against its base (committed, uncommitted and untracked), bookkeeping left out. */
export function changedFiles(dir, base) {
  if (!base || git(dir, 'cat-file', '-e', `${base}^{commit}`).status !== 0) return null;
  const d = git(dir, 'diff', '--name-only', base);
  if (d.status !== 0) return null;
  const extra = git(dir, 'ls-files', '--others', '--exclude-standard');
  const all = [...new Set([...d.stdout.split('\n'), ...(extra.status === 0 ? extra.stdout.split('\n') : [])].map((f) => f.trim().replace(/^"|"$/g, '')).filter((f) => f && !BOOKKEEPING.test(f)))].sort();
  return { files: all.slice(0, FILES_CAP), total: all.length };
}

const ANSI = /\u001b\[[0-9;?]*[ -/]*[@-~]/g;
/** One log line as a stable, readable signature: no colours, times, durations, temp paths or runs of space; at most 160 characters. */
export function normaliseLine(line) {
  return String(line || '')
    .replace(ANSI, '')
    .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z?/g, '<time>')
    .replace(/\(?\b\d+(\.\d+)?\s?(ms|s|sec|seconds)\b\)?/g, '')
    .replace(/(?:[A-Za-z]:)?[\\/](?:[\w .-]+[\\/])+([\w.-]+)/g, '$1')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 160);
}
const hash = (s) => crypto.createHash('sha1').update(String(s)).digest('hex').slice(0, 8);
/** The signature's key: the gate and the line with numbers and hex ids taken out (two runs of one failure match). */
export const signatureKey = (gate, line) => hash(`${gate}|${String(line || '').replace(/\b[0-9a-f]{7,40}\b/gi, '#').replace(/\d+(\.\d+)?/g, '#')}`);

const FAILING = /(^|\s)(FAIL(ED)?|✗|✕|×|not ok)(\s|:|$)|\b\w*Error:|\bAssertion|\bassert(ion)? failed|\bpanic:/i;
const NOT_FAILING = /\b0 fail(ed|ures?)?\b|\bfail(ed|ures?)?:?\s*0\b|^\s*$/i;
const HARNESS_LINE = /^\s*\[(gates|train|task done|game-gates|done)\]/;
const SEED = /(?:--seed[= ]|\bseed\b["']?\s*[=:]?\s*["']?)(0x[0-9a-f]+|-?\d+)/i;

/**
 * What a verify's output says: { gates: [{ id, ok }], failGate, failLine, seed }. Gates from run-gates' own lines
 * ("[gates] PASS x" / "[gates] FAIL x"); the failing line from the first failing gate's own output (the lines before
 * its "[gates] FAIL" line, or after its compact "[gates] <id> output" header), else the whole text.
 */
export function readGateLog(text) {
  const lines = String(text || '').replace(/\r/g, '').split('\n').map((l) => l.replace(ANSI, ''));
  const gates = [];
  const seen = new Set();
  let firstFail = -1;
  let prevStatus = -1;
  let failSeg = [];
  lines.forEach((l, i) => {
    const m = l.match(/^\[gates\] (PASS|FAIL|WARN) (\S+)/);
    if (!m) return;
    if (!seen.has(m[2])) { seen.add(m[2]); gates.push({ id: m[2], ok: m[1] !== 'FAIL', ...(m[1] === 'WARN' ? { optional: true } : {}) }); }
    if (m[1] === 'FAIL' && firstFail === -1) {
      firstFail = i;
      failSeg = lines.slice(prevStatus + 1, i);
      const hdr = lines.findIndex((x, j) => j > i && new RegExp(`^\\[gates\\] ${m[2].replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} output`).test(x));
      if (hdr !== -1) { const end = lines.findIndex((x, j) => j > hdr && /^\[gates\] /.test(x)); failSeg = failSeg.concat(lines.slice(hdr + 1, end === -1 ? undefined : end)); }
    }
    prevStatus = i;
  });
  const failGate = firstFail === -1 ? null : gates.find((g) => !g.ok)?.id || null;
  const pick = (seg) => seg.find((l) => FAILING.test(l) && !NOT_FAILING.test(l) && !HARNESS_LINE.test(l)) || seg.find((l) => FAILING.test(l) && !NOT_FAILING.test(l) && !/^\[gates\] (PASS|FAIL|WARN) /.test(l)) || null;
  const failLine = failGate ? pick(failSeg) || pick(lines) : pick(lines);
  const seedIn = (seg) => { for (const l of seg) { const m = l.match(SEED); if (m) return m[1]; } return null; };
  const seed = seedIn(failSeg) || seedIn(lines);
  // Which parts failed (sub-ids), a red golden's first divergence, files that were timeout-flakes.
  const subIds = subIdsFromLog(text, { roots: [REPO_ROOT, mainRootOf()] });
  const divergence = divergenceFromLog(text)[0] || null;
  const timeoutFlakes = [...new Set(Object.values(timeoutFlakesFromLog(text)).flat())];
  return { gates, failGate, failLine: failLine ? normaliseLine(failLine) : null, seed, subIds, divergence, timeoutFlakes };
}

/** A refused `task done` (its game checks failed): kept so the task's next hand-back carries what failed. */
export function recordGateRefusal(taskId, { gates = [], text = '', log = null } = {}) {
  try {
    fs.mkdirSync(REFUSALS_DIR(), { recursive: true });
    fs.writeFileSync(path.join(REFUSALS_DIR(), `${safeName(taskId)}.json`), JSON.stringify({ at: new Date().toISOString(), task: taskId, gates: gates.map((g) => ({ id: g.id, ok: Boolean(g.ok) })), text: String(text || '').slice(-8000), log }, null, 2));
  } catch { /* evidence only */ }
}

/** The holder's newest verify since `since`: { at, gates, text, log, where } or null. */
function ownVerify(agent, since) {
  if (!agent || !/^[\w.-]+$/.test(agent)) return null;
  const gdir = path.join(STUDIO_STATE_DIR, 'gates');
  const recs = [`${agent}-full.json`, `${agent}.json`].map((n) => ({ file: path.join(gdir, n), rec: readJson(path.join(gdir, n)) })).filter((x) => x.rec && Array.isArray(x.rec.rows));
  const best = recs.sort((a, b) => (Date.parse(b.rec.at) || 0) - (Date.parse(a.rec.at) || 0))[0];
  if (!best || (Date.parse(best.rec.at) || 0) < since) return null;
  const at = Date.parse(best.rec.at) || 0;
  const gates = best.rec.rows.map((r) => ({ id: r.id, ok: Boolean(r.ok) || r.required === false }));
  // Its output: the detached run's own log (all of it), else the failing gate's compact log; either from this run.
  const vdir = path.join(STUDIO_STATE_DIR, 'verify-running');
  let runLog = null;
  try {
    const esc = agent.replace(/[.\\-]/g, '\\$&');
    const mine = new RegExp(`^${esc}\\.[0-9a-z]+-\\d+\\.log$`);
    runLog = fs.readdirSync(vdir).filter((f) => mine.test(f)).map((f) => path.join(vdir, f)).filter((f) => mtime(f) >= since && Math.abs(mtime(f) - at) < 3600000).sort((a, b) => mtime(b) - mtime(a))[0] || null;
  } catch { /* no detached runs */ }
  const failed = gates.find((g) => !g.ok);
  const outLog = failed ? path.join(gdir, 'out', `${safeName(failed.id)}.log`) : null;
  const outOk = outLog && mtime(outLog) >= since && mtime(outLog) <= at + 60000;
  const text = runLog ? readText(runLog) : outOk ? `${readText(outLog) || ''}\n[gates] FAIL ${failed.id}` : '';
  return { at, gates, text: text || '', log: slash(path.relative(path.dirname(STUDIO_STATE_DIR), runLog || (outOk ? outLog : best.file))), where: `${agent}'s verify` };
}

/**
 * The cause of a session's newest verify since `since` (its own record, .studio/gates/<agent>[-full].json):
 * { at, ok, gates (the failing ids), failGate, line, key, log } or null when it ran none. `key` names the cause: the
 * failing gate and its first failing line (signatureKey), so the same red seen again has the same key.
 */
export function verifyCause(agent, since = 0) {
  const v = ownVerify(agent, since);
  if (!v) return null;
  const r = readGateLog(v.text);
  const fails = v.gates.filter((g) => !g.ok).map((g) => g.id);
  const failGate = fails[0] || r.failGate || null;
  const ok = !fails.length;
  return { at: v.at, ok, gates: fails, failGate, line: ok ? null : r.failLine || null, key: ok ? null : signatureKey(failGate || '', r.failLine || ''), log: v.log };
}

/**
 * The commits the task made: in its own copy every commit since the task's start (merges of main left out),
 * in the shared checkout only those naming the task. { list: [{ sha, subject }], total } or null when git can't say.
 */
export function taskCommits(dir, base, taskId, { shared = false } = {}) {
  const range = base && git(dir, 'cat-file', '-e', `${base}^{commit}`).status === 0 ? `${base}..HEAD` : null;
  if (!range) return null;
  const r = git(dir, 'log', '--no-merges', '--format=%h%x09%s', ...(shared ? ['--grep', String(taskId), '--fixed-strings'] : []), range);
  if (r.status !== 0) return null;
  const all = r.stdout.split('\n').filter(Boolean).map((l) => { const [sha, ...rest] = l.split('\t'); const subject = rest.join('\t'); return { sha, subject: subject.length > SUBJECT_MAX ? `${subject.slice(0, SUBJECT_MAX - 1)}…` : subject }; }).reverse();
  return { list: all.slice(-COMMITS_CAP), total: all.length };
}

/** The task's lane (task-holds / its add) and the branch of the copy it works in. */
function laneFacts(taskId, cwd) {
  let paths = null;
  try { paths = laneOf(taskId); } catch { paths = null; }
  const inCopy = path.resolve(cwd) !== path.resolve(mainRootOf()) && fs.existsSync(path.join(cwd, '.git'));
  const branch = inCopy ? String(git(cwd, 'symbolic-ref', '--short', 'HEAD').stdout || '').trim() || null : null;
  return { paths, copy: inCopy ? slash(path.relative(mainRootOf(), cwd)) : null, branch };
}

/** The exact next command, from the harness's facts only. */
export function nextCommand(f) {
  const id = f.task;
  const red = (f.gates || []).find((g) => !g.ok);
  if (red) return `fix ${red.id}${f.log ? ` (log: ${f.log})` : ''}, then npm run verify -- --only ${red.id}, then npm run verify`;
  if (f.gates?.length && (f.commits?.total || 0) > 0) return `node harness/task.mjs done ${id} --agent $STUDIO_LOCK_OWNER --check, then node harness/task.mjs done ${id} --agent $STUDIO_LOCK_OWNER`;
  if (f.gates?.length) return `commit the work (nothing committed since the task started), then node harness/task.mjs done ${id} --agent $STUDIO_LOCK_OWNER --check`;
  if ((f.commits?.total || 0) > 0 || (f.total || 0) > 0) return 'npm run verify (in the foreground)';
  return `node harness/task.mjs show ${id} (nothing changed or verified yet: start from the brief)`;
}

/**
 * The facts for a hand-back of `taskId`: { base, files, total, gates, where, at, signature, seed, log }.
 * `opts`: { agent, dir, note (a log it names is read), root (what that log is relative to), now }.
 */
export function buildFacts(taskId, { agent = null, dir = null, note = '', root = null, withNext = true } = {}) {
  const start = taskStart(taskId);
  const since = start?.at || 0;
  const cwd = workDir(agent, dir);
  const ch = start?.head ? changedFiles(cwd, start.head) : null;
  const cands = [];
  // A log the note names (the train's "Full log: …").
  const named = String(note || '').match(/\b(?:Full log|Log): ([^\s(][^\s]*?)\.?(?=\s|$)/);
  if (named) {
    const base = root || mainRootOf();
    const f = path.isAbsolute(named[1]) ? named[1] : path.join(base, named[1]);
    const text = readText(f);
    if (text !== null) cands.push({ at: mtime(f) || Date.now(), text, log: slash(named[1]), where: /train/.test(named[1]) ? 'the merge train\'s verify' : 'the verify the note names', explicit: true });
  }
  const ref = readJson(path.join(REFUSALS_DIR(), `${safeName(taskId)}.json`));
  if (ref && (Date.parse(ref.at) || 0) >= since) cands.push({ at: Date.parse(ref.at) || 0, gates: ref.gates, text: `${ref.text || ''}\n${(ref.gates || []).map((g) => `[gates] ${g.ok ? 'PASS' : 'FAIL'} ${g.id}`).join('\n')}`, log: ref.log || null, where: 'the refused task done' });
  const own = ownVerify(agent, since);
  if (own) cands.push(own);
  const best = cands.find((c) => c.explicit) || cands.sort((a, b) => b.at - a.at)[0] || null;
  let gates = [];
  let signature = null;
  let seed = null;
  let parts = { subIds: [], divergence: null, timeoutFlakes: [] };
  if (best) {
    const r = readGateLog(best.text);
    gates = best.gates?.length ? best.gates : r.gates;
    const failGate = gates.find((g) => !g.ok)?.id || r.failGate;
    if (failGate || r.failLine) signature = { gate: failGate || null, line: r.failLine, key: signatureKey(failGate || '', r.failLine || '') };
    seed = r.seed;
    parts = { subIds: gates.some((g) => !g.ok) ? r.subIds : [], divergence: r.divergence, timeoutFlakes: r.timeoutFlakes };
  }
  // The game's test-randomness findings in the task's copy (advisory unless the game requires it).
  const testRng = testRngFacts(cwd);
  // The same red fixed before (harness/error-memory.mjs).
  let seen = null;
  try { seen = signature ? seenBefore(signature.key) : null; } catch { seen = null; }
  // Lane, commits and the next command, so a refresh never starts from scratch.
  // The merge train's drop note names its own next step (make a clean lane, fix the red): it keeps the block without them.
  let lane = null;
  let commits = null;
  if (withNext) {
    try { lane = laneFacts(taskId, cwd); } catch { lane = null; }
    try { commits = start?.head ? taskCommits(cwd, start.head, taskId, { shared: !lane?.copy }) : null; } catch { commits = null; }
  }
  // 2.85 (g): a file the note says it made or changed that is nowhere (the lane, main): said, never refused.
  let noteMissing = [];
  try { noteMissing = noteMissingPaths(note, [cwd, mainRootOf()]); } catch { noteMissing = []; }
  return { ...(noteMissing.length ? { noteMissing } : {}), ...(seen ? { seenBefore: seen } : {}), ...(withNext ? { lane, commits } : {}), task: taskId, base: start?.head || null, files: ch?.files || null, total: ch?.total ?? null, gates, where: best?.where || null, at: best?.at || null, signature, seed, log: best?.log || null, ...(testRng ? { testRng } : {}), ...(parts.subIds.length ? { subIds: parts.subIds } : {}), ...(parts.divergence ? { divergence: parts.divergence } : {}), ...(parts.timeoutFlakes.length ? { timeoutFlakes: parts.timeoutFlakes } : {}) };
}

/** The block, as written into the hand-back: at most FACTS_MAX characters (lists shortened first, then lines). */
export function renderFacts(f) {
  let lines = null;
  for (const [files, commits] of LIST_STEPS) {
    lines = factLines(f, { filesShown: files, commitsShown: commits });
    if (lines.join('\n').length <= FACTS_MAX) return lines.join('\n');
  }
  return compactFacts(lines);
}

function factLines(f, { filesShown = FILES_SHOWN, commitsShown = COMMITS_CAP } = {}) {
  const hhmm = (ms) => (ms ? `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC` : '');
  const L = [FACTS_HEAD];
  L.push(f.files === null
    ? `- Changed files: unknown (${f.base ? `start commit ${String(f.base).slice(0, 8)} isn't in this checkout` : 'no start commit recorded'})`
    : `- Changed files since ${String(f.base).slice(0, 8)} (${f.total}): ${f.files.length ? `${f.files.slice(0, filesShown).join(', ')}${f.total > Math.min(f.files.length, filesShown) ? ` (+${f.total - Math.min(f.files.length, filesShown)} more)` : ''}` : 'none'}`);
  L.push(f.gates.length ? `- Gates run (${f.where}${f.at ? `, ${hhmm(f.at)}` : ''}): ${f.gates.map((g) => `${g.ok ? 'PASS' : 'FAIL'} ${g.id}`).join(', ')}` : '- Gates run: none recorded since the task started');
  L.push(f.signature ? `- Failure signature: ${f.signature.gate ? `${f.signature.gate}: ` : ''}${f.signature.line || '(no failing line found in the log)'} [sig ${f.signature.key}]` : '- Failure signature: none');
  if (f.subIds?.length) L.push(`- Failing sub-ids: ${f.subIds.slice(0, 10).join(', ')}${f.subIds.length > 10 ? ` (+${f.subIds.length - 10} more)` : ''}`);
  if (f.divergence) L.push(`- First divergence: ${divergenceText(f.divergence)}${f.divergence.ref ? ` vs ${String(f.divergence.ref).slice(0, 8)}` : ''}`);
  if (f.timeoutFlakes?.length) L.push(`- Timeout-flakes (timed out, passed alone at low load; not counted against the lane): ${f.timeoutFlakes.slice(0, 5).join(', ')}`);
  if (f.seenBefore) L.push(`- Seen before: ${seenLine(f.seenBefore).replace(/^seen before: /, '')}`);
  if (f.seed !== null && f.seed !== undefined) L.push(`- Failing seed: ${f.seed}`);
  if (f.testRng?.count) L.push(`- Test randomness (${f.testRng.mode === 'required' ? 'required' : 'advisory'}, node harness/test-rng.mjs): ${f.testRng.count} finding(s): ${f.testRng.items.slice(0, 5).join(', ')}${f.testRng.count > 5 ? ` (+${f.testRng.count - 5} more)` : ''}`);
  L.push(`- Last verify log: ${f.log || 'none'}`);
  // Lane, commits, verdict and the next command (absent in a block built by an older harness).
  if (f.lane !== undefined) L.push(`- Lane: ${f.lane?.paths || 'none (the whole game)'}${f.lane?.copy ? ` (copy ${f.lane.copy}${f.lane.branch ? `, branch ${f.lane.branch}` : ''})` : ''}`);
  if (f.commits !== undefined) {
    const shown = f.commits ? f.commits.list.slice(-commitsShown) : [];
    L.push(f.commits === null ? '- Commits: unknown (no start commit in this checkout)' : `- Commits since ${String(f.base).slice(0, 8)} (${f.commits.total}): ${f.commits.total ? `${shown.map((c) => `${c.sha} ${c.subject}`).join('; ')}${f.commits.total > shown.length ? `; and ${f.commits.total - shown.length} more (older)` : ''}` : 'none'}`);
  }
  if (f.lane !== undefined) {
    const red = (f.gates || []).find((g) => !g.ok);
    L.push(`- Last verify: ${!f.gates?.length ? 'not run since the task started' : red ? `red (${(f.gates || []).filter((g) => !g.ok).map((g) => g.id).join(', ')})` : 'green'}${f.where ? ` (${f.where})` : ''}`);
    L.push(`- Next command: ${nextCommand(f)}`);
  }
  for (const p of (f.noteMissing || []).slice(0, 3)) L.push(`- ${noteMissingLine(p)}`);
  L.push(FACTS_END);
  return L;
}

/**
 * The block at most FACTS_MAX characters, so the hand-back (facts and prose) stays under its cap: long lines are
 * shortened first (to 200, then 120 characters), then the optional lines go (sub-ids, divergence, flakes, seen before,
 * test randomness), then the rest is cut; the head and the end line always stay.
 */
function compactFacts(lines) {
  const join = (ls) => ls.join('\n');
  if (join(lines).length <= FACTS_MAX) return join(lines);
  const clip = (l, n) => (l.length > n ? `${l.slice(0, n - 1)}…` : l);
  const body = lines.slice(1, -1);
  for (const n of [200, 120]) {
    const ls = [lines[0], ...body.map((l) => clip(l, n)), FACTS_END];
    if (join(ls).length <= FACTS_MAX) return join(ls);
  }
  const optional = /^- (Failing sub-ids|First divergence|Timeout-flakes|Seen before|Test randomness)/;
  const kept = body.filter((l) => !optional.test(l)).map((l) => clip(l, 120));
  const out = [lines[0]];
  for (const l of kept) if (join([...out, l, FACTS_END]).length <= FACTS_MAX) out.push(l);
  return join([...out, FACTS_END]);
}

/** The facts block for a hand-back of `taskId` ('' when the note already has one or the facts can't be read). */
export function factsFor(taskId, note, opts = {}) {
  const text = String(note || '');
  if (text.includes(FACTS_HEAD)) return '';
  try {
    const f = buildFacts(taskId, { ...opts, note: text });
    if (f.noteMissing?.length) recordNoteUnverified(taskId, f.noteMissing, { agent: opts.agent, where: 'hand-back' });
    return renderFacts(f);
  } catch {
    return '';
  }
}

/** The note with the facts block in front of it (unchanged when it already has one, or when the facts can't be read). */
export function withFacts(taskId, note, opts = {}) {
  const text = String(note || '');
  const facts = factsFor(taskId, text, opts);
  return facts ? `${facts}\n${text}` : text;
}

/** A note split into a leading facts block (or '') and the prose after it. */
export function splitFacts(note) {
  const text = String(note || '');
  if (!text.startsWith(FACTS_HEAD)) return { facts: '', prose: text };
  const end = text.indexOf(FACTS_END);
  if (end === -1) return { facts: '', prose: text };
  return { facts: text.slice(0, end + FACTS_END.length), prose: text.slice(end + FACTS_END.length).replace(/^\n/, '') };
}

/**
 * The newest facts block in a task's hand-off file, with the heading of its entry ("## <time> · <who>"):
 * { block, heading } or null. For the next agent's brief, which shows it first.
 */
export function latestFacts(handoffText) {
  const text = String(handoffText || '');
  const at = text.lastIndexOf(FACTS_HEAD);
  if (at === -1) return null;
  const end = text.indexOf(FACTS_END, at);
  const block = text.slice(at, end === -1 ? undefined : end + FACTS_END.length);
  const before = text.slice(0, at).split('\n').reverse().find((l) => /^## /.test(l)) || '';
  return { block, heading: before.replace(/^## /, '').trim() };
}

/** The hand-off text with every facts block taken out (the brief shows the newest one on its own). */
export function withoutFacts(handoffText) {
  return String(handoffText || '').replace(new RegExp(`${FACTS_HEAD.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?${FACTS_END.replace(/\./g, '\\.')}\\n?`, 'g'), '');
}

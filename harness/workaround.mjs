#!/usr/bin/env node
/**
 * harness/workaround.mjs — 2.71.0 (z): the self-repair loop. Every time an agent or a person has to work around the
 * harness, it is recorded here, and repeats open ONE harness-improvement task for whoever maintains the harness.
 *
 *   npm run workaround -- log "<what I had to do>" --why "<what the harness did wrong>" [--cmd "<command>"] [--by <agent>]
 *   npm run workaround -- list [--since 7d] [--json]       the records (newest last)
 *   npm run workaround -- tasks [--all] [--json]           the harness tasks (open; --all: closed too)
 *   npm run workaround -- close <H-id> --by <name> --note "<what fixed it>"
 *   npm run workaround -- export [--since 7d]              one markdown file for the harness maintainer (secrets removed)
 *   npm run workaround -- scan                             run the detection pass now (the supervisor runs it every 10 min)
 *   npm run workaround -- repro <H-id> --by <agent> --harness-repo <clone>   2.73.0: a failing-test PR scaffold for the
 *                                                          harness (harness/overseer-repro.mjs; overseer stage 1+)
 *
 * Records: .studio/workarounds.jsonl, one line each { id, ts, what, why, cmd, cmdKey, by, detected, kind, evidence,
 * signature, sig }, plus one `harness.workaround` event. The signature (harness/workaround-stats.mjs) is the harness
 * command involved plus the normalised "what", so repeats group. Text is cleaned with the secret scanner's patterns
 * (harness/secrets.mjs scrub) before it is written anywhere.
 *
 * Detected workarounds (detected: true, with their evidence; only cheap, certain signals):
 *   hand-edit   a harness-owned record changed by something other than the harness. The harness stamps what it writes
 *               (.studio/write-stamps/: content hash and time, written BEFORE the file, so a reader never sees a new
 *               file with an old stamp): the board (studio/NEXT.md, studio/DONE.md, under the board lock) and the train
 *               queue (.studio/train/queue.json). A later file whose hash differs and whose mtime is after the stamp was
 *               changed outside the harness. Not counted: the file equals git's HEAD copy (a pull, a merge, an upgrade),
 *               or a harness upgrade or studio restart was logged since the stamp. Reported once per content.
 *   force       `--force` on a task or lock command.
 *   retry       the same harness command (task/lock, same subcommand and ids) run STUDIO_WORKAROUND_RETRIES (3) times
 *               within STUDIO_WORKAROUND_RETRY_MIN (10) minutes by the same agent, every earlier run having exited
 *               non-zero. Read-only commands (next, show, list, status) and `done --check` (made to be re-run) don't count.
 *   restart     `supervisor stop` (by hand: studio:stop, Ctrl+C, a kill signal) and a start within
 *               STUDIO_WORKAROUND_RESTART_MIN (5) minutes, unless a harness upgrade landed in between (that restart is
 *               the documented step).
 *   kill        the watcher found an agent session whose launcher process is gone with no stop asked through the
 *               harness, and the machine has not restarted since the session started (agent.mjs markGone records both
 *               times). A crash of the launcher itself reads the same; that is rare and still worth a look.
 * Left out as noisy: a session's tool process ending by a signal (an out-of-memory kill and the harness's own stops look
 * the same, and on Windows a kill is just exit 1), and every other record (written by many code paths without stamps).
 *
 * Harness tasks: a signature seen twice, or once with --why, opens ONE task (deduped by signature) in
 * studio/HARNESS-TASKS.md (state in .studio/harness-tasks.json): occurrences, evidence, commands. A separate queue: never
 * on studio/NEXT.md, never for game builders. A closed task seen again reopens. When a harness upgrade lands (an
 * upgrade.merged event, an Upgrade-Versions trailer, a package.json version bump, or the version this file last saw
 * changing) and a task's signature then doesn't occur for STUDIO_WORKAROUND_FIXED_DAYS (7) days, the task is marked
 * "maybe fixed in <version>"; seen again, the mark goes.
 *
 * STUDIO_WORKAROUND_DETECT=off turns detection off (logging by hand still works). The digest and the impact report
 * (`npm run autonomy -- impact`) show workarounds per day, the top 5 signatures and the trend after each upgrade.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, actor, emitEvent, readRecentEvents } from './event.mjs';
import { appendLine, withFileLock, writeAtomic } from './fsafe.mjs';
import { scrub, findSecrets } from './secrets.mjs';
import { DAY, signatureOf, workaroundStats, workaroundTrend } from './workaround-stats.mjs';

export const RECORDS_FILE = () => path.join(STUDIO_STATE_DIR, 'workarounds.jsonl');
export const TASKS_STATE_FILE = () => path.join(STUDIO_STATE_DIR, 'harness-tasks.json');
export const TASKS_MD_REL = 'studio/HARNESS-TASKS.md';
const RUNS_FILE = () => path.join(STUDIO_STATE_DIR, 'cmd-runs.jsonl');
const STATE_FILE = () => path.join(STUDIO_STATE_DIR, 'workaround-state.json');
const LOCK_DIR = () => path.join(STUDIO_STATE_DIR, 'locks');
const num = (v, d) => (v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : d);
const off = (env = process.env) => /^(off|0|false|no)$/i.test(String(env.STUDIO_WORKAROUND_DETECT || ''));
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const iso = (ms) => new Date(ms).toISOString();
const sha = (text) => crypto.createHash('sha256').update(String(text)).digest('hex').slice(0, 24);
export const settings = (env = process.env) => ({
  retries: Math.max(2, Math.round(num(env.STUDIO_WORKAROUND_RETRIES, 3))),
  retryMs: num(env.STUDIO_WORKAROUND_RETRY_MIN, 10) * 60000,
  restartMs: num(env.STUDIO_WORKAROUND_RESTART_MIN, 5) * 60000,
  fixedMs: num(env.STUDIO_WORKAROUND_FIXED_DAYS, 7) * DAY,
  scanMs: num(env.STUDIO_WORKAROUND_SCAN_MIN, 10) * 60000,
});

let scriptsCache = null;
const scripts = () => {
  if (!scriptsCache) scriptsCache = readJson(path.join(REPO_ROOT, 'package.json'), {})?.scripts || {};
  return scriptsCache;
};
const harnessVersion = () => readJson(path.join(REPO_ROOT, 'package.json'), {})?.version || null;

/** Text with anything secret-looking removed (the secret scanner's patterns, then credential flags and assignments), on one line. */
export function clean(text, max = 400) {
  let s = scrub(String(text ?? '')).text
    .replace(/\b(authorization|proxy-authorization)\s*[:=]\s*("?)(bearer|basic|token)?\s*[^\s"']+/gi, (m, h, q, kind) => `${h}: ${q}${kind ? `${kind} ` : ''}[removed]`)
    .replace(/\b(bearer|basic)\s+[A-Za-z0-9._~+/=-]{8,}/gi, '$1 [removed]')
    .replace(/\b([A-Za-z_][A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API_?KEY|ACCESS_?KEY|PRIVATE_?KEY|CREDENTIALS?|WEBHOOK(?:_URL)?))\s*=\s*("[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1=[removed]')
    .replace(/(--?(?:password|passwd|token|secret|api-?key|access-?key|webhook(?:-url)?)\b)(?:\s*=\s*|\s+)("[^"]*"|'[^']*'|[^\s;&|]+)/gi, '$1 [removed]')
    .replace(/(\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+):[^\s@/]+@/gi, '$1:[removed]@')
    .replace(/([?&](?:token|key|api_key|apikey|secret|password|sig|signature|access_token)=)[^\s&#"']+/gi, '$1[removed]')
    .replace(/[\u0000-\u001f\u007f]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  const home = os.homedir();
  if (home && home.length > 3) s = s.split(home).join('~');
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// ---- records ------------------------------------------------------------------------------------------------------

export function readRecords({ since = 0 } = {}) {
  let text = '';
  try { text = fs.readFileSync(RECORDS_FILE(), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) {
    if (!l.trim()) continue;
    try { const r = JSON.parse(l); if ((Date.parse(r.ts) || 0) >= since) out.push(r); } catch { /* a torn line */ }
  }
  return out;
}

const locked = (fn) => {
  try { return withFileLock('workarounds', fn, { dir: LOCK_DIR(), timeoutMs: 5000, what: 'The workaround log' }); } catch { return fn(); }
};

/**
 * Record one workaround: { what, why, cmd, by, detected, kind, evidence: [lines], key (dedupes detected ones), now }.
 * Returns { record, opened: [task ids], duplicate }.
 */
export function recordWorkaround({ what, why = '', cmd = '', by = null, detected = false, kind = 'manual', evidence = [], key = null, now = Date.now() } = {}) {
  const w = clean(what, 300);
  if (!w) return { error: 'what', message: 'Say what you had to do: npm run workaround -- log "<what I had to do>" --why "<what the harness did wrong>"' };
  return locked(() => {
    const all = readRecords();
    if (key && all.some((r) => r.key === key)) return { duplicate: true };
    const c = clean(cmd, 200);
    const sig = signatureOf({ what: w, cmd: c }, scripts());
    const record = {
      id: `W-${String(all.length + 1).padStart(4, '0')}`,
      ts: iso(now), what: w, why: clean(why, 400), cmd: c, cmdKey: sig.cmd, by: clean(by || actor(), 60),
      detected: Boolean(detected), kind, evidence: (Array.isArray(evidence) ? evidence : [evidence]).filter(Boolean).map((e) => clean(e, 300)).slice(0, 8),
      ...(key ? { key } : {}), signature: sig.signature, sig: sig.sig,
    };
    fs.mkdirSync(path.dirname(RECORDS_FILE()), { recursive: true });
    appendLine(RECORDS_FILE(), `${JSON.stringify(record)}\n`);
    try {
      emitEvent({ type: 'harness.workaround', agent: record.by, status: 'warn', msg: `${detected ? 'Detected' : 'Logged'} workaround (${kind}): ${record.what}${record.why ? `; harness: ${record.why}` : ''}`.slice(0, 600), meta: { id: record.id, signature: record.signature, sig: record.sig, cmd: record.cmdKey, detected: record.detected, kind } });
    } catch { /* the record stands */ }
    const synced = syncTasks({ records: [...all, record], now });
    return { record, opened: synced.opened, reopened: synced.reopened, task: synced.state.tasks.find((t) => t.sig === record.sig)?.id || null };
  });
}

// ---- harness tasks ------------------------------------------------------------------------------------------------

export function readTasks() {
  const s = readJson(TASKS_STATE_FILE(), null);
  return s && Array.isArray(s.tasks) ? s : { seq: 0, tasks: [] };
}

/**
 * Bring the harness tasks in line with the records: open one per eligible signature (seen twice, or once with a why),
 * update occurrences, reopen a closed one seen again, and mark "maybe fixed in <version>" (points: upgrades, oldest
 * first). Writes the state and studio/HARNESS-TASKS.md when anything changed. Returns { opened, reopened, maybeFixed }.
 */
export function syncTasks({ records = readRecords(), now = Date.now(), points = null, env = process.env } = {}) {
  const state = readTasks();
  const before = JSON.stringify(state);
  const groups = new Map();
  for (const r of records) { const g = groups.get(r.sig) || []; g.push(r); groups.set(r.sig, g); }
  const opened = []; const reopened = []; const maybeFixed = [];
  for (const [sig, rs] of groups) {
    const eligible = rs.length >= 2 || rs.some((r) => r.why);
    let t = state.tasks.find((x) => x.sig === sig);
    if (!t && !eligible) continue;
    const first = rs[0]; const last = rs[rs.length - 1];
    if (!t) {
      state.seq = (state.seq || 0) + 1;
      t = { id: `H-${String(state.seq).padStart(3, '0')}`, sig, signature: first.signature, title: first.what.slice(0, 100), status: 'open', openedAt: iso(now) };
      state.tasks.push(t);
      opened.push(t.id);
    } else if (t.status === 'closed' && rs.some((r) => Date.parse(r.ts) > Date.parse(t.closedAt || 0))) {
      t.status = 'open';
      t.reopenedAt = iso(now);
      t.reopenNote = `seen again after it was closed (${t.closedAt?.slice(0, 10) || '?'}${t.note ? `: ${t.note}` : ''})`;
      reopened.push(t.id);
    }
    t.occurrences = rs.length;
    t.firstSeen = first.ts;
    t.lastSeen = last.ts;
    t.by = [...new Set(rs.map((r) => r.by).filter(Boolean))].slice(0, 6);
    t.why = [...new Set(rs.map((r) => r.why).filter(Boolean))].slice(0, 3);
    t.commands = [...new Set(rs.map((r) => r.cmd).filter(Boolean))].slice(-5);
    t.detected = rs.filter((r) => r.detected).length;
    t.evidence = rs.slice(-5).map((r) => `${r.ts.slice(0, 16).replace('T', ' ')} ${r.detected ? `detected (${r.kind})` : `logged by ${r.by}`}: ${r.what}${r.evidence?.length ? ` [${r.evidence.join('; ')}]` : ''}`);
    if (t.maybeFixed && Date.parse(t.lastSeen) > Date.parse(t.maybeFixed.at)) { t.seenAfterFix = `seen again after ${t.maybeFixed.version}`; delete t.maybeFixed; }
  }
  if (points) {
    const fixedMs = settings(env).fixedMs;
    for (const t of state.tasks.filter((x) => x.status === 'open' && !x.maybeFixed)) {
      const last = Date.parse(t.lastSeen) || 0;
      const p = points.find((x) => x.at > last);
      if (p && now - p.at >= fixedMs) {
        t.maybeFixed = { version: p.version, at: iso(p.at) };
        maybeFixed.push(t.id);
      }
    }
  }
  if (JSON.stringify(state) !== before || (state.tasks.length && !fs.existsSync(path.join(REPO_ROOT, TASKS_MD_REL)))) {
    writeAtomic(TASKS_STATE_FILE(), `${JSON.stringify(state, null, 2)}\n`, { fsync: false });
    writeAtomic(path.join(REPO_ROOT, TASKS_MD_REL), renderTasks(state));
    for (const id of opened) { const t = state.tasks.find((x) => x.id === id); emitEvent({ type: 'harness.task_opened', agent: 'harness', status: 'warn', msg: `Harness task ${id} opened (${TASKS_MD_REL}): ${t.title}`.slice(0, 400), meta: { id, sig: t.sig, signature: t.signature, occurrences: t.occurrences } }); }
    for (const id of reopened) emitEvent({ type: 'harness.task_reopened', agent: 'harness', status: 'warn', msg: `Harness task ${id} reopened: its workaround was seen again after it was closed`, meta: { id } });
    for (const id of maybeFixed) { const t = state.tasks.find((x) => x.id === id); emitEvent({ type: 'harness.task_maybe_fixed', agent: 'harness', msg: `Harness task ${id} is maybe fixed in ${t.maybeFixed.version}: not seen for ${Math.round(settings(env).fixedMs / DAY)} days after it landed`, meta: { id, version: t.maybeFixed.version } }); }
  }
  return { opened, reopened, maybeFixed, state };
}

const taskBlock = (t) => [
  `### ${t.id}: ${t.title}`,
  `- Signature: \`${t.signature}\` (${t.sig})`,
  `- Seen ${t.occurrences} time${t.occurrences === 1 ? '' : 's'} (${t.detected || 0} detected), first ${String(t.firstSeen).slice(0, 16).replace('T', ' ')}, last ${String(t.lastSeen).slice(0, 16).replace('T', ' ')}; by ${(t.by || []).join(', ') || '?'}`,
  ...(t.maybeFixed ? [`- **Maybe fixed in ${t.maybeFixed.version}**: not seen since it landed (${t.maybeFixed.at.slice(0, 10)}). Check, then close it.`] : []),
  ...(t.seenAfterFix ? [`- Note: ${t.seenAfterFix}.`] : []),
  ...(t.reopenNote && t.status === 'open' ? [`- Reopened: ${t.reopenNote}.`] : []),
  ...(t.why?.length ? [`- What the harness did wrong (as reported): ${t.why.join(' | ')}`] : []),
  ...(t.commands?.length ? [`- Commands: ${t.commands.map((c) => `\`${c}\``).join(', ')}`] : []),
  '- Evidence (latest first):',
  ...[...(t.evidence || [])].reverse().map((e) => `  - ${e}`),
  ...(t.status === 'closed' ? [`- Closed ${String(t.closedAt).slice(0, 10)} by ${t.closedBy}: ${t.note}`] : []),
  '',
];

export function renderTasks(state) {
  const open = state.tasks.filter((t) => t.status === 'open');
  const closed = state.tasks.filter((t) => t.status === 'closed');
  return [
    '# Harness tasks (`studio/HARNESS-TASKS.md`)',
    '',
    'Written by harness/workaround.mjs (the self-repair loop). These are for whoever maintains the harness, never for game',
    'builders, and never on the board (studio/NEXT.md). Each task is one workaround signature seen twice, or once with a reason.',
    'Close one with: npm run workaround -- close <H-id> --by <name> --note "what fixed it". Send them all to the harness',
    'maintainer with: npm run workaround -- export.',
    '',
    `## Open (${open.length})`,
    '',
    ...(open.length ? open.flatMap(taskBlock) : ['_None._', '']),
    `## Closed (${closed.length})`,
    '',
    ...(closed.length ? closed.slice(-30).flatMap((t) => [`- ${t.id}: ${t.title} (\`${t.signature}\`): closed ${String(t.closedAt).slice(0, 10)} by ${t.closedBy}: ${t.note}`]) : ['_None._']),
    '',
  ].join('\n');
}

const WORKER_ROLES = new Set(['builder', 'qa', 'artist', 'art', 'reviewer', 'tester', 'designer', 'sound', 'writer']);

/** Close a harness task: { id, by, note }. Never by a game-builder session (STUDIO_ROLE a worker role). */
export function closeTask({ id, by, note, env = process.env, now = Date.now() } = {}) {
  if (!id || !by || !note || String(note).trim().length < 5) return { error: 'usage', message: 'Usage: npm run workaround -- close <H-id> --by <name> --note "what fixed it"' };
  if (WORKER_ROLES.has(String(env.STUDIO_ROLE || '').toLowerCase())) return { error: 'role', message: `Harness tasks are for whoever maintains the harness; a ${env.STUDIO_ROLE} session doesn't close them.` };
  return locked(() => {
    const state = readTasks();
    const t = state.tasks.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
    if (!t) return { error: 'missing', message: `No harness task ${id} (npm run workaround -- tasks --all).` };
    if (t.status === 'closed') return { error: 'closed', message: `${t.id} is already closed (${t.closedAt?.slice(0, 10)} by ${t.closedBy}).` };
    Object.assign(t, { status: 'closed', closedAt: iso(now), closedBy: clean(by, 60), note: clean(note, 300) });
    writeAtomic(TASKS_STATE_FILE(), `${JSON.stringify(state, null, 2)}\n`, { fsync: false });
    writeAtomic(path.join(REPO_ROOT, TASKS_MD_REL), renderTasks(state));
    emitEvent({ type: 'harness.task_closed', agent: t.closedBy, msg: `Harness task ${t.id} closed by ${t.closedBy}: ${t.note}`.slice(0, 400), meta: { id: t.id, sig: t.sig } });
    return { ok: true, task: t };
  });
}

// ---- detection: harness commands (--force, retries) ---------------------------------------------------------------

const READ_ONLY = new Set(['next', 'show', 'list', 'status', 'help', 'proposed', 'pending', 'review']);
/** The positional words of an argv (flags and their values left out), parsed the way harness/task.mjs does. */
const positional = (argv) => {
  const out = [];
  for (let i = 0; i < argv.length; i++) {
    const a = String(argv[i]);
    if (a.startsWith('--')) { if (argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--')) i++; } else if (!a.startsWith('-')) out.push(a);
  }
  return out;
};

function readRuns() {
  let text = '';
  try { text = fs.readFileSync(RUNS_FILE(), 'utf8'); } catch { return []; }
  const out = [];
  for (const l of text.split('\n')) { if (!l.trim()) continue; try { out.push(JSON.parse(l)); } catch { /* torn */ } }
  return out;
}
function appendRun(rec) {
  try {
    const f = RUNS_FILE();
    fs.mkdirSync(path.dirname(f), { recursive: true });
    appendLine(f, `${JSON.stringify(rec)}\n`);
    if (fs.statSync(f).size > 256 * 1024) writeAtomic(f, `${readRuns().slice(-500).map((r) => JSON.stringify(r)).join('\n')}\n`, { fsync: false });
  } catch { /* evidence only */ }
}

/**
 * Called by a harness CLI (task, lock) as it starts: records `--force` as a detected workaround, notices the third run
 * of a command whose earlier runs all failed, and logs this run's exit code when the process ends.
 */
export function watchCommand(script, argv = [], { agent = null, now = Date.now(), env = process.env } = {}) {
  if (off(env)) return null;
  const by = agent || actor();
  const words = positional(argv);
  const sub = words[0] || '';
  const key = [script, ...words.slice(0, 3)].join(' ');
  const line = clean(`${script} ${argv.join(' ')}`, 200);
  const found = [];
  if (argv.includes('--force')) {
    const r = recordWorkaround({ what: `used --force on ${script} ${sub}`.trim(), cmd: `${script} ${sub}`, by, detected: true, kind: 'force', evidence: [`${iso(now)} ${by} ran: ${line}`], now });
    if (r.record) found.push(r.record);
  }
  if (READ_ONLY.has(sub) || argv.includes('--check') || argv.includes('--help') || argv.includes('-h')) return found;
  const { retries, retryMs } = settings(env);
  const mine = readRuns().filter((r) => r.by === by && r.key === key && now - r.ts <= retryMs && r.ts <= now);
  const streak = [];
  for (let i = mine.length - 1; i >= 0 && mine[i].code !== 0; i--) streak.unshift(mine[i]);
  if (streak.length >= retries - 1) {
    const r = recordWorkaround({
      what: `re-ran a refused harness command (${script} ${sub})`,
      cmd: `${script} ${sub}`, by, detected: true, kind: 'retry', key: `retry:${by}:${key}:${streak[0].ts}`, now,
      evidence: [...streak.map((s) => `${iso(s.ts)} exit ${s.code}`), `${iso(now)} run ${streak.length + 1}: ${line}`],
    });
    if (r.record) found.push(r.record);
  }
  process.on('exit', (code) => appendRun({ ts: now, by, key, code: Number(code) || 0 }));
  return found;
}

// ---- detection: write stamps (hand edits) -------------------------------------------------------------------------

const stampFile = (root, rel) => path.join(root, '.studio', 'write-stamps', `${rel.replace(/[\\/:]+/g, '__')}.json`);
const relOf = (root, file) => path.relative(root, file).replace(/\\/g, '/');

/** Stamp what the harness is about to write to `file` (call BEFORE writing it). */
export function stampWrite(file, text, { root = REPO_ROOT } = {}) {
  const rel = relOf(root, file);
  const s = String(text);
  writeAtomic(stampFile(root, rel), `${JSON.stringify({ file: rel, sha: sha(s), size: Buffer.byteLength(s), lines: s.split('\n').length, at: Date.now(), pid: process.pid })}\n`, { fsync: false });
}

const HARNESS_REWRITES = /^(upgrade\.(merged|stash_restored|merge_conflict|auto)|studio\.restarted|setup\.init)$/;
function gitHeadCopy(file) {
  try {
    const real = fs.realpathSync(file);
    const r = spawnSync('git', ['show', `HEAD:./${path.basename(real)}`], { windowsHide: true, cwd: path.dirname(real), encoding: 'utf8', timeout: 10000, maxBuffer: 32 * 1024 * 1024 });
    return r.status === 0 ? r.stdout : null;
  } catch { return null; }
}

/**
 * Was `file` changed by something other than the harness since its last stamp? Records a detected workaround once per
 * content and stamps the file as it is now. text: the file's content when the caller already read it. Returns the record or null.
 */
export function checkStamped(file, { text = undefined, root = REPO_ROOT, now = Date.now(), env = process.env } = {}) {
  if (off(env)) return null;
  const rel = relOf(root, file);
  const sf = stampFile(root, rel);
  const st = readJson(sf, null);
  if (!st?.sha) return null;
  let cur = text;
  if (cur === undefined || cur === null) { try { cur = fs.readFileSync(file, 'utf8'); } catch { return null; } }
  if (sha(cur) === st.sha) return null;
  let mtime = 0;
  try { mtime = fs.statSync(file).mtimeMs; } catch { return null; }
  if (!(mtime > st.at + 2)) return null; // written around the stamp: a harness write in flight, not a hand edit
  const restamp = () => { try { if (readJson(sf, null)?.at === st.at) stampWrite(file, cur, { root }); } catch { /* next time */ } };
  if (!/^\.studio\//.test(rel)) {
    const head = gitHeadCopy(file);
    if (head !== null && head.replace(/\r/g, '') === String(cur).replace(/\r/g, '')) { restamp(); return null; }
  }
  if (readRecentEvents(3000).some((e) => HARNESS_REWRITES.test(e.type || '') && Date.parse(e.ts) >= st.at)) { restamp(); return null; }
  const lines = String(cur).split('\n').length;
  const r = recordWorkaround({
    what: `hand-edited ${rel}`, by: 'outside the harness', detected: true, kind: 'hand-edit', key: `hand-edit:${rel}:${sha(cur)}`, now,
    evidence: [`${rel} changed outside the harness at ${iso(mtime)} (${st.size} -> ${Buffer.byteLength(String(cur))} bytes, ${st.lines ?? '?'} -> ${lines} lines); the harness last wrote it at ${iso(st.at)}`],
  });
  restamp();
  return r.record || null;
}

/** Every stamped record checked once: [records]. */
export function checkAllStamps({ root = REPO_ROOT, now = Date.now(), env = process.env } = {}) {
  const dir = path.join(root, '.studio', 'write-stamps');
  let names = [];
  try { names = fs.readdirSync(dir).filter((n) => n.endsWith('.json')); } catch { return []; }
  const out = [];
  for (const n of names) {
    const st = readJson(path.join(dir, n), null);
    if (!st?.file || /(^|\/)\.\.(\/|$)/.test(st.file)) continue;
    const r = checkStamped(path.join(root, st.file), { root, now, env });
    if (r) out.push(r);
  }
  return out;
}

// ---- detection: the event log (supervisor restarts, killed launchers) ---------------------------------------------

const STOP_BY_HAND = /Supervisor stopped \((stopped by hand|stopped by the system|studio:stop was asked)\)/;
export function detectFromEvents(events, { now = Date.now(), env = process.env } = {}) {
  if (off(env)) return [];
  const { restartMs } = settings(env);
  const ts = (e) => Date.parse(e?.ts) || 0;
  const ev = events.filter((e) => ts(e) >= now - 7 * DAY && ts(e) <= now).sort((a, b) => ts(a) - ts(b));
  const out = [];
  let lastStop = null;
  let upgradedSinceStop = false;
  for (const e of ev) {
    if (e.type === 'supervisor.stop') { lastStop = e; upgradedSinceStop = false; continue; }
    if (/^upgrade\.(merged|auto)$/.test(e.type || '')) { upgradedSinceStop = true; continue; }
    if (e.type === 'supervisor.start' && lastStop) {
      const gap = ts(e) - ts(lastStop);
      if (STOP_BY_HAND.test(lastStop.msg || '') && gap <= restartMs && !upgradedSinceStop) {
        const r = recordWorkaround({
          what: 'restarted the supervisor (stopped it by hand and started it again)', cmd: 'supervisor stop', by: lastStop.meta?.by || 'outside the harness', detected: true, kind: 'restart', key: `restart:${e.id || e.ts}`, now,
          evidence: [`${lastStop.ts}: ${String(lastStop.msg).slice(0, 160)}`, `${e.ts}: started again ${Math.round(gap / 1000)} s later`],
        });
        if (r.record) out.push(r.record);
      }
      lastStop = null;
      continue;
    }
    if (e.type === 'agent.session.end' && e.meta?.reason === 'process gone' && !e.meta?.stoppedBy && e.meta?.startedAt && e.meta?.bootAt && Date.parse(e.meta.bootAt) < Date.parse(e.meta.startedAt)) {
      const r = recordWorkaround({
        what: 'killed a harness child (an agent session launcher) outside the harness', cmd: '', by: 'outside the harness', detected: true, kind: 'kill', key: `kill:${e.id || `${e.agent}:${e.ts}`}`, now,
        evidence: [`${e.ts} ${e.agent}: ${String(e.msg || '').slice(0, 160)}; started ${e.meta.startedAt}, the machine up since ${e.meta.bootAt}, no stop asked through the harness`],
      });
      if (r.record) out.push(r.record);
    }
  }
  return out;
}

// ---- upgrades and the pass ----------------------------------------------------------------------------------------

/** Harness upgrades, oldest first: impact.mjs's points plus the version changes this file has seen. */
export async function upgradesSeen({ events = null, now = Date.now(), root = REPO_ROOT } = {}) {
  const st = readJson(STATE_FILE(), {}) || {};
  const ver = harnessVersion();
  st.upgrades = Array.isArray(st.upgrades) ? st.upgrades : [];
  if (ver && st.version && st.version !== ver && !st.upgrades.some((u) => u.version === ver)) st.upgrades.push({ version: ver, from: st.version, at: now });
  if (ver && st.version !== ver) { st.version = ver; try { writeAtomic(STATE_FILE(), `${JSON.stringify(st, null, 2)}\n`, { fsync: false }); } catch { /* next pass */ } }
  let pts = [];
  try { pts = (await import('./impact.mjs')).upgradePoints({ root, events: events || readRecentEvents(50000) }); } catch { pts = []; }
  const all = new Map();
  for (const p of [...pts, ...st.upgrades]) { const v = String(p.version).replace(/^v/, ''); const cur = all.get(v); if (!cur || p.at < cur.at) all.set(v, { version: v, at: p.at, from: p.from || null }); }
  return [...all.values()].filter((p) => Number.isFinite(p.at)).sort((a, b) => a.at - b.at);
}

/**
 * The detection pass: stamped records, the event log, the harness tasks and their "maybe fixed" marks. force: run even
 * if the last pass was under STUDIO_WORKAROUND_SCAN_MIN ago (the supervisor calls it every loop without force).
 */
export async function workaroundPass({ force = false, now = Date.now(), env = process.env, root = REPO_ROOT } = {}) {
  const st = readJson(STATE_FILE(), {}) || {};
  if (!force && st.scannedAt && now - st.scannedAt < settings(env).scanMs) return { skipped: true };
  const events = readRecentEvents(50000);
  const found = [...checkAllStamps({ root, now, env }), ...detectFromEvents(events, { now, env })];
  const points = await upgradesSeen({ events, now, root });
  const synced = locked(() => syncTasks({ now, points, env }));
  const st2 = readJson(STATE_FILE(), {}) || {};
  st2.scannedAt = now;
  try { writeAtomic(STATE_FILE(), `${JSON.stringify(st2, null, 2)}\n`, { fsync: false }); } catch { /* next pass */ }
  return { found, opened: synced.opened, reopened: synced.reopened, maybeFixed: synced.maybeFixed, points };
}

// ---- measures, digest, export -------------------------------------------------------------------------------------

const short = (s, n = 48) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
/** The digest's line ('' when there were no workarounds in 7 days and no harness task is open). */
export function workaroundDigestLine({ events = [], now = Date.now(), points = [], brief = false } = {}) {
  const s = workaroundStats(events, { now, days: 7 });
  const open = readTasks().tasks.filter((t) => t.status === 'open');
  if (!s.n && !open.length) return '';
  const last = workaroundTrend(events, points, { now }).pop();
  const trend = last && last.verdict !== 'none either side' ? `; after ${last.version}: ${last.before.perDay} -> ${last.after.perDay}/day (${last.verdict})` : '';
  const tasks = open.length ? `; ${open.length} harness task${open.length === 1 ? '' : 's'} open (${TASKS_MD_REL})` : '';
  if (brief) return `Workarounds: ${s.last24h} in 24 h, ${s.perDay}/day over 7 days${tasks} (npm run workaround -- list).`;
  return `Workarounds: ${s.last24h} in 24 h, ${s.perDay}/day over 7 days${s.top.length ? `; top: ${s.top.map((t) => `\`${short(t.signature)}\` ${t.n}`).join(', ')}` : ''}${trend}${tasks}.`;
}

const parseSince = (v, now = Date.now()) => {
  if (!v) return now - 7 * DAY;
  const m = String(v).match(/^(\d+(?:\.\d+)?)\s*([dhm])$/i);
  if (m) return now - Number(m[1]) * { d: DAY, h: 3600000, m: 60000 }[m[2].toLowerCase()];
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
};

/** One markdown file for the harness maintainer: .studio/exports/harness-workarounds-<date>.md. Returns { file, text, records, tasks }. */
export async function exportWorkarounds({ since = '7d', now = Date.now(), root = REPO_ROOT } = {}) {
  const from = parseSince(since, now);
  if (from === null) return { error: 'since', message: 'Usage: npm run workaround -- export [--since 7d | 24h | 2026-11-01]' };
  const records = readRecords({ since: from });
  const tasks = readTasks().tasks;
  const events = readRecentEvents(50000);
  let points = [];
  try { points = await upgradesSeen({ events, now, root }); } catch { points = []; }
  const days = Math.max(1, Math.round((now - from) / DAY));
  const s = workaroundStats(events, { now, days });
  const trend = workaroundTrend(events, points, { now }).slice(-5);
  const L = [
    `# Harness workarounds: ${iso(from).slice(0, 10)} to ${iso(now).slice(0, 10)}`,
    '',
    `Harness ${harnessVersion() || '?'}. Exported ${iso(now).slice(0, 16).replace('T', ' ')} UTC by \`npm run workaround -- export\`. Anything matching the`,
    'secret scanner\'s patterns has been removed ("[removed]").',
    '',
    '## Summary',
    `- ${records.length} workaround${records.length === 1 ? '' : 's'} recorded (${records.filter((r) => r.detected).length} detected by the harness, ${records.filter((r) => !r.detected).length} logged by hand); ${s.perDay} per day over ${days} day${days === 1 ? '' : 's'}.`,
    ...(s.top.length ? ['- Top signatures:', ...s.top.map((t) => `  - \`${t.signature}\`: ${t.n}`)] : []),
    ...(trend.length ? ['- Per day before -> after each upgrade:', ...trend.map((t) => `  - ${t.version} (${t.at.slice(0, 10)}): ${t.before.perDay} -> ${t.after.perDay} (${t.verdict})`)] : []),
    '',
    `## Harness tasks (${tasks.filter((t) => t.status === 'open').length} open)`,
    '',
    ...(tasks.length ? tasks.filter((t) => t.status === 'open' || (Date.parse(t.closedAt) || 0) >= from).flatMap(taskBlock) : ['_None._', '']),
    '## Every workaround in the period',
    '',
    ...(records.length ? records.map((r) => `- ${r.ts.slice(0, 16).replace('T', ' ')} ${r.id} ${r.detected ? `detected (${r.kind})` : `logged by ${r.by}`}: ${r.what}${r.why ? `. Harness: ${r.why}` : ''}${r.cmd ? `. Command: \`${r.cmd}\`` : ''}${r.evidence?.length ? `. Evidence: ${r.evidence.join('; ')}` : ''} (\`${r.signature}\`)`) : ['_None._']),
    '',
  ];
  // Every line cleaned; indented list items keep their indent (clean collapses whitespace).
  let text = L.map((l) => (l.startsWith('#') || l === '' ? l : `${l.match(/^\s*/)[0]}${clean(l, 4000)}`)).join('\n');
  for (let i = 0; i < 3 && findSecrets(text).length; i++) text = scrub(text).text;
  const file = path.join(STUDIO_STATE_DIR, 'exports', `harness-workarounds-${iso(now).slice(0, 10)}.md`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  emitEvent({ type: 'harness.workarounds_exported', agent: actor(), msg: `Exported ${records.length} workaround(s) and ${tasks.filter((t) => t.status === 'open').length} open harness task(s) for the harness maintainer (${relOf(root, file)})`, meta: { file: relOf(root, file), records: records.length } });
  return { file, rel: relOf(root, file), text, records: records.length, tasks: tasks.length };
}

// ---- CLI ----------------------------------------------------------------------------------------------------------

const USAGE = [
  'Usage:',
  '  npm run workaround -- log "<what I had to do>" --why "<what the harness did wrong>" [--cmd "<command>"] [--by <agent>]',
  '  npm run workaround -- list [--since 7d] [--json]',
  '  npm run workaround -- tasks [--all] [--json]',
  '  npm run workaround -- close <H-id> --by <name> --note "<what fixed it>"',
  '  npm run workaround -- export [--since 7d]',
  '  npm run workaround -- scan',
  '  npm run workaround -- repro <H-id> --by <agent> --harness-repo <a separate harness clone> [--base <ref>] [--commit]   (2.73.0: overseer stage 1+)',
].join('\n');

export async function workaroundCli(argv) {
  const flag = (k) => { const i = argv.indexOf(`--${k}`); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  const words = positional(argv);
  const cmd = words[0];
  if (!cmd || argv.includes('--help') || argv.includes('-h')) return { code: cmd ? 0 : 2, text: USAGE };
  if (cmd === 'log') {
    const what = words.slice(1).join(' ');
    const r = recordWorkaround({ what, why: flag('why') || '', cmd: flag('cmd') || '', by: flag('by') });
    if (r.error) return { code: 2, text: `${r.message}\n${USAGE}` };
    const tasks = [...(r.opened || []), ...(r.reopened || [])];
    return { code: 0, text: `Recorded ${r.record.id} (signature \`${r.record.signature}\`).${tasks.length ? ` Harness task ${tasks.join(', ')} ${r.opened?.length ? 'opened' : 'reopened'} in ${TASKS_MD_REL}.` : (r.task ? ` Added to harness task ${r.task}.` : ' A harness task opens when this signature is seen again (or log it with --why).')}` };
  }
  if (cmd === 'list') {
    const since = parseSince(flag('since') || '7d');
    if (since === null) return { code: 2, text: USAGE };
    const rs = readRecords({ since });
    if (argv.includes('--json')) return { code: 0, text: JSON.stringify(rs, null, 2) };
    return { code: 0, text: rs.length ? rs.map((r) => `${r.ts.slice(0, 16).replace('T', ' ')} ${r.id} ${r.detected ? `[detected ${r.kind}]` : `[${r.by}]`} ${r.what}${r.why ? ` (harness: ${r.why})` : ''}  \`${r.signature}\``).join('\n') : 'No workarounds recorded in that time.' };
  }
  if (cmd === 'tasks') {
    const ts = readTasks().tasks.filter((t) => argv.includes('--all') || t.status === 'open');
    if (argv.includes('--json')) return { code: 0, text: JSON.stringify(ts, null, 2) };
    return { code: 0, text: ts.length ? ts.map((t) => `${t.id} [${t.status}${t.maybeFixed ? `, maybe fixed in ${t.maybeFixed.version}` : ''}] ${t.title} (seen ${t.occurrences}x, last ${String(t.lastSeen).slice(0, 10)})  \`${t.signature}\``).join('\n') : 'No harness tasks.' };
  }
  if (cmd === 'close') {
    const r = closeTask({ id: words[1], by: flag('by'), note: flag('note') });
    return r.error ? { code: r.error === 'usage' ? 2 : 1, text: r.message } : { code: 0, text: `Closed ${r.task.id}: ${r.task.note}` };
  }
  if (cmd === 'export') {
    const r = await exportWorkarounds({ since: flag('since') || '7d' });
    return r.error ? { code: 2, text: r.message } : { code: 0, text: `Wrote ${r.rel}: ${r.records} workaround(s), ${r.tasks} harness task(s). Read it, then send it to the harness maintainer.` };
  }
  // 2.73.0 (f): the overseer's failing-test PR scaffold for a harness task, in a separate harness clone (harness/overseer-repro.mjs).
  if (cmd === 'repro') {
    const r = await (await import('./overseer-repro.mjs')).reproScaffold({ id: words[1], by: flag('by'), harnessRepo: flag('harness-repo'), base: flag('base'), commit: argv.includes('--commit') });
    return { code: r.code, text: r.lines.join('\n') };
  }
  if (cmd === 'scan') {
    const r = await workaroundPass({ force: true });
    return { code: 0, text: `Scan: ${r.found.length} new detected workaround(s)${r.found.length ? ` (${r.found.map((x) => x.kind).join(', ')})` : ''}; ${r.opened.length} harness task(s) opened, ${r.maybeFixed.length} marked maybe fixed.` };
  }
  return { code: 2, text: USAGE };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // No top-level await: task.mjs and lock.mjs import this file (an async module there could stall an import cycle).
  workaroundCli(process.argv.slice(2)).then((r) => { (r.code ? console.error : console.log)(r.text); process.exit(r.code); }, (err) => { console.error(err.stack || String(err)); process.exit(1); });
}

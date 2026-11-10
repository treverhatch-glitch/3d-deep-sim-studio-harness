/**
 * harness/aider-protocol.mjs — 2.79.2 (a): the launcher runs the builder protocol around aider.
 *
 * aider is one-shot (--message-file: read the message, edit files, exit) and doesn't reliably run shell commands, so an
 * aider builder (--tool nim, aider, vertex, or an owner tool in studio/tools.json whose command starts aider) never ran
 * `task start` / `task done`: every session ended "no work on T-…: it never claimed T-…". And its context was the whole
 * repo (repo map, files the kickoff named, a ~1 MB game file), so each request carried hundreds of thousands of tokens.
 * For such a session on a task, in its own lane copy, the launcher now:
 *   1. claims the task before aider starts (`node harness/task.mjs start <ID> --agent <agent>` in the copy: the same path a
 *      builder's own `npm run task -- start` takes; it writes the focus brief);
 *   2. gives aider a short edit brief (editBrief: the task, the lane's paths, the rules for edits, the brief's "what / done
 *      means / steps / never" sections without harness commands), never the kickoff with harness commands;
 *   3. starts aider on the lane's files (--file), with an ignore file that keeps the repo map to the lane (gitignore
 *      whitelist) and leaves out tracked files over STUDIO_AIDER_MAX_FILE_KB (200) unless the lane names them;
 *   4. after aider exits (finishAiderTask): commits its changes on the lane branch (Studio-Task / Studio-Agent trailers),
 *      runs `task done --check`, then `task done` (in a copy: queues the lane for the merge train); no change, a refused
 *      commit or a failed check hands the task back (handBackCause no-change | red) with aider's last lines and the reason.
 * The session's agent.session.end says which (meta.aider, and its message). STUDIO_AIDER_PROTOCOL=off: the 2.79.1 launch.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { untrustedBlock } from './untrusted.mjs';

export const AIDER_MAX_FILE_KB_DEFAULT = 200;
const num = (v, d) => { const n = Number(v); return v !== undefined && v !== null && String(v).trim() !== '' && Number.isFinite(n) ? n : d; };
/** STUDIO_AIDER_MAX_FILE_KB: a tracked file bigger than this stays out of aider's map and chat unless the lane names it. */
export const aiderMaxFileKb = (env = process.env) => { const n = num(env.STUDIO_AIDER_MAX_FILE_KB, AIDER_MAX_FILE_KB_DEFAULT); return n > 0 ? n : AIDER_MAX_FILE_KB_DEFAULT; };

const posix = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');

/** Whether a command line starts aider (an owner tool in studio/tools.json): its program's file name is aider(.exe|.cmd|.bat). */
export function isAiderCommand(line) {
  const s = String(line || '').trim();
  const first = (s.match(/^"([^"]+)"|^'([^']+)'|^(\S+)/) || []).slice(1).find(Boolean) || '';
  return /^aider(\.exe|\.cmd|\.bat)?$/i.test(path.basename(first.replace(/\\/g, '/')));
}

/**
 * Does this session get the launcher's aider protocol? { on, why }. Builders only, on a task, in their own lane copy,
 * on an aider tool: a built-in (nim, aider, vertex) or an owner tool whose command starts aider.
 */
export function aiderDriven({ tool, custom = null, rehearsal = false, regCommand = null, role, task, copy, env = process.env }) {
  // STUDIO_AIDER_PROTOCOL=off: the 2.79.1 launch (aider gets the kickoff and the brief with --read, and nothing else).
  if (/^(off|0|false|no)$/i.test(String(env.STUDIO_AIDER_PROTOCOL || '').trim())) return { on: false, why: 'STUDIO_AIDER_PROTOCOL is off' };
  const aider = (!custom && ['nim', 'aider', 'vertex'].includes(tool)) || (Boolean(custom) && Boolean(regCommand) && custom === regCommand && isAiderCommand(regCommand));
  if (!aider || rehearsal) return { on: false, why: 'not an aider session' };
  if (role !== 'builder') return { on: false, why: `${role} sessions on aider run as before (the protocol is the builder's)` };
  if (!task) return { on: false, why: 'no task to claim' };
  if (!copy) return { on: false, why: 'no lane copy (the launcher commits aider\'s work only in the agent\'s own copy)' };
  return { on: true, why: '' };
}

/** A lane's entries as paths (regions `file#name` as the file), relative and with / separators; globs dropped. */
function lanePathsOf(lanePaths) {
  const all = [...new Set((lanePaths || []).map((p) => posix(String(p).split('#')[0])).filter((p) => p && !/[*?[\]]/.test(p) && !p.startsWith('..') && !path.isAbsolute(p)))];
  return all;
}
const isDirIn = (cwd, rel) => { try { return fs.statSync(path.join(cwd, rel)).isDirectory(); } catch { return !/\.[A-Za-z0-9]{1,8}$/.test(rel); } };

/** The lane's files (not folders) to pass with --file: the ones the lane names. A file the lane names that isn't there yet is created by aider. */
export function laneFiles({ cwd, lanePaths }) {
  return lanePathsOf(lanePaths).filter((p) => !isDirIn(cwd, p));
}

/**
 * The extra ignore lines for a driven session (before the harness's own lines in the agent's .aiderignore):
 *   - a whitelist of the lane (gitignore order: ignore everything, then re-include each ancestor folder and ignore its
 *     other entries, then re-include the lane's folders and files), so the repo map covers only the lane;
 *   - every tracked file over the size limit that the lane doesn't name (/path).
 * No lane (or a lane with a glob): no whitelist, only the size limit.
 */
export function laneIgnoreLines({ cwd, lanePaths, env = process.env, tracked = null }) {
  const raw = (lanePaths || []).map((p) => posix(String(p).split('#')[0])).filter(Boolean);
  const paths = lanePathsOf(lanePaths);
  const lines = [];
  if (paths.length && paths.length === raw.length) {
    const dirs = paths.filter((p) => isDirIn(cwd, p));
    // A path inside a folder the lane names is covered by that folder.
    const leaves = paths.filter((p) => !dirs.some((d) => d !== p && p.startsWith(`${d}/`)));
    const ancestors = new Set();
    for (const p of leaves) { const parts = p.split('/'); for (let i = 1; i < parts.length; i++) ancestors.add(parts.slice(0, i).join('/')); }
    const anc = [...ancestors].filter((a) => !leaves.includes(a)).sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b));
    lines.push('/*');
    for (const a of anc) lines.push(`!/${a}/`, `/${a}/*`);
    for (const p of leaves) lines.push(dirs.includes(p) ? `!/${p}/` : `!/${p}`);
  }
  const named = new Set(paths);
  const max = aiderMaxFileKb(env) * 1024;
  let files = tracked;
  if (!files) {
    const r = spawnSync('git', ['ls-files', '-z'], { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
    files = r.status === 0 ? r.stdout.split('\0').filter(Boolean) : [];
  }
  for (const f of files) {
    const rel = posix(f);
    if (named.has(rel)) continue;
    let size = 0;
    try { size = fs.statSync(path.join(cwd, rel)).size; } catch { continue; }
    if (size > max) lines.push(`/${rel}`);
  }
  return lines;
}

// A line that is a harness command (aider can't run them; naming harness files pulled them into its chat).
const HARNESS_LINE = /\b(npm run|npx\s|node\s+(harness|scripts|qa|tools)\/|harness\/[\w.-]+\.mjs|scripts\/[\w.-]+\.mjs|lock\.mjs|task\.mjs|done-check|STUDIO_LOCK_OWNER|\.studio\/)/i;
const KEEP_SECTIONS = /^(What this task is|Done means|The regression this bug needs|Steps\b|Never\b|The game's voice)/i;

/** The parts of the task's focus brief (.studio/briefs/<ID>.md) an edit needs, without harness commands. */
export function briefForAider(text, max = 8000) {
  const parts = String(text || '').replace(/\r\n/g, '\n').split(/^## /m).slice(1);
  const kept = [];
  for (const p of parts) {
    const head = p.split('\n')[0].trim();
    if (!KEEP_SECTIONS.test(head)) continue;
    // Harness command lines and ``` fences go (a fence left with no commands in it is noise); the marked block's ~~~~ stay.
    const body = p.split('\n').slice(1).filter((l) => !HARNESS_LINE.test(l) && !/^\s*```/.test(l)).join('\n').trim();
    if (body) kept.push(`### ${head}\n${body}`);
  }
  const out = kept.join('\n\n');
  return out.length > max ? `${out.slice(0, max)}\n…(cut)` : out;
}

/** The message aider gets: a short edit brief. Never a harness command. */
export function editBrief({ task, title = '', brief = '', lanePaths = [], files = [] }) {
  const lane = lanePathsOf(lanePaths);
  const from = briefForAider(brief);
  const L = [
    `# Edit task ${task}`,
    '',
    'Make the code change this task asks for by editing files, then stop. Do not run commands and do not commit: when you finish, the studio commits your edits, runs the task\'s check and hands the result on.',
    '',
    '## Where to edit',
    lane.length ? `- Only these paths (the task's lane): ${lane.map((p) => `\`${p}\``).join(', ')}.` : '- The game\'s own files only; keep the change small and in one place.',
    ...(files.length ? [`- Already in the chat: ${files.map((p) => `\`${p}\``).join(', ')}.`] : []),
    '',
    '## Rules for edits',
    '- The game\'s sim (cartridges/<name>/): no DOM, window, WebGL or three; fixed ticks; seeded RNG only (no Math.random, no Date.now); state is plain JSON.',
    '- Keep tunable numbers in the game\'s config or data files, not in logic.',
    '- Never edit the studio\'s own folders (harness/, hub/, scripts/, tools/, studio/, qa/*.mjs) or protected files (scenarios\' expected outcomes, regressions, gates); never weaken a test.',
    '- Never write keys or tokens into any file.',
    '- If the task can\'t be done by editing these files, change nothing and say why in one line.',
  ];
  if (from) L.push('', '## From the task\'s brief', from);
  else if (title) L.push('', '## The task', untrustedBlock([{ label: `Task title (${task})`, text: title }]).trimEnd());
  return `${L.join('\n')}\n`;
}

/** The last lines aider printed (the launcher's own lines left out), secrets scrubbed. */
export function aiderTailLines(text, { lines = 8, secrets = [] } = {}) {
  let s = String(text || '').replace(/\r\n/g, '\n');
  for (const k of secrets.filter((x) => x && String(x).length >= 6)) s = s.split(String(k)).join('<key>');
  return s.split('\n').map((l) => l.trimEnd()).filter((l) => l.trim() && !/^\[launcher\]/.test(l)).slice(-lines).map((l) => l.slice(0, 240));
}

// The check's unmet items ("[ ] …" lines) when it prints them, else its last lines.
const unmet = (r) => { const l = `${r?.stdout || ''}${r?.stderr || ''}`.split(/\r?\n/).filter((x) => /^\s*\[ \]/.test(x)).map((x) => x.trim()); return l.length ? l.slice(0, 4).join(' | ').slice(0, 900) : tail(r); };
const tail = (r, n = 6) => `${r?.stdout || ''}${r?.stderr || ''}`.trim().split(/\r?\n/).filter((l) => l.trim()).slice(-n).join(' | ').slice(0, 900);

/** Claim the task the way a builder does, in its copy: { ok, out }. run: spawnSync's shape (tests). */
export function claimTask({ agent, task, model = null, cwd, env, run = spawnSync, timeoutMs = Number(process.env.STUDIO_AIDER_CLAIM_TIMEOUT_MS) || 480000 }) {
  const r = run(process.execPath, [path.join(cwd, 'harness', 'task.mjs'), 'start', task, '--agent', agent, ...(model ? ['--model', model] : [])], { windowsHide: true, cwd, env, encoding: 'utf8', timeout: timeoutMs });
  const timedOut = r.error?.code === 'ETIMEDOUT';
  return { ok: r.status === 0, out: timedOut ? `claim step timed out after ${Math.round(timeoutMs / 1000)} s` : (tail(r, 4) || `exit ${r.status ?? r.signal ?? '?'}`) };
}

/** Files changed in the copy (tracked changes and new files, git's own ignores applied). */
export function changedFiles(cwd, run = spawnSync) {
  const r = run('git', ['status', '--porcelain', '-z', '--untracked-files=all'], { windowsHide: true, cwd, encoding: 'utf8' });
  if (r.status !== 0) return [];
  const out = [];
  const parts = String(r.stdout || '').split('\0');
  for (let i = 0; i < parts.length; i++) {
    const e = parts[i];
    if (!e || e.length < 4) continue;
    out.push(e.slice(3));
    if (/^R|^C/.test(e)) i += 1; // a rename's source follows
  }
  return [...new Set(out)];
}

/**
 * After aider exits: commit, check, done; or hand back. Returns the summary for agent.session.end:
 *   { claimed: true, changed: [files], committed: sha|null, check: 'pass'|'fail'|null, result: 'queued'|'done'|'handed',
 *     cause: null|'no-change'|'red'|'prompt-cap', line }
 * pause(task, agent, note, { cause }): the hand-back (the launcher passes pauseTask with force). queued(task): is it in the
 * merge train's queue now. stopped: { kind, why } when the launcher stopped aider (only 'prompt-cap' gets here).
 */
export function finishAiderTask({ agent, task, title = '', tool, model = null, cwd, env, branch = null, aiderOutput = '', exitCode = 0, stopped = null, secrets = [], pause, queued = () => false, run = spawnSync, timeoutMs = 20 * 60000 }) {
  const said = aiderTailLines(aiderOutput, { secrets });
  const quote = said.length ? ` aider's last lines: "${said.join(' / ').replace(/"/g, "'").slice(0, 700)}".` : ' aider printed nothing.';
  const who = `${agent} (aider on ${tool}${model ? `, ${model}` : ''})`;
  const handBack = (cause, why, extra = {}) => {
    const note = `${who}: claimed ${task} by the launcher; ${why}.${quote}`;
    try { pause(task, agent, note, { cause }); } catch { /* the session end still says it */ }
    return { claimed: true, changed: extra.changed || [], committed: extra.committed || null, check: extra.check || null, result: 'handed', cause, line: `handed back (${cause}): ${why}` };
  };
  if (stopped?.kind === 'prompt-cap') return handBack('prompt-cap', `the launcher stopped aider: ${stopped.why}; its edits were not committed`);
  const changed = changedFiles(cwd, run);
  if (!changed.length) return handBack('no-change', `aider changed no file (exit ${exitCode})`);
  const short = `${changed.slice(0, 4).join(', ')}${changed.length > 4 ? ` +${changed.length - 4}` : ''}`;
  const add = run('git', ['add', '-A', '--', '.'], { windowsHide: true, cwd, env, encoding: 'utf8' });
  const subject = `${task}: ${String(title || 'aider edit').replace(/\s+/g, ' ').trim().slice(0, 100)} (aider on ${tool})`;
  const c = add.status === 0 ? run('git', ['commit', '-q', '-m', subject, '-m', `Studio-Task: ${task}\nStudio-Agent: ${agent}`], { windowsHide: true, cwd, env, encoding: 'utf8', timeout: timeoutMs }) : add;
  if (c.status !== 0) return handBack('red', `aider changed ${changed.length} file(s) (${short}), but the commit was refused: ${tail(c) || `exit ${c.status}`}`, { changed });
  const sha = String(run('git', ['rev-parse', '--short', 'HEAD'], { windowsHide: true, cwd, encoding: 'utf8' }).stdout || '').trim() || null;
  const at = `committed ${sha || '?'}${branch ? ` on ${branch}` : ''}`;
  const task_ = (args) => run(process.execPath, [path.join(cwd, 'harness', 'task.mjs'), ...args], { windowsHide: true, cwd, env, encoding: 'utf8', timeout: timeoutMs });
  const chk = task_(['done', task, '--agent', agent, '--check']);
  if (chk.status !== 0) return handBack('red', `aider changed ${changed.length} file(s) (${short}), ${at}; the task's check failed: ${unmet(chk) || `exit ${chk.status}`}`, { changed, committed: sha, check: 'fail' });
  const done = task_(['done', task, '--agent', agent, '--note', `aider on ${tool}: the launcher committed ${changed.length} file(s) and ran the check`]);
  if (done.status !== 0) return handBack('red', `aider changed ${changed.length} file(s) (${short}), ${at}; the check passed but task done refused: ${unmet(done) || `exit ${done.status}`}`, { changed, committed: sha, check: 'pass' });
  const inQueue = queued(task);
  return { claimed: true, changed, committed: sha, check: 'pass', result: inQueue ? 'queued' : 'done', cause: null, line: `${changed.length} file(s) changed (${short}), ${at}, check passed, ${inQueue ? 'queued for the merge train' : 'task done ran'}` };
}

#!/usr/bin/env node
/**
 * harness/said-vs-did.mjs — what a builder SAYS it ran and changed, checked against what the harness can see.
 *
 * `task done <ID> --claim "<command> => <last line>"` (repeatable) names a command the builder ran and the last line it
 * printed. The command is re-run here from an allowlist (the studio's own read-only checks: verify, selftest units,
 * goldens, regressions, done-check, docs and purity checks; never one that writes, such as --update) and its last
 * non-empty line is compared with the claim. A command outside the allowlist is not re-run: it is reported as
 * unverifiable, never as green. With at least one --claim (2.81: a done with no claim is judged as before), file paths
 * in the --note that are not in the task's diff (commits tagged Studio-Task: <ID>, the lane's unlanded commits, uncommitted edits) are reported
 * as claimed-but-unchanged. Any mismatch emits review.verdict {verdict: 'claim-mismatch'} and task done refuses with
 * the label `claim`. The builder's prose is never evidence; only the re-run and git are.
 *
 * Settings: STUDIO_CLAIM_TIMEOUT_S (default 900) per re-run; STUDIO_CLAIMS=off skips the re-run (the note's file
 * claims are still diffed).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const CLAIM_ALLOWLIST = [
  /^npm run verify(\s|$)/,
  /^npm run (golden|check:purity|playtest(:stage1)?)(\s|$)/,
  /^node qa\/(selftest(-[\w.]+)?|check-golden|check-regressions|vertical-slice|playtest)\.mjs(\s|$)/,
  /^node harness\/done-check\.mjs(\s|$)/,
  /^node harness\/anchors\.mjs\s+(list|show|validate|check)(\s|$)/,
  /^node scripts\/(check-docs|check-sim-purity|check-function-size)\.mjs(\s|$)/,
];
// 2.81 (b2): a re-run only reads. A claim whose command would write (regenerate goldens or regressions, fix, prune,
// add) is not re-run: it is unverifiable, never green.
export const CLAIM_WRITES = /\s--?(update|write|fix|init[\w-]*|prune[\w-]*|accept|bless)\b/;
const UNSAFE = /[|;&`$<>]|\n/;


/**
 * 2.85 (g): the repo-file paths a hand-back note says it created, changed or pointed to ("added X", "wrote X", "see X",
 * "in X"). Conservative: one token with no spaces, no URL, no glob, no placeholder; it has a "/" and an extension, or
 * starts with a known top folder. The check is cheap (does the file exist), and it never refuses: see noteMissingPaths.
 */
const TOP_FOLDERS = /^(harness|qa|studio|docs|game|cartridges|web|scripts|tools|engine|skills|src)\//;
export function notedRepoPaths(note) {
  const text = String(note || '').replace(/\r\n?/g, '\n');
  const out = new Set();
  const re = /\b(?:added|adds|created|creates|wrote|written|writes|changed|changes|updated|updates|edited|modified|renamed|fixed|new|see|in)\s+(?:the\s+|a\s+|file\s+)?[`'"(]?([^\s`'",;:()]+)/gi;
  for (const m of text.matchAll(re)) {
    const p = m[1].replace(/^\.\//, '').replace(/[.]+$/, '');
    if (!p || /[*?{}<>|\\$~]|:\/\/|^(https?:|www\.)|^\/|\.\.\//.test(p)) continue;
    if ((/\//.test(p) && /\.[A-Za-z0-9]{1,8}$/.test(p)) || TOP_FOLDERS.test(p)) out.add(p);
  }
  return [...out];
}

/** The paths the note names that exist in none of `roots` (the lane, then main). Never throws. */
export function noteMissingPaths(note, roots = [REPO_ROOT]) {
  try {
    const where = roots.filter(Boolean);
    return notedRepoPaths(note).filter((p) => !where.some((r) => fs.existsSync(path.join(r, p))));
  } catch { return []; }
}

/** The line the hand-back facts show for one missing path. */
export const noteMissingLine = (p) => `the note names ${p}, which does not exist`;

/** A task.note_unverified event (status warn) for the missing paths. Never refuses anything. */
export function recordNoteUnverified(taskId, missing, { agent = null, where = 'hand-back' } = {}) {
  if (!missing?.length) return null;
  try {
    emitEvent({ type: 'task.note_unverified', agent: agent || 'harness', task: taskId, status: 'warn', msg: `${taskId}: ${missing.slice(0, 5).map(noteMissingLine).join('; ')} (${where})`.slice(0, 600), meta: { missing: missing.slice(0, 20), where } });
  } catch { /* a record, never a blocker */ }
  return missing;
}

/** "<cmd> => <last line>" → { cmd, expect } or { error }. */
export function parseClaim(text) {
  const s = String(text || '').trim();
  const m = s.match(/^(.+?)\s*=>\s*(.+)$/);
  if (!m) return { error: `claim "${s.slice(0, 80)}" is not "<command> => <last line>"` };
  const cmd = m[1].trim();
  const expect = m[2].trim();
  if (UNSAFE.test(cmd)) return { error: `claim command "${cmd.slice(0, 80)}" has shell operators; give one plain command` };
  return { cmd, expect, allowed: CLAIM_ALLOWLIST.some((re) => re.test(cmd)) && !CLAIM_WRITES.test(` ${cmd}`) };
}
export function parseClaims(list) {
  return (Array.isArray(list) ? list : list ? [list] : []).map(parseClaim);
}

const lastLine = (out) => String(out || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean).pop() || '';

/** Re-run one allowed claim; the last non-empty line of stdout+stderr must contain the claimed line (whitespace-folded). */
export function rerunClaim(claim, { cwd = REPO_ROOT, env = process.env, timeoutS = Number(env.STUDIO_CLAIM_TIMEOUT_S || 900) } = {}) {
  if (claim.error) return { ...claim, ok: false, verdict: 'malformed' };
  if (!claim.allowed) return { ...claim, ok: false, verdict: 'unverifiable', why: 'not a read-only studio check the harness re-runs (npm run verify, node qa/selftest.mjs --only …, npm run golden, node qa/check-regressions.mjs, done-check, anchors validate)' };
  const [bin, ...args] = claim.cmd.split(/\s+/);
  const r = spawnSync(bin, args, { windowsHide: true, cwd, encoding: 'utf8', env, timeout: timeoutS * 1000, shell: process.platform === 'win32' });
  const fold = (s) => String(s).replace(/\s+/g, ' ').trim();
  const tail = [...String(r.stdout || '').split(/\r?\n/), ...String(r.stderr || '').split(/\r?\n/)].map((l) => l.trim()).filter(Boolean).slice(-3);
  const got = lastLine(r.stdout) || lastLine(r.stderr);
  const ok = !r.error && tail.some((l) => fold(l).includes(fold(claim.expect)));
  return { ...claim, ok, verdict: r.error ? (r.error.code === 'ETIMEDOUT' ? 'timeout' : 'crash') : ok ? 'matches' : 'mismatch', got: got.slice(0, 300), status: r.status, why: ok ? null : r.error ? `could not re-run (${r.error.code || r.error.message})` : `re-run printed "${got.slice(0, 160)}" (exit ${r.status}), not "${claim.expect.slice(0, 160)}"` };
}

/** Paths a note names (a/b.ext, with at least one slash and an extension). */
export function notedFiles(note) {
  return [...new Set((String(note || '').match(/(?<![\w/.-])(?:[\w.-]+\/)+[\w.-]+\.[A-Za-z0-9]{1,8}(?![\w/])/g) || []).map((p) => p.replace(/^\.\//, '').replace(/[.,;:]+$/, '')))];
}

const git = (args, cwd) => { const r = spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8' }); return r.status === 0 ? r.stdout : ''; };

/** Files the task actually touched: tagged commits, commits since base, the working tree. */
export function taskFiles(taskId, { cwd = REPO_ROOT, base = null } = {}) {
  const out = new Set();
  for (const sha of git(['log', '--format=%H', `--grep=Studio-Task: ${taskId}`, '-n', '100'], cwd).split('\n').filter(Boolean)) for (const f of git(['show', '--name-only', '--format=', sha], cwd).split('\n')) if (f.trim()) out.add(f.trim());
  if (base) for (const f of git(['diff', '--name-only', `${base}..HEAD`], cwd).split('\n')) if (f.trim()) out.add(f.trim());
  for (const l of git(['status', '--porcelain'], cwd).split('\n')) if (l.length > 3) out.add(l.slice(3).trim().replace(/^.* -> /, ''));
  return out;
}

/**
 * The whole judgment for a task done: { ok, results, files: { claimed, unchanged }, mismatches[] }.
 * `files` claims only count when the path exists in the tree or in the diff (a path the note names as "see X" that
 * never existed is reported too: a made-up file is the claim the check is for).
 */
export function judgeClaims(taskId, { claims = [], note = '', cwd = REPO_ROOT, base = null, env = process.env, rerun = !/^(off|0|false|no)$/i.test(String(env.STUDIO_CLAIMS || '')) } = {}) {
  const parsed = parseClaims(claims);
  const results = parsed.map((c) => (rerun ? rerunClaim(c, { cwd, env }) : c.error ? { ...c, ok: false, verdict: 'malformed' } : { ...c, ok: false, verdict: 'not-rerun', why: 'STUDIO_CLAIMS=off: not re-run, not counted as green' }));
  const touched = taskFiles(taskId, { cwd, base });
  const claimed = notedFiles(note).filter((p) => !/^(https?:|www\.)/.test(p));
  const unchanged = claimed.filter((p) => !touched.has(p) && ![...touched].some((t) => t.endsWith(`/${p}`) || p.endsWith(`/${t}`)));
  const mismatches = [
    ...results.filter((r) => ['mismatch', 'malformed', 'crash', 'timeout'].includes(r.verdict)).map((r) => `${r.cmd || r.error}: ${r.why || r.error}`),
    ...(unchanged.length ? [`the note names ${unchanged.slice(0, 5).join(', ')}${unchanged.length > 5 ? ` and ${unchanged.length - 5} more` : ''} but no commit tagged ${taskId}, no lane commit and no uncommitted edit touches ${unchanged.length === 1 ? 'it' : 'them'}`] : []),
  ];
  const unverifiable = results.filter((r) => ['unverifiable', 'not-rerun'].includes(r.verdict)).map((r) => `${r.cmd}: ${r.why}`);
  return { ok: !mismatches.length, results, files: { claimed, unchanged, touched: touched.size }, mismatches, unverifiable };
}

/** Emit the verdict (review.verdict {claim-mismatch}) when something mismatched. */
export function recordClaimVerdict(taskId, judged, { agent = null } = {}) {
  if (judged.ok) return null;
  const meta = { verdict: 'claim-mismatch', mismatches: judged.mismatches.slice(0, 10), unverifiable: judged.unverifiable.slice(0, 10), results: judged.results.map((r) => ({ cmd: r.cmd || null, verdict: r.verdict, got: r.got || null })) };
  emitEvent({ type: 'review.verdict', agent: agent || 'harness', task: taskId, to: 'producer', status: 'blocked', msg: `${taskId}: claim-mismatch: ${judged.mismatches[0]}`.slice(0, 600), meta });
  return meta;
}

export function claimLines(judged) {
  const L = [];
  for (const r of judged.results) L.push(`  [${r.ok ? 'x' : ' '}] claim ${r.cmd || r.error}${r.ok ? ` => ${r.expect}` : `: ${r.verdict}${r.why ? ` (${r.why})` : ''}`}`);
  if (judged.files.claimed.length) L.push(`  [${judged.files.unchanged.length ? ' ' : 'x'}] files the note names: ${judged.files.claimed.length} named, ${judged.files.unchanged.length} not in the task's diff${judged.files.unchanged.length ? ` (${judged.files.unchanged.slice(0, 5).join(', ')})` : ''}`);
  return L;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const id = argv.find((a) => /^[A-Z]+-\d+$/.test(a));
  const claims = argv.flatMap((a, i) => (a === '--claim' && argv[i + 1] ? [argv[i + 1]] : []));
  const note = argv.flatMap((a, i) => (a === '--note' && argv[i + 1] ? [argv[i + 1]] : []))[0] || '';
  if (!id) { console.error('Usage: node harness/said-vs-did.mjs <T-ID> [--claim "<command> => <last line>"]… [--note "…"]'); process.exit(1); }
  const j = judgeClaims(id, { claims, note });
  for (const l of claimLines(j)) console.log(l);
  for (const u of j.unverifiable) console.log(`  ? ${u}`);
  console.log(j.ok ? 'claims hold' : `claim mismatch: ${j.mismatches.join('; ')}`);
  process.exit(j.ok ? 0 : 1);
}

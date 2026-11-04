#!/usr/bin/env node
/**
 * harness/holdout.mjs — 2.78.0 (PU-54): held-out checks the builders cannot read, run at the merge train only.
 *
 * Builders can read every visible check, so a builder can tune its work to them (special-case the golden seed). A held-out
 * case is a command whose expected result no builder has seen. The cases are JSON files in STUDIO_HOLDOUT_DIR (default
 * <main checkout's parent>/<main checkout's folder name>-holdout: outside every checkout, so no lane copy links to it;
 * harness/holdout-dir.mjs). The path guard hook denies builder and lane sessions reads of it. docs/HOLDOUT.md.
 *
 *   node harness/holdout.mjs run                  the `holdout` gate. Runs only at the train (STUDIO_GATE_PRIORITY=landing);
 *                                                 anywhere else it prints "runs at the train only" and passes.
 *                                                 No folder or no cases: passes, "no held-out cases".
 *                                                 A failing case prints its id and note, never its command or expected values.
 *   node harness/holdout.mjs list                 ids and notes only
 *   node harness/holdout.mjs add <id> --command "…" [--expect-exit N] [--expect-stdout-of-current] [--contains "…"]…
 *                                [--cwd rel] [--note "…"]
 *                                                 for the owner or Producer. --expect-stdout-of-current runs the command once
 *                                                 on the main checkout now and records the stdout's sha256.
 *
 * A case: { id, command, cwd?: "relative to the studio root", expect: { exit?, stdoutSha256?, contains?: [] }, note }.
 * stdout is compared after CRLF -> LF.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { holdoutDir, mainRootOf, isBuilderSession } from './holdout-dir.mjs';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const sha = (s) => crypto.createHash('sha256').update(String(s).replace(/\r\n/g, '\n')).digest('hex');
export const atTrain = (env = process.env) => String(env.STUDIO_GATE_PRIORITY || '') === 'landing';

export function loadCases(dir) {
  let names = [];
  try { names = fs.readdirSync(dir).filter((f) => f.endsWith('.json')).sort(); } catch { return []; }
  const out = [];
  for (const f of names) {
    try { const c = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8')); if (c && c.command) out.push({ ...c, id: c.id || f.replace(/\.json$/, '') }); }
    catch { out.push({ id: f.replace(/\.json$/, ''), note: 'case file is not valid JSON', broken: true }); }
  }
  return out;
}

/** Run one case in `root`. Returns { ok } only: never the command, the output or the expected values. */
export function runCase(c, root, env = process.env) {
  if (c.broken) return { ok: false };
  const cwd = path.resolve(root, c.cwd || '.');
  if (path.relative(root, cwd).startsWith('..') || path.isAbsolute(path.relative(root, cwd))) return { ok: false };
  const r = spawnSync(c.command, { cwd, shell: true, encoding: 'utf8', windowsHide: true, env, maxBuffer: 64 * 1024 * 1024, timeout: Number(env.STUDIO_HOLDOUT_TIMEOUT_MS || 300000) });
  const e = c.expect || {};
  const stdout = String(r.stdout || '').replace(/\r\n/g, '\n');
  const ok = r.error == null && (e.exit == null ? true : r.status === e.exit)
    && (e.stdoutSha256 == null || sha(stdout) === e.stdoutSha256)
    && (e.contains || []).every((s) => stdout.includes(s));
  return { ok };
}

function parseArgs(a) {
  const o = { _: [], contains: [] };
  for (let i = 0; i < a.length; i++) {
    const k = a[i];
    if (k === '--command') o.command = a[++i];
    else if (k === '--expect-exit') o.exit = Number(a[++i]);
    else if (k === '--expect-stdout-of-current') o.current = true;
    else if (k === '--contains') o.contains.push(a[++i]);
    else if (k === '--cwd') o.cwd = a[++i];
    else if (k === '--note') o.note = a[++i];
    else o._.push(k);
  }
  return o;
}

function main(argv, env = process.env) {
  const [cmd, ...rest] = argv;
  const dir = holdoutDir(ROOT, env);
  if (cmd === 'run') {
    if (!atTrain(env)) { console.log('[holdout] skipped: runs at the train only (the merge train runs the held-out cases)'); return 0; }
    const cases = loadCases(dir);
    if (!cases.length) { console.log('[holdout] PASS no held-out cases'); return 0; }
    const failed = cases.filter((c) => !runCase(c, ROOT, env).ok);
    for (const c of failed) console.log(`[holdout] FAIL ${c.id}: ${c.note || '(no note)'}`);
    if (failed.length) { console.log(`[holdout] FAIL ${failed.length} of ${cases.length} held-out case(s) failed`); return 1; }
    console.log(`[holdout] PASS ${cases.length} held-out case(s)`);
    return 0;
  }
  if (cmd === 'list') {
    const cases = loadCases(dir);
    if (!cases.length) console.log('no held-out cases');
    for (const c of cases) console.log(`${c.id}\t${c.note || ''}`);
    return 0;
  }
  if (cmd === 'add') {
    const o = parseArgs(rest);
    const id = o._[0];
    if (isBuilderSession(ROOT, env)) { console.error('[holdout] add: the owner or Producer makes cases, not a builder or a lane session'); return 1; }
    if (!id || !/^[\w.-]+$/.test(id) || !o.command) { console.error('usage: node harness/holdout.mjs add <id> --command "…" [--expect-exit N] [--expect-stdout-of-current] [--contains "…"] [--cwd rel] [--note "…"]'); return 2; }
    const expect = {};
    if (Number.isInteger(o.exit)) expect.exit = o.exit;
    if (o.contains.length) expect.contains = o.contains;
    if (o.current) {
      const main = mainRootOf(ROOT, env);
      const r = spawnSync(o.command, { cwd: path.resolve(main, o.cwd || '.'), shell: true, encoding: 'utf8', windowsHide: true, env, maxBuffer: 64 * 1024 * 1024 });
      if (expect.exit == null) expect.exit = r.status ?? 1;
      expect.stdoutSha256 = sha(r.stdout);
    }
    if (!Object.keys(expect).length) { console.error('[holdout] add: give --expect-exit, --contains or --expect-stdout-of-current'); return 2; }
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${id}.json`);
    fs.writeFileSync(file, `${JSON.stringify({ id, command: o.command, ...(o.cwd ? { cwd: o.cwd } : {}), expect, note: o.note || '' }, null, 2)}\n`);
    console.log(`[holdout] wrote case ${id}`);
    return 0;
  }
  console.error('usage: node harness/holdout.mjs run | list | add <id> --command "…" …');
  return 2;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exit(main(process.argv.slice(2)));

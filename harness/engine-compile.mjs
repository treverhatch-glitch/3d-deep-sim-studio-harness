/**
 * harness/engine-compile.mjs — 2.90: the engine train's compile search. Before a batch's land run, the studio's cheap
 * compile command (engines.<x>.quickCheck, or engines.<x>.compileSearch when it is a command; false: off) runs on the
 * batch as it would land, in a throwaway checkout of the engine repo. Red there and green on the target: merged
 * prefixes find the lanes that do not compile together with the ones before them; those are handed back with the
 * compiler's own lines, and the rest go on to ONE land run. A red on the target itself judges nobody.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { rulesCheckout, removeCheckout, changedPaths } from './engine-rules.mjs';
import { compileErrorFiles } from './unity-gate.mjs';
import { numBlankDefault as num } from './helpers.mjs';

/** The compile search's command: { command, timeoutMin, source } or null (off, or nothing to run). */
export function compileSearchOf(cfg = {}) {
  const v = cfg?.compileSearch;
  if (v === false || /^(off|false|no|0)$/i.test(String(v ?? '').trim())) return null;
  if (typeof v === 'string' && v.trim()) return { command: v.trim(), timeoutMin: Math.max(1, num(cfg.quickCheckTimeoutMin, 30)), source: 'compileSearch' };
  const q = typeof cfg?.quickCheck === 'string' ? cfg.quickCheck.trim() : '';
  return q ? { command: q, timeoutMin: Math.max(1, num(cfg.quickCheckTimeoutMin, 30)), source: 'quickCheck' } : null;
}

/** The compiler's error lines in a command's output: unique, the checkout folder and the project suffix taken out, 8 at most. */
export function compilerLines(text, dir = '') {
  const strip = (l) => {
    let x = l.trim().replace(/\s*\[[^\]]*\.(cs|fs|vb)proj\]\s*$/i, '');
    for (const d of [dir, dir.split(path.sep).join('/')].filter(Boolean)) x = x.split(`${d}/`).join('').split(`${d}\\`).join('');
    return x;
  };
  const seen = new Set();
  for (const l of String(text || '').replace(/\r\n?/g, '\n').split('\n')) {
    if (!/\berror\b\s*[A-Z]{2,}\d{3,}\b|:\s*error\b/i.test(l) || /^\s*\d+\s+Error\(s\)/i.test(l)) continue;
    seen.add(strip(l));
    if (seen.size >= 8) break;
  }
  return [...seen];
}

/** Run the compile command on one commit in a throwaway checkout. { status: 'pass'|'red'|'error', why, lines, files, tail, ms }. */
export function compileAt({ repo, sha, cmd, root, id = 'compile', engine = 'unity', rules = null, env = process.env, log = () => {} } = {}) {
  const dir = path.join(root, '.studio', 'tmp', `compile-${String(id).replace(/[^A-Za-z0-9._-]/g, '_')}-${String(sha).slice(0, 10)}`);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  removeCheckout(repo, dir);
  const co = rulesCheckout({ repo, sha, dir, cfg: { paths: rules?.paths || [], lfs: rules?.lfs === true }, env, log, engine });
  if (!co.ok) return { status: 'error', why: `could not check ${String(sha).slice(0, 10)} out for the compile search: ${co.why}`, lines: [], files: [] };
  const t0 = Date.now();
  try {
    log(`[engine-compile] ${engine}: ${cmd.command} on ${String(sha).slice(0, 10)}${co.sparse ? ' (sparse checkout)' : ''}`);
    const r = spawnSync(cmd.command, { shell: true, cwd: dir, encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024, timeout: cmd.timeoutMin * 60000, env: { ...env, STUDIO_ENGINE: engine, STUDIO_ENGINE_LANE_DIR: dir, STUDIO_ENGINE_REPO: repo } });
    const ms = Date.now() - t0;
    const text = `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n?/g, '\n').trimEnd();
    if (r.error) return { status: 'error', why: r.error.code === 'ETIMEDOUT' ? `the compile command timed out after ${cmd.timeoutMin} min (engines.${engine}.quickCheckTimeoutMin)` : `the compile command could not run: ${r.error.code || r.error.message}`, lines: [], files: [], ms };
    if (r.status === 0) return { status: 'pass', why: `compiles (${Math.round(ms / 1000)} s)`, lines: [], files: [], ms };
    const lines = compilerLines(text, dir);
    const d = dir.split(path.sep).join('/');
    const rel = (f) => (f.startsWith(`${d}/`) ? f.slice(d.length + 1) : f);
    return { status: 'red', why: `the compile command exited ${r.status ?? r.signal ?? '?'}`, lines, files: compileErrorFiles(text).map(rel), tail: text.split('\n').slice(-8).join('\n'), ms };
  } finally { removeCheckout(repo, dir); }
}

/**
 * The search. lanes in queue order; chain(tip, lanes) -> { head } | { error }; at(sha) -> compileAt's result. Returns
 * { ran, green?, targetRed?, kept, left: [{ lane, with: [lane], lines, files }], runs, why }. Each left lane is the last of
 * the smallest prefix that does not compile; `with` are the lanes before it that change a file the compiler names (all
 * of them when none does). maxRuns bounds the compile runs.
 */
export function compileSearch({ repo, tip, lanes = [], chain, at, maxRuns = 12 } = {}) {
  const res = { ran: false, kept: lanes.slice(), left: [], runs: 0, why: '' };
  const memo = new Map();
  const treeOf = (sha) => String(spawnSync('git', ['rev-parse', `${sha}^{tree}`], { cwd: repo, encoding: 'utf8', windowsHide: true }).stdout || '').trim() || sha;
  const run = (sha) => { const k = treeOf(sha); if (!memo.has(k)) { memo.set(k, at(sha)); res.runs += 1; } return memo.get(k); };
  let set = lanes.slice();
  const c0 = chain(tip, set);
  if (c0.error || !c0.head) return { ...res, why: `the batch could not be built (${c0.error || 'no head'})` };
  let r = run(c0.head);
  if (r.status === 'pass') return { ...res, ran: true, green: true, why: `the batch compiles (${r.why})` };
  if (r.status !== 'red') return { ...res, why: `${r.why}: the land run decides` };
  const t = run(tip);
  if (t.status !== 'pass') return { ...res, targetRed: true, why: `the compile command is ${t.status} on the target itself (${t.why}), so it judges no lane` };
  res.ran = true;
  while (r.status === 'red' && set.length) {
    let lo = 0; let hi = set.length; let bad = r; let stuck = false;
    while (hi - lo > 1) {
      if (res.runs >= maxRuns) { stuck = true; break; }
      const mid = Math.floor((lo + hi) / 2);
      const p = chain(tip, set.slice(0, mid));
      const rm = p.error || !p.head ? { status: 'error' } : run(p.head);
      if (rm.status === 'pass') lo = mid; else if (rm.status === 'red') { hi = mid; bad = rm; } else { stuck = true; break; }
    }
    if (stuck) { res.why = `the compile search stopped after ${res.runs} run(s): the land run decides for ${set.map((l) => l.task).join(', ')}`; break; }
    const lane = set[hi - 1];
    const before = set.slice(0, hi - 1);
    const files = bad.files || [];
    const touching = before.filter((l) => (changedPaths(repo, tip, l.head) || []).some((f) => files.some((e) => e === f || e.endsWith(`/${f}`) || f.endsWith(`/${e}`))));
    res.left.push({ lane, with: touching.length ? touching : before, lines: bad.lines || [], files, tail: bad.tail || '' });
    set = set.filter((l) => l.task !== lane.task);
    if (!set.length || res.runs >= maxRuns) break;
    const c = chain(tip, set);
    if (c.error || !c.head) break;
    r = run(c.head);
  }
  res.kept = set;
  if (!res.why) res.why = `${res.left.length} lane(s) do not compile with the others (${res.left.map((x) => x.lane.task).join(', ')}); ${set.length} go on`;
  return res;
}

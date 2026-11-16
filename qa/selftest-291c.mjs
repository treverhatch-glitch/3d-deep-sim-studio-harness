/**
 * qa/selftest-291c.mjs — 2.91: the stall rule counts reads of the task's own files as progress.
 * focus  namedFiles lists the existing files and folders a task names (ranges, lane, paths, holds, title, scope).
 * stall  a Read, Grep or Glob of a named file or of a path under a named folder (absolute, relative, either slash,
 *   the lane copy's root or the main root) holds the clock; a file the task does not name does not. Reads hold it for
 *   at most STUDIO_STALL_READ_MAX_MIN (2 x the stall limit; 0 is off) since the last write; the verdict then names them.
 * log    the session log is read from a saved byte offset; a missing log is zero reads; a half-written line waits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlIn as u, gEnvOf, gitArgsOf, guardOf, out } from './kit.mjs';

export async function selftest291C({ dir, run, report, tmpRoot, root }) {
  void run; void root;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitArgsOf(gEnvOf(ident));
  const guard = guardOf(report);
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    CLAUDECODE: '', AI_AGENT: '', NODE_OPTIONS: '', STUDIO_DRIFT: 'off', STUDIO_STALL: '', STUDIO_STALL_MIN: '', STUDIO_STALL_PLAN_MIN: '', STUDIO_SESSION_MAX_MIN: '', STUDIO_STALL_READ_MAX_MIN: '',
    STUDIO_STALL_VERIFY_MAX_MIN: '', STUDIO_DONE_RUNNING_MAX_MIN: '90', STUDIO_MACHINE_SCAN: 'off', STUDIO_THREADS: '', STUDIO_LANELESS: 'shared', ...ident,
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `291c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-291c.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    for (const f of ['docs/port-plan.md', 'cartridges/demo/sim.ts', 'cartridges/demo/parts/a.ts', 'docs/other.md']) { fs.mkdirSync(path.dirname(path.join(S, f)), { recursive: true }); fs.writeFileSync(path.join(S, f), 'x\n'); }
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const probe = (S, env, name, code) => {
    const f = path.join(tmpRoot, `probe-291c-${name}-${process.pid}-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000 });
    const t = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(t), _err: r.stderr?.slice(-1500) }; } catch { return { _err: `${out(r).slice(-2500)}` }; }
  };
  // Shared probe code: a log kept outside the copy, a fake clock, and a helper that adds one tool call to the log.
  const prelude = (S, logName) => `import fs from 'node:fs'; import path from 'node:path';
import { observe, readStall } from ${u(S, 'harness/stall.mjs')};
const root = path.resolve('.'); const M = 60000; const t0 = Date.now() - 40 * M; const iso = (t) => new Date(t).toISOString();
const log = ${JSON.stringify(path.join(tmpRoot, `${logName}-${process.pid}.log`))}; fs.writeFileSync(log, '');
let k = 0;
const call = (name, input) => fs.appendFileSync(log, JSON.stringify({ type: 'assistant', message: { id: 'm' + (k++), content: [{ type: 'tool_use', id: 't' + k, name, input }] } }) + '\\n');
const sess = (agent) => ({ agent, role: 'builder', startedAt: iso(t0), task: 'T-1' });
const beat = (s, min, files, roots = [root], file = log) => observe(s, { now: t0 + min * M, cwd: root, events: [], reads: { files, log: file, from: 0, roots } });
`;

  await guard('2.91: namedFiles returns the files of a task\'s path:N-M ranges, its lane, paths, holds, a folder and a path word in its title or scope, and drops a path that does not exist (fails before this fix: no such function)', async () => {
    const { S, env } = studio('named');
    const r = probe(S, env, 'named', `import { namedFiles } from ${u(S, 'harness/focus.mjs')};
const root = process.cwd();
const a = namedFiles({ title: 'Port docs/port-plan.md:10-40 and docs/gone.md:1-5' }, root);
const b = namedFiles({ title: 'Port it', lane: 'cartridges/demo/sim.ts', paths: ['cartridges/demo/parts/'], holds: 'docs/other.md,docs/missing.md', scope: 'also see docs/nothing.md' }, root);
const c = namedFiles({ title: 'Read docs/other.md first', scope: 'keep to cartridges/demo/parts' }, root);
console.log(JSON.stringify({ a, b, c }));`);
    const has = (l, ...x) => x.every((f) => (l || []).includes(f));
    const ok = has(r.a, 'docs/port-plan.md') && !r.a.includes('docs/gone.md') && has(r.b, 'cartridges/demo/sim.ts', 'cartridges/demo/parts', 'docs/other.md')
      && !r.b.some((f) => /missing|nothing/.test(f)) && has(r.c, 'docs/other.md', 'cartridges/demo/parts');
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  await guard('2.91: a session with no write whose new reads are of a file its task names is not stalled at the stall limit (15 min), and records that its last progress was a read; a read of a file the task does not name holds nothing and the session is stalled (fails before this fix: both were stalled at 16 min)', async () => {
    const { S, env } = studio('reads');
    const r = probe(S, env, 'reads', `${prelude(S, 'reads')}
const files = ['docs/port-plan.md'];
const a = sess('builder-a1'); beat(a, 0, files);
call('Read', { file_path: 'docs/port-plan.md' }); beat(a, 14, files);
call('Read', { file_path: 'docs/port-plan.md' }); const va = beat(a, 28, files);
const b = sess('builder-b1'); beat(b, 0, files);
call('Read', { file_path: 'docs/other.md' }); const vb = beat(b, 16, files);
console.log(JSON.stringify({ va, vb, kind: readStall('builder-a1')?.lastProgress }));`);
    const ok = r.va?.stalled === false && r.kind === 'read' && r.vb?.stalled === true && r.vb.kind === 'no-progress';
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  await guard('2.91: reads of a file under a named folder count (Read, Grep and Glob with a path), also a file the lane copy holds, an absolute path, and a path with backslashes; a folder outside the task or the root does not (fails before this fix: each was stalled at 16 min)', async () => {
    const { S, env } = studio('forms');
    const r = probe(S, env, 'forms', `${prelude(S, 'forms')}
const files = ['cartridges/demo/parts', 'docs/port-plan.md'];
const lane = path.join(root, '.lanes', 'builder-x');
const one = (id, name, input, roots) => { const s = sess(id); beat(s, 0, files, roots); call(name, input); return beat(s, 16, files, roots).stalled; };
const out = {
  under: one('builder-f1', 'Read', { file_path: 'cartridges/demo/parts/a.ts' }),
  grep: one('builder-f2', 'Grep', { pattern: 'x', path: 'cartridges/demo/parts' }),
  glob: one('builder-f3', 'Glob', { pattern: '*.ts', path: 'cartridges/demo/parts' }),
  abs: one('builder-f4', 'Read', { file_path: path.join(root, 'docs', 'port-plan.md') }),
  back: one('builder-f5', 'Read', { file_path: 'docs\\\\port-plan.md' }),
  absBack: one('builder-f6', 'Read', { file_path: path.join(root, 'docs', 'port-plan.md').replace(/\\//g, '\\\\') }),
  laneCopy: one('builder-f7', 'Read', { file_path: path.join(lane, 'docs', 'port-plan.md') }, [lane, root]),
  elsewhere: one('builder-f8', 'Read', { file_path: '/elsewhere/docs/port-plan.md' }),
  siblingFolder: one('builder-f9', 'Read', { file_path: 'cartridges/demo/parts-other/a.ts' }),
};
console.log(JSON.stringify(out));`);
    const ok = ['under', 'grep', 'glob', 'abs', 'laneCopy'].every((k) => r[k] === false) && r.elsewhere === true && r.siblingFolder === true
      && (process.platform === 'win32' ? r.back === false && r.absBack === false : r.back === false);
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  await guard('2.91: reads hold the clock for at most STUDIO_STALL_READ_MAX_MIN (default 2 x 15 = 30 min) since the last write: reads every 10 min keep a session alive at 20 min, and at 30 min it is stalled with "reads of the task\'s files held the clock for 20 min" in its message (fails before this fix: no bound, and no such message)', async () => {
    const { S, env } = studio('bound');
    const r = probe(S, env, 'bound', `${prelude(S, 'bound')}
const files = ['docs/port-plan.md']; const a = sess('builder-b2'); beat(a, 0, files);
const v = {};
for (const m of [10, 20, 30]) { call('Read', { file_path: 'docs/port-plan.md' }); v[m] = beat(a, m, files); }
console.log(JSON.stringify(v));`);
    const ok = r['10']?.stalled === false && r['20']?.stalled === false && r['30']?.stalled === true && r['30'].kind === 'no-progress'
      && /no file write, commit or task change for 30 min \(reads of the task's files held the clock for 20 min\)/.test(r['30'].why);
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  await guard('2.91: STUDIO_STALL_READ_MAX_MIN=0 turns the read rule off (a read of a named file does not hold the clock: stalled at 16 min, no mention of reads), and a set value is the bound (6 min: a read at 4 min holds the clock, but at 16 min the session is stalled and the message names the reads) (fails before this fix: the setting did nothing)', async () => {
    const { S, env } = studio('off');
    const code = `${prelude(S, 'off')}
const files = ['docs/port-plan.md']; const a = sess('builder-o1'); beat(a, 0, files);
call('Read', { file_path: 'docs/port-plan.md' }); const v1 = beat(a, 4, files); const v2 = beat(a, 16, files);
console.log(JSON.stringify({ v1, v2 }));`;
    const off = probe(S, { ...env, STUDIO_STALL_READ_MAX_MIN: '0' }, 'off', code);
    const six = probe(S, { ...env, STUDIO_STALL_READ_MAX_MIN: '6' }, 'six', code.replace(/builder-o1/g, 'builder-o2'));
    const ok = off.v1?.stalled === false && off.v2?.stalled === true && !/reads of/.test(off.v2.why) && six.v1?.stalled === false && six.v2?.stalled === true && /held the clock for 4 min/.test(six.v2.why);
    return [ok, JSON.stringify({ off, six }).slice(0, 1500)];
  });

  await guard('2.91: a missing session log is zero reads and never throws (the session is judged by writes as before: stalled at 16 min); the log is read from a saved offset: a beat with no new lines adds no reads, and a half-written last line is not counted until its newline arrives (fails before this fix: no read counting)', async () => {
    const { S, env } = studio('inc');
    const r = probe(S, env, 'inc', `${prelude(S, 'inc')}
const files = ['docs/port-plan.md'];
let err = null; let miss = null;
try { const m = sess('builder-m1'); beat(m, 0, files, [root], path.join(root, 'no-such.log')); miss = beat(m, 16, files, [root], path.join(root, 'no-such.log')); } catch (e) { err = e.message; }
const a = sess('builder-i1'); beat(a, 0, files);
const cnt = () => readStall('builder-i1')?.reads?.count;
call('Read', { file_path: 'docs/port-plan.md' }); beat(a, 1, files); const c1 = cnt(); const off1 = readStall('builder-i1').reads.offset;
beat(a, 2, files); const c2 = cnt();
const line = JSON.stringify({ type: 'assistant', message: { id: 'half', content: [{ type: 'tool_use', id: 'th', name: 'Read', input: { file_path: 'docs/port-plan.md' } }] } });
fs.appendFileSync(log, line.slice(0, 40)); beat(a, 3, files); const c3 = cnt(); const off3 = readStall('builder-i1').reads.offset;
fs.appendFileSync(log, line.slice(40) + '\\n'); beat(a, 4, files); const c4 = cnt();
console.log(JSON.stringify({ err, miss, c1, c2, c3, c4, same: off1 === off3 }));`);
    const ok = r.err === null && r.miss?.stalled === true && r.c1 === 1 && r.c2 === 1 && r.c3 === 1 && r.same === true && r.c4 === 2;
    return [ok, JSON.stringify(r).slice(0, 1500)];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}

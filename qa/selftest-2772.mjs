/**
 * qa/selftest-2772.mjs — 2.77.2: the crew's first live hours on 2.77.1 (B-104, B-106, B-107).
 *   B-107  an agent that ended with no commits got a full launcher verify of its empty lane (main's own commits naming the
 *          task were taken for its work), and while that ran it "worked on the whole game", so no builder started.
 *   B-106  a speculative train that was still verifying (beating, no lock yet) was reported "died silently".
 *   B-104  an update merged by an older upgrade guard: `hook-stamp.mjs grandfather --ref <remote ref>` lists its commits.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2772({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '' };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2772-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    const ev = path.join(S, '.studio', 'events-2772.jsonl'); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2772-${++n}.mjs`); fs.writeFileSync(f, code); const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);

  // ---- B-107 ----
  {
    const { S, env } = studio('b107');
    const r = probe(S, `import { workCommitted } from ${u(S, 'harness/agent.mjs')};
import { laneClashWith } from ${u(S, 'harness/supervisor.mjs')};
import { lanesClash } from ${u(S, 'harness/task-hold.mjs')};
let asked = 0;
const hit = () => { asked++; return true; };
const g = { role: 'builder', lane: null };
console.log(JSON.stringify({
  copyEmpty: workCommitted({ ahead: 0, inCopy: true, logHit: hit }),
  askedInCopy: asked,
  copyAhead: workCommitted({ ahead: 2, inCopy: true, logHit: hit }),
  shared: workCommitted({ ahead: 0, inCopy: false, logHit: hit }),
  sharedNone: workCommitted({ ahead: 0, inCopy: false, logHit: () => false }),
  exitedBlocks: Boolean(laneClashWith([{ agent: 'builder-agyf8', role: 'builder', lane: null, agentExited: { code: 0 } }], g, lanesClash)),
  endingBlocks: Boolean(laneClashWith([{ agent: 'builder-x', role: 'builder', lane: null, ending: { why: 'its agent exited' } }], g, lanesClash)),
  liveBlocks: Boolean(laneClashWith([{ agent: 'builder-y', role: 'builder', lane: null }], g, lanesClash)),
}));
`, env);
    await guard('2.77.2 (B-107): in a lane copy only the branch\'s own commits count as the session\'s work: an empty lane is not "committed" (no launcher verify), even when main has commits naming the task; ahead 2 is; the shared checkout still searches the log (fails on 2.77.1: the log search found main\'s commits, so an empty lane got a full verify)', () => [
      r.j && r.j.copyEmpty === false && r.j.askedInCopy === 0 && r.j.copyAhead === true && r.j.shared === true && r.j.sharedNone === false, JSON.stringify({ j: r.j, out: out(r).slice(-500) })]);
    await guard('2.77.2 (B-107): a session whose agent has exited (or that is wrapping up) no longer "works on the whole game", so it doesn\'t stop every other builder; a live session with no lane still does (fails on 2.77.1: the ending agent blocked all launches for ~20 min)', () => [
      r.j && r.j.exitedBlocks === false && r.j.endingBlocks === false && r.j.liveBlocks === true, JSON.stringify(r.j)]);
  }

  // ---- B-106 ----
  {
    const { S, env } = studio('b106');
    const id = '20261104-200655-37648';
    const at = new Date(Date.now() - 20 * 60000).toISOString();
    fs.appendFileSync(env.AGENT_EVENTS_FILE, `${JSON.stringify({ ts: at, type: 'task.train.start', agent: `train-${id}`, msg: `train ${id} started`, meta: { train: id } })}\n`);
    fs.mkdirSync(path.join(S, '.studio', 'train', id), { recursive: true });
    const r = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import { commFacts } from ${u(S, 'harness/communicator.mjs')};
const beat = path.join(process.cwd(), '.studio', 'train', ${JSON.stringify(id)}, 'beat');
fs.writeFileSync(beat, String(Date.now() - 20000));
const a = await commFacts({ root: process.cwd(), now: Date.now(), state: {}, deps: { machine: null, needs: [] } });
fs.writeFileSync(beat, String(Date.now() - 45 * 60000));
const b = await commFacts({ root: process.cwd(), now: Date.now(), state: {}, deps: { machine: null, needs: [] } });
console.log(JSON.stringify({ beating: (a.unendedTrains || []).map((t) => t.id), stale: (b.unendedTrains || []).map((t) => t.id) }));
`, env);
    await guard('2.77.2 (B-106): a train with no end event and no lock that is still beating (a speculative train verifying) is not reported "died silently"; with its heartbeat 45 min old it is (fails on 2.77.1: the speculative train was a false "train-dead" alert)', () => [
      r.j && r.j.beating.length === 0 && r.j.stale.includes(id), JSON.stringify({ j: r.j, out: out(r).slice(-600) })]);
  }

  // ---- B-104 ----
  {
    const { S, env } = studio('b104');
    const remote = path.join(tmpRoot, `2772-remote-${process.pid}-${++n}`);
    g(tmpRoot, 'init', '-q', '--bare', remote);
    g(S, 'remote', 'add', 'origin', remote);
    g(S, 'push', '-q', 'origin', 'main');
    g(S, 'checkout', '-qb', 'upstream');
    fs.writeFileSync(path.join(S, 'harness', 'update-2772.mjs'), 'export const x = 1;\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'harness: an update commit made without the hooks', '--no-verify');
    const up = g(S, 'rev-parse', 'HEAD').stdout.trim();
    g(S, 'push', '-q', 'origin', 'upstream');
    g(S, 'fetch', '-q', 'origin');
    g(S, 'checkout', '-q', 'main');
    g(S, 'branch', 'local-work', up);
    const local = run(S, 'node harness/hook-stamp.mjs grandfather --ref local-work', { ...env, ...ident, STUDIO_PROTECT_BASE: 'main' });
    const ok = run(S, 'node harness/hook-stamp.mjs grandfather --ref origin/upstream', { ...env, ...ident, STUDIO_PROTECT_BASE: 'main' });
    const gf = (() => { try { const f = path.join(S, '.git', 'studio-hooks-grandfather.json'); return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } })();
    await guard('2.77.2 (B-104): `hook-stamp.mjs grandfather --ref origin/<branch>` lists the fetched update\'s unstamped commits (an update an older guard merged) as exempt; a local branch is refused (fails on 2.77.1: no --ref, only local unpushed work)', () => [
      local.status === 1 && /isn't a remote-tracking ref/.test(out(local)) && ok.status === 0 && /PASS 1 unstamped commit/.test(out(ok)) && gf && gf.shas.includes(up),
      JSON.stringify({ local: out(local).slice(-300), ok: out(ok).slice(-400), gf: gf && gf.shas.length })]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}

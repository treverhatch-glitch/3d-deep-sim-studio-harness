/**
 * qa/selftest-295d.mjs — 2.95 (d): no session starts on a task whose branch is queued for an engine train while the
 * task waits for another task (task after). The pick skips it, `task start` refuses it in plain words, and queueing the
 * same branch at the same head again changes nothing. A task that is only held, or only queued, behaves as before.
 *
 * The scaffolding (a studio copy, a made-up engine repo, the queue file) is qa/selftest-284u.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { eventsOf as eventsFileOf, eventTypesOf, fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, readJsonFile as readJson, writeIn as write } from './kit.mjs';

export async function selftest295D({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s295d-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-295d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `295d-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-295d.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const evs = eventTypesOf(eventsFileOf(evFile));
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-295d-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const cli = (args) => spawnSync(process.execPath, ['harness/task.mjs', ...args], { windowsHide: true, cwd: S, env: envOf(), encoding: 'utf8', timeout: 120000 });

  try {
    // ---- a made-up engine repo with one branch ahead of its target, and the unity engine's settings ----
    const R = path.join(T, 'repo');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'base.txt', 'base\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    g(R, 'checkout', '-q', '-b', 'feat/a');
    write(R, 'a.txt', 'a\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'feat/a work');
    const head = g(R, 'rev-parse', 'feat/a').stdout.trim();
    g(R, 'checkout', '-q', 'port/main');
    write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { land: `node -e "0" {branch}`, target: 'port/main', cwd: fwd(R), rules: false } } }, null, 2)}\n`);

    // T-1 is open; T-2 is in progress and T-3 waits in the backlog, both queued and waiting for T-1; T-4 waits for T-1 and is
    // not queued; T-5 and T-6 are queued and wait for nothing.
    const added = {};
    const names = ['Port Fees rounding', 'Port MapNav costs', 'Port Game/Sim ticks', 'Port tools/SimTests runner', 'Port queue ordering', 'Port save format'];
    for (const n of [1, 2, 3, 4, 5, 6]) added[n] = (cli(['add', names[n - 1], '--role', 'engine-porter', '--track', 'unity']).stdout.match(/"id":\s*"([^"]+)"/) || [])[1] || null;
    const [t1, t2, t3, t4, t5, t6] = [1, 2, 3, 4, 5, 6].map((n) => added[n]);
    const started = cli(['start', t2, '--agent', 'porter-a']);
    for (const t of [t2, t3, t4]) cli(['after', t, '--set', t1]);
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    const entry = (t, i) => ({ task: t, agent: `porter-${i}`, branch: 'feat/a', head, at: new Date(Date.now() - 600000 + i).toISOString() });
    const queueFile = path.join(S, '.studio', 'train', 'unity-queue.json');
    fs.writeFileSync(queueFile, JSON.stringify([entry(t2, 0), entry(t3, 1), entry(t5, 2), entry(t6, 3)]));
    // The porter's session over: its claim is gone, the task stays in progress (its branch is queued).
    probe(`import { release } from ${u('harness/lock.mjs')}; release('task:${t2}', 'porter-a', { force: true }); console.log('{}');`);

    const ASK = `import { startRefusal } from ${u('harness/attempts.mjs')}; import { parseNextQueue } from ${u('harness/task.mjs')};
const q = parseNextQueue(); const closed = { ...q, done: [...q.done, { id: '${t1}' }] };
const pick = (id, qq) => { const r = startRefusal(id, { agent: 'porter-b', role: 'engine-porter', q: qq }); return r ? { kind: r.kind, message: r.message } : null; };
const ids = ${JSON.stringify({ t2, t3, t4, t5, t6 })};
const o = {}; for (const [k, id] of Object.entries(ids)) o[k] = { now: pick(id, q), closed: pick(id, closed) };
console.log(JSON.stringify(o));`;
    const asked = probe(ASK);
    const words = (t) => new RegExp(`${t} can't start yet: it waits for ${t1} \\(task after\\); its branch stays queued; no session is started until ${t1} closes\\. Pick another task`);
    const inProgress = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8').split('## BACKLOG')[0].includes(t2);

    await guard('2.95 (d1) a task in progress whose branch is queued for the engine train and that waits for another task (task after) is not picked for a new session: the pick says it waits and names the task (fails before this fix: the pick let it through, a session started on it)', () => [
      Boolean(t1 && t2) && /"owner": "porter-a"/.test(started.stdout) && inProgress && asked.t2?.now?.kind === 'held' && words(t2).test(asked.t2.now.message || ''), JSON.stringify({ added, started: out(started).slice(0, 300), asked: asked.t2 })]);

    await guard('2.95 (d2) the same task waiting in the backlog is skipped with the same plain words', () => [
      asked.t3?.now?.kind === 'held' && words(t3).test(asked.t3.now.message || ''), JSON.stringify(asked.t3)]);

    const r2 = cli(['start', t2, '--agent', 'porter-b']);
    const r2f = cli(['start', t2, '--agent', 'porter-b', '--force']);
    await guard('2.95 (d3) task start on the queued, waiting task is refused with the words and "Pick another task", and nothing is claimed; --force (a person) still starts it (fails before this fix: the start went through)', () => [
      !/"owner"/.test(r2.stdout) && words(t2).test(out(r2)) && /"owner": "porter-b"/.test(r2f.stdout), JSON.stringify({ a: out(r2).slice(0, 500), f: out(r2f).slice(0, 300) })]);

    await guard('2.95 (d4) once the task it waits for is done, the task is no longer skipped (nothing else is needed: the next train takes the branch)', () => [
      asked.t2?.closed === null && asked.t3?.closed?.message && !/waits for/.test(asked.t3.closed.message), JSON.stringify({ t2: asked.t2?.closed, t3: asked.t3?.closed })]);

    await guard('2.95 (d5) a task that waits but is not queued is refused as before (waits for the task, no "its branch stays queued"); a queued task that waits for nothing gets the train words it always got, in progress or not', () => [
      asked.t4?.now?.kind === 'held' && /waits for/.test(asked.t4.now.message) && !/branch stays queued/.test(asked.t4.now.message)
        && /queued for the unity train/.test(asked.t5?.now?.message || '') && !/branch stays queued/.test(asked.t5.now.message) && /queued for the unity train/.test(asked.t6?.now?.message || ''), JSON.stringify({ t4: asked.t4?.now, t5: asked.t5?.now, t6: asked.t6?.now })]);

    // ---- queueing the same branch at the same head again ----
    const queueAgain = (t) => probe(`import { queueUnityTask } from ${u('harness/unity-train.mjs')};
import { afterWaits } from ${u('harness/task-hold.mjs')}; import { parseNextQueue } from ${u('harness/task.mjs')};
const r = queueUnityTask(process.cwd(), { engine: 'unity', task: '${t}', agent: 'porter-b', branch: 'feat/a', again: true, waits: afterWaits('${t}', parseNextQueue()) });
console.log(JSON.stringify({ ok: r.ok, message: r.message }));`);
    const before = fs.readFileSync(queueFile, 'utf8');
    const nQueued = () => evs(/^task\.train\.unity\.queued$/).length;
    const n0 = nQueued();
    const again3 = queueAgain(t3);
    const n3 = nQueued();
    const afterAgain3 = fs.readFileSync(queueFile, 'utf8');
    const again5 = queueAgain(t5);
    await guard('2.95 (d6) task done --train --again for a branch already queued at the same head that waits for another task answers "already queued; it waits for ..." and changes nothing: the queue file is as it was and no second queued event (fails before this fix: it re-queued and said so again)', () => [
      again3.ok === true && new RegExp(`already queued; it waits for ${t1} \\(task after\\)`).test(again3.message || '') && afterAgain3 === before && n3 === n0, JSON.stringify({ again3, n0, n3 })]);
    await guard('2.95 (d7) the same queueing for a queued branch that waits for nothing is a normal re-queue as before (queued event, no "already queued")', () => [
      again5.ok === true && !/already queued/.test(again5.message || '') && nQueued() === n0 + 1, JSON.stringify({ again5, n0, n: nQueued() })]);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}

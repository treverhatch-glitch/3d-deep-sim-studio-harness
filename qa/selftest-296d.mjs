/**
 * qa/selftest-296d.mjs — 2.96 (d): each engine-train landing is posted once to the studio's webhook; the daily test-cost
 * report (rules.times, npm run engine -- test-cost); play-plan --propose for the paths no play.focus.map entry takes;
 * the refill wakes the Producer when no open task can start. No webhook is called: the Communicator gets a stand-in fetch
 * that writes each request to a file.
 *
 * The scaffolding (a studio copy, a made-up engine repo) is qa/selftest-295d.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, fwd, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest296D({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s296d-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_REPORT_WEBHOOK: '', STUDIO_COMM_WEBHOOK: '', STUDIO_COMM: '', STUDIO_COMM_DISK_GB: '0',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-296d-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  const S = path.join(tmpRoot, `296d-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/engine', 'studio/game.json', 'studio/mode.json', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-296d.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, AGENT_EVENTS_MIRROR: '', STUDIO_MAIN_ROOT: S, ...extra });
  const u = fileUrlRelSOf(S);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-296d-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const setEngines = (engines) => write(S, 'studio/game.json', `${JSON.stringify({ engines }, null, 2)}\n`);
  const node = (args, extra = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env: envOf(extra), encoding: 'utf8', timeout: 120000 });

  try {
    // ---- a made-up engine repo with two systems, one switched on ----
    const R = path.join(T, 'repo');
    fs.mkdirSync(R, { recursive: true });
    g(R, 'init', '-q', '-b', 'port/main');
    write(R, 'Systems/Fees.sys', 'name: Fees\non: true\n');
    write(R, 'Systems/MapNav.sys', 'name: MapNav\non: false\n');
    g(R, 'add', '-A'); g(R, 'commit', '-qm', 'start');
    const engineCfg = (extra = {}) => ({ unity: { land: 'node -e "0" {branch}', target: 'port/main', cwd: fwd(R), rules: false, progress: 'node -e "console.log(\'Fees ported: 40 percent\')"', switches: { files: 'Systems/*.sys', name: '^name: (.+)$', on: '^on: true', total: 3 }, ...extra } });

    // ---- (1) the landing post ----
    const hookUrl = 'http://127.0.0.1:9/api/webhooks/4242/tok296dNotARealToken';
    const capFile = path.join(T, 'posts.jsonl');
    const commDir = path.join(S, '.studio', 'comm');
    const nowMs = Date.now();
    const landed = (ids, ageMin, id) => ({ id, ts: new Date(nowMs - ageMin * 60000).toISOString(), type: 'task.train.unity.landed', agent: 'unity-train', status: 'ok', msg: 'Unity train x: moved', meta: { train: 'x', engine: 'unity', lanes: ids } });
    const ids10 = Array.from({ length: 10 }, (_, i) => `T-${i + 1}`);
    const titles = Object.fromEntries(ids10.map((t, i) => [t, `Port system number ${i + 1} with a very plain title`]));
    const evsAll = [
      landed(ids10, 5, 'evt_land_a'),
      { id: 'evt_web', ts: new Date(nowMs - 12 * 3600000).toISOString(), type: 'lane.merged', agent: 'merge', task: 'T-99', status: 'ok', meta: {} },
      { id: 'evt_old', ts: new Date(nowMs - 30 * 3600000).toISOString(), type: 'lane.merged', agent: 'merge', task: 'T-98', status: 'ok', meta: {} },
    ];
    const passCode = (events, extra = '') => `import fs from 'node:fs'; import { communicatorPass } from ${u('harness/communicator.mjs')};
const cap = ${JSON.stringify(capFile)};
const fetchImpl = async (url, init) => { fs.appendFileSync(cap, JSON.stringify({ url, body: JSON.parse(init.body) }) + '\\n'); return { ok: true, status: 204 }; };
const deps = { events: ${JSON.stringify(events)}, needs: [], beta: { on: false }, machine: null, delegated: false, inProgress: [], engines: [], fetchImpl, landing: { titles: ${JSON.stringify(titles)} } };
const now = ${nowMs};
const r1 = await communicatorPass({ now, deps });
const r2 = await communicatorPass({ now: now + 60000, deps });
${extra}
console.log(JSON.stringify({ r1: { posted: r1.posted, kind: r1.kind, why: r1.why }, r2: { posted: r2.posted, kind: r2.kind } }));`;
    const fresh = () => { fs.rmSync(commDir, { recursive: true, force: true }); fs.rmSync(capFile, { force: true }); fs.mkdirSync(commDir, { recursive: true }); fs.writeFileSync(path.join(commDir, 'state.json'), JSON.stringify({ t0: new Date(nowMs - 3600000).toISOString(), lastStatusAt: new Date(nowMs).toISOString() })); };
    const posts = () => { try { return fs.readFileSync(capFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };

    setEngines(engineCfg());
    fresh();
    const a = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: hookUrl });
    const pa = posts();
    const textA = String(pa[0]?.body?.text || '');
    await guard('2.96 (d1) a landing is posted once with its tasks and titles (8, then "and 2 more"), the 24-hour count, the progress line and "Systems ON: 1 of 3", and not a second time on the next pass (fails before this fix: nothing was posted when a train landed)', () => [
      pa.length === 1 && a.r1?.kind === 'landing' && a.r2?.kind === null && /Unity landing \d\d:\d\d: 10 tasks landed/.test(textA) && /- T-1 Port system number 1 with/.test(textA) && /- T-8 /.test(textA) && !/- T-9 /.test(textA) && /and 2 more/.test(textA)
        && /11 landed in the last 24 hours\./.test(textA) && /Fees ported: 40 percent/.test(textA) && /Systems ON: 1 of 3/.test(textA), JSON.stringify({ a, posts: pa.length, textA })]);

    setEngines(engineCfg({ announce: false }));
    fresh();
    const off = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: hookUrl });
    await guard('2.96 (d2) engines.<x>.announce: false posts nothing for the landing (fails before this fix: there was no switch)', () => [posts().length === 0 && off.r1?.kind === null, JSON.stringify({ off, posts: posts().length })]);

    setEngines(engineCfg());
    fresh();
    const noHook = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: '', STUDIO_REPORT_WEBHOOK: '' });
    await guard('2.96 (d3) with no webhook set nothing is posted and nothing is called', () => [posts().length === 0 && noHook.r1?.posted === false, JSON.stringify({ noHook, posts: posts().length })]);

    setEngines(engineCfg({ progress: 'node -e "process.exit(3)"' }));
    fresh();
    const badProg = probe(passCode(evsAll), { STUDIO_COMM_WEBHOOK: hookUrl });
    const textB = String(posts()[0]?.body?.text || '');
    await guard('2.96 (d4) a progress command that fails is left out of the post, which is still posted with the rest', () => [
      posts().length === 1 && /Systems ON: 1 of 3/.test(textB) && !/Fees ported/.test(textB) && !/exit 3/.test(textB), JSON.stringify({ badProg, textB })]);
    // ---- (A) end ----
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}

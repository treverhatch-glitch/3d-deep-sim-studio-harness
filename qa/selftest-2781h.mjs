/**
 * qa/selftest-2781h.mjs — 2.78.1 (h): the three CI failures of 2.78.1's first push, each from the Windows or Linux run.
 *   - A hand-back entry stays under 3k characters with the harness's facts in front (20 lines, the prose cut to the room
 *     the facts leave; the facts compact: at most 12 files and 5 commits listed, "and N more").
 *   - B-119 on Windows: git prints an engine worktree as its real path (long names), the studio may know it by another
 *     spelling (Windows' TEMP is a short name, C:\Users\RUNNER~1\...). A link alias stands in for that here: the reused
 *     worktree comes back in the studio's spelling, and the land script's gate worktree named by the alias is still its own.
 *   - B-117: on Windows every heavy wait takes a machine scan of its own (ram.mjs), so "a fresh scan" alone opened the
 *     engine line on a 4-core 16 GB machine and a Unity land ran beside a live heavy holder. The line now also needs the
 *     scan to show room for an engine land beside a game job (cores without overcommit, usable RAM).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2781H({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const textIn = (cwd, rel) => { try { return fs.readFileSync(path.join(cwd, rel), 'utf8'); } catch { return ''; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_RAM_FLOOR_GB: '0', STUDIO_UNITY_MIN_FREE_GB: '0', STUDIO_HEAVY_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_TEST_LOADAVG: '0',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2781h-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    const ev = path.join(S, '.studio', 'events-2781h.jsonl');
    writeIn(S, '.studio/events-2781h.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S } };
  };
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
  const task = (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2781h-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const commit = (cwd, rel, text, msg) => { writeIn(cwd, rel, text); g(cwd, 'add', '--', rel); return g(cwd, 'commit', '-qm', msg, '--no-verify'); };

  // ---- 1. a hand-back entry under 3k with the facts ----
  {
    const { S, env } = studio('handback');
    const a = task(S, ['add', 'Dock crane queue', '--role', 'builder', '--paths', 'game/toy/src/dock'], env);
    const id = (out(a).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    const who = { ...env, STUDIO_LOCK_OWNER: 'builder-h1' };
    const st = task(S, ['start', id, '--agent', 'builder-h1'], who);
    for (let i = 1; i <= 8; i += 1) {
      for (let k = 0; k < 5; k += 1) writeIn(S, `game/toy/src/dock/part-${i}-${k}-with-a-long-file-name.mjs`, `export const v${i}${k} = ${i * k};\n`);
      g(S, 'add', '-A'); g(S, 'commit', '-qm', `${id}: crane queue step ${i}, with a subject long enough to show how subjects are kept short in the facts block`, '--no-verify');
    }
    writeIn(S, '.studio/gates/out/game_test.log', 'FAIL src/dock/crane.test.ts > the crane queue keeps order\n  expected 3 to be 4\n[gates] FAIL game:test\n');
    writeIn(S, '.studio/gates/builder-h1.json', JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), rows: [{ id: 'lint', ok: true }, { id: 'protected', ok: true }, { id: 'game:test', ok: false }] }));
    const note = Array.from({ length: 25 }, (_, i) => `line ${i}: ${'the crane queue still drops the last crate when two ships dock at once; '.repeat(3)}`).join('\n');
    const pa = task(S, ['pause', id, '--agent', 'builder-h1', '--note', note], who);
    const h = textIn(S, `studio/handoffs/${id}.md`);
    const last = h.split(/\n## /).pop();
    const filesLine = (last.match(/- Changed files since [^\n]*/) || [''])[0];
    const listed = (filesLine.split(': ').slice(1).join(': ').split(' (+')[0] || '').split(', ').filter(Boolean).length;
    const commitsLine = (last.match(/- Commits since [^\n]*/) || [''])[0];
    const shown = (commitsLine.match(/ T-\d+: crane queue step \d+/g) || []).length;
    await guard('2.78.1 (h, hand-back): a hand-back with 40 changed files, 8 commits with long subjects, a red verify and a 25-line 5k note is one entry under 3k characters: the facts first and compact (at most 12 files listed, the rest "(+N more)"; at most the newest 5 commits, the rest "and N more (older)"; subjects cut), then the prose cut to the room left ("Cut to 20 lines") (fails on 2.78.1 at 904ce7f: the prose was cut to 2400 characters and the facts added on top, 3059 characters in npm run handoff\'s own check)', () => [
      id && st.status === 0 && pa.status === 0 && last.length < 3000 && /Hand-back facts/.test(last) && /End of hand-back facts\./.test(last) && /Cut to 20 lines/.test(last) && /line 0: the crane queue/.test(last)
        && listed >= 3 && listed <= 12 && filesLine.includes(`(40): `) && filesLine.endsWith(`(+${40 - listed} more)`)
        && shown >= 2 && shown <= 5 && /- Commits since [0-9a-f]{8} \(8\): /.test(commitsLine) && commitsLine.endsWith(`; and ${8 - shown} more (older)`) && !/step 1,/.test(commitsLine) && /step 8,/.test(commitsLine)
        && /- Last verify: red \(game:test\)/.test(last) && /- Next command: fix game:test/.test(last),
      JSON.stringify({ id, len: last.length, listed, shown, last: last.slice(0, 1800), pa: out(pa).slice(-300) })]);
  }

  // ---- 2. B-119: the engine worktree in the studio's spelling, compared by real path ----
  {
    const { S, env } = studio('enginewt');
    // The studio knows the engine folders through an alias (a link; on Windows a junction), as it may know a temp folder
    // by its short name; git prints the real path.
    const realTop = path.join(tmpRoot, `2781h-real-${process.pid}`);
    const alias = path.join(tmpRoot, `2781h-alias-${process.pid}`);
    made.push(realTop, alias);
    const R = path.join(realTop, 'repo');
    const W = path.join(realTop, 'wt');
    fs.mkdirSync(R, { recursive: true });
    let linked = true;
    try { fs.symlinkSync(realTop, alias, process.platform === 'win32' ? 'junction' : 'dir'); } catch { linked = false; }
    g(R, 'init', '-q', '-b', 'main'); g(R, 'config', 'user.name', 't'); g(R, 'config', 'user.email', 't@example.invalid');
    commit(R, 'Assets/Start.cs', 'class Start {}\n', 'engine repo');
    g(R, 'branch', 'unity/pass-1');
    g(R, 'worktree', 'add', W, 'unity/pass-1');
    const RA = path.join(alias, 'repo');
    const WA = path.join(alias, 'wt');
    const setUnity = (extra) => writeIn(S, 'studio/game.json', `${JSON.stringify({ ...(readIn(S, 'studio/game.json') || {}), engines: { unity: { folder: RA, target: 'main', ...extra } } }, null, 2)}\n`);
    setUnity({});
    const a = task(S, ['add', 'Unity pass 1', '--role', 'engine-porter', '--track', 'engine:unity', '--branch', 'unity/pass-1'], env);
    const id = (out(a).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1];
    const launch = () => probe(S, `const et = await import(${u(S, 'harness/engine-tracks.mjs')}); console.log(JSON.stringify(et.engineLaunch({ task: ${JSON.stringify(id)}, agent: 'porter-h1' })));`, env).j || {};
    const reused = launch();
    setUnity({ gateWorktree: WA });
    const gate = launch();
    await guard('2.78.1 (h, B-119 on Windows): git prints the engine worktree by its real path while the studio knows the folders by another spelling (an alias here; on Windows the short-name temp folder, C:\\Users\\RUNNER~1\\...): a clean worktree on the branch is reused and handed back in the studio\'s spelling (the alias path), and the land script\'s own gate worktree named through the alias is still refused as its own (fails on 2.78.1 at 904ce7f: paths compared with path.resolve, so the worktree came back as git\'s spelling and the gate worktree was reused)', () => [
      linked && id && reused.reused === true && reused.dir === WA && /already checked out there and clean/.test(reused.note || '') && !reused.error
        && /the land script's own worktree/.test(gate.error || '') && !gate.dir,
      JSON.stringify({ linked, id, WA, reused, gate }).slice(0, 1800)]);
  }

  // ---- 3. B-117: the engine line needs room for both ----
  {
    const { S, env } = studio('engineline');
    const TAKE = `const take = (H, root, label, o = {}) => { const logs = []; try { const lk = H.acquireHeavy(root, label, { log: (m) => logs.push(m), ...o, env: { ...process.env, STUDIO_HEAVY_HELD: '', ...(o.env || {}) } }); return { ok: true, lk, logs }; } catch (e) { return { ok: false, code: e.code || 'ERR', msg: String(e.message || e).slice(0, 400), logs }; } };`;
    const scanOf = (cores, ramGb) => JSON.stringify({ at: new Date().toISOString(), os: 'win32', ram: { totalGb: ramGb, freeGb: ramGb - 4, commitLimitGb: ramGb + 8, commitUsedGb: 6 }, cores: { logical: cores }, gpus: [] });
    const besideHolder = (scan, extra = {}) => probe(S, `import * as H from ${u(S, 'harness/heavy.mjs')};
${TAKE}
const root = process.cwd();
const h = take(H, root, 'holder-2781h', { kind: 'heavy' });
const e = take(H, root, 'unity land', { kind: 'unity', engine: 'unity', env: { STUDIO_GATE_PRIORITY: 'landing' } });
if (e.ok) e.lk.release(); if (h.ok) h.lk.release();
console.log(JSON.stringify({ holder: h.ok, land: e.ok ? 'took it' : e.code, msg: e.msg || '', logs: e.logs.join(' | ').slice(0, 600) }));
`, { ...env, STUDIO_HEAVY_SLOTS: '1', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: scan, ...extra }).j || {};
    const small = besideHolder(scanOf(4, 16));
    const big = besideHolder(scanOf(32, 64));
    const forced = besideHolder(scanOf(4, 16), { STUDIO_ENGINE_LINE_ROOM: 'off' });
    await guard('2.78.1 (h, B-117 beside a holder): with a fresh scan of a 4-core 16 GB machine (what Windows\' own scan gives a CI runner) and one game slot, a Unity land beside a live heavy holder waits and is refused naming the holder, saying the machine has no room for the engine line (6 threads on 4 cores); on a 32-core 64 GB scan it takes the engine line beside it; STUDIO_ENGINE_LINE_ROOM=off opens the line on the small machine too (fails on 2.78.1 at 904ce7f: any fresh scan opened the line, so the land ran beside the holder on the 4-core machine, qa/selftest-259d.mjs #16 on Windows)', () => [
      small.holder && small.land === 'HEAVY_BUSY' && /holder-2781h/.test(small.msg) && /no room for the engine line/.test(small.logs) && /6 threads \(4 logical cores/.test(small.logs)
        && big.holder && big.land === 'took it' && forced.holder && forced.land === 'took it',
      JSON.stringify({ small, big, forced }).slice(0, 1800)]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}

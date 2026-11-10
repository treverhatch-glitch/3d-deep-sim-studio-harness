/**
 * qa/selftest-2731b.mjs — 2.73.1 (helper b): identity never from the shared .env (B-60), leftover folders in .lanes/ are
 * not lanes (B-51), and the one-command boot (B-69).
 *   env      .env's STUDIO_LOCK_OWNER / STUDIO_ROLE / STUDIO_AGENT / STUDIO_MAIN_ROOT are ignored by every loader (event.mjs,
 *            route.mjs, dotenv.mjs) with one stderr line naming the line; other settings still load; the owner's own
 *            studio:resume is no longer refused as "an agent's shell"; the upgrade preflight WARNs with a Fix line
 *   lanes    an emptied .lanes/<name> folder (no worktree) is a "leftover folder (not a lane)" (INFO) in the preflight,
 *            not a lane with main's dirty files as its "unlanded work"; laneCopies leaves it out; lanes refresh refuses it
 *            without running git in it
 *   boot     `studio:boot --check` reports and changes nothing; the sweep clears dead-pid lock/status files with one
 *            event each and leaves live ones, claims and lanes alone (2.80: no hub to start any more); the supervisor only
 *            when none runs, with --foreground and the passed options (--no-hub accepted and not passed on); the Windows npm.cmd hint; --shortcut writes the Desktop file
 * Each check fails on 2.73.0 (the loaders took identity from .env, the preflight counted leftover folders, no boot).
 */
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function selftest2731B({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nmSrc = fs.existsSync(path.join(dir, 'node_modules', 'typescript')) ? path.join(dir, 'node_modules') : path.join(harnessRoot, 'node_modules');
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const IDK = ['STUDIO_LOCK_OWNER', 'STUDIO_ROLE', 'STUDIO_AGENT', 'STUDIO_MAIN_ROOT'];
  // The children's env: the identity keys are left OUT (not set empty: an empty value would hide what .env sets).
  const cleanEnv = (extra = {}) => {
    const e = { ...process.env, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_HEAVY_SLOTS: '0', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '', npm_lifecycle_event: '', HUB_TOKEN: '', HUB_PORT: '', STUDIO_REPORT_WEBHOOK: '', STUDIO_DISK_MIN_FREE_GB: '0.5', STUDIO_PREFLIGHT_MIN_RAM_GB: '0', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2731b-${process.pid}.pem`) };
    for (const k of Object.keys(e)) if (IDK.includes(k) || /^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k];
    delete e.NODE_PATH;
    return { ...e, ...extra };
  };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: cleanEnv() });
  const node = (cwd, args, extra = {}, opts = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: cleanEnv(extra), timeout: 120000, ...opts });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2731b-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    try { fs.symlinkSync(fs.realpathSync(nmSrc), path.join(S, 'node_modules'), 'junction'); } catch {}
    for (const x of ['.studio/agents', '.studio/locks', '.studio/train', '.studio/verify-running', '.studio/supervisor.json', '.studio/logs', '.env']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2731b.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const lastJson = (r) => { const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return null; } };
  // Harness modules of a copy are imported in a child, never here: their event.mjs would load the copy's .env into this
  // process (the full selftest runs every unit in one process).
  const js = (S, code, E) => { const r = node(S, ['--input-type=module', '-e', code], E); return { r, j: lastJson(r) }; };
  const freePort = () => new Promise((res) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); });
  const DEAD = 2147483000; // a pid no process has

  // ---- env (B-60) ----
  {
    const { S, ev } = studio('env');
    fs.writeFileSync(path.join(S, '.env'), 'STUDIO_PRODUCER_NAME=pat\nSTUDIO_LOCK_OWNER=opus-1\n# a note\nexport STUDIO_ROLE=builder\nSTUDIO_AGENT=\nROUTER_TEST_API_KEY=k2731b\n');
    const E = { AGENT_EVENTS_FILE: ev };
    await guard('2.73.1 (B-60): .env\'s STUDIO_LOCK_OWNER and STUDIO_ROLE are ignored by every .env loader (event.mjs, route.mjs, dotenv.mjs) while other settings still load, and one stderr line names the lines to remove (fails on 2.73.0: the shell became opus-1, a builder)', () => {
      const code = "const ev=await import('./harness/event.mjs');const r=await import('./harness/route.mjs');r.loadDotEnv();const d=await import('./harness/dotenv.mjs');d.loadDotEnv(process.cwd()+'/.env');console.log(JSON.stringify({owner:process.env.STUDIO_LOCK_OWNER??null,role:process.env.STUDIO_ROLE??null,agent:process.env.STUDIO_AGENT??null,producer:process.env.STUDIO_PRODUCER_NAME??null,key:Boolean(process.env.ROUTER_TEST_API_KEY),actor:ev.actor()}));";
      const r = node(S, ['--input-type=module', '-e', code], E);
      const j = lastJson(r);
      const warn = String(r.stderr || '').split('\n').filter((l) => /identity settings belong to a session, not the studio's \.env: remove lines 2, 4/.test(l));
      return [j && j.owner === null && j.role === null && j.agent === null && j.producer === 'pat' && j.key && j.actor === 'pat' && warn.length === 1 && !/opus-1|k2731b/.test(String(r.stderr)), out(r)];
    });
    await guard('2.73.1 (B-60): with STUDIO_LOCK_OWNER=opus-1 in .env, the owner\'s own `studio:resume -- --by hatch` is not refused as "an agent\'s shell" (fails on 2.73.0: "Not resumed: this runs in an agent\'s shell (STUDIO_LOCK_OWNER=opus-1)")', () => {
      const r = node(S, ['harness/supervisor.mjs', 'resume', '--by', 'hatch'], E);
      return [r.status === 0 && !/agent's shell|launched/.test(out(r)) && /Not halted/.test(out(r)), out(r)];
    });
    await guard('2.73.1 (B-60): the upgrade preflight WARNs on .env identity lines (dotenv-identity, naming lines 2 and 4, with a Fix line; values never shown) (fails on 2.73.0: no such item)', async () => {
      const { r, j: p } = js(S, "const m=await import('./harness/upgrade-preflight.mjs');const p=await m.preflight({root:process.cwd(),env:process.env});console.log(JSON.stringify({items:p.items,lines:p.lines}))", E);
      if (!p) return [false, out(r)];
      const it = p.items.find((i) => i.id === 'dotenv-identity');
      const lines = p.lines.join('\n');
      return [it && it.status === 'WARN' && /lines 2, 4/.test(it.detail) && /remove lines 2, 4/.test(it.fix || '') && /Fix: remove lines 2, 4/.test(lines) && !/opus-1|k2731b/.test(lines), JSON.stringify(it || p.items.map((i) => i.id))];
    });
  }

  // ---- lanes (B-51) ----
  {
    const { S, ev } = studio('lanes');
    const E = { AGENT_EVENTS_FILE: ev };
    const lane = path.join(S, '.lanes', 'builder-s1');
    g(S, ['worktree', 'add', '-q', '-b', 'lane/builder-s1', lane]);
    const orphan = path.join(S, '.lanes', 'reviewer-s1');
    fs.mkdirSync(orphan, { recursive: true }); // an old lane folder, emptied: no .git, no worktree
    fs.mkdirSync(path.join(S, '.lanes', 'builder-s16'), { recursive: true });
    fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'agents', 'reviewer-s1.json'), JSON.stringify({ agent: 'reviewer-s1', task: 'T-016', status: 'ended' }));
    // The main checkout has uncommitted board work (what git saw "in" each leftover folder).
    fs.appendFileSync(path.join(S, 'studio', 'CURRENT_TASK.md'), '\nlocal edit 2731b\n');
    const mainBefore = g(S, ['status', '--porcelain']).stdout;
    await guard('2.73.1 (B-51): the upgrade preflight lists empty .lanes folders as "leftover folder (not a lane)" (INFO) and a clean real lane passes, never main\'s dirty files as their unlanded work (fails on 2.73.0: "WARN lanes: 2 lane(s) hold unlanded work: builder-s16 (1 uncommitted file(s)) ...")', async () => {
      const { r, j: p } = js(S, "const m=await import('./harness/upgrade-preflight.mjs');const p=await m.preflight({root:process.cwd(),env:process.env});console.log(JSON.stringify({items:p.items}))", E);
      if (!p) return [false, out(r)];
      const lanes = p.items.find((i) => i.id === 'lanes');
      const left = p.items.find((i) => i.id === 'lanes-leftover');
      return [lanes?.status === 'PASS' && /1 lane copy/.test(lanes.detail) && left?.status === 'INFO' && /2 leftover folders \(not a lane/.test(left.detail) && /builder-s16/.test(left.detail) && /reviewer-s1/.test(left.detail) && !p.items.some((i) => /unlanded work: .*(builder-s16|reviewer-s1)/.test(i.detail)), JSON.stringify(p.items.filter((i) => /lanes/.test(i.id)))];
    });
    await guard('2.73.1 (B-51): laneCopies() holds only registered worktrees and leftoverLaneFolders() names the others (fails on 2.73.0: builder-s16 and reviewer-s1 came back as lanes on main\'s branch, dirty)', () => {
      const r = node(S, ['--input-type=module', '-e', "const w=await import('./harness/worktree.mjs');console.log(JSON.stringify({copies:w.laneCopies().map((c)=>[c.agent,c.branch,c.dirty]),left:(w.leftoverLaneFolders?w.leftoverLaneFolders():[]).map((x)=>x.name).sort()}))"], E);
      const j = lastJson(r);
      return [j && JSON.stringify(j.copies) === JSON.stringify([['builder-s1', 'lane/builder-s1', false]]) && JSON.stringify(j.left) === JSON.stringify(['builder-s16', 'reviewer-s1']), out(r)];
    });
    await guard('2.73.1 (B-51): `lanes refresh T-016` (mapped to the empty .lanes/reviewer-s1) and refreshLane on that folder refuse it as no lane, never "uncommitted work in it (studio/CURRENT_TASK.md)", and main is untouched (fails on 2.73.0: "REFUSED T-016: uncommitted work in it (studio/CURRENT_TASK.md)")', () => {
      const r = node(S, ['harness/lanes.mjs', 'refresh', 'T-016', '--by', 'hatch', '--no-tests', '--json'], E);
      const r2 = node(S, ['--input-type=module', '-e', `const l=await import('./harness/lanes.mjs');const x=await l.refreshLane(process.cwd(),{task:'T-016',agent:'reviewer-s1',branch:null,dir:${JSON.stringify(orphan)}},{by:'hatch',tests:false});console.log(JSON.stringify(x))`], E);
      const j = lastJson(r2);
      const text = `${out(r)}\n${out(r2)}`;
      return [!/uncommitted work in it/.test(text) && j?.status === 'refused' && /leftover folder, not a lane/.test(j.why) && g(S, ['status', '--porcelain']).stdout === mainBefore && fs.readdirSync(orphan).length === 0, text];
    });
  }

  // ---- boot (B-69) ----
  {
    const { S, ev } = studio('boot');
    const E = { AGENT_EVENTS_FILE: ev };
    fs.writeFileSync(path.join(S, '.env'), 'STUDIO_BACKUP_KEEP=60\nSTUDIO_LOCK_OWNER=opus-1\n');
    const locks = path.join(S, '.studio', 'locks');
    fs.mkdirSync(locks, { recursive: true });
    fs.mkdirSync(path.join(S, '.studio', 'verify-running'), { recursive: true });
    fs.mkdirSync(path.join(S, '.studio', 'train'), { recursive: true });
    const put = (rel, v) => fs.writeFileSync(path.join(S, rel), JSON.stringify(v));
    put('.studio/locks/train.lock', { pid: DEAD, at: Date.now(), id: 'train-2731b', by: 'train-daemon' });
    put('.studio/locks/land.lock', { pid: process.pid, at: Date.now() }); // live: kept
    put('.studio/verify-running/full.json', { pid: DEAD, startedAt: new Date().toISOString(), owner: 'builder-s1' });
    put('.studio/supervisor.json', { pid: DEAD, status: 'running', startedAt: new Date().toISOString() });
    put('.studio/locks/task-T-001.abcd.lock', { key: 'task:T-001', owner: 'builder-s1', pid: DEAD }); // a claim: never the sweep's
    fs.mkdirSync(path.join(S, '.lanes', 'builder-s9'), { recursive: true });
    fs.writeFileSync(path.join(S, '.lanes', 'builder-s9', 'work.txt'), 'keep\n');
    const exists = (rel) => fs.existsSync(path.join(S, rel));
    await guard('2.73.1 (B-69): `studio:boot --check` reports (the dead-pid train lock "would clear", the supervisor down, the .env identity WARN with its Fix, the leftover folder) and changes nothing: no file cleared, nothing started (fails on 2.73.0: no harness/boot.mjs)', () => {
      const pkg = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8'));
      const r = node(S, ['harness/boot.mjs', '--check'], E);
      const t = out(r);
      return [pkg.scripts?.['studio:boot'] === 'node harness/boot.mjs' && r.status === 0 && /\.studio\/locks\/train\.lock would clear \(pid \d+ is gone \(train-2731b\)\)/.test(t) && !/^\s*hub\s/m.test(t) && /supervisor\s+down/.test(t) && /WARN dotenv-identity: \.env sets STUDIO_LOCK_OWNER \(line 2\)/.test(t) && /Fix: remove line 2 from \.env/.test(t) && /builder-s9/.test(t) && exists('.studio/locks/train.lock') && JSON.parse(fs.readFileSync(path.join(S, '.studio/supervisor.json'), 'utf8')).status === 'running' && !exists('.studio/logs') && !events(ev).some((e) => /^boot\./.test(e.type)), t];
    });
    await guard('2.73.1 (B-69): `studio:boot` clears the dead-pid train lock and full-verify record, marks the dead supervisor stopped (one boot.stale_cleared event each), keeps a live lock, a claim and the lane folder; a second boot finds nothing more to clear (fails on 2.73.0: no boot; 2.80: there is no hub to start)', async () => {
      const r = node(S, ['harness/boot.mjs', '--no-supervisor', '--json'], { ...E, STUDIO_LOCK_OWNER: 'opus-1' });
      const j = lastJson(r);
      const cleared = events(ev).filter((e) => e.type === 'boot.stale_cleared').map((e) => e.meta?.file).sort();
      const r2 = node(S, ['harness/boot.mjs', '--no-supervisor', '--json'], E);
      const j2 = lastJson(r2);
      const sup = JSON.parse(fs.readFileSync(path.join(S, '.studio/supervisor.json'), 'utf8'));
      return [r.status === 0 && j && !('hub' in (j.daemons || {})) && JSON.stringify(cleared) === JSON.stringify(['.studio/supervisor.json', '.studio/locks/train.lock', '.studio/verify-running/full.json'].sort())
        && !exists('.studio/locks/train.lock') && !exists('.studio/verify-running/full.json') && exists('.studio/locks/land.lock') && exists('.studio/locks/task-T-001.abcd.lock') && exists('.lanes/builder-s9/work.txt')
        && sup.status === 'stopped' && /studio:boot/.test(sup.stopReason) && r2.status === 0 && j2?.swept?.length === 1 && j2.swept[0].action === 'kept', `${out(r)}\n${out(r2)}\ncleared ${cleared}`];
    });
    await guard('2.73.1 (B-69): the supervisor starts only when none runs: once with harness/supervisor.mjs --foreground and the passed --until, hidden in .studio/logs/supervisor.log, without the session identity; a live supervisor is left alone (fails on 2.73.0: no boot)', async () => {
      const sjson = path.join(S, '.studio', 'supervisor.json');
      fs.writeFileSync(sjson, JSON.stringify({ pid: DEAD, status: 'stopped' }));
      const code = (argv) => `const b=await import('./harness/boot.mjs');const calls=[];const start=(root,script,args,log,env)=>{calls.push({script,args,log,owner:env.STUDIO_LOCK_OWNER??null,role:env.STUDIO_ROLE??null});return 4242;};const d=await b.startDaemons({root:process.cwd(),env:{...process.env,STUDIO_LOCK_OWNER:'opus-1',STUDIO_ROLE:'builder'},argv:${JSON.stringify(argv)},up:async()=>false,start,emit:()=>{}});console.log(JSON.stringify({d,calls}))`;
      const A = js(S, code(['--until', '46h', '--no-hub']), E);
      fs.writeFileSync(sjson, JSON.stringify({ pid: process.pid, status: 'running', startedAt: new Date().toISOString() }));
      const C = js(S, code(['--no-hub']), E);
      if (!A.j || !C.j) return [false, `${out(A.r)}\n${out(C.r)}`];
      const a = A.j.d; const c = C.j.d; const calls = [...A.j.calls, ...C.j.calls];
      const src = fs.readFileSync(path.join(S, 'harness', 'boot.mjs'), 'utf8');
      const spawnLine = (src.match(/spawn\(process\.execPath[^\n]*/) || [''])[0];
      return [a.supervisor.state === 'started' && calls.length === 1 && calls[0].script === 'harness/supervisor.mjs' && JSON.stringify(calls[0].args) === JSON.stringify(['--until', '46h', '--foreground']) && a.hubGone === true && calls[0].log === 'supervisor.log' && calls[0].owner === null && calls[0].role === null
        && c.supervisor.state === 'running' && c.supervisor.pid === process.pid && /detached: true/.test(spawnLine) && /windowsHide: true/.test(spawnLine), JSON.stringify({ a, c, calls, spawnLine })];
    });
    await guard('2.73.1 (B-69): on Windows the preflight says to type npm.cmd when PowerShell blocks npm.ps1, and --shortcut writes a Desktop .cmd that runs `npm.cmd run studio:boot` in the studio folder (a .sh elsewhere) and prints its path (fails on 2.73.0: no boot)', async () => {
      const home = path.join(tmpRoot, `2731b-home-${process.pid}`);
      fs.mkdirSync(path.join(home, 'Desktop'), { recursive: true });
      const P = js(S, `const b=await import('./harness/boot.mjs');const pre=b.preflightLite({root:process.cwd(),env:process.env,platform:'win32'});const w=b.writeShortcut({root:'C:\\\\Users\\\\owner\\\\studio 100%',env:{USERPROFILE:${JSON.stringify(home)}},platform:'win32'});console.log(JSON.stringify({pre,w}))`, E);
      if (!P.j) return [false, out(P.r)];
      const { pre, w } = P.j;
      const cmd = w.ok ? fs.readFileSync(w.file, 'utf8') : '';
      const r = node(S, ['harness/boot.mjs', '--check', '--shortcut', '--no-hub', '--no-supervisor'], { ...E, HOME: home });
      const sh = path.join(home, 'Desktop', `studio-boot-${path.basename(S)}.sh`);
      const ps = pre.find((i) => i.id === 'powershell');
      return [ps && /npm\.ps1/.test(ps.detail) && /npm\.cmd run studio:boot/.test(ps.detail) && w.ok && /\.cmd$/.test(w.file) && /cd \/d "C:\\Users\\owner\\studio 100%%"\r\n/.test(cmd) && /call npm\.cmd run studio:boot\r\n/.test(cmd)
        && (process.platform === 'win32' || (fs.existsSync(sh) && fs.readFileSync(sh, 'utf8').includes('npm run studio:boot') && out(r).includes(`shortcut    ${sh}`))), `${JSON.stringify(ps)}\n${cmd}\n${out(r)}`];
    });
  }
  for (const S of made) { try { g(S, ['worktree', 'prune']); fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {} }
}

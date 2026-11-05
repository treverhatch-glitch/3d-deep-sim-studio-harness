/**
 * qa/selftest-2773e.mjs — 2.77.3 (e): the stall killer, the owner's allow rules, studio:reload-env, an empty playtest stage.
 *   H1 / B-109  the read-burn ratio counted cache reads and had no grace period: an Opus session was ended after 4 min.
 *   H6          Claude Code allow rules for hook-stamp grandfather and `hooks -- restamp` (--owner).
 *   M5          studio:reload-env said "hasn't answered in 15 s" although the supervisor reloads on its next pass.
 *   M7          a playtest stage that stepped nothing passed.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2773E({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '',
    STUDIO_STALL_RATIO: '', STUDIO_STALL_GRACE_MIN: '', STUDIO_STALL_MIN: '', STUDIO_STALL: '', STUDIO_STALL_RATIO_WINDOW_TOKENS: '', STUDIO_SESSION_MAX_MIN: '', STUDIO_SUPERVISOR_SEC: '' };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2773e-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    const ev = path.join(S, '.studio', 'events-2773e.jsonl'); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2773e-${++n}.mjs`); fs.writeFileSync(f, code); const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);

  // ---- H1 / B-109 ----
  {
    const { S, env } = studio('h1');
    const r = probe(S, `import fs from 'node:fs';
const st = await import(${u(S, 'harness/stall.mjs')});
const line = (id, usage) => JSON.stringify({ type: 'assistant', session_id: 's', message: { id, usage } });
const lt = st.logTokens([line('a', { input_tokens: 10, cache_creation_input_tokens: 90, cache_read_input_tokens: 100000, output_tokens: 5 }), line('b', { input_tokens: 5, cache_read_input_tokens: 100000, output_tokens: 5 })].join('\\n'));
const now = Date.now();
const mk = (agent, minAgo) => ({ agent, role: 'builder', startedAt: new Date(now - minAgo * 60000).toISOString() });
const obs = (agent, minAgo, tokens) => st.observe(mk(agent, minAgo), { tokens, cwd: process.cwd(), now, events: [] });
// the crew's case: 4 min in, 2.17M read (almost all cache reads), 267 written
const cached = obs('h1-cached', 4, { in: 2169593, fresh: 40000, out: 267 });
// a real burn after the grace period still ends the session, and inside it does not
const burnLate = obs('h1-late', 20, { in: 2169593, fresh: 2169593, out: 267 });
const burnEarly = obs('h1-early', 4, { in: 2169593, fresh: 2169593, out: 267 });
const lateCached = obs('h1-late-cached', 20, { in: 2169593, fresh: 40000, out: 267 });
process.env.STUDIO_STALL_RATIO = '0';
const off = obs('h1-off', 20, { in: 2169593, fresh: 2169593, out: 267 });
console.log(JSON.stringify({ lt, cached, burnLate, burnEarly, lateCached, off }));
`, { ...env, STUDIO_STALL_MIN: '600', STUDIO_SESSION_MAX_MIN: '600' });
    const j = r.j;
    await guard('2.77.3 (H1, B-109): the read-burn ratio ignores cache reads (logTokens.fresh = uncached input + cache creation; a 4 min session that "read 2169593, wrote 267" mostly from cache is not ended), and a real burn is not judged inside STUDIO_STALL_GRACE_MIN (15 min) but is after it; STUDIO_STALL_RATIO=0 stays off (fails on 2.77.2: cache reads counted and no grace, the session was ended after 4 min)', () => [
      j && j.lt.fresh === 105 && j.lt.in === 200105 && j.cached.stalled === false && j.lateCached.stalled === false && j.burnEarly.stalled === false
        && j.burnLate.stalled === true && j.burnLate.kind === 'read-burn' && j.off.stalled === false,
      JSON.stringify({ j, out: out(r).slice(-500) })]);
  }

  // ---- H6 ----
  {
    const { S, env } = studio('h6');
    const r = probe(S, `const d = await import(${u(S, 'harness/delegation.mjs')});
const owner = d.claudeRules([], { owner: true });
const plain = d.claudeRules([], { owner: false });
const want = ['Bash(node harness/hook-stamp.mjs grandfather:*)', 'Bash(npm run hooks -- restamp:*)', 'Bash(npm.cmd run hooks -- restamp:*)', 'Bash(npm run approve -- hooks:*)', 'Bash(npm.cmd run approve -- hooks:*)', 'Bash(npm run approve -- force:*)', 'Bash(npm.cmd run approve -- force:*)'];
const broad = ['Bash(*)', 'Bash(npm run hooks:*)', 'Bash(npm run approve:*)', 'Bash(node harness/hook-stamp.mjs:*)', 'Bash(node harness/*:*)', 'Bash(npm run hooks -- restamp *)'];
console.log(JSON.stringify({ missing: want.filter((r) => !owner.includes(r)), narrow: want.map((r) => d.narrowRule(r)), broadAccepted: broad.filter((r) => d.narrowRule(r)), inPlain: want.filter((r) => plain.includes(r)) }));
`, env);
    const j = r.j;
    await guard('2.77.3 (H6): `delegate -- claude-settings --owner` allows `node harness/hook-stamp.mjs grandfather` (any args), `npm run hooks -- restamp`, `npm run approve -- hooks` and `-- force` (npm and npm.cmd forms); narrowRule accepts them and still refuses broad rules; the non-owner list does not carry them (fails on 2.77.2: grandfather and hooks -- restamp were not in the list)', () => [
      j && j.missing.length === 0 && j.narrow.every(Boolean) && j.broadAccepted.length === 0 && j.inPlain.length === 0,
      JSON.stringify({ j, out: out(r).slice(-500) })]);
  }

  // ---- M5 ----
  {
    const { S, env } = studio('m5');
    const sup = path.join(S, '.studio', 'supervisor.json');
    const cliEnv = { ...process.env, ...env, STUDIO_SUPERVISOR_SEC: '1' };
    const cli = () => spawnSync(process.execPath, ['harness/env-reload.mjs', '--by', 'tester'], { windowsHide: true, cwd: S, encoding: 'utf8', env: cliEnv, timeout: 60000 });
    // a supervisor that is alive but busy in a pass: it does not answer
    fs.writeFileSync(sup, JSON.stringify({ pid: process.pid, status: 'running', startedAt: new Date().toISOString() }));
    const t0 = Date.now();
    const busy = cli();
    const took = Date.now() - t0;
    fs.rmSync(sup, { force: true });
    const none = cli();
    await guard('2.77.3 (M5): `studio:reload-env` with a running supervisor that has not answered says "Queued: the supervisor reloads on its next pass" (exit 0) after waiting one pass (STUDIO_SUPERVISOR_SEC + 10 s margin, not 15 s); with no supervisor running it still exits 0 and says the settings apply when it starts (fails on 2.77.2: "hasn\'t answered in 15 s" after a fixed 15 s wait)', () => [
      busy.status === 0 && /Queued: the supervisor reloads on its next pass/.test(out(busy)) && !/hasn't answered/.test(out(busy)) && took >= 10500 && took < 14500 && none.status === 0 && /supervisor isn't running here, so the new settings apply when it starts/.test(out(none)),
      JSON.stringify({ took, busy: out(busy).slice(-300), busyStatus: busy.status, none: out(none).slice(-300), noneStatus: none.status })]);
  }

  // ---- M7 ----
  {
    const { S, env } = studio('m7');
    const r = probe(S, `const pt = await import(${u(S, 'qa/playtest.mjs')});
const empty = await pt.runStage1ProgrammaticQA({ seed: 1, ticks: -5, cartridge: 'example-sim' });
const real = await pt.runStage1ProgrammaticQA({ seed: 1, ticks: 20, cartridge: 'example-sim' });
console.log(JSON.stringify({ empty: { passed: empty.passed, ticksRun: empty.ticksRun, ids: empty.findings.map((f) => f.id), summary: empty.findings[0]?.summary }, real: { passed: real.passed, ticksRun: real.ticksRun, ids: real.findings.map((f) => f.id) } }));
`, env);
    const j = r.j;
    await guard('2.77.3 (M7): a playtest stage 1 that stepped nothing (no ticks to run) fails with QA-STAGE1-RAN-NOTHING "ran 0 steps" instead of passing; a normal run still passes (fails on 2.77.2: a 0-tick run reported passed)', () => [
      j && j.empty.passed === false && j.empty.ticksRun === 0 && j.empty.ids.includes('QA-STAGE1-RAN-NOTHING') && /ran 0 steps/.test(j.empty.summary || '') && j.real.passed === true && j.real.ticksRun > 0,
      JSON.stringify({ j, out: out(r).slice(-600) })]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}

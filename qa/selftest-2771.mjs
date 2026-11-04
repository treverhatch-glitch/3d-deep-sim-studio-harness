/**
 * qa/selftest-2771.mjs — 2.77.1: the crew's live-run blockers on 2.77.0 (Windows, harness 2.77 on studio-hatchfield).
 *   B-102  the supervisor exited after its first pass (exit 13, "unsettled top-level await"): with the Communicator on,
 *          a pass imports supervisor.mjs back while main() was a top-level await. Now: passes keep coming, each saved;
 *          a hung step is bounded (supervisor.step_timeout) and the pass goes on.
 *   B-99   agy -p exits 0 mid-task (a headless denial, or idle with a background test): counted as a failed run (so
 *          --fallback fires), with the reason in the hand-back; GEMINI.md says foreground-only and one test form.
 *   B-103  a beta-mode (or owner-proxy) approval of a config proposal is applied when the lane lands.
 *   B-100  `upgrade --merge` lists the update's own commits (made without this studio's hooks) as exempt, so the hooks
 *          gate on main doesn't start red.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2771({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '' };
  let n = 0;
  const made = [];
  // A studio of its own (the repo as it is), its own git, nothing of the harness's runtime state.
  const studio = (name) => {
    const S = path.join(tmpRoot, `2771-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-2771.jsonl');
    writeIn(S, '.studio/events-2771.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2771-${++n}.mjs`); fs.writeFileSync(f, code); const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);

  // ---- B-102: the supervisor keeps running with the Communicator on ----
  {
    const { S, env } = studio('sup');
    // The Communicator on (its webhook set: a local port nothing listens on, so each post fails at once and is retried
    // later) is what made a pass import supervisor.mjs back (its needs-a-person list reads readStatus).
    const r = spawnSync(process.execPath, ['harness/supervisor.mjs', '--foreground', '--no-hub'], { windowsHide: true, cwd: S, encoding: 'utf8', timeout: 40000, env: { ...process.env, ...env, STUDIO_COMM_WEBHOOK: 'http://127.0.0.1:9/hook', STUDIO_SUPERVISOR_SEC: '4' } });
    let st = null; try { st = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'supervisor.json'), 'utf8')); } catch {}
    await guard('2.77.1 (B-102): with the Communicator on, `supervisor.mjs --foreground` keeps running (no exit 13, no "unsettled top-level await"), finishes pass after pass and saves each one (passes ≥ 2 in .studio/supervisor.json) (fails on 2.77.0: it exited after the first pass with nothing saved)', () => [
      r.status !== 13 && !/unsettled top-level await/i.test(out(r)) && Number(st?.passes) >= 2 && st?.lastLoop,
      JSON.stringify({ status: r.status, signal: r.signal, passes: st?.passes, lastLoop: st?.lastLoop, out: out(r).slice(-800) })]);
    // A step that never settles is reported, and the pass goes on with its fallback.
    const b = probe(S, `import { boundedStep } from ${u(S, 'harness/supervisor.mjs')};
const seen = []; const state = {};
const t0 = Date.now();
const v = await boundedStep('hang', () => new Promise(() => {}), { ms: 300, fallback: () => 'went on', state, emit: (e) => seen.push(e) });
const w = await boundedStep('quick', async () => 'done', { ms: 5000, state, emit: (e) => seen.push(e) });
console.log(JSON.stringify({ v, w, ms: Date.now() - t0, types: seen.map((e) => e.type), step: seen[0]?.meta?.step, last: state.step }));
process.exit(0);
`, env);
    await guard('2.77.1 (B-102): boundedStep: a step still pending after its limit is reported (supervisor.step_timeout naming the step) and the pass goes on with the fallback; a quick step returns its own value (fails on 2.77.0: no bound, one hung step stopped every later step)', () => [
      b.j && b.j.v === 'went on' && b.j.w === 'done' && b.j.ms < 4000 && b.j.types.length === 1 && b.j.types[0] === 'supervisor.step_timeout' && b.j.step === 'hang',
      JSON.stringify({ j: b.j, out: out(b).slice(-600) })]);
  }

  // ---- B-99: agy ending a session mid-task with exit 0 ----
  {
    const { S, env } = studio('agy');
    const a = probe(S, `import { agyCutShort } from ${u(S, 'harness/agent.mjs')};
import { AGY_SHELL_RULES } from ${u(S, 'harness/agy-allow.mjs')};
const denied = 'jetski: no output produced — a tool required the "command" permission that headless mode cannot prompt for, so it was auto-denied. Add an allow-rule under permissions.allow in settings.json (e.g. command(<target>)).';
const idle = 'root agent idle; waiting up to 1h30m0s for 1 background task(s)\\nRunning \`a.test.ts\` and waiting for it to finish.';
console.log(JSON.stringify({
  denied: agyCutShort({ tool: 'agy', code: 0, log: denied }),
  idle: agyCutShort({ tool: 'agy', code: 0, log: idle }),
  fine: agyCutShort({ tool: 'agy', code: 0, log: 'All done. npm run task -- done T-1 passed.' }),
  claude: agyCutShort({ tool: 'claude', code: 0, log: denied }),
  exit1: agyCutShort({ tool: 'agy', code: 1, log: denied }),
  foreground: /foreground/i.test(AGY_SHELL_RULES) && /background/i.test(AGY_SHELL_RULES),
  testForm: /npm --prefix <game folder> run test -- <test file>/.test(AGY_SHELL_RULES),
}));
`, env);
    await guard('2.77.1 (B-99): an agy session that exits 0 on a headless denial ("denied") or while idle with a background task ("idle") is a cut-short run, not a finish; a real finish, another tool and a non-zero exit are not this (those have their own handling) (fails on 2.77.0: both counted as a normal finish, so --fallback never fired)', () => [
      a.j && a.j.denied === 'denied' && a.j.idle === 'idle' && a.j.fine === null && a.j.claude === null && a.j.exit1 === null,
      JSON.stringify({ j: a.j, out: out(a).slice(-600) })]);
    await guard('2.77.1 (B-99): the GEMINI.md rules the launcher writes into agy lanes say to run every command in the foreground (never in the background) and give one command for a game\'s tests (npm --prefix <game folder> run test -- <test file>) (fails on 2.77.0: no such rule)', () => [
      a.j && a.j.foreground && a.j.testForm, JSON.stringify(a.j)]);
  }

  // ---- B-103: a beta-mode approval of a config proposal is applied ----
  {
    const { S, env } = studio('cfg');
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    writeIn(S, 'studio/protected.json', `${JSON.stringify({ globs: ['studio/locked-2771.json'] }, null, 2)}\n`);
    writeIn(S, 'studio/locked-2771.json', `${JSON.stringify({ limit: 1 }, null, 2)}\n`);
    const at = new Date().toISOString();
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'the-owner', at, agents: ['opus-1'] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio: owner key, protected file, beta on', '--no-verify');
    const r = probe(S, `import fs from 'node:fs'; import path from 'node:path'; import { spawnSync } from 'node:child_process';
import { landConfig, protectedPart, protectedGlobsAt, proposalRel } from ${u(S, 'harness/config-proposal.mjs')};
const root = process.cwd();
const g = (...a) => spawnSync('git', ['-c', 'core.autocrlf=false', ...a], { cwd: root, encoding: 'utf8', windowsHide: true });
const changes = [{ file: 'studio/locked-2771.json', set: { limit: 9 } }];
const part = protectedPart(changes, protectedGlobsAt(root, 'HEAD'));
fs.mkdirSync(path.join(root, 'studio-proposals'), { recursive: true });
fs.writeFileSync(path.join(root, proposalRel('T-971')), JSON.stringify({ changes, why: 'raise the limit for the test' }, null, 2) + '\\n');
g('add', '-A'); g('commit', '-qm', 'T-971 lands its proposal', '--no-verify');
const ff = (r, main, sha) => { const m = g('merge', '--ff-only', '-q', sha); return { ok: m.status === 0, message: m.stderr }; };
const before = landConfig(root, { task: 'T-971', main: 'main', ff, by: 'train' });
const beta = JSON.parse(fs.readFileSync(path.join(root, 'studio/beta.json'), 'utf8'));
fs.mkdirSync(path.join(root, 'studio/approvals'), { recursive: true });
fs.writeFileSync(path.join(root, 'studio/approvals/proposal-T-971.json'), JSON.stringify({ approval: { kind: 'proposal', task: 'T-971', change: part.hash, changes: part.changes, by: 'opus-1', note: 'beta-mode approval of the limit', at: new Date().toISOString(), recordedBy: 'opus-1', via: 'beta agent' }, signature: null, beta: { by: beta.by, at: beta.at } }, null, 2) + '\\n');
g('add', '-A'); g('commit', '-qm', 'approval of T-971 (beta mode)', '--no-verify');
const after = landConfig(root, { task: 'T-971', main: 'main', ff, by: 'train' });
const locked = JSON.parse(g('show', 'HEAD:studio/locked-2771.json').stdout);
console.log(JSON.stringify({ beforeHeld: before?.held?.map((h) => h.why.slice(0, 80)), afterOk: after?.ok, applied: after?.applied, decision: after?.decision, limit: locked.limit }));
`, env);
    await guard('2.77.1 (B-103): in beta mode, `approve -- proposal`\'s approval (no signature, the beta record embedded) is accepted when the proposal lands: the protected key is applied (limit 9) and the decision names the beta-mode approval; without it the change is held (fails on 2.77.0: held even with the approval, "only the owner\'s signed approval")', () => [
      r.j && r.j.beforeHeld?.length && /owner key/.test(r.j.beforeHeld[0]) && r.j.afterOk === true && r.j.applied?.includes('studio/locked-2771.json') && /beta mode approval/.test(r.j.decision || '') && r.j.limit === 9,
      JSON.stringify({ j: r.j, out: out(r).slice(-900) })]);
  }

  // ---- B-100: an update's own commits don't fail the hooks gate after upgrade --merge ----
  {
    const { S, env } = studio('hooks');
    g(S, 'checkout', '-qb', 'upstream');
    const pj = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')); pj.version = '9.9.9';
    writeIn(S, 'package.json', `${JSON.stringify(pj, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'harness 9.9.9: version', '--no-verify');
    writeIn(S, 'harness/new-in-update-2771.mjs', 'export const x = 1;\n');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'harness 9.9.9: a new file', '--no-verify');
    const ups = g(S, 'rev-list', 'main..upstream').stdout.trim().split('\n').filter(Boolean);
    g(S, 'checkout', '-q', 'main');
    const start = g(S, 'rev-parse', 'HEAD').stdout.trim();
    const m = run(S, 'node harness/upgrade-guard.mjs --merge upstream --by Pat --permission "Pat: take the 9.9.9 update (selftest)"', { ...env, ...ident });
    const h = probe(S, `import { checkHookStamps, readGrandfather } from ${u(S, 'harness/hook-stamp.mjs')};
const r = await checkHookStamps({ env: { ...process.env, STUDIO_HOOKS_CHECK: 'on' }, range: { base: ${JSON.stringify(start)}, head: 'HEAD' } });
const gf = readGrandfather(process.cwd());
console.log(JSON.stringify({ open: (r.open || []).map((o) => o.sha || o.c?.sha || o), listed: ${JSON.stringify(ups)}.filter((s) => gf.shas.has(s)).length }));
`, env);
    const openShas = JSON.stringify(h.j?.open || []);
    await guard('2.77.1 (B-100): after `upgrade --merge`, the update\'s own commits (made without this studio\'s hooks) are in the grandfather list and the hooks gate doesn\'t list them; the merge says so (fails on 2.77.0: each one was "no Studio-Hooks stamp" on main)', () => [
      m.status === 0 && /listed as made without this studio's hooks/.test(out(m)) && h.j && h.j.listed === ups.length && ups.length === 2 && ups.every((s) => !openShas.includes(s.slice(0, 7))),
      JSON.stringify({ status: m.status, merge: out(m).slice(-700), j: h.j, ups, probe: out(h).slice(-500) })]);
  }

  // ---- PU-44: a session's denials are recorded once, from its own part of the appended agent log ----
  {
    const { S, env } = studio('den');
    const d = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import { recordDenials } from ${u(S, 'harness/denials.mjs')};
const log = path.join(process.cwd(), '.studio', 'agents', 'director-9.log');
fs.mkdirSync(path.dirname(log), { recursive: true });
const result = (ids) => JSON.stringify({ type: 'result', permission_denials: ids.map((i) => ({ tool_name: 'Bash', tool_use_id: 'tu' + i, tool_input: { command: 'node harness/task.mjs next --n ' + i } })) }) + '\\n';
fs.writeFileSync(log, result([1, 2, 3]));
const n1 = recordDenials({ log: '', logFile: log, from: 0, agent: 'director-9', role: 'director' });
const from2 = fs.statSync(log).size;
fs.appendFileSync(log, result([4]));
const n2 = recordDenials({ log: '', logFile: log, from: from2, agent: 'director-9', role: 'director' });
const from3 = fs.statSync(log).size;
const n3 = recordDenials({ log: '', logFile: log, from: from3, agent: 'director-9', role: 'director' });
const lines = fs.readFileSync(path.join(process.cwd(), '.studio', 'denials.jsonl'), 'utf8').split('\\n').filter(Boolean).length;
console.log(JSON.stringify({ n1, n2, n3, lines }));
`, env);
    await guard('2.77.1 (PU-44): a session\'s permission denials are read from its own part of the appended agent log: 3, then 1 new, then 0 for a session with none, 4 records in all (fails on 2.77.0: every session end recorded the whole log again, so the crew\'s 248 records held 182 copies)', () => [
      d.j && d.j.n1 === 3 && d.j.n2 === 1 && (d.j.n3 === 0 || d.j.n3 === null) && d.j.lines === 4, JSON.stringify({ j: d.j, out: out(d).slice(-500) })]);
  }

  // ---- PU-45: no harness message suggests a chained command (agent shells refuse them) ----
  {
    // adopt.mjs gatesFor builds the game's gate commands, which the harness itself runs with a shell (not advice to an agent).
    const hits = [];
    for (const f of fs.readdirSync(path.join(dir, 'harness')).filter((x) => x.endsWith('.mjs'))) {
      const text = fs.readFileSync(path.join(dir, 'harness', f), 'utf8');
      text.split('\n').forEach((l, i) => { if (/&& git commit|`[^`]*\bcd \$\{[^}]+\} && /.test(l) && !/^\s*(\/\/|\*)/.test(l) && !/const cd = `cd \$\{root\} && `/.test(l)) hits.push(`${f}:${i + 1}`); });
    }
    await guard('2.77.1 (PU-45): no harness message tells an agent to run a chained command (`git add … && git commit`, `cd <dir> && …`): it gives one command per call (fails on 2.77.0: task done\'s uncommitted refusal and adopt\'s install hint did)', () => [
      hits.length === 0, hits.join(', ')]);
  }

  if (!process.env.KEEP_2771) for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}

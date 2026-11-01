/**
 * qa/selftest-2591.mjs — 2.59.1: owner decisions an agent records on a person's direct permission.
 *
 * The owner's rule (2026-11-01): "allow agents to sign off when we give direct permission" and "a high level director
 * or producer agent or agent outside of the harness can change things with direct human permission". 2.59.0 refused
 * every agent for `npm run task -- type` and `npm run studio:resume`. Now a Producer or Director session, or an agent
 * outside the harness (a coding agent's shell, an agent's name outside a launched session), may do it when it names
 * the person (--by) and where they said so (--permission). The record keeps both and who recorded it. A builder or
 * other worker session never may; without --permission agents are refused as before.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2591({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const env = { ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_RESUME_BY: '', STUDIO_OWNER_KEY: '' };
  const git = (cmd, e = {}) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`, { ...env, ...e });
  const task = (cmd, e = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...env, ...e });
  const add = (title) => JSON.parse(task(`add "${title}" --role builder`).stdout).id;
  const doneCheck = (id) => out(run(dir, `node harness/done-check.mjs ${id}`, env));
  const readRec = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-types.json'), 'utf8')); } catch { return { tasks: {} }; } };
  const record = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-types.json'), 'utf8')).tasks || {}; } catch { return {}; } };
  // No quote marks inside, and passed in double quotes: cmd.exe (Windows) doesn't treat single quotes as quoting.
  const PERM = 'Hatch on Discord 2026-11-01 18:29, T-x is a UI change, not a bug, retype it';

  git('init -q -b main');
  git('config core.autocrlf false');
  git('add -A');
  git('commit -q -m base --no-verify');

  // An agent outside the harness (a coding agent's shell), on the owner's permission.
  const t1 = add('Fix: bug batch 21 - panel copy');
  const bot = task(`type ${t1} change --by hatch --why "UI copy only; nothing to replay" --permission "${PERM}"`, { CLAUDECODE: '1', STUDIO_LOCK_OWNER: '' });
  const r1 = record()[t1] || {};
  const dc1 = doneCheck(t1);
  report('2.59.1: an agent outside the harness (a coding agent\'s shell) records a reclassification on the owner\'s permission: --by hatch --permission "…" is kept with who recorded it, it counts, and done-check shows the permission',
    bot.status === 0 && r1.type === 'change' && r1.by === 'hatch' && r1.permission === PERM && /coding agent \(CLAUDECODE\)/.test(r1.recordedBy || '') && /is a "change" task/.test(dc1) && /on hatch's permission/.test(dc1),
    `${out(bot).slice(-500)}\n${JSON.stringify(r1)}\n${dc1.slice(0, 600)}`);

  // A launched Producer session, whose commit carries Studio-Agent: producer-s3 (as the commit-msg hook writes).
  const t2 = add('Fix: bug batch 22 - timetable labels');
  const prod = task(`type ${t2} change --by hatch --why "labels only; nothing to replay" --permission "${PERM}" --no-commit`, { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s3' });
  git('add studio/task-types.json');
  git('commit -q -m "T: retype on permission" --no-verify --trailer "Studio-Agent: producer-s3"');
  const dc2 = doneCheck(t2);
  report('2.59.1: a launched Producer session may record it on permission, and its own commit (Studio-Agent: producer-s3) counts because the entry says producer-s3 recorded it',
    prod.status === 0 && record()[t2]?.recordedBy === 'producer-s3' && /is a "change" task/.test(dc2) && /recorded by producer-s3 on hatch's permission/.test(dc2),
    `${out(prod).slice(-400)}\n${dc2.slice(0, 600)}`);

  // Workers never; no permission, no change from 2.59.0.
  const t3 = add('Fix: bug batch 23 - hangar menu');
  const builder = task(`type ${t3} change --by hatch --why "a builder relaying permission" --permission "${PERM}"`, { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s9' });
  const workerShell = task(`type ${t3} change --by hatch --why "a worker shell relaying permission" --permission "${PERM}"`, { STUDIO_LOCK_OWNER: 'builder-s9' });
  const noPerm = task(`type ${t3} change --by hatch --why "the bot says the owner agreed"`, { CLAUDECODE: '1' });
  const shortPerm = task(`type ${t3} change --by hatch --why "too short a permission" --permission "ok"`, { CLAUDECODE: '1' });
  const agentBy = task(`type ${t3} change --by opus-bot --why "permission from itself" --permission "${PERM}"`, { CLAUDECODE: '1' });
  report('2.59.1: a builder session or a worker\'s shell is refused even with --permission; without --permission (or with a too-short one) an agent is refused as in 2.59.0; --by must be the person, not an agent; nothing is recorded',
    builder.status !== 0 && /launched builder session can't act on permission/.test(out(builder)) && workerShell.status !== 0 && /builder-s9 is a worker agent/.test(out(workerShell))
      && noPerm.status !== 0 && /coding agent/.test(out(noPerm)) && /--permission/.test(out(noPerm)) && shortPerm.status !== 0 && agentBy.status !== 0 && /agent's name/.test(out(agentBy)) && !record()[t3],
    [builder, workerShell, noPerm, shortPerm, agentBy].map((r) => out(r).slice(-220)).join('\n---\n'));

  // An entry claiming permission but committed by a worker (or by an agent other than the one it names) doesn't count.
  const t4 = add('Fix: bug batch 24 - shop sign');
  const rec = readRec();
  rec.tasks[t4] = { type: 'docs', from: 'bug', by: 'hatch', why: 'hand-written by a builder with a permission line', at: new Date().toISOString(), permission: PERM, recordedBy: 'builder-s9' };
  fs.writeFileSync(path.join(dir, 'studio/task-types.json'), JSON.stringify(rec, null, 2));
  git('add studio/task-types.json');
  git('commit -q -m "retype" --no-verify --trailer "Studio-Agent: builder-s9"');
  const t5 = add('Fix: bug batch 25 - gate sign');
  const rec5 = readRec();
  rec5.tasks[t5] = { type: 'docs', from: 'bug', by: 'hatch', why: 'names another agent as the recorder', at: new Date().toISOString(), permission: PERM, recordedBy: 'producer-s3' };
  fs.writeFileSync(path.join(dir, 'studio/task-types.json'), JSON.stringify(rec5, null, 2));
  git('add studio/task-types.json');
  git('commit -q -m "retype" --no-verify --trailer "Studio-Agent: director-s2"');
  report('2.59.1: an entry with a permission line committed by a worker (builder-s9), or by an agent other than the one it names, is ignored: the title\'s type stands',
    /is a "bug" task \(from its title\)/.test(doneCheck(t4)) && /is a "bug" task \(from its title\)/.test(doneCheck(t5)), `${doneCheck(t4).slice(0, 400)}\n---\n${doneCheck(t5).slice(0, 400)}`);

  // studio:resume on permission.
  const probe = (code, e = {}) => {
    const f = path.join(dir, `.probe-2591-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...e });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const res = probe(`import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATUS_FILE } from ${u('harness/supervisor.mjs')};
import { selfIdentity } from ${u('harness/proc-identity.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const RESUME = path.join('.studio', 'supervisor-resume');
const halt = () => { fs.rmSync(RESUME, { force: true }); fs.writeFileSync(STATUS_FILE, JSON.stringify({ pid: process.pid, identity: selfIdentity(), status: 'running', startedAt: new Date().toISOString(), halted: { at: new Date().toISOString(), code: 127, why: 'two sessions in a row ended with exit 127' } })); };
const cli = (args, e = {}) => { const x = spawnSync(process.execPath, ['harness/supervisor.mjs', 'resume', ...args], { encoding: 'utf8', env: { ...process.env, ...e } }); return { code: x.status, text: (x.stdout || '') + (x.stderr || ''), file: fs.existsSync(RESUME) ? JSON.parse(fs.readFileSync(RESUME, 'utf8')) : null }; };
fs.mkdirSync('.studio', { recursive: true });
const o = {};
halt(); o.botNoPerm = cli(['--by', 'hatch'], { STUDIO_LOCK_OWNER: 'opus-bot' });
halt(); o.builder = cli(['--by', 'hatch', '--permission', ${JSON.stringify(PERM)}], { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s9' });
halt(); o.bot = cli(['--by', 'hatch', '--why', 'tool-x is on the PATH now', '--permission', ${JSON.stringify(PERM)}], { STUDIO_LOCK_OWNER: 'opus-bot' });
o.ev = readRecentEvents(5000).filter((e) => e.type === 'supervisor.resume_asked').pop() || null;
halt(); o.director = cli(['--by', 'hatch', '--permission', ${JSON.stringify(PERM)}], { STUDIO_ROLE: 'director', STUDIO_LOCK_OWNER: 'director-s2' });
console.log(JSON.stringify(o));`);
  report('2.59.1: npm run studio:resume on permission: an outside agent (opus-bot) or a Director session clears the halt for the named person, the resume file and event keep the permission and who recorded it; without --permission, or from a builder session, it is refused',
    res.botNoPerm?.code === 1 && !res.botNoPerm.file && res.builder?.code === 1 && /launched builder session/.test(res.builder.text) && !res.builder.file
      && res.bot?.code === 0 && res.bot.file?.by === 'hatch' && res.bot.file?.recordedBy === 'opus-bot' && res.bot.file?.permission === PERM && /recorded by opus-bot on hatch's permission/.test(res.ev?.msg || '')
      && res.director?.code === 0 && res.director.file?.recordedBy === 'director-s2',
    JSON.stringify(res).slice(0, 2500));
}

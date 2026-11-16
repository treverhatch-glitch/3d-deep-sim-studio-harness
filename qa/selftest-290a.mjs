/**
 * qa/selftest-290a.mjs — 2.90: costs a live studio's overseer wrote down while running 2.86.
 *   a  a task that names a proposal (its title or --after) waits while it is one, then for the task it became
 *   b  `task promote` takes --phase, --serves and --type, so a porter's "Port …" proposal can be promoted
 * Scaffolding: a studio copy with its own git and events file, as in qa/selftest-286e.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf, gEnvOf, gitUserCrlfOf, guardCap3000Of, out, writeIn as write } from './kit.mjs';

export async function selftest290A({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = gitUserCrlfOf(gEnvOf(ident));
  const guard = guardCap3000Of(report);
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const S = path.join(tmpRoot, `290a-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/proposed.json', 'studio/engine', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  write(S, 'studio/game.json', `${JSON.stringify({ engines: { unity: { repo: '../engine-repo' } } }, null, 2)}\n`);
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-290a.jsonl');
  fs.writeFileSync(evFile, '');
  const env = {
    ...clean, ...ident, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_USAGE_FUNCTIONS: 'off', STUDIO_DISK_MIN_FREE_GB: '0', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-290a-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '',
  };
  const node = (args) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env, encoding: 'utf8', timeout: 180000 });
  const task = (...a) => node(['harness/task.mjs', ...a]);
  const u = fileUrlOf(S);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(S, `.probe-290a-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = node([f]);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const board = () => fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
  const idOf = (title) => (board().match(new RegExp(`\\*\\*(T-\\d+)\\*\\*[^\\n]*${title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`)) || [])[1] || null;

  // ================= a. a task that names a proposal waits for it =================
  {
    const r = probe(`import fs from 'node:fs';
const th = await import(${u('harness/task-hold.mjs')});
const write = (items) => fs.writeFileSync('studio/proposed.json', JSON.stringify({ items, next: 3 }));
const q = (done) => ({ done: done.map((id) => ({ id })), inProgress: [], backlog: [{ id: 'T-001', role: 'engine-porter', title: 'Wire batch 1 to the engine (web half: P-01)' }, { id: 'T-002', role: 'producer', title: 'Look at P-01 and decide' }, { id: 'T-003', role: 'builder', title: 'Another task' }] });
write([{ id: 'P-01', title: 'Web half of batch 1', role: 'builder', agent: 'builder-1', meta: {} }]);
th.setHold('T-003', { after: ['P-01'] });
const open = th.holdReason('T-001', q([]), Date.now(), th.readHolds());
const owner = th.holdOwner('T-001', q([]), Date.now(), th.readHolds());
const producer = th.holdReason('T-002', q([]), Date.now(), th.readHolds());
const viaAfter = th.holdReason('T-003', q([]), Date.now(), th.readHolds());
write([{ id: 'P-01', title: 'Web half of batch 1', role: 'builder', agent: 'builder-1', meta: {}, promoted: 'T-009' }]);
const became = th.holdReason('T-001', q([]), Date.now(), th.readHolds());
const doneNow = th.holdReason('T-001', q(['T-009']), Date.now(), th.readHolds());
console.log(JSON.stringify({ open, owner: owner && owner.owner, producer, viaAfter, became, doneNow }));`);
    await guard('2.90 (a) a backlog task whose title names an open proposal (P-01) waits for it, the reason names `task promote P-01` and the owner is the Producer; a --after P-01 hold says the same; once P-01 became T-009 the task waits for T-009 and starts when T-009 is done; a Producer\'s task that names P-01 is not held (fails on 2.89: holdReason was null, so the task launched while its other half was still a proposal)', () => [
      /still a proposal/.test(String(r.open)) && /promote P-01/.test(String(r.open)) && r.owner === 'the Producer' && r.producer === null && /still a proposal/.test(String(r.viaAfter))
        && /T-009 \(was P-01\)/.test(String(r.became)) && r.doneNow === null,
      JSON.stringify(r)]);
  }
  {
    write(S, 'studio/proposed.json', JSON.stringify({ items: [{ id: 'P-02', title: 'Web half of batch 2', role: 'builder', agent: 'builder-1', meta: {} }], next: 3 }));
    const add = task('add', 'Docs: wire notes for batch 2', '--agent', 'prod-1', '--after', 'P-02');
    const bad = task('add', 'Docs: wire notes for batch 3', '--agent', 'prod-1', '--after', 'P-77');
    await guard('2.90 (a) `task add --after P-02` with P-02 an open proposal is queued and its hold names P-02, while an id that is neither a task nor an open proposal is still refused (fails on 2.89: "P-02 is not a task id on the board")', () => {
      const id = idOf('wire notes for batch 2');
      const holds = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'task-holds.json'), 'utf8')).tasks || {};
      return [add.status === 0 && Boolean(id) && (holds[id]?.after || []).includes('P-02') && bad.status !== 0 && /P-77 is not a task id/.test(out(bad)), JSON.stringify({ add: out(add).slice(-400), bad: out(bad).slice(-300), id, hold: id && holds[id] })];
    });
  }

  // ================= b. promote takes what the gate asks =================
  {
    fs.rmSync(path.join(S, 'studio', 'proposed.json'), { force: true });
    node(['harness/intake.mjs', '--answers', 'studio/templates/intake-example.json']);
    const sign = node(['harness/bible.mjs', 'sign', '--by', 'hatch']);
    const p1 = task('add', 'Port (engine, batch 1): the rules of the store', '--role', 'engine-porter', '--agent', 'engine-porter-1', '--why', 'the next batch of the port plan');
    const p2 = task('add', 'Port (engine, batch 2): the rules of the market', '--role', 'engine-porter', '--agent', 'engine-porter-1', '--why', 'the batch after it');
    const plain = task('promote', 'P-1', '--by', 'prod-1');
    const flagged = task('promote', 'P-1', '--by', 'prod-1', '--phase', '1', '--serves', 'pillar:Calm');
    const chore = task('promote', 'P-2', '--by', 'prod-1', '--type', 'chore');
    const badType = task('promote', 'P-2', '--by', 'prod-1', '--type', 'nonsense');
    await guard('2.90 (b) a porter\'s "Port …" proposal: plain `task promote` still refuses it and says to promote with --phase and --serves (or --type chore); `promote P-1 --phase 1 --serves pillar:Calm` queues it, and `promote P-2 --type chore` queues it as "Chore: Port …"; an unknown --type is refused (fails on 2.89: promote took no flags, so both stayed refused and were re-added by hand)', () => [
      sign.status === 0 && /Proposed P-1/.test(out(p1)) && /Proposed P-2/.test(out(p2))
        && /Refused: P-1/.test(out(plain)) && /promote P-1 --by prod-1 --phase/.test(out(plain)) && /--type chore/.test(out(plain))
        && /Queued P-1→T-\d+/.test(out(flagged)) && /Queued P-2→T-\d+/.test(out(chore)) && Boolean(idOf('Chore: Port (engine, batch 2)')) && Boolean(idOf('Port (engine, batch 1): the rules of the store'))
        && badType.status !== 0 && /Unknown --type/.test(out(badType)),
      JSON.stringify({ sign: out(sign).slice(-200), p1: out(p1).slice(-200), plain: out(plain).slice(-600), flagged: out(flagged).slice(-300), chore: out(chore).slice(-300), badType: out(badType).slice(-200) })]);
  }

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep removes it */ }
}

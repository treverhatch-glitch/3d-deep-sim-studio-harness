/**
 * qa/selftest-283j.mjs — 2.83: the owner-only list tells the game's own money from real money, and code removed in a
 * lane from deleted data.
 *
 * A crew's owner was paged for a balance question that used the word "money" and for a task that removed three unwired
 * modules: the owner's proxy was refused both. The list (harness/owner-acts.mjs) now reads those two for what they are,
 * and nothing else: one word of real spending, or of data, keeps the question the owner's. A stand-in's answer to such
 * an ask records the reading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function selftest283J({ dir, report, tmpRoot, root }) {
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, ok, d); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 1500)); } };
  const { ownerOnlyTopic, ownerOnlyReadAs, ownerOnlyAction } = await import(pathToFileURL(path.join(dir, 'harness', 'owner-acts.mjs')).href);
  const act = (q, why = '') => ownerOnlyTopic(q, why)?.act || null;
  const wrong = (cases) => cases.filter(([q, want]) => act(q) !== want).map(([q, want]) => `${JSON.stringify(q)}: got ${act(q)}, want ${want}`);

  const game = [
    ['Balance: the plan said a lean start runs dry in 4 days, so payroll is halved for week one. If the measured runway holds, that week hands out money the game does not need. Retire it?', null],
    ['In-game loans: should the player pay 5% or 8% interest on a $50,000 loan?', null],
    ['Playtest note: players buy the cheapest truck and never upgrade. Raise its upkeep?', null],
    ['Game design: should a refund of half the build cost be paid when the player demolishes a building?', null],
  ];
  const real = [
    ['Can I spend money on a subscription?', 'money'],
    ['Pay the invoice?', 'money'],
    ['Should we buy the paid plan so the player gets better art?', 'money'],
    ['The game\'s economy needs music: buy a sound pack for $20?', 'money'],
    ['Players pay real money for the in-game currency: set the pack at $4.99?', 'money'],
    ['For the playtest, purchase two more seats of the tool?', 'money'],
    ['The player pays $5 in the game. Bill us in USD?', 'money'],
    ['Buy it?', 'money'],
  ];
  await guard('2.83 the owner-only list, money: a question that says it is about the game (the player, in-game, a balance or playtest question) and names nothing of real spending is not the owner\'s "real money", so the owner\'s proxy may answer a balance question (fails before this fix: any ask with the word money, pay or buy, or a $ amount, waited for the owner in person)', () => {
    const w = wrong(game); return [w.length === 0, w.join(' | ').slice(0, 1500)];
  });
  await guard('2.83 the owner-only list, money: one word of real spending keeps it the owner\'s, whatever else the question says about the game (a paid plan, a subscription, an invoice, an asset bought, real money for in-game currency, a real currency), and so does a bare "buy it?"', () => {
    const w = wrong(real); return [w.length === 0, w.join(' | ').slice(0, 1500)];
  });

  const code = [
    ['T-456 (delete the unwired staff/, prestige/, gates/ modules with their tests) passed and is queued. Release it?', null],
    ['Delete the old helper functions in ui/panel.ts?', null],
    ['The port is live: delete the unused code of the old pathfinding module in this lane?', null],
  ];
  const data = [
    ['Delete the backups of the unwired modules?', 'delete'],
    ['Wipe the unused modules?', 'delete'],
    ['Delete the repo history of the test files?', 'delete'],
    ['Delete the save files?', 'delete'],
    ['Delete the branch with the unused code?', 'delete'],
    ['Delete the worktree of the old module?', 'delete'],
    ['Delete the lane of the old module?', 'delete'],
    ['Delete it?', 'delete'],
    ['Delete the unused test files with rm -rf?', 'delete'],
    ['Delete the events log and the old scripts?', 'delete'],
    ['Purge the dead code?', 'delete'],
    ['Delete .studio and the unused scripts?', 'delete'],
  ];
  await guard('2.83 the owner-only list, delete: removing code through a lane (modules, functions, tests, a named source file) is not the owner\'s "deleting data": it is reviewed and stays in git history (fails before this fix: a task that removed three unwired modules waited for the owner in person)', () => {
    const w = wrong(code); return [w.length === 0, w.join(' | ').slice(0, 1500)];
  });
  await guard('2.83 the owner-only list, delete: anything that names data stays the owner\'s (backups, history, saves, a branch, a worktree, logs, .studio), so does a wipe, purge or rm -r of anything, and so does a bare "delete it?"', () => {
    const w = wrong(data); return [w.length === 0, w.join(' | ').slice(0, 1500)];
  });
  await guard('2.83 the owner-only list: the action names are untouched (a delegation for "money", "pay", "delete" or "wipe" is refused to a stand-in as before), keys and publishing are read as before, and each reading names itself', () => {
    const acts = ['money', 'pay', 'buy', 'delete', 'wipe'].every((a) => ownerOnlyAction(a));
    const others = act('Rotate the API key the player service uses?') === 'credentials' && act('Publish the in-game shop page?') === 'publish';
    const r1 = ownerOnlyReadAs(game[1][0]); const r2 = ownerOnlyReadAs(code[0][0]); const r3 = ownerOnlyReadAs(real[0][0]);
    return [acts && others && r1.length === 1 && r1[0].act === 'money' && /not real money/.test(r1[0].why) && r2.length === 1 && r2[0].act === 'delete' && /not deleting data/.test(r2[0].why) && r3.length === 0,
      JSON.stringify({ acts, others, r1, r2, r3 }).slice(0, 900)];
  });

  // Through the real command, in a studio with beta mode on (the overseer the owner named answers asks for the owner):
  // the balance question is answered and the reading recorded; the question about a paid plan is refused and stays open.
  {
    const S = fs.mkdtempSync(path.join(tmpRoot, '283j-studio-'));
    const nm = path.join(root || dir, 'node_modules');
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/asks', 'studio/delegation.json', '.env']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    const writeIn = (rel, text) => { fs.mkdirSync(path.dirname(path.join(S, rel)), { recursive: true }); fs.writeFileSync(path.join(S, rel), text); };
    writeIn('.studio/events-283j.jsonl', '');
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    writeIn('studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    writeIn('studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
    const g = (...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd: S, encoding: 'utf8', env: gEnv() });
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'studio, owner key, beta on', '--no-verify');
    const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_OUTSIDE_SIGNERS: '', STUDIO_BETA: '', CLAUDECODE: '', STUDIO_ROOT: '', AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-283j.jsonl') };
    const node = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...ident, ...base, ...extra } });
    const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
    const asked = [
      node(['harness/ask.mjs', 'In-game loans: should the player pay 5% or 8% interest?', '--by', 'builder-s1'], { STUDIO_LOCK_OWNER: 'builder-s1' }),
      node(['harness/ask.mjs', 'Should we buy the paid plan of the art tool?', '--by', 'builder-s1'], { STUDIO_LOCK_OWNER: 'builder-s1' }),
      node(['harness/ask.mjs', 'T-9 removes the unwired shop/ module with its tests: go ahead?', '--by', 'builder-s1'], { STUDIO_LOCK_OWNER: 'builder-s1' }),
    ];
    const orch = { CLAUDECODE: '1' };
    const a1 = node(['harness/ask.mjs', 'answer', 'A-001', '5', '--by', 'overseer-1'], orch);
    const a2 = node(['harness/ask.mjs', 'answer', 'A-002', 'yes', '--by', 'overseer-1'], orch);
    const a3 = node(['harness/ask.mjs', 'answer', 'A-003', 'yes', '--by', 'overseer-1'], orch);
    const doc = (id) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'asks', `${id}.json`), 'utf8')); } catch { return null; } };
    const d1 = doc('A-001'); const d2 = doc('A-002'); const d3 = doc('A-003');
    await guard('2.83 the owner-only list, through the ask command (beta mode, the overseer the owner named): it answers an in-game money question, and the answer records that the money words were read as the game\'s own; a question about buying a paid plan is refused to it and stays open; a question about removing a module is answered with nothing to record (no owner-only word in it) (fails before this fix: the first was refused as "real money")', () => [
      a1.status === 0 && d1?.status === 'answered' && d1.recordedBy === 'overseer-1' && d1.answeredBy === 'pat' && d1.readAs?.length === 1 && d1.readAs[0].act === 'money'
        && a2.status !== 0 && /real money/.test(out(a2)) && d2?.status === 'open'
        && a3.status === 0 && d3?.status === 'answered' && !d3.readAs,
      `${asked.map((r) => out(r).slice(-120)).join(' | ')} || ${out(a1).slice(-300)} | ${out(a2).slice(-300)} | ${out(a3).slice(-200)} | ${JSON.stringify({ d1: d1 && { s: d1.status, by: d1.recordedBy, readAs: d1.readAs }, d2: d2 && d2.status, d3: d3 && { s: d3.status, readAs: d3.readAs } })}`.slice(0, 2200)]);
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
}

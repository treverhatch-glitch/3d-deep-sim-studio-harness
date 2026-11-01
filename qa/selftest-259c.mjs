/**
 * qa/selftest-259c.mjs — 2.59.0 (crew brief item 5): the owner reclassifies a task's type, and a bug's regression can
 * be a seeded game unit test where no cartridge covers the bug.
 *   1. `npm run task -- type <ID> <type> --by <owner> --why "…"`: a person in their own terminal is recorded (and the
 *      record is committed); an agent's name, a launched session and an agent's shell are refused. done-check uses the
 *      recorded type and says where it comes from; an entry set by an agent's commit doesn't count. With an owner key
 *      the reclassification must be signed (an unsigned record is then ignored; a tampered approval doesn't verify).
 *   2. A "kind": "test" regression: qa/fails-before.mjs runs the studio's own test command (studio/game.json
 *      "regressionTest") and proves the test fails on the parent and passes on the fix; the HEAD control fails; a
 *      test file that can't load at the old commit is an error (known: false), never a pass.
 *   3. done-check accepts that regression for a bug task; qa/check-regressions.mjs runs it.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest259C({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const env = { ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-259c-${process.pid}.pem`) };
  const git = (cmd, e = {}) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`, { ...env, ...e });
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const task = (cmd, e = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...env, ...e });
  const add = (title) => JSON.parse(task(`add "${title}" --role builder`).stdout).id;
  const doneCheck = (id, e = {}) => out(run(dir, `node harness/done-check.mjs ${id}`, { ...env, ...e }));
  const record = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-types.json'), 'utf8')).tasks || {}; } catch { return {}; } };

  git('init -q -b main');
  git('config core.autocrlf false');
  git('add -A');
  git('commit -q -m base --no-verify');

  // ---- 1. the owner record (no owner key yet) ----
  const t1 = add('Fix: bug batch 12 - UI panels and copy');
  const before = doneCheck(t1);
  const rec = task(`type ${t1} change --by hatch --why "UI copy fixes; no sim behaviour to replay"`);
  const last = git('log -1 "--format=%s%n%(trailers:key=Studio-Agent,valueonly)" --name-only').stdout;
  const after = doneCheck(t1);
  report('2.59.0 (item 5): a person reclassifies a task (task type <ID> change --by hatch --why …): recorded in studio/task-types.json with who, why, when and from→to, and committed from their terminal',
    rec.status === 0 && record()[t1]?.type === 'change' && record()[t1]?.from === 'bug' && record()[t1]?.by === 'hatch' && /no sim/.test(record()[t1]?.why || '') && /^\d{4}-/.test(record()[t1]?.at || '') && /studio\/task-types\.json/.test(last) && /reclassified/.test(last) && !/opus|builder|claude/.test(last), `${out(rec)}\n${last}\n${JSON.stringify(record())}`);
  report('2.59.0 (item 5): done-check then uses the recorded type and says where it comes from (title before, owner record after)',
    /is a "bug" task \(from its title\)/.test(before) && /is a "change" task \(set by hatch on \d{4}-\d\d-\d\d \(the title says bug\) \[owner record in studio\/task-types\.json, commit [0-9a-f]{8}; not signed/.test(after) && !/Regression saved/.test(after), `${before.slice(0, 300)}\n---\n${after.slice(0, 600)}`);
  const shown = task(`type ${t1}`);
  report('2.59.0 (item 5): task type <ID> with no type shows the type and its source', shown.status === 0 && /is a "change" task \(set by hatch/.test(out(shown)), out(shown));

  const t2 = add('Fix: bug batch 13 - timetable');
  const byAgent = task(`type ${t2} change --by opus-bot --why "the bot says this is not a bug"`);
  const byLaunched = task(`type ${t2} change --by hatch --why "relayed from the owner on Discord"`, { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' });
  const byShell = task(`type ${t2} change --by hatch --why "relayed from the owner on Discord"`, { STUDIO_LOCK_OWNER: 'opus-12' });
  const byBot = task(`type ${t2} change --by hatch --why "relayed from the owner on Discord"`, { CLAUDECODE: '1' });
  const bySession = (() => { w('.studio/agents/fixer-7.json', JSON.stringify({ agent: 'fixer-7', role: 'builder', status: 'ended' })); return task(`type ${t2} change --by fixer-7 --why "a launched agent's own name"`); })();
  report('2.59.0 (item 5): an agent\'s name is refused (opus-bot; a launched session\'s name), and nothing is recorded',
    byAgent.status !== 0 && /"opus-bot" is an agent's name/.test(out(byAgent)) && bySession.status !== 0 && /"fixer-7" is an agent's name/.test(out(bySession)) && !record()[t2], `${out(byAgent)}\n${out(bySession)}`);
  report('2.59.0 (item 5): refused inside a launched agent session (STUDIO_ROLE), in a shell working as an agent (STUDIO_LOCK_OWNER) and in a coding agent\'s own shell (CLAUDECODE), even with --by <owner>',
    byLaunched.status !== 0 && /launched builder session/.test(out(byLaunched)) && byShell.status !== 0 && /works as opus-12/.test(out(byShell)) && byBot.status !== 0 && /run by a coding agent \(CLAUDECODE/.test(out(byBot)) && !record()[t2], `${out(byLaunched)}\n${out(byShell)}\n${out(byBot)}`);
  const noWhy = task(`type ${t2} change --by hatch`);
  const noneType = task(`type ${t2} none --by hatch --why "close it with no check at all"`);
  report('2.59.0 (item 5): a reclassification needs a reason, and can\'t set "none" (closing without a check stays a signed force approval)',
    noWhy.status !== 0 && /--why/.test(out(noWhy)) && noneType.status !== 0 && /approve -- force/.test(out(noneType)) && !record()[t2], `${out(noWhy)}\n${out(noneType)}`);

  // An entry an agent's commit wrote doesn't count.
  const r2 = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-types.json'), 'utf8')); } catch { return { tasks: {} }; } })();
  r2.tasks[t2] = { type: 'docs', from: 'bug', by: 'hatch', why: 'hand-written by an agent to dodge the bug check', at: new Date().toISOString() };
  w('studio/task-types.json', JSON.stringify(r2, null, 2));
  git('add studio/task-types.json');
  git(`commit -q -m "retype" --no-verify --trailer "Studio-Agent: opus-12"`);
  const tampered = doneCheck(t2);
  report('2.59.0 (item 5): an entry set by an agent\'s commit (Studio-Agent trailer) is ignored: the title\'s type stands and the note says why',
    /is a "bug" task \(from its title\)/.test(tampered) && /set by commit [0-9a-f]{8} of the agent opus-12/.test(tampered) && /is a "change" task/.test(doneCheck(t1)), tampered.slice(0, 800));
  const lines = run(dir, `node --input-type=module -e "const { typeRecordLines } = await import('./harness/reclassify.mjs'); console.log(JSON.stringify(typeRecordLines()))"`, env);
  const gates = run(dir, 'node scripts/run-gates.mjs --only secrets --no-detach', env);
  report('2.59.0 (item 5): verify lists the reclassifications in force and warns about one that doesn\'t count',
    new RegExp(`owner type: ${t1} is a "change" task, set by hatch`).test(out(gates)) && new RegExp(`WARN owner type: ${t2}: a reclassification is on file but doesn't count`).test(out(gates)), `${out(lines).slice(0, 600)}\n---\n${out(gates).slice(0, 1500)}`);

  // ---- 2. a "kind": "test" regression ----
  w('studio/game.json', `${JSON.stringify({ regressionTest: { command: 'node game/toy/run-test.mjs {file} {name} {seed} {junit}' } }, null, 2)}\n`);
  w('game/toy/run-test.mjs', `// A tiny test runner: runs one named test with a seed and writes a JUnit result.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
const [file, name, seed, junit] = process.argv.slice(2);
const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/"/g, '&quot;');
let mod;
try { mod = await import(pathToFileURL(path.resolve(file)).href); } catch (err) {
  fs.writeFileSync(junit, '<testsuites><testsuite name="' + esc(file) + '"><testcase name="' + esc(file) + '"><failure message="' + esc(err.message) + '"/></testcase></testsuite></testsuites>');
  console.error('load failed: ' + err.message); process.exit(1);
}
let fail = null;
try { mod.tests[name](Number(seed)); } catch (err) { fail = err; }
fs.writeFileSync(junit, '<testsuites><testsuite name="toy"><testcase classname="toy" name="' + esc(name) + '">' + (fail ? '<failure message="' + esc(fail.message) + '"/>' : '') + '</testcase></testsuite></testsuites>');
process.exit(fail ? 1 : 0);
`);
  w('game/toy/src/score.mjs', 'export function score(seed) { return seed + 1; }\n');
  git('add -A');
  git('commit -q -m "toy game with the score bug" --no-verify');
  const bug = add('Fix: score doubles wrong for some seeds');
  task(`start ${bug} --agent fixer-1`);
  w('game/toy/src/score.mjs', 'export function score(seed) { return seed * 2; }\n');
  w('game/toy/src/bonus.mjs', 'export const bonus = (n) => n * 2;\n');
  w('game/toy/tests/score.test.mjs', `import { score } from '../src/score.mjs';
export const tests = { 'score doubles the seed': (seed) => { if (score(seed) !== seed * 2) throw new Error('score(' + seed + ') = ' + score(seed)); } };
`);
  // This one imports a module the fix adds: at the old commit it can't load, which proves nothing.
  w('game/toy/tests/bonus.test.mjs', `import { bonus } from '../src/bonus.mjs';
export const tests = { 'bonus doubles': (seed) => { if (bonus(seed) !== seed * 2) throw new Error('bonus'); } };
`);
  const reg = (id, file, name) => w(`qa/regressions/${id}.json`, `${JSON.stringify({ id, kind: 'test', test: { file, name }, seed: 21, description: 'score was seed + 1', fixed: true }, null, 2)}\n`);
  reg('BUG-score', 'game/toy/tests/score.test.mjs', 'score doubles the seed');
  reg('BUG-bonus', 'game/toy/tests/bonus.test.mjs', 'bonus doubles');
  git('add -A');
  git(`commit -q -m "fix the score" --no-verify --trailer "Studio-Task: ${bug}"`);
  const fb = (file, rev) => {
    const r = run(dir, `node --input-type=module -e "const { failsBefore } = await import('./qa/fails-before.mjs'); console.log(JSON.stringify(failsBefore('${file}', '${rev}')))"`, env);
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-1200) }; }
  };
  const parent = fb('qa/regressions/BUG-score.json', 'HEAD~1');
  report('2.59.0 (item 5): a "kind": "test" regression is proven by fails-before: the seeded test fails on the parent and passes on the fix, run with the studio\'s own test command',
    parent.ok === true && parent.known === true && /fails on the old code \(score\(21\) = 22\) and passes on the current checkout/.test(parent.why || ''), JSON.stringify(parent));
  const head = fb('qa/regressions/BUG-score.json', 'HEAD');
  report('2.59.0 (item 5): the HEAD control fails ("the test passes on … too"), and no worktree is left behind', head.ok === false && head.known === true && /passes on [0-9a-f]{7} too/.test(head.why || '') && !/fails-before-/.test(git('worktree list').stdout), JSON.stringify(head));
  const load = fb('qa/regressions/BUG-bonus.json', 'HEAD~1');
  report('2.59.0 (item 5): a test that can\'t load at the old commit (it imports what the fix adds) is an error (known: false), never a pass, and isn\'t cached',
    load.ok === false && load.known === false && /didn't run/.test(load.why || '') && /proves nothing/.test(load.why || '') && !(() => { try { return fs.readFileSync(path.join(dir, '.studio/cache/fails-before.json'), 'utf8'); } catch { return ''; } })().includes('didn\'t run'), JSON.stringify(load));
  fs.rmSync(path.join(dir, 'qa/regressions/BUG-bonus.json'));
  const noJunit = (() => {
    w('studio/game.json', `${JSON.stringify({ regressionTest: { command: 'node game/toy/run-test.mjs {file} {name} {seed}' } }, null, 2)}\n`);
    const r = fb('qa/regressions/BUG-score.json', 'HEAD~1');
    w('studio/game.json', `${JSON.stringify({ regressionTest: { command: 'node game/toy/run-test.mjs {file} {name} {seed} {junit}' } }, null, 2)}\n`);
    return r;
  })();
  report('2.59.0 (item 5): a test command with no JUnit result ({junit}) is refused: a test that never ran can\'t count as failing',
    noJunit.ok === false && noJunit.known === false && /\{junit\}/.test(noJunit.why || ''), JSON.stringify(noJunit));

  // ---- 3. done-check and the regressions gate accept it ----
  const dc = doneCheck(bug);
  report('2.59.0 (item 5): done-check accepts the seeded game test as the bug\'s regression (saved, and fails on the code before the fix)',
    /is a "bug" task/.test(dc) && /\[x\] Regression saved/.test(dc) && /\[x\] Regression fails on the code before the fix/.test(dc), dc.slice(0, 1500));
  const regs = run(dir, 'node qa/check-regressions.mjs', env);
  report('2.59.0 (item 5): qa/check-regressions.mjs runs the test regression with the studio\'s runner and the cartridge replays as before',
    regs.status === 0 && /PASS BUG-score\.json \(test "score doubles the seed"/.test(out(regs)) && /PASS example-same-tick\.json/.test(out(regs)), out(regs));

  // ---- 1b. with an owner key: a reclassification must be signed ----
  const keyFile = path.join(tmpRoot, `owner-259c-${process.pid}.pem`);
  const keyEnv = { STUDIO_OWNER_KEY: keyFile };
  const kg = run(dir, 'node harness/approve.mjs keygen', { ...env, ...keyEnv });
  git('add studio/keys/owner-ed25519.pub.pem');
  git('commit -q -m "owner key" --no-verify');
  const unsigned = doneCheck(t1);
  report('2.59.0 (item 5): once the studio has an owner key, an unsigned record no longer counts (the title\'s type stands; the note says it must be signed)',
    kg.status === 0 && /is a "bug" task \(from its title\)/.test(unsigned) && /has an owner key, so a reclassification counts only when it is signed/.test(unsigned), `${out(kg)}\n${unsigned.slice(0, 800)}`);
  const noPriv = task(`type ${t1} change --by hatch --why "UI copy fixes; no sim behaviour to replay"`);
  report('2.59.0 (item 5): with an owner key and no private key on this machine, the reclassification is refused and nothing is written',
    noPriv.status !== 0 && /no owner private key on this machine/.test(out(noPriv)) && !fs.existsSync(path.join(dir, `studio/approvals/type-${t1}.json`)), out(noPriv));
  const signed = task(`type ${t1} change --by hatch --why "UI copy fixes; no sim behaviour to replay"`, keyEnv);
  const signedCheck = doneCheck(t1);
  const appr = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, `studio/approvals/type-${t1}.json`), 'utf8')); } catch { return null; } })();
  report('2.59.0 (item 5): on the owner\'s device it is signed (studio/approvals/type-<ID>.json, kind "type") and done-check honours it as owner-signed',
    signed.status === 0 && appr?.approval?.kind === 'type' && appr.approval.to === 'change' && typeof appr.signature === 'string' && /is a "change" task \(set by hatch .*\[owner-signed, studio\/approvals\/type-/.test(signedCheck), `${out(signed)}\n${signedCheck.slice(0, 600)}`);
  if (appr?.approval) appr.approval.to = 'docs';
  w(`studio/approvals/type-${t1}.json`, JSON.stringify(appr || { approval: { kind: 'type', task: t1, to: 'docs', by: 'hatch' }, signature: 'x' }, null, 2));
  const forged = doneCheck(t1);
  report('2.59.0 (item 5): an edited (forged) approval doesn\'t verify: the title\'s type stands',
    /is a "bug" task \(from its title\)/.test(forged) && !/is a "docs" task/.test(forged), forged.slice(0, 600));
}

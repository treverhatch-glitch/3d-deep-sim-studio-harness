/**
 * qa/selftest-2601q.mjs — 2.60.1 (crew B-38, B-39, B-40).
 *   B-38: what makes a task a render task. A valid owner type that isn't render work outranks the title; an invalid one
 *         (a worker's commit) changes nothing; `task visual <ID> off|on` is recorded like `task type` (a person, or a
 *         Producer/Director/outside agent on permission; workers never) and shown in done-check; once the task has
 *         commits, evidence decides: a render-looking title whose changes touch no render path ("visualPaths") needs no
 *         visual result, one that does still needs it, and a non-render title that changes render files gets a warning
 *         (and needs the result only with the strict switch).
 *   B-39: a lane held for landing (`task hold`) or queued for the merge train doesn't run the claim clock, gets no
 *         rescue, its rescues can't start, holding closes its waiting rescues, and landing closes them; a lane that is
 *         neither is still stopped by its budget.
 *   B-40: in a lane copy the Claude Code hook denies edits to studio config (studio/ is main's), and task done in a
 *         lane warns, naming the files, when main's studio config changed uncommitted while the task was worked.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2601Q({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const env = { ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', STUDIO_MAIN_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', CLAUDE_PROJECT_DIR: '', STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_STRICT: '', STUDIO_VISUAL_GATE: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2601q-${process.pid}.pem`) };
  const outside = { STUDIO_LOCK_OWNER: 'opus-bot', CLAUDECODE: '1' };
  const worker = { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' };
  const git = (cmd, e = {}) => run(dir, `git -c user.name=hatch -c user.email=owner@example.com ${cmd}`, { ...env, ...e });
  const w = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const task = (cmd, e = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...env, ...e });
  const add = (title, role = 'builder') => JSON.parse(task(`add "${title}" --role ${role}`).stdout).id;
  const gate = (id, title, e = {}) => run(dir, `node harness/verdict-split.mjs gate ${id} --title "${title}"`, { ...env, ...e });
  const doneCheck = (id, e = {}) => out(run(dir, `node harness/done-check.mjs ${id}`, { ...env, ...e }));
  const types = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-types.json'), 'utf8')); } catch { return { tasks: {} }; } };
  const board = () => fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const commitAs = (msg, trailers = []) => git(`commit -q -m "${msg}" --no-verify ${trailers.map((t) => `--trailer "${t}"`).join(' ')}`);
  const NEEDS = /a render task needs a visual result/;

  git('init -q -b main');
  git('config core.autocrlf false');
  git('add -A');
  git('commit -q -m base --no-verify');

  // ---- B-38 (1): the owner's type outranks the title ----
  const tCfg = add('Wire the web visual-capture camera config');
  const tBad = add('Wire the render scene capture config');
  const typed = task(`type ${tCfg} change --by hatch --why "config only: the capture settings, nothing on screen changes"`);
  const rec = types();
  rec.tasks[tBad] = { type: 'change', from: 'change', by: 'hatch', why: 'a worker wrote this to skip the visual proof', at: new Date().toISOString(), permission: 'hatch said so in chat, honest', recordedBy: 'builder-s3' };
  w('studio/task-types.json', JSON.stringify(rec, null, 2));
  git('add studio/task-types.json');
  commitAs('retype', ['Studio-Agent: builder-s3']);
  const gCfg = gate(tCfg, 'Wire the web visual-capture camera config');
  const dCfg = run(dir, `node harness/task.mjs done ${tCfg} --agent hatch --check`, env);
  report('2.60.1 (B-38): a render-titled task the owner reclassified as "change" (valid: a person\'s committed record) no longer needs a visual result (gate passes, task done --check doesn\'t ask for one)',
    typed.status === 0 && gCfg.status === 0 && !NEEDS.test(out(gCfg)) && !NEEDS.test(out(dCfg)) && /owner made it a "change" task/.test(out(gCfg)), `${out(typed)}\n---\n${out(gCfg)}\n---\n${out(dCfg).slice(0, 800)}`);
  const gBad = gate(tBad, 'Wire the render scene capture config');
  report('2.60.1 (B-38): the same entry set by a worker\'s commit (Studio-Agent: builder-s3) changes nothing: the task still needs its visual result',
    gBad.status !== 0 && NEEDS.test(out(gBad)), out(gBad));

  // ---- B-38 (2): task visual <ID> off|on ----
  const tVis = add('Fix the render test flake under the scene folder');
  const byWorker = task(`visual ${tVis} off --by hatch --why "test-only fix, nothing on screen changes" --permission "hatch in chat: visual proof off for this one"`, worker);
  report('2.60.1 (B-38): a builder can\'t set a task\'s visual proof, even with a permission line; nothing is recorded',
    byWorker.status !== 0 && /worker|can't act on permission/.test(out(byWorker)) && !types().visual?.[tVis], out(byWorker));
  const byBot = task(`visual ${tVis} off --by hatch --why "test-only fix, nothing on screen changes" --permission "hatch in chat 21:05: visual proof off for this one"`, outside);
  const vr = types().visual?.[tVis];
  const gVis = gate(tVis, 'Fix the render test flake under the scene folder');
  const dcVis = doneCheck(tVis);
  report('2.60.1 (B-38): task visual <ID> off --by hatch --permission "…" from an outside agent is recorded (who, why, permission, recorded by), committed, honoured by the gate, and done-check says "visual proof: off, set by opus-bot on hatch\'s permission"',
    byBot.status === 0 && vr?.visual === 'off' && vr.by === 'hatch' && vr.recordedBy === 'opus-bot' && /visual proof off/.test(git('log -1 --format=%s').stdout) && gVis.status === 0 && /visual proof: off, set by opus-bot on hatch's permission/.test(dcVis),
    `${out(byBot)}\n${JSON.stringify(vr)}\n---\n${out(gVis)}\n---\n${dcVis.slice(0, 800)}`);
  // A visual decision written by a worker's commit doesn't count (the same rule as task type).
  const tVis2 = add('Port the camera rig');
  const r2 = types();
  r2.visual = { ...(r2.visual || {}), [tVis2]: { visual: 'off', by: 'hatch', why: 'a worker wrote this by hand', at: new Date().toISOString(), permission: 'hatch said yes somewhere', recordedBy: 'builder-s3' } };
  w('studio/task-types.json', JSON.stringify(r2, null, 2));
  git('add studio/task-types.json');
  commitAs('visual off', ['Studio-Agent: builder-s3']);
  const gVis2 = gate(tVis2, 'Port the camera rig');
  report('2.60.1 (B-38): a visual-proof entry set by a worker\'s commit is ignored (the task still needs its result) and done-check says why',
    gVis2.status !== 0 && NEEDS.test(out(gVis2)) && /visual-proof decision is on file but doesn't count/.test(doneCheck(tVis2)), `${out(gVis2)}\n---\n${doneCheck(tVis2).slice(0, 600)}`);

  // ---- B-38 (0): evidence, once the task has commits ----
  w('studio/game.json', `${JSON.stringify({ visualPaths: ['game/toy/src/render/**'] }, null, 2)}\n`);
  w('game/toy/src/render/water.mjs', 'export const water = 1;\n');
  w('game/toy/tests/camera.test.mjs', 'export const t = 1;\n');
  w('game/toy/src/ui/fees.mjs', 'export const fee = 1;\n');
  git('add -A');
  commitAs('toy game');
  const tTest = add('Fix the camera test flake');
  w('game/toy/tests/camera.test.mjs', 'export const t = 2;\n');
  git('add -A');
  commitAs('camera test', [`Studio-Task: ${tTest}`]);
  const gTest = gate(tTest, 'Fix the camera test flake');
  const dcTest = doneCheck(tTest);
  report('2.60.1 (B-38): a render-titled task whose commits touch no render path (studio/game.json visualPaths) needs no visual result, and done-check says "no render files changed"',
    gTest.status === 0 && /no render files changed: 1 file \(game\/toy\/tests\/camera\.test\.mjs\)/.test(dcTest), `${out(gTest)}\n---\n${dcTest.slice(0, 800)}`);
  const tWater = add('Render the water foam');
  w('game/toy/src/render/water.mjs', 'export const water = 2;\n');
  git('add -A');
  commitAs('foam', [`Studio-Task: ${tWater}`]);
  const gWater = gate(tWater, 'Render the water foam');
  report('2.60.1 (B-38): a render-titled task that changes a render path still needs its visual result (the evidence never switches a real render change off)',
    gWater.status !== 0 && NEEDS.test(out(gWater)) && /it changes render files: game\/toy\/src\/render\/water\.mjs/.test(out(gWater)), out(gWater));
  const tFee = add('Tune the fee panel numbers');
  w('game/toy/src/render/water.mjs', 'export const water = 3;\n');
  w('game/toy/src/ui/fees.mjs', 'export const fee = 2;\n');
  git('add -A');
  commitAs('fees', [`Studio-Task: ${tFee}`]);
  const gFee = gate(tFee, 'Tune the fee panel numbers');
  const dcFee = doneCheck(tFee);
  const gFeeStrict = gate(tFee, 'Tune the fee panel numbers', { STUDIO_VISUAL_STRICT: 'on' });
  report('2.60.1 (B-38): a non-render title whose commits change render files gets a warning in done-check ("changes render files: …; a visual result is recommended"), not a refusal; with STUDIO_VISUAL_STRICT=on it needs the result',
    gFee.status === 0 && /WARN changes render files: game\/toy\/src\/render\/water\.mjs; a visual result is recommended/.test(dcFee) && gFeeStrict.status !== 0 && NEEDS.test(out(gFeeStrict)),
    `${out(gFee)}\n---\n${dcFee.slice(0, 800)}\n---\n${out(gFeeStrict)}`);

  // ---- B-39: the claim clock and rescues for lanes waiting to land on purpose ----
  const ev = (rows) => fs.appendFileSync(path.join(dir, '.studio/events.jsonl'), rows.map((r) => `${JSON.stringify(r)}\n`).join(''));
  const ago = (min) => new Date(Date.now() - min * 60000).toISOString();
  const tHeld = add('Lane parked in the merge chain A');
  const tQueued = add('Lane parked in the merge chain B');
  const tStuck = add('Lane that really is stuck');
  ev([
    { ts: ago(300), type: 'task.start', agent: 'builder-x', task: tHeld, msg: 'start' },
    { ts: ago(290), type: 'task.held', agent: 'opus-bot', task: tHeld, msg: 'held' },
    { ts: ago(300), type: 'task.start', agent: 'builder-y', task: tQueued, msg: 'start' },
    { ts: ago(280), type: 'task.train.queued', agent: 'builder-y', task: tQueued, msg: 'queued' },
    { ts: ago(300), type: 'task.start', agent: 'builder-z', task: tStuck, msg: 'start' },
  ]);
  const budget = (id) => { const r = run(dir, `node harness/task-budget.mjs ${id} --json`, { ...env, STUDIO_TASK_BUDGET: '' }); try { return JSON.parse(r.stdout); } catch { return { raw: out(r) }; } };
  const bH = budget(tHeld);
  const bQ = budget(tQueued);
  const bS = budget(tStuck);
  report('2.60.1 (B-39): the claim clock stops while a lane is held (task.held) or queued for the train (task.train.queued): 300 min claimed counts ~10 and ~20, not over budget',
    bH.over === false && bH.spend?.minutes <= 12 && bQ.over === false && bQ.spend?.minutes <= 22 && bQ.spend?.minutes >= 18, JSON.stringify({ bH, bQ }));
  report('2.60.1 (B-39): a lane that is neither held nor queued is still stopped by its claim clock (300 min, limit 240)',
    bS.over === true && /min claimed/.test(bS.why || ''), JSON.stringify(bS));

  // task hold: who may, and what it does.
  const tChain = add('Lane in the hand-built merge chain C');
  const rescueC = add(`Rescue: ${tChain} stuck (241 min claimed)`);
  const holdW = task(`hold ${tChain} --by builder-s3 --why "integrating it myself"`, worker);
  const holdB = task(`hold ${tChain} --by opus-bot --why "parked in merge chain 3, lands after T-099"`, outside);
  const holdsNow = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks || {}; } catch { return {}; } })();
  report('2.60.1 (B-39): task hold is refused for a worker; an outside agent (a merge conductor) holds the lane, and its waiting rescue task is closed with a note',
    holdW.status !== 0 && /Refused: a launched builder session/.test(out(holdW)) && holdB.status === 0 && holdsNow[tChain]?.held?.by === 'opus-bot' && !board().includes(rescueC) && new RegExp(`${rescueC} closed`).test(out(holdB)),
    `${out(holdW)}\n---\n${out(holdB)}\n---\n${board().slice(0, 1500)}`);

  // A rescue for a lane queued for the train can't start.
  const tTrain = add('Lane queued for the next train');
  fs.mkdirSync(path.join(dir, '.studio/train'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio/train/queue.json'), JSON.stringify([{ task: tTrain, agent: 'builder-q', branch: 'lane/builder-q', head: 'abc', at: ago(30) }]));
  const rescueT = add(`Rescue: ${tTrain} stuck (241 min claimed)`);
  const startR = task(`start ${rescueT} --agent builder-r`);
  report('2.60.1 (B-39): a rescue for a lane queued for the merge train can\'t start (no builder is sent into a lane mid-integration)',
    startR.status !== 0 && /queued for the merge train/.test(out(startR)), out(startR));

  // The watchdog's rescue pass files no rescue for a budget-parked lane that is held.
  const tPark = add('Lane held while its budget stop was pending');
  const holdsF = path.join(dir, 'studio/task-holds.json');
  const hj = (() => { try { return JSON.parse(fs.readFileSync(holdsF, 'utf8')); } catch { return { tasks: {} }; } })();
  hj.tasks[tPark] = { parked: { by: 'budget', why: `${tPark} has used its budget: 241 min claimed (limit 240)`, budget: true, at: ago(5) }, held: { by: 'opus-bot', why: 'merge chain 3', at: ago(60) } };
  fs.writeFileSync(holdsF, JSON.stringify(hj, null, 2));
  const pass = run(dir, `node --input-type=module -e "const { rescuePass } = await import(${u('harness/rescue.mjs').replace(/"/g, '\\"')}); console.log(JSON.stringify(await rescuePass({})))"`, { ...env, STUDIO_RESCUE: '' });
  report('2.60.1 (B-39): the rescue pass files no rescue for a budget-parked lane that is held for landing',
    pass.status === 0 && !new RegExp(`Rescue: ${tPark}\\b`).test(board()), `${out(pass)}\n---\n${board().slice(0, 1500)}`);

  // Landing closes the task's open rescues (task done; the watchdog's sweep for anything closed elsewhere).
  const tLand = add('Lane that lands with a rescue still open');
  const rescueL = add(`Rescue: ${tLand} stuck (241 min claimed)`);
  const landed = task(`done ${tLand} --agent hatch --force --reason "landed by hand in the merge chain"`, { STUDIO_DONE_UNCOMMITTED: 'allow' });
  const nextOnly = board().split(/^## /m).filter((s) => !/^(Done|Recently done)/i.test(s)).join('');
  report('2.60.1 (B-39): when a task lands (task done), its open rescue task is closed automatically with a note',
    !nextOnly.includes(`${rescueL} `) && !new RegExp(`\\[ \\] \\*\\*${rescueL}\\*\\*|${rescueL}.*Rescue`).test(nextOnly) && /task\.rescue\.closed/.test(fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8')),
    `${out(landed).slice(0, 800)}\n---\n${board().slice(0, 2000)}`);

  // ---- B-40: a lane copy's studio/ is main's ----
  const hookRun = (input, projectDir) => {
    const f = path.join(tmpRoot, `hook-in-2601q-${process.pid}.json`);
    fs.writeFileSync(f, JSON.stringify(input));
    const r = run(dir, `node .claude/hooks/lane-studio-guard.mjs < "${f}"`, { ...env, CLAUDE_PROJECT_DIR: projectDir });
    try { return JSON.parse(r.stdout || 'null'); } catch { return { raw: out(r) }; }
  };
  const lane = path.join(dir, '.lanes', 'builder-l');
  const deny = (d) => d?.hookSpecificOutput?.permissionDecision === 'deny';
  const hLaneCfg = hookRun({ tool_name: 'Edit', tool_input: { file_path: path.join(lane, 'studio', 'game.json'), old_string: 'a', new_string: 'b' } }, lane);
  const hLaneMain = hookRun({ tool_name: 'Write', tool_input: { file_path: path.join(dir, 'studio', 'gates.json'), content: '{}' } }, lane);
  const hLaneBoard = hookRun({ tool_name: 'Edit', tool_input: { file_path: path.join(lane, 'studio', 'rescues', 'T-001.md'), old_string: 'a', new_string: 'b' } }, lane);
  const hLaneCode = hookRun({ tool_name: 'Edit', tool_input: { file_path: path.join(lane, 'game', 'toy', 'src', 'ui', 'fees.mjs'), old_string: 'a', new_string: 'b' } }, lane);
  const hMain = hookRun({ tool_name: 'Edit', tool_input: { file_path: path.join(dir, 'studio', 'game.json'), old_string: 'a', new_string: 'b' } }, dir);
  const settings = fs.readFileSync(path.join(dir, '.claude/settings.json'), 'utf8');
  report('2.60.1 (B-40): in a lane copy the PreToolUse hook denies edits to studio config (through the link or main\'s real path) and names the route; board notes, game code and the main checkout are not affected',
    deny(hLaneCfg) && /studio\/game\.json is studio config/.test(hLaneCfg.hookSpecificOutput.permissionDecisionReason) && /hand the task back/.test(hLaneCfg.hookSpecificOutput.permissionDecisionReason) && deny(hLaneMain) && !deny(hLaneBoard) && !deny(hLaneCode) && !deny(hMain) && /Edit\|Write\|MultiEdit\|NotebookEdit[^\n]*lane-studio-guard/.test(settings),
    JSON.stringify({ hLaneCfg, hLaneMain, hLaneBoard, hLaneCode, hMain }).slice(0, 2000));

  // task done in a lane warns when main's studio config changed uncommitted while the task was worked.
  git('add -A');
  commitAs('before lane');
  const tLane = add('Lane work beside a config edit');
  const made = run(dir, `node --input-type=module -e "const { createLaneCopy } = await import(${u('harness/worktree.mjs').replace(/"/g, '\\"')}); console.log(JSON.stringify(createLaneCopy('builder-l', { task: '${tLane}' })))"`, env);
  ev([{ ts: ago(2), type: 'task.start', agent: 'builder-l', task: tLane, msg: 'start' }]);
  w('studio/game.json', `${JSON.stringify({ visualPaths: ['game/toy/src/render/**'], engines: { other: { land: 'x' } } }, null, 2)}\n`);
  fs.writeFileSync(holdsF, `${(() => { try { return fs.readFileSync(holdsF, 'utf8'); } catch { return '{"tasks":{}}'; } })()}\n`);
  const laneDone = run(lane, `node harness/task.mjs done ${tLane} --agent builder-l --check`, { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_DONE_NOOP: 'allow' });
  report('2.60.1 (B-40): task done in a lane copy warns loudly, naming studio/game.json, when main\'s studio config changed uncommitted while the task was worked (board records like task-holds.json are not named)',
    fs.existsSync(path.join(lane, 'studio')) && /WARNING: the main checkout's studio config changed while/.test(out(laneDone)) && /studio\/game\.json/.test(out(laneDone)) && !/task-holds\.json/.test(out(laneDone).split('WARNING')[1] || ''),
    `${out(made).slice(0, 400)}\n---\n${out(laneDone).slice(0, 1500)}`);
  try { run(dir, 'git worktree remove --force .lanes/builder-l', env); } catch { /* best effort */ }
}

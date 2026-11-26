/**
 * qa/selftest-299c.mjs — 2.99 (c): Play Mode focus for a mixed batch, and Play Mode time per fixture.
 * (1) paths that match play.focus.skip need no Play Mode: with the rest mapped, the stage is focus; one path no
 * entry takes sends it to full. (2) engines.<x>.play.times is read after a land run that ran the play stage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, guardCap3000Of, out } from './kit.mjs';

export async function selftest299C({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s299c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const u = fileUrlRelSOf(dir);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(T, `probe-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: dir, env: { ...clean, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 240000 });
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };

  try {
    // ---- (1) the decision ----
    const focus = { map: [{ match: '^Game/Ui/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], smoke: 'Game.PlayTests.Smoke', skip: ['^Sim/'] };
    const sel = probe(`import { playSelection } from ${u('harness/engine-rules.mjs')};
const cfg = { play: { focus: ${JSON.stringify(focus)} } };
const sims = Array.from({ length: 30 }, (_, i) => 'Sim/Fees/F' + i + '.cs');
const ui = Array.from({ length: 12 }, (_, i) => 'Game/Ui/Hangar/P' + i + '.cs');
console.log(JSON.stringify({
  mixed: playSelection({ changed: [...sims, ...ui], cfg }),
  other: playSelection({ changed: [...sims, ...ui, 'Game/Scenes/Main.unity'], cfg }),
  allSkip: playSelection({ changed: sims, cfg }),
  full: playSelection({ changed: [...sims, ...ui], cfg, full: true, fullWhy: 'a full land run' }),
}));`);
    await guard('2.99 (c1) a mixed batch of skip paths and mapped paths runs focus: the mapped entries\' filters plus smoke, and the why line names both counts (fails before this fix: the skip paths counted as unmapped and the stage ran in full)', () => [
      sel.mixed?.mode === 'focus' && sel.mixed.filter === 'Game.PlayTests.Hangar;Game.PlayTests.Smoke' && /12 changed path\(s\) mapped by play\.focus, 30 more need no Play Mode \(play\.focus\.skip\)/.test(sel.mixed.why), JSON.stringify(sel.mixed || sel)]);
    await guard('2.99 (c2) one path that matches neither skip nor a map entry sends the stage to full, and the why line names that path alone (fails before this fix: the skip paths were named as unmapped too)', () => [
      sel.other?.mode === 'full' && sel.other.unmatched?.join() === 'Game/Scenes/Main.unity' && /1 changed path\(s\) match no play\.focus\.map entry: Game\/Scenes\/Main\.unity$/.test(sel.other.why), JSON.stringify(sel.other || sel)]);
    await guard('2.99 (c3) a batch where every path matches skip is still mode skip', () => [sel.allSkip?.mode === 'skip' && sel.allSkip.filter === '', JSON.stringify(sel.allSkip || sel)]);
    await guard('2.99 (c4) a full land run never focuses, even for a mixed batch', () => [sel.full?.mode === 'full' && sel.full.why === 'a full land run', JSON.stringify(sel.full || sel)]);

    // ---- (2) Play Mode time per fixture ----
    const R = path.join(T, 'root');
    const W = path.join(T, 'work');
    const setGame = (play) => { fs.mkdirSync(path.join(R, 'studio'), { recursive: true }); fs.writeFileSync(path.join(R, 'studio', 'game.json'), JSON.stringify({ engines: { unity: { land: 'node land.mjs {branch}', target: 'port/main', play } } })); };
    const withTimes = { focus: { map: [{ match: '^Game/Ui/', filter: 'Game.PlayTests.Ui' }, { match: '^Game/Net/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }, { match: '^Game/Hud/', filter: 'Game.PlayTests.Hud' }], smoke: 'Game.PlayTests.Smoke', skip: ['^Sim/'] }, times: 'TestResults/*' };
    fs.mkdirSync(path.join(W, 'TestResults'), { recursive: true });
    fs.writeFileSync(path.join(W, 'TestResults', 'a.xml'), '<test-run><test-suite><test-case name="Opens" fullname="Game.PlayTests.Ui.PanelTests.Opens" classname="Game.PlayTests.Ui.PanelTests" duration="120.5"/><test-case name="Closes" fullname="Game.PlayTests.Ui.PanelTests.Closes(1)" classname="Game.PlayTests.Ui.PanelTests" duration="60"/><test-case name="Boot" fullname="Game.PlayTests.Smoke.BootTests.Boot" duration="30"/></test-suite></test-run>');
    fs.writeFileSync(path.join(W, 'TestResults', 'b.trx'), '<?xml version="1.0"?>\r\n<TestRun><TestDefinitions><UnitTest name="Draws" id="id-1"><Execution id="e1"/><TestMethod codeBase="x.dll" className="Game.PlayTests.Hud.DrawTests, Game.PlayTests" name="Draws"/></UnitTest></TestDefinitions><Results><UnitTestResult executionId="e1" testId="id-1" testName="Draws" duration="00:10:00.0000000" outcome="Passed"/></Results></TestRun>\r\n');
    const cliArgs = ['--paths', 'Sim/Fees/F1.cs,Game/Ui/A.cs'];
    const planOf = (extra = [], args = cliArgs) => { const r = spawnSync(process.execPath, [path.join(dir, 'harness', 'unity-train.mjs'), 'play-plan', ...args, ...extra], { windowsHide: true, cwd: dir, env: { ...clean, NODE_OPTIONS: '', STUDIO_MAIN_ROOT: R }, encoding: 'utf8', timeout: 120000 }); return out(r); };
    setGame(withTimes);
    const kept = probe(`import fs from 'node:fs'; import { recordPlayTimes, playFixtures } from ${u('harness/rules-times.mjs')};
const rec = recordPlayTimes(${JSON.stringify(R)}, 'unity', { dir: ${JSON.stringify(W)} });
console.log(JSON.stringify({ rec, fx: playFixtures(${JSON.stringify(R)}, 'unity') }));`);
    const mins = (n) => (kept.fx || []).find((x) => x.name === n)?.minutes;
    await guard('2.99 (c5) play.times is read from an NUnit file and a .trx file: minutes per fixture (class; a parameter list on a test name is dropped, a .trx class comes from its UnitTest), longest first (fails before this fix: no Play Mode time was kept)', () => [
      mins('Game.PlayTests.Ui.PanelTests') === 3.01 && mins('Game.PlayTests.Hud.DrawTests') === 10 && mins('Game.PlayTests.Smoke.BootTests') === 0.5 && kept.fx[0].name === 'Game.PlayTests.Hud.DrawTests', JSON.stringify(kept)]);
    const plan = planOf();
    await guard('2.99 (c6) play-plan prints the fixtures by minutes (10 slowest, the total), the minutes of each map entry (a template filter shows "?"), and the expected minutes of a focused plan (fails before this fix: it printed none of these)', () => [
      /: focus with the filter Game\.PlayTests\.Ui;Game\.PlayTests\.Smoke/.test(plan) && /expected Play Mode time for this plan: about 3\.5 min/.test(plan) && /3 fixtures, 13\.5 min in all/.test(plan) && /10 min {2}Game\.PlayTests\.Hud\.DrawTests/.test(plan)
        && /3 min {2}\^Game\/Ui\/ -> Game\.PlayTests\.Ui/.test(plan) && /\? {2}\^Game\/Net\/\(\[A-Za-z\]\+\)\/ -> Game\.PlayTests\.\$1/.test(plan) && /10 min {2}\^Game\/Hud\/ -> Game\.PlayTests\.Hud/.test(plan), plan.slice(-1500)]);
        const sel2 = probe(`import { playSelection } from ${u('harness/engine-rules.mjs')}; import { playFixtures } from ${u('harness/rules-times.mjs')};
console.log(JSON.stringify(playSelection({ changed: ['Sim/F.cs', 'Game/Ui/A.cs'], cfg: { play: ${JSON.stringify(withTimes)} }, fixtures: playFixtures(${JSON.stringify(R)}, 'unity') })));`);
    await guard('2.99 (c7) the land run\'s focused selection adds the expected minutes to its why line when its filter names kept fixtures', () => [
      sel2.mode === 'focus' && sel2.expectMin === 3.5 && /; about 3\.5 min expected$/.test(sel2.why), JSON.stringify(sel2)]);
    const gaps = probe(`import { proposeGroups, playCostLines } from ${u('harness/play-gaps.mjs')}; import { playFixtures } from ${u('harness/rules-times.mjs')};
const fx = playFixtures(${JSON.stringify(R)}, 'unity');
const g = proposeGroups(['Game/Hud/X.cs', 'Game/Audio/Y.cs', 'Sim/Z.cs'], { rules: { focus: { map: [{ match: '^Sim/', filter: 'Sim' }] } }, fixtures: fx });
console.log(JSON.stringify(Object.fromEntries(g.map((x) => [x.folder, x.cost]))));`);
    await guard('2.99 (c8) play-plan --propose says what it knows about the cost of each entry: the fixtures that carry the folder\'s name, none, or that a skip costs nothing', () => [
      /"Hud" in the name take 10 min \(1\)/.test(gaps['Game/Hud/']) && /no kept fixture has "Audio"/.test(gaps['Game/Audio/']) && /no Play Mode time/.test(gaps['Sim/']), JSON.stringify(gaps)]);

    // ---- no play.times: nothing changes and nothing is read ----
    const timesFile = path.join(R, '.studio', 'engine', 'unity-times.json');
    const keptBytes = fs.readFileSync(timesFile, 'utf8');
    const { times: _t, ...noTimes } = withTimes;
    setGame(noTimes);
    fs.rmSync(path.join(R, '.studio'), { recursive: true, force: true });
    fs.mkdirSync(path.dirname(timesFile), { recursive: true });
    fs.writeFileSync(timesFile, keptBytes);
    const before = fs.statSync(timesFile).mtimeMs;
    const none = probe(`import fs from 'node:fs'; import { recordPlayTimes, playFixtures } from ${u('harness/rules-times.mjs')};
const rec = recordPlayTimes(${JSON.stringify(R)}, 'unity', { dir: ${JSON.stringify(W)} });
console.log(JSON.stringify({ rec, fx: playFixtures(${JSON.stringify(R)}, 'unity') }));`);
    const planNone = planOf();
    await guard('2.99 (c9) with no play.times nothing is read or kept: no fixtures even where a times file holds some, the file is untouched, play-plan prints no time lines and the focused why line has no minutes', () => [
      none.rec === null && none.fx?.length === 0 && fs.readFileSync(timesFile, 'utf8') === keptBytes && fs.statSync(timesFile).mtimeMs === before && /focus with the filter/.test(planNone) && !/Play Mode time|expected/.test(planNone), JSON.stringify({ none, planNone: planNone.slice(-600) })]);
    const propNone = planOf(['--propose'], ['--paths', 'Game/Audio/b.cs']);
    await guard('2.99 (c10) --propose with no play.times says the cost is unknown and why', () => [/cost unknown: engines\.<x>\.play\.times is not set/.test(propNone), propNone.slice(-600)]);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}

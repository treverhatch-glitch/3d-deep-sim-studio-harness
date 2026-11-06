/**
 * qa/selftest-2791e.mjs — 2.79.1 (e): the cut. Nine old switches are gone (the default behaviour stays), and the dead
 * exports are gone.
 *   - A name a .env still sets for a removed switch is flagged unknown by `npm run studio:reload-env` (envNameReport),
 *     one that is still read is not, and the census no longer lists the removed names.
 *   - Setting a removed name changes nothing: a lane commit still gets a note for another agent's lock, a docs task
 *     with only notes changed still skips the game's checks, a game studio still replaces the stage-1 playtest, a
 *     review whose last Verdict line approves still approves, a hand-back naming an owner-only step still parks.
 * A temp studio copy of the repo and probe scripts run in it, as selftest-279t.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';

/** The switches 2.79.1 (e) removed. */
const REMOVED = ['LANE_LOCKS', 'TYPE_EVIDENCE', 'UNITY_PLAYMODE_RETRY', 'TRAIN_GREEN_FIRST', 'STAGE1_PLAYTEST', 'REVIEW_VERDICT_LINE', 'DONE_SKIP_GAME_NONCODE', 'TRAIN_LAND_OVER_NONCODE', 'OWNER_ONLY_PARK'].map((k) => `STUDIO_${k}`);

export async function selftest2791E({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const put = (S, rel, text) => { fs.mkdirSync(path.dirname(path.join(S, rel)), { recursive: true }); fs.writeFileSync(path.join(S, rel), text); };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = '';
  const base = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', CI: '', NODE_OPTIONS: '', npm_lifecycle_event: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2791e-${process.pid}.pem`) };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2791e-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'game.json'), { force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    made.push(S);
    return S;
  };
  let pn = 0;
  const probe = (S, code, env = {}, timeout = 120000) => {
    const f = path.join(S, `.probe-2791e-${++pn}.mjs`);
    fs.writeFileSync(f, `import path from 'node:path';\nconst S = ${JSON.stringify(S)};\nconst imp = (rel) => import(new URL(rel, ${JSON.stringify(pathToFileURL(S + path.sep).href)}).href);\n${code}\n`);
    const r = spawnSync(process.execPath, [f], { cwd: S, encoding: 'utf8', windowsHide: true, timeout, env: { ...process.env, ...base, ...env } });
    const last = String(r.stdout || '').trim().split('\n').pop();
    let j = null;
    try { j = JSON.parse(last); } catch {}
    return { j, out: `${r.stdout || ''}${r.stderr || ''}`.slice(-1500), status: r.status };
  };

  await guard('a .env that still sets a removed switch is flagged unknown by studio:reload-env, a name still read is not (fails on 2.79.0: all nine were still read, so none was flagged)', async () => {
    const S = studio('env');
    put(S, 'env-test', `${[...REMOVED, 'STUDIO_STALL_MIN'].map((k) => `${k}=off`).join('\n')}\n`);
    const r = probe(S, `const m = await imp('harness/env-reload.mjs'); const rep = m.envNameReport({ root: S, file: path.join(S, 'env-test') }); console.log(JSON.stringify({ unknown: rep.unknown, known: rep.known, text: m.envNameText(rep) }));`);
    const j = r.j || {};
    const ok = j.known === true && JSON.stringify([...(j.unknown || [])].sort()) === JSON.stringify([...REMOVED].sort()) && !(j.unknown || []).includes('STUDIO_STALL_MIN')
      && new RegExp(`${REMOVED[0]} +unknown \\(removed or misspelled\\)`).test(j.text || '') && !/STUDIO_STALL_MIN +unknown/.test(j.text || '');
    return [ok, r.j ? JSON.stringify({ unknown: j.unknown, known: j.known }) : r.out];
  });

  await guard('the census lists none of the removed names and is told none of them is read (fails on 2.79.0: all nine listed)', async () => {
    const r = spawnSync(process.execPath, ['scripts/settings-census.mjs', '--summary'], { cwd: dir, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...base } });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    const listed = REMOVED.filter((k) => new RegExp(`(^|\\s)${k}(\\s|$)`, 'm').test(text));
    const total = Number((text.match(/SUMMARY: (\d+) settings/) || [])[1]);
    return [r.status === 0 && Number.isFinite(total) && listed.length === 0, `total ${total}, still listed: ${listed.join(', ') || 'none'}`];
  });

  await guard('setting a removed switch to its old value changes nothing: a lane commit still gets a note for another agent\'s lock, a notes-only docs task still skips the game checks, a review whose last Verdict line approves still approves (fails on 2.79.0: LANE_LOCKS=block refused, DONE_SKIP_GAME_NONCODE=off ran the checks, REVIEW_VERDICT_LINE=off judged the whole file)', async () => {
    const S = studio('same');
    const claim = spawnSync(process.execPath, ['harness/lock.mjs', 'claim', 'path:game/x', '--owner', 'other-agent', '--wide', 'a test'], { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 60000, env: { ...process.env, ...base } });
    const r = probe(S, `
      const lock = await imp('harness/lock.mjs');
      const dc = await imp('harness/done-check.mjs');
      const laneOff = lock.checkStaged('me', { files: ['game/x/f.txt'], lane: 'lane-q', env: { ['STUDIO_' + 'LANE_LOCKS']: 'block' } });
      const laneMain = lock.checkStaged('me', { files: ['game/x/f.txt'], lane: null, env: { ['STUDIO_' + 'LANE_LOCKS']: 'block' } });
      const skip = dc.skipGameChecks('docs', ['docs/A.md', 'README.md'], { ['STUDIO_' + 'DONE_SKIP_GAME_NONCODE']: 'off' }).skip;
      const both = 'Verdict: changes requested\\n\\n## Re-review\\nFixed. Non-blocking note: rename x later.\\nVerdict: approve\\n';
      const approves = dc.reviewApproves(both, { ['STUDIO_' + 'REVIEW_VERDICT_LINE']: 'off' });
      console.log(JSON.stringify({ laneOk: laneOff.ok, laneNote: laneOff.warnings.length, mainOk: laneMain.ok, skip, approves }));`);
    const j = r.j || {};
    const ok = JSON.parse(claim.stdout || '{}').ok === true && j.laneOk === true && j.laneNote === 1 && j.mainOk === false && j.skip === true && j.approves === true;
    return [ok, r.j ? JSON.stringify(j) : `${claim.stdout} ${r.out}`];
  });

  await guard('setting a removed switch to its old value changes nothing: a game studio still replaces the stage-1 playtest, a hand-back naming an owner-only step still parks the task (fails on 2.79.0: STAGE1_PLAYTEST=on kept stage 1, OWNER_ONLY_PARK=off parked nothing)', async () => {
    const S = studio('game');
    put(S, 'game/demo/build.mjs', "console.log('build');\n");
    put(S, 'studio/game.json', `${JSON.stringify({ game: 'demo', tester: { build: 'node game/demo/build.mjs', dist: 'game/demo/dist' } }, null, 2)}\n`);
    const r = probe(S, `
      const c = await imp('harness/tester-config.mjs');
      const oo = await imp('harness/owner-only.mjs');
      const holds = await imp('harness/task-hold.mjs');
      const replaced = c.stage1Replaced(S, { ['STUDIO_' + 'STAGE1_PLAYTEST']: 'on' }).replaced;
      const parked = oo.parkIfOwnerOnly('T-901', 'Blocked: only the owner approves weakening a test.', { who: 'builder-x', env: { ['STUDIO_' + 'OWNER_ONLY_PARK']: 'off' } });
      console.log(JSON.stringify({ replaced, parked: Boolean(parked?.parked), hold: Boolean(holds.readHolds()['T-901']?.parked) }));`);
    const j = r.j || {};
    return [j.replaced === true && j.parked === true && j.hold === true, r.j ? JSON.stringify(j) : r.out];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {} }
}

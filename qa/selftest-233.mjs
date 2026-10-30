/**
 * qa/selftest-233.mjs — the 2.33.0 checks, run by qa/selftest.mjs on a copy of the repo.
 * One door to the studio's branch, agents see only their own credentials, and the false refusals the
 * Marina builders logged: a re-claim reading as "no code changed", cheap checks only after the slow
 * ones, reused task ids.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest233({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let n = 0;
  const probe = (code, env = {}, cwd = dir) => {
    const f = path.join(tmpRoot, `p233-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const gitEnv = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const sh = (cmd, env = {}, cwd = dir) => run(cwd, cmd, { ...gitEnv, ...env });

  // ---- agents see only their own tool's credentials ----
  const ae = probe(`import { agentEnv, heldBack } from ${u('harness/agent-env.mjs')};
const env = { PATH: '/bin', HOME: '/h', ANTHROPIC_API_KEY: 'a', OPENAI_API_KEY: 'o', GEMINI_API_KEY: 'g', XAI_API_KEY: 'x', HUB_TOKEN: 't', STUDIO_OWNER_KEY: 'k', STUDIO_ROLE: 'r', GH_TOKEN: 'gh', NVIDIA_API_KEY: 'n', STUDIO_BUILDER_ENV: 'GH_TOKEN' };
console.log(JSON.stringify({
  claudeBuilder: Object.keys(agentEnv({ tool: 'claude', role: 'builder', env })).sort(),
  geminiCustom: Object.keys(agentEnv({ tool: 'custom', model: 'gemini-3.1-pro-preview', role: 'producer', env })).sort(),
  full: Object.keys(agentEnv({ tool: 'claude', env: { ...env, STUDIO_AGENT_ENV: 'full' } })).length,
  held: heldBack({ tool: 'grok', role: 'producer', env }).sort(),
}));`);
  report('2.33.0: a launched agent gets its own tool\'s key and the studio settings, never other providers\' keys, HUB_TOKEN or the owner key; a role can be given more by name', JSON.stringify(ae.claudeBuilder) === JSON.stringify(['ANTHROPIC_API_KEY', 'GH_TOKEN', 'HOME', 'PATH', 'STUDIO_BUILDER_ENV', 'STUDIO_ROLE']) && ae.geminiCustom?.includes('GEMINI_API_KEY') && !ae.geminiCustom.includes('ANTHROPIC_API_KEY') && ae.held?.includes('HUB_TOKEN') && ae.held.includes('STUDIO_OWNER_KEY') && ae.held.includes('ANTHROPIC_API_KEY') && !ae.held.includes('XAI_API_KEY') && ae.full === 13, JSON.stringify(ae));

  // ---- the guard hook never lets an agent read keys ----
  const gh = probe(`import { decide } from ${u('.claude/hooks/guard-paths.mjs')};
const t = [['Read', { file_path: '/r/.env' }], ['Bash', { command: 'cat .env | grep KEY' }], ['Bash', { command: 'cp ~/.studio-owner/owner-ed25519.pem /tmp/k' }], ['Read', { file_path: '.studio/keys/studio-ed25519.pem' }], ['Read', { file_path: '/r/.env.example' }], ['Read', { file_path: 'harness/env.mjs' }]];
console.log(JSON.stringify(t.map(([tool, i]) => Boolean(decide(tool, i)))));`);
  report('2.33.0: the guard hook refuses reads of .env and key files (Read and shell readers), and still allows .env.example', JSON.stringify(gh) === JSON.stringify([true, true, true, true, false, false]), JSON.stringify(gh));

  // ---- task ids are never reused ----
  const env = { STUDIO_BREAKER: 'off', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off' };
  const add1 = sh('node harness/task.mjs add "Id probe one: a task that gets dropped" --role builder', env);
  const id1 = (out(add1).match(/T-\d+/) || [])[0];
  const next = path.join(dir, 'studio', 'NEXT.md');
  fs.writeFileSync(next, fs.readFileSync(next, 'utf8').split('\n').filter((l) => !l.includes(`${id1}`)).join('\n'));
  const add2 = sh('node harness/task.mjs add "Id probe two: added after the drop" --role builder', env);
  const id2 = (out(add2).match(/T-\d+/) || [])[0];
  report('2.33.0: a task dropped from the board never gives its id to the next task (the id comes from everything ever issued)', Boolean(id1) && Boolean(id2) && Number(id2.slice(2)) > Number(id1.slice(2)), `${id1} then ${id2}\n${out(add1)}\n${out(add2)}`);

  // ---- a re-claim keeps the task's baseline; --check stops before the game gates ----
  sh('git init -q -b main && git add -A && git commit -qm base');
  const add3 = sh('node harness/task.mjs add "Reclaim probe: change the example economy" --role builder', env);
  const id3 = (out(add3).match(/T-\d+/) || [])[0];
  sh(`node harness/task.mjs start ${id3} --agent builder-r1`, env);
  const idx = path.join(dir, 'cartridges', 'example-sim', 'index.mjs');
  fs.writeFileSync(idx, `${fs.readFileSync(idx, 'utf8')}\n// reclaim probe change\n`);
  sh(`git add -A && git commit -qm "${id3}: the change"`);
  sh(`node harness/task.mjs pause ${id3} --agent builder-r1 --note "handing over for the night"`, env);
  sh(`node harness/task.mjs start ${id3} --agent builder-r2`, env);
  const pre = sh(`node harness/task.mjs done ${id3} --agent builder-r2 --check`, { ...env, STUDIO_VISUAL_GATE: 'off' });
  report('2.33.0: after a hand-back and re-claim, the earlier agent\'s committed change still counts (no false "no code changed"); task done --check names verify as the next step and runs no game check', pre.status === 0 && /every quick check passes/.test(out(pre)) && /npm run verify/.test(out(pre)) && !/no code changed/.test(out(pre)) && !/\[game-gates\]/.test(out(pre)), out(pre));
  const add4 = sh('node harness/task.mjs add "Nochange probe: a build task with no change" --role builder', env);
  const id4 = (out(add4).match(/T-\d+/) || [])[0];
  sh(`node harness/task.mjs start ${id4} --agent builder-r3`, env);
  const none = sh(`node harness/task.mjs done ${id4} --agent builder-r3 --check`, { ...env, STUDIO_VISUAL_GATE: 'off' });
  report('2.33.0: task done --check still refuses a build task that changed nothing, in seconds', none.status !== 0 && /no code changed/.test(out(none)), out(none));

  // ---- one door: no game commits on the main checkout while the studio works in lanes ----
  sh('git config core.hooksPath scripts/hooks');
  sh('git worktree add -q -b lane/builder-d1 .lanes/builder-d1 main');
  const lane = path.join(dir, '.lanes', 'builder-d1');
  fs.appendFileSync(idx, '// straight on main\n');
  const onMain = sh('git add cartridges/example-sim/index.mjs && git commit -qm "outside builder on main"', {});
  sh('git reset -q && git checkout -q -- cartridges/example-sim/index.mjs');
  fs.appendFileSync(path.join(dir, 'studio', 'harness-notes', 'NOTES.md'), '\n- [probe] a Director note\n');
  const notes = sh('git add studio/harness-notes/NOTES.md && git commit -qm "director notes"', {});
  const lidx = path.join(lane, 'cartridges', 'example-sim', 'index.mjs');
  fs.appendFileSync(lidx, '// in the lane\n');
  const inLane = sh('git add -A && git commit -qm "lane work"', {}, lane);
  report('2.33.0: with lanes in use, a game commit straight on the main checkout is refused; studio notes there and commits in a lane are not', onMain.status !== 0 && /works in lanes/.test(out(onMain)) && notes.status === 0 && inLane.status === 0, [onMain, notes, inLane].map(out).join('\n---\n').slice(0, 2500));
}

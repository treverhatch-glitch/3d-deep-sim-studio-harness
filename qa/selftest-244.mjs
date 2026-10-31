/**
 * qa/selftest-244.mjs — the 2.44.0 checks: sync an adopted game from its own repo, related tests only in a lane's
 * verify, and a failed game check run once more before it counts.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest244({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const evFile = path.join(dir, '.studio', 'events-244.jsonl');
  const env = { AGENT_EVENTS_FILE: evFile, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0' };

  // 1. Sync: a game adopted from its repo; the repo moves on; the studio's own change is exported, then synced.
  const src = path.join(tmpRoot, `harbour-244-${process.pid}`);
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  const w = (rel, t) => fs.writeFileSync(path.join(src, rel), t);
  w('package.json', JSON.stringify({ name: 'harbour', scripts: { test: 'vitest run' }, devDependencies: { vitest: '^5.0.0' } }, null, 2));
  w('src/boats.ts', 'export const boats = 1;\n');
  w('src/docks.ts', 'export const docks = 1;\n');
  g(src, 'init', '-q', '-b', 'main');
  g(src, 'add', '-A');
  g(src, 'commit', '-qm', 'start');
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'studio', '--no-verify');
  const ad = run(dir, `node scripts/onboard-game.mjs --path "${src}" --name Harbour --adopt`, env);
  const man = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'game/harbour/studio.gates.json'), 'utf8')); } catch { return {}; } })();
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'adopt', '--no-verify');
  fs.appendFileSync(path.join(dir, 'game/harbour/src/docks.ts'), 'export const piers = 2; // studio\n');
  g(dir, 'commit', '-qam', 'studio work', '--no-verify');
  w('src/boats.ts', 'export const boats = 3; // upstream\n');
  g(src, 'commit', '-qam', 'upstream work');
  const refused = run(dir, 'node scripts/onboard-game.mjs --sync', env);
  run(dir, 'node scripts/onboard-game.mjs --export', env);
  const synced = run(dir, 'node scripts/onboard-game.mjs --sync', env);
  const origin = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/game/ORIGIN.json'), 'utf8')); } catch { return {}; } })();
  const upstreamSha = g(src, 'rev-parse', 'HEAD').stdout.trim();
  const after = run(dir, 'node scripts/onboard-game.mjs --export', env);
  const again = run(dir, 'node scripts/onboard-game.mjs --sync', env);
  report('2.44.0: onboard --adopt gives a Vitest game\'s test check a related-tests command', /vitest related --run --passWithNoTests \{files\}/.test(man.gates?.find((x) => x.id === 'test')?.related || ''), `${out(ad)}\n${JSON.stringify(man)}`);
  report('2.44.0: onboard --sync refuses while the studio has unexported changes to the game; after an export it brings the game repo\'s new commits in as one commit, keeping the studio\'s change; then nothing to export and up to date', refused.status !== 0 && /haven't been sent back yet .*studio work/.test(out(refused)) && synced.status === 0 && /synced 1 commit\(s\)/.test(out(synced)) && /, committed/.test(out(synced)) && /boats = 3; \/\/ upstream/.test(fs.readFileSync(path.join(dir, 'game/harbour/src/boats.ts'), 'utf8')) && /piers = 2; \/\/ studio/.test(fs.readFileSync(path.join(dir, 'game/harbour/src/docks.ts'), 'utf8')) && origin.sha === upstreamSha && /nothing to export/.test(out(after)) && /up to date/.test(out(again)), `${out(refused)}\n---\n${out(synced)}\n---\n${out(after)}\n---\n${out(again)}`);

  // 1b. Adopting cleared the template's example controls list, and the controls check waits with a note.
  const cl = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/controls.json'), 'utf8')); } catch { return {}; } })();
  const cc = run(dir, 'node qa/controls-check.mjs', env);
  report('2.44.0: adopting clears the template\'s example controls list (it was testing the wrong game); until the real list is written, the controls check is a note for an adopted game, not a permanent red', Array.isArray(cl.controls) && cl.controls.length === 0 && /cleared the template's example controls list/.test(out(ad)) && cc.status === 0 && /Harbour was adopted and its Game Bible has no controls list yet/.test(out(cc)) && /write the Game Bible's controls list for Harbour/.test(fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8')), `${out(ad)}\n${out(cc)}\n${JSON.stringify(cl)}`);

  // 1c. Docs inside the game name the game's own scripts; what is missing there is a note, not a failure.
  fs.writeFileSync(path.join(dir, 'game/harbour/HOWTO.md'), 'Run `npm run test` before a PR. Old: `npm run nope-gone`.\n');
  const d1 = run(dir, 'node scripts/check-docs.mjs', env);
  fs.writeFileSync(path.join(dir, 'docs/ZZ-244.md'), 'Run `npm run nope-studio`.\n');
  const d2 = run(dir, 'node scripts/check-docs.mjs', env);
  fs.rmSync(path.join(dir, 'docs/ZZ-244.md'));
  report('2.44.0: the docs check reads a game\'s own Markdown against the game\'s own package.json (its `npm run test` passes); a command missing there is a note, while one missing from the studio\'s docs still fails', d1.status === 0 && /note: 1 command\(s\) in a game's own docs/.test(out(d1)) && /nope-gone/.test(out(d1)) && !/HOWTO\.md:1 npm run test /.test(out(d1)) && d2.status !== 0 && /ZZ-244\.md:1 npm run nope-studio/.test(out(d2)), `${out(d1)}\n---\n${out(d2)}`);

  // 2. Related tests: a gate whose full command fails and whose related command passes, so a pass means related ran.
  fs.writeFileSync(path.join(dir, 'game/harbour/studio.gates.json'), JSON.stringify({
    shared: ['game/harbour/package.json'],
    gates: [{ id: 'test', command: 'node -e "console.log(\'FULL SUITE\'); process.exit(1)"', related: 'node -e "console.log(\'RELATED \' + process.argv.slice(1).join(\' \'))" {files}', paths: ['game/harbour/**'] }],
  }));
  const gg = (changed, e = {}) => run(dir, `node harness/game-gates.mjs --changed ${changed}`, { ...env, ...e });
  const rel = gg('game/harbour/src/docks.ts', { STUDIO_GATE_RELATED: 'on' });
  const viaWhole = gg('game/harbour/src/docks.ts', { STUDIO_WHOLE_GAME: 'on' });
  const off = gg('game/harbour/src/docks.ts');
  const data = gg('game/harbour/src/docks.ts,game/harbour/levels.json', { STUDIO_GATE_RELATED: 'on' });
  const shared = gg('game/harbour/src/docks.ts,game/harbour/package.json', { STUDIO_GATE_RELATED: 'on' });
  report('2.44.0: with the whole suite running after landing (STUDIO_WHOLE_GAME=on) or STUDIO_GATE_RELATED=on, a lane\'s code change runs only the related tests; a data file, a shared file or the setting off runs the whole suite', rel.status === 0 && /only the tests related to the 1 changed file/.test(out(rel)) && viaWhole.status === 0 && /only the tests related to the 1 changed file/.test(out(viaWhole)) && off.status !== 0 && !/only the tests related/.test(out(off)) && data.status !== 0 && !/only the tests related/.test(out(data)) && shared.status !== 0 && /is shared: every gate runs/.test(out(shared)) && !/only the tests related/.test(out(shared)), [rel, viaWhole, off, data, shared].map(out).join('\n---\n'));

  // 3. Retry once: fails the first time, passes the second.
  const counter = path.join(tmpRoot, `count-244-${process.pid}`);
  fs.writeFileSync(path.join(dir, 'game/harbour/studio.gates.json'), JSON.stringify({ gates: [{ id: 'test', command: `node -e "const f=${JSON.stringify(counter).replace(/"/g, '\\"')};const fs=require('fs');const n=fs.existsSync(f)?+fs.readFileSync(f,'utf8'):0;fs.writeFileSync(f,String(n+1));if(n%2===0){console.log('FAIL longRun: timed out');process.exit(1)}console.log('ok')"`, paths: ['game/harbour/**'] }] }));
  fs.rmSync(counter, { force: true });
  const noRetry = run(dir, 'node harness/game-gates.mjs', env);
  fs.rmSync(counter, { force: true });
  const retry = run(dir, 'node harness/game-gates.mjs', { ...env, STUDIO_GAME_GATE_RETRY: 'on' });
  const ev = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8') : '';
  report('2.44.0: with STUDIO_GAME_GATE_RETRY=on a game check that fails once and passes when run again counts as a pass, logged as flaky (gate.flaky); off by default it fails', noRetry.status !== 0 && retry.status === 0 && /WARN game:test failed, then passed when run again \(flaky: FAIL longRun: timed out\)/.test(out(retry)) && /gate\.flaky/.test(ev), `${out(noRetry)}\n---\n${out(retry)}`);
}

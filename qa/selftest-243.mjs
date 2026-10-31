/**
 * qa/selftest-243.mjs — the 2.43.0 checks: adopting a game that already exists, and what that test on a real
 * half-built game turned up (harness/adopt.mjs, scripts/onboard-game.mjs, scripts/secret-scan.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest243({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const env = { AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-243.jsonl'), STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off' };

  // 1. Secrets: "AKIA" + 16 capitals inside a run of base64 is encoded data; the same standing alone is a key.
  const sd = path.join(tmpRoot, `secrets-243-${process.pid}`);
  fs.mkdirSync(sd, { recursive: true });
  const blob = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB' + 'AKIAQWERTYUIOPASDFGH' + 'CAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==';
  fs.writeFileSync(path.join(sd, 'pack.json'), JSON.stringify({ png: blob }));
  const s1 = run(dir, `node scripts/secret-scan.mjs "${sd}"`);
  fs.writeFileSync(path.join(sd, 'keys.txt'), 'aws_access_key_id = "AKIAQWERTYUIOPASDFGH"\n');
  const s2 = run(dir, `node scripts/secret-scan.mjs "${sd}"`);
  report('2.43.0: the secret scan skips a key-shaped piece of base64 data (a real game\'s image pack tripped it) and still catches the same key standing alone', s1.status === 0 && s2.status !== 0 && /keys\.txt:1/.test(out(s2)) && !/pack\.json/.test(out(s2)), `${out(s1)}\n---\n${out(s2)}`);

  // 2. A small existing game: its docs name trunk `develop`; `main` is checked out and older.
  const src = path.join(tmpRoot, `mygame-243-${process.pid}`);
  fs.mkdirSync(path.join(src, 'docs'), { recursive: true });
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  const w = (rel, t) => fs.writeFileSync(path.join(src, rel), t);
  w('package.json', JSON.stringify({ name: 'mygame', scripts: { dev: 'vite', test: 'vitest run', lint: 'oxlint', build: 'vite build' }, devDependencies: { three: '^0.180.0', vitest: '^5.0.0' } }, null, 2));
  w('tsconfig.json', '{ "compilerOptions": { "strict": true } }\n');
  w('CLAUDE.md', '# My Game\n\n- Trunk (integration) branch: `develop`. All PRs target `develop`.\n');
  w('DESIGN.md', '# Design\n\nYou run a harbour.\n');
  w('docs/VISION.md', '# Vision\n\nBoats, docks, money.\n');
  w('index.html', '<script type="module" src="/src/main.ts"></script>\n');
  w('src/main.ts', 'export const x = 1;\n');
  g(src, 'init', '-q', '-b', 'main');
  g(src, 'add', '-A');
  g(src, 'commit', '-qm', 'start');
  g(src, 'switch', '-q', '-c', 'develop');
  w('src/main.ts', 'export const x = 2; // only on develop\n');
  g(src, 'commit', '-qam', 'develop work');
  g(src, 'switch', '-q', 'main');

  // The studio copy is a git repo (export reads its commits).
  g(dir, 'init', '-q', '-b', 'main');
  g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'studio', '--no-verify');
  const dry = run(dir, `node scripts/onboard-game.mjs --path "${src}" --name "My Game" --adopt --dry-run`, env);
  report('2.43.0: onboard --adopt --dry-run lists the checks it would declare from the game\'s scripts and says when the game\'s own docs name another branch than the one checked out', dry.status === 0 && /--adopt would copy/.test(out(dry)) && /typecheck: cd game\/my-game && npx tsc --noEmit/.test(out(dry)) && /test: cd game\/my-game && npm run test --silent/.test(out(dry)) && /lint \(optional\)/.test(out(dry)) && /CLAUDE\.md says work goes to `develop` \(pass --ref develop/.test(out(dry)) && !fs.existsSync(path.join(dir, 'game', 'my-game')), out(dry));

  const ad = run(dir, `node scripts/onboard-game.mjs --path "${src}" --name "My Game" --adopt --ref develop`, env);
  const origin = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/game/ORIGIN.json'), 'utf8')); } catch { return null; } })();
  const man = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'game/my-game/studio.gates.json'), 'utf8')); } catch { return null; } })();
  const board = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  const bible = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/bible/bible.json'), 'utf8')); } catch { return {}; } })();
  const sg = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/game.json'), 'utf8')); } catch { return {}; } })();
  report('2.43.0: onboard --adopt --ref copies that branch\'s tracked files into game/<slug>/, records where it came from, makes it the studio\'s game, declares its own checks, and starts the Bible as an existing game', ad.status === 0 && /only on develop/.test(fs.readFileSync(path.join(dir, 'game/my-game/src/main.ts'), 'utf8')) && !fs.existsSync(path.join(dir, 'game/my-game/.git')) && origin?.ref === 'develop' && /^[0-9a-f]{40}$/.test(origin?.sha || '') && sg.game === 'my-game' && JSON.stringify(man?.gates?.map((x) => x.id)) === '["typecheck","test","lint","build"]' && man.gates.find((x) => x.id === 'lint').required === false && bible.answers?.origin === 'existing', `${out(ad)}\n${JSON.stringify({ origin, man, sg, bibleOrigin: bible.answers?.origin })}`);
  report('2.43.0: a game with design docs gets "draft the Game Bible from its own design docs" (each answer naming its source) and a person\'s check-and-sign, not a blank intake; the checks review names its manifest', /Docs: draft the Game Bible for My Game from its own design docs \([^)]*DESIGN\.md/.test(board) && /Check and sign the Game Bible for My Game, drafted from its docs/.test(board) && !/Answer the game intake for My Game/.test(board) && /Review: the checks game\/my-game\/studio\.gates\.json declares/.test(board), board.split('\n').filter((l) => /My Game/.test(l)).join('\n'));

  // 3. Export: a committed change to the adopted game comes back as a patch that applies to the source at the
  // adopted commit, without the studio-only manifest.
  g(dir, 'add', '-A');
  g(dir, 'commit', '-qm', 'adopt My Game', '--no-verify');
  fs.appendFileSync(path.join(dir, 'game/my-game/src/main.ts'), 'export const y = 3; // made in the studio\n');
  fs.appendFileSync(path.join(dir, 'game/my-game/studio.gates.json'), '\n');
  g(dir, 'commit', '-qam', 'studio work', '--no-verify');
  const ex = run(dir, 'node scripts/onboard-game.mjs --export', env);
  const patch = (out(ex).match(/patch: (studio\/game\/export-[\w-]+\.patch)/) || [])[1];
  const text = patch ? fs.readFileSync(path.join(dir, patch), 'utf8') : '';
  g(src, 'switch', '-q', '-c', 'studio/export', origin?.sha || 'develop');
  const check = patch ? spawnSync('git', ['apply', '--check', path.join(dir, patch)], { cwd: src, encoding: 'utf8' }) : { status: 1 };
  report('2.43.0: onboard --export writes the studio\'s committed changes to the adopted game as one patch, relative to the game\'s own repo and without studio.gates.json, that applies on a branch from the adopted commit', ex.status === 0 && /1 file\(s\) changed in game\/my-game/.test(out(ex)) && /a\/src\/main\.ts/.test(text) && !/studio\.gates\.json/.test(text) && check.status === 0 && /git switch -c studio\/export-/.test(out(ex)), `${out(ex)}\n${text}\n${check.stderr || ''}`);

  // 4. Pre-production for an existing game starts from its art and its build; an exact duplicate add returns the task.
  const p = path.join(tmpRoot, `p243-${process.pid}.mjs`);
  fs.writeFileSync(p, `import { queuePreproduction } from ${u('harness/intake.mjs')};
import { readBible, writeBible } from ${u('harness/bible.mjs')};
import { addTask } from ${u('harness/task.mjs')};
const b = readBible(); b.preproQueued = null; writeBible(b);
const added = queuePreproduction(readBible());
const one = addTask({ title: 'Docs: a note about the harbour lights', role: 'producer', agent: 'producer' });
const two = addTask({ title: 'Docs:  a note about the harbour lights ', role: 'producer', agent: 'producer' });
console.log(JSON.stringify({ titles: added.map((t) => t.title), one: one.id, two }));`);
  const r = run(dir, `node "${p}"`, env);
  let j = {};
  try { j = JSON.parse(r.stdout.trim().split('\n').pop()); } catch {}
  // 5. task done reuses this agent's own green verify on the exact commit (opt-in); otherwise it runs the game's
  // checks (here they fail: the adopted game's packages aren't installed).
  if (j.one) {
    const denv = { ...env, STUDIO_LOCK_OWNER: 'builder-r', STUDIO_VISUAL_GATE: 'off', STUDIO_DONE_NOOP: 'allow' };
    run(dir, `node harness/task.mjs start ${j.one} --agent builder-r`, denv);
    fs.appendFileSync(path.join(dir, 'game/my-game/docs/VISION.md'), '\nHarbour lights at dusk.\n');
    g(dir, 'add', '-A', 'game');
    g(dir, 'commit', '-qm', `lights\n\nStudio-Task: ${j.one}`, '--no-verify');
    const head = g(dir, 'rev-parse', 'HEAD').stdout.trim();
    fs.mkdirSync(path.join(dir, '.studio', 'gates'), { recursive: true });
    const plant = (h) => fs.writeFileSync(path.join(dir, '.studio', 'gates', 'builder-r-full.json'), JSON.stringify({ at: new Date(Date.now() + 1000).toISOString(), head: h, dirty: false, partial: false, scope: 'full', rows: [{ id: 'game', ok: true, required: true }, { id: 'secrets', ok: true, required: true }] }));
    plant(head);
    const off = run(dir, `node harness/task.mjs done ${j.one} --agent builder-r`, denv);
    plant('0'.repeat(40));
    const stale = run(dir, `node harness/task.mjs done ${j.one} --agent builder-r`, { ...denv, STUDIO_DONE_REUSE_VERIFY: 'on' });
    plant(head);
    const on = run(dir, `node harness/task.mjs done ${j.one} --agent builder-r`, { ...denv, STUDIO_DONE_REUSE_VERIFY: 'on' });
    report('2.43.0: with STUDIO_DONE_REUSE_VERIFY=on, task done reuses the agent\'s own green verify on this exact commit instead of running the game\'s checks again; without it, or with a verify from another commit, they run (and here fail)', off.status !== 0 && /the game's checks fail/.test(out(off)) && stale.status !== 0 && /the game's checks fail/.test(out(stale)) && on.status === 0 && /not run again \(STUDIO_DONE_REUSE_VERIFY\)/.test(out(on)) && /"status": "done"/.test(out(on)), `${out(off).slice(-600)}\n---\n${out(stale).slice(-600)}\n---\n${out(on).slice(-1200)}`);
  }
  report('2.43.0: pre-production for an existing game asks for a style sheet from its existing art and storyboards from its current build (no placeholder art); adding the same title again returns the open task instead of a duplicate', (j.titles || []).some((t) => /style sheet from My Game's existing art/.test(t)) && !(j.titles || []).some((t) => /placeholder/.test(t)) && (j.titles || []).some((t) => /from the current build and its design docs/.test(t)) && j.two?.duplicate === true && j.two.id === j.one, out(r));
}

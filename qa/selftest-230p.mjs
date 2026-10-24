/**
 * qa/selftest-230p.mjs — the 2.30p checks, run by qa/selftest.mjs on a copy of the repo.
 * Path-scoped game gates (skips logged, old manifests unchanged), lane verify results reused after a
 * rebase that only brings in another track's files, the short land lock, and a board write that never
 * overwrites tasks queued while a done was running its gates.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest230p({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const w = (rel, text, mode) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); if (mode) fs.chmodSync(path.join(dir, rel), mode); };
  const probe = (code, env = {}, cwd = dir) => {
    const f = path.join(tmpRoot, `p230p-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(cwd, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  const base = { STUDIO_LOCK_OWNER: 'builder-p1', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_DONE_NOOP: 'allow', STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG_LAUNCH: 'off', STUDIO_GAMEDEV_WAKE_DIRECTOR: 'off', STUDIO_DEV_CYCLE_WAKE: 'off', STUDIO_VISUAL_GATE: 'off' };

  // 1. Gate selection.
  const sel = probe(`import { selectGates, matchAny, scopeOf } from ${u('harness/merge-lane.mjs')};
const gates = [{ id: 'web-a', paths: ['web/**', 'tools/web/**'], track: 'web' }, { id: 'web-b', paths: ['web/**'], track: 'web' }, { id: 'eng', paths: ['godot/**'], track: 'engine' }];
const ids = (r) => r.run.map((g) => g.id);
console.log(JSON.stringify({
  eng: selectGates(gates, ['godot/game/water.gd', 'godot/game/water.gdshader']),
  web: ids(selectGates(gates, ['web/game/sim/x.mjs'])),
  shared: ids(selectGates(gates, ['godot/a.gd', 'shared/rules.json'], { shared: ['shared/**'] })),
  harness: ids(selectGates(gates, ['harness/task.mjs'])),
  none: ids(selectGates(gates, null)),
  old: ids(selectGates([{ id: 'legacy' }, ...gates], ['godot/a.gd'])),
  glob: [matchAny('web/a/b.js', ['web']), matchAny('webx/a.js', ['web']), matchAny('tools/web/x.mjs', ['tools/*/x.mjs'])],
  scope: scopeOf([gates[2]]), scopeAll: scopeOf([{ id: 'legacy' }]),
}));`);
  report('2.30p: an engine-only change runs only the engine-track gate; the others are skipped with a reason', JSON.stringify(sel.eng?.run?.map((g) => g.id)) === '["eng"]' && sel.eng.skipped.length === 2 && /none of the 2 changed file/.test(sel.eng.skipped[0].why), JSON.stringify(sel.eng || sel));
  report('2.30p: a browser change runs the browser gates; a shared or harness path runs all; no diff runs all', JSON.stringify(sel.web) === '["web-a","web-b"]' && sel.shared?.length === 3 && sel.harness?.length === 3 && sel.none?.length === 3, JSON.stringify(sel));
  report('2.30p: a gate with no paths always runs (old manifests unchanged); globs match folders, not prefixes', sel.old?.includes('legacy') && sel.old.includes('eng') && !sel.old.includes('web-a') && JSON.stringify(sel.glob) === '[true,false,true]' && sel.scopeAll === null && sel.scope?.includes('godot/**'), JSON.stringify(sel));

  // 2. game-gates.mjs with a manifest that declares paths and tracks.
  w('web/zz-two/index.html', '<!doctype html>\n');
  w('web/zz-two/studio.gates.json', JSON.stringify({ shared: ['shared/**'], gates: [
    { id: 'web-play', command: 'node -e "require(\'fs\').appendFileSync(\'zz-ran.txt\',\'web \')"', paths: ['web/zz-two/**'], track: 'web' },
    { id: 'engine-check', command: 'node -e "require(\'fs\').appendFileSync(\'zz-ran.txt\',\'engine \')"', paths: ['godot/**'], track: 'engine' },
  ] }));
  const genv = { ...base, STUDIO_GAME: 'zz-two' };
  const ran = () => { const f = path.join(dir, 'zz-ran.txt'); const t = fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim() : ''; fs.rmSync(f, { force: true }); return t; };
  const g1 = run(dir, 'node harness/game-gates.mjs --changed godot/zz/water.gd', genv);
  const r1 = ran();
  const g2 = run(dir, 'node harness/game-gates.mjs', genv);
  const r2 = ran();
  const g3 = run(dir, 'node harness/game-gates.mjs --json', { ...genv, STUDIO_GATE_CHANGED: 'web/zz-two/sim/a.mjs' });
  const r3 = ran();
  let j3 = {};
  try { j3 = JSON.parse(g3.stdout.trim().split('\n').pop()); } catch {}
  report('2.30p: game-gates --changed runs only the gates whose paths the diff touches and logs SKIP with the reason', g1.status === 0 && r1 === 'engine' && /SKIP game:web-play: none of the 1 changed file/.test(out(g1)) && /track web/.test(out(g1)), `${r1} | ${out(g1)}`);
  report('2.30p: without a diff every gate runs; STUDIO_GATE_CHANGED scopes too and the JSON lists skipped gates and the scope', g2.status === 0 && r2 === 'web engine' && r3 === 'web' && j3.skipped?.[0]?.id === 'game:engine-check' && j3.scope?.includes('web/zz-two/**') && !j3.scope.includes('godot/**'), `${r2} | ${r3} | ${g3.stdout.slice(-600)}`);

  // 3. Reuse decision.
  const ru = probe(`import { canReuse } from ${u('harness/merge-lane.mjs')};
const rec = { head: 'abc', scope: ['godot/**', 'harness/**'] };
console.log(JSON.stringify({
  other: canReuse(rec, { head: 'abc', incoming: ['web/g/a.js', 'web/g/b.js'] }),
  mine: canReuse(rec, { head: 'abc', incoming: ['godot/x/y.gd'] }),
  harness: canReuse(rec, { head: 'abc', incoming: ['harness/task.mjs'] }),
  moved: canReuse(rec, { head: 'def', incoming: ['web/a.js'] }),
  unscoped: canReuse({ head: 'abc', scope: null }, { head: 'abc', incoming: ['web/a.js'] }),
  none: canReuse(null, { head: 'abc', incoming: [] }),
}));`);
  report('2.30p: a recorded pass is reused only when the incoming files are all outside its scope and it was for this commit', ru.other?.ok && !ru.mine?.ok && !ru.harness?.ok && !ru.moved?.ok && !ru.unscoped?.ok && !ru.none?.ok, JSON.stringify(ru));

  // 4. The land lock serializes concurrent critical sections and breaks a dead holder's lock.
  const counter = path.join(tmpRoot, `p230p-counter-${process.pid}.txt`);
  fs.writeFileSync(counter, '0');
  const worker = path.join(tmpRoot, `p230p-lockw-${process.pid}.mjs`);
  fs.writeFileSync(worker, `import fs from 'node:fs'; import { withLandLock } from ${u('harness/merge-lane.mjs')};
for (let i = 0; i < 5; i++) withLandLock(${JSON.stringify(dir)}, () => { const v = Number(fs.readFileSync(${JSON.stringify(counter)}, 'utf8')); Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 15); fs.writeFileSync(${JSON.stringify(counter)}, String(v + 1)); });`);
  const spawnP = (cmd, env = {}) => new Promise((resolve) => { const c = spawn(cmd, { cwd: dir, shell: true, env: { ...process.env, ...env } }); let s = ''; c.stdout.on('data', (d) => (s += d)); c.stderr.on('data', (d) => (s += d)); c.on('close', (status) => resolve({ status, out: s })); });
  const ws = await Promise.all([1, 2, 3, 4].map(() => spawnP(`node "${worker}"`)));
  const total = Number(fs.readFileSync(counter, 'utf8'));
  fs.mkdirSync(path.join(dir, '.studio', 'locks'), { recursive: true });
  fs.writeFileSync(path.join(dir, '.studio', 'locks', 'land.lock'), JSON.stringify({ pid: 999999, at: Date.now() }));
  const dead = probe(`import { withLandLock } from ${u('harness/merge-lane.mjs')}; const t = Date.now(); const v = withLandLock(${JSON.stringify(dir)}, () => 'ran', { waitMs: 3000 }); console.log(JSON.stringify({ v, ms: Date.now() - t }));`);
  report('2.30p: 4 processes x 5 read-modify-writes under the land lock lose no update; a dead holder\'s lock is broken', total === 20 && ws.every((x) => x.status === 0) && dead.v === 'ran' && dead.ms < 2000, `total=${total} ${ws.map((x) => x.out).join('')} ${JSON.stringify(dead)}`);

  // 5. Concurrent done and board write: tasks queued while a done is running its gates survive.
  w('web/zz-slow/index.html', '<!doctype html>\n');
  w('web/zz-slow/studio.gates.json', JSON.stringify({ gates: [{ id: 'slow', command: 'node -e "setTimeout(()=>{},2500)"' }] }));
  const senv = { ...base, STUDIO_GAME: 'zz-slow' };
  const add = run(dir, 'node harness/task.mjs add "Coordinate the dock notes" --role producer --origin dev --asked "test"', senv);
  const id = (out(add).match(/T-\d+/) || [])[0];
  run(dir, `node harness/task.mjs start ${id} --agent builder-p1`, senv);
  const doneP = spawnP(`node harness/task.mjs done ${id} --agent builder-p1`, { ...senv, STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: '' });
  await new Promise((r) => setTimeout(r, 900));
  const adds = [];
  for (const t of ['Queued mid-done one', 'Queued mid-done two', 'Queued mid-done three']) adds.push(run(dir, `node harness/task.mjs add "${t}" --role producer --origin dev --asked "test"`, senv));
  const d = await doneP;
  const next = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
  const doneMd = fs.readFileSync(path.join(dir, 'studio', 'DONE.md'), 'utf8');
  const kept = ['one', 'two', 'three'].filter((k) => next.includes(`Queued mid-done ${k}`)).length;
  report('2.30p: a done that ran its gates for seconds keeps every task queued meanwhile (board re-read under the lock), and is in DONE', Boolean(id) && d.status === 0 && kept === 3 && doneMd.includes(`**${id}**`) && !new RegExp(`\\*\\*${id}\\*\\*`).test(next), `kept=${kept} ${d.out.slice(-800)} ${adds.map(out).join('').slice(0, 400)}`);

  // 6. A real lane copy: an engine-only lane rebased over a browser-only landing reuses its pass;
  //    a landing inside its scope re-runs the checks (path-scoped).
  const sh = (cwd, cmd) => run(cwd, cmd, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' });
  const repo = path.join(tmpRoot, `p230p-git-${process.pid}`);
  fs.mkdirSync(repo, { recursive: true });
  fs.cpSync(path.join(dir, 'harness'), path.join(repo, 'harness'), { recursive: true });
  fs.cpSync(path.join(dir, 'package.json'), path.join(repo, 'package.json'));
  fs.mkdirSync(path.join(repo, 'scripts'), { recursive: true });
  fs.writeFileSync(path.join(repo, 'scripts', 'run-gates.mjs'), "import fs from 'node:fs'; fs.appendFileSync(process.env.ZZ_GATE_LOG, (process.env.STUDIO_GATE_CHANGED || 'ALL') + '\\n'); console.log('PASS game');\n");
  for (const [rel, t] of [['web/g/a.js', 'a\n'], ['godot/g/w.gd', 'extends Node\n'], ['.gitignore', '.lanes/\n.studio/\n']]) { fs.mkdirSync(path.dirname(path.join(repo, rel)), { recursive: true }); fs.writeFileSync(path.join(repo, rel), t); }
  const gateLog = path.join(tmpRoot, `p230p-gatelog-${process.pid}.txt`);
  fs.writeFileSync(gateLog, '');
  sh(repo, 'git init -q -b main && git add -A && git commit -qm init');
  const lane = path.join(repo, '.lanes', 'builder-p1');
  sh(repo, `git worktree add -q -b lane/builder-p1 "${lane}" main`);
  fs.writeFileSync(path.join(lane, 'godot', 'g', 'w.gd'), 'extends Node\n# water\n');
  sh(lane, 'git commit -qam "T-1 water"');
  const lu = (rel) => JSON.stringify(pathToFileURL(path.join(lane, rel)).href);
  const genvG = { STUDIO_MAIN_ROOT: repo, ZZ_GATE_LOG: gateLog, STUDIO_LOCK_OWNER: 'builder-p1' };
  const rec = probe(`import { laneDiff } from ${lu('harness/worktree.mjs')}; import { recordPass } from ${lu('harness/merge-lane.mjs')};
const d = laneDiff(); recordPass(${JSON.stringify(repo)}, 'T-1', { head: d.head, base: d.base, changed: d.changed, scope: ['godot/**', 'harness/**'] }); console.log(JSON.stringify(d));`, genvG, lane);
  fs.writeFileSync(path.join(repo, 'web', 'g', 'a.js'), 'a2\n');
  sh(repo, 'git commit -qam "web landing"');
  const dl = probe(`import { deliver } from ${lu('harness/worktree.mjs')}; let landed = 0; const r = deliver('T-1', { onLanded: () => landed++ }); console.log(JSON.stringify({ ...r, landed }));`, genvG, lane);
  const log1 = fs.readFileSync(gateLog, 'utf8');
  const mainHas = fs.readFileSync(path.join(repo, 'godot', 'g', 'w.gd'), 'utf8');
  report('2.30p: deliver reuses the lane\'s pass after rebasing over another track\'s landing, fast-forwards, and writes the board under the lock', rec.changed?.[0] === 'godot/g/w.gd' && dl.ok === true && dl.merged === 1 && dl.landed === 1 && log1 === '' && /# water/.test(mainHas), `${JSON.stringify(rec)} ${JSON.stringify(dl)} log=${JSON.stringify(log1)}`);

  fs.writeFileSync(path.join(lane, 'godot', 'g', 'w.gd'), 'extends Node\n# water\n# foam\n');
  sh(lane, 'git commit -qam "T-2 foam"');
  probe(`import { laneDiff } from ${lu('harness/worktree.mjs')}; import { recordPass } from ${lu('harness/merge-lane.mjs')};
const d = laneDiff(); recordPass(${JSON.stringify(repo)}, 'T-2', { head: d.head, base: d.base, changed: d.changed, scope: ['godot/**', 'harness/**'] }); console.log('{}');`, genvG, lane);
  fs.writeFileSync(path.join(repo, 'godot', 'g', 'dock.gd'), 'extends Node\n');
  sh(repo, 'git add -A && git commit -qm "engine landing"');
  const dl2 = probe(`import { deliver } from ${lu('harness/worktree.mjs')}; const r = deliver('T-2'); console.log(JSON.stringify(r));`, genvG, lane);
  const log2 = fs.readFileSync(gateLog, 'utf8').trim();
  report('2.30p: a landing inside the lane\'s scope re-runs the checks, scoped to the lane\'s own diff', dl2.ok === true && log2 === 'godot/g/w.gd', `${JSON.stringify(dl2)} log=${JSON.stringify(log2)}`);
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}
}

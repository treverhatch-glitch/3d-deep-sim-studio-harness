/**
 * qa/selftest-284x.mjs — 2.84 (x): gates run for the engine a task is on.
 *
 * A crew's finding on 2.83: every `npm run verify` ran the web game's gates for docs-only tasks and for Unity-track work,
 * which they cannot affect. Each gate now has a track (harness/gate-tracks.mjs); a verify covers the tracks of its
 * changed paths and of its task(s), names the gates it did not run, and records what it covered for task done and the
 * merge train.
 *
 * The studio copy here has stand-in gates that record that they ran: golden and vision (web), godot-unit (engine:godot),
 * engine-u ("track": "engine:unity" on the gate), hcheck ("track": "harness" on the gate), docs (harness, judges docs),
 * secrets (all, judges docs) and mystery (an id no table names).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest284X({ dir, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, Boolean(ok), ok ? '' : String(d || '').slice(0, 2500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(STUDIO_|CLAUDE|AGENT_)/i.test(k)) clean[k] = '';
  const S = path.join(tmpRoot, `s284x-${process.pid}`);
  fs.rmSync(S, { recursive: true, force: true });
  fs.mkdirSync(S, { recursive: true });
  for (const d of ['harness', 'scripts', 'studio']) fs.cpSync(path.join(dir, d), path.join(S, d), { recursive: true });
  for (const n of fs.readdirSync(path.join(dir, 'qa'))) if (n.endsWith('.mjs') && !n.startsWith('selftest')) fs.cpSync(path.join(dir, 'qa', n), path.join(S, 'qa', n)); // done-check's imports
  fs.cpSync(path.join(dir, 'package.json'), path.join(S, 'package.json'));
  for (const x of ['studio/game.json', 'studio/mode.json', 'studio/engine']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(S, rel)), { recursive: true }); fs.writeFileSync(path.join(S, rel), text); };
  const log = path.join(S, 'gate-ran.txt');
  write('probe-gate.mjs', "import fs from 'node:fs'; fs.appendFileSync(process.env.ZZ_GATE_LOG, process.argv[2] + '\\n');\n");
  const gate = (id, extra = {}) => ({ id, command: `node probe-gate.mjs ${id}`, required: true, lite: true, cache: false, ...extra });
  write('studio/gates.json', JSON.stringify({ gates: [gate('golden'), gate('vision'), gate('godot-unit'), gate('engine-u', { track: 'engine:unity' }), gate('hcheck', { track: 'harness' }), gate('docs'), gate('secrets'), gate('mystery')] }, null, 2));
  write('engine/u/engine.json', JSON.stringify({ engine: 'unity' }));
  write('web/g/a.js', 'a\n');
  write('.gitignore', '.studio/\nnode_modules\n');
  // engine task records (harness/engine-tracks.mjs): T-9 on Unity, T-7 on Godot; T-8 has none (a web task).
  write('.studio/engine/tasks.json', JSON.stringify({ 'T-9': { engine: 'unity', track: 'engine:unity' }, 'T-7': { engine: 'godot', track: 'engine:godot' } }));
  const git = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident } });
  git('init', '-q', '-b', 'main'); git('add', '-A'); git('commit', '-qm', 'studio', '--no-verify');
  const base = { ...clean, ...ident, ZZ_GATE_LOG: log, STUDIO_MAIN_ROOT: S, STUDIO_LOCK_OWNER: 'probe-x', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_HEAVY_POLL_MS: '100', STUDIO_HEAVY_WAIT_MIN: '0.05', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_CPU_PROBE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_REFILL_WAKE: 'off', AGENT_EVENTS_FILE: path.join(S, '.studio', 'events.jsonl'), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '' };
  const verify = (env = {}, args = []) => {
    fs.writeFileSync(log, '');
    const r = spawnSync(process.execPath, [path.join(S, 'scripts', 'run-gates.mjs'), '--no-detach', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...base, ...env }, timeout: 240000 });
    const ran = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).sort();
    let rec = null;
    try { rec = JSON.parse(fs.readFileSync(path.join(S, '.studio', 'gates', 'probe-x.json'), 'utf8')); } catch {}
    return { r, ran, rec, text: out(r) };
  };
  const same = (a, b) => JSON.stringify([...a].sort()) === JSON.stringify([...b].sort());
  const ALL = ['docs', 'engine-u', 'godot-unit', 'golden', 'hcheck', 'mystery', 'secrets', 'vision'];
  const show = (v) => `ran ${v.ran.join(',')}\n${v.text.split('\n').filter((l) => /\[gates\] (gates by track|not run for|FAIL|PASS)/.test(l)).join('\n')}\n${v.text.slice(-800)}`;

  await guard('2.84 (x) a docs-only change runs only the gates that judge docs (docs, secrets) and names the rest: "not run for this change: ..." and the mode line (fails before this fix: every verify ran the web game\'s gates for a docs-only lane)', () => {
    const v = verify({ STUDIO_GATE_CHANGED: 'docs/GUIDE.md,studio/NEXT.md' });
    const nr = (v.text.match(/\[gates\] not run for this change: [^\n]*/) || [''])[0];
    return [v.r.status === 0 && same(v.ran, ['docs', 'secrets']) && /gates by track: on, this change covers docs/.test(v.text) && ['golden', 'vision', 'godot-unit', 'engine-u', 'hcheck', 'mystery'].every((id) => nr.includes(id)) && /golden, vision \(web track\)/.test(nr) && /mystery \(all track\)/.test(nr) && /touches docs only/.test(nr)
      && v.rec?.tracks?.mode === 'by-track' && same(v.rec.tracks.covered, ['docs']) && v.rec.tracks.notRun.length === 6, show(v)];
  });
  await guard('2.84 (x) a note inside the game\'s own folder (game/<name>/notes/x.md) stays on the game\'s track, since the game\'s checks may read it; a .md under docs/ or the studio board is docs', async () => {
    const gt = await import(pathToFileURL(path.join(S, 'harness', 'gate-tracks.mjs')).href);
    const got = ['game/demo/notes/a.md', 'web/g/README.md', 'engine/u/NOTES.md', 'docs/X.md', 'AGENTS.md', 'studio/NEXT.md', 'studio/game.json', 'package.json'].map((f) => [f, gt.pathTrack(f, { root: S }).join('+')]);
    const want = ['web', 'web', 'engine:unity', 'docs', 'docs', 'docs', '*', '*'];
    return [got.every(([, t], i) => t === want[i]), JSON.stringify(got)];
  });
  await guard('2.84 (x) an engine-track task whose lane touches only engine paths runs no web gate: the Unity gate and the every-change gates run, golden, vision and the Godot gate do not (fails before this fix: Unity work ran every web gate)', () => {
    const v = verify({ STUDIO_GATE_CHANGED: 'engine/u/Assets/Port.cs', STUDIO_VERIFY_TASKS: 'T-9' });
    const v2 = verify({ STUDIO_VERIFY_TASKS: 'T-9' }); // its work in its own repo: no studio diff, the task's track decides
    return [v.r.status === 0 && same(v.ran, ['engine-u', 'mystery', 'secrets']) && /not run for this change: [^\n]*golden/.test(v.text) && /touches engine:unity only/.test(v.text)
      && v2.r.status === 0 && same(v2.ran, ['engine-u', 'mystery', 'secrets']), `${show(v)}\n---\n${show(v2)}`];
  });
  await guard('2.84 (x) a web task runs no engine gate: a lane that changed web code runs the web gates and the every-change gates, not the Unity or Godot gate', () => {
    const v = verify({ STUDIO_GATE_CHANGED: 'web/g/a.js', STUDIO_VERIFY_TASKS: 'T-8' });
    return [v.r.status === 0 && same(v.ran, ['golden', 'mystery', 'secrets', 'vision']) && /engine-u \(engine:unity track\)/.test(v.text), show(v)];
  });
  await guard('2.84 (x) an engine task that also edits web code runs both: the union of the task\'s track and its paths\' tracks', () => {
    const v = verify({ STUDIO_GATE_CHANGED: 'engine/u/Assets/Port.cs,web/g/a.js', STUDIO_VERIFY_TASKS: 'T-9' });
    return [v.r.status === 0 && same(v.ran, ['engine-u', 'golden', 'mystery', 'secrets', 'vision']) && same(v.rec?.tracks?.covered || [], ['engine:unity', 'web']), show(v)];
  });
  await guard('2.84 (x) a harness change runs the harness gates and the every-change gates (docs, hcheck, secrets, mystery), no web or engine gate', () => {
    const v = verify({ STUDIO_GATE_CHANGED: 'harness/x.mjs' });
    return [v.r.status === 0 && same(v.ran, ['docs', 'hcheck', 'mystery', 'secrets']), show(v)];
  });
  await guard('2.84 (x) --all runs every gate, and so does STUDIO_GATES_BY_TRACK=off (with a line that says which mode ran); no task and no diff runs every gate too', () => {
    const a = verify({ STUDIO_GATE_CHANGED: 'docs/GUIDE.md', STUDIO_VERIFY_TASKS: 'T-9' }, ['--all']);
    const o = verify({ STUDIO_GATE_CHANGED: 'docs/GUIDE.md', STUDIO_VERIFY_TASKS: 'T-9', STUDIO_GATES_BY_TRACK: 'off' });
    const n = verify({});
    return [same(a.ran, ALL) && /gates by track: on, every gate runs \(--all\)/.test(a.text) && same(o.ran, ALL) && /gates by track: off \(STUDIO_GATES_BY_TRACK=off\)/.test(o.text) && o.rec?.tracks?.mode === 'off' && same(n.ran, ALL) && !/not run for this change/.test(n.text + a.text + o.text), `${show(a)}\n---\n${show(o)}\n---\n${show(n)}`];
  });
  await guard('2.84 (x) the train\'s verify of a mixed batch covers the union: its tasks\' tracks (STUDIO_VERIFY_TASKS, set by the train) and its files; a record that covered fewer tracks than the batch needs is not reused (recordCovers)', async () => {
    const v = verify({ STUDIO_GATE_CHANGED: 'web/g/a.js', STUDIO_VERIFY_TASKS: 'T-9,T-7,T-8' });
    const { recordCovers } = await import(pathToFileURL(path.join(S, 'harness', 'train.mjs')).href);
    const rec = (covered) => ({ partial: false, dirty: false, rows: [{ id: 'golden', ok: true, required: true }], tracks: { mode: 'by-track', covered } });
    process.env.STUDIO_MAIN_ROOT = S;
    let narrow; let wide;
    try {
      narrow = recordCovers(rec(['engine:unity']), { root: S, tree: 'x', changed: ['web/g/a.js'], tasks: ['T-9'] });
      wide = recordCovers(rec(['engine:unity', 'web']), { root: S, tree: 'x', changed: ['web/g/a.js'], tasks: ['T-9'] });
    } finally { delete process.env.STUDIO_MAIN_ROOT; }
    const src = fs.readFileSync(path.join(S, 'harness', 'train.mjs'), 'utf8');
    return [same(v.ran, ['engine-u', 'godot-unit', 'golden', 'mystery', 'secrets', 'vision']) && !narrow.ok && /needs web/.test(narrow.why) && !/needs/.test(wide.why || '') && /env\.STUDIO_VERIFY_TASKS = tasks\.join/.test(src), `${show(v)}\n${JSON.stringify({ narrow, wide })}`];
  });
  await guard('2.84 (x) a gate entry\'s "track" overrides the table: engine-u (engine:unity) runs for a Unity task only, hcheck (harness) for a harness change only; a game check in the game\'s manifest follows its own "track" in the game gate', async () => {
    const u = verify({ STUDIO_GATE_CHANGED: 'engine/u/Assets/Port.cs' });
    const gt = await import(pathToFileURL(path.join(S, 'harness', 'gate-tracks.mjs')).href);
    const t1 = gt.gateTrack({ id: 'golden', track: 'engine:unity' }).tracks;
    const t2 = gt.gateTrack({ id: 'game:unit' }).tracks;
    const t3 = gt.gateTrack({ id: 'game:unit', track: ['engine:unity'] }).tracks;
    return [u.ran.includes('engine-u') && !u.ran.includes('hcheck') && !u.ran.includes('golden') && same(t1, ['engine:unity']) && same(t2, ['web']) && same(t3, ['engine:unity']), `${show(u)}\n${JSON.stringify({ t1, t2, t3 })}`];
  });
  await guard('2.84 (x) an unknown gate id defaults to "all": it runs for a web change and for an engine change, and a docs-only change names it among the gates not run (never silently skipped)', async () => {
    const gt = await import(pathToFileURL(path.join(S, 'harness', 'gate-tracks.mjs')).href);
    const t = gt.gateTrack({ id: 'mystery' });
    const w = verify({ STUDIO_GATE_CHANGED: 'web/g/a.js' });
    const d = verify({ STUDIO_GATE_CHANGED: 'docs/GUIDE.md' });
    return [same(t.tracks, ['all']) && t.from === 'default' && w.ran.includes('mystery') && !d.ran.includes('mystery') && /not run for this change: [^\n]*mystery \(all track\)/.test(d.text) && d.rec?.tracks?.notRun?.some((x) => x.id === 'mystery'), `${JSON.stringify(t)}\n${show(w)}\n${show(d)}`];
  });
  await guard('2.84 (x) task done refuses a verify that skipped a track the task touched (it ran for engine:unity only, the task changed web code) and accepts one that covered it (fails before this fix: a narrower verify counted)', async () => {
    const head = git('rev-parse', 'HEAD').stdout.trim();
    const f = path.join(S, '.studio', 'gates-last-full.json');
    const probe = (covered) => {
      fs.writeFileSync(f, JSON.stringify({ at: new Date().toISOString(), head, dirty: false, partial: false, rows: [{ id: 'golden', ok: true, required: true }], tracks: { mode: 'by-track', covered } }));
      const code = `import { gatesAfter } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'done-check.mjs')).href)};\nconsole.log(JSON.stringify({ why: gatesAfter(Date.now() - 60000, ['web/g/a.js', 'engine/u/Assets/Port.cs']) }));`;
      const p = path.join(S, '.probe-284x.mjs');
      fs.writeFileSync(p, code);
      const r = spawnSync(process.execPath, [p], { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...base, STUDIO_LOCK_OWNER: '' } });
      try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { raw: out(r) }; }
    };
    const narrow = probe(['engine:unity']);
    const wide = probe(['engine:unity', 'web']);
    return [/ran the gates for engine:unity only, and this task's changes also need web/.test(narrow.why || '') && wide.why === null, JSON.stringify({ narrow, wide })];
  });
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {}
}

/**
 * qa/selftest-278d.mjs — 2.78.0 (PU-55): the player-journey gate (qa/journey.mjs).
 * Each mutant of cartridges/example-sim, applied in a fixture copy, must fail the right sub-check of the example journey
 * (studio/journeys/example-sim/start-to-win.json): the goal completing by itself -> no-input; a save that drops a field and
 * a module-level variable that lives only in one process -> reopen; an ignored input -> goal-not-met. The unmodified
 * cartridge passes; a journey naming a non-public action is refused; a { command } journey is judged on its four fields;
 * no journeys passes with a WARN.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export async function selftest278D({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(dir, 'node_modules');
  if (!fs.existsSync(nm) && fs.existsSync(path.join(harnessRoot, 'node_modules'))) {
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), nm, 'junction'); } catch {}
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const gitIn = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const env = { STUDIO_CARTRIDGE: '', STUDIO_GAME: '', TICK_BUDGET_MS_PER_TICK: '', NODE_OPTIONS: '', ...ident };
  let n = 0;
  const fixture = (name, edit = () => {}) => {
    const S = path.join(tmpRoot, `278d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules|\.studio)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    edit(S);
    gitIn(S, 'init', '-q', '-b', 'main');
    gitIn(S, 'config', 'core.autocrlf', 'false'); gitIn(S, 'config', 'core.eol', 'lf');
    gitIn(S, 'add', '-A'); gitIn(S, 'commit', '-qm', 'fixture', '--no-verify');
    return S;
  };
  const mutate = (S, rel, from, to) => {
    const f = path.join(S, rel);
    const text = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n');
    if (!text.includes(from)) throw new Error(`fixture: "${from.slice(0, 50)}" not found in ${rel}`);
    fs.writeFileSync(f, text.replace(from, to));
  };
  const jr = (S) => run(S, 'node qa/journey.mjs', env);
  const kinds = (r) => [...new Set([...out(r).matchAll(/\[journey\] FAIL ([\w-]+) /g)].map((m) => m[1]))].sort();
  const IDX = 'cartridges/example-sim/index.mjs';
  const T = ' (fails on 2.77.1: no journey gate)';

  await guard(`2.78.0 (PU-55): the unmodified example-sim passes its example journey: PASS line, exit 0, a Fix-free output${T}`, () => {
    const r = jr(fixture('clean'));
    return [r.status === 0 && /\[journey\] PASS example-sim\/start-to-win/.test(out(r)) && !/FAIL|Fix:/.test(out(r)), out(r)];
  });

  const mutants = [
    ['the goal completes by itself (win threshold 0)', (S) => mutate(S, IDX, 'winCredits: 25000,', 'winCredits: 0,'), ['no-input']],
    ['save drops a field (paused)', (S) => mutate(S, IDX, 'export function saveState(state) {\n  return JSON.stringify(state);', 'export function saveState(state) {\n  const { paused, ...rest } = state;\n  return JSON.stringify(rest);'), ['reopen']],
    ['an input is ignored (spawn does nothing)', (S) => mutate(S, IDX, "if (act.type === 'SPAWN_ENTITY' || act.type === 'spawn') {", "if (act.type === 'SPAWN_ENTITY') {"), ['goal-not-met']],
    ['a module-level variable survives in-process but not across processes', (S) => {
      mutate(S, IDX, 'const UNIT_KINDS =', 'let seenSpawn = 0;\nconst UNIT_KINDS =');
      mutate(S, IDX, 'state.resources.credits -= cost;', 'state.resources.credits -= cost;\n      seenSpawn += 1;');
      mutate(S, IDX, 'state.resources.credits += t.baseIncome', 'state.resources.credits += (seenSpawn > 0 ? 1 : 0) + t.baseIncome');
    }, ['reopen']],
  ];
  for (const [label, edit, want] of mutants) {
    await guard(`2.78.0 (PU-55): mutant "${label}" fails only the ${want.join('+')} check, with a Fix line, exit 1${T}`, () => {
      const r = jr(fixture('m', edit));
      const k = kinds(r);
      return [r.status === 1 && JSON.stringify(k) === JSON.stringify(want) && /\[journey\] Fix: /.test(out(r)), `${JSON.stringify(k)} exit ${r.status}\n${out(r)}`];
    });
  }

  await guard(`2.78.0 (PU-55): a journey naming a non-public action is refused (non-public-action), exit 1${T}`, () => {
    const S = fixture('nonpublic', (d) => {
      const f = path.join(d, 'studio/journeys/example-sim/start-to-win.json');
      const j = JSON.parse(fs.readFileSync(f, 'utf8'));
      j.steps[0].action = 'SET_CREDITS'; j.steps[0].args = { value: 999999 };
      fs.writeFileSync(f, JSON.stringify(j));
    });
    const r = jr(S);
    return [r.status === 1 && JSON.stringify(kinds(r)) === '["non-public-action"]' && /SET_CREDITS/.test(out(r)), out(r)];
  });

  await guard(`2.78.0 (PU-55): a malformed journey is refused (bad-journey) and a cartridge with no journeys passes with a WARN${T}`, () => {
    const bad = fixture('bad', (d) => fs.writeFileSync(path.join(d, 'studio/journeys/example-sim/start-to-win.json'), JSON.stringify({ id: 'x', seed: 1, steps: [], goal: { path: 'won', op: 'nope' }, saveAt: 5, maxTicks: 3 })));
    const none = fixture('none', (d) => fs.rmSync(path.join(d, 'studio/journeys'), { recursive: true, force: true }));
    const r1 = jr(bad); const r2 = jr(none);
    return [r1.status === 1 && JSON.stringify(kinds(r1)) === '["bad-journey"]' && r2.status === 0 && /\[journey\] WARN no journeys yet/.test(out(r2)) && !/FAIL/.test(out(r2)), `${out(r1)}\n---\n${out(r2)}`];
  });

  await guard(`2.78.0 (PU-55): a { command } journey is judged on goalMet, noInputGoalMet and the two digests: a good line passes; each wrong field fails its own kind${T}`, () => {
    const run1 = (line) => {
      const S = fixture('cmd', (d) => {
        fs.rmSync(path.join(d, 'studio/journeys/example-sim'), { recursive: true, force: true });
        fs.mkdirSync(path.join(d, 'studio/journeys/example-sim'), { recursive: true });
        fs.writeFileSync(path.join(d, 'emit.mjs'), `console.log('noise'); console.log(${JSON.stringify(JSON.stringify(line))});\n`);
        fs.writeFileSync(path.join(d, 'studio/journeys/example-sim/web.json'), JSON.stringify({ command: 'node emit.mjs' }));
      });
      const r = jr(S);
      return { status: r.status, k: kinds(r), o: out(r) };
    };
    const good = { goalMet: true, noInputGoalMet: false, digestA: 'abc', digestReopen: 'abc' };
    const g = run1(good);
    const a = run1({ ...good, goalMet: false });
    const b = run1({ ...good, noInputGoalMet: true });
    const c = run1({ ...good, digestReopen: 'xyz' });
    const d2 = run1({ goalMet: true });
    const ok = g.status === 0 && a.status === 1 && JSON.stringify(a.k) === '["goal-not-met"]' && JSON.stringify(b.k) === '["no-input"]' && JSON.stringify(c.k) === '["reopen"]' && JSON.stringify(d2.k) === '["command"]';
    return [ok, JSON.stringify({ g: g.o, a: a.k, b: b.k, c: c.k, d: d2.k })];
  });
}

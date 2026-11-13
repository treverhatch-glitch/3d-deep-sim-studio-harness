/**
 * qa/selftest-285g.mjs — 2.85 (g): places that took an agent's word with no evidence now ask for something that exists.
 *
 *   1  a milestone is "met" only with evidence (a file, a commit or an event id); a person may say why there is none
 *   2  a Golden-Reason is 20+ characters and names a task on the board (STUDIO_GOLDEN_REASON=strict|loose)
 *   3  a change to the game's sim comes with a test or a No-Test-Reason trailer, recorded on task.done
 *   4  the browser check plays the studio's game; a game it cannot drive is skipped with a reason, never replaced by the sample
 *   5  a hand-back note's file claims are looked for: a missing path is said in the facts and as an event, never refused
 *
 * Scaffolding (a studio copy with its own git and events file, a probe that runs a snippet in it) follows qa/selftest-284t.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285G({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = (extra = {}) => { const e = { ...process.env, ...ident, ...extra }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  clean.PATH = process.env.PATH || '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VERIFY_DETACH: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_PROGRAMS: 'off', STUDIO_CPU_PROBE: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_REACHABILITY: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285g-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };

  // ---- a studio copy (its own git and events file) ----
  const S = path.join(tmpRoot, `285g-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks below need no package */ }
  for (const x of ['.studio', 'studio/beta.json', 'studio/task-holds.json', 'studio/game.json', 'studio/mode.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
  const evFile = path.join(S, '.studio', 'events-285g.jsonl');
  const envOf = (extra = {}) => ({ ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...extra });
  const events = () => { try { return fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const run = (args, env = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, env: { ...envOf(), ...env }, encoding: 'utf8', timeout: 240000 });
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-285g-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = run([f], env);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ================= 1. a milestone is met only with evidence =================
  {
    write(S, 'studio/bible/CHARTER.md', '# Charter\n\n- M7 Water\nExit: waves move; foam shows\n');
    write(S, 'qa/reports/water-capture.txt', 'a capture\n');
    const sha = g(S, 'rev-parse', 'HEAD').stdout.trim();
    fs.appendFileSync(evFile, `${JSON.stringify({ id: 'evt_1_abcde', type: 'x.y', ts: new Date().toISOString() })}\n`);
    const met = (n, ...more) => run(['harness/producer-refill.mjs', 'met', 'M7', String(n), ...more]);
    const state = () => { try { return JSON.parse(fs.readFileSync(path.join(S, '.studio', 'milestones.json'), 'utf8')); } catch { return {}; } };
    await guard('2.85 (g) 1: an agent marking a milestone met with only a name is refused with one line saying what counts as evidence, and nothing is recorded (fails before this fix: it was recorded on the name alone)', () => {
      const r = met(1, '--by', 'director');
      return [r.status !== 0 && /evidence/.test(out(r)) && /file|commit|event/.test(out(r)) && !state().M7?.met?.[1], out(r)];
    });
    await guard('2.85 (g) 1: evidence that does not exist (a missing file, an unknown commit, an unknown event id) is refused', () => {
      const rs = [met(1, '--by', 'director', '--evidence', 'qa/reports/nope.png'), met(1, '--by', 'director', '--evidence', 'deadbeefdead'), met(1, '--by', 'director', '--evidence', 'evt_9_zzzzz'), met(1, '--by', 'director', '--evidence', '../outside.txt')];
      return [rs.every((r) => r.status !== 0 && /not found|evidence/.test(out(r))) && !state().M7?.met?.[1], rs.map(out).join('|')];
    });
    await guard('2.85 (g) 1: a file, a commit and an event id that exist are accepted and stored with the record; the milestone list shows them', () => {
      const a = met(1, '--by', 'director', '--evidence', 'qa/reports/water-capture.txt', sha);
      const b = met(2, '--by', 'director', '--evidence', 'evt_1_abcde');
      const list = run(['harness/producer-refill.mjs', 'milestones']);
      const rec = state().M7?.met;
      return [a.status === 0 && b.status === 0 && rec?.[1]?.evidence?.length === 2 && rec[1].evidence[0].kind === 'file' && rec[1].evidence[1].kind === 'commit' && rec[2].evidence[0].kind === 'event' && /qa\/reports\/water-capture\.txt/.test(out(list)) && /evt_1_abcde/.test(out(list)), out(a) + out(b) + out(list)];
    });
    await guard('2.85 (g) 1: a person (not an agent name) may pass --evidence none --why "<reason>" and it is recorded as such; an agent may not, and a person needs a reason', () => {
      const person = met(1, '--by', 'maintainer', '--evidence', 'none', '--why', 'the owner watched it run on screen');
      const rec = state().M7?.met?.[1]?.evidence;
      const agent = met(2, '--by', 'builder', '--evidence', 'none', '--why', 'the owner watched it run on screen');
      const noWhy = met(2, '--by', 'maintainer', '--evidence', 'none');
      return [person.status === 0 && rec?.none === true && /watched it run/.test(rec.why) && agent.status !== 0 && /agent/.test(out(agent)) && noWhy.status !== 0, out(person) + out(agent) + out(noWhy)];
    });
  }

  // ================= 2. a Golden-Reason names what it is for =================
  {
    write(S, 'studio/NEXT.md', '# Queue\n\n## IN_PROGRESS\n_None._\n\n## BACKLOG\n- [ ] **T-001** [P1] (`builder`) — Retune the belt\n\n## DONE\n_see DONE.md_\n');
    write(S, 'studio/DONE.md', '# Done\n\n## DONE\n- [x] **T-777** [P1] (`builder`) — Finish line\n');
    write(S, 'qa/golden/run.json', '{"tick":1}\n'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'golden: first', '--no-verify');
    let n = 1;
    const reasoned = (reason, env = {}) => {
      n += 1; write(S, 'qa/golden/run.json', `{"tick":${n}}\n`); g(S, 'add', '-A');
      const args = ['commit', '-q', '--no-verify', '-m', `retune ${n}`];
      if (reason !== null) args.push('-m', `Golden-Reason: ${reason}`);
      g(S, ...args);
      const p = probe(`import { goldenWithoutReason } from ${u('harness/test-weakening.mjs')}; const f = goldenWithoutReason('HEAD~1..HEAD'); console.log(JSON.stringify({ n: f.length, text: f.map((x) => x.detail).join(' | ') }));`, env);
      return p;
    };
    await guard('2.85 (g) 2: a one-letter Golden-Reason no longer waives the golden check, and the finding says what a reason needs (20+ characters and a task on the board); no trailer is still a finding (fails before: any text waived it)', () => {
      const p = reasoned('x'); const none = reasoned(null);
      return [p.n === 1 && /20 characters/.test(p.text) && /task/.test(p.text) && none.n === 1, JSON.stringify([p, none])];
    });
    await guard('2.85 (g) 2: a long reason that names no task on the board (no id, or an id that is not there) is still a finding', () => {
      const a = reasoned('the belt moves faster on purpose'); const b = reasoned('T-999 the belt moves faster on purpose');
      return [a.n === 1 && b.n === 1 && /names no task/.test(b.text), JSON.stringify([a, b])];
    });
    await guard('2.85 (g) 2: a reason of 20+ characters naming a task that is open (T-001) or done (T-777) on the board waives the check', () => {
      const a = reasoned('T-001: the faster belt moves the end tick'); const b = reasoned('T-777 retunes the finish tick for the new line');
      return [a.n === 0 && b.n === 0, JSON.stringify([a, b])];
    });
    await guard('2.85 (g) 2: STUDIO_GOLDEN_REASON=loose accepts any non-empty reason; on an empty board the default is loose and =strict still refuses', () => {
      const loose = reasoned('x', { STUDIO_GOLDEN_REASON: 'loose' });
      write(S, 'studio/NEXT.md', '# Queue\n\n## IN_PROGRESS\n_None._\n\n## BACKLOG\n_None._\n'); write(S, 'studio/DONE.md', '# Done\n\n## DONE\n');
      const emptyDefault = reasoned('x'); const emptyStrict = reasoned('x', { STUDIO_GOLDEN_REASON: 'strict' });
      return [loose.n === 0 && emptyDefault.n === 0 && emptyStrict.n === 1, JSON.stringify([loose, emptyDefault, emptyStrict])];
    });
  }

  // ================= 3. a change to the game's sim comes with a test or a stated reason =================
  {
    let seq = 0;
    const when = () => new Date(Date.now() + 3600 * 1000 + (++seq) * 1000).toISOString();
    const commitFor = (task, files, trailers = []) => {
      for (const [f, t] of Object.entries(files)) write(S, f, t);
      g(S, 'add', '-A');
      const d = when();
      const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', 'commit', '-q', '--no-verify', '-m', `${task}: work`, '-m', [...trailers, `Studio-Task: ${task}`].join('\n')], { windowsHide: true, cwd: S, encoding: 'utf8', env: gEnv({ GIT_AUTHOR_DATE: d, GIT_COMMITTER_DATE: d }) });
      return r.status === 0;
    };
    const evidence = (task) => probe(`import { taskChanges, rulesTestEvidence } from ${u('harness/done-check.mjs')};
const ch = taskChanges(${JSON.stringify(task)}, Date.now() + 1800 * 1000); const e = rulesTestEvidence(ch);
console.log(JSON.stringify({ sim: e.sim, tests: e.tests, reason: e.reason, files: ch.files }));`);
    const SIM = 'game/demo/sim/rules.mjs';
    await guard('2.85 (g) 3: sim code changed with a test file passes: no reason is asked (a task with sim code and a test)', () => {
      commitFor('T-910', { [SIM]: 'export const rule = 1;\n', 'game/demo/sim/rules.test.mjs': 'export const t = 1;\n' });
      const e = evidence('T-910');
      return [e.sim?.length === 1 && e.tests >= 1, JSON.stringify(e)];
    });
    await guard('2.85 (g) 3: sim code changed with no test and no trailer is flagged (fails before this fix: a change task needed only changes and a green verify)', () => {
      commitFor('T-911', { [SIM]: 'export const rule = 2;\n' });
      const e = evidence('T-911');
      return [e.sim?.length === 1 && e.tests === 0 && e.reason === '', JSON.stringify(e)];
    });
    await guard('2.85 (g) 3: a No-Test-Reason trailer of 20+ characters in a commit of the task is found; a short one is not', () => {
      commitFor('T-912', { [SIM]: 'export const rule = 3;\n' }, ['No-Test-Reason: a constant moved to the tuning file, same numbers']);
      commitFor('T-913', { [SIM]: 'export const rule = 4;\n' }, ['No-Test-Reason: no test']);
      const a = evidence('T-912'); const b = evidence('T-913');
      return [/same numbers/.test(a.reason) && b.reason === '' && b.sim?.length === 1, JSON.stringify([a, b])];
    });
    await guard('2.85 (g) 3: a docs-only change, a UI-only change and a tooling change touch no sim file, so nothing is asked of them', () => {
      commitFor('T-914', { 'docs/rules-note.md': '# note\n' });
      commitFor('T-915', { 'game/demo/ui/panel.mjs': 'export const panel = 1;\n' });
      commitFor('T-916', { 'tools/make-thing.mjs': 'export const x = 1;\n' });
      const r = ['T-914', 'T-915', 'T-916'].map(evidence);
      return [r.every((e) => e.sim?.length === 0), JSON.stringify(r)];
    });
    await guard('2.85 (g) 3: done-check (task done --check) lists "Game rules changed with a test, or a stated reason" as a missing item for sim code with neither, passes it with the trailer, and the reason is returned for the task.done event (meta.noTestReason)', () => {
      const p = probe(`import { checkDone } from ${u('harness/done-check.mjs')};
const label = 'Game rules changed with a test, or a stated reason';
const row = (id) => { const r = checkDone({ id, title: 'Rules change', role: 'builder' }, Date.now() + 1800 * 1000); return { row: r.checks.find((c) => c.label === label) || null, reason: r.noTestReason || null }; };
console.log(JSON.stringify({ a: row('T-911'), b: row('T-912'), c: row('T-914') }));`);
      return [p.a?.row?.ok === false && /No-Test-Reason/.test(p.a.row.why) && p.b?.row?.ok === true && /same numbers/.test(p.b.reason || '') && p.c?.row === null, JSON.stringify(p)];
    });
  }

  // ================= 4. the browser check plays the studio's game =================
  {
    const setGame = (j) => write(S, 'studio/game.json', `${JSON.stringify(j)}\n`);
    const target = () => probe(`import { resolvePlayTarget } from ${u('qa/browser-play.mjs')}; console.log(JSON.stringify(resolvePlayTarget({})));`);
    write(S, 'game/adopted-x/index.html', '<html></html>\n');
    write(S, 'game/adopted-x/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'smoke-play', command: 'node tools/play.mjs' }] })}\n`);
    fs.cpSync(path.join(S, 'cartridges', 'example-sim'), path.join(S, 'cartridges', 'real-one'), { recursive: true });
    await guard('2.85 (g) 4: with a cartridge as the active game the browser check plays that cartridge (not the first one in the folder)', () => {
      setGame({ game: 'real-one' }); const a = target();
      setGame({ cartridge: 'real-one' }); const b = target();
      return [a.cartridge === 'real-one' && b.cartridge === 'real-one', JSON.stringify([a, b])];
    });
    await guard('2.85 (g) 4: with an adopted game that has no cartridge manifest it is skipped as "not applicable: <why>", names the game\'s own play check, and the sample is not played (fails before: it played example-sim)', () => {
      setGame({ game: 'adopted-x' });
      const t = target();
      const p = probe(`import { playInBrowser } from ${u('qa/browser-play.mjs')}; const r = await playInBrowser({}); console.log(JSON.stringify({ cartridge: r.cartridge, skipped: r.skipped, passed: r.passed }));`);
      const cli = run(['qa/browser-play.mjs', '--no-shots']);
      return [t.skip && !t.cartridge && /adopted-x/.test(t.skip) && /game:smoke-play/.test(t.skip) && p.cartridge === null && /^not applicable: /.test(p.skipped) && p.passed === true
        && cli.status === 0 && /not applicable: /.test(out(cli)) && !/example-sim/.test(out(cli)), JSON.stringify({ t, p, cli: out(cli).slice(-500) })];
    });
    await guard('2.85 (g) 4: the sample plays only when it is the active game: set by name, or nothing else is set (the first cartridge); a cartridge named on the command line or in STUDIO_CARTRIDGE is still played as asked', () => {
      setGame({ game: 'example-sim' }); const a = target();
      fs.rmSync(path.join(S, 'cartridges', 'real-one'), { recursive: true, force: true }); setGame({}); const b = target();
      setGame({ game: 'adopted-x' });
      const c = probe(`import { resolvePlayTarget } from ${u('qa/browser-play.mjs')}; console.log(JSON.stringify(resolvePlayTarget({ cartridge: 'example-sim' })));`);
      const d = probe(`import { resolvePlayTarget } from ${u('qa/browser-play.mjs')}; console.log(JSON.stringify(resolvePlayTarget({})));`, { STUDIO_CARTRIDGE: 'example-sim' });
      return [a.cartridge === 'example-sim' && b.cartridge === 'example-sim' && c.cartridge === 'example-sim' && d.cartridge === 'example-sim', JSON.stringify([a, b, c, d])];
    });
    await guard('2.85 (g) 4: the launcher\'s browser check after a task emits qa.browser_play status "skipped" with the reason for an adopted game (never "ok"), and does not report a pass for the sample', () => {
      setGame({ game: 'adopted-x' });
      const p = probe(`import { browserCheckAfter } from ${u('harness/agent.mjs')}; const e = browserCheckAfter('T-950', process.cwd(), process.env); console.log(JSON.stringify(e));`);
      const ev = events().filter((e) => e.type === 'qa.browser_play' && e.task === 'T-950');
      setGame({});
      return [p.status === 'skipped' && /not applicable/.test(p.msg || '') && ev.length === 1 && ev[0].status === 'skipped' && !/passed/.test(ev[0].msg), JSON.stringify({ p, ev })];
    });
  }

  // ================= 5. a hand-back note's file claims are looked for =================
  {
    write(S, 'harness/real-thing.mjs', 'export const x = 1;\n');
    const note = 'I added qa/never-written.mjs and wrote harness/real-thing.mjs; see https://example.com/a/b.html, changed docs/*.md, updated my notes in the chat, and I fixed src/lost/file.ts too.';
    await guard('2.85 (g) 5: a hand-back note naming a file it says it added or changed that does not exist gets a line in the facts and a task.note_unverified warn event; files that exist, URLs and globs are left alone (fails before: nothing was checked)', () => {
      const p = probe(`import { factsFor } from ${u('harness/handback-facts.mjs')}; import { notedRepoPaths, noteMissingPaths } from ${u('harness/said-vs-did.mjs')};
const note = ${JSON.stringify(note)};
console.log(JSON.stringify({ facts: factsFor('T-960', note, {}), named: notedRepoPaths(note), missing: noteMissingPaths(note, [process.cwd()]) }));`);
      const ev = events().filter((e) => e.type === 'task.note_unverified' && e.task === 'T-960');
      return [/the note names qa\/never-written\.mjs, which does not exist/.test(p.facts || '') && /the note names src\/lost\/file\.ts, which does not exist/.test(p.facts || '') && !/real-thing/.test((p.facts || '').split('\n').filter((l) => /the note names/.test(l)).join('\n'))
        && !/example\.com|\*/.test((p.facts || '').split('\n').filter((l) => /the note names/.test(l)).join('\n')) && p.missing?.length === 2
        && ev.length >= 1 && ev[0].status === 'warn' && /never-written/.test(ev[0].msg), JSON.stringify({ p, ev })];
    });
    await guard('2.85 (g) 5: a note that names only files that exist, or no files, adds no line and no event, and the hand-back is never refused', () => {
      const before = events().filter((e) => e.type === 'task.note_unverified').length;
      const p = probe(`import { factsFor } from ${u('harness/handback-facts.mjs')};
console.log(JSON.stringify({ facts: factsFor('T-961', 'I wrote harness/real-thing.mjs and see docs/WORK-ORGANIZATION.md; it works.', {}) }));`);
      const after = events().filter((e) => e.type === 'task.note_unverified').length;
      return [typeof p.facts === 'string' && p.facts.length > 0 && !/which does not exist/.test(p.facts) && after === before, JSON.stringify({ p, before, after })];
    });
  }
}

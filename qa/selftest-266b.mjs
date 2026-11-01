/**
 * qa/selftest-266b.mjs — 2.66.0 (helper b): npm run fuzz (qa/fuzz.mjs): generated play, invariants, save/load,
 * determinism, ddmin shrinking, findings deduped by id, suggest vs file (the shadow week), the ignore list.
 * Made-up cartridges only, written into the copy:
 *   fz-planted  a counter goes negative after a, then b, then c, among noise actions (actions() export)
 *   fz-types    no actions(), only actionTypes; "sub" more than the value goes negative (the generic generator)
 *   fz-global   a hidden module-level counter feeds the state (determinism)
 *   fz-saveload a state key holding undefined changes the next step (lost by JSON: save/load)
 *   fz-none     neither actions() nor actionTypes (skipped with a note)
 * Every check fails on 2.65.2, which has no qa/fuzz.mjs.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const CARTS = {
  'fz-planted': `export function createInitialState(seed = 1) { return { seed: seed >>> 0, tick: 0, counter: 10, stage: 0, noise: 0 }; }
export function step(prev, actions = null) {
  const s = structuredClone(prev);
  s.tick += 1;
  for (const a of actions || []) {
    if (a.type === 'a' && s.stage === 0) s.stage = 1;
    else if (a.type === 'b' && s.stage === 1) s.stage = 2;
    else if (a.type === 'c' && s.stage === 2) s.counter = -1;
    else if (a.type === 'n') s.noise = (s.noise + 1) % 7;
    else if (a.type === 'm') s.noise = (s.noise + 3) % 7;
  }
  return s;
}
export function invariants(s) { return s.counter < 0 ? [{ id: 'COUNTER_NEGATIVE', severity: 'P1', summary: 'counter is ' + s.counter }] : []; }
export function actions(state, rand) { return { type: rand.pick(['a', 'b', 'c', 'n', 'm', 'n', 'm']) }; }
`,
  'fz-types': `export const actionTypes = [{ type: 'add', n: [1, 2, 3] }, { type: 'sub', n: { min: 1, max: 9 } }, 'noop'];
export function createInitialState(seed = 1) { return { seed: seed >>> 0, tick: 0, value: 5 }; }
export function step(prev, actions = null) {
  const s = structuredClone(prev);
  s.tick += 1;
  for (const a of actions || []) {
    if (a.type === 'add') s.value = Math.min(20, s.value + a.n);
    if (a.type === 'sub' && a.n <= 8) s.value = Math.max(0, s.value - a.n);
    if (a.type === 'sub' && a.n === 9) s.value -= a.n;
  }
  return s;
}
export function invariants(s) { return s.value < 0 ? [{ id: 'VALUE_NEGATIVE', severity: 'P0', summary: 'value is ' + s.value }] : []; }
`,
  'fz-global': `let hidden = 0;
export function createInitialState(seed = 1) { return { seed: seed >>> 0, tick: 0, x: 0 }; }
export function step(prev, actions = null) { const s = structuredClone(prev); s.tick += 1; hidden += 1; s.x = (s.x + hidden) % 1000; return s; }
export function actions(state, rand) { return rand() < 0.5 ? { type: 'poke' } : null; }
`,
  'fz-saveload': `export function createInitialState(seed = 1) { return { seed: seed >>> 0, tick: 0, n: 0, marker: undefined }; }
export function step(prev, actions = null) { const s = structuredClone(prev); s.tick += 1; s.n += 'marker' in s ? 1 : 2; return s; }
export function actions(state, rand) { return { type: 'poke' }; }
`,
  'fz-none': `export function createInitialState(seed = 1) { return { seed: seed >>> 0, tick: 0 }; }
export function step(prev) { return { ...prev, tick: prev.tick + 1 }; }
`,
};

export async function selftest266B({ dir, run, report, tmpRoot }) {
  const events = path.join(dir, '.studio', 'events-266b.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_ROLE: '', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', STUDIO_LANELESS: 'shared', STUDIO_WORKTREES: 'off', STUDIO_FUZZ_SEEDS: '', STUDIO_FUZZ_TICKS: '', STUDIO_CARTRIDGE: '', AGENT_EVENTS_FILE: events };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const fuzz = (args, env = {}) => run(dir, `node qa/fuzz.mjs ${args}`, { ...base, ...env });
  const json = (r) => { const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop(); try { return JSON.parse(line); } catch { return null; } };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const fuzzEvents = () => evs().filter((e) => e.type === 'fuzz.finding');
  const readJ = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };
  const readT = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
  const cfgFile = path.join(dir, 'studio', 'fuzz.json');
  const setCfg = (obj) => fs.writeFileSync(cfgFile, `${JSON.stringify(obj, null, 2)}\n`);
  const count = (text, s) => text.split(s).length - 1;
  const fuzzDir = path.join(dir, '.studio', 'fuzz');
  for (const [name, src] of Object.entries(CARTS)) {
    fs.mkdirSync(path.join(dir, 'cartridges', name), { recursive: true });
    fs.writeFileSync(path.join(dir, 'cartridges', name, 'index.mjs'), src);
  }
  const SMALL = '--seeds 4 --ticks 200';
  const result = (j, name) => (j?.results || []).find((r) => r.name === name) || null;

  // ---- read-only --check first: nothing written, exit 1 on a finding; example-sim and the template are clean ----
  setCfg({ mode: 'suggest' });
  const cfgBefore = fs.readFileSync(cfgFile, 'utf8');
  const chk = fuzz(`--check --json --cartridge fz-planted ${SMALL}`);
  const chkJ = json(chk);
  const ex = fuzz('--check --json --cartridge example-sim --seeds 6 --ticks 300');
  const tpl = fuzz('--check --json --cartridge _template --seeds 4 --ticks 300');
  report('2.66.0 (b): npm run fuzz -- --check is read-only (no .studio/fuzz, studio/fuzz.json untouched, no event) and exits 1 on a finding; a fresh fuzz of example-sim (its actions() export, ids repeating) is clean after the 2.65.2 fix, and the new-game template carries an actions() stub that fuzzes clean',
    chk.status === 1 && result(chkJ, 'fz-planted')?.findings?.length === 1 && !fs.existsSync(fuzzDir) && fs.readFileSync(cfgFile, 'utf8') === cfgBefore && !fuzzEvents().length
      && ex.status === 0 && result(json(ex), 'example-sim')?.source === 'actions()' && result(json(ex), 'example-sim')?.findings?.length === 0
      && tpl.status === 0 && result(json(tpl), '_template')?.source === 'actions()' && result(json(tpl), '_template')?.findings?.length === 0
      && /export function actions\(state, rand\)/.test(readT('cartridges/_template/index.mjs')),
    `${out(chk).slice(-800)}\n${out(ex).slice(-500)}\n${out(tpl).slice(-500)}`);

  // ---- planted bug: found among noise, shrunk to <= 3 actions, written with seed and replay command; suggest mode ----
  const t0 = Date.now();
  const r1 = fuzz(`--json --cartridge fz-planted ${SMALL}`);
  const j1 = json(r1);
  const f1 = result(j1, 'fz-planted')?.findings?.[0];
  const rec = f1 && readJ(`.studio/fuzz/findings/${f1.id}.json`);
  const rep = f1 && run(dir, `node qa/fuzz.mjs --replay .studio/fuzz/findings/${f1.id}.json`, base);
  const trace = f1 && run(dir, `node harness/replay.mjs --trace .studio/fuzz/findings/${f1.id}.json --quiet`, base);
  report('2.66.0 (b): a counter that goes negative after a, b, c among noise actions is found, shrunk (ddmin) to those 3 actions, and written to .studio/fuzz/findings/<id>.json with the seed, the failing tick and the replay command; both the fuzz replay and harness/replay.mjs --trace reproduce it',
    r1.status === 0 && f1?.check === 'invariant' && f1.code === 'COUNTER_NEGATIVE' && f1.actions.length <= 3 && f1.actions.map((e) => e.action.type).join('') === 'abc' && f1.originalActions > 3
      && rec?.seed >= 1 && rec.tick >= 1 && rec.cartridge === 'fz-planted' && rec.replay === `npm run fuzz -- --replay .studio/fuzz/findings/${f1.id}.json` && /^F-[0-9a-f]{12}$/.test(f1.id)
      && rep?.status === 1 && /still fails/.test(out(rep)) && trace?.status === 1,
    `${out(r1).slice(-1200)}\n${JSON.stringify(rec)?.slice(0, 600)}\n${rep ? out(rep).slice(-300) : ''}\n${trace ? out(trace).slice(-300) : ''}`);

  const cfg1 = readJ('studio/fuzz.json');
  const after = Date.parse(cfg1?.autoFileAfter);
  const board1 = readT('studio/NEXT.md');
  const sug1 = readT('.studio/fuzz/suggestions.md');
  const ev1 = fuzzEvents();
  report('2.66.0 (b): by default ("mode": "suggest") a new finding goes to .studio/fuzz/suggestions.md and one fuzz.finding event, no task is filed; the first run sets autoFileAfter to first run + 7 days in studio/fuzz.json',
    j1?.mode === 'suggest' && f1 && sug1.includes(`## ${f1.id} `) && ev1.length === 1 && ev1[0].meta?.mode === 'suggest' && ev1[0].meta?.id === f1.id && !/fuzz finding/i.test(board1)
      && cfg1?.mode === 'suggest' && Number.isFinite(after) && Math.abs(after - (t0 + 7 * 86400000)) < 10 * 60000 && j1.shadowStarted === cfg1.autoFileAfter,
    `${JSON.stringify(cfg1)}\n${JSON.stringify(ev1).slice(0, 600)}\n${sug1.slice(0, 600)}`);

  // ---- rerun: same id, same file, no second suggestion or event; autoFileAfter kept ----
  const r2 = fuzz(`--json --cartridge fz-planted ${SMALL}`);
  const f2 = result(json(r2), 'fz-planted')?.findings?.[0];
  const files2 = fs.existsSync(path.join(fuzzDir, 'findings')) ? fs.readdirSync(path.join(fuzzDir, 'findings')) : [];
  report('2.66.0 (b): a rerun dedupes by finding id (cartridge + check + shrunk actions\' types): the same findings file (seenRuns 2), no second suggestion, no second event, autoFileAfter unchanged',
    f2?.id === f1?.id && files2.length === 1 && readJ(`.studio/fuzz/findings/${f1?.id}.json`)?.seenRuns === 2 && count(readT('.studio/fuzz/suggestions.md'), `## ${f1?.id} `) === 1 && fuzzEvents().length === 1 && readJ('studio/fuzz.json')?.autoFileAfter === cfg1?.autoFileAfter,
    `${out(r2).slice(-800)}\n${files2.join(',')}\n${fuzzEvents().length}`);

  // ---- the daily digest lists the suggestion ----
  const probe = path.join(tmpRoot, `p266b-${process.pid}.mjs`);
  fs.writeFileSync(probe, `import { buildDigest } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'digest.mjs')).href)};
const d = await buildDigest();
console.log(JSON.stringify({ text: d.text, kinds: d.need.map((x) => x.kind) }));`);
  const dg = run(dir, `node "${probe}"`, base);
  const dj = json(dg);
  report('2.66.0 (b): the daily digest (harness/digest.mjs) shows a suggested fuzz finding of the last 24 h as something for a person (file it or ignore it), naming its id and suggestions.md',
    Boolean(dj?.kinds?.includes('fuzz')) && dj.text.includes(f1?.id) && /suggestions\.md/.test(dj.text), out(dg).slice(-1200));

  // ---- file mode: one bug task per new id, never twice (even with the findings record gone) ----
  setCfg({ ...readJ('studio/fuzz.json'), mode: 'file' });
  const r3 = fuzz(`--json --cartridge fz-planted ${SMALL}`);
  const f3 = result(json(r3), 'fz-planted')?.findings?.[0];
  const title = `Fix fuzz finding ${f1?.id}`;
  const board3 = readT('studio/NEXT.md');
  const evFile = fuzzEvents().filter((e) => e.meta?.mode === 'file');
  fs.rmSync(path.join(fuzzDir, 'findings'), { recursive: true, force: true });
  const r4 = fuzz(`--json --cartridge fz-planted ${SMALL}`);
  const board4 = readT('studio/NEXT.md');
  report('2.66.0 (b): "mode": "file" files ONE bug task ("Fix fuzz finding <id>…", through task.mjs addTask) for the finding, records it, and never files it twice: a rerun, even with .studio/fuzz/findings removed, finds the task.added event and files nothing',
    r3.status === 0 && /^T-\d+$/.test(String(f3?.task)) && count(board3, title) === 1 && evFile.length === 1 && evFile[0].meta?.task === f3.task
      && r4.status === 0 && count(board4, title) === 1 && fuzzEvents().filter((e) => e.meta?.mode === 'file').length === 1 && result(json(r4), 'fz-planted')?.findings?.[0]?.task === f3.task,
    `${out(r3).slice(-800)}\n${out(r4).slice(-600)}\n${board4.split('\n').filter((l) => /fuzz/i.test(l)).join('\n')}`);

  // ---- the generic generator (actionTypes), the ignore list, a skipped cartridge ----
  setCfg({ mode: 'suggest', autoFileAfter: null });
  const pre = json(fuzz(`--check --json --cartridge fz-types ${SMALL}`));
  const ft = result(pre, 'fz-types')?.findings?.[0];
  fs.writeFileSync(path.join(dir, 'studio', 'fuzz.ignore.json'), JSON.stringify([{ id: ft?.id, why: 'made-up: a deep debt is allowed in this test' }]));
  const evBefore = fuzzEvents().length;
  const r5 = fuzz(`--json --cartridge fz-types ${SMALL}`);
  const f5 = result(json(r5), 'fz-types')?.findings?.[0];
  const none = fuzz(`--cartridge fz-none ${SMALL}`);
  report('2.66.0 (b): a cartridge with only actionTypes is fuzzed by the generic generator (found, shrunk to the one bad "sub"); studio/fuzz.ignore.json ({ id, why }) is honoured (recorded, not suggested, no event); "autoFileAfter": null is kept (no shadow date written); a cartridge with neither is skipped with a note',
    result(pre, 'fz-types')?.source === 'actionTypes' && ft?.code === 'VALUE_NEGATIVE' && ft.actions.length === 1 && ft.actions[0].action.type === 'sub' && ft.actions[0].action.n === 9
      && f5?.id === ft.id && Boolean(f5.ignored) && !readT('.studio/fuzz/suggestions.md').includes(`## ${ft.id} `) && fuzzEvents().length === evBefore && readJ('studio/fuzz.json')?.autoFileAfter === null
      && none.status === 0 && /fz-none: skipped, no actions\(state, rand\) export and no actionTypes/.test(out(none)),
    `${JSON.stringify(pre)?.slice(0, 600)}\n${out(r5).slice(-600)}\n${out(none).slice(-300)}`);

  fs.writeFileSync(path.join(dir, 'studio', 'fuzz.ignore.json'), JSON.stringify([{ id: ft?.id }]));
  const r6 = fuzz(`--cartridge fz-types ${SMALL}`);
  report('2.66.0 (b): an ignore entry with no why is not honoured (the finding is suggested, the output says so)',
    readT('.studio/fuzz/suggestions.md').includes(`## ${ft?.id} `) && /not honoured \(each entry needs a "why"\)/.test(out(r6)), out(r6).slice(-800));

  // ---- the shadow week ends: autoFileAfter in the past files ----
  setCfg({ mode: 'suggest', autoFileAfter: new Date(Date.now() - 60000).toISOString() });
  const r7 = fuzz(`--json --cartridge fz-saveload ${SMALL}`);
  const j7 = json(r7);
  const f7 = result(j7, 'fz-saveload')?.findings?.[0];
  report('2.66.0 (b): a state that does not survive JSON is caught by the save/load round trip (check save-load); with autoFileAfter passed, "suggest" files it as a bug task (the shadow week is over)',
    f7?.check === 'save-load' && f7.code === 'SAVE_LOAD_DIVERGED' && j7?.mode === 'file' && /^T-\d+$/.test(String(f7.task)) && count(readT('studio/NEXT.md'), `Fix fuzz finding ${f7.id}`) === 1,
    out(r7).slice(-1000));

  // ---- determinism: a hidden global counter ----
  const r8 = fuzz(`--check --json --cartridge fz-global ${SMALL}`);
  const f8 = result(json(r8), 'fz-global')?.findings?.[0];
  report('2.66.0 (b): a cartridge feeding a hidden module-level counter into its state fails the determinism check (check determinism, code NONDETERMINISTIC), shrunk to no actions at all',
    r8.status === 1 && f8?.check === 'determinism' && f8.code === 'NONDETERMINISTIC' && f8.actions.length === 0, out(r8).slice(-1000));
  try { fs.rmSync(probe, { force: true }); } catch {}
}

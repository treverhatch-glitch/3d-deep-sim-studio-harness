/**
 * qa/selftest-285f.mjs — 2.85 (f): the designer's vision in every brief, and vision fixes land first.
 *
 * A review of a live crew found builders never saw the designer's pillars: the brief (.studio/briefs/<ID>.md, built by
 * harness/focus.mjs) held the task line, notes, "Done means", lane rules and gates, and none of the signed Game Bible.
 * And a fix for a broken pillar waited ten hours in the train queue behind routine ports. The scaffolding (a studio
 * copy with its own events file, probes that import the copy's modules) is qa/selftest-2773d.mjs's.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest285F({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  const base = { ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_AUTO_TRICKS: '0', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285f-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '' };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let n = 0;

  const NEVER = 'Never punish the player for waiting. Never show a modal that blocks the view; never use fake spawns. Never sell power for money.';
  const bible = (extra = {}) => ({
    version: 1,
    signed: { by: 'tester', at: '2026-10-01T00:00:00.000Z' },
    phase: { open: 1, history: [], floors: [] },
    answers: { never: NEVER, feelGreat: 'Watching a crowded queue drain after a good layout change. It should feel earned. And loud.', fantasy: 'Run a small port' },
    pillars: [{ name: 'Calm', rulesOut: 'timers that rush the player' }, { name: 'Readable', rulesOut: 'hidden numbers' }, { name: 'Earned', rulesOut: 'free upgrades' }],
    phases: { 1: { player: 'Lay out the first gates by hand and watch the queues. It starts to feel small.' }, 2: {}, 3: {} },
    layers: { building: { answer: 'yes', phase: 1, why: 'The player lays out gates and halls on a grid' } },
    ...extra,
  });
  const studio = (name, b = bible()) => {
    const S = path.join(tmpRoot, `285f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch { /* none needed */ } }
    for (const x of ['.studio', 'studio/task-holds.json', 'studio/proposed.json', 'studio/DONE.md', 'studio/handoffs', 'studio/bible/FEEL.md']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    fs.mkdirSync(path.join(S, 'studio', 'bible'), { recursive: true });
    if (b) fs.writeFileSync(path.join(S, 'studio', 'bible', 'bible.json'), `${JSON.stringify(b, null, 2)}\n`);
    else fs.rmSync(path.join(S, 'studio', 'bible', 'bible.json'), { force: true });
    const ev = path.join(S, '.studio', 'events-285f.jsonl');
    fs.writeFileSync(ev, '');
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S } };
  };
  // A board and its task.added events, written as task add would leave them.
  const board = (S, ev, tasks, t0 = Date.parse('2026-11-10T00:00:00Z')) => {
    const line = (t) => `- [ ] **${t.id}** [${t.priority || 'P1'}] (\`${t.role || 'builder'}\`) — ${t.title}`;
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), ['# Studio Task Queue (`studio/NEXT.md`)', '', '## IN_PROGRESS', '_No task currently in progress._', '', '## BACKLOG', ...tasks.map(line), '', '## DONE', '_Finished tasks are in `studio/DONE.md`._', ''].join('\n'));
    fs.writeFileSync(ev, tasks.map((t, i) => JSON.stringify({ ts: new Date(t0 + i * 60000).toISOString(), type: 'task.added', agent: 'producer', task: t.id, msg: `Queued ${t.id} [${t.priority || 'P1'}] (${t.role || 'builder'}): ${t.title}`, meta: t.meta || {} })).join('\n') + '\n');
  };
  const probe = (S, code, env) => { const f = path.join(S, `.probe-285f-${++n}.mjs`); fs.writeFileSync(f, code); const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, encoding: 'utf8', env, timeout: 180000 }); try { fs.rmSync(f, { force: true }); } catch { /* left */ } const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch { /* none */ } return { ...r, j }; };
  const cli = (S, env, args) => spawnSync(process.execPath, ['harness/task.mjs', ...args], { windowsHide: true, cwd: S, encoding: 'utf8', env, timeout: 180000 });
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const briefs = (S, env, ids) => probe(S, `import { buildFocus, renderFocus } from ${u(S, 'harness/focus.mjs')};
const out = {};
for (const id of ${JSON.stringify(ids)}) { const f = buildFocus(id, 'claude-a'); out[id] = f ? renderFocus(f) : null; }
console.log(JSON.stringify(out));`, env);
  const HEAD = "## The designer's vision for this task (studio/bible, signed)";
  const section = (md) => { const i = String(md || '').indexOf(HEAD); if (i < 0) return ''; const rest = md.slice(i + HEAD.length); const j = rest.indexOf('\n## '); return rest.slice(0, j < 0 ? undefined : j).trim(); };
  const words = (s) => s.split(/\s+/).filter(Boolean).length;

  const TASKS = [
    { id: 'T-001', title: 'Add a calm gate queue panel', meta: { phase: 1, serves: 'pillar:Calm', lane: 'game/a', build: true } },
    { id: 'T-002', title: 'Add the grid build mode for halls', meta: { phase: 1, serves: 'layer:building', lane: 'game/b', build: true } },
    { id: 'T-003', title: 'Port the gate queue', role: 'engine-porter', meta: { track: 'engine:demo' } },
    { id: 'T-004', title: 'Docs: the gate guide', meta: { type: 'docs' } },
    { id: 'T-005', title: 'Review T-001 gate queue panel', role: 'reviewer', meta: {} },
    { id: 'T-006', title: 'Add a tooling script for exports', meta: { infra: true } },
  ];

  // ---- 1. the card in the brief ----
  {
    const { S, ev, env } = studio('brief');
    board(S, ev, TASKS);
    const r = briefs(S, env, TASKS.map((t) => t.id));
    const b = r.j || {};
    const one = b['T-001'] || '';
    const card = section(one);
    await guard('2.85 (f): a pillar task\'s brief has the vision card between "What this task is" and "Done means": the pillar as the Bible has it, the never items, the feel line, the phase goal and the hand-back line, within 300 words (fails before this fix: the brief had none of the Bible)', () => [
      one.indexOf('## What this task is') >= 0 && one.indexOf('## What this task is') < one.indexOf(HEAD) && one.indexOf(HEAD) < one.indexOf('## Done means')
      && /Pillar \*\*Calm\*\*: rules out timers that rush the player/.test(card) && /- The game must never:/.test(card) && /Never punish the player for waiting/.test(card) && /Never sell power for money/.test(card)
      && /What has to feel great: Watching a crowded queue drain after a good layout change\. It should feel earned\.$/m.test(card) && /Phase 1 goal: Lay out the first gates by hand and watch the queues\./.test(card)
      && card.includes('If what you are about to build breaks one of these, stop and hand back: `npm run task -- pause T-001 --note "vision: <which line and why>"`.') && words(card) <= 300, `${one.slice(0, 2500)}\n${out(r).slice(-800)}`]);
    const two = section(b['T-002']);
    await guard('2.85 (f): a layer task\'s card names the layer with its Bible line, the pillars as a reminder, and the never and feel lines (fails before this fix: no card)', () => [
      /Layer \*\*Building and bases\*\* \(kept, phase 1\): The player lays out gates and halls on a grid/.test(two) && /pillars it must not break: Calm, Readable, Earned/.test(two) && /Never use fake spawns/i.test(two) && /What has to feel great/.test(two), two || String(b['T-002']).slice(0, 1500)]);
    const port = section(b['T-003']);
    const portNever = (port.match(/^ {2}- /gm) || []).length;
    await guard('2.85 (f): an engine port gets the shorter port card ("the web game is the spec", hand back instead of fixing) with at most 3 never items and no pillar or feel line (fails before this fix: no card)', () => [
      /This is a port: match the web game's behaviour exactly; the web game is the spec\. Do not improve, rename or re-balance\. If the web game seems wrong, hand back with the evidence instead of fixing it in the port\./.test(port) && portNever === 3 && !/Pillar|feel great/.test(port), port || String(b['T-003']).slice(0, 1500)]);
    await guard('2.85 (f): a docs task and a tooling (--infra) task get no card and their brief says nothing, while the pillar task beside them has one (fails before this fix: no task had a card)', () => [
      b['T-004'] && b['T-006'] && !b['T-004'].includes('designer\'s vision') && !b['T-006'].includes('designer\'s vision') && one.includes(HEAD), `${String(b['T-004']).slice(0, 400)}`]);
    const rev = section(b['T-005']);
    const cardLines = card.split('\n').filter((l) => l.startsWith('- ') || l.startsWith('  - '));
    await guard('2.85 (f): the reviewer\'s brief for "Review T-001 …" shows T-001\'s card, line for line, and asks to judge T-001 against it (fails before this fix: the reviewer saw no vision)', () => [
      cardLines.length >= 4 && cardLines.every((l) => rev.includes(l)) && /judge T-001 against it/.test(rev) && /If T-001 breaks one of these, request changes/.test(rev), `${rev}\n---\n${cardLines.join('\n')}`]);
    const off = briefs(S, { ...env, STUDIO_VISION_CARD: 'off' }, ['T-001']).j || {};
    const cap = briefs(S, { ...env, STUDIO_VISION_CARD_WORDS: '45' }, ['T-001']).j || {};
    const capped = section(cap['T-001']);
    await guard('2.85 (f): STUDIO_VISION_CARD=off removes the card; STUDIO_VISION_CARD_WORDS trims the phase goal first, then the feel line, keeping the pillar (fails before this fix: no card and no switch)', () => [
      off['T-001'] && !off['T-001'].includes(HEAD) && /Pillar \*\*Calm\*\*/.test(capped) && !/Phase 1 goal/.test(capped) && !/feel great/.test(capped) && words(capped.split('\nIf what')[0]) <= 45, `${capped}\n${String(off['T-001']).slice(0, 300)}`]);
    // A 40-item never list: six items, the ones sharing a word with the title or the pillar first.
    const forty = Array.from({ length: 40 }, (_, i) => (i === 31 ? 'Never let a gate queue grow without a sign' : i === 37 ? 'Never rush the player with timers' : `Never do thing number ${i + 1} wrong`)).join('\n');
    const nv = probe(S, `import { visionCard } from ${u(S, 'harness/vision-card.mjs')};
const b = JSON.parse(${JSON.stringify(JSON.stringify(bible({ answers: { never: forty, feelGreat: 'x.' } })))});
const c = visionCard({ task: { id: 'T-001', title: 'Add a calm gate queue panel', role: 'builder' }, meta: { serves: 'pillar:Calm', phase: 1 }, type: 'change', bible: b, root: process.cwd() });
console.log(JSON.stringify(c));`, env).j;
    const items = (nv?.lines || []).filter((l) => l.startsWith('  - '));
    await guard('2.85 (f): a 40-item never list is cut to 6, the two that share a word with the task title or the pillar first (fails before this fix: no list)', () => [
      items.length === 6 && items[0].includes('gate queue') && items[1].includes('timers') && items.every((l) => l.length <= 164), JSON.stringify(nv)]);
    // Unsigned Bible: no card.
    fs.writeFileSync(path.join(S, 'studio', 'bible', 'bible.json'), `${JSON.stringify(bible({ signed: null }), null, 2)}\n`);
    const uns = briefs(S, env, ['T-001']).j || {};
    await guard('2.85 (f): the same task\'s brief has the card with the signed Bible and none once the Bible is unsigned (fails before this fix: no card either way)', () => [uns['T-001'] && !uns['T-001'].includes(HEAD) && one.includes(HEAD), String(uns['T-001']).slice(0, 400)]);
    fs.writeFileSync(path.join(S, 'studio', 'bible', 'bible.json'), `${JSON.stringify(bible(), null, 2)}\n`);
    fs.writeFileSync(path.join(S, 'studio', 'bible', 'FEEL.md'), '# Feel\n\n## game/a\nSoft.\n');
    const feel = section((briefs(S, env, ['T-001']).j || {})['T-001']);
    const show = cli(S, env, ['show', 'T-001']);
    let shown = null; try { shown = JSON.parse(show.stdout); } catch { /* below */ }
    await guard('2.85 (f): with studio/bible/FEEL.md the card points to it (not inlined), and `task show` gives a vision field with the kind, words and pillar (fails before this fix: no pointer, no field)', () => [
      /More on feel: studio\/bible\/FEEL\.md \(read the part for game\/a only\)/.test(feel) && !feel.includes('Soft.') && shown?.vision?.kind === 'pillar' && shown.vision.pillar === 'Calm' && shown.vision.words > 10, `${feel}\n${out(show).slice(-600)}`]);
    const st = cli(S, { ...env, STUDIO_LOCK_OWNER: 'claude-a' }, ['start', 'T-001', '--agent', 'claude-a']);
    const startEv = fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((e) => e.type === 'task.start' && e.task === 'T-001');
    await guard('2.85 (f): task start records meta.visionCard ("pillar") and meta.playerFacing on the task.start event (fails before this fix: the event had no such field)', () => [startEv?.meta?.visionCard === 'pillar' && startEv.meta.playerFacing === true, `${JSON.stringify(startEv)}\n${out(st).slice(-800)}`]);
  }

  // ---- 2. vision fixes ----
  {
    const { S, ev, env } = studio('fix');
    board(S, ev, [{ id: 'T-010', title: 'Add a hall', meta: { phase: 1, serves: 'pillar:Readable', lane: 'game/a', build: true } }]);
    const args = ['add', 'Fix the queue timer that rushes the player', '--role', 'builder', '--phase', '1', '--serves', 'pillar:Calm', '--lane', 'game/c', '--vision-fix', '--why', 'A countdown flashes red over the gate queue'];
    const worker = cli(S, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-a' }, [...args, '--agent', 'builder-a']);
    const noWhy = cli(S, env, args.filter((a, i) => a !== '--why' && args[i - 1] !== '--why'));
    const noPillar = cli(S, env, ['add', 'Fix the hall grid', '--phase', '1', '--serves', 'layer:building', '--lane', 'game/c', '--vision-fix', '--why', 'Halls overlap on screen']);
    const tester = cli(S, { ...env, STUDIO_ROLE: 'qa-playtester', STUDIO_LOCK_OWNER: 'qa-playtester-1' }, [...args.slice(0, 2), 'now', ...args.slice(2), '--agent', 'qa-playtester-1']);
    const outside = cli(S, env, args);
    const evs = () => fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const added = evs().filter((e) => e.type === 'task.added' && e.meta?.visionFix);
    const proposed = (() => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'proposed.json'), 'utf8')).items || []; } catch { return []; } })();
    const nextMd = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const vid = added[0]?.task;
    await guard('2.85 (f): only the Director, Producer, a playtester or the overseer sets --vision-fix: a builder session is refused, it needs --serves pillar: and a --why, a playtester\'s goes to the Producer\'s proposals with its flag, the overseer\'s is queued with meta.visionFix and a [vision] mark on its board line (fails before this fix: no such flag)', () => [
      worker.status !== 0 && /vision-fix refused/.test(out(worker)) && noWhy.status !== 0 && /--why/.test(out(noWhy)) && noPillar.status !== 0 && /pillar/.test(out(noPillar))
      && tester.status === 0 && proposed.some((p) => p.meta?.visionFix === true && p.agent === 'qa-playtester-1')
      && outside.status === 0 && added.length >= 1 && added.at(-1).meta.visionWhy === 'A countdown flashes red over the gate queue' && new RegExp(`\\*\\*${added.at(-1).task}\\*\\* \\[P1\\] \\(\`builder\`\\) — Fix the queue timer that rushes the player \\[vision\\]`).test(nextMd),
      [out(worker), out(noWhy), out(noPillar), out(tester), out(outside), nextMd].map((x) => x.slice(-500)).join('\n---\n')]);
    const vfId = added.at(-1)?.task;
    const show = (() => { try { return JSON.parse(cli(S, env, ['show', vfId]).stdout); } catch { return null; } })();
    const nx = probe(S, `import { nextFor } from ${u(S, 'harness/task.mjs')};
console.log(JSON.stringify({ next: nextFor({ role: 'builder', agent: 'claude-z' }).task?.id || null }));`, env).j;
    await guard('2.85 (f): a startable vision fix is offered to a free builder before an older waiting task of the same role, and task show says visionFix (fails before this fix: the older task came first)', () => [
      nx?.next === vfId && show?.visionFix === true, JSON.stringify({ nx, vfId, v: show?.visionFix })]);
    // A child fix (--caused-by the vision fix) inherits it.
    const child = cli(S, env, ['add', 'Fix the countdown colour again', '--role', 'builder', '--type', 'bug', '--caused-by', vfId, '--lane', 'game/c', '--phase', '1', '--serves', 'pillar:Calm']);
    const kid = evs().filter((e) => e.type === 'task.added' && e.meta?.causedBy === vfId).pop();
    await guard('2.85 (f): a fix whose causedBy parent is a vision fix is one too (meta.visionFix, visionInherited, the [vision] mark) (fails before this fix: it queued as routine work)', () => [
      kid?.meta?.visionFix === true && kid.meta.visionInherited === vfId && /\[vision\]$/.test(kid.msg), `${JSON.stringify(kid)}\n${out(child).slice(-500)}`]);
    // Trains: the web queue's order and the engine batch, with batchMax 1 and older lanes ahead.
    const tr = probe(S, `import { visionLanesFirst } from ${u(S, 'harness/train.mjs')};
import { selectBatch } from ${u(S, 'harness/engine-train-control.mjs')};
const q = [{ task: 'T-010', branch: 'a' }, { task: 'T-020', branch: 'b' }, { task: ${JSON.stringify(vfId)}, branch: 'c' }];
const web = visionLanesFirst(q).slice(0, 1).map((l) => l.task);
const eng = selectBatch(q, { batchMax: 1 });
const grp = selectBatch(q, { batchMax: 2, group: 'play', classOf: (l) => (l.task === ${JSON.stringify(vfId)} ? 'edit' : 'full') });
console.log(JSON.stringify({ web, eng: eng.lanes.map((l) => l.task), why: eng.why, grp: grp.lanes.map((l) => l.task), cls: grp.cls }));`, env).j;
    const src = fs.readFileSync(path.join(S, 'harness', 'train.mjs'), 'utf8');
    const body = src.slice(src.indexOf('async function trainBody'));
    await guard('2.85 (f): a queued vision fix is first in the next web batch (before the cap) and the next engine batch with batchMax 1 while older lanes wait; with batchGroup "play" the batch is its class (fails before this fix: the oldest lane went first)', () => [
      tr?.web?.[0] === vfId && tr.eng.length === 1 && tr.eng[0] === vfId && /vision fix first/.test(tr.why) && tr.grp.length === 1 && tr.grp[0] === vfId && tr.cls === 'edit'
      && body.indexOf('visionLanesFirst(lanes') > 0 && body.indexOf('visionLanesFirst(lanes') < body.indexOf('lanes.length > maxLanes'), JSON.stringify(tr)]);
  }

  // ---- 3. the score lines ----
  {
    const { S, env } = studio('score');
    const t = (h) => new Date(Date.parse('2026-11-10T00:00:00Z') + h * 3600000).toISOString();
    const events = [
      { ts: t(0), type: 'task.added', task: 'T-1', meta: { serves: 'pillar:Calm', visionFix: true } },
      { ts: t(0.5), type: 'task.start', task: 'T-1', agent: 'a', meta: { visionCard: 'pillar', playerFacing: true } },
      { ts: t(1), type: 'task.start', task: 'T-2', agent: 'b', meta: { visionCard: null, playerFacing: true } },
      { ts: t(1), type: 'task.start', task: 'T-3', agent: 'c', meta: { visionCard: null, playerFacing: false } },
      { ts: t(1.5), type: 'task.added', task: 'T-4', meta: { causedBy: 'T-1' } },
      { ts: t(2), type: 'task.done', task: 'T-1', agent: 'a' },
      { ts: t(6), type: 'task.done', task: 'T-4', agent: 'a' },
    ];
    const r = probe(S, `import { roundScore, scoreText } from ${u(S, 'harness/score.mjs')};
const s = await roundScore({ events: ${JSON.stringify(events)}, machine: [], days: 7, root: process.cwd(), progressTimeoutMs: 1000 });
console.log(JSON.stringify({ text: scoreText(s) }));`, env);
    const text = r.j?.text || '';
    await guard('2.85 (f): npm run score prints "Briefs with a vision card: 1 of 2 player-facing tasks started" and "Vision fixes: 2 filed, median time from filed to landed 3.3 h" (a child fix counts) (fails before this fix: no such lines)', () => [
      text.includes('Briefs with a vision card: 1 of 2 player-facing tasks started') && text.includes('Vision fixes: 2 filed, median time from filed to landed 3.3 h'), `${text.slice(-800)}\n${out(r).slice(-600)}`]);
  }
}

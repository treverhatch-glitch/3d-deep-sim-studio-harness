/**
 * qa/selftest-235.mjs — the 2.35.0 checks: the rescue ladder for a task stopped by its budget.
 * Rescue on a different model family -> a split rescue on the next model -> shelved for the morning report,
 * with model fallbacks at each step and no step that waits forever.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest235({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  let n = 0;
  const evFile = path.join(dir, '.studio', 'events-235.jsonl');
  const env = { AGENT_EVENTS_FILE: evFile, STUDIO_TASK_BUDGET: 'off', STUDIO_REFILL_WAKE: 'off', STUDIO_RESCUE_MODELS: 'gpt-6,gemini-3-pro,claude-opus-5-5', STUDIO_RESCUE_MODEL: '', STUDIO_TIER_TOP_MODEL: '' };
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p235-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };

  // 1. The rescue model: a family that didn't work on the task, skipping models marked out, then the same family.
  const evs = [{ type: 'task.start', task: 'T-9', model: 'claude-sonnet-5-5', ts: new Date().toISOString() }];
  const m = probe(`import fs from 'node:fs'; import path from 'node:path';
import { rescueModelFor } from ${u('harness/rescue.mjs')};
import { QUOTA_FILE } from ${u('harness/budget.mjs')};
const evs = ${JSON.stringify(evs)};
const a = rescueModelFor('T-9', { events: evs });
const b = rescueModelFor('T-9', { events: evs, exclude: ['gpt-6'] });
fs.mkdirSync(path.dirname(QUOTA_FILE), { recursive: true });
fs.writeFileSync(QUOTA_FILE, JSON.stringify({ gpt: { until: new Date(Date.now() + 3600000).toISOString(), why: 'test' }, gemini: { until: new Date(Date.now() + 3600000).toISOString(), why: 'test' } }));
const c = rescueModelFor('T-9', { events: evs });
fs.rmSync(QUOTA_FILE);
const d = rescueModelFor('T-9', { events: evs, env: { STUDIO_RESCUE_MODELS: '' } });
console.log(JSON.stringify({ a, b, c, d }));`);
  report('2.35.0: the rescue model is from a family that did not work on the task; a model marked out (quota or spend guard) is skipped; with no other family left it falls back to the same family; with none listed the launcher picks', m.a?.model === 'gpt-6' && m.a.differentFamily === true && m.b?.model === 'gemini-3-pro' && m.c?.model === 'claude-opus-5-5' && m.c.differentFamily === false && m.c.skipped?.length === 2 && m.d?.model === null, JSON.stringify(m));

  // 2. The ladder: budget stop -> rescue step 1 -> (stuck) step 2 on another model -> (stuck) shelved; morning report.
  const add = run(dir, 'node harness/task.mjs add "Ladder probe: build the baggage belt" --role builder', env);
  const id = (out(add).match(/T-\d+/) || [])[0];
  const L = probe(`import { rescuePass } from ${u('harness/rescue.mjs')};
import { setHold, readHolds } from ${u('harness/task-hold.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
import { needsYou, renderNeeds } from ${u('harness/health.mjs')};
const id = ${JSON.stringify(id)};
const titles = () => Object.fromEntries([...parseNextQueue().inProgress, ...parseNextQueue().backlog].map((t) => [t.id, t.title]));
const find = (re) => Object.entries(titles()).filter(([, t]) => re.test(t)).map(([i]) => i);
setHold(id, { parked: { by: 'budget', budget: true, why: id + ' has used its budget: 6 sessions (limit 6). more' } }, { by: 'budget' });
const a1 = await rescuePass();
const r1 = find(new RegExp('^Rescue: ' + id + ' stuck'))[0];
const afterStep1 = readHolds()[id]?.parked?.rescue;
const again = await rescuePass(); // nothing new: one step per stop
setHold(r1, { parked: { by: 'budget', budget: true, why: r1 + ' has used its budget' } }, { by: 'budget' });
const a2 = await rescuePass();
const r2 = find(new RegExp('^Rescue: ' + id + ' split it'))[0];
const morningMid = renderNeeds(await needsYou([], {}));
// Step 2 nobody picks up: past the wait it moves on, to the shelf.
const a3 = await rescuePass({ now: Date.now() + 2 * 3600000 });
const h = readHolds();
const morning = renderNeeds(await needsYou([], {}));
console.log(JSON.stringify({ a1, again, a2, a3, r1, r2, afterStep1, shelved: h[id]?.parked?.shelved === true, r1sup: h[r1]?.parked?.superseded === true, r2sup: h[r2]?.parked?.superseded === true, morningMid, morning }));`, { STUDIO_HEALTH_CI: 'off' });
  const lines = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
  const resc = lines.filter((e) => e.type === 'task.rescue' && e.task === id);
  report('2.35.0: rescue ladder step 1: a task stopped by its budget gets one rescue (P0, on a different model family), and only one per stop', Boolean(L.r1) && L.afterStep1 === L.r1 && L.again?.length === 0 && resc[0]?.meta?.model === 'gpt-6' && resc[0]?.meta?.level === 1, JSON.stringify({ L, resc }));
  report('2.35.0: rescue ladder step 2: a rescue stopped by its own budget is superseded by a split rescue on the next model, and the morning report shows it under "Being rescued", not "Needs you"', Boolean(L.r2) && L.r1sup && resc[1]?.meta?.model === 'gemini-3-pro' && resc[1]?.meta?.level === 2 && /## Being rescued[\s\S]*rescue T-\d+ is on it/.test(L.morningMid || '') && !new RegExp(`${id} is parked`).test(L.morningMid || ''), JSON.stringify({ r2: L.r2, resc, morningMid: L.morningMid }));
  report('2.35.0: rescue ladder step 3: a step nobody claims within STUDIO_RESCUE_WAIT_MIN moves on; past the last step the task is shelved, listed under "Needs you" as shelved, and a person is asked once', L.r2sup && L.shelved && new RegExp(`${id} is shelved`).test(L.morning || '') && lines.some((e) => e.type === 'task.shelved' && e.task === id) && lines.filter((e) => e.type === 'agent.ask' && e.task === id).length === 1, JSON.stringify({ a3: L.a3, morning: L.morning }));

  // 3. Rescues off: straight to a person.
  const add2 = run(dir, 'node harness/task.mjs add "Ladder probe: rescues off" --role builder', env);
  const id2 = (out(add2).match(/T-\d+/) || [])[0];
  const off = probe(`import { rescuePass } from ${u('harness/rescue.mjs')};
import { setHold, readHolds } from ${u('harness/task-hold.mjs')};
setHold(${JSON.stringify(id2)}, { parked: { by: 'budget', budget: true, why: 'used its budget' } }, { by: 'budget' });
const a = await rescuePass();
console.log(JSON.stringify({ a, rescue: readHolds()[${JSON.stringify(id2)}]?.parked?.rescue }));`, { STUDIO_RESCUE: 'off' });
  report('2.35.0: STUDIO_RESCUE=off sends a budget stop straight to a person (no rescue task)', off.a?.[0]?.kind === 'ask' && off.rescue === 'person', JSON.stringify(off));

  // 4. A finished rescue acts on its decision; step 2 may not choose retry.
  const ap = probe(`import fs from 'node:fs'; import path from 'node:path';
import { applyRescue, rescueFile } from ${u('harness/rescue.mjs')};
import { setHold, readHolds } from ${u('harness/task-hold.mjs')};
const diag = 'Diagnosis: ' + 'the builder kept editing the wrong scene file because the brief named an old path '.repeat(4) + '\\n\\n';
fs.mkdirSync(path.dirname(rescueFile('T-901')), { recursive: true });
setHold('T-901', { parked: { by: 'budget', budget: true, why: 'x', rescue: 'T-902' } }, { by: 'budget' });
fs.writeFileSync(rescueFile('T-901'), '# Rescue of T-901\\n\\n' + diag + 'Decision: retry\\n');
const d1 = applyRescue({ id: 'T-902', title: 'Rescue: T-901 stuck (sessions)' });
const h1 = readHolds()['T-901']?.parked || null;
setHold('T-903', { parked: { by: 'budget', budget: true, why: 'x', rescue: 'T-904' } }, { by: 'budget' });
fs.writeFileSync(rescueFile('T-903'), '# Rescue of T-903\\n\\n' + diag + 'Decision: split\\n');
const d2 = applyRescue({ id: 'T-904', title: 'Rescue: T-903 stuck (sessions)' });
console.log(JSON.stringify({ d1, h1, d2, h2: readHolds()['T-903']?.parked?.rescue }));`);
  const dc = fs.readFileSync(path.join(dir, 'harness', 'done-check.mjs'), 'utf8');
  report('2.35.0: a finished rescue acts on its decision (retry unparks the task and resets its budget, split keeps it parked until the pieces land); step 2 must decide split or needs-person', ap.d1 === 'retry' && ap.h1 === null && ap.d2 === 'split' && ap.h2 === 'split' && /step 2: the decision must be split or needs-person/.test(dc), JSON.stringify(ap));
}

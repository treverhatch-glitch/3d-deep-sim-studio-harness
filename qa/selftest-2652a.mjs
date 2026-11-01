/**
 * qa/selftest-2652a.mjs — 2.65.2 (helper a): measurement fixes and one cartridge input bug (research 2026-11-01).
 *   1: the session end records the cache-write split (5-minute / 1-hour, from Claude's result usage) and the TTL the
 *      launcher asked for; dollarsOf prices cache writes by TTL (1.25x / 2x input, multipliers in studio/prices.json),
 *      cache reads with no read price at 0.1x input, and prefers the cost the tool reported (meta.costUsd).
 *   2: buildAutonomy without `weigh` counts cache reads at the budget meter's weight, as the CLI does.
 *   3: tokensFrom's plain (OpenAI-format) path takes cached tokens off prompt_tokens / input_tokens; an Anthropic-format
 *      plain report adds its cache writes.
 *   4: example-sim refuses a spawn whose caller-given id is in use (no duplicate entity, nothing charged).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2652A({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const events = path.join(dir, '.studio', 'events-2652a.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_ROLE: '', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_AGENT_TOOL: '', STUDIO_REHEARSAL: '', STUDIO_LONG_CACHE: '', STUDIO_CACHE_READ_WEIGHT: '', STUDIO_AUTONOMY_CACHE_S: '0', STUDIO_LANELESS: 'shared', STUDIO_WORKTREES: 'off', AGENT_EVENTS_FILE: events };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p2652a-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-1500) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const near = (a, b) => typeof a === 'number' && Math.abs(a - b) < 1e-9;

  // ---- 1a. the session end records the write split and the TTL asked for ----
  const fake = path.join(tmpRoot, `fake-claude-2652a-${process.pid}.mjs`);
  fs.writeFileSync(fake, `const split = process.argv[2] === 'split';
console.log(JSON.stringify({ type: 'assistant', message: { usage: { input_tokens: 5, cache_creation_input_tokens: 3000, cache_read_input_tokens: 0, output_tokens: 10 } } }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', num_turns: 2, total_cost_usd: 0.25, usage: { input_tokens: 5, cache_creation_input_tokens: 3000, cache_read_input_tokens: 9000, output_tokens: 10, ...(split ? { cache_creation: { ephemeral_5m_input_tokens: 1000, ephemeral_1h_input_tokens: 2000 } } : {}) } }));
`);
  const s1 = run(dir, 'node harness/agent.mjs start --role producer --agent pr-2652a --tool claude --model m-1', { ...base, STUDIO_PRODUCER_CMD: `node "${fake}" split` });
  const s2 = run(dir, 'node harness/agent.mjs start --role builder --agent bu-2652a --tool claude --model m-1', { ...base, STUDIO_BUILDER_CMD: `node "${fake}" nosplit` });
  const endOf = (agent) => evs().filter((e) => e.type === 'agent.session.end' && e.agent === agent).pop()?.meta || null;
  const m1 = endOf('pr-2652a'); const m2 = endOf('bu-2652a');
  report('2.65.2 (a, 1): a session end records its cache writes, their 5-minute / 1-hour split when Claude\'s result usage gives one (cache_creation), and the TTL the launcher asked for (1h for a Producer, 5m for a builder); the reported cost stays recorded',
    s1.status === 0 && s2.status === 0 && m1?.cacheWrite === 3000 && m1?.cacheWrite5m === 1000 && m1?.cacheWrite1h === 2000 && m1?.cacheTtl === '1h' && m1?.costUsd === 0.25
      && m2?.cacheWrite === 3000 && m2?.cacheWrite5m === undefined && m2?.cacheWrite1h === undefined && m2?.cacheTtl === '5m',
    `${JSON.stringify({ m1, m2 })}\n${out(s1).slice(-600)}\n${out(s2).slice(-600)}`);

  // ---- 1b. dollarsOf prices cache writes by TTL ----
  const M = 1000000;
  const d1 = probe(`import { dollarsOf } from ${u('harness/autonomy.mjs')};
const prices = { 'm-big': { in: 3, out: 15 } };
const one = (meta) => dollarsOf([{ model: 'm-big', tokensIn: ${M}, tokensOut: 0, meta }], prices).usd;
console.log(JSON.stringify({
  split: one({ cacheWrite: ${0.6 * M}, cacheWrite5m: ${0.2 * M}, cacheWrite1h: ${0.4 * M} }),
  ttl1h: one({ cacheWrite: ${M}, cacheTtl: '1h' }),
  ttl5m: one({ cacheWrite: ${M} }),
  none: one({}),
}));`);
  report('2.65.2 (a, 1): dollarsOf prices cache writes as Anthropic bills them, not as plain input: 5-minute writes at 1.25x input, 1-hour writes at 2x (by the split, else the recorded TTL, else 5 minutes); plain input stays at 1x',
    near(d1.split, 0.4 * 3 + 0.2 * 3.75 + 0.4 * 6) && near(d1.ttl1h, 6) && near(d1.ttl5m, 3.75) && near(d1.none, 3), JSON.stringify(d1));

  // ---- 1c. multipliers from studio/prices.json; a model with no read price reads at 0.1x input ----
  fs.writeFileSync(path.join(dir, 'studio', 'prices.json'), JSON.stringify({ models: { 'm-big': { in: 3, out: 15 } }, multipliers: { cacheWrite1h: 3, cacheRead: 'x' } }));
  const d2 = probe(`import { dollarsOf, readPriceMultipliers, readPrices } from ${u('harness/autonomy.mjs')};
const mult = readPriceMultipliers();
const prices = readPrices();
console.log(JSON.stringify({ mult,
  write1h: dollarsOf([{ model: 'm-big', tokensIn: ${M}, meta: { cacheWrite: ${M}, cacheTtl: '1h' } }], prices, mult).usd,
  readDefault: dollarsOf([{ model: 'm-big', tokensIn: 0, meta: { cacheRead: ${M} } }], prices, mult).usd,
  readPriced: dollarsOf([{ model: 'm-x', tokensIn: 0, meta: { cacheRead: ${M} } }], { 'm-x': { in: 3, cacheRead: 0.15 } }).usd }));`);
  fs.rmSync(path.join(dir, 'studio', 'prices.json'), { force: true });
  report('2.65.2 (a, 1): the write and read multipliers come from studio/prices.json "multipliers" (a bad value keeps the default); a model with no cacheRead price reads at 0.1x its input price instead of $0, one with a price at that price',
    d2.mult?.cacheWrite1h === 3 && d2.mult?.cacheWrite5m === 1.25 && d2.mult?.cacheRead === 0.1 && near(d2.write1h, 9) && near(d2.readDefault, 0.3) && near(d2.readPriced, 0.15), JSON.stringify(d2));

  // ---- 1d. the cost the tool reported is preferred ----
  const d3 = probe(`import { dollarsOf, buildAutonomy, personClassifier } from ${u('harness/autonomy.mjs')};
const prices = { 'm-big': { in: 3, out: 15 } };
const ends = [
  { model: 'm-big', tokensIn: ${M}, meta: { costUsd: 7.5 } },
  { model: 'm-other', tokensIn: ${M}, meta: { costUsd: 2 } },
  { model: 'm-big', tokensIn: ${M}, meta: { costUsd: null } },
];
const d = dollarsOf(ends, prices);
const now = Date.parse('2026-11-08T00:00:00Z');
const at = (h) => new Date(now - h * 3600000).toISOString();
const ev = ends.map((e, i) => ({ ts: at(10 + i), type: 'agent.session.end', agent: 'b-' + i, ...e }));
ev.push({ ts: at(5), type: 'task.done', agent: 'b-0', task: 'T-1' });
const card = buildAutonomy(ev, { now, days: 7, isPersonName: await personClassifier(), prices });
console.log(JSON.stringify({ d, cost: card.cost }));`);
  report('2.65.2 (a, 1): a session whose tool reported its cost (meta.costUsd) counts at that cost, even for a model not in the price table; one without is priced from the table; the scorecard says how many were reported',
    near(d3.d?.usd, 7.5 + 2 + 3) && d3.d?.reported === 2 && d3.d?.unpriced === 0 && d3.cost?.dollars === 12.5 && d3.cost?.reportedSessions === 2 && /2 session\(s\) at the cost their tool reported/.test(d3.cost?.note || ''),
    JSON.stringify(d3));

  // ---- 2. buildAutonomy's default weight is the budget meter's ----
  const NOW = '2026-11-08T00:00:00Z';
  const now = Date.parse(NOW);
  const at = (h) => new Date(now - h * 3600000).toISOString();
  const wev = [
    { ts: at(30), type: 'agent.session.end', agent: 'b-w1', model: 'm-1', tokensIn: 100, tokensOut: 100, meta: { cacheRead: 10000 } },
    { ts: at(29), type: 'task.done', agent: 'b-w1', task: 'T-1' },
  ];
  fs.writeFileSync(events, wev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const w = probe(`import { buildAutonomy, personClassifier } from ${u('harness/autonomy.mjs')};
import { weightedTokens } from ${u('harness/budget.mjs')};
const ev = ${JSON.stringify(wev)};
const card = buildAutonomy(ev, { now: ${now}, days: 7, isPersonName: await personClassifier() });
console.log(JSON.stringify({ tokens: card.tokens, perLanded: card.tokensPerLanded, meter: weightedTokens(ev[0]) }));`);
  const cli = run(dir, `node harness/autonomy.mjs --now ${NOW} --json`, base);
  let cj = null; try { cj = JSON.parse(cli.stdout); } catch {}
  report('2.65.2 (a, 2): buildAutonomy called without `weigh` counts cache reads at the budget meter\'s weight (100 + 100 + 10,000 x 0.1 = 1,200), the same number as the CLI (and the hub, which uses the same report), not at full weight (10,200)',
    w.tokens === 1200 && w.meter === 1200 && cj?.card?.tokens === 1200, `${JSON.stringify(w)}\ncli tokens ${cj?.card?.tokens}\n${out(cli).slice(-600)}`);

  // ---- 3. tokensFrom's plain path ----
  const tk = probe(`import { tokensFrom } from ${u('harness/agent.mjs')};
const pick = (t) => ({ in: t.tokensIn, read: t.cacheRead, out: t.tokensOut });
console.log(JSON.stringify({
  chat: pick(tokensFrom(JSON.stringify({ usage: { prompt_tokens: 40, completion_tokens: 4, prompt_tokens_details: { cached_tokens: 30 } } }))),
  responses: pick(tokensFrom(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 5, input_tokens_details: { cached_tokens: 80 } } }))),
  codexOne: pick(tokensFrom(JSON.stringify({ usage: { input_tokens: 100, output_tokens: 5, cached_input_tokens: 80 } }))),
  anthropic: pick(tokensFrom(JSON.stringify({ usage: { input_tokens: 10, cache_creation_input_tokens: 200, cache_read_input_tokens: 500, output_tokens: 3 } }))),
  bare: pick(tokensFrom(JSON.stringify({ usage: { prompt_tokens: 40, completion_tokens: 4 } }))),
}));`);
  const eq = (x, a, b, c) => x && x.in === a && x.read === b && x.out === c;
  report('2.65.2 (a, 3): a plain (non-Claude, non-Codex-stream) usage report counts cached tokens once: in the OpenAI shapes they come off prompt_tokens / input_tokens (as the Codex path does) instead of counting as fresh input or twice; an Anthropic-shaped one adds its cache writes to the input as the Claude path does',
    eq(tk.chat, 10, 30, 4) && eq(tk.responses, 20, 80, 5) && eq(tk.codexOne, 20, 80, 5) && eq(tk.anthropic, 210, 500, 3) && eq(tk.bare, 40, 0, 4), JSON.stringify(tk));

  // ---- 4. example-sim refuses a spawn whose id is in use ----
  const sim = probe(`import { createInitialState, step, invariants } from ${u('cartridges/example-sim/index.mjs')};
let s = createInitialState(1337);
s = step(s, { type: 'spawn', kind: 'crate', id: 'c', x: 1, z: 1 });
s = step(s, { type: 'spawn', kind: 'crate', id: 'c', x: 2, z: 2 });
const f1 = invariants(s);
let a = createInitialState(1337); let b = createInitialState(1337);
a = step(a, { type: 'spawn', kind: 'vehicle', id: 'unit-1', x: 3, z: 3 });
b = step(b, null);
console.log(JSON.stringify({ ids: s.entities.map((e) => e.id), log: s.actionLog.map((x) => x.ok), f1: f1.map((f) => f.id), unitDup: a.entities.filter((e) => e.id === 'unit-1').length, credits: [a.resources.credits, b.resources.credits], unitLog: a.actionLog.map((x) => x.ok) }));`);
  const regs = run(dir, 'node qa/check-regressions.mjs', base);
  report('2.65.2 (a, 4): example-sim refuses a spawn whose caller-given id is already in use (logged ok: false, nothing charged, no DUPLICATE_ID); the regression replays pass',
    sim.ids?.join(',') === 'unit-1,prop-1,c' && sim.log?.join(',') === 'true,false' && sim.f1?.length === 0 && sim.unitDup === 1 && sim.credits?.[0] === sim.credits?.[1] && sim.unitLog?.join(',') === 'false' && regs.status === 0,
    `${JSON.stringify(sim)}\n${out(regs).slice(-600)}`);

  fs.rmSync(fake, { force: true });
}

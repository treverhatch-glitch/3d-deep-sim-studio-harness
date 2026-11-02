/**
 * qa/selftest-267i.mjs — 2.67.0 (helper i): the scorecard's gaps the crew found on day one. Made-up events only.
 *   1. Outside work counts: `npm run usage -- add` records a session (meta.outside) the scorecard and the budget read;
 *      `usage -- import` reads Claude Code transcripts (subagent files too) once per session and model, records only
 *      the growth on a re-import, and never prints or stores message text. An outside orchestrator's releases, lanes
 *      refreshes, holds and conductor notes are orchestrator interventions, split planned / unplanned.
 *   2. Default prices: studio/prices.json ships family rows with a "checked" stamp; a full model id is priced by its
 *      family and the card says "prices from <file>, checked <date>".
 *   3. Risk tiers: the train's task.train.tier events give the L3 bar's tierCUnsigned (it read n/a before).
 *   4. A stale halt: the card names the open halt (who, when, cause, how to clear); studio:resume clears one older
 *      than STUDIO_HALT_STALE_H whose supervisor isn't running (a person, or an outside agent on permission), and the
 *      card stops counting it; a younger one is left alone; a worker is still refused.
 *   5. Local days: daily rows and landing times in STUDIO_TZ, with the UTC span / date when it differs (TZ alone keeps
 *      UTC days and only feeds the hint).
 * Each check fails on 2.66.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest267I({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const base = { STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_TZ: '', TZ: 'UTC', STUDIO_HALT_STALE_H: '', STUDIO_RESUME_BY: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_CACHE_READ_WEIGHT: '0.1' };
  const evFile = (n) => path.join(dir, '.studio', `events-267i-${n}.jsonl`);
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  const readEv = (f) => { try { return fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-267i-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...base, ...env });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: String(r.stderr || '').slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const NOW = Date.parse('2026-11-08T00:00:00Z');
  const at = (h) => new Date(NOW - h * 3600000).toISOString();

  // ---- 1a. usage add ----
  {
    const f = evFile('add');
    const env = { AGENT_EVENTS_FILE: f };
    const add = run(dir, 'node harness/usage.mjs add --agent opus-bot --tokens-in 1000 --tokens-out 500 --cache-read 10000 --cache-write 200 --cost-usd 0.42 --task T-5 --model claude-opus-4-5 --why "integrated train 14"', { ...base, ...env });
    const worker = run(dir, 'node harness/usage.mjs add --agent builder-s1 --tokens-in 10 --tokens-out 10 --why "my own session"', { ...base, ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s1' });
    const noWhy = run(dir, 'node harness/usage.mjs add --agent opus-bot --tokens-in 10', { ...base, ...env });
    const evs = readEv(f);
    const e = evs.find((x) => x.type === 'agent.session.end');
    fs.writeFileSync(f, [...evs, { ts: at(30), type: 'task.start', agent: 'builder-a1', task: 'T-5' }, { ts: at(20), type: 'task.done', agent: 'builder-a1', task: 'T-5' }].map((x) => JSON.stringify({ ...x, ts: x.type === 'agent.session.end' ? at(10) : x.ts })).join('\n') + '\n');
    const card = probe('add', `import { buildAutonomy, personClassifier } from ${u('harness/autonomy.mjs')};
import { usedSince } from ${u('harness/budget.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const ev = readRecentEvents(1000);
const c = buildAutonomy(ev, { now: ${NOW}, days: 7, isPersonName: await personClassifier() });
console.log(JSON.stringify({ tokens: c.tokens, perLanded: c.tokensPerLanded, usage: c.orchestrator.usage, budget: usedSince('outside', 0, ev) }));`, env);
    report('2.67.0 (i, 1): npm run usage -- add records outside work as a session (meta.outside, cache writes in tokensIn) that the scorecard and the budget count; a launched worker and a record without --why are refused',
      add.status === 0 && e?.meta?.outside === true && e.agent === 'opus-bot' && e.tokensIn === 1200 && e.tokensOut === 500 && e.meta.cacheRead === 10000 && e.meta.costUsd === 0.42 && e.task === 'T-5' && e.model === 'claude-opus-4-5'
        && card.tokens === 2700 && card.perLanded === 2700 && card.usage?.sessions === 1 && card.usage?.tokens === 2700 && card.budget === 2700
        && worker.status !== 0 && /counted by its launcher/.test(out(worker)) && noWhy.status !== 0 && evs.filter((x) => x.type === 'agent.session.end').length === 1,
      `${out(add)}\n${out(worker)}\n${out(noWhy)}\n${JSON.stringify(e)}\n${JSON.stringify(card)}`);
  }

  // ---- 1b. usage import ----
  {
    const f = evFile('import');
    const env = { AGENT_EVENTS_FILE: f };
    const tdir = path.join(tmpRoot, 'transcripts-267i', 'proj');
    fs.mkdirSync(path.join(tdir, 'sess-1', 'subagents'), { recursive: true });
    const SECRET = 'SECRET-CONTENT-267i';
    const asst = (id, model, usage, t, extra = {}) => JSON.stringify({ type: 'assistant', sessionId: 'sess-1', timestamp: `2026-11-07T${t}:00.000Z`, message: { id, model, role: 'assistant', content: [{ type: 'text', text: SECRET }], usage }, ...extra });
    const main = path.join(tdir, 'sess-1.jsonl');
    fs.writeFileSync(main, [
      JSON.stringify({ type: 'user', sessionId: 'sess-1', message: { role: 'user', content: SECRET } }),
      asst('msg_a', 'claude-opus-4-5', { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } }, '10:00'),
      asst('msg_a', 'claude-opus-4-5', { input_tokens: 10, output_tokens: 5, cache_creation_input_tokens: 100, cache_read_input_tokens: 1000, cache_creation: { ephemeral_5m_input_tokens: 100, ephemeral_1h_input_tokens: 0 } }, '10:00'),
      'not json {',
      asst('msg_b', 'claude-opus-4-5', { input_tokens: 20, output_tokens: 30, cache_creation_input_tokens: 0, cache_read_input_tokens: 2000 }, '10:05'),
    ].join('\n') + '\n');
    fs.writeFileSync(path.join(tdir, 'sess-1', 'subagents', 'agent-ax1.jsonl'), asst('msg_c', 'claude-haiku-4-5', { input_tokens: 7, output_tokens: 3, cache_read_input_tokens: 50 }, '10:03', { isSidechain: true, agentId: 'ax1' }) + '\n');
    const i1 = run(dir, `node harness/usage.mjs import "${path.dirname(tdir)}" --agent opus-bot`, { ...base, ...env });
    const ev1 = readEv(f).filter((x) => x.type === 'agent.session.end');
    const i2 = run(dir, `node harness/usage.mjs import "${path.dirname(tdir)}" --agent opus-bot`, { ...base, ...env });
    const n2 = readEv(f).filter((x) => x.type === 'agent.session.end').length;
    fs.appendFileSync(main, asst('msg_d', 'claude-opus-4-5', { input_tokens: 1, output_tokens: 2 }, '11:00') + '\n');
    const i3 = run(dir, `node harness/usage.mjs import "${main}" --agent opus-bot`, { ...base, ...env });
    const ev3 = readEv(f).filter((x) => x.type === 'agent.session.end');
    const opus = ev1.find((x) => x.model === 'claude-opus-4-5'); const haiku = ev1.find((x) => x.model === 'claude-haiku-4-5');
    const last = ev3[ev3.length - 1];
    const raw = (() => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } })();
    report('2.67.0 (i, 1): npm run usage -- import records each Claude Code session (and each subagent file) per model once: a message repeated per content block counts once, a re-import records nothing, a grown session only its growth; no message text is printed or stored',
      i1.status === 0 && ev1.length === 2 && opus?.tokensIn === 130 && opus?.tokensOut === 35 && opus?.meta?.cacheRead === 3000 && opus?.meta?.cacheWrite === 100 && opus?.meta?.cacheWrite5m === 100 && opus?.meta?.outside === true && opus?.ts === '2026-11-07T10:05:00.000Z'
        && haiku?.tokensIn === 7 && haiku?.tokensOut === 3 && haiku?.meta?.subagent === 'ax1' && /2 session\(s\) \(1 subagent\)/.test(out(i1))
        && i2.status === 0 && n2 === 2 && /0 session\(s\)/.test(out(i2)) && /2 already imported/.test(out(i2))
        && i3.status === 0 && ev3.length === 3 && last.tokensIn === 1 && last.tokensOut === 2 && last.meta?.lastMessageId === 'msg_d'
        && ![out(i1), out(i2), out(i3), raw].some((s) => s.includes(SECRET)),
      `${out(i1)}\n${out(i2)}\n${out(i3)}\n${JSON.stringify(ev3).slice(0, 1500)}`);
  }

  // ---- 1c. orchestrator interventions ----
  {
    const ev = [
      { ts: at(100), type: 'supervisor.start', agent: 'supervisor' },
      { ts: at(50), type: 'conductor.note', agent: 'opus-bot', task: 'T-2', meta: { by: 'opus-bot' } },
      { ts: at(49), type: 'lanes.refresh.ok', agent: 'opus-bot', task: 'T-3' },
      { ts: at(48), type: 'task.train.released', agent: 'opus-bot', task: 'T-4', meta: { by: 'dana', permission: 'dana on chat: release T-4', recordedBy: 'opus-bot', tier: 'C' } },
      { ts: at(47), type: 'task.hold', agent: 'opus-bot', task: 'T-6', msg: 'Held T-6: waits for T-4' },
      { ts: at(46), type: 'task.hold', agent: 'dana', task: 'T-7', msg: 'Held T-7' },
      { ts: at(45), type: 'task.hold', agent: 'builder-s2', task: 'T-8', msg: 'Held T-8' },
      { ts: at(44), type: 'task.hold', agent: 'supervisor', task: 'T-9', msg: 'Held T-9' },
      { ts: at(43), type: 'task.done', agent: 'builder-a1', task: 'T-1' },
    ];
    const c = probe('orch', `import { buildAutonomy, autonomyLine, levelBadge, personClassifier } from ${u('harness/autonomy.mjs')};
const c = buildAutonomy(${JSON.stringify(ev)}, { now: ${NOW}, days: 7, isPersonName: await personClassifier() });
console.log(JSON.stringify({ o: c.orchestrator, line: autonomyLine(c, levelBadge(c)), unplanned: c.interventions.unplanned }));`);
    report('2.67.0 (i, 1): an outside orchestrator\'s conductor notes, lanes refreshes, recorded releases and holds are orchestrator interventions, split planned (3) / unplanned (1); a person\'s own hold, a worker\'s and the harness\'s are not',
      c.o?.conductorNotes === 1 && c.o?.interventions === 4 && c.o?.planned === 3 && c.o?.unplanned === 1 && c.o?.who?.['opus-bot'] === 4 && c.o?.byType?.['task.hold'] === 1 && /4 orchestrator interventions/.test(c.line || ''),
      JSON.stringify(c));
  }

  // ---- 2. default prices ----
  {
    const pf = path.join(dir, 'studio', 'prices.json');
    const shipped = (() => { try { return JSON.parse(fs.readFileSync(pf, 'utf8')); } catch { return null; } })();
    const ev = [
      { ts: at(30), type: 'agent.session.end', agent: 'b-1', model: 'claude-opus-4-5', tokensIn: 1000000, tokensOut: 100000, meta: { tool: 'claude' } },
      { ts: at(29), type: 'task.done', agent: 'b-1', task: 'T-1' },
    ];
    const c = probe('prices', `import { buildAutonomy, personClassifier, readPrices, readPriceInfo, readPriceMultipliers, priceFor } from ${u('harness/autonomy.mjs')};
const prices = readPrices(); const info = readPriceInfo();
const c = buildAutonomy(${JSON.stringify(ev)}, { now: ${NOW}, days: 7, isPersonName: await personClassifier(), prices, priceInfo: info, priceMultipliers: readPriceMultipliers(), weigh: (e) => e.tokensIn + e.tokensOut });
console.log(JSON.stringify({ info, cost: c.cost, fam: [priceFor(prices, 'claude-sonnet-4-5-20250929', 'claude')?.in, priceFor(prices, 'claude-haiku-4-5', null)?.in, priceFor(prices, 'mystery-model', 'custom')] }));`);
    const fams = shipped?.models || {};
    const rowsOk = ['opus', 'sonnet', 'haiku'].every((k) => Number(fams[k]?.in) > 0 && Number(fams[k]?.out) > 0 && Number(fams[k]?.cacheRead) >= 0) && shipped?.multipliers?.cacheWrite5m === 1.25 && shipped?.multipliers?.cacheWrite1h === 2;
    const want = (Number(fams.opus?.in) * 1 + Number(fams.opus?.out) * 0.1);
    report('2.67.0 (i, 2): studio/prices.json ships opus / sonnet / haiku rows (input, output, cache read) with the write multipliers and a "checked" stamp; a full model id is priced by its family; the card says "prices from studio/prices.json, checked …"',
      rowsOk && typeof shipped?.checked === 'string' && c.info?.checked === shipped.checked && c.cost?.priced === true && Math.abs(c.cost?.dollars - Math.round(want * 100) / 100) < 0.011
        && /prices from studio\/prices\.json, checked /.test(c.cost?.note || '') && c.fam?.[0] === fams.sonnet?.in && c.fam?.[1] === fams.haiku?.in && c.fam?.[2] === null,
      JSON.stringify({ shipped, c }).slice(0, 2000));
  }

  // ---- 3. risk tiers from the train's tier events ----
  {
    const ev = [
      { ts: at(60), type: 'task.start', agent: 'builder-a1', task: 'T-1' }, { ts: at(59), type: 'task.start', agent: 'builder-a2', task: 'T-2' }, { ts: at(58), type: 'task.start', agent: 'builder-a3', task: 'T-3' },
      { ts: at(50), type: 'task.train.tier', agent: 'train', task: 'T-1', meta: { train: 'R-1', tier: 'A', released: null } },
      { ts: at(50), type: 'task.train.tier', agent: 'train', task: 'T-2', meta: { train: 'R-1', tier: 'C', released: null } },
      { ts: at(50), type: 'task.train.held', agent: 'train', task: 'T-2', meta: { train: 'R-1', tier: 'C' } },
      { ts: at(40), type: 'task.train.released', agent: 'opus-bot', task: 'T-2', meta: { by: 'dana', tier: 'C', permission: 'dana on chat: land T-2', recordedBy: 'opus-bot' } },
      { ts: at(30), type: 'task.train.tier', agent: 'train', task: 'T-2', meta: { train: 'R-2', tier: 'C', released: 'dana' } },
      { ts: at(30), type: 'task.train.tier', agent: 'train', task: 'T-3', meta: { train: 'R-2', tier: 'B', released: null } },
      { ts: at(29), type: 'task.train.landed', agent: 'train', meta: { train: 'R-2', lanes: ['T-1', 'T-2', 'T-3'] } },
    ];
    const bad = [...ev, { ts: at(20), type: 'task.start', agent: 'builder-a4', task: 'T-4' }, { ts: at(19), type: 'task.train.tier', agent: 'train', task: 'T-4', meta: { train: 'R-3', tier: 'C', released: null } }, { ts: at(18), type: 'task.train.landed', agent: 'train', meta: { train: 'R-3', lanes: ['T-4'] } }];
    const c = probe('tiers', `import { buildAutonomy, l3Checks, personClassifier } from ${u('harness/autonomy.mjs')};
const isPersonName = await personClassifier();
const a = buildAutonomy(${JSON.stringify(ev)}, { now: ${NOW}, days: 7, isPersonName });
const b = buildAutonomy(${JSON.stringify(bad)}, { now: ${NOW}, days: 7, isPersonName });
const chk = l3Checks(a).find((x) => x.id === 'tierCUnsigned');
console.log(JSON.stringify({ a: a.tierCUnsigned, tiers: a.tiers, b: b.tierCUnsigned, chk }));`);
    report('2.67.0 (i, 3): the L3 bar\'s tierCUnsigned reads the train\'s task.train.tier events (it showed n/a): 0 when the tier-C lane was released before it landed, 1 for a tier-C landing with no release; the bar shows the tier counts',
      c.a === 0 && c.b === 1 && c.tiers?.A === 1 && c.tiers?.B === 1 && c.tiers?.C === 1 && c.tiers?.rows?.[0]?.releasedBy === 'dana' && c.chk?.na === false && /A 1, B 1, C 1/.test(c.chk?.value || ''),
      JSON.stringify(c));
  }

  // ---- 4. a stale halt ----
  {
    const realNow = Date.now();
    const rat = (h) => new Date(realNow - h * 3600000).toISOString();
    const haltEvs = (h) => [
      { ts: rat(h + 10), type: 'supervisor.start', agent: 'supervisor' },
      { ts: rat(h), type: 'supervisor.halted', agent: 'supervisor', status: 'blocked', msg: 'Supervisor stopped starting agents: two sessions in a row ended with exit 127 (b-s1, b-s2): fake-tool wasn\'t found' },
    ];
    const fOld = evFile('halt-old'); const fYoung = evFile('halt-young'); const fPerm = evFile('halt-perm');
    fs.writeFileSync(fOld, haltEvs(30).map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(fYoung, haltEvs(2).map((x) => JSON.stringify(x)).join('\n') + '\n');
    fs.writeFileSync(fPerm, haltEvs(40).map((x) => JSON.stringify(x)).join('\n') + '\n');
    const cardOf = (f, name) => probe(name, `import { buildAutonomy, personClassifier } from ${u('harness/autonomy.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const c = buildAutonomy(readRecentEvents(1000), { now: Date.now() + 60000, days: 7, isPersonName: await personClassifier(), supervisorRunning: false });
console.log(JSON.stringify({ hw: c.haltWait, i: c.interventions, o: c.orchestrator }));`, { AGENT_EVENTS_FILE: f });
    const before = cardOf(fOld, 'halt-before');
    const worker = run(dir, 'node harness/supervisor.mjs resume --by dana --why "leftover"', { ...base, AGENT_EVENTS_FILE: fOld, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s1' });
    const res = run(dir, 'node harness/supervisor.mjs resume --by dana --why "leftover from the crash"', { ...base, AGENT_EVENTS_FILE: fOld });
    const after = cardOf(fOld, 'halt-after');
    const young = run(dir, 'node harness/supervisor.mjs resume --by dana', { ...base, AGENT_EVENTS_FILE: fYoung });
    const perm = run(dir, 'node harness/supervisor.mjs resume --by dana --permission "dana on chat 11-02: clear that old halt"', { ...base, AGENT_EVENTS_FILE: fPerm, STUDIO_LOCK_OWNER: 'opus-bot' });
    const permCard = cardOf(fPerm, 'halt-perm');
    const cleared = readEv(fOld).find((x) => x.type === 'supervisor.halt_cleared');
    const pc = readEv(fPerm).find((x) => x.type === 'supervisor.halt_cleared');
    const oh = before.hw?.openHalt;
    report('2.67.0 (i, 4): the card names the open halt (who, when, cause, how to clear: stale, studio:resume); studio:resume clears a halt older than STUDIO_HALT_STALE_H whose supervisor isn\'t running and the card stops counting it as waiting; a younger one is left alone; a worker is refused; an outside agent clears it on a person\'s recorded permission',
      before.hw?.open === 1 && oh?.who === 'supervisor' && /exit 127/.test(oh?.cause || '') && oh?.stale === true && oh?.ageH >= 29.9 && /studio:resume/.test(oh?.clear || '') && /^\d{4}-\d\d-\d\d \d\d:\d\d/.test(oh?.atLocal || '')
        && worker.status !== 0 && res.status === 0 && /Cleared a stale halt/.test(out(res)) && cleared?.meta?.by === 'dana' && cleared?.meta?.stale === true
        && after.hw?.open === 0 && !after.hw?.openHalt && after.i?.planned === 1
        && young.status === 0 && /Not cleared/.test(out(young)) && !readEv(fYoung).some((x) => x.type === 'supervisor.halt_cleared')
        && perm.status === 0 && pc?.agent === 'opus-bot' && pc?.meta?.recordedBy === 'opus-bot' && pc?.meta?.by === 'dana' && permCard.hw?.open === 0 && permCard.o?.interventions === 1,
      `${JSON.stringify(before).slice(0, 1200)}\n${out(worker)}\n${out(res)}\n${JSON.stringify(after).slice(0, 600)}\n${out(young)}\n${out(perm)}\n${JSON.stringify(permCard).slice(0, 600)}`);
  }

  // ---- 5. local days ----
  {
    const f = evFile('days');
    const ev = [
      { ts: '2026-11-01T18:30:00.000Z', type: 'task.start', agent: 'builder-a1', task: 'T-1' },
      { ts: '2026-11-01T18:45:00.000Z', type: 'task.done', agent: 'builder-a1', task: 'T-1' },
      { ts: '2026-11-01T10:00:00.000Z', type: 'task.done', agent: 'builder-a2', task: 'T-2' },
    ];
    fs.writeFileSync(f, ev.map((x) => JSON.stringify(x)).join('\n') + '\n');
    const code = `import { buildAutonomy, personClassifier } from ${u('harness/autonomy.mjs')};
const c = buildAutonomy(${JSON.stringify(ev)}, { now: ${NOW}, days: 7, isPersonName: await personClassifier() });
console.log(JSON.stringify({ zone: c.zone, days: c.buckets.map((b) => [b.day, b.landed, b.utc || null]), t1: c.tasks.find((t) => t.task === 'T-1') }));`;
    const bkk = probe('days-bkk', code, { STUDIO_TZ: 'Asia/Bangkok' });
    const utc = probe('days-utc', code, { STUDIO_TZ: '', TZ: 'Asia/Bangkok' });
    const cli = run(dir, 'node harness/autonomy.mjs --now 2026-11-08T00:00:00Z', { ...base, AGENT_EVENTS_FILE: f, STUDIO_TZ: 'Asia/Bangkok' });
    const d2 = (bkk.days || []).find((x) => x[0] === '2026-11-02'); const d1 = (bkk.days || []).find((x) => x[0] === '2026-11-01');
    const u1 = (utc.days || []).find((x) => x[0] === '2026-11-01');
    report('2.67.0 (i, 5): with STUDIO_TZ the daily rows are local calendar days (a landing at 01:45 local on 11-02 is 11-02\'s, not 11-01\'s) with their UTC span, and a landing time is local with its UTC date when that differs; without it, UTC days as before (TZ alone only feeds the "set STUDIO_TZ" hint)',
      bkk.zone?.zone === 'Asia/Bangkok' && d2?.[1] === 1 && d1?.[1] === 1 && /2026-11-01 17:00 to 2026-11-02 17:00 UTC/.test(d2?.[2] || '') && bkk.t1?.landedLocal === '2026-11-02 01:45 +07:00' && bkk.t1?.landedUtcDate === '2026-11-01'
        && utc.zone?.zone === 'UTC' && utc.zone?.machine === 'Asia/Bangkok' && u1?.[1] === 2 && u1?.[2] === null && utc.days?.length === 7 && !utc.t1?.landedUtcDate
        && cli.status === 0 && /Days \(local, Asia\/Bangkok/.test(out(cli)) && /2026-11-02 \(2026-11-01 17:00 to 2026-11-02 17:00 UTC\): .*1 landed/.test(out(cli)),
      `${JSON.stringify({ bkk, utc }).slice(0, 2000)}\n${out(cli).slice(-1500)}`);
  }
}

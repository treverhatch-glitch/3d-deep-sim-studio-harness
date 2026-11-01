/**
 * qa/selftest-266a.mjs — 2.66.0 (helper a): tokens that do work (research 2026-11-02, metrics M1; dev plan row
 * "Effective-token ratio"). A made-up event log; every number below is worked out by hand in the comments.
 *   1: a landing is kept, pending, reopened or reverted/redone (a revert commit naming it, a train hand-back after it
 *      landed, a task added --caused-by it or titled "Redo of <it>"), judged over keepDays.
 *   2: the waste split: each session's tokens and dollars go to the attempts it held (shared by wall time): kept,
 *      reopened, reverted or redone, handed back, dropped, no task; pending apart.
 *   3: the effective-token ratio (kept / judged tokens) and the cost per kept change, overall and per task type.
 *   4: any rate on fewer than minSample (30) items reads "not enough data (n=…)" with a Wilson 95% interval.
 *   5: the CLI: --since sets the window, --json carries card.tokenWork, the text has a "Tokens" block;
 *      STUDIO_KEEP_DAYS changes keepDays.
 *   6: revert commits are read from git (`Revert "…"` subjects) and name a task as a whole word (T-1 is not T-12).
 *   6b: a session end that names its task (meta.task) holds that task's attempt (one agent name, two parallel tasks).
 *   7: keepDays / minSample come from studio/autonomy.json (STUDIO_KEEP_DAYS first).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest266A({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const events = path.join(dir, '.studio', 'events-266a.jsonl');
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_ROLE: '', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_CACHE_READ_WEIGHT: '', STUDIO_KEEP_DAYS: '', STUDIO_AUTONOMY_CACHE_S: '0', AGENT_EVENTS_FILE: events };
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p266a-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...base, ...env });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-1500) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  const near = (a, b, eps = 1e-6) => typeof a === 'number' && Math.abs(a - b) < eps;

  // ---- The made-up log: 10 days from t0, keepDays 7, judged at the window's end (day 10) ----
  const D = 86400000; const t0 = Date.parse('2026-10-01T00:00:00Z');
  const at = (d, h = 0) => new Date(t0 + d * D + h * 3600000).toISOString();
  const ev = [];
  const add = (task, title, d, meta = undefined) => ev.push({ ts: at(d), type: 'task.added', agent: 'producer-a', task, msg: `Queued ${task} [P1] (builder): ${title}`, ...(meta ? { meta } : {}) });
  const start = (task, agent, d, h = 0) => ev.push({ ts: at(d, h), type: 'task.start', agent, task });
  const done = (task, agent, d, h) => ev.push({ ts: at(d, h), type: 'task.done', agent, task, status: 'done' });
  // tokensIn only (no cache reads), and each session reports its cost: $1 per 10,000 tokens.
  const sess = (agent, d, h, tin) => ev.push({ ts: at(d, h), type: 'agent.session.end', agent, tokensIn: tin, tokensOut: 0, meta: { costUsd: tin / 10000 } });
  for (const [t, title] of [['T-1', 'Bug: alpha'], ['T-2', 'Add beta'], ['T-3', 'Add gamma'], ['T-4', 'Add delta'], ['T-5', 'Add eps'], ['T-6', 'Add zeta'], ['T-7', 'Add eta'], ['T-8', 'Docs: theta'], ['T-10', 'Add iota'], ['T-11', 'Add kappa'], ['T-12', 'Add lambda']]) add(t, title, 0);
  start('T-1', 'b1', 1); done('T-1', 'b1', 1, 2); sess('b1', 1, 3, 100000); // kept: 100,000 tok, $10 (bug)
  start('T-2', 'b2', 1); ev.push({ ts: at(1, 1), type: 'task.paused', agent: 'b2', task: 'T-2', msg: 'Handed back T-2: stuck' }); sess('b2', 1, 2, 40000); // handed back: 40,000, $4
  start('T-2', 'b3', 1, 4); done('T-2', 'b3', 1, 5); sess('b3', 1, 6, 60000); // kept: 60,000, $6
  // One session, two attempts: T-8 1 h (kept), T-10 3 h (handed back): 40,000 split 10,000 / 30,000, $1 / $3.
  start('T-8', 'b9', 1); done('T-8', 'b9', 1, 1); start('T-10', 'b9', 1, 1); ev.push({ ts: at(1, 4), type: 'task.paused', agent: 'b9', task: 'T-10', msg: 'Handed back T-10: blocked' }); sess('b9', 1, 5, 40000);
  start('T-3', 'b4', 2); done('T-3', 'b4', 2, 1); sess('b4', 2, 2, 30000); // reopened on day 4: 30,000, $3
  start('T-4', 'b5', 2); done('T-4', 'b5', 2, 1); sess('b5', 2, 2, 20000); // reverted on day 3 (git): 20,000, $2
  start('T-5', 'b6', 2); done('T-5', 'b6', 2, 1); sess('b6', 2, 2, 10000); // a bug --caused-by it on day 3: 10,000, $1
  start('T-6', 'b7', 2); ev.push({ ts: at(2, 1), type: 'task.dropped', agent: 'producer-a', task: 'T-6', msg: 'Dropped T-6' }); sess('b7', 2, 2, 5000); // dropped: 5,000, $0.5
  start('T-11', 'b10', 2); done('T-11', 'b10', 2, 1); sess('b10', 2, 2, 7000); // train hand-back on day 3: 7,000, $0.7
  start('T-12', 'b11', 2); done('T-12', 'b11', 2, 1); sess('b11', 2, 2, 3000); // "Redo of T-12" added day 4: 3,000, $0.3
  ev.push({ ts: at(3), type: 'task.added', agent: 'producer-a', task: 'T-9', msg: 'Queued T-9 [P1] (builder): Fix: crash after eps', meta: { causedBy: 'T-5' } });
  ev.push({ ts: at(3, 2), type: 'task.paused', agent: 'train', task: 'T-11', msg: 'Handed back T-11: Not landed by merge train tr-9: a conflict with main' });
  ev.push({ ts: at(4), type: 'task.reopened', agent: 'hatch', task: 'T-3', msg: 'Reopened T-3: wrong' });
  ev.push({ ts: at(4, 1), type: 'task.added', agent: 'producer-a', task: 'T-14', msg: 'Queued T-14 [P1] (builder): Redo of T-12: again' });
  sess('prod', 5, 0, 15000); // a Producer session holding no task: no task, 15,000, $1.5
  // T-7: handed back on day 5, then landed day 6 (+ 7 > day 10): both pending (the hand-back waits for its task's
  // landing to be judged): 4,000 + 8,000, $0.4 + $0.8. T-15: handed back day 8, not landed yet (+ 7 > day 10): pending,
  // 2,000, $0.2.
  start('T-7', 'b12', 5); ev.push({ ts: at(5, 1), type: 'task.paused', agent: 'b12', task: 'T-7', msg: 'Handed back T-7: tests red' }); sess('b12', 5, 2, 4000);
  start('T-7', 'b8', 6); done('T-7', 'b8', 6, 1); sess('b8', 6, 2, 8000);
  add('T-15', 'Add mu', 7); start('T-15', 'b13', 8); ev.push({ ts: at(8, 1), type: 'task.paused', agent: 'b13', task: 'T-15', msg: 'Handed back T-15: unclear' }); sess('b13', 8, 2, 2000);
  const reverts = [{ at: t0 + 3 * D, subject: 'Revert "T-4: add delta"' }, { at: t0 + 3 * D, subject: 'Revert "T-100: something else"' }];
  const now = t0 + 10 * D;
  fs.mkdirSync(path.dirname(events), { recursive: true });

  const card = probe(`import { buildAutonomy } from ${u('harness/autonomy.mjs')};
const c = buildAutonomy(${JSON.stringify(ev)}, { now: ${now}, days: 10, isPersonName: (x) => x === 'hatch', reverts: ${JSON.stringify(reverts)} });
console.log(JSON.stringify({ w: c.tokenWork ?? null, five: buildAutonomy(${JSON.stringify(ev)}, { now: ${now}, days: 10, isPersonName: (x) => x === 'hatch', reverts: ${JSON.stringify(reverts)}, minSample: 5 }).tokenWork?.effectiveTokenRatio ?? null }));`);
  const w = card.w || null;
  const fates = Object.fromEntries((w?.landings || []).map((l) => [l.task, l.fate]));

  // ---- 1. fates ----
  report('2.66.0 (a, 1): a landing is kept when nothing undid it within keepDays (7); younger than that it is pending; reopened, reverted (a `Revert "T-4: …"` commit; "T-100" does not name T-1), handed back by the train after landing, a bug --caused-by it, or a task titled "Redo of <it>" are not kept',
    w && fates['T-1'] === 'kept' && fates['T-2'] === 'kept' && fates['T-8'] === 'kept' && fates['T-7'] === 'pending' && fates['T-3'] === 'reopened'
      && fates['T-4'] === 'revertedOrRedone' && fates['T-5'] === 'revertedOrRedone' && fates['T-11'] === 'revertedOrRedone' && fates['T-12'] === 'revertedOrRedone'
      && w.landed === 9 && w.kept === 3 && w.pendingLandings === 1 && w.keepDays === 7,
    JSON.stringify({ fates, landed: w?.landed, kept: w?.kept, pending: w?.pendingLandings, out: card._out }));

  // ---- 2. the waste split (tokens and $) ----
  // kept 100,000 + 60,000 + 10,000 = 170,000 ($17); handed back 40,000 + 30,000 = 70,000 ($7); reopened 30,000 ($3);
  // reverted or redone 20,000 + 10,000 + 7,000 + 3,000 = 40,000 ($4); dropped 5,000 ($0.5); no task 15,000 ($1.5);
  // pending 4,000 + 8,000 + 2,000 = 14,000 ($1.4). All 344,000 ($34.4); judged (all minus pending) 330,000 ($33).
  const b = w?.buckets || {};
  const bk = (k, tok, usd) => b[k]?.tokens === tok && near(b[k]?.usd, usd);
  report('2.66.0 (a, 2): the waste split by hand: kept 170k/$17, reopened 30k/$3, reverted or redone 40k/$4, handed back 70k/$7 (one session shared 1 h : 3 h between a kept and a handed-back attempt), dropped 5k/$0.5, no task 15k/$1.5; pending 14k/$1.4 apart (a landing younger than keepDays, the hand-back before it, a young hand-back with no landing yet); 344k/$34.4 in all, 330k/$33 judged',
    w && bk('kept', 170000, 17) && bk('reopened', 30000, 3) && bk('revertedOrRedone', 40000, 4) && bk('handedBack', 70000, 7) && bk('dropped', 5000, 0.5) && bk('noTask', 15000, 1.5) && bk('pending', 14000, 1.4)
      && w.tokens === 344000 && near(w.dollars, 34.4) && w.judgedTokens === 330000 && near(w.judgedDollars, 33) && w.sessions === 14 && w.judgedSessions === 11,
    JSON.stringify({ buckets: b, tokens: w?.tokens, dollars: w?.dollars, judged: w?.judgedTokens, sessions: w?.sessions }));

  // ---- 3. ETR and cost per kept change ----
  // ETR = 170,000 / 330,000 = 0.5152 (dollars 17 / 33 = 0.5152). Per kept change: 330,000 / 3 = 110,000 tokens, $33 / 3 = $11.
  // Per type (pending and no-task left out): bug 100,000 / 1 kept ($10); docs 10,000 / 1 ($1);
  // change 40,000 + 60,000 + 30,000 + 30,000 + 20,000 + 10,000 + 5,000 + 7,000 + 3,000 = 205,000 / 1 kept ($20.5).
  const pt = w?.perType || {};
  report('2.66.0 (a, 3): effective-token ratio 170k / 330k judged = 0.5152 (by dollars 17 / 33 too); cost per kept change 110,000 tokens and $11 (330k, $33 over 3 kept); per type: bug 100,000 / $10, docs 10,000 / $1, change 205,000 / $20.5 per kept change',
    w && w.effectiveTokenRatio?.tokenRatio === 0.5152 && w.effectiveTokenRatio?.dollarRatio === 0.5152 && w.costPerKept?.tokens === 110000 && near(w.costPerKept?.dollars, 11)
      && pt.bug?.tokensPerKept === 100000 && near(pt.bug?.dollarsPerKept, 10) && pt.docs?.tokensPerKept === 10000 && near(pt.docs?.dollarsPerKept, 1)
      && pt.change?.kept === 1 && pt.change?.tokens === 205000 && pt.change?.tokensPerKept === 205000 && near(pt.change?.dollarsPerKept, 20.5),
    JSON.stringify({ etr: w?.effectiveTokenRatio, cost: w?.costPerKept, perType: pt }));

  // ---- 4. minimum sample + Wilson ----
  // Wilson 95%: 5 of 10 -> [0.2366, 0.7634]; 0 of 10 -> [0, 0.2775]. The ETR here rests on 11 judged sessions, the
  // keep rate on 8 judged landings (3 kept): both under 30, so no bare percentage. With minSample 5 the ETR shows 51.5%.
  const wl = probe(`import { wilson, sampledRate } from ${u('harness/autonomy.mjs')};
console.log(JSON.stringify({ a: wilson(5, 10), b: wilson(0, 10), s29: sampledRate(10, 29).text, s30: sampledRate(15, 30).text }));`);
  const etrText = String(w?.effectiveTokenRatio?.text || ''); const keepText = String(w?.keepRate?.text || '');
  report('2.66.0 (a, 4): a rate on fewer than 30 items reads "not enough data (n=…)" with its Wilson 95% interval (5/10 -> 23.7%-76.3%, 0/10 -> 0%-27.7%), never a bare percentage: the ETR (n=11 sessions), the keep rate (3 of n=8 landings); 30 items or a lower minSample show the percentage',
    wl.a && near(wl.a[0], 0.23659, 1e-4) && near(wl.a[1], 0.76341, 1e-4) && near(wl.b[0], 0, 1e-9) && near(wl.b[1], 0.27753, 1e-4)
      && /^not enough data \(n=29; 95% interval/.test(wl.s29) && /^50% \(95% interval/.test(wl.s30)
      && /^not enough data \(n=11; 95% interval \d/.test(etrText) && !/^\d/.test(etrText) && /^not enough data \(n=8; 95% interval/.test(keepText) && w.keepRate.k === 3
      && /^51\.5% \(95% interval/.test(String(card.five?.text || '')),
    JSON.stringify({ wl, etrText, keepText, five: card.five }));

  // ---- 5. the CLI: --since, --json, the Tokens block, STUDIO_KEEP_DAYS ----
  // The CLI reads reverts from git (none in this copy), so T-4 is kept here; with STUDIO_KEEP_DAYS=3, T-7 (day 6 + 3 <
  // day 10) is judged kept too (its day-5 hand-back, 4,000, is judged handed back); T-15 (day 8 + 3) stays pending:
  // kept 100,000 + 60,000 + 10,000 + 20,000 + 8,000 = 198,000 of 344,000 - 2,000 = 342,000 judged = 0.5789;
  // 5 kept: 342,000 / 5 = 68,400 tokens per kept change. T-3's reopen (day 4) is within 3 days of day 2.
  fs.writeFileSync(events, ev.map((e) => JSON.stringify(e)).join('\n') + '\n');
  const cj = run(dir, `node harness/autonomy.mjs --json --since ${at(0)} --now ${at(10)}`, { ...base, STUDIO_KEEP_DAYS: '3' });
  let j = null; try { j = JSON.parse(cj.stdout); } catch {}
  const jw = j?.card?.tokenWork;
  const ct = run(dir, `node harness/autonomy.mjs --since ${at(0)} --now ${at(10)}`, base);
  report('2.66.0 (a, 5): npm run autonomy --since <t0> --now <t0+10d> scores 10 days; --json carries card.tokenWork (STUDIO_KEEP_DAYS=3: 5 kept, ETR 198k/342k = 0.5789, 68,400 tokens per kept change); the text has a Tokens block with the waste split and "not enough data (n="',
    cj.status === 0 && j?.card?.window?.days === 10 && jw?.keepDays === 3 && jw?.kept === 5 && jw?.pendingLandings === 0 && jw?.effectiveTokenRatio?.tokenRatio === 0.5789 && jw?.costPerKept?.tokens === 68400 && jw?.buckets?.handedBack?.tokens === 74000 && jw?.buckets?.pending?.tokens === 2000
      && ct.status === 0 && /^Tokens \(kept = landed/m.test(ct.stdout) && /Effective-token ratio \(kept \/ judged tokens\): not enough data \(n=11/.test(ct.stdout) && /Waste: reopened 30k \(\$3\.00\)/.test(ct.stdout) && /handed back 70k \(\$7\.00\)/.test(ct.stdout) && /no task 15k/.test(ct.stdout) && /Pending .*14k tokens/.test(ct.stdout),
    `${JSON.stringify({ days: j?.card?.window?.days, jw: jw && { keepDays: jw.keepDays, kept: jw.kept, etr: jw.effectiveTokenRatio, cost: jw.costPerKept } })}\n${out(cj).slice(-500)}\n${out(ct).slice(-1500)}`);

  // ---- 6. revert commits from git; whole-word task names ----
  const repo = path.join(tmpRoot, `git266a-${process.pid}`);
  fs.mkdirSync(repo, { recursive: true });
  const g = (cmd) => run(repo, `git -c user.name=t -c user.email=t@example.invalid -c commit.gpgsign=false ${cmd}`);
  g('init -q'); fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n'); g('add a.txt'); g('commit -q -m "T-4: add delta"'); g('revert --no-edit HEAD');
  const rv = probe(`import { revertCommits, revertNames, namesTask } from ${u('harness/autonomy.mjs')};
const r = revertCommits(${JSON.stringify(repo)}, 0);
console.log(JSON.stringify({ r, t4: r.length ? revertNames(r[0].subject, 'T-4') : null, t40: r.length ? revertNames(r[0].subject, 'T-40') : null, t1: namesTask('Revert "T-12: x"', 'T-1'), t12: namesTask('Revert "T-12: x"', 'T-12'), plain: revertNames('T-4: add delta', 'T-4') }));`);
  report('2.66.0 (a, 6): revert commits come from git log (`Revert "T-4: add delta"` with its time); a revert names a task as a whole word (T-4 yes, T-40 no; "T-12" is not T-1), and only a "Revert \\"…\\"" subject counts',
    Array.isArray(rv.r) && rv.r.length === 1 && rv.r[0].subject === 'Revert "T-4: add delta"' && rv.r[0].at > 0 && rv.t4 === true && rv.t40 === false && rv.t1 === false && rv.t12 === true && rv.plain === false,
    JSON.stringify(rv));
  try { fs.rmSync(repo, { recursive: true, force: true }); } catch {}

  // ---- 6b. a session end that names its task holds that task's attempt ----
  // One agent name, two tasks claimed in parallel; each session end names its task (meta.task). By time alone both
  // attempts would go to the first end (6,000 + 0) and the second session would be "no task". Named: T-21 (kept) 1,000,
  // T-22 (reopened day 3) 5,000.
  const pv = [];
  pv.push({ ts: at(1), type: 'task.start', agent: 'bx', task: 'T-21' }, { ts: at(1, 1), type: 'task.start', agent: 'bx', task: 'T-22' });
  pv.push({ ts: at(1, 2), type: 'agent.session.end', agent: 'bx', tokensIn: 5000, tokensOut: 0, meta: { task: 'T-22' } });
  pv.push({ ts: at(1, 3), type: 'agent.session.end', agent: 'bx', tokensIn: 1000, tokensOut: 0, meta: { task: 'T-21' } });
  pv.push({ ts: at(1, 4), type: 'task.done', agent: 'bx', task: 'T-21' }, { ts: at(1, 4), type: 'task.done', agent: 'bx', task: 'T-22' }, { ts: at(3), type: 'task.reopened', agent: 'hatch', task: 'T-22' });
  const pc = probe(`import { buildAutonomy } from ${u('harness/autonomy.mjs')};
console.log(JSON.stringify(buildAutonomy(${JSON.stringify(pv)}, { now: ${now}, days: 10, isPersonName: (x) => x === 'hatch' }).tokenWork?.buckets ?? null));`);
  report('2.66.0 (a, 6b): a session end that names its task (meta.task) holds that task\'s attempt, even when one agent name ran two tasks at once: kept 1,000, reopened 5,000, nothing "no task"',
    pc.kept?.tokens === 1000 && pc.reopened?.tokens === 5000 && pc.noTask?.tokens === 0, JSON.stringify(pc));

  // ---- 7. config ----
  const cfgRoot = path.join(tmpRoot, `cfg266a-${process.pid}`);
  fs.mkdirSync(path.join(cfgRoot, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(cfgRoot, 'studio', 'autonomy.json'), JSON.stringify({ level: 'L2', keepDays: 3, minSample: 5 }));
  const cf = (env) => probe(`import { readAutonomyConfig } from ${u('harness/autonomy.mjs')};
const c = readAutonomyConfig(${JSON.stringify(cfgRoot)}); const d = readAutonomyConfig(${JSON.stringify(path.join(tmpRoot, 'no-such-root'))});
console.log(JSON.stringify({ keepDays: c.keepDays, minSample: c.minSample, defKeep: d.keepDays, defMin: d.minSample }));`, env);
  const c1 = cf({}); const c2 = cf({ STUDIO_KEEP_DAYS: '4' });
  report('2.66.0 (a, 7): keepDays and minSample come from studio/autonomy.json ("keepDays": 3, "minSample": 5), STUDIO_KEEP_DAYS (4) wins over the file, defaults 7 and 30',
    c1.keepDays === 3 && c1.minSample === 5 && c1.defKeep === 7 && c1.defMin === 30 && c2.keepDays === 4 && c2.defKeep === 4,
    JSON.stringify({ c1, c2 }));
  try { fs.rmSync(cfgRoot, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(events, { force: true }); } catch {}
}

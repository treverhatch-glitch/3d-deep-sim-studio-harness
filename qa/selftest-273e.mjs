/**
 * qa/selftest-273e.mjs — 2.73.0 (helper e): autonomy, safely: confidence bounds on the L3 bar, audit sampling, and
 * cheap-first routing with the holdout off.
 *   bound      the L3 bar reads one-sided 90% Wilson bounds: 12 of 14 hands-free (0.86) with no reopen doesn't suggest L3
 *              and says how many more landings at this rate would clear it; 40 of 40 does; "confidence": 0 in
 *              studio/autonomy.json gives the old point-estimate verdict.
 *   demote     demotion stays on point estimates: a studio at L3 whose small sample misses the bound but whose rates
 *              hold isn't told to step down; one whose point estimate fails is.
 *   cli        `npm run autonomy` shows "hands-free 0.86 (lower bound 0.70 at 90%, n=14): not yet" and the landings needed.
 *   draw       audits pick hands-free landings and autonomous decisions by a draw seeded with the task / decision id
 *              (the same picks every time, at the policy's "audit.rate"; 0.1 by default while autonomous mode is on, 0
 *              when it is off).
 *   list       picked items are on `npm run decisions -- review` and in the digest; an audit is refused from one who
 *              worked on it (and the deciding agent); a person records it.
 *   redo       a failed audit counts as a Redo in the scorecard's redo rate and the L3 bar; an approved audited
 *              decision counts as a passed audit.
 *   route      cheap-first: a listed type starts on the cheapest tier the policy lists, one tier up per red round, never
 *              a model the policy doesn't list, never changes the model of a task already started; holdout 0 sends none
 *              to the default tier (a seeded share when the owner sets it); the launcher calls it.
 *   stats      success rate and tokens per landed change by type and tier, from session ends; the output says the
 *              holdout is off until API credit is available; `npm run policy` shows audits and routing.
 * A made-up studio (git checkout, events and a decision log of made-up tasks). Each check fails on 2.71.1 (no bound,
 * no harness/audit.mjs, no harness/routing.mjs).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest273E({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const evFile = path.join(dir, '.studio', 'events-273e.jsonl');
  const logFile = path.join(dir, '.studio', 'decisions.jsonl');
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_ROLE: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_AGENT: '', STUDIO_L3_CONFIDENCE: '', STUDIO_TZ: 'UTC',
    STUDIO_TIER_CHEAP_MODEL: '', STUDIO_TIER_MID_MODEL: '', STUDIO_TIER_TOP_MODEL: '', STUDIO_HOOKS_CHECK: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-273e-${process.pid}.pem`),
    AGENT_EVENTS_FILE: evFile, AGENT_EVENTS_MIRROR: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  let n = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(dir, `.probe-273e-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };
  const cli = (cmd, extra = {}) => run(dir, cmd, { ...env, ...extra });
  const DAY = 86400000;
  const NOW = Math.floor(Date.now() / 60000) * 60000;
  const at = (h) => new Date(NOW - h * 3600000).toISOString();
  const writeEvents = (evs) => { fs.mkdirSync(path.dirname(evFile), { recursive: true }); fs.writeFileSync(evFile, evs.map((e) => JSON.stringify(e)).join('\n') + (evs.length ? '\n' : '')); };
  // A week: the log reaches back 8 days, a supervisor ran 7.5 days with no unplanned intervention, `landed` tasks land
  // (the first `handsFree` of them with no person on them; the others had a person's unblock between claim and land).
  const week = (landed, handsFree, { reopen = 0, prefix = 'T-' } = {}) => {
    const ev = [{ ts: at(8 * 24), type: 'hub.boot', agent: 'hub' }, { ts: at(7.5 * 24), type: 'supervisor.start', agent: 'supervisor' }];
    for (let i = 1; i <= landed; i++) {
      const h = 7 * 24 - (i * 160) / landed;
      const id = `${prefix}${100 + i}`;
      ev.push({ ts: at(h), type: 'task.start', agent: `builder-a${i}`, task: id });
      if (i > handsFree) ev.push({ ts: at(h - 0.2), type: 'task.unblocked', agent: 'dana', task: id });
      ev.push({ ts: at(h - 0.5), type: 'task.done', agent: `builder-a${i}`, task: id });
      if (i <= reopen) ev.push({ ts: at(h - 1), type: 'task.reopened', agent: 'dana', task: id });
    }
    return ev.sort((a, b) => a.ts.localeCompare(b.ts));
  };
  const autonomyFile = path.join(dir, 'studio', 'autonomy.json');
  const autonomyBefore = fs.existsSync(autonomyFile) ? fs.readFileSync(autonomyFile, 'utf8') : null;
  const score = (evs, cfg = '{}', extra = {}) => probe(`import { buildAutonomy, levelBadge, personClassifier, DEFAULT_AUTONOMY } from ${u('harness/autonomy.mjs')};
const isPersonName = await personClassifier();
const c = buildAutonomy(${JSON.stringify(evs)}, { now: ${NOW}, days: 7, isPersonName });
const b = levelBadge(c, { ...DEFAULT_AUTONOMY, ...${cfg} });
console.log(JSON.stringify({ landed: c.landed, hf: c.handsFreeLandRate, reopen: c.reopenRate, hb: c.hoursBetweenInterventions, meets: b.meets, kind: b.suggestion.kind, text: b.suggestion.text, confidence: b.confidence, checks: b.checks }));`, extra);
  const chk = (s, id) => (s.checks || []).find((c) => c.id === id) || {};

  // ---- 1. bounds ----
  const w14 = week(14, 12);
  await guard('273e bound: the L3 bar reads one-sided 90% Wilson bounds: 12 of 14 hands-free (0.86, lower bound 0.70) with no reopen (upper bound 0.11) doesn\'t suggest L3 and says how many more landings at this rate would clear each; 40 of 40 does; "confidence": 0 gives the old point-estimate verdict (fails on 2.71.1: point estimates, so 14 landings at 0.86 suggest L3)', () => {
    const d = score(w14);
    const z = score(w14, '{ "confidence": 0 }');
    const big = score(week(40, 40));
    const hf = chk(d, 'handsFreeLandRate'); const ro = chk(d, 'reopenRate');
    return [d.landed === 14 && d.hb > 8 && d.confidence === 0.9 && d.meets === 'L2' && d.kind === null
      && hf.ok === false && hf.pointOk === true && Math.abs(hf.bound - 0.7002) < 0.001 && hf.more === 67 && /hands-free 0\.86 \(lower bound 0\.70 at 90%, n=14\): not yet; about 67 more landings at this rate would clear it/.test(hf.value)
      && ro.ok === false && ro.pointOk === true && ro.more === 18 && /reopened 0\.00 \(upper bound 0\.11 at 90%, n=14\): not yet/.test(ro.value)
      && z.confidence === 0 && z.meets === 'L3' && z.kind === 'promote'
      && big.meets === 'L3' && big.kind === 'promote' && /90% bound/.test(big.text), JSON.stringify({ d, z: { meets: z.meets, kind: z.kind, c: z.confidence }, big: { meets: big.meets, kind: big.kind, out: big._out } }).slice(0, 3000)];
  });

  await guard('273e demote: demotion stays on point estimates: at L3, a small sample that misses the bound with every rate holding gets no demotion; a point estimate under the bar does (fails on 2.71.1: no bound, so the checks carry no point/bound verdicts)', () => {
    const hold = score(w14, '{ "level": "L3" }');
    const fail = score(week(14, 10), '{ "level": "L3" }');
    return [hold.meets === 'L2' && hold.kind === null && chk(hold, 'handsFreeLandRate').pointOk === true && chk(hold, 'handsFreeLandRate').ok === false
      && fail.kind === 'demote' && /handsFreeLandRate 71\.4% \(bar: at least 80%\)/.test(fail.text) && !/reopenRate/.test(fail.text), JSON.stringify({ hold: { meets: hold.meets, kind: hold.kind }, fail: { kind: fail.kind, text: fail.text, out: fail._out } }).slice(0, 2000)];
  });

  await guard('273e cli: `npm run autonomy` prints "hands-free 0.86 (lower bound 0.70 at 90%, n=14): not yet" with the landings needed and no L3 suggestion; with "confidence": 0 in studio/autonomy.json it meets the bar as before (fails on 2.71.1: the bar prints 85.7% and suggests L3)', () => {
    writeEvents(w14);
    const a = cli(`node harness/autonomy.mjs --now ${new Date(NOW).toISOString()}`);
    const cfg = JSON.parse(autonomyBefore || '{}');
    fs.writeFileSync(autonomyFile, JSON.stringify({ ...cfg, confidence: 0 }, null, 2));
    const b = cli(`node harness/autonomy.mjs --now ${new Date(NOW).toISOString()}`);
    if (autonomyBefore === null) fs.rmSync(autonomyFile, { force: true }); else fs.writeFileSync(autonomyFile, autonomyBefore);
    return [a.status === 0 && /MISS handsFreeLandRate: hands-free 0\.86 \(lower bound 0\.70 at 90%, n=14\): not yet; about 67 more landings at this rate would clear it/.test(a.stdout) && /one-sided 90% Wilson bound/.test(a.stdout) && !/suggest L3/.test(a.stdout) && /hands-free 86% \(lower bound 70% at 90%\) of 14 landed/.test(a.stdout)
      && b.status === 0 && /meets the L3 bar/.test(b.stdout) && /suggest L3 \(your call\)/.test(b.stdout) && /point estimates \("confidence": 0\)/.test(b.stdout), `${out(a).slice(-2000)}\n---\n${out(b).slice(-1200)}`];
  });

  // ---- 2. audits: a git studio whose policy counts (committed by a person, no owner key) ----
  for (const f of ['studio/policy.json', '.studio/decisions.jsonl', '.studio/autonomy-paused.json', '.studio/policy-proposal.json', 'studio/delegation.json']) fs.rmSync(path.join(dir, f), { force: true });
  if (!fs.existsSync(path.join(dir, '.git'))) { g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify'); }
  const setPolicy = (doc) => { fs.writeFileSync(path.join(dir, 'studio', 'policy.json'), JSON.stringify(doc, null, 2)); g(dir, 'add', 'studio/policy.json'); g(dir, 'commit', '-qm', 'policy (owner)', '--no-verify'); };
  const OV = 'overseer-bot';
  const auto = { allowed: true, agent: OV, actions: ['type', 'hold'], reviewWithinH: 72, by: 'dana', at: at(24 * 9) };
  const draw = (seed) => parseInt(crypto.createHash('sha256').update(`studio-audit|${seed}`).digest('hex').slice(0, 13), 16) / 2 ** 52;
  const aw = week(20, 20, { prefix: 'T-' });
  const decIds = Array.from({ length: 12 }, (_, i) => `D-test273e${i}`);
  const decs = decIds.map((id, i) => ({ kind: 'decision', id, at: at(24 * 3 + i), action: 'type', subject: `T-${300 + i}`, by: OV, as: 'autonomous', why: 'judged from the diff', evidence: 'only docs changed', undo: { kind: 'text', text: 'by hand' } }));
  fs.mkdirSync(path.dirname(logFile), { recursive: true });
  fs.writeFileSync(logFile, decs.map((d) => JSON.stringify(d)).join('\n') + '\n');
  writeEvents(aw);
  const items = (extra = {}) => probe(`import { auditItems, auditRate } from ${u('harness/audit.mjs')};
const a = await auditItems({ now: ${NOW}, days: 14 });
console.log(JSON.stringify({ rate: a.rate, source: a.source, ids: a.items.map((x) => x.id), items: a.items }));`, extra);
  const landingsPicked = (rate) => aw.filter((e) => e.type === 'task.done').map((e) => e.task).filter((t) => draw(t) < rate).map((t) => `AU-${t}`);
  const decsPicked = (rate) => decIds.filter((id) => draw(id) < rate).map((id) => `AU-${id}`);
  let firstItems = null;
  await guard('273e draw: audit items are the hands-free landings and autonomous decisions whose draw (sha256 of the task / decision id) is under the policy\'s "audit.rate", the same every time; 0.1 by default while autonomous mode is on; 0 with autonomous mode off (fails on 2.71.1: no harness/audit.mjs)', () => {
    setPolicy({ autonomous: auto, audit: { rate: 0.5 }, never: [], notes: [] });
    const a = items(); const b = items();
    setPolicy({ autonomous: auto, never: [], notes: [] });
    const dflt = items();
    setPolicy({ autonomous: { ...auto, allowed: false }, never: [], notes: [] });
    const off = items();
    setPolicy({ autonomous: auto, audit: { rate: 0.5 }, never: [], notes: [] });
    firstItems = a;
    const want = [...landingsPicked(0.5), ...decsPicked(0.5)].sort();
    const wantDefault = [...landingsPicked(0.1), ...decsPicked(0.1)].sort();
    return [a.rate === 0.5 && JSON.stringify([...(a.ids || [])].sort()) === JSON.stringify(want) && want.length >= 6 && want.length < 32 && JSON.stringify(a.ids) === JSON.stringify(b.ids)
      && dflt.rate === 0.1 && /autonomous mode is on/.test(dflt.source) && JSON.stringify([...(dflt.ids || [])].sort()) === JSON.stringify(wantDefault)
      && off.rate === 0 && (off.ids || []).length === 0, JSON.stringify({ a: a.ids, want, dflt: { rate: dflt.rate, ids: dflt.ids, wantDefault, out: dflt._out }, off: { rate: off.rate, out: off._out } }).slice(0, 3000)];
  });

  const landItem = (firstItems?.items || []).find((x) => x.kind === 'landing');
  const decItem = (firstItems?.items || []).find((x) => x.kind === 'decision');
  await guard('273e list: picked items are on `npm run decisions -- review` (marked [audit], never blocking) and in the digest; an audit is refused from the agent that worked on the task, from a shell working as it and from the deciding agent; a person records a pass (fails on 2.71.1: no audit items, no `decisions -- audit`)', () => {
    const rv = cli('node harness/decisions.mjs review');
    const dg = probe(`import { buildDigest } from ${u('harness/digest.mjs')}; const d = await buildDigest({ now: ${NOW} }); console.log(JSON.stringify({ text: d.text }));`);
    const doer = landItem ? landItem.doers[0] : 'none';
    const selfA = cli(`node harness/decisions.mjs audit ${landItem?.id} pass --by ${doer}`);
    const shellA = cli(`node harness/decisions.mjs audit ${landItem?.id} pass --by dana --permission "dana said: audit it for me please"`, { STUDIO_LOCK_OWNER: doer, CLAUDECODE: '1' });
    const decA = cli(`node harness/decisions.mjs audit ${decItem?.id} pass --by ${OV}`);
    const ok = cli(`node harness/decisions.mjs audit ${landItem?.id} pass --by dana`);
    const notPicked = cli('node harness/decisions.mjs audit AU-T-999 pass --by dana');
    const recs = fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((r) => r.kind === 'audit');
    return [landItem && decItem && rv.status === 0 && rv.stdout.includes(`${landItem.id}`) && rv.stdout.includes(`${decItem.id}`) && /\[audit\]/.test(rv.stdout) && /never blocks work/.test(rv.stdout)
      && /Audits \(50% of hands-free landings and autonomous decisions, 7 days\)/.test(dg.text || '')
      && selfA.status !== 0 && /worked on/.test(out(selfA)) && shellA.status !== 0 && /worked on/.test(out(shellA)) && decA.status !== 0 && /worked on/.test(out(decA))
      && ok.status === 0 && notPicked.status !== 0 && recs.length === 1 && recs[0].of === landItem.id && recs[0].verdict === 'pass' && recs[0].by === 'dana',
    `${out(rv).slice(-1500)}\n--- digest\n${String(dg.text || dg._out).slice(-800)}\n--- self ${out(selfA)}\n--- shell ${out(shellA)}\n--- dec ${out(decA)}\n--- ok ${out(ok)}\n--- notPicked ${out(notPicked)}`];
  });

  await guard('273e redo: a failed audit counts as a Redo in the redo rate and the L3 bar (the bound check names it); approving an audited autonomous decision records a passed audit; a fail needs a note (fails on 2.71.1: audits don\'t exist, the redo rate is away verdicts only)', () => {
    const other = (firstItems?.items || []).filter((x) => x.kind === 'landing')[1];
    const noNote = cli(`node harness/decisions.mjs audit ${other?.id} fail --by dana`);
    const fail = cli(`node harness/decisions.mjs audit ${other?.id} fail --by dana --note "the change skipped the edge case it was for"`);
    const appr = cli(`node harness/decisions.mjs approve ${decItem?.decision} --by dana`);
    const evs = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
    const s = probe(`import fs from 'node:fs'; import { buildAutonomy, levelBadge, personClassifier, DEFAULT_AUTONOMY } from ${u('harness/autonomy.mjs')};
const evs = fs.readFileSync(${JSON.stringify(evFile)}, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const c = buildAutonomy(evs, { now: ${NOW} + 60000, days: 7, isPersonName: await personClassifier() });
const b = levelBadge(c, DEFAULT_AUTONOMY);
console.log(JSON.stringify({ v: c.verdicts, redo: b.checks.find((x) => x.id === 'redoRate') }));`);
    const av = evs.filter((e) => e.type === 'audit.verdict');
    return [noNote.status !== 0 && fail.status === 0 && appr.status === 0
      && av.length === 3 && av.some((e) => e.meta.of === decItem.id && e.meta.verdict === 'pass' && e.meta.via === 'review') && av.some((e) => e.meta.of === other.id && e.meta.verdict === 'fail')
      && s.v?.audited === 3 && s.v?.auditFailed === 1 && Math.abs(s.v?.redoRate - 1 / 3) < 0.001 && s.redo?.ok === false && s.redo?.n === 3 && s.redo?.k === 1,
    JSON.stringify({ noNote: out(noNote), fail: out(fail), appr: out(appr), av: av.map((e) => e.meta), s }).slice(0, 3000)];
  });

  // ---- 3. routing ----
  setPolicy({ autonomous: auto, never: [], notes: [], routing: { cheapFirst: ['docs', 'chore', 'test'], tiers: { cheap: 'claude-haiku-9', top: 'claude-opus-9' }, models: ['claude-sonnet-9'], holdout: 0 } });
  await guard('273e route: a listed type or track starts on the cheapest tier the policy lists, one tier up per red round (a failed hand-back; a usage-limit stop isn\'t one), capped at the top listed; an unlisted STUDIO_TIER_* model is never picked; a type not listed and a task started before routing keep their model; holdout 0 sends none to the default tier, a set holdout a seeded share; the launcher calls it and skips the 2.30d tier-up for a routed task (fails on 2.71.1: no harness/routing.mjs)', () => {
    const r = probe(`import { routeFor, launchRoute, tierModels, routingPolicy } from ${u('harness/routing.mjs')};
import { readPolicy } from ${u('harness/policy-rules.mjs')};
const policy = readPolicy();
const T = (h) => new Date(${NOW} - h * 3600000).toISOString();
const paused = (task, h, msg = 'handed back: tests failed') => ({ ts: T(h), type: 'task.paused', agent: 'builder-a1', task, msg });
const start = (task, h, model) => ({ ts: T(h), type: 'agent.session.start', agent: 'builder-a1', task, model });
const routed = (task, h, tier, model, failed = 0) => ({ ts: T(h), type: 'model.routed', agent: 'launcher', task, meta: { arm: 'cheap-first', tier, model, failed } });
const first = launchRoute({ id: 'T-1', type: 'docs', role: 'builder' }, { events: [] });
const e1 = [routed('T-1', 5, 'cheap', 'claude-haiku-9'), start('T-1', 5, 'claude-haiku-9'), paused('T-1', 4)];
const second = routeFor({ id: 'T-1', type: 'docs' }, { policy, events: e1 });
const e2 = [...e1, routed('T-1', 3, 'top', 'claude-opus-9', 1), start('T-1', 3, 'claude-opus-9'), paused('T-1', 2)];
const third = routeFor({ id: 'T-1', type: 'docs' }, { policy, events: e2 });
const limit = routeFor({ id: 'T-1', type: 'docs' }, { policy, events: [routed('T-1', 5, 'cheap', 'claude-haiku-9'), start('T-1', 5, 'claude-haiku-9'), paused('T-1', 4, 'builder-a1 stopped at its usage limit; handed back')] });
const sticky = routeFor({ id: 'T-1', type: 'docs' }, { policy, events: [routed('T-1', 5, 'cheap', 'claude-haiku-9'), start('T-1', 5, 'claude-haiku-9')] });
const track = routeFor({ id: 'T-2', type: 'change', track: 'test' }, { policy, events: [] });
const notListed = routeFor({ id: 'T-3', type: 'bug' }, { policy, events: [] });
const midStart = routeFor({ id: 'T-4', type: 'docs' }, { policy, events: [start('T-4', 5, 'claude-opus-9')] });
const unlisted = tierModels(routingPolicy(policy), { STUDIO_TIER_MID_MODEL: 'gpt-unlisted', STUDIO_TIER_CHEAP_MODEL: 'claude-sonnet-9' });
const ids = Array.from({ length: 40 }, (_, i) => 'T-' + (500 + i));
const hold0 = ids.filter((id) => routeFor({ id, type: 'docs' }, { policy, events: [] })?.arm === 'holdout').length;
const p2 = { ...policy, effective: { ...policy.effective, routing: { ...policy.effective.routing, holdout: 0.25 } } };
const h1 = ids.filter((id) => routeFor({ id, type: 'docs' }, { policy: p2, events: [] })?.arm === 'holdout');
const h2 = ids.filter((id) => routeFor({ id, type: 'docs' }, { policy: p2, events: [] })?.arm === 'holdout');
console.log(JSON.stringify({ first, second, third, limit, sticky, track, notListed, midStart, unlisted, hold0, h1: h1.length, same: JSON.stringify(h1) === JSON.stringify(h2), holdModel: routeFor({ id: h1[0], type: 'docs' }, { policy: p2, events: [] })?.model ?? null }));`);
    const src = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
    const wired = /launchRoute\(/.test(src) && /type: 'model\.routed'/.test(src) && /2\.30d[^\n]*\n\s*if \(opts\.task && !opts\.model && !routed\)/.test(src);
    return [r.first?.arm === 'cheap-first' && r.first.tier === 'cheap' && r.first.model === 'claude-haiku-9'
      && r.second?.tier === 'top' && r.second.model === 'claude-opus-9' && r.second.failed === 1
      && r.third?.tier === 'top' && r.third.failed === 2
      && r.limit?.tier === 'cheap' && r.limit.failed === 0 && r.sticky?.model === 'claude-haiku-9' && r.sticky.sticky === true
      && r.track?.model === 'claude-haiku-9' && r.track.matched === 'test' && r.notListed === null && r.midStart?.arm === 'none' && r.midStart.model === null
      && r.unlisted?.cheap === 'claude-haiku-9' && !r.unlisted.mid && r.unlisted.top === 'claude-opus-9'
      && r.hold0 === 0 && r.h1 > 2 && r.h1 < 20 && r.same === true && r.holdModel === null && wired, JSON.stringify({ r, wired }).slice(0, 3000)];
  });

  await guard('273e stats: `npm run autonomy -- routing` gives per task type and tier the sessions, landings, success rate and tokens per landed change from session ends, and says the holdout is off until API credit is available; `npm run policy` shows the audit share and the routing (fails on 2.71.1: no routing command; the policy shows neither)', () => {
    const se = (task, h, model, tok, startH) => ({ ts: at(h), type: 'agent.session.end', agent: 'builder-a1', model, task, tokensIn: tok, tokensOut: 0, meta: { startedAt: at(startH) } });
    const add = (task, title, h) => ({ ts: at(h), type: 'task.added', agent: 'producer', task, msg: `Queued ${task} [P2] (builder): ${title}` });
    writeEvents([
      add('T-41', 'Docs: explain the save format', 40), add('T-42', 'Docs: list the keys', 40), add('T-43', 'Add a lantern', 40),
      se('T-41', 30, 'claude-haiku-9', 1000, 31), { ts: at(29.5), type: 'task.paused', agent: 'builder-a1', task: 'T-41', msg: 'handed back: tests failed' },
      se('T-41', 20, 'claude-opus-9', 9000, 21), { ts: at(19.9), type: 'task.done', agent: 'builder-a1', task: 'T-41' },
      se('T-42', 10, 'claude-haiku-9', 2000, 11), { ts: at(9.9), type: 'task.done', agent: 'builder-a1', task: 'T-42' },
      se('T-43', 8, 'claude-sonnet-9', 5000, 9),
    ]);
    const j = cli('node harness/autonomy.mjs routing --json');
    let js = null; try { js = JSON.parse(j.stdout); } catch {}
    const t = cli('node harness/autonomy.mjs routing');
    const pol = cli('node harness/policy.mjs');
    const row = (type, tier) => (js?.rows || []).find((x) => x.type === type && x.tier === tier) || {};
    const dc = row('docs', 'cheap'); const dt = row('docs', 'top'); const ch = row('change', 'mid');
    return [j.status === 0 && dc.sessions === 2 && dc.landed === 1 && dc.successRate === 0.5 && dc.tokensPerLanded === 3000 && dt.sessions === 1 && dt.landed === 1 && dt.tokensPerLanded === 9000 && ch.sessions === 1 && ch.landed === 0 && ch.tokensPerLanded === null
      && js.holdout === 0 && /deferred it until API credit is available/.test(js.note)
      && t.status === 0 && /Cheap-first routing: on for docs, chore, test/.test(t.stdout) && /Holdout: off \(0\): the owner deferred it until API credit is available/.test(t.stdout) && /docs · cheap: 2 session\(s\) on 2 task\(s\), 1 landed \(success 50%\), 3,000 tokens per landed change/.test(t.stdout)
      && pol.status === 0 && /Audits: 10% of hands-free landings and autonomous decisions/.test(pol.stdout) && /Cheap-first routing: docs, chore, test start on the cheapest listed tier \(cheap claude-haiku-9, top claude-opus-9\)/.test(pol.stdout) && /Holdout: off \(0; deferred by the owner until API credit is available\)/.test(pol.stdout),
    `${String(j.stdout).slice(0, 1200)}\n---\n${out(t)}\n---\n${out(pol).slice(-1500)}`];
  });

  // Put back what this test set up (a shared full-selftest copy may run more checks after this one).
  for (const f of ['studio/policy.json', '.studio/decisions.jsonl', evFile]) fs.rmSync(path.isAbsolute(f) ? f : path.join(dir, f), { force: true });
  if (autonomyBefore !== null) fs.writeFileSync(autonomyFile, autonomyBefore);
}

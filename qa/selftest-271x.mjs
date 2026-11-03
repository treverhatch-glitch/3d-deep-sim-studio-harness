/**
 * qa/selftest-271x.mjs — 2.71.0 (helper x): one decision log, the studio policy file, autonomous mode, its review list.
 *   policy     `npm run policy` reads studio/policy.json (a missing file is today's behaviour); the file is on every
 *              shipped protected list, so a lane that writes it is tier C.
 *   log        a person's hold, unhold and reclassification each write exactly one record to .studio/decisions.jsonl
 *              (as "person", with an undo) and one `decision` event; `npm run decisions -- --action … --json` filters.
 *   self       an agent can't turn autonomous mode on for itself: `policy autonomous on` and `policy confirm` refuse an
 *              agent's shell, a policy.json an agent committed doesn't count, a worker can't propose, and a game dev's
 *              proposal changes nothing until the owner confirms it.
 *   autonomous after the owner confirms, the named overseer takes a listed decision (task type, yes) with --by itself
 *              and no permission words: recorded "autonomous", on the review list (`decisions -- review`).
 *   never      in autonomous mode the overseer can't delete lanes (janitor-lanes, even if the file lists it) nor release
 *              a lane held for a protected file; it may release a lane held after hand-backs (logged, with an undo).
 *   review     the deciding agent can't approve its own decision, a person can; revert runs the undo (the type goes
 *              back; a released lane is held again; a lane that already left the queue gets a revert task); edit
 *              needs a note; `mode autonomous off` pauses it at once (never a worker).
 *   digest     the War Room snapshot and the digest show the review count and the oldest; past reviewWithinH it goes
 *              to "Needs you"; a pending proposal is in "Needs you".
 *   measure    autonomous decisions per day, approved vs reverted (revert rate) and time saved against the median
 *              owner wait from events ("not enough data" under 10 waits).
 * A made-up studio in a git checkout. Each check fails on 2.70.0 (no policy file, no decision log, no autonomous mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest271X({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-271x.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const logFile = path.join(dir, '.studio', 'decisions.jsonl');
  const log = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const decs = () => log().filter((r) => r.kind === 'decision');
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_ROLE: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_AGENT: '', STUDIO_RAM_FLOOR_GB: '0', STUDIO_QUOTA_PROBE: 'off',
    STUDIO_CREW_WATCH: 'off', STUDIO_JANITOR: 'off', STUDIO_DAILY_TOKEN_CAP: 'off', STUDIO_LANE_INFER: 'off', STUDIO_OVERLAP: '', STUDIO_DECISION_MIN_N: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_HOOKS_RESTAMP: 'off', STUDIO_MACHINE_SCAN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-271x-${process.pid}.pem`),
    AGENT_EVENTS_FILE: events, AGENT_EVENTS_MIRROR: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  const OV = 'overseer-bot';
  const agentEnv = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: OV };
  let n = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p271x-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };
  const cli = (cmd, extra = {}) => run(dir, cmd, { ...env, ...extra });

  // ---- a made-up studio ----
  for (const d of ['.studio/agents', '.lanes', '.studio/train']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
  for (const f of ['studio/delegation.json', 'studio/policy.json', 'studio/task-types.json', 'studio/task-holds.json', '.studio/decisions.jsonl', '.studio/policy-proposal.json', '.studio/autonomy-paused.json']) fs.rmSync(path.join(dir, f), { force: true });
  fs.mkdirSync(path.dirname(events), { recursive: true });
  fs.writeFileSync(events, '');
  fs.mkdirSync(path.join(dir, 'game', 'kite-meadow', 'src'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'game', 'kite-meadow', 'src', 'wind.js'), 'export const wind = 2;\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  const addTask = (title) => (out(cli(`node harness/task.mjs add "${title}" --role builder --priority P1`)).match(/"id": "(T-\d+)"/) || [])[1];
  const tHold = addTask('Tune the kite tether length');
  const tType = addTask('Fix: kites drift left in calm air');
  const tAuto = addTask('Fix: the meadow fence reads as a bug but is a chore');
  const tYes = addTask('Add gusts that push kites upward');

  // 1. policy
  await guard('271x policy: `npm run policy` reads studio/policy.json (none: today\'s behaviour, autonomous mode off) and the file is on the shipped protected lists (approve DEFAULT_PROTECTED, tiers SHIPPED_PROTECTED, studio/protected.json), so a lane writing it is tier C (fails on 2.70.0: no policy command or file)', () => {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).scripts || {};
    const r = cli('node harness/policy.mjs');
    const p = probe(`import { DEFAULT_PROTECTED } from ${u('harness/approve.mjs')}; import { SHIPPED_PROTECTED, classifyLane } from ${u('harness/tiers.mjs')}; import fs from 'node:fs'; console.log(JSON.stringify({ d: DEFAULT_PROTECTED.includes('studio/policy.json'), s: SHIPPED_PROTECTED.includes('studio/policy.json'), f: JSON.parse(fs.readFileSync('studio/protected.json', 'utf8')).globs.includes('studio/policy.json'), tier: classifyLane({ files: [{ path: 'studio/policy.json', status: 'M' }] }).tier }));`);
    return [pkg.policy && pkg.decisions && r.status === 0 && /today's behaviour/.test(out(r)) && /Autonomous mode: off/.test(out(r)) && p.d && p.s && p.f && p.tier === 'C', JSON.stringify({ pkg: [pkg.policy, pkg.decisions], r: out(r), p })];
  });

  // 2. one decision log
  const h1 = cli(`node harness/task.mjs hold ${tHold} --by dana --why "waits for the tether chain"`);
  const h2 = cli(`node harness/task.mjs unhold ${tHold} --by dana`);
  const ty = cli(`node harness/task.mjs type ${tType} chore --by dana --why "the drift is a tuning chore, not a bug"`);
  await guard('271x log: a person\'s hold, unhold and reclassification write exactly one record each to .studio/decisions.jsonl (as "person", with an undo) plus one `decision` event; `npm run decisions -- --action hold --json` lists only the holds (fails on 2.70.0: no decision log)', () => {
    const d = decs();
    const holds = d.filter((x) => x.action === 'hold' && x.subject === tHold);
    const types = d.filter((x) => x.action === 'type' && x.subject === tType);
    const l = cli('node harness/decisions.mjs --since 24h --action hold --json');
    let listed = [];
    try { listed = JSON.parse(l.stdout); } catch {}
    const ev = evs().filter((e) => e.type === 'decision');
    return [h1.status === 0 && h2.status === 0 && ty.status === 0 && holds.length === 2 && types.length === 1 && holds.every((x) => x.as === 'person' && x.by === 'dana' && x.undo?.kind) && types[0].undo?.kind === 'retype' && listed.length === 2 && listed.every((x) => x.action === 'hold') && ev.length === d.length && d.length === 3, JSON.stringify({ d, listed, ev: ev.length, h1: out(h1).slice(-300), ty: out(ty).slice(-300) })];
  });

  // 3. an agent can't turn autonomous mode on for itself
  const selfOn = cli(`node harness/policy.mjs autonomous on --agent ${OV} --by dana`, agentEnv);
  const workerProp = cli(`node harness/autonomy.mjs mode autonomous on --agent ${OV} --by dana --permission "dana said: go autonomous tonight"`, { STUDIO_LOCK_OWNER: 'builder-s3' });
  const devProp = cli(`node harness/autonomy.mjs mode autonomous on --agent ${OV} --by dana --why "nights off"`);
  const beforeConfirm = cli(`node harness/task.mjs type ${tAuto} chore --by ${OV} --why "a fence chore, not a bug at all"`, agentEnv);
  const selfConfirm = cli('node harness/policy.mjs confirm --by dana', agentEnv);
  // An agent writes studio/policy.json itself and commits it (the commit-msg hook stamps Studio-Agent on agent commits).
  fs.writeFileSync(path.join(dir, 'studio', 'policy.json'), JSON.stringify({ autonomous: { allowed: true, agent: OV, actions: ['type', 'janitor-lanes'] } }, null, 2));
  g(dir, 'add', 'studio/policy.json'); g(dir, 'commit', '-qm', 'policy: on', '-m', `Studio-Agent: ${OV}`, '--no-verify');
  const agentFile = cli(`node harness/task.mjs type ${tAuto} chore --by ${OV} --why "a fence chore, not a bug at all"`, agentEnv);
  const shown = cli('node harness/policy.mjs');
  await guard('271x self: an agent can\'t turn autonomous mode on for itself: `policy autonomous on` and `policy confirm` refuse an agent\'s shell, a worker can\'t propose, a game dev\'s proposal changes nothing until the owner confirms, and a policy.json an agent committed doesn\'t count (its type decision is refused) (fails on 2.70.0: no policy command, so nothing to refuse or confirm)', () => [
    selfOn.status !== 0 && /Not changed: .*coding agent/.test(out(selfOn)) && workerProp.status !== 0 && /worker/.test(out(workerProp)) && devProp.status === 0 && /Proposed/.test(out(devProp)) && fs.existsSync(path.join(dir, '.studio', 'policy-proposal.json')) && beforeConfirm.status !== 0 && selfConfirm.status !== 0 && /coding agent/.test(out(selfConfirm)) && agentFile.status !== 0 && /doesn't count/.test(out(shown)) && /Studio-Agent/.test(out(shown)),
    JSON.stringify({ selfOn: out(selfOn), workerProp: out(workerProp), devProp: out(devProp), beforeConfirm: out(beforeConfirm).slice(-300), selfConfirm: out(selfConfirm), agentFile: out(agentFile).slice(-300), shown: out(shown) }),
  ]);

  // 4. the owner confirms; the overseer decides on its own
  fs.rmSync(path.join(dir, 'studio', 'policy.json'), { force: true });
  g(dir, 'rm', '-q', '--cached', 'studio/policy.json'); g(dir, 'commit', '-qm', 'policy: drop the agent\'s file', '--no-verify');
  const conf = cli('node harness/policy.mjs confirm --by dana');
  probe(`import { setHold } from ${u('harness/task-hold.mjs')}; setHold(${JSON.stringify(tYes)}, { needsYes: { by: 'builder-s2', at: new Date().toISOString() } }); console.log('{}');`);
  const aType = cli(`node harness/task.mjs type ${tAuto} chore --by ${OV} --why "a fence chore, not a bug at all"`, agentEnv);
  const aYes = cli(`node harness/task.mjs yes ${tYes} --by ${OV}`, agentEnv);
  const rev = cli('node harness/decisions.mjs review');
  await guard('271x autonomous: after the owner confirms the proposal, the named overseer takes listed decisions (task type, yes) with --by itself and no permission words; each is recorded "autonomous" and listed by `decisions -- review` (fails on 2.70.0: the overseer is refused without --permission)', () => {
    const d = decs().filter((x) => x.as === 'autonomous');
    const t = cli(`node harness/task.mjs type ${tAuto}`);
    return [conf.status === 0 && /Autonomous mode is on/.test(out(conf)) && aType.status === 0 && aYes.status === 0 && d.some((x) => x.action === 'type' && x.subject === tAuto && x.by === OV) && d.some((x) => x.action === 'yes' && x.subject === tYes && x.undo?.kind === 'needs-yes') && /"chore"/.test(out(t)) && /2 decision\(s\) waiting for review/.test(out(rev)) && out(rev).includes(tAuto), JSON.stringify({ conf: out(conf), aType: out(aType).slice(-400), aYes: out(aYes).slice(-400), rev: out(rev), d, t: out(t) })];
  });

  // 5. never in autonomous mode
  let pol = { autonomous: { actions: ['janitor-lanes'] } };
  try { pol = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'policy.json'), 'utf8')); } catch { /* 2.70.0: no policy file */ }
  const sub = (s) => `${s.slice(0, 9)}${'0'.repeat(31)}`;
  const queue = (rows) => { fs.mkdirSync(path.join(dir, '.studio', 'train'), { recursive: true }); fs.writeFileSync(path.join(dir, '.studio', 'train', 'queue.json'), JSON.stringify(rows, null, 2)); };
  const tProt = addTask('Retune the kite gate thresholds');
  const tBack = addTask('Kite tail physics, take four');
  const protWhy = probe(`import { DEFAULT_TIER_RULES } from ${u('harness/tiers.mjs')}; console.log(JSON.stringify({ w: DEFAULT_TIER_RULES.find((r) => r.id === 'protected').why }));`).w;
  queue([
    { task: tProt, agent: 'builder-a', head: sub('a1a1a1a1a'), held: { tier: 'C', why: `${protWhy}: studio/game.json`, head: sub('a1a1a1a1a'), at: new Date().toISOString() } },
    { task: tBack, agent: 'builder-b', head: sub('b2b2b2b2b'), held: { tier: 'B', why: 'handed back 4 times (more than 3, STUDIO_TRAIN_MAX_HANDBACKS): after that many tries the problem is in the plan, so a person looks before it lands', head: sub('b2b2b2b2b'), at: new Date().toISOString() } },
  ]);
  const rel = probe(`import { releaseLane } from ${u('harness/train.mjs')}; const a = releaseLane(process.cwd(), ${JSON.stringify(tProt)}, { by: ${JSON.stringify(OV)} }); const b = releaseLane(process.cwd(), ${JSON.stringify(tBack)}, { by: ${JSON.stringify(OV)} }); console.log(JSON.stringify({ a, b }));`, agentEnv);
  const jan = probe(`import { deciderCheck } from ${u('harness/decider.mjs')}; const d = await deciderCheck({ by: ${JSON.stringify(OV)}, action: 'janitor-lanes', what: 'delete lane copies' }); console.log(JSON.stringify(d));`, agentEnv);
  await guard('271x never: in autonomous mode the overseer can\'t delete lane copies (janitor-lanes is never autonomous, whatever the file lists) nor release a lane held for a protected file; it may release a lane held after too many hand-backs, logged "autonomous" with a re-hold undo (fails on 2.70.0: no autonomous release at all)', () => {
    const q = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8'));
    const rd = decs().find((x) => x.action === 'train-release' && x.subject === tBack);
    return [!pol.autonomous.actions.includes('janitor-lanes') && rel.a?.ok === false && /never releases a lane held for protected/.test(rel.a.message) && !q.find((e) => e.task === tProt).released && rel.b?.ok === true && q.find((e) => e.task === tBack).released?.autonomous === true && rd?.as === 'autonomous' && rd.undo?.kind === 'rehold-lane' && jan.ok === false, JSON.stringify({ rel, jan, rd, actions: pol.autonomous.actions })];
  });

  // 6. review
  const all = decs();
  const dType = all.find((x) => x.action === 'type' && x.subject === tAuto);
  const dYes = all.find((x) => x.action === 'yes' && x.subject === tYes);
  const dRel = all.find((x) => x.action === 'train-release' && x.subject === tBack);
  const selfApprove = cli(`node harness/decisions.mjs approve ${dYes?.id} --by ${OV}`, agentEnv);
  const approve = cli(`node harness/decisions.mjs approve ${dYes?.id} --by dana`);
  const editNo = cli(`node harness/decisions.mjs edit ${dRel?.id} --by dana`);
  const revType = cli(`node harness/decisions.mjs revert ${dType?.id} --by dana --why "it really is a bug"`);
  const revRel = cli(`node harness/decisions.mjs revert ${dRel?.id} --by dana --why "look at it first"`);
  // A release that landed (left the queue) can't be held again: the revert files a revert task.
  queue([{ task: tBack, agent: 'builder-b', head: sub('b2b2b2b2b'), held: { tier: 'B', why: 'handed back 4 times', head: sub('b2b2b2b2b') } }]);
  const rel2 = probe(`import { releaseLane } from ${u('harness/train.mjs')}; console.log(JSON.stringify(releaseLane(process.cwd(), ${JSON.stringify(tBack)}, { by: ${JSON.stringify(OV)} })));`, agentEnv);
  queue([]);
  const dRel2 = decs().filter((x) => x.action === 'train-release' && x.subject === tBack).pop();
  const revLanded = cli(`node harness/decisions.mjs revert ${dRel2?.id} --by dana`);
  await guard('271x review: the deciding agent can\'t approve its own decision, a person can; edit needs a note; revert runs the undo (the type goes back to the title\'s, a released lane is held again, a landed one gets a revert task) and none of it logs a second decision (fails on 2.70.0: no review list)', () => {
    const t = cli(`node harness/task.mjs type ${tAuto}`);
    const board = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
    const reviews = log().filter((r) => r.kind === 'review');
    const extra = decs().filter((x) => x.at > (dRel2?.at || '')).length;
    return [selfApprove.status !== 0 && /never reviews its own/.test(out(selfApprove)) && approve.status === 0 && editNo.status !== 0 && revType.status === 0 && /"bug"/.test(out(t)) && revRel.status === 0 && /held again/.test(out(revRel)) && rel2.ok && revLanded.status === 0 && /revert task|filed/.test(out(revLanded)) && new RegExp(`Revert ${tBack}`).test(board) && reviews.filter((r) => r.verdict === 'reverted').length === 3 && reviews.some((r) => r.verdict === 'approved' && r.of === dYes.id) && extra === 0, JSON.stringify({ selfApprove: out(selfApprove), approve: out(approve), editNo: out(editNo), revType: out(revType).slice(-400), t: out(t), revRel: out(revRel), revLanded: out(revLanded), reviews, extra })];
  });

  // 7. pause
  const workerOff = cli('node harness/autonomy.mjs mode autonomous off --by builder-s3');
  const off = cli('node harness/autonomy.mjs mode autonomous off --by sam --why "too many reverts"');
  const afterOff = cli(`node harness/task.mjs type ${tAuto} chore --by ${OV} --why "a fence chore, not a bug at all"`, agentEnv);
  await guard('271x pause: `autonomy -- mode autonomous off` (anyone but a worker) pauses autonomous mode at once: the overseer\'s next decision is refused with the pause named (fails on 2.70.0: no mode command)', () => [
    workerOff.status !== 0 && off.status === 0 && afterOff.status !== 0 && /paused/.test(out(afterOff)), JSON.stringify({ workerOff: out(workerOff), off: out(off), afterOff: out(afterOff).slice(-400) }),
  ]);

  // 8. digest and War Room
  const old = { kind: 'decision', id: 'D-old1', at: new Date(Date.now() - 100 * 3600000).toISOString(), action: 'hold', subject: tHold, by: OV, as: 'autonomous', why: 'old one', evidence: '', undo: null };
  fs.appendFileSync(logFile, `${JSON.stringify(old)}\n`);
  cli(`node harness/autonomy.mjs mode autonomous on --agent ${OV} --by dana`);
  const dg = probe(`import { buildDigest } from ${u('harness/digest.mjs')}; import { reviewCard } from ${u('harness/decisions-log.mjs')}; const d = await buildDigest({}); console.log(JSON.stringify({ text: d.text, card: reviewCard() }));`);
  await guard('271x digest: the War Room card and the digest show the autonomous decisions waiting for review with the oldest; one past reviewWithinH (72 h) is under "Needs you", and so is a proposal waiting for the owner (fails on 2.70.0: neither knows the review list)', () => [
    dg.card?.pending >= 1 && dg.card.oldest?.id === 'D-old1' && dg.card.overdue >= 1 && /Needs you/.test(dg.text || '') && /autonomous decision.*waited more than 72 h/.test(dg.text) && /proposes autonomous mode/.test(dg.text) && /Autonomous mode paused/.test(dg.text), JSON.stringify(dg),
  ]);

  // 9. measure
  const mroot = path.join(tmpRoot, `m271x-${process.pid}`);
  fs.mkdirSync(path.join(mroot, '.studio'), { recursive: true });
  const T0 = Date.parse('2026-06-10T00:00:00Z');
  const iso = (ms) => new Date(ms).toISOString();
  const rows = [];
  const ev = [];
  for (let i = 0; i < 12; i++) { const t = T0 + i * 3600000; ev.push({ type: 'task.train.held', task: `T-${100 + i}`, ts: iso(t) }, { type: 'task.train.released', task: `T-${100 + i}`, ts: iso(t + 2 * 3600000) }); }
  for (let i = 0; i < 4; i++) {
    const t = T0 + 20 * 3600000 + i * 3600000;
    ev.push({ type: 'task.train.held', task: `T-${200 + i}`, ts: iso(t) }, { type: 'task.train.released', task: `T-${200 + i}`, ts: iso(t + 60000 * 5) });
    rows.push({ kind: 'decision', id: `D-m${i}`, at: iso(t + 60000 * 5), action: 'train-release', subject: `T-${200 + i}`, by: OV, as: 'autonomous', why: '', evidence: '', undo: null });
  }
  rows.push({ kind: 'decision', id: 'D-q1', at: iso(T0 + 30 * 3600000), action: 'quarantine', subject: 'tests/kite.test.js', by: OV, as: 'autonomous', why: '', evidence: '', undo: null });
  rows.push({ kind: 'review', of: 'D-m0', verdict: 'approved', by: 'dana' }, { kind: 'review', of: 'D-m1', verdict: 'approved', by: 'dana' }, { kind: 'review', of: 'D-m2', verdict: 'approved', by: 'dana' }, { kind: 'review', of: 'D-m3', verdict: 'reverted', by: 'dana' });
  fs.writeFileSync(path.join(mroot, '.studio', 'decisions.jsonl'), `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  const m = probe(`import { autonomyStats } from ${u('harness/decisions-log.mjs')}; console.log(JSON.stringify(autonomyStats({ root: ${JSON.stringify(mroot)}, events: ${JSON.stringify(ev)}, now: ${T0 + 3 * 86400000}, env: {} })));`);
  fs.rmSync(mroot, { recursive: true, force: true });
  await guard('271x measure: autonomous decisions per day, approved vs reverted (revert rate 25%), and time saved against the median owner wait for that action from events (12 waits of 2 h: about 7.7 h saved on 4 releases); an action with under 10 measured waits says "not enough data" (fails on 2.70.0: nothing measures it)', () => [
    m.total === 5 && m.approved === 3 && m.reverted === 1 && m.revertRate === 0.25 && m.perDay?.['2026-06-10'] === 4 && m.saved?.['train-release']?.enough === true && Math.abs(m.saved['train-release'].savedH - 7.7) < 0.2 && m.saved['train-release'].medianWaitH === 2 && m.saved.quarantine?.enough === false && /not enough data/.test(m.saved.quarantine.text), JSON.stringify(m),
  ]);
}

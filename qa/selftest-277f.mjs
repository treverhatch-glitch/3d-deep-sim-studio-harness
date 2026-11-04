/**
 * qa/selftest-277f.mjs — 2.77.0 (helper f): three small parts of Patch #2.
 *   digest    P1.1: the daily digest has a "Beta mode" section for its 24 h: whether beta is on, who switched it and when,
 *             each use (who, action, subject, why), at most 30 lines with a count of the rest; nothing when beta is off
 *             and nothing was used; the section is not counted in the digest's 200 words; recordBetaUse keeps the subject
 *             and the reason in the event
 *   mixed     P2.4 / B-91: the launcher (carryTaskBranch, used by the lane copy, `task start` and the claim) does not merge
 *             an earlier branch whose commits carry another OPEN task's Studio-Task trailer; it says so (lane.mixed_skipped,
 *             the start output) and starts from main plus the task's own commits; a --after dependency's commits, a
 *             Rescue target's and a branch of only this task's commits still merge; STUDIO_TRAIN_MIXED=off turns it off
 *   rig       P4.2: the job catalog has an "art-bake" kind (RAM, CPU threads, minutes, all overridable in
 *             studio/machine-budget.json "jobs"); one RIG_PRIORITY table (train > verify/check > Unity/art > soak) that the
 *             weights come from, unchanged in value; docs name both
 * Every check fails on 2.76.0 (no betaDigestLines, no carryTaskBranchEx / mixed check, no art-bake, no RIG_PRIORITY).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest277F({ dir, report, tmpRoot }) {
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '', STUDIO_TRAIN_MIXED: '', STUDIO_DIGEST: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-key-277f-${process.pid}.pem`), ...ident,
  };
  let n = 0;
  const made = [];
  const studio = () => {
    const S = path.join(tmpRoot, `277f-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio/agents', '.studio/locks', '.studio/decisions.jsonl', '.studio/lane-branches.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-277f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const evs = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const node = (S, env, code) => spawnSync(process.execPath, ['--input-type=module', '-e', code], { cwd: S, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...env } });
  const imp = (S, f) => JSON.stringify(pathToFileURL(path.join(S, 'harness', f)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

  // ---- digest ----
  const mk = (i, over = {}) => ({ ts: new Date(Date.UTC(2026, 10, 4, 6, i)).toISOString(), type: 'delegation.used', agent: 'opus-1', status: 'ok', msg: `opus-1 train-release T-${i} in beta mode: reason ${i}`, meta: { beta: true, action: 'train-release', subject: `T-${i}`, why: `reason ${i}`, via: 'beta' }, ...over });
  const NOW = Date.UTC(2026, 10, 4, 12, 0);
  const digestCall = (S, env, eventsJs) => node(S, env, `const m = await import(${imp(S, 'beta-mode.mjs')}); const lines = await m.betaDigestLines({ events: ${eventsJs}, now: ${NOW}, root: ${JSON.stringify(S)} }); console.log(JSON.stringify(lines));`);
  await guard('digest: beta off and no use gives no section', async () => {
    const { S, env } = studio();
    const r = digestCall(S, env, '[]');
    return [r.status === 0 && r.stdout.trim() === '[]', out(r)];
  });
  await guard('digest: each use is listed with who, action, subject and why; old ones are not', async () => {
    const { S, env } = studio();
    const old = mk(9, { ts: new Date(NOW - 3 * 86400000).toISOString(), meta: { beta: true, action: 'old-action', subject: 'T-9', why: 'x' } });
    const r = digestCall(S, env, JSON.stringify([mk(1), mk(2), old, { ...mk(3), meta: {}, type: 'delegation.used' }]));
    const lines = JSON.parse(r.stdout.trim() || '[]');
    const t = lines.join('\n');
    return [/off now/.test(t) && /2 beta uses/.test(t) && /opus-1: train-release T-1 \(reason 1\)/.test(t) && /T-2 \(reason 2\)/.test(t) && !/old-action/.test(t) && !/T-3/.test(t), t || out(r)];
  });
  await guard('digest: at most 30 lines, with a count of the rest', async () => {
    const { S, env } = studio();
    const many = Array.from({ length: 45 }, (_, i) => mk(i % 55));
    const r = digestCall(S, env, JSON.stringify(many));
    const lines = JSON.parse(r.stdout.trim() || '[]');
    return [lines.length <= 30 && /and \d+ more/.test(lines[lines.length - 1]) && lines.filter((l) => /train-release/.test(l)).length + Number((lines[lines.length - 1].match(/and (\d+) more/) || [])[1]) === 45, `${lines.length} lines; last: ${lines[lines.length - 1]}`];
  });
  await guard('digest: who turned beta on and off, and when, from the events and the decisions log', async () => {
    const { S, env } = studio();
    const on = { ts: new Date(NOW - 5 * 3600000).toISOString(), type: 'beta.on', agent: 'owner', msg: 'beta mode on', meta: { by: 'owner' } };
    const off = { ts: new Date(NOW - 2 * 3600000).toISOString(), type: 'beta.off', agent: 'maint', msg: 'beta mode off by maint', meta: { by: 'maint' } };
    fs.writeFileSync(path.join(S, '.studio', 'decisions.jsonl'), `${JSON.stringify({ kind: 'decision', id: 'D-1', at: on.ts, action: 'beta-on', subject: 'studio/beta.json', by: 'owner', as: 'person', why: 'building the harness' })}\n`);
    const r = digestCall(S, env, JSON.stringify([on, off]));
    const t = JSON.parse(r.stdout.trim() || '[]').join('\n');
    return [/turned ON by owner: building the harness/.test(t) && /turned OFF by maint/.test(t) && /off now/.test(t) && (t.match(/turned ON/g) || []).length === 1, t || out(r)];
  });
  await guard('digest: beta on now is shown even with no use; buildDigest carries the section outside its 200 words', async () => {
    const { S, env } = studio();
    fs.mkdirSync(path.join(S, 'studio'), { recursive: true });
    fs.writeFileSync(path.join(S, 'studio', 'beta.json'), `${JSON.stringify({ on: true, by: 'owner', at: new Date(NOW - 3600000).toISOString(), why: 'building', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'beta: on (by owner)', '--no-verify');
    const many = Array.from({ length: 12 }, (_, i) => mk(i));
    const r = node(S, env, `const d = await import(${imp(S, 'digest.mjs')}); const x = await d.buildDigest({ now: ${NOW}, root: ${JSON.stringify(S)}, events: ${JSON.stringify(many)} }); console.log(JSON.stringify({ text: x.text, words: x.words, max: d.MAX_WORDS }));`);
    const j = JSON.parse(r.stdout.trim().split('\n').pop() || '{}');
    return [r.status === 0 && /## Beta mode/.test(j.text) && /ON now \(set by owner/.test(j.text) && /12 beta uses/.test(j.text) && j.words < j.max, `${out(r).slice(0, 600)} ${j.words}`];
  });
  await guard('digest: recordBetaUse keeps the subject and the reason in the event', async () => {
    const { S, env, ev } = studio();
    node(S, env, `const m = await import(${imp(S, 'beta-mode.mjs')}); m.recordBetaUse({ who: 'opus-1', via: 'beta' }, { action: 'release', subject: 'T-5', why: 'golden moved on purpose' });`);
    const e = evs(ev).find((x) => x.type === 'delegation.used');
    return [e?.meta?.beta === true && e.meta.subject === 'T-5' && e.meta.why === 'golden moved on purpose', JSON.stringify(e)];
  });

  // ---- launcher-side mixed lane ----
  const board = (S, lines) => { fs.mkdirSync(path.join(S, 'studio'), { recursive: true }); fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), `# Next\n\n## IN_PROGRESS\n\n## BACKLOG\n\n${lines.join('\n')}\n`); };
  const commitOn = (S, branch, file, task, text = 'x') => { g(S, 'checkout', '-q', branch); fs.writeFileSync(path.join(S, file), text); g(S, 'add', file); g(S, 'commit', '-q', '--no-verify', '-m', `work on ${file}`, '-m', task ? `Studio-Task: ${task}` : 'no trailer'); };
  const setup = (opts = {}) => {
    const s = studio();
    const { S } = s;
    board(S, ['- [ ] **T-1** (builder) the task', '- [ ] **T-2** (builder) another task', '- [ ] **T-3** (builder) a rescue: Rescue: T-2']);
    if (opts.holds) { fs.writeFileSync(path.join(S, 'studio', 'task-holds.json'), JSON.stringify({ tasks: { 'T-1': { after: ['T-2'] } } })); }
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'board', '--no-verify');
    g(S, 'branch', 'old-lane');
    for (const [file, task] of opts.commits || []) commitOn(S, 'old-lane', file, task);
    g(S, 'checkout', '-q', 'main');
    fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'lane-branches.json'), JSON.stringify({ [opts.forTask || 'T-1']: 'old-lane' }));
    const copy = path.join(S, '.lanes', 'builder-x');
    g(S, 'worktree', 'add', '-q', '-b', 'new-lane', copy, 'main');
    return { ...s, copy };
  };
  const carry = (s, task = 'T-1', extraEnv = {}) => node(s.S, { ...s.env, ...extraEnv }, `const w = await import(${imp(s.S, 'worktree.mjs')}); const r = w.carryTaskBranch(${JSON.stringify(task)}, ${JSON.stringify(s.copy)}); console.log('RESULT ' + JSON.stringify(r));`);
  const has = (s, f) => fs.existsSync(path.join(s.copy, f));
  await guard('mixed: a branch carrying another open task\'s commits is not merged; the copy has main plus the task\'s own commits', async () => {
    const s = setup({ commits: [['a-other.txt', 'T-2'], ['b-own.txt', 'T-1']] });
    const r = carry(s);
    return [r.status === 0 && /RESULT null/.test(r.stdout) && !has(s, 'a-other.txt') && has(s, 'b-own.txt'), `${out(r)} other=${has(s, 'a-other.txt')} own=${has(s, 'b-own.txt')}`];
  });
  await guard('mixed: the skip is an event, lane.mixed_skipped, naming the other task', async () => {
    const s = setup({ commits: [['a-other.txt', 'T-2'], ['b-own.txt', 'T-1']] });
    carry(s);
    const e = evs(s.env.AGENT_EVENTS_FILE).find((x) => x.type === 'lane.mixed_skipped');
    return [e && e.task === 'T-1' && /T-2/.test(e.msg) && e.meta.picked === 1 && e.meta.foreign[0].task === 'T-2', JSON.stringify(e)];
  });
  await guard('mixed: carryTaskBranchEx and the start lines say so (task start, the claim, the launcher kickoff)', async () => {
    const s = setup({ commits: [['a-other.txt', 'T-2'], ['b-own.txt', 'T-1']] });
    const r = node(s.S, s.env, `const w = await import(${imp(s.S, 'worktree.mjs')}); const x = w.carryTaskBranchEx('T-1', ${JSON.stringify(s.copy)}); const l = await import(${imp(s.S, 'lane-at-claim.mjs')}); console.log('LINES ' + JSON.stringify(l.laneAtClaimLines({ rel: '.lanes/x', dir: '/x', branch: 'b', mixed: x.mixed }))); console.log('X ' + JSON.stringify(x.mixed && x.mixed.line));`);
    const src = (f) => fs.readFileSync(path.join(s.S, 'harness', f), 'utf8');
    return [/MIXED LANE NOT MERGED: Did not merge old-lane/.test(r.stdout) && /plus 1 of T-1's own/.test(r.stdout) && /MIXED LANE NOT MERGED/.test(src('task.mjs')) && /copy\.mixed/.test(src('agent.mjs')), out(r)];
  });
  await guard('mixed: a branch of only this task\'s commits still merges', async () => {
    const s = setup({ commits: [['b-own.txt', 'T-1'], ['c-own.txt', 'T-1']] });
    const r = carry(s);
    return [/RESULT "old-lane"/.test(r.stdout) && has(s, 'b-own.txt') && has(s, 'c-own.txt'), out(r)];
  });
  await guard('mixed: an --after dependency\'s commits still merge', async () => {
    const s = setup({ holds: true, commits: [['a-dep.txt', 'T-2'], ['b-own.txt', 'T-1']] });
    const r = carry(s);
    return [/RESULT "old-lane"/.test(r.stdout) && has(s, 'a-dep.txt') && has(s, 'b-own.txt'), out(r)];
  });
  await guard('mixed: a Rescue task may carry the task it rescues', async () => {
    const s = setup({ forTask: 'T-3', commits: [['a-rescued.txt', 'T-2'], ['b-own.txt', 'T-3']] });
    const r = carry(s, 'T-3');
    return [/RESULT "old-lane"/.test(r.stdout) && has(s, 'a-rescued.txt'), out(r)];
  });
  await guard('mixed: another task that has landed (not open) does not make a mixed lane; STUDIO_TRAIN_MIXED=off turns the check off', async () => {
    const s = setup({ commits: [['a-other.txt', 'T-2'], ['b-own.txt', 'T-1']] });
    const off = carry(s, 'T-1', { STUDIO_TRAIN_MIXED: 'off' });
    const s2 = setup({ commits: [['a-other.txt', 'T-2'], ['b-own.txt', 'T-1']] });
    board(s2.S, ['- [ ] **T-1** (builder) the task', '', '## DONE', '', '- [x] **T-2** (builder) landed']);
    g(s2.S, 'add', '-A'); g(s2.S, 'commit', '-qm', 'T-2 landed', '--no-verify');
    const landed = carry(s2);
    return [/RESULT "old-lane"/.test(off.stdout) && has(s, 'a-other.txt') && /RESULT "old-lane"/.test(landed.stdout), `${out(off)} ${out(landed)}`];
  });

  // ---- rig ----
  const hbUrl = pathToFileURL(path.join(dir, 'harness', 'heavy-budget.mjs')).href;
  const rootCfg = path.join(tmpRoot, `277f-cfg-${process.pid}`);
  fs.mkdirSync(path.join(rootCfg, 'studio'), { recursive: true });
  await guard('rig: an art-bake job kind with RAM, CPU threads and minutes, art in the rig, overridable in data', async () => {
    const hb = await import(hbUrl);
    const c = hb.jobClaim('art-bake', { root: rootCfg, env: {} });
    fs.writeFileSync(path.join(rootCfg, 'studio', 'machine-budget.json'), JSON.stringify({ jobs: { 'art-bake': { ramGb: 9, cpuThreads: 6, minutes: 45 } } }));
    const o = hb.jobClaim('art-bake', { root: rootCfg, env: {} });
    const cat = hb.jobCatalog(rootCfg, {}).find((x) => x.kind === 'art-bake');
    fs.rmSync(path.join(rootCfg, 'studio', 'machine-budget.json'), { force: true });
    return [c.kind === 'art-bake' && c.ramGb > 0 && c.cpuThreads > 0 && c.minutes > 0 && o.ramGb === 9 && o.cpuThreads === 6 && o.minutes === 45 && hb.rigKind({ claim: { kind: 'art-bake' } }) === 'art' && cat?.rig === 'art' && cat.minutes === 45, JSON.stringify({ c, o, cat })];
  });
  await guard('rig: one priority table, train > builder verifies > Unity/art > soaks, and the weights come from it unchanged', async () => {
    const hb = await import(hbUrl);
    const r = (k) => hb.rigRank(k);
    const ok = r('train') < r('verify') && r('verify') === r('check') && r('check') < r('unity') && r('unity') === r('art') && r('art') < r('soak');
    const w = hb.RIG_WEIGHTS;
    return [ok && w.train === 4 && w.verify === 2 && w.check === 2 && w.soak === 1 && Object.keys(w).length === 4 && hb.jobCatalog(rootCfg, {}).every((c, i, a) => !i || a[i - 1].rank <= c.rank), JSON.stringify({ w, p: hb.RIG_PRIORITY })];
  });
  await guard('rig: the rig budget shows an art-bake share; docs name the kind and the order', async () => {
    const rb = fs.readFileSync(path.join(dir, 'harness', 'rig-budget.mjs'), 'utf8');
    const docs = fs.readFileSync(path.join(dir, 'docs', 'WORK-ORGANIZATION.md'), 'utf8');
    return [/art-bake/.test(rb) && /art-bake/.test(docs) && /train > builder verifies > Unity\/art > soaks/.test(docs) && /Beta mode/.test(fs.readFileSync(path.join(dir, 'docs', 'AUTONOMY.md'), 'utf8')) && /lane\.mixed_skipped/.test(fs.readFileSync(path.join(dir, 'docs', 'WORK-ORGANIZATION.md'), 'utf8')), 'docs/code mention']
  });
  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch {} }
  try { fs.rmSync(rootCfg, { recursive: true, force: true }); } catch {}
}

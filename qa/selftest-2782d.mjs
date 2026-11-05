/**
 * qa/selftest-2782d.mjs — 2.78.2 (d): the cross-family reviewer when Gemini is out, and builders that retry owner-only steps.
 *   - A 429 on one Gemini model (Argon) through agy is saved as agy:<model> in .studio/tool-quota.json, not as agy, so
 *     Flash still launches; the reviewer picker skips the marked model, not the tool; a tool-wide mark still skips agy.
 *   - `npm run review -- record <ID> --by … --family … --file …` records an outside review: another family only, never
 *     from a worker, written under studio/reviews/ with a header naming the outside reviewer, logged and committed.
 *   - A hand-back (or a session's last output) that names an owner-only step parks the task at the orchestrator's rank
 *     with reason owner-only, pages the orchestrator, and the supervisor's hold check keeps builders off it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782D({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', STUDIO_QUOTA_SKIP: '', STUDIO_QUOTA_MODEL_TOOLS: '', STUDIO_OWNER_ONLY_PARK: '', STUDIO_REVIEWER_TOOL: '', STUDIO_REVIEW_TOOLS: '', STUDIO_TOOL_AGY_MODEL: '', STUDIO_REVIEW_AGY_FALLBACK: '', STUDIO_BUDGET_STOP: '' };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `2782d-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'approvals'), { recursive: true, force: true });
    fs.rmSync(path.join(S, 'studio', 'task-holds.json'), { force: true });
    const ev = path.join(S, '.studio', 'events-2782d.jsonl');
    writeIn(S, '.studio/events-2782d.jsonl', '');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    made.push(S);
    return { S, env: { ...base, AGENT_EVENTS_FILE: ev }, ev };
  };
  const node = (S, args, env, input) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000, ...(input ? { input } : {}) });
  const task = (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
  const add = (S, title, env) => { const r = task(S, ['add', title, '--role', 'builder'], env); return (out(r).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1] || null; };
  const probe = (S, code, env) => { const f = path.join(S, `.probe-2782d-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const ARGON = 'gemini-4-argon-high';
  const FLASH = 'gemini-3.8-flash-high';
  const LIMIT = 'Error: 429 RESOURCE_EXHAUSTED: You have exhausted your capacity on this model. Your quota will reset after 3h0m0s.';

  // ---- 6a: a 429 on one Gemini model marks that model, not all of agy ----
  {
    const { S, env } = studio('quota');
    const r = probe(S, `import { cleanUp } from ${u(S, 'harness/agent.mjs')};
import * as B from ${u(S, 'harness/budget.mjs')};
const { budgetStopFor } = B;
import fs from 'node:fs';
fs.mkdirSync('.studio/agents', { recursive: true });
cleanUp('builder-q1', { code: 1, log: ${JSON.stringify(LIMIT)}, role: 'builder', tool: 'agy', model: '${ARGON}' });
const q = JSON.parse(fs.readFileSync('.studio/tool-quota.json', 'utf8'));
const argon = budgetStopFor({ tool: 'agy', model: '${ARGON}' });
const flash = budgetStopFor({ tool: 'agy', model: '${FLASH}' });
console.log(JSON.stringify({ keys: Object.keys(q), argon: argon.stopped, flash: flash.stopped, flashFor: Boolean(B.exhaustedFor?.('agy', '${FLASH}')), argonFor: Boolean(B.exhaustedFor?.('agy', '${ARGON}')) }));
`, env);
    await guard('2.78.2 (d): a 429 on Gemini Argon through agy is saved as "agy:gemini-4-argon-high" in .studio/tool-quota.json (not "agy"): a launch on Argon is stopped, a launch on Flash is not (fails on 2.78.1: the mark was the tool-wide key "agy", so Flash was stopped too)', () => [
      r.j && r.j.keys.length === 1 && r.j.keys[0] === `agy:${ARGON}` && r.j.argon === true && r.j.flash === false && r.j.argonFor === true && r.j.flashFor === false,
      JSON.stringify({ j: r.j, out: out(r).slice(-700) })]);

    // A tool-wide mark (old marks, auth, binary missing) still holds every model; STUDIO_QUOTA_MODEL_TOOLS=off is the old key.
    const r2 = probe(S, `import * as B from ${u(S, 'harness/budget.mjs')};
const { markExhausted, budgetStopFor } = B;
const exhaustedFor = (...a) => B.exhaustedFor?.(...a) ?? null;
const quotaKeyFor = (...a) => B.quotaKeyFor?.(...a) ?? null;
import fs from 'node:fs';
fs.rmSync('.studio/tool-quota.json', { force: true });
markExhausted('agy', 'agy: not found on PATH');
const wide = { argon: budgetStopFor({ tool: 'agy', model: '${ARGON}' }).stopped, flash: budgetStopFor({ tool: 'agy', model: '${FLASH}' }).stopped, flashFor: Boolean(exhaustedFor('agy', '${FLASH}')) };
const keys = { agy: quotaKeyFor('agy', '${ARGON}'), claude: quotaKeyFor('claude', 'claude-opus-5-5'), off: quotaKeyFor('agy', '${ARGON}', { STUDIO_QUOTA_MODEL_TOOLS: 'off' }), all: quotaKeyFor('claude', 'x', { STUDIO_QUOTA_MODEL_TOOLS: 'all' }) };
console.log(JSON.stringify({ wide, keys }));
`, env);
    await guard('2.78.2 (d): a tool-wide "agy" mark (auth, binary missing, an old mark) still stops every agy model; claude keeps one key per tool; STUDIO_QUOTA_MODEL_TOOLS=off|all change the keying (fails on 2.78.1: no per-model key at all)', () => [
      r2.j && r2.j.wide.argon === true && r2.j.wide.flash === true && r2.j.wide.flashFor === true && r2.j.keys.agy === `agy:${ARGON}` && r2.j.keys.claude === 'claude' && r2.j.keys.off === 'agy' && r2.j.keys.all === 'claude:x',
      JSON.stringify({ j: r2.j, out: out(r2).slice(-500) })]);
  }

  // ---- 6a: the reviewer picker checks the model key first ----
  {
    const { S, env } = studio('picker');
    const r = probe(S, `import { cliReview } from ${u(S, 'harness/review.mjs')};
import { markExhausted } from ${u(S, 'harness/budget.mjs')};
import fs from 'node:fs';
const calls = [];
const run = (cmd, args, opts) => {
  if (cmd === 'which' || cmd === 'where') return { status: args[0] === 'agy' ? 0 : 1, stdout: '', stderr: '' };
  calls.push(args.join(' '));
  return { status: 0, stdout: 'Looks fine. VERDICT: APPROVE', stderr: '' };
};
const g = { builder: 'claude-opus-5-5', task: { id: 'T-1' } };
const msgs = [{ role: 'user', content: 'review' }];
markExhausted('agy:${ARGON}', '429 quota will reset after 3h0m0s');
const model = await cliReview(g, msgs, { run });
fs.rmSync('.studio/tool-quota.json', { force: true });
markExhausted('agy', 'agy: 429 quota will reset after 3h0m0s');
calls.length = 0;
const wide = await cliReview(g, msgs, { run });
console.log(JSON.stringify({ model: { ok: model.ok, model: model.model, error: model.error || '' }, wide: { ok: wide.ok, error: wide.error || '' }, argv: calls }));
`, env);
    await guard('2.78.2 (d): with Argon marked out (agy:gemini-4-argon-high) the reviewer picker still reviews through agy on the Flash model for a Claude builder; with the tool-wide "agy" mark it skips agy (fails on 2.78.1: agyReview ran Argon, the default, whatever the model mark said)', () => [
      r.j && r.j.model.ok === true && r.j.model.model === FLASH && r.j.wide.ok === false && /agy: out of quota/.test(r.j.wide.error) && r.j.argv.length === 0,
      JSON.stringify({ j: r.j, out: out(r).slice(-700) })]);
  }

  // ---- 6b: record an outside review ----
  {
    const { S, env, ev } = studio('record');
    const id = add(S, 'Port the example sim loop', env);
    writeIn(S, 'work.txt', 'x\n');
    g(S, 'add', 'work.txt'); g(S, 'commit', '-qm', 'work', '--no-verify', '--trailer', `Studio-Task: ${id}`, '--trailer', 'Studio-Model: claude-opus-5-5');
    const review = 'The loop is deterministic and the test covers the tick.\nOne non-blocking note: rename the helper.\nNothing to reject.\nVERDICT: APPROVE\n';
    writeIn(S, '../2782d-review-in.md', review);
    const file = path.join(S, '..', '2782d-review-in.md');
    const orch = { ...env, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' };
    const rec = (e, extra = []) => node(S, ['harness/review.mjs', 'record', id, '--by', 'grokbot', '--file', file, ...extra], e);
    const same = rec(orch, ['--family', 'anthropic']);
    const byBuilder = rec({ ...env, STUDIO_LOCK_OWNER: 'builder-s1' }, ['--family', 'xai']);
    const byRole = rec({ ...env, STUDIO_ROLE: 'reviewer' }, ['--family', 'xai']);
    const none = rec(orch, ['--family', 'xai', '--no-such']).status; void none;
    const noVerdict = (() => { writeIn(S, '../2782d-noverdict.md', 'Looks fine to me.\n'); return node(S, ['harness/review.mjs', 'record', id, '--by', 'grokbot', '--family', 'xai', '--file', path.join(S, '..', '2782d-noverdict.md')], orch); })();
    const dir0 = (() => { try { return fs.readdirSync(path.join(S, 'studio', 'reviews')).filter((f) => f.endsWith('.md') && f !== 'README.md'); } catch { return []; } })();
    // (the earlier attempts above must have written nothing, but the "--no-such" call is a real success: it is the recording)
    const files = dir0.filter((f) => new RegExp(`-${id}-outside-grokbot`).test(f));
    const text = files.length ? fs.readFileSync(path.join(S, 'studio', 'reviews', files[0]), 'utf8') : '';
    const committed = files.length ? g(S, 'log', '-1', '--format=%s', '--', `studio/reviews/${files[0]}`).stdout.trim() : '';
    const evs = events(ev).filter((e) => e.type === 'review.recorded' && e.task === id);
    await guard('2.78.2 (d): `review record <ID> --by grokbot --family xai --file …` by the orchestrator writes studio/reviews/<date>-<ID>-outside-grokbot.md (model-family: xai, implementer-family: anthropic, an "Outside reviewer: grokbot" line, one Verdict: approve and no verdict words in the notes), commits it and logs review.recorded (fails on 2.78.1: no record command)', () => [
      files.length === 1 && /^model-family: xai$/m.test(text) && /^implementer-family: anthropic$/m.test(text) && /^Outside reviewer: grokbot \(xai\), done outside the harness/m.test(text)
        && (text.match(/^Verdict:/gm) || []).length === 1 && /^Verdict: approve$/m.test(text) && !/\b(reject|blocking|changes requested|request changes)\b/i.test(text.replace(/^Verdict:.*$/m, ''))
        && /Review: .* by grokbot \(xai/.test(committed) && evs.length === 1 && evs[0].meta?.family === 'xai',
      JSON.stringify({ files, text: text.slice(0, 600), committed, evs: evs.length })]);
    await guard('2.78.2 (d): `review record` refuses the implementer\'s own family (--family anthropic for a Claude builder), a worker (STUDIO_LOCK_OWNER builder-s1, STUDIO_ROLE reviewer) and a file with no verdict line, each exit 1 (fails on 2.78.1: no record command, so no refusal to tell apart)', () => [
      same.status === 1 && /same family as the builder/.test(out(same)) && byBuilder.status === 1 && /worker agent/.test(out(byBuilder)) && byRole.status === 1 && /can't record a review/.test(out(byRole)) && noVerdict.status === 1 && /no verdict line/.test(out(noVerdict)) && files.length === 1,
      JSON.stringify({ same: out(same).slice(0, 200), byBuilder: out(byBuilder).slice(0, 200), byRole: out(byRole).slice(0, 200), noVerdict: out(noVerdict).slice(0, 200), files })]);
  }

  // ---- 8: an owner-only step waits for the owner ----
  {
    const { S, env, ev } = studio('owner');
    const t1 = add(S, 'Tune the example scenario', env);
    const t2 = add(S, 'Another example task', env);
    const t3 = add(S, 'A third example task', env);
    for (const [id, a] of [[t1, 'builder-o1'], [t2, 'builder-o2'], [t3, 'builder-o3']]) task(S, ['start', id, '--agent', a], { ...env, STUDIO_LOCK_OWNER: a });
    const pause = (id, a, note) => task(S, ['pause', id, '--agent', a, '--note', note], { ...env, STUDIO_LOCK_OWNER: a });
    const p1 = pause(t1, 'builder-o1', 'Stopped: the scenario expectation in qa.mjs needs a re-pin. [protected] FAIL protected file changed:\n  cartridges/example/qa.mjs\n[protected] Only the owner can approve these: on the owner\'s machine, npm run approve -- protected.');
    const p2 = pause(t2, 'builder-o2', 'Stopped: the unit test fails on one assertion; I will look at the tick order next. Nothing owner-related.');
    const holds = () => readIn(S, 'studio/task-holds.json')?.tasks || {};
    const h1 = holds()[t1]?.parked;
    const e1 = events(ev).filter((e) => e.type === 'task.owner_only');
    const r = probe(S, `import { holdReason } from ${u(S, 'harness/task-hold.mjs')};
import { parseNextQueue } from ${u(S, 'harness/task.mjs')};
const q = parseNextQueue();
console.log(JSON.stringify({ t1: holdReason('${t1}', q, Date.now(), undefined, 'builder'), t2: holdReason('${t2}', q, Date.now(), undefined, 'builder') }));
`, env);
    await guard('2.78.2 (d): a hand-back whose note carries the protected check\'s refusal ("Only the owner can approve these") parks the task: reason owner-only, rank 3 (the orchestrator), parked by harness, one task.owner_only event to the orchestrator, and the supervisor\'s hold check (holdReason) now keeps builders off it; a hand-back with no owner-only phrase is not parked (fails on 2.78.1: no park, no event, holdReason is null)', () => [
      p1.status === 0 && h1?.ownerOnly === true && h1.reason === 'owner-only' && h1.rank === 3 && h1.by === 'harness' && !holds()[t2]?.parked
        && e1.length === 1 && e1[0].to === 'orchestrator' && e1[0].task === t1 && /waits for the owner/.test(e1[0].msg)
        && /owner-only/.test(r.j?.t1 || '') && !r.j?.t2 && p2.status === 0,
      JSON.stringify({ p1: out(p1).slice(0, 300), h1, e1: e1.length, hr: r.j, out: out(r).slice(-300) })]);

    // Only the orchestrator or the owner lifts it; a builder can't.
    const byBuilder = task(S, ['unpark', t1, '--by', 'builder-o9'], { ...env, STUDIO_LOCK_OWNER: 'builder-o9' });
    const stillParked = Boolean(holds()[t1]?.parked);
    const byOrch = task(S, ['unpark', t1, '--by', 'opus-1'], { ...env, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' });
    const lifted = !holds()[t1]?.parked;
    await guard('2.78.2 (d): the owner-only park is lifted by the orchestrator (`task unpark --by opus-1`) and refused to a builder (fails on 2.78.1: there is no park to lift)', () => [
      byBuilder.status !== 0 && stillParked && byOrch.status === 0 && lifted && h1?.rank === 3,
      JSON.stringify({ byBuilder: out(byBuilder).slice(0, 250), byOrch: out(byOrch).slice(0, 150), stillParked, lifted })]);

    // The launcher's own hand-back: a session that ended after the harness refused an owner-only step.
    const r3 = probe(S, `import { cleanUp } from ${u(S, 'harness/agent.mjs')};
import fs from 'node:fs';
fs.mkdirSync('.studio/agents', { recursive: true });
const log = 'working...\\n[protected] FAIL protected file changed:\\n  cartridges/example/qa.mjs\\n[protected] Only the owner can approve these: on the owner\\'s machine, npm run approve -- protected --note "why". An agent should hand the task back instead of working around it.\\n';
cleanUp('builder-o3', { code: 0, log, role: 'builder', tool: 'claude', model: 'claude-opus-5-5' });
const holds = JSON.parse(fs.readFileSync('studio/task-holds.json', 'utf8')).tasks;
console.log(JSON.stringify({ parked: holds['${t3}']?.parked || null }));
`, env);
    const e3 = events(ev).filter((e) => e.type === 'task.owner_only' && e.task === t3);
    await guard('2.78.2 (d): a session that ends right after the harness\'s own refusal (the protected check\'s last line in its output) is handed back and parked owner-only by the launcher\'s cleanup, with the orchestrator paged (fails on 2.78.1: the task went back to the queue and was relaunched)', () => [
      r3.j?.parked?.ownerOnly === true && r3.j.parked.rank === 3 && e3.length === 1 && e3[0].to === 'orchestrator',
      JSON.stringify({ j: r3.j, e3: e3.length, out: out(r3).slice(-500) })]);

    // The Communicator turns the event into an alert for the orchestrator.
    const r4 = probe(S, `import { alertsNow, routeAlert } from ${u(S, 'harness/communicator.mjs')};
const now = Date.now();
const f = { now, events: [{ ts: new Date(now - 1000).toISOString(), type: 'task.owner_only', task: 'T-9', to: 'orchestrator', msg: 'T-9 waits for the owner: builder-x hand-back names an owner-only step (a protected file changed: "Only the owner can approve these").' }], workers: [], stopFiles: [], blockers: [], crewPaused: [], queue: [], held: [], needs: [], asks: [], sup: {}, line: null };
const a = alertsNow(f).filter((x) => /owner-only/.test(x.key));
console.log(JSON.stringify({ a, route: a[0] ? routeAlert(a[0]) : null }));
`, env);
    await guard('2.78.2 (d): the Communicator raises a task.owner_only event as an alert routed to the orchestrator, not the owner (fails on 2.78.1: no alert for it)', () => [
      r4.j && r4.j.a.length === 1 && r4.j.a[0].key === 'owner-only:T-9' && JSON.stringify(r4.j.route) === '["orchestrator"]' && /waits for the owner/.test(r4.j.a[0].text),
      JSON.stringify({ j: r4.j, out: out(r4).slice(-500) })]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
  try { fs.rmSync(path.join(tmpRoot, '2782d-review-in.md'), { force: true }); } catch {}
}

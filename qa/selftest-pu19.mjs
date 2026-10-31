/**
 * qa/selftest-pu19.mjs — PU-19 (P-042): Claude Code's 5-hour and weekly limit messages count as usage limits,
 * with their reset times, and the studio waits for the reset instead of counting a failure.
 *   - "5-hour limit reached ∙ resets 3pm", "Weekly limit reached ∙ resets Mon 9am", "Opus weekly limit reached ∙
 *     resets Nov 3, 9am", "… limit reached|<unix time>", a zone in brackets "(Asia/Bangkok)": recognised, reset read.
 *   - "recursion limit reached", "file size limit reached" and the like are not usage limits.
 *   - End to end: a fake agent prints "5-hour limit reached ∙ resets <time>" mid-task under the supervisor: the tool
 *     is marked out until that time, nothing else starts, the task goes back to the queue, nothing is parked,
 *     escalated or halted; the same through a role's own command (marked "custom").
 * The wording of Claude Code's limit lines is taken from user reports, not from a live run.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftestPU19({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-pu19-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, env);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const events = () => (fs.existsSync(path.join(dir, '.studio/events.jsonl')) ? fs.readFileSync(path.join(dir, '.studio/events.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const quota = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio/tool-quota.json'), 'utf8')); } catch { return {}; } };
  // Slower platforms (Windows) get more time, as in qa/selftest.mjs; wait for a detached session to end.
  const SLOW = Number(process.env.STUDIO_SELFTEST_SLOW) || (process.platform === 'win32' ? 2.5 : 1);
  const waitFor = (fn, ms = 30000 * SLOW) => { const t = Date.now(); while (!fn() && Date.now() - t < ms) spawnSync(process.execPath, ['-e', 'setTimeout(()=>{},300)']); return fn(); };
  const holds = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/task-holds.json'), 'utf8')).tasks || {}; } catch { return {}; } };

  // 1. The table: each message is a usage limit (a plain stderr line and a stream-json error result), with its reset.
  // now = Saturday 2026-10-31 10:00 in Bangkok (03:00 UTC); the machine's zone is set to Asia/Bangkok.
  const table = [
    ['5-hour limit reached ∙ resets 3pm', '2026-10-31T08:00:00.000Z'],
    ['5-hour limit reached · resets 3pm (Asia/Bangkok)', '2026-10-31T08:00:00.000Z'],
    ['Weekly limit reached ∙ resets Mon 9am', '2026-11-02T02:00:00.000Z'],
    ['Opus weekly limit reached ∙ resets Nov 3, 9am', '2026-11-03T02:00:00.000Z'],
    ['Sonnet weekly limit reached ∙ resets 3 Nov 9am', '2026-11-03T02:00:00.000Z'],
    ['Opus weekly limit reached · resets Nov 3 at 9:00', '2026-11-03T02:00:00.000Z'],
    ['Session limit reached ∙ resets 3pm', '2026-10-31T08:00:00.000Z'],
    ["You've reached your weekly limit · resets Tuesday 14:00", '2026-11-03T07:00:00.000Z'],
    ['Claude AI usage limit reached|1793498400', '2026-11-01T02:00:00.000Z'],
    ['Claude AI usage limit reached|1793498400000', '2026-11-01T02:00:00.000Z'],
    ['Claude usage limit reached. Your limit will reset at 5pm (Europe/London).', '2026-10-31T17:00:00.000Z'],
    // New York leaves daylight time on Nov 1, 2026: Monday 9am there is 14:00 UTC, not 13:00.
    ['Weekly limit reached ∙ resets Mon 9am (America/New_York)', '2026-11-02T14:00:00.000Z'],
    ["You've hit your limit · resets 3pm", '2026-10-31T08:00:00.000Z'],
    ['Error: You\'ve hit your usage limit. Try again at 6:12 AM.', '2026-10-31T23:12:00.000Z'],
  ];
  const neg = [
    'RecursionError: maximum recursion limit reached',
    'Error: file size limit reached (10 MB)',
    'Error: memory limit reached in worker 3',
    'Error: context window limit reached',
    'Error: retry limit reached for job 7',
    'Error: daily build limit reached',
    'Error: limit reached; reset the counter and retry',
  ];
  const tableCode = `import { providerTrouble } from ${u('harness/agent.mjs')};
import { parseReset, QUOTA_ERROR, limitLine } from ${u('harness/budget.mjs')};
const now = Date.parse('2026-10-31T03:00:00Z');
const table = ${JSON.stringify(table)};
const neg = ${JSON.stringify(neg)};
const iso = (t) => { const r = parseReset(t, now); return r ? new Date(r).toISOString() : null; };
const rows = table.map(([m]) => ({ m, plain: providerTrouble('some output\\n' + m + '\\n', 1)?.kind || null, result: providerTrouble(JSON.stringify({ type: 'result', subtype: 'success', is_error: true, result: m }), 1)?.kind || null, probe: Boolean(limitLine(m + '\\n', '', 1)), reset: iso(m) }));
const negs = neg.map((m) => ({ m, re: QUOTA_ERROR.test(m), plain: providerTrouble('some output\\n' + m + '\\n', 1)?.kind || null, result: providerTrouble(JSON.stringify({ type: 'result', subtype: 'error_during_execution', is_error: true, result: m }), 1)?.kind || null }));
// The agent's own transcript quoting the line is never the provider talking.
const quoted = providerTrouble(JSON.stringify({ type: 'user', message: { content: [{ type: 'tool_result', content: '5-hour limit reached ∙ resets 3pm' }] } }), 1);
const extra = { pastEpoch: iso('Claude AI usage limit reached|1761962400'), badZone: iso('5-hour limit reached ∙ resets 3pm (Not/AZone)'), farDate: iso('Weekly limit reached ∙ resets Jan 2, 9am'), sameDayLater: iso('Weekly limit reached ∙ resets Sat 11am'), sameDayPast: iso('Weekly limit reached ∙ resets Sat 9am'), oldForms: [iso('Resets in 80h54m54s.'), iso('resets in 3 days'), iso('resets 06:12'), iso('usage limit reached')] };
console.log(JSON.stringify({ rows, negs, quoted, extra, zone: Intl.DateTimeFormat().resolvedOptions().timeZone }));`;
  const bkk = probe('table', tableCode, { TZ: 'Asia/Bangkok' });
  const want = Object.fromEntries(table);
  const badRows = (bkk.rows || []).filter((r) => r.plain !== 'quota' || r.result !== 'quota' || !r.probe || r.reset !== want[r.m]);
  report('PU-19 (P-042): each 5-hour / weekly / Opus / session / epoch limit message is a usage limit (plain line, stream-json result and the budget probe), with its reset time',
    (bkk.rows || []).length === table.length && !badRows.length, JSON.stringify(badRows.length ? badRows : bkk).slice(0, 2500));
  const badNeg = (bkk.negs || []).filter((r) => r.re || r.plain === 'quota' || r.result === 'quota');
  report('PU-19 (P-042): ordinary errors that say "limit reached" (recursion, file size, memory, context, retry, a build limit, "reset the counter") are not usage limits, and a transcript quoting the limit line marks nothing',
    (bkk.negs || []).length === neg.length && !badNeg.length && bkk.quoted === null, JSON.stringify(badNeg.length ? badNeg : bkk).slice(0, 2500));
  const x = bkk.extra || {};
  report('PU-19 (P-042): "|<unix time>" in seconds or milliseconds is the reset; one already past is no reset (1 h assumed); a date over 45 days off isn\'t believed; a weekday later today is today, earlier today is next week; older forms read as before',
    x.pastEpoch === null && x.farDate === null && x.sameDayLater === '2026-10-31T04:00:00.000Z' && x.sameDayPast === '2026-11-07T02:00:00.000Z' && JSON.stringify(x.oldForms) === JSON.stringify(['2026-11-03T11:54:54.000Z', '2026-11-03T03:00:00.000Z', '2026-10-31T23:12:00.000Z', null]),
    JSON.stringify(x));
  // The same messages on a machine in Los Angeles: a bracketed zone decides; without one the machine's local time does.
  const la = probe('table-la', tableCode, { TZ: 'America/Los_Angeles' });
  const laReset = Object.fromEntries((la.rows || []).map((r) => [r.m, r.reset]));
  const zoned = table.filter(([m]) => /\([A-Za-z_]+\/[A-Za-z_]+\)|\|\d+/.test(m)).map(([m]) => m);
  report('PU-19 (P-042): a zone in brackets "(Asia/Bangkok)" is applied to the clock time whatever the machine\'s zone; without one the machine\'s local time is used (as before), and an unknown zone falls back to it',
    la.zone === 'America/Los_Angeles' && zoned.length >= 5 && zoned.every((m) => laReset[m] === want[m]) && laReset['5-hour limit reached ∙ resets 3pm'] === '2026-10-31T22:00:00.000Z' && laReset['Weekly limit reached ∙ resets Mon 9am'] === '2026-11-02T17:00:00.000Z' && x.badZone === '2026-10-31T08:00:00.000Z' && la.extra?.badZone === '2026-10-31T22:00:00.000Z',
    JSON.stringify({ zone: la.zone, laReset, bad: la.extra?.badZone }).slice(0, 2000));

  // 2. End to end. A studio copy with git, a fast pace, one tool in the order, and stand-in agents. The real
  // claude is never called: its launch command is the fake, and the quota probe is off.
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  if (!fs.existsSync(path.join(dir, '.git'))) {
    g('init', '-q', '-b', 'main');
    g('add', '-A');
    g('commit', '-qm', 'studio', '--no-verify');
  }
  const fake = (name, line) => {
    fs.writeFileSync(path.join(dir, name), `import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
const [agent, task] = process.argv.slice(2);
const sh = (...a) => spawnSync(process.execPath, a, { encoding: 'utf8', env: process.env });
sh('harness/task.mjs', 'start', task, '--agent', agent, '--model', 'fake-1');
sh('harness/lock.mjs', 'claim', 'path:docs/fake', '--owner', agent);
fs.mkdirSync('docs/fake', { recursive: true });
fs.writeFileSync('docs/fake/' + agent + '.md', '# half-done work by ' + agent + '\\n');
process.stderr.write(${JSON.stringify(line)} + '\\n');
process.exit(1);
`);
    return `node ${name} {agent} {task}`;
  };
  // The reset 2 h from now, written as Claude Code writes it ("3:07pm"), in the machine's zone (UTC here).
  const reset = new Date(Date.now() + 2 * 3600000);
  reset.setUTCSeconds(0, 0);
  const hh = reset.getUTCHours();
  const said = `5-hour limit reached ∙ resets ${hh % 12 || 12}:${String(reset.getUTCMinutes()).padStart(2, '0')}${hh >= 12 ? 'pm' : 'am'}`;
  const base = { TZ: 'UTC', STUDIO_HEARTBEAT_SEC: '1', STUDIO_SUPERVISOR_SEC: '1', STUDIO_LAUNCH_LOCK_SEC: '1', STUDIO_QUOTA_PROBE: 'off', STUDIO_CLAUDE_PROBE_CMD: 'node -e "process.exit(3)"', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_AUTO_FINISH: 'off', STUDIO_POST_BROWSER_PLAY: 'off' };
  run(dir, 'node harness/mode.mjs set fast --by selftest', base);
  run(dir, 'node harness/budget.mjs order claude', base);
  const add = (title) => JSON.parse(run(dir, `node harness/task.mjs add "${title}" --role rnd --priority P0`, base).stdout).id;
  const ta = add('Polish the dock labels');
  add('Polish the pier labels');
  const limitedCmd = fake('.probe-pu19-limited.mjs', said);
  const env1 = { ...base, STUDIO_RND_TOOL: 'claude', STUDIO_TOOL_CLAUDE_CMD: limitedCmd };
  const t0 = new Date().toISOString();
  const sup = run(dir, `node harness/supervisor.mjs --no-hub --until ${Math.ceil(10 * SLOW)}s --foreground`, env1);
  waitFor(() => events().some((e) => e.ts >= t0 && e.type === 'agent.session.end'));
  const ev1 = events().filter((e) => e.ts >= t0);
  const starts = ev1.filter((e) => e.type === 'agent.session.start');
  const end = ev1.find((e) => e.type === 'agent.session.end');
  const paused = ev1.find((e) => e.type === 'task.paused');
  const mark = quota().claude;
  const counted = ev1.filter((e) => e.type === 'task.breaker' || e.type === 'supervisor.halted' || (e.type === 'task.hold' && /Parked/.test(e.msg || '')) || /^model\.escalat/.test(e.type) || e.type === 'tool.takeover');
  const queue = fs.readFileSync(path.join(dir, 'studio/NEXT.md'), 'utf8');
  report('PU-19 (P-042) end to end: an agent that prints "5-hour limit reached ∙ resets <time>" mid-task under the supervisor marks claude out until exactly that time; no other session starts while it is out',
    starts.length === 1 && mark?.until === reset.toISOString() && mark?.resetKnown === true && mark?.line === said && end?.meta?.usageLimit?.until === reset.toISOString(),
    `${said} -> ${JSON.stringify(mark)}\nstarts ${starts.length}\n${out(sup).slice(-600)}\n${ev1.map((e) => `${e.type} ${e.msg || ''}`).join('\n').slice(0, 2000)}`);
  report('PU-19 (P-042) end to end: the task goes back to the queue with a "stopped at its usage limit" note and its work saved; the session ends as a warning, not an error; nothing is parked, tripped, escalated, taken over or halted',
    paused?.task === ta && /stopped at its usage limit/.test(paused.msg) && !paused.meta?.reasonKey && end?.status === 'warn' && !counted.length && new RegExp(`## BACKLOG[\\s\\S]*${ta}[\\s\\S]*## DONE`).test(queue) && !holds()[ta]?.parked && fs.existsSync(path.join(dir, `.studio/wip/${ta}-${end?.agent}.patch`)),
    `${JSON.stringify(paused)}\n${JSON.stringify(end?.status)}\n${counted.map((e) => `${e.type} ${e.msg}`).join('\n')}`);

  // 3. The same limit three times on one task (the mark cleared between, as if each reset had passed): no breaker
  // (2 same-reason hand-backs), no loop park (3 in 2 h), no tier-up, and the supervisor doesn't halt on them.
  // The control, a real failure twice, does trip the breaker and halt the supervisor (the counters are live).
  const tb = add('Polish the ferry labels');
  for (const n of [1, 2, 3]) {
    run(dir, 'node harness/budget.mjs clear claude', base);
    run(dir, `node harness/agent.mjs start --role rnd --agent lim-${n} --tool claude --task ${tb}`, env1);
  }
  const tc = add('Polish the quay labels');
  const failCmd = fake('.probe-pu19-failing.mjs', 'Error: build failed: 3 type errors');
  for (const n of [1, 2]) {
    run(dir, 'node harness/budget.mjs clear claude', base);
    run(dir, `node harness/agent.mjs start --role rnd --agent ctl-${n} --tool claude --task ${tc}`, { ...env1, STUDIO_TOOL_CLAUDE_CMD: failCmd });
  }
  const counts = probe('counts', `import { escalationFor } from ${u('harness/model-tiers.mjs')};
import { supervise } from ${u('harness/supervisor.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const ev = readRecentEvents(20000);
const lim = await supervise({ dryRun: true }, { startedAt: Date.now() - 3600000, names: ['lim-1', 'lim-2', 'lim-3'] });
const ctl = await supervise({ dryRun: true }, { startedAt: Date.now() - 3600000, names: ['ctl-1', 'ctl-2'] });
console.log(JSON.stringify({ limPauses: ev.filter((e) => e.type === 'task.paused' && e.task === ${JSON.stringify(tb)}).length, limEsc: escalationFor(${JSON.stringify(tb)}), ctlEsc: escalationFor(${JSON.stringify(tc)}), limWhy: lim.why, ctlWhy: ctl.why }));`, base);
  const hb = holds();
  report('PU-19 (P-042): three usage-limit stops on one task count as nothing (no breaker, no loop park, no model tier-up, no supervisor halt); two real failures still trip the breaker and halt the supervisor',
    counts.limPauses === 3 && !hb[tb]?.parked && counts.limEsc === null && !(counts.limWhy || []).some((w) => /halted/.test(w)) && hb[tc]?.parked?.breaker === true && counts.ctlEsc?.failed === 2 && (counts.ctlWhy || []).some((w) => /halted: two sessions in a row ended with exit 1/.test(w)),
    JSON.stringify({ counts, hb }).slice(0, 2500));

  // 4. Through a role's own command (STUDIO_RND_CMD, the tool unknown): the limit is marked "custom" with its
  // reset (a bracketed zone this time), and the supervisor waits for it instead of starting a session a minute.
  run(dir, 'node harness/budget.mjs clear claude', base);
  const customCmd = fake('.probe-pu19-custom.mjs', '5-hour limit reached · resets 11:30pm (Asia/Bangkok)');
  const t1 = new Date().toISOString();
  const sup2 = run(dir, `node harness/supervisor.mjs --no-hub --until ${Math.ceil(8 * SLOW)}s --foreground`, { ...base, STUDIO_RND_CMD: customCmd });
  waitFor(() => events().some((e) => e.ts >= t1 && e.type === 'agent.session.end'));
  const ev2 = events().filter((e) => e.ts >= t1);
  const cm = quota().custom;
  const bkkNow = new Date(Date.now() + 7 * 3600000);
  const exp = Date.UTC(bkkNow.getUTCFullYear(), bkkNow.getUTCMonth(), bkkNow.getUTCDate(), 23, 30) - 7 * 3600000;
  const expIso = new Date(exp > Date.parse(t1) ? exp : exp + 86400000).toISOString();
  report('PU-19 (P-042) end to end through a role\'s own command: the limit is marked "custom" until its reset (11:30pm Bangkok), the supervisor starts one session and then waits, nothing is parked or halted',
    ev2.filter((e) => e.type === 'agent.session.start').length === 1 && cm?.until === expIso && ev2.some((e) => e.type === 'agent.session.end' && e.status === 'warn' && e.meta?.usageLimit?.on === 'custom') && !ev2.some((e) => e.type === 'task.breaker' || e.type === 'supervisor.halted' || (e.type === 'task.hold' && /Parked/.test(e.msg || ''))),
    `${expIso} ${JSON.stringify(cm)}\n${out(sup2).slice(-400)}\n${ev2.map((e) => `${e.type} ${e.status || ''} ${e.msg || ''}`).join('\n').slice(0, 2000)}`);
  for (const f of fs.readdirSync(dir)) if (f.startsWith('.probe-pu19-')) fs.rmSync(path.join(dir, f), { force: true });
}

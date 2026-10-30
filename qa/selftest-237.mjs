/**
 * qa/selftest-237.mjs — the 2.37.0 checks: the whole-game check after work lands (harness/whole-game.mjs).
 * The copy is made a git repo; a tiny stand-in for run-gates (STUDIO_WHOLE_CMD) fails when game.txt says
 * "broken", and fails once then passes alone when it says "flaky".
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest237({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (...a) => spawnSync('git', a, { cwd: dir, encoding: 'utf8' });
  const evFile = path.join(dir, '.studio', 'events-237.jsonl');
  const env = { AGENT_EVENTS_FILE: evFile, STUDIO_GATE_SLOTS: '0', STUDIO_WHOLE_GAME: 'on', STUDIO_WHOLE_CMD: 'node wcheck.mjs', STUDIO_HEALTH_CI: 'off', STUDIO_MAIN_ROOT: '' };
  let n = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p237-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: out(r) }; }
  };
  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'wcheck.mjs'), `import fs from 'node:fs';
const t = fs.readFileSync('game.txt', 'utf8');
const only = process.argv.includes('--only');
if (/broken/.test(t) || (/flaky/.test(t) && !only)) { console.log('[gates] FAIL demo'); process.exit(1); }
console.log('[gates] PASS demo');
`);
  const commit = (text, msg) => {
    fs.writeFileSync(path.join(dir, 'game.txt'), `${text}\n`);
    g('add', '-A');
    g('-c', 'user.name=t', '-c', 'user.email=t@t', 'commit', '-qm', msg, '--no-verify');
    return g('rev-parse', 'HEAD').stdout.trim();
  };
  g('init', '-q', '-b', 'main');
  g('config', 'core.autocrlf', 'false');
  const sha1 = commit('fine', 'start');

  // 1. Off unless asked for; due on a commit it hasn't seen.
  const d = probe(`import { wholeDue } from ${u('harness/whole-game.mjs')};
console.log(JSON.stringify({ off: wholeDue({ env: {} }), on: wholeDue() }));`);
  report('2.37.0: the whole-game check is off unless STUDIO_WHOLE_GAME=on, and is due on a commit of the studio branch it has not seen', d.off === null && d.on?.sha === sha1, JSON.stringify(d));

  // 2. Green: runs in its own clean copy at exactly that commit; the main checkout is untouched.
  fs.mkdirSync(path.join(dir, '.studio', 'whole-wt'), { recursive: true });
  const green = probe(`import { runWhole } from ${u('harness/whole-game.mjs')};
console.log(JSON.stringify(await runWhole()));`);
  const wt = path.join(dir, '.studio', 'whole-wt');
  fs.writeFileSync(path.join(wt, 'leftover.txt'), 'junk from an earlier run');
  const statusMain = g('status', '--porcelain').stdout.trim();
  report('2.37.0: a green whole-game run checks the exact commit in its own copy (.studio/whole-wt) and leaves the main checkout untouched', green.result === 'green' && green.lastGreen?.sha === sha1 && spawnSync('git', ['rev-parse', 'HEAD'], { cwd: wt, encoding: 'utf8' }).stdout.trim() === sha1 && statusMain === '', JSON.stringify({ green, statusMain }));

  // 3. Red after a landing: re-run alone first, then a P0 fix task naming the check and the landed task.
  const sha2 = commit('broken', 'T-7 work');
  probe(`import { emitEvent } from ${u('harness/event.mjs')};
emitEvent({ type: 'lane.merged', agent: 'b1', task: 'T-7', msg: 'T-7 landed' });
console.log('{}');`);
  const red = probe(`import { runWhole } from ${u('harness/whole-game.mjs')};
import { parseNextQueue } from ${u('harness/task.mjs')};
import { taskType } from ${u('harness/done-check.mjs')};
import { needsYou, renderNeeds } from ${u('harness/health.mjs')};
const r = await runWhole();
const t = [...parseNextQueue().inProgress, ...parseNextQueue().backlog].find((x) => x.id === r.task);
console.log(JSON.stringify({ r, title: t?.title || null, prio: t?.priority || null, type: t ? taskType(t) : null, morning: renderNeeds(await needsYou([], {})) }));`);
  const lines = () => (fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
  const brief = red.r?.task ? path.join(dir, 'studio', 'handoffs', `${red.r.task}.md`) : '';
  report('2.37.0: a red whole-game run (still red when re-run alone) queues one P0 fix task naming the failing check, the commits and the task that landed since the last green run, with a brief; the morning report lists it', red.r?.result === 'red' && red.r.failed?.join() === 'demo' && !fs.existsSync(path.join(wt, 'leftover.txt')) && new RegExp(`^Whole-game check red at ${sha2.slice(0, 8)}: demo after T-7`).test(red.title || '') && red.type === 'whole' && fs.existsSync(brief) && /git log/.test(fs.readFileSync(brief, 'utf8')) && /whole-game check is red at/.test(red.morning || '') && lines().some((e) => e.type === 'whole.red'), JSON.stringify(red));

  // 4. Still red on the next commit: no second fix task.
  commit('broken still', 'more');
  const red2 = probe(`import { runWhole } from ${u('harness/whole-game.mjs')};
console.log(JSON.stringify(await runWhole()));`);
  report('2.37.0: while a whole-game fix task is open, a later red run adds to the log but queues no second task', red2.result === 'red' && red2.task === red.r?.task, JSON.stringify(red2));

  // 5. A failure that passes alone is "environment", not a break.
  const sha4 = commit('flaky', 'flaky');
  const fl = probe(`import { runWhole } from ${u('harness/whole-game.mjs')};
console.log(JSON.stringify(await runWhole()));`);
  report('2.37.0: a check that fails in the full run but passes when re-run alone is logged as environment (a busy or flaky box), counts as green and queues nothing', fl.result === 'environment' && fl.ok === true && fl.lastGreen?.sha === sha4 && lines().some((e) => e.type === 'whole.environment'), JSON.stringify(fl));

  // 6. The watchdog's kick: a background run on the new commit; not due again while it runs or after.
  const sha5 = commit('fine again', 'fixed');
  const k = probe(`import { wholeKick, wholeDue, readWhole } from ${u('harness/whole-game.mjs')};
const a = wholeKick();
const dueWhile = wholeDue();
let s = readWhole();
for (let i = 0; i < 100 && s.last?.sha !== ${JSON.stringify(sha5)}; i++) { await new Promise((r) => setTimeout(r, 200)); s = readWhole(); }
console.log(JSON.stringify({ a, dueWhile, last: s.last, dueAfter: wholeDue() }));`);
  report('2.37.0: the watchdog step starts the whole-game check in the background on a new commit, and it is not started twice', /started the whole-game check/.test(k.a?.msg || '') && k.dueWhile === null && k.last?.sha === sha5 && k.last.result === 'green' && k.dueAfter === null, JSON.stringify(k));
}

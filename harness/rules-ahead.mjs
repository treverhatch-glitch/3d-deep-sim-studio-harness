/**
 * harness/rules-ahead.mjs — 2.94: the next batch's rules check, run beside the current land run (engines.<x>.rules.ahead).
 * The train starts it as a detached child just before its land run: the lanes the next train would take, merged on the
 * checked head of this batch. The child waits until the land run holds its machine:heavy slot, starts only while free
 * RAM minus the floor holds what one rules run takes (rules-parts.mjs splitPlan), and runs the batch only. The train
 * ends it with its whole process tree unless the land run landed the batch unchanged; then the next train finds its
 * result, or waits for it when it still runs for the tree that train wants. A red ahead judges no lane. 2.95: with
 * rules.shards each test command starts when its measured peak fits beside the land run (docs/NATIVE-ENGINE.md).
 * Files in .studio/engine: <x>-rules-ahead.json (the train's: pid, lanes, keys, verdict), <x>-rules-ahead-out.json (the
 * child's: state, decisions, the kept results before it ran), <x>-rules-ahead-job.json (what to run).
 *   node harness/rules-ahead.mjs <job file>   (the child; the train starts it)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readJson, writeAtomic } from './fsafe.mjs';
import { emitEvent } from './event.mjs';
import { rulesConfig, rulesGate, rulesKey, rulesTimeout, rulesCacheKeys, rulesCacheForget, removeCheckout, rulesPeakGb } from './engine-rules.mjs';
import { splitPlan, readFreeGb } from './rules-parts.mjs';
import { heavyHolders, holderLive } from './heavy.mjs';
import { selfIdentity, pidAlive } from './proc-identity.mjs';

const SELF = fileURLToPath(import.meta.url);
const fileOf = (root, engine, k) => path.join(root, '.studio', 'engine', `${engine}-rules-ahead${k}.json`);
const put = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); writeAtomic(f, `${JSON.stringify(v, null, 2)}\n`); };
const pause = (ms) => new Promise((r) => { setTimeout(r, ms); });
const short = (x) => String(x || '').slice(0, 10);
const live = (m, o) => Boolean(m?.pid) && pidAlive(m.pid, o?.pid === m.pid ? o.identity : undefined) && holderLive({ pid: m.pid, at: Date.now() });
const tell = (root, engine, m, outcome, why = '') => { try { emitEvent({ type: `task.train.${engine}.rules_ahead`, agent: `${engine}-train`, track: `engine:${engine}`, status: ['dropped', 'kept-red', 'not-started'].includes(outcome) ? 'warn' : 'ok', msg: `the check ahead of ${m.tasks.join(', ')}: ${outcome}${why ? ` (${why})` : ''}`.slice(0, 600), meta: { train: m.train, engine, tasks: m.tasks, head: m.head, tree: m.key, outcome, why: String(why).slice(0, 300) } }); } catch { /* the log says it */ } };
const clear = (root, engine) => { for (const k of ['', '-out', '-job']) { try { fs.rmSync(fileOf(root, engine, k), { force: true }); } catch { /* gone */ } } };

/** Start the child for `lanes` merged on `head` (its merged head is `next`). The record, after one log line. */
export function aheadStart({ root, engine, repo, target, head, next, lanes, cfg, from, extraFrom, train, landLabel, env = process.env, log = () => {} }) {
  const job = { root, engine, repo, target, head, lanes: lanes.map(({ task, branch, head: h }) => ({ task, branch, head: h })), from, extraFrom, train, landLabel };
  for (const k of ['', '-out']) fs.rmSync(fileOf(root, engine, k), { force: true });
  put(fileOf(root, engine, '-job'), job);
  // Detached on every system: on Windows a child that is not detached ends with the train's process, and this one must outlive it.
  const c = spawn(process.execPath, [SELF, fileOf(root, engine, '-job')], { cwd: root, env, detached: true, stdio: 'ignore', windowsHide: true });
  c.on('error', () => {}); c.unref();
  const m = { train, pid: c.pid, tasks: job.lanes.map((l) => l.task), heads: job.lanes.map((l) => l.head), head, next, key: rulesKey({ repo, sha: next, cfg }), baseKey: rulesKey({ repo, sha: head, cfg }), at: new Date().toISOString(), told: 0 };
  put(fileOf(root, engine, ''), m);
  log(`of ${m.tasks.join(', ')} on ${short(head)} waits for this land run to hold the machine, then for free memory (pid ${c.pid})`);
  return m;
}

/** End the child with its process tree and forget what it kept; one event. */
async function endIt(root, engine, m, o, why) {
  if (live(m, o)) {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(m.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else { try { process.kill(-m.pid, 'SIGTERM'); } catch { /* gone */ } }
    for (const until = Date.now() + 15000; live(m, o) && Date.now() < until;) await pause(100);
    if (live(m, o) && process.platform !== 'win32') { try { process.kill(-m.pid, 'SIGKILL'); } catch { /* gone */ } }
  }
  // 2.96: an exact-tree green it finished stays kept (a fact about that tree); the rest it added is forgotten.
  if (o?.before) rulesCacheForget(root, engine, o.before, { keepTree: true });
  // A run ended mid-way leaves its throwaway checkout (runRulesAt's own clean-up did not run).
  const job = readJson(fileOf(root, engine, '-job')); const tmp = path.join(root, '.studio', 'tmp');
  try { for (const d of fs.readdirSync(tmp)) if (job?.repo && d.startsWith(`rules-${m.train}-ahead`)) removeCheckout(job.repo, path.join(tmp, d)); } catch { /* none */ }
  if (o?.state === 'running' || o?.state === 'done') tell(root, engine, m, 'dropped', why);
  clear(root, engine);
}

/** The child's decisions not said yet, plus the kept outcome once it is done and its land run landed. */
function news(root, engine, m) {
  const cur = readJson(fileOf(root, engine, '')) || {};
  Object.assign(m, { told: cur.told || 0, toldDone: Boolean(cur.toldDone) });
  const o = readJson(fileOf(root, engine, '-out')) || {};
  const lines = (o.lines || []).slice(m.told || 0);
  if (m.verdict === 'kept' && o.state === 'done' && !m.toldDone) {
    // 2.95: 'partial': it stopped between shards; the shards it finished green are kept, the next train runs the rest.
    const ok = ['pass', 'red', 'partial'].includes(o.status);
    if (!ok) rulesCacheForget(root, engine, o.before);
    tell(root, engine, m, ok ? `kept-${{ pass: 'green', red: 'red', partial: 'partial' }[o.status]}` : 'dropped', o.why);
    lines.push(!ok ? `ended without an answer (${o.why}): nothing of it is kept` : o.status === 'partial' ? `stopped between shards (${o.why}): the shards it finished green are kept for ${m.tasks.join(', ')}; the next train runs the rest` : `ended ${o.status === 'pass' ? 'green' : 'red (it judges no lane; the next train asks the target as before)'}: its result is kept for ${m.tasks.join(', ')}`);
    m.toldDone = true;
  }
  m.told = (o.lines || []).length;
  put(fileOf(root, engine, ''), m);
  return { o, lines };
}

/** The train's verdict once its land run answered: keep (landed unchanged) or end it. Log lines. */
export async function aheadVerdict(root, engine, { keep, why = '' }) {
  const m = readJson(fileOf(root, engine, ''));
  if (!m || m.verdict) return [];
  m.verdict = keep ? 'kept' : 'dropped';
  put(fileOf(root, engine, ''), m);
  const { o, lines } = news(root, engine, m);
  if (o.state === 'not-started') { clear(root, engine); return lines; }
  if (!keep) { await endIt(root, engine, m, o, why); return [...lines, `was ended: ${why}; nothing of it is kept`]; }
  return o.state === 'done' ? lines : [...lines, 'goes on: this land run landed the batch unchanged; the next train takes its result'];
}

/**
 * The next train, before its own rules check: a check ahead for exactly the tree it wants (key) is waited for while it
 * runs; one for another tree, or one whose train ended without a verdict, is ended. { train, waitedMs, status } or null.
 */
export async function aheadFor(root, engine, { key, train, log = () => {} }) {
  const m = readJson(fileOf(root, engine, ''));
  if (!m || m.train === train) return null;
  let { o, lines } = news(root, engine, m);
  for (const l of lines) log(`of train ${m.train} ${l}`);
  const want = m.verdict === 'kept' && key() === m.key;
  if (!want || o.state === 'not-started') {
    if (m.verdict === 'kept' && !live(m, o)) { clear(root, engine); return null; }
    const why = !m.verdict ? 'its train ended before its land run answered' : 'this train checks another tree';
    if (live(m, o)) log(`of train ${m.train} was ended: ${why}`);
    await endIt(root, engine, m, o, why);
    return null;
  }
  const t0 = Date.now();
  const limit = Number(o.limitMs) > 0 ? o.limitMs : 120 * 60000;
  if (live(m, o)) log(`of train ${m.train} still runs for this batch's tree: this train waits for it instead of running the same tests`);
  // Its own runs end at their time limits; this bound is a safety net (the wait for the land run, rules.first, the batch).
  while (live(m, o) && Date.now() - Date.parse(m.at) < 3 * limit + 60000) await pause(200);
  ({ o, lines } = news(root, engine, m));
  for (const l of lines) log(`of train ${m.train} ${l}`);
  if (live(m, o) || o.state !== 'done') { await endIt(root, engine, m, o, 'it did not finish within its time limit'); return null; }
  clear(root, engine);
  return { train: m.train, waitedMs: Date.now() - t0, status: o.status };
}

/** `train cancel`: the check ahead ends with the train. */
export async function aheadEnd(root, engine, why) {
  const m = readJson(fileOf(root, engine, ''));
  if (m) await endIt(root, engine, m, readJson(fileOf(root, engine, '-out')), why);
}

/** The line for `train status` while it runs, or ''. */
export function aheadLine(root, engine) {
  const m = readJson(fileOf(root, engine, ''));
  const o = readJson(fileOf(root, engine, '-out')) || {};
  if (!m || !live(m, o) || !['waiting', 'running'].includes(o.state)) return '';
  return `Checking the next batch ahead: ${m.tasks.join(', ')}, since ${Math.round((Date.now() - Date.parse(m.at)) / 60000)} min${o.state === 'waiting' ? ' (waiting for the land run to hold the machine)' : ''}`;
}

async function child(jobFile) {
  const job = readJson(jobFile);
  if (!job) return 1;
  const { root, engine, repo, train } = job; const env = process.env;
  const o = { pid: process.pid, identity: selfIdentity(), state: 'waiting', lines: [] };
  const save = (x = {}, line = '') => { Object.assign(o, x); if (line) o.lines.push(line); put(fileOf(root, engine, '-out'), o); };
  const verdict = () => readJson(fileOf(root, engine, ''))?.verdict || '';
  const cfg = rulesConfig(engine, { root, env, repo, ref: job.target });
  if (!cfg) { tell(root, engine, { train, tasks: job.lanes.map((l) => l.task), head: job.head, key: null }, 'not-started', 'no rules check is configured'); return save({ state: 'not-started' }, 'was not started: no rules check is configured'); }
  // The same time limit as the next train's own check; the wait for the land run counts against it too.
  const limitMs = rulesTimeout(root, engine, cfg, 'full').min * 60000;
  save({ limitMs });
  const t0 = Date.now(); const poll = Math.max(50, Number(env.STUDIO_HEAVY_POLL_MS) || 1000);
  const me = { train, tasks: job.lanes.map((l) => l.task), head: job.head, key: null };
  // 2.95: every way it does not start is an event (not-started, with the reason), so an overseer can count them.
  const notStarted = (why) => { tell(root, engine, me, 'not-started', why); return save({ state: 'not-started' }, `was not started: ${why}`); };
  while (!verdict() && !heavyHolders(root, { env }).some((h) => h.label === job.landLabel) && Date.now() - t0 < limitMs) await pause(poll);
  if (verdict() === 'dropped') return notStarted('the land run ended before it could start');
  // 2.95: a rules run's own measured peak (rules.peak) is what one run takes, when it is known.
  const plan = splitPlan(cfg.focus || {}, { root, engine, env, peakGb: rulesPeakGb(root, engine, cfg) });
  const roomNow = () => { const free = readFreeGb(env); return free === null ? null : Math.round((free - plan.floorGb) * 10) / 10; };
  const { chainOnTarget } = await import('./unity-train.mjs');
  const gate = (admit) => rulesGate({ engine, repo, tip: job.head, lanes: job.lanes, cfg, from: job.from, extraFrom: job.extraFrom, owe: true, root, id: `${train}-ahead`, env, chain: (t, ls) => chainOnTarget(repo, t, ls, `${train}-ahead`, engine), batchOnly: true, admit });
  let rg;
  let started = 0;
  if (!cfg.shards) {
    const room = roomNow();
    if (room === null || room < plan.gb) return notStarted(room === null ? 'free RAM is not known' : `free RAM minus the floor is ${room} GB with the land run going, under the ${plan.gb} GB one rules run takes`);
    save({ state: 'running', before: rulesCacheKeys(root, engine) }, `started: ${me.tasks.join(', ')} on ${short(job.head)}, ${room} GB free over the floor (${plan.gb} GB for one rules run)`);
    tell(root, engine, me, 'started');
    rg = gate(null);
  } else {
    // Shard by shard: each test command starts when its own measured peak (else the plan's number) fits beside the land run.
    save({ before: rulesCacheKeys(root, engine) });
    const waited = new Set();
    const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
    const admit = ({ filter }) => {
      const need = rulesPeakGb(root, engine, cfg, filter) || plan.gb;
      let lack = '';
      for (;;) {
        if (verdict()) return `the land run answered${lack ? ` while ${filter} waited for memory (${lack})` : ''}`;
        const room = roomNow();
        if (room !== null && room >= need) {
          if (!started++) { save({ state: 'running' }, `started: ${me.tasks.join(', ')} on ${short(job.head)}, shard by shard; ${filter} first: ${room} GB free over the floor (${need} GB)`); tell(root, engine, me, 'started'); }
          else save({}, `${filter} starts: ${room} GB free over the floor (${need} GB)`);
          return true;
        }
        if (Date.now() - t0 >= limitMs) return `free RAM minus the floor stayed under the ${need} GB ${filter} takes for the time limit`;
        lack = room === null ? 'free RAM is not known' : `${room} GB free over the floor, ${need} GB needed`;
        if (!waited.has(filter)) { waited.add(filter); save({}, `${filter} waits for memory: ${lack}`); }
        sleep(poll);
      }
    };
    rg = gate(admit);
    if (rg.stopped && !started) return notStarted(String(rg.why || '').replace(/^stopped before /, ''));
    if (!started) { save({ state: 'running' }); tell(root, engine, me, 'started'); }
  }
  save({ state: 'done', status: rg.stopped ? 'partial' : rg.ahead || 'error', why: String(rg.why || '').slice(0, 300) });
  const m = readJson(fileOf(root, engine, ''));
  if (m?.verdict === 'kept') news(root, engine, m);
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === SELF) child(process.argv[2]).then(() => process.exit(0), () => process.exit(1));

/**
 * qa/selftest-279f.mjs — 2.79 (f): measuring and trimming.
 *   - `npm run gates -- stats`: per gate runs / times red / last red / "never red in N days" from the gates.run events;
 *     the morning health report carries the same table; the gates.run event records each gate's time (gateMs).
 *   - Telemetry: diagnostics nothing reads per event (gate.timeout_scaled, machine.sample, prompt.prefix.volatile) are
 *     counted and written as one hourly <type>.summary; STUDIO_TELEMETRY=full writes every one again.
 *   - `npm run studio:reload-env` lists the STUDIO_* names the .env sets (never values) and flags unknown ones.
 *   - The default heavy slot count follows the RAM: about one slot per 10 GB.
 *   - STUDIO_API_POOL: builders on an API key start while the plan's budget is high, not otherwise; `agent start --pool api`.
 *   - A second session end naming the same owner-only step neither relaunches a builder nor pages again.
 * A temp copy of the studio per check; probe scripts run in it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest279F({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const readIn = (cwd, rel) => { try { return JSON.parse(fs.readFileSync(path.join(cwd, rel), 'utf8')); } catch { return null; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_HEALTH_CI: 'off', STUDIO_RAM_FLOOR_GB: '0',
    STUDIO_TEST_FREEMEM_MB: '32000', STUDIO_LINE_PRODUCER: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-279f-${process.pid}.pem`),
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '',
  };
  let n = 0;
  const made = [];
  const studio = (name, { git = false } = {}) => {
    const S = path.join(tmpRoot, `279f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    fs.rmSync(path.join(S, '.studio'), { recursive: true, force: true });
    fs.rmSync(path.join(S, '.env'), { force: true });
    fs.rmSync(path.join(S, 'studio', 'task-holds.json'), { force: true });
    const ev = path.join(S, '.studio', 'events-279f.jsonl');
    writeIn(S, '.studio/events-279f.jsonl', '');
    if (git) {
      g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
      g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
      g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio', '--no-verify');
    }
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: '' } };
  };
  const node = (S, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 120000 });
  const probe = (S, code, env) => { const f = path.join(S, `.probe-279f-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(S, [f], env); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const task = (S, line, env) => node(S, ['harness/task.mjs', ...line], env);
  const add = (S, title, env) => { const r = task(S, ['add', title, '--role', 'builder'], env); return (out(r).match(/"id":\s*"([A-Z]+-\d+)"/) || [])[1] || null; };
  const iso = (ms) => new Date(ms).toISOString();

  // ---- 1: gate stats ----
  {
    const { S, ev, env } = studio('stats');
    writeIn(S, 'studio/mode.json', `${JSON.stringify({ mode: null, history: [], scope: 'lite' })}\n`);
    const now = Date.now();
    const run = (agoH, failed, extra = {}) => JSON.stringify({ ts: iso(now - agoH * 3600000), type: 'gates.run', msg: 'verify', meta: { ms: 1000, scoped: false, partial: false, ran: 5, failed, gameMs: 4000, gateMs: { game: 4000, golden: 2000 }, ...extra } });
    writeIn(S, '.studio/events-279f.jsonl', [
      run(2, ['game']), run(30, []), run(60, ['game', 'hooks']), run(100, [], { gateMs: { game: 6000, golden: 4000 }, gameMs: 6000 }),
      run(5, ['golden'], { partial: true }), // a partial run counts for no gate
      run(24 * 10, ['regressions']), // older than the 7-day window
    ].join('\n') + '\n');
    const r = node(S, ['scripts/run-gates.mjs', 'stats', '--json'], env);
    let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch {}
    const row = (id) => j?.rows?.find((x) => x.id === id);
    const txt = node(S, ['scripts/run-gates.mjs', 'stats', '--days', '7'], env);
    await guard('2.79 (f): `npm run gates -- stats --json` counts full verifies of the last 7 days (4), per lite gate: game red 2 times, last red the newest day, 4.5 s average; golden 2.5 s, never red: isolation (runs 4); the partial run and the 10-day-old run count for nothing; the text says "never red in 7 days" (fails on 2.78.2: `stats` is not a command; it ran every gate)', () => [
      r.status === 0 && j?.verifies === 4 && row('game')?.runs === 4 && row('game')?.red === 2 && row('game')?.lastRed === iso(now - 2 * 3600000).slice(0, 10) && row('game')?.avgMs === 4500 && row('golden')?.red === 0 && row('golden')?.avgMs === 2500
        && row('isolation')?.neverRed === true && row('isolation')?.runs === 4 && row('hooks')?.red === 1 && !row('regressions')?.red && /isolation .*never red in 7 days/.test(out(txt)) && !/game .*never red/.test(out(txt)),
      JSON.stringify({ status: r.status, j, text: out(txt).slice(0, 700), err: out(r).slice(-300) })]);
    const h = node(S, ['harness/health.mjs', '--morning', '--json'], env);
    let hj = null; try { hj = JSON.parse(String(h.stdout).trim().split('\n').pop()); } catch {}
    const ht = node(S, ['harness/health.mjs', '--morning'], env);
    await guard('2.79 (f): the morning health report carries the same gate table (--json gateStats, text "Gate stats, last 7 days") (fails on 2.78.2: no gate table)', () => [
      hj?.gateStats?.verifies === 4 && /Gate stats, last 7 days/.test(out(ht)) && /never red in 7 days/.test(out(ht)),
      JSON.stringify({ gs: hj?.gateStats?.verifies, out: out(ht).slice(-600) })]);
    const src = fs.readFileSync(path.join(S, 'scripts', 'run-gates.mjs'), 'utf8');
    await guard('2.79 (f): the gates.run event records each gate\'s time (meta.gateMs) for the stats\' average (fails on 2.78.2: only gameMs)', () => [/gateMs: Object\.fromEntries\(rows\.filter/.test(src), 'scripts/run-gates.mjs']);
    void ev;
  }

  // ---- 2: telemetry ----
  {
    const { S, ev, env } = studio('telemetry');
    const r = probe(S, `import { emitSampled, flushTelemetry } from ${u(S, 'harness/telemetry.mjs')};
import fs from 'node:fs';
const sent = [];
const emit = (e) => sent.push(e);
const t0 = Date.parse('2026-11-05T10:00:00Z');
for (let i = 0; i < 40; i++) emitSampled({ type: 'gate.timeout_scaled', agent: 'a', msg: 'game: timeout 900 s (load)', meta: { gate: 'game' } }, i % 4 ? 'game' : 'unit', { now: t0 + i * 60000 * 1.0 > t0 + 59 * 60000 ? t0 + 59 * 60000 : t0 + i * 60000, emit, env: {} });
const before = sent.length;
const counter = JSON.parse(fs.readFileSync('.studio/telemetry/gate.timeout_scaled.json', 'utf8'));
emitSampled({ type: 'gate.timeout_scaled', agent: 'a', msg: 'game: timeout 900 s (load)', meta: { gate: 'game' } }, 'game', { now: t0 + 61 * 60000, emit, env: {} });
const afterHour = sent.slice();
const again = flushTelemetry({ now: t0 + 130 * 60000, emit, env: {} });
const full = [];
for (let i = 0; i < 3; i++) emitSampled({ type: 'gate.timeout_scaled', agent: 'a', msg: 'x' }, 'game', { now: t0, emit: (e) => full.push(e), env: { STUDIO_TELEMETRY: 'full' } });
console.log(JSON.stringify({ before, counter: counter.count, keys: counter.keys, afterHour, again, full: full.map((e) => e.type) }));
`, env);
    const s = r.j?.afterHour?.[0];
    await guard('2.79 (f): telemetry counts a diagnostic nobody reads per event: 40 gate.timeout_scaled in the hour write no event (counter file: count 40, keys), the first one after the hour writes ONE gate.timeout_scaled.summary (count 41, top keys, last facts) and starts a fresh counter (a flush with nothing new writes none); STUDIO_TELEMETRY=full writes each one (fails on 2.78.2: harness/telemetry.mjs does not exist)', () => [
      r.j && r.j.before === 0 && r.j.counter === 40 && r.j.keys.game === 30 && r.j.keys.unit === 10 && r.j.afterHour.length === 1 && s.type === 'gate.timeout_scaled.summary' && s.meta.count === 41 && s.meta.top.game === 31 && s.meta.last?.gate === 'game'
        && r.j.again.length === 0 && r.j.full.length === 3 && r.j.full.every((t) => t === 'gate.timeout_scaled'),
      JSON.stringify({ j: r.j, out: out(r).slice(-500) })]);
    // The machine monitor: 13 samples 5 minutes apart over an hour and a bit are one summary, not 13 events.
    const m = probe(S, `import { sampleMachine } from ${u(S, 'harness/machine.mjs')};
const ev = [];
const t0 = Date.parse('2026-11-05T10:00:00Z');
const o = { root: process.cwd(), env: { STUDIO_MACHINE_SAMPLE_S: '300' }, emit: (e) => ev.push(e), cpus: () => [{ times: { user: 1, nice: 0, sys: 1, idle: 98, irq: 0 } }] };
for (let i = 0; i <= 13; i++) await sampleMachine({ ...o, now: t0 + i * 301000 });
const full = [];
for (let i = 0; i <= 3; i++) await sampleMachine({ ...o, root: process.cwd(), env: { STUDIO_MACHINE_SAMPLE_S: '300', STUDIO_TELEMETRY: 'full' }, emit: (e) => full.push(e), now: t0 + 9e6 + i * 301000 });
console.log(JSON.stringify({ types: ev.map((e) => e.type), n: ev.filter((e) => e.type === 'machine.sample').length, sum: ev.find((e) => e.type === 'machine.sample.summary')?.meta?.count || 0, full: full.filter((e) => e.type === 'machine.sample').length }));
`, env);
    await guard('2.79 (f): the machine monitor\'s 14 samples over an hour are one machine.sample.summary (count in the hour), none per sample; with STUDIO_TELEMETRY=full every sample is an event again (fails on 2.78.2: 14 machine.sample events)', () => [
      m.j && m.j.n === 0 && m.j.types.filter((t) => t === 'machine.sample.summary').length === 1 && m.j.sum >= 12 && m.j.full === 4,
      JSON.stringify({ j: m.j, out: out(m).slice(-500) })]);
    const srcs = ['harness/game-gates.mjs', 'harness/agent.mjs'].map((f) => fs.readFileSync(path.join(S, f), 'utf8')).join('\n');
    await guard('2.79 (f): gate.timeout_scaled and prompt.prefix.volatile go through emitSampled; the types a reader needs per event (hotspot.overlap, task.overlap, skill.follow, watch.report, agent.heartbeat, trigger.would_drop, thread.would_route) are still emitted one by one (fails on 2.78.2: both were emitEvent)', () => {
      const keep = [['hotspots', 'hotspot.overlap'], ['task-overlap', 'task.overlap'], ['scorecard', 'skill.follow'], ['watch', 'watch.report'], ['threads', 'trigger.would_drop'], ['threads', 'thread.would_route']]
        .every(([f, t]) => new RegExp(`emitEvent\\(\\{ type: '${t.replace('.', '\\.')}'`).test(fs.readFileSync(path.join(S, 'harness', `${f}.mjs`), 'utf8')) || /type: '(task\.overlap)'/.test(fs.readFileSync(path.join(S, 'harness', `${f}.mjs`), 'utf8')));
      return [/emitSampled\(\{ type: 'gate\.timeout_scaled'/.test(srcs) && /emitSampled\(\{ type: 'prompt\.prefix\.volatile'/.test(srcs) && /emitEvent\(\{ type: 'agent\.heartbeat'/.test(srcs) && keep, 'sources'];
    });
    void ev;
  }

  // ---- 3: studio:reload-env prints names ----
  {
    const { S, env } = studio('env');
    const DEAD = 'STUDIO' + '_REMOVED_LONG_AGO_SETTING'; // built, so the settings scan doesn't count it as a real name
    writeIn(S, '.env', ['STUDIO_HEAVY_SLOTS=3', 'STUDIO_KEYMAP_AGENT_BUILDER_API2=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', `${DEAD}=hunter2-secret-value`, 'STUDIO_TRAIN_PIPELINE=off', ''].join('\r\n'));
    const r = node(S, ['harness/env-reload.mjs', '--by', 'test'], { ...env });
    const text = out(r);
    await guard('2.79 (f): `studio:reload-env` lists the STUDIO_* names the .env sets (names only: no value, not even of a mapped key) and marks the one the harness no longer reads "unknown (removed or misspelled)", not the settings it reads or the KEYMAP family (CRLF .env) (fails on 2.78.2: it printed no names)', () => [
      r.status === 0 && /STUDIO_HEAVY_SLOTS(?! .*unknown)/.test(text) && /STUDIO_TRAIN_PIPELINE(?! .*unknown)/.test(text) && /STUDIO_KEYMAP_AGENT_BUILDER_API2(?! .*unknown)/.test(text)
        && new RegExp(`${DEAD} +unknown \\(removed or misspelled\\)`).test(text) && !/hunter2|ANTHROPIC_API_KEY_LANE/.test(text) && !/STUDIO_HEAVY_SLOTS.*unknown/.test(text),
      text.slice(-900)]);
  }

  // ---- 4: heavy slots follow the RAM ----
  {
    const { S, env } = studio('slots');
    const r = probe(S, `import { slotsFor } from ${u(S, 'harness/heavy-budget.mjs')};
const m = (gb, cores) => ({ at: new Date().toISOString(), ram: { totalGb: gb, freeGb: gb / 2 }, cores: { logical: cores }, os: { platform: 'win32' } });
console.log(JSON.stringify({ g32: slotsFor(m(32, 28), {}), g16: slotsFor(m(16, 28), {}), g8: slotsFor(m(8, 8), {}), g64: slotsFor(m(64, 28), {}), g128: slotsFor(m(128, 64), {}), few: slotsFor(m(64, 8), {}), set: slotsFor(m(32, 28), { STUDIO_HEAVY_SLOTS: '2' }), none: slotsFor(null, {}) }));
`, env);
    await guard('2.79 (f): the default heavy slot count follows the RAM, about one per 10 GB: 32 GB / 28 threads gets 3 with nothing set (it got 6), 16 GB 1, 8 GB 1, 64 GB 6, 128 GB still at most 6, 64 GB / 8 threads 2 (the cores); STUDIO_HEAVY_SLOTS still wins; no scan 1 (fails on 2.78.2: 32 GB gave 6)', () => [
      r.j && r.j.g32 === 3 && r.j.g16 === 1 && r.j.g8 === 1 && r.j.g64 === 6 && r.j.g128 === 6 && r.j.few === 2 && r.j.set === 2 && r.j.none === 1,
      JSON.stringify({ j: r.j, out: out(r).slice(-400) })]);
  }

  // ---- 5: the API-key builder pool ----
  {
    const { S, ev, env } = studio('pool', { git: true });
    const now = Date.now();
    writeIn(S, 'studio/budget.json', `${JSON.stringify({ order: ['claude'], tools: { claude: { weeklyTokens: 1000, target: 1, resetDay: 'monday' } } })}\n`);
    const id = add(S, 'Pool probe task', env);
    task(S, ['lane', id, 'cartridges/mine', '--by', 'hatch'], { ...env, CLAUDECODE: '' }); // its own lane, so a pool builder can run beside one elsewhere
    const sup = (extraEnv, { over = true, running = [] } = {}) => {
      writeIn(S, '.studio/events-279f.jsonl', over ? `${JSON.stringify({ ts: iso(now), type: 'agent.session.end', agent: 'builder-s1', tokensIn: 900000, tokensOut: 0, meta: { tool: 'claude' } })}\n` : '');
      return probe(S, `import { supervise } from ${u(S, 'harness/supervisor.mjs')};
const starts = [];
const running = ${JSON.stringify(running)};
const deps = { sessions: () => running.map((a) => ({ agent: a, role: 'builder', running: true, task: 'T-0', lane: 'cartridges/elsewhere' })), startAgent: (o) => { starts.push({ agent: o.agent, role: o.role }); return { ok: true }; }, launchableRoles: (r) => r, nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'plan', deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ started: r.started, why: r.why, starts }));
`, { ...env, STUDIO_AGENT_TOOL: 'claude', ...extraEnv });
    };
    const pool = { STUDIO_API_POOL: 'builder-api2,builder-api3', STUDIO_KEYMAP_AGENT_BUILDER_API2: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', STUDIO_KEYMAP_AGENT_BUILDER_API3: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE' };
    const noPool = sup({});
    const high = sup(pool);
    const fine = sup(pool, { over: false });
    const oneBusy = sup(pool, { running: ['builder-api2'] });
    const unmapped = sup({ STUDIO_API_POOL: 'builder-api2', STUDIO_KEYMAP_AGENT_BUILDER_API2: '' });
    await guard('2.79 (f): with the plan over its weekly target the supervisor starts nothing without a pool ("slowing down"), and with STUDIO_API_POOL starts a pool builder (builder-api2, the first free name, one api_pool event is logged by a real start); with budget headroom it starts a plan builder, never a pool name; a pool name with no key mapping is never started (it would bill the plan) (fails on 2.78.2: no pool; "slowing down" every time)', () => [
      noPool.j?.starts?.length === 0 && noPool.j.why.some((w) => /over its target/.test(w))
        && high.j?.starts?.length === 1 && high.j.starts[0].agent === 'builder-api2' && high.j.starts[0].role === 'builder'
        && fine.j?.starts?.length >= 1 && !fine.j.starts.some((s) => /api/.test(s.agent))
        && unmapped.j?.starts?.length === 0,
      JSON.stringify({ noPool: noPool.j, high: high.j, fine: fine.j, unmapped: unmapped.j, err: out(high).slice(-400) })]);
    await guard('2.79 (f): the pool never exceeds its size: with builder-api2 running the next pool start is builder-api3, and with both running none start (fails on 2.78.2: no pool)', () => {
      const both = sup(pool, { running: ['builder-api2', 'builder-api3'] });
      return [oneBusy.j && both.j && both.j.starts.length === 0 && oneBusy.j.starts.length === 1 && oneBusy.j.starts[0].agent === 'builder-api3', JSON.stringify({ oneBusy: oneBusy.j, both: both.j })];
    });
    // The usage wind-down is the other "plan budget high" signal: it starts nothing new, except pool builders.
    {
      const W = studio('pool-wd', { git: true });
      writeIn(W.S, 'studio/budget.json', `${JSON.stringify({ order: ['claude'], tools: { claude: { weeklyTokens: 1000, target: 1, resetDay: 'monday' } } })}\n`);
      const wid = add(W.S, 'Wind-down probe task', W.env);
      task(W.S, ['lane', wid, 'cartridges/mine', '--by', 'hatch'], { ...W.env, CLAUDECODE: '' });
      writeIn(W.S, '.studio/events-279f.jsonl', `${JSON.stringify({ ts: iso(now), type: 'agent.session.end', agent: 'builder-s1', tokensIn: 900000, tokensOut: 0, meta: { tool: 'claude' } })}\n`);
      const wd = (extra) => probe(W.S, `import { supervise } from ${u(W.S, 'harness/supervisor.mjs')};
const starts = [];
const deps = { sessions: () => [], startAgent: (o) => { starts.push(o.agent); return { ok: true }; }, launchableRoles: (r) => r, nextAgentName: (role, p) => p + role + '-' + (starts.length + 1) };
const r = await supervise({ watcher: true, dryRun: true, prefix: 'plan', deps }, { startedAt: Date.now(), names: [] });
console.log(JSON.stringify({ why: r.why, starts, winddown: Boolean(r.winddown) }));
`, { ...W.env, STUDIO_AGENT_TOOL: 'claude', STUDIO_USAGE_WINDDOWN_PCT: '50', ...extra });
      const withPool = wd(pool);
      const without = wd({});
      await guard('2.79 (f): in a usage wind-down (STUDIO_USAGE_WINDDOWN_PCT) nothing new starts without a pool, and with STUDIO_API_POOL only the pool builder starts (builder-api2), saying the plan is winding down (fails on 2.78.2: no pool)', () => [
        withPool.j?.starts?.length === 1 && withPool.j.starts[0] === 'builder-api2' && withPool.j.why.some((w) => /wind(ing)? down/.test(w)) && without.j?.starts?.length === 0 && without.j.winddown === true,
        JSON.stringify({ withPool: withPool.j, without: without.j, err: out(withPool).slice(-300) })]);
    }
    const manual = probe(S, `import { pickManual, poolNames } from ${u(S, 'harness/api-pool.mjs')};
console.log(JSON.stringify({ first: pickManual({ live: [], env: process.env }), second: pickManual({ live: [{ agent: 'builder-api2', running: true }], env: process.env }), none: pickManual({ live: [], env: { STUDIO_API_POOL: 'builder-api2' } }), bad: poolNames({ STUDIO_API_POOL: 'rm -rf, owner-key, builder-x' }) }));
`, { ...env, ...pool });
    const cli = node(S, ['harness/agent.mjs', 'start', '--pool', 'api', '--task', id || 'T-1'], { ...env, STUDIO_API_POOL: '' });
    await guard('2.79 (f): `agent start --pool api` takes the first free pool builder (builder-api2, then builder-api3), refuses with a reason when the pool is unset, empty of mapped names or fully running, and ignores names that aren\'t builder names (fails on 2.78.2: --pool is not a flag)', () => [
      manual.j?.first?.name === 'builder-api2' && manual.j.second.name === 'builder-api3' && manual.j.none.name === null && /STUDIO_KEYMAP_AGENT_BUILDER_API2/.test(manual.j.none.why) && manual.j.bad.names.length === 0 && manual.j.bad.ignored.length === 4
        && cli.status === 1 && /No API-pool builder to start/.test(out(cli)),
      JSON.stringify({ manual: manual.j, cli: out(cli).slice(-300) })]);
    void ev;
  }

  // ---- 7: a second owner-only session end ----
  {
    const { S, ev, env } = studio('owner', { git: true });
    const t1 = add(S, 'Tune the example scenario', env);
    const tk = (line, a) => task(S, line, { ...env, STUDIO_LOCK_OWNER: a });
    tk(['start', t1, '--agent', 'builder-o1'], 'builder-o1');
    const END = `import { cleanUp } from ${u(S, 'harness/agent.mjs')};
import fs from 'node:fs';
fs.mkdirSync('.studio/agents', { recursive: true });
const log = 'working...\\n[protected] FAIL protected file changed:\\n  cartridges/example/qa.mjs\\n[protected] Only the owner can approve these: on the owner\\'s machine, npm run approve -- protected --note "why". An agent should hand the task back instead of working around it.\\n';
cleanUp(process.argv[2], { code: 0, log, role: 'builder', tool: 'claude', model: 'claude-opus-5-5' });
const holds = JSON.parse(fs.readFileSync('studio/task-holds.json', 'utf8')).tasks;
console.log(JSON.stringify({ parked: holds['${t1}']?.parked || null }));
`;
    const endAs = (a) => { const f = path.join(S, `.probe-end-${a}.mjs`); fs.writeFileSync(f, END); const r = node(S, [f, a], { ...env, STUDIO_LOCK_OWNER: a }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
    const first = endAs('builder-o1');
    const mark = events(ev).length;
    const parkedAt = first.j?.parked?.at;
    // A second session on the same task (one that was already running when the park was set, or started by hand) ends the same way.
    const claim = tk(['start', t1, '--agent', 'builder-o2'], 'builder-o2');
    const second = endAs('builder-o2');
    const all = events(ev);
    const later = all.slice(mark);
    const pages = (x) => x.filter((e) => e.type === 'task.owner_only' && e.task === t1).length;
    const asks = later.filter((e) => (e.type === 'agent.ask' || e.type === 'task.breaker' || e.type === 'task.hold') && e.task === t1);
    const hr = probe(S, `import { holdReason } from ${u(S, 'harness/task-hold.mjs')};
import { parseNextQueue } from ${u(S, 'harness/task.mjs')};
console.log(JSON.stringify({ hold: holdReason('${t1}', parseNextQueue(), Date.now(), undefined, 'builder') }));
`, env);
    await guard('2.79 (f): a second session end naming the same owner-only step (the task is parked owner-only already) pages the orchestrator once in all (one task.owner_only), starts no new park, breaker, ask or hold event, keeps the first park\'s time, and the supervisor\'s hold check still keeps builders off it (fails on 2.78.1: the task was relaunched; on 2.78.2 this is the check that it stays fixed)', () => [
      first.j?.parked?.ownerOnly === true && pages(all) === 1 && pages(later) === 0 && asks.length === 0 && second.j?.parked?.at === parkedAt && /owner-only/.test(hr.j?.hold || ''),
      JSON.stringify({ first: first.j, second: second.j, claim: out(claim).slice(-200), pages: pages(all), later: later.map((e) => `${e.type}:${e.task || ''}`), hold: hr.j })]);
  }

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
}

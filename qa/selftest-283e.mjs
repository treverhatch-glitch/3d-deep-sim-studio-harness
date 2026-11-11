/**
 * qa/selftest-283e.mjs — 2.83 (e): four model-routing and launch-cap problems from a 26-hour crew run, and the boost lever.
 *
 *   routes   a model-pool route applies only to the roles studio/models.json names in routeRoles (default builder and
 *            engine-porter): a Director task keeps its own role model (B-126)
 *   refresh  a refresh hand-off, a person's stop and a usage-limit stop are not a failure of the route or model
 *   slots    a Producer, Director or Line Producer session doesn't take a builder slot under the cap
 *   vertex   an engine-track task is never started on the vertex (aider) tool unless STUDIO_VERTEX_ENGINE=on
 *   boost    `mode boost on --builders-only` raises the caps and leaves the Director's and Producer's cadence alone
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283E({ dir, root, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = { ...clean, STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_HOOKS_CHECK: 'off', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '' };

  const S = path.join(tmpRoot, `283e-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks need no package */ }
  for (const x of ['.studio', 'studio/mode.json', 'studio/models.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.mkdirSync(path.join(S, '.studio'), { recursive: true });
  const evFile = path.join(S, '.studio', 'events-283e.jsonl');
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, env = {}) => {
    const f = path.join(S, `.probe-283e-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S, ...env }, encoding: 'utf8', timeout: 240000 });
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1500) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };

  // ================= 1. which roles a pool route applies to =================
  {
    const p = probe(`import { routeAppliesToRole, linePlanNow } from ${u('harness/supervisor.mjs')};
const roles = ['builder', 'engine-porter', 'director', 'producer', 'reviewer', 'line-producer'];
const dflt = roles.filter((r) => routeAppliesToRole(r));
const own = roles.filter((r) => routeAppliesToRole(r, { routeRoles: ['builder', 'reviewer'] }));
const plan = { routes: { 'T-D': { model: 'builder-model', tier: 'normal', why: 'x' }, 'T-B': { model: 'builder-model', tier: 'normal', why: 'x' } }, order: new Map(), hold: new Map(), rigCap: null, rigWhy: '', skip: new Set() };
const line = await linePlanNow(Date.now(), { plan, models: { routeRoles: ['builder', 'engine-porter'] } });
const dir = line.routeFor({ role: 'director', tasks: [{ id: 'T-D' }] }, { tool: 'claude', preferred: 'claude' });
const bld = line.routeFor({ role: 'builder', tasks: [{ id: 'T-B' }] }, { tool: 'claude', preferred: 'claude' });
const wide = await linePlanNow(Date.now(), { plan, models: { routeRoles: ['builder', 'director'] } });
const dir2 = wide.routeFor({ role: 'director', tasks: [{ id: 'T-D' }] }, { tool: 'claude', preferred: 'claude' });
console.log(JSON.stringify({ dflt, own, dir, bld, dir2 }));`);
    await guard('2.83 routeAppliesToRole: with no routeRoles in studio/models.json only builder and engine-porter take a pool route (fails before this fix: no such function, every role took it); a models.json list of its own replaces the default', () => [
      p.dflt?.join() === 'builder,engine-porter' && p.own?.join() === 'builder,reviewer', JSON.stringify(p)]);
    await guard('2.83 a plan with a Director task and a builder task: only the builder gets the pool route (fails before this fix: the Director task ran on the builders\' model, B-126); a models.json that lists director lets it', () => [
      p.dir && Object.keys(p.dir).length === 0 && p.bld?.model === 'builder-model' && p.dir2?.model === 'builder-model', JSON.stringify(p)]);
    fs.writeFileSync(path.join(S, 'studio', 'models.json'), JSON.stringify({ routeRoles: ['builder', 'reviewer'] }));
    const m = probe(`import { readModels } from ${u('harness/model-pools.mjs')};
console.log(JSON.stringify({ roles: readModels().routeRoles }));`);
    fs.rmSync(path.join(S, 'studio', 'models.json'), { force: true });
    const d = probe(`import { readModels } from ${u('harness/model-pools.mjs')};
console.log(JSON.stringify({ roles: readModels().routeRoles }));`);
    await guard('2.83 readModels carries routeRoles from studio/models.json, and builder + engine-porter when the file does not name it', () => [
      m.roles?.join() === 'builder,reviewer' && d.roles?.join() === 'builder,engine-porter', JSON.stringify({ m, d })]);
  }

  // ================= 2. a refresh is not a route failure =================
  {
    const t = (min) => new Date(Date.UTC(2026, 10, 10, 10, min)).toISOString();
    const evs = (kind) => {
      const msg = { refresh: 'builder-a1 (claude, claude-sonnet-5-5) refreshed: it reached the 120-turn ceiling. No uncommitted work. A fresh session continues from this hand-back.', person: 'builder-a1 (claude, claude-sonnet-5-5) was stopped by Hatch (a stop, not a failure).', limit: 'builder-a1 (claude, claude-sonnet-5-5) stopped at its usage limit: the provider said "limit".', real: 'builder-a1 (claude, claude-sonnet-5-5) ended without task done or a hand-back.' }[kind];
      const reason = { refresh: 'refreshed (session cap): a fresh session continues', person: 'stopped by Hatch', limit: 'usage limit: limit', real: 'finished without task done' }[kind];
      return [
        { ts: t(0), type: 'task.added', task: 'T-1', agent: 'p', meta: { size: 3 } },
        { ts: t(1), type: 'agent.session.start', agent: 'builder-a1', task: 'T-1', model: 'claude-sonnet-5-5', meta: { role: 'builder', tool: 'vertex' } },
        { ts: t(5), type: 'task.paused', agent: 'builder-a1', task: 'T-1', msg: `Handed back T-1: ${msg}` },
        { ts: t(5), type: 'agent.session.end', agent: 'builder-a1', task: 'T-1', model: 'claude-sonnet-5-5', msg: 'ended', meta: { role: 'builder', tool: 'vertex', reason, handed: [{ task: 'T-1' }], ...(kind === 'refresh' ? { refreshed: true } : kind === 'person' ? { stoppedBy: 'Hatch' } : kind === 'limit' ? { usageLimit: { on: 'claude' } } : {}) } },
        { ts: t(6), type: 'agent.session.start', agent: 'builder-a2', task: 'T-1', model: 'claude-sonnet-5-5', meta: { role: 'builder', tool: 'claude' } },
      ];
    };
    const all = {};
    for (const k of ['refresh', 'person', 'limit', 'real']) all[k] = evs(k);
    const p = probe(`import { escalationFor } from ${u('harness/model-tiers.mjs')};
import { vertexFailures } from ${u('harness/vertex.mjs')};
import { buildOutcomes, readModels } from ${u('harness/model-pools.mjs')};
const all = ${JSON.stringify(all)};
const cfg = readModels();
const r = {};
for (const [k, e] of Object.entries(all)) r[k] = { esc: escalationFor('T-1', { events: e, env: {} })?.failed || 0, vx: vertexFailures('T-1', e), out: buildOutcomes(e, { cfg }).filter((o) => o.agent === 'builder-a1').map((o) => o.result)[0] };
console.log(JSON.stringify(r));`);
    await guard('2.83 a refresh hand-off is not counted as a failure of the model or route (tier escalation, Vertex hand-backs, pool outcomes); a real hand-back still is (fails before this fix: the refresh counted as a red round and dropped the route)', () => [
      p.refresh?.esc === 0 && p.refresh.vx === 0 && p.refresh.out === 'other' && p.real?.esc === 1 && p.real.vx === 1 && p.real.out === 'handed', JSON.stringify(p)]);
    await guard('2.83 a person\'s stop and a usage-limit stop are not a failure of the route either', () => [
      p.person?.esc === 0 && p.person.vx === 0 && p.person.out === 'other' && p.limit?.esc === 0 && p.limit.vx === 0 && p.limit.out === 'other', JSON.stringify(p)]);
  }

  // ================= 3. a planning session doesn't take a builder slot =================
  {
    const p = probe(`import { builderRoom, isPlanningRole } from ${u('harness/supervisor.mjs')};
const builders = [{ role: 'builder', running: true }, { role: 'builder', running: true }];
const withPlan = [...builders, { role: 'producer', running: true }, { role: 'director', running: true }, { role: 'line-producer', running: true }];
console.log(JSON.stringify({ none: builderRoom(4, []), b: builderRoom(4, builders), withPlan: builderRoom(4, withPlan), porter: builderRoom(4, [{ role: 'engine-porter', running: true }]), reviewer: builderRoom(4, [{ role: 'reviewer', running: true }]), plan: ['producer', 'director', 'line-producer', 'builder', 'reviewer'].map(isPlanningRole) }));`);
    await guard('2.83 running Producer, Director and Line Producer sessions leave the free builder slots as they were (fails before this fix: each took one of the cap); builders, engine-porters and reviewers still count', () => [
      p.none === 4 && p.b === 2 && p.withPlan === 2 && p.porter === 3 && p.reviewer === 3 && p.plan?.join() === 'true,true,true,false,false', JSON.stringify(p)]);
  }

  // ================= 4. an engine-track task never goes to the vertex (aider) tool =================
  {
    const ev = [
      { ts: new Date().toISOString(), type: 'task.added', task: 'T-ENG', agent: 'p', meta: { size: 3, track: 'engine:alpha' } },
      { ts: new Date().toISOString(), type: 'task.added', task: 'T-WEB', agent: 'p', meta: { size: 3 } },
    ];
    const p = probe(`import { vertexPick } from ${u('harness/vertex.mjs')};
const events = ${JSON.stringify(ev)};
const ready = { ok: true };
const pick = (taskId, env = {}) => vertexPick({ role: 'builder', taskId, live: [], cap: 4, high: true, events, ready, env: { STUDIO_VERTEX_SHARE: '1', ...env } });
console.log(JSON.stringify({ eng: pick('T-ENG'), web: pick('T-WEB'), on: pick('T-ENG', { STUDIO_VERTEX_ENGINE: 'on' }) }));`);
    await guard('2.83 an engine-track task is not started on Vertex and the skip says why (fails before this fix: aider got it and ended with "aider changed no file"); a web task still is; STUDIO_VERTEX_ENGINE=on allows the engine task', () => [
      !p.eng?.tool && /engine track/.test(p.eng?.skip || '') && /STUDIO_VERTEX_ENGINE/.test(p.eng?.skip || '') && p.web?.tool === 'vertex' && p.on?.tool === 'vertex', JSON.stringify(p)]);
  }

  // ================= 5. boost on --builders-only =================
  {
    const q = probe(`import { setBoost, effectiveMode, describeMode, readMode } from ${u('harness/mode.mjs')};
const plain0 = effectiveMode(readMode());
setBoost(true, 'tester', 4, undefined, true);
const bo = effectiveMode(readMode());
const boText = describeMode(bo);
setBoost(true, 'tester', 4);
const full = effectiveMode(readMode());
const fullText = describeMode(full);
setBoost(false, 'tester');
console.log(JSON.stringify({ base: { max: plain0.maxAgents, b: plain0.perRole.builder, d: plain0.directorEveryHours, p: plain0.producerEveryHours }, bo: { max: bo.maxAgents, b: bo.perRole.builder, d: bo.directorEveryHours, p: bo.producerEveryHours, flag: bo.boostBuildersOnly }, full: { max: full.maxAgents, d: full.directorEveryHours, p: full.producerEveryHours, flag: full.boostBuildersOnly }, boText, fullText }));`);
    const cli = spawnSync(process.execPath, [path.join(S, 'harness', 'mode.mjs'), 'boost', 'on', '--by', 'tester', '--hours', '2', '--builders-only'], { windowsHide: true, cwd: S, env: { ...base, AGENT_EVENTS_FILE: evFile, STUDIO_MAIN_ROOT: S }, encoding: 'utf8', timeout: 60000 });
    await guard('2.83 `mode boost on --builders-only` raises the agent and builder caps exactly as boost does and leaves the Director\'s and Producer\'s cadence as the mode had it; plain boost still makes them 1 h for the Producer; the status says which is on (fails before this fix: no such flag, the cadence always changed)', () => [
      q.bo?.max > q.base?.max && q.bo.b > q.base.b && q.bo.max === q.full?.max && q.bo.d === q.base.d && q.bo.p === q.base.p && q.bo.flag === true
        && q.full?.p === 1 && q.full.flag === false && /builders only: planning cadence unchanged/.test(q.boText || '') && /builders and planning cadence/.test(q.fullText || ''), JSON.stringify(q)]);
    await guard('2.83 the command line takes --builders-only and its status line says so', () => [
      cli.status === 0 && /builders only: planning cadence unchanged/.test(out(cli)), out(cli).slice(0, 800)]);
  }

  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* best effort */ }
}

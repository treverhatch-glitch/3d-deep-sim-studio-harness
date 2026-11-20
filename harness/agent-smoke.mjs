/**
 * harness/agent-smoke.mjs — `npm run agent -- smoke`: one real start that proves a pool or tool path.
 *   npm run agent -- smoke [--role builder] [--pool api] [--tool <tool>] [--engine <x>] [--minutes 10] [--dry-run]
 * It SPENDS REAL TOKENS. It adds a throwaway task (one line in docs/smoke/<agent>.md, committed in the session's own
 * lane), starts the session through the normal `agent start`, waits, says whether the lane was made, whether the commit
 * exists and how the session ended, then drops the task (never queued for a train, never landed) and removes the lane.
 * Exit 0 only when the commit exists. With no --pool or --tool it runs one smoke per path the role has, in the owner's
 * order (STUDIO_BUILDER_ORDER, else the API pool then the role's tool; then the tools the owner set in `npm run budget -- order`).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR, readRecentEvents } from './event.mjs';
import { readJson } from './fsafe.mjs';
import { builderOrder, pickManual, poolNames } from './api-pool.mjs';
import { BUDGET_FILE } from './budget.mjs';

const AGENT = path.join(path.dirname(fileURLToPath(import.meta.url)), 'agent.mjs');
const TASK = path.join(path.dirname(fileURLToPath(import.meta.url)), 'task.mjs');
const KEY = (role) => String(role).toUpperCase().replace(/[^A-Z0-9]+/g, '_');
const git = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8' });
const node = (script, args, env) => spawnSync(process.execPath, [script, ...args], { windowsHide: true, cwd: REPO_ROOT, encoding: 'utf8', env, timeout: 120000 });
const SPENDS = 'agent smoke starts a real session and spends real tokens (a plan session, or the API key for the pool).';

/** The paths to prove for a role: [{ pool?: 'api', tool?: string, label }]. Explicit --pool or --tool: just that one. */
export function smokePlan({ role = 'builder', pool = null, tool = null, env = process.env } = {}) {
  if (pool || tool) return [{ ...(pool ? { pool } : {}), ...(tool ? { tool } : {}), label: pool ? `the ${pool} pool` : `tool ${tool}` }];
  const own = env[`STUDIO_${KEY(role)}_TOOL`] || env.STUDIO_AGENT_TOOL || 'claude';
  const out = [];
  for (const k of builderOrder(env) || ['api', 'plan']) {
    if (k === 'api' && poolNames(env).names.length) out.push({ pool: 'api', label: 'the api pool' });
    if (k === 'vertex') out.push({ tool: 'vertex', label: 'tool vertex' });
    if (k === 'plan') out.push({ tool: null, label: `the plan (${own})` });
  }
  for (const t of (readJson(BUDGET_FILE, {}).order || []).map((x) => String(x).split(':')[0])) if (t !== own && !out.some((o) => o.tool === t)) out.push({ tool: t, label: `tool ${t}` });
  return out;
}

const eventsOf = (agent, type) => readRecentEvents(5000).filter((e) => e.type === type && e.agent === agent);
const lineOf = (s) => String(s || '').trim().split('\n').filter(Boolean).pop() || '';

/** Remove a lane: the worktree, then its branch (kept by the launcher when it holds commits). */
function removeLane({ repo, dir, branch }) {
  if (dir && fs.existsSync(dir)) git(repo, ['worktree', 'remove', '--force', dir]);
  if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 });
  git(repo, ['worktree', 'prune']);
  if (branch) git(repo, ['branch', '-D', branch]);
}

/** One smoke. Returns { ok, lines, agent, task }. */
export async function smokeOne({ role, entry, engine = null, minutes = 10, deps, env = process.env, dryRun = false }) {
  let agent = null;
  if (entry.pool) {
    const pm = pickManual({ live: deps.sessions(), busy: deps.laneNameClash });
    if (!pm.name) return { ok: false, lines: [`no API-pool builder to start: ${pm.why}`] };
    agent = pm.name;
  } else agent = `smoke-${Date.now().toString(36)}`;
  const file = `docs/smoke/${agent}.md`;
  const title = `Smoke test ${agent}: add one line to ${file} and commit it`;
  const startArgs = ['start', '--attach', '--role', role, ...(entry.pool ? ['--pool', entry.pool] : ['--agent', agent]), ...(entry.tool ? ['--tool', entry.tool] : [])];
  const note = `This is a harness smoke test, not real work. Add one line to ${file} in your working folder (an engine pass: its engine worktree), commit it there, then stop. Do not run task done or verify.`;
  if (dryRun) return { ok: true, lines: [`would add a smoke task "${title}" (${engine ? `engine:${engine}` : 'lane docs/smoke'}) and run: agent ${[...startArgs, '--task', '<its id>'].join(' ')} (waits up to ${minutes} min)`] };
  const lines = [];
  // The producer adds to the live queue; --lane keeps a builder in its own folder, an engine pass gets its engine's worktree.
  const where = engine ? ['--track', `engine:${engine}`] : role === 'engine-porter' ? [] : ['--lane', 'docs/smoke'];
  const added = node(TASK, ['add', title, '--role', role, '--priority', 'P2', '--agent', env.STUDIO_PRODUCER_NAME || 'producer', ...where], env);
  let task = null;
  try { task = JSON.parse(String(added.stdout).slice(String(added.stdout).indexOf('{'))).id; } catch { /* below */ }
  if (!task) return { ok: false, lines: [`the smoke task was not queued: ${lineOf(added.stderr) || lineOf(added.stdout)}`] };
  const childEnv = { ...env, STUDIO_AUTO_FINISH: 'off', STUDIO_REFILL_WAKE: 'off' };
  const child = spawn(process.execPath, [AGENT, ...startArgs, '--task', task, '--note', note], { windowsHide: true, cwd: REPO_ROOT, env: childEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let said = '';
  for (const s of [child.stdout, child.stderr]) s.on('data', (d) => { said = `${said}${d}`.slice(-4000); });
  const exited = new Promise((r) => child.on('exit', (code) => r(code)).on('error', () => r(null)));
  let timedOut = false;
  const timer = setTimeout(() => { timedOut = true; node(AGENT, ['stop', agent, '--by', 'smoke'], env); }, minutes * 60000);
  let code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('late'), minutes * 60000 + 60000))]);
  clearTimeout(timer);
  if (code === 'late') {
    if (process.platform === 'win32') spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' });
    else child.kill('SIGKILL');
    code = null;
  }
  const rec = readJson(path.join(STUDIO_STATE_DIR, 'agents', `${agent}.json`));
  const eng = eventsOf(agent, 'engine.lane').pop()?.meta || null;
  const lane = eng ? { repo: eng.repo, dir: eng.dir, branch: eng.branch } : rec?.copy ? { repo: REPO_ROOT, dir: path.join(REPO_ROOT, rec.copy.dir), branch: rec.copy.branch } : null;
  const log = lane?.branch ? git(lane.repo, ['log', '--format=%h', '-n', '1', lane.branch, '--', file]) : null;
  const commit = log?.status === 0 ? log.stdout.trim() : '';
  lines.push(`lane made: ${lane ? `yes, ${String(lane.dir).split(path.sep).join('/')} on branch ${lane.branch}` : 'no'}`);
  lines.push(`first tool call allowed: ${commit ? `yes, commit ${commit} on ${lane.branch}` : 'no, no commit with that file'}`);
  const why = rec?.refusal || rec?.reason || (code === 0 ? '' : lineOf(said));
  lines.push(`session ${timedOut ? 'did not end in time and was stopped' : 'ended'}${rec ? ` (${rec.tool || '?'}, ${rec.model || '?'}, ${rec.status})` : ''}${why ? `: ${String(why).replace(/\s+/g, ' ').slice(0, 300)}` : ''}`);
  // Clean up: the task goes back, then off the queue as a smoke task (no DONE line, no train); the lane is removed.
  node(TASK, ['pause', task, '--force', '--note', 'smoke test ended'], env);
  const dropped = node(TASK, ['drop', task, '--by', 'smoke', '--why', 'smoke task: a harness start check, never real work'], env);
  if (lane) removeLane(lane);
  lines.push(`cleaned up: ${task} ${dropped.status === 0 ? 'dropped' : `NOT dropped (${lineOf(dropped.stderr)}); drop it: npm run task -- drop ${task} --by <you> --why "smoke"`}${lane ? ', lane removed' : ''}`);
  return { ok: Boolean(commit), lines, agent, task };
}

/** The CLI: returns the exit code. deps: { sessions, laneNameClash } from agent.mjs (it cannot be imported back). */
export async function smokeCli(argv, deps, env = process.env) {
  const flag = (n) => { const i = argv.indexOf(`--${n}`); return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : null; };
  const role = flag('role') || 'builder';
  const engine = flag('engine') || null;
  const minutes = Number(flag('minutes')) || 10;
  if (flag('pool') && String(flag('pool')).toLowerCase() !== 'api') { console.error('--pool takes "api"'); return 1; }
  const entries = smokePlan({ role, pool: flag('pool') && 'api', tool: flag('tool'), env });
  if (!entries.length) { console.error(`Nothing to smoke for ${role}: no API pool name (STUDIO_API_POOL) and no tool set.`); return 1; }
  const dryRun = argv.includes('--dry-run');
  console.log(`${SPENDS}${dryRun ? ' (--dry-run: nothing is started)' : ''}`);
  const many = entries.length > 1;
  let bad = 0;
  for (const entry of entries) {
    const r = await smokeOne({ role, entry, engine, minutes, deps, env, dryRun });
    if (!r.ok) bad += 1;
    if (many && !dryRun) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${role} on ${entry.label}: ${r.lines[1] || r.lines[0]}; ${r.lines[2] || ''}`);
    else for (const l of r.lines) console.log(`${many ? `${entry.label}: ` : ''}${l}`);
  }
  return bad ? 1 : 0;
}

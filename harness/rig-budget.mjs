#!/usr/bin/env node
/**
 * harness/rig-budget.mjs — 2.76.0 (j, B-89): what runs on this machine now and the share each kind of job would get.
 *
 * Test workers are shared across the jobs running at once (harness/heavy-budget.mjs coreShare: the train's verify,
 * then builders' verifies and lane checks, then soaks; Unity, art and playtest jobs take the threads they claim). This
 * file gathers the picture for the Line Producer and for people:
 *
 *   rigBudget({ root?, env?, now?, events? }) -> {
 *     cores, freeGb, totalGb, known,                       the last machine scan (known: false with none)
 *     running: [{ kind, label, workers, ramGb, threads, startedAt, etaMin, pid, owner, source }],
 *     shares: { train, verify, check, soak: { workers, why }, unity, art, playtest, other: { threads, ramGb } },
 *     coming: [{ kind: 'train', why }], weights, why }
 *
 *   kind     train | verify | check | soak | unity | art | playtest | other (heavy-budget.mjs rigKind)
 *   source   machine:heavy (a holder), gate slot (a lane's game check), verify-running (a verify record whose process
 *            lives but holds no machine:heavy slot: waiting for one, or a light run)
 *   etaMin   minutes left, from the median of the last finished jobs of that kind (job.done events), else null
 *   shares   what a job of that kind would get if it started now (the same functions the gates use)
 *
 *   node harness/rig-budget.mjs [--json]
 *
 * Read-only; never throws (a part it can't read is left out). Paths: the main checkout's .studio (lane copies share it).
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import * as hb from './heavy-budget.mjs';
import { pidAlive as alive, readJson } from './fsafe.mjs';

const iso = (t) => { const ms = typeof t === 'number' ? t : Date.parse(t); return Number.isFinite(ms) ? new Date(ms).toISOString() : null; };
const median = (xs) => { const s = xs.filter((x) => Number.isFinite(x) && x > 0).sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };
/** The job.done kind whose durations stand for a rig kind's ETA. */
const ETA_KIND = { train: 'verify', verify: 'verify', check: 'game-gates', soak: 'game-gates', unity: 'unity-gate', art: 'heavy', playtest: 'heavy', other: 'heavy' };

/** Median minutes of the last (at most 12) passing job.done events per job kind: { kind: minutes }. */
export function typicalMinutes(events = []) {
  const by = {};
  for (const e of events) {
    if (e?.type !== 'job.done' || e.status !== 'ok') continue;
    const k = e.meta?.kind;
    const ms = Number(e.meta?.ms ?? e.durationMs);
    if (!k || !(ms > 0)) continue;
    (by[k] ||= []).push(ms);
  }
  const out = {};
  for (const [k, xs] of Object.entries(by)) { const m = median(xs.slice(-12)); if (m) out[k] = Math.round(m / 6000) / 10; }
  return out;
}

export async function rigBudget({ root = null, env = process.env, now = Date.now(), events = null } = {}) {
  const heavy = await import('./heavy.mjs');
  const hroot = root || (await heavy.heavyRoot());
  let profile = null;
  try { profile = hb.machineProfile(hroot, { env }); } catch {}
  let holders = [];
  try { holders = heavy.heavyHolders(hroot, { env }); } catch {}
  let slots = [];
  try { slots = heavy.laneCheckSlots(hroot, env); } catch {}
  let evs = events;
  if (!evs) { try { evs = (await import('./event.mjs')).readRecentEvents(3000); } catch { evs = []; } }
  const typical = typicalMinutes(evs || []);
  const eta = (kind, at) => { const m = typical[ETA_KIND[kind] || 'heavy']; const t = Number(typeof at === 'number' ? at : Date.parse(at)); return m && Number.isFinite(t) ? Math.max(0, Math.round((m - (now - t) / 60000) * 10) / 10) : null; };
  const running = [];
  for (const j of hb.rigJobs(holders)) running.push({ kind: j.kind, rank: hb.rigRank(j.kind), label: j.label, workers: j.workers, ramGb: j.ramGb, threads: j.threads, startedAt: iso(j.at), etaMin: eta(j.kind, j.at), pid: j.pid, owner: j.owner, source: 'machine:heavy' });
  for (const g of slots) running.push({ kind: 'check', label: g.label, workers: null, ramGb: null, threads: null, startedAt: iso(g.at), etaMin: eta('check', g.at), pid: g.pid, owner: null, source: 'gate slot' });
  // Verify records whose process lives but that hold no machine:heavy slot (waiting for one, or a light run).
  const held = new Set(holders.map((h) => Number(h.pid)));
  const owners = new Set(holders.map((h) => h.owner).filter(Boolean));
  try {
    const dir = path.join(hroot, '.studio', 'verify-running');
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json') && !n.endsWith('.result.json'))) {
      const r = readJson(path.join(dir, f));
      if (!r) continue;
      const pids = [r.pid, r.runnerPid, r.hostPid].map(Number).filter((p) => p > 0);
      if (!pids.some(alive) || pids.some((p) => held.has(p))) continue;
      const owner = r.owner || f.replace(/\.json$/, '');
      if (owners.has(owner) && f !== 'full.json') continue;
      running.push({ kind: 'verify', label: `verify by ${owner}${r.args?.length ? ` (${r.args.join(' ')})` : ''}`, workers: null, ramGb: null, threads: null, startedAt: iso(r.startedAt), etaMin: eta('verify', r.startedAt), pid: pids.find(alive), owner, source: 'verify-running', note: 'holds no machine:heavy slot (waiting for one, or a light run)' });
    }
  } catch {}
  const state = hb.budgetState(profile, holders, { env });
  const laneJobs = slots.map(() => ({ kind: 'check', workers: null, threads: 0 }));
  const coming = hb.trainComing(hroot, { env, jobs: state.jobs || [] });
  const shares = {};
  try {
    for (const as of ['train', 'verify']) { const c = hb.jobClaim('verify', { root: hroot, env, profile, state, as, extraJobs: laneJobs, ...(as === 'train' ? { coming: [] } : {}) }); shares[as] = { workers: c.workers, ramGb: c.ramGb, why: c.workersWhy || '' }; }
    for (const self of ['check', 'soak']) { const t = hb.testWorkers({ profile, env, holders, laneChecks: slots.length, root: hroot, trainRoot: hroot, self }); shares[self] = { workers: t.workers, why: t.why }; }
    for (const [k, kind] of [['unity', 'unity'], ['art', 'blender-preview'], ['artBake', 'art-bake'], ['playtest', 'browser-playtest'], ['other', 'heavy']]) { const c = hb.jobClaim(kind, { root: hroot, env, profile, state }); shares[k] = { threads: c.cpuThreads, ramGb: c.ramGb, why: `a fixed claim (${c.label})${c.areaWhy ? `; ${c.areaWhy}` : ''}` }; }
  } catch {}
  return {
    at: new Date(now).toISOString(),
    known: Boolean(state.known),
    cores: hb.logicalCores(profile),
    freeGb: state.known ? state.freeRamGb : null,
    totalGb: state.known ? state.totalRamGb : null,
    running,
    shares,
    coming,
    weights: hb.rigWeights(hroot),
    on: hb.rigShareOn(env),
    why: !state.known ? 'no machine scan (npm run machine): every check gets 2 test workers' : hb.rigShareOn(env) ? 'test workers are shared by cores and RAM (harness/heavy-budget.mjs coreShare)' : 'STUDIO_RIG_SHARE=off: test workers by free RAM only',
  };
}

/** One line per job and per share, for people. */
export function rigText(b) {
  const L = [`Rig: ${b.cores} cores, ${b.freeGb ?? '?'} GB free for heavy work${b.totalGb ? ` of ${b.totalGb} GB` : ''}; ${b.why}.`];
  L.push(b.running.length ? 'Running:' : 'Running: nothing.');
  for (const r of b.running) L.push(`  ${r.kind.padEnd(8)} ${r.label || '?'}${r.owner ? ` (${r.owner})` : ''}: ${r.workers ? `${r.workers} workers` : r.threads ? `${r.threads} threads` : 'workers unknown'}${r.ramGb ? `, ${r.ramGb} GB` : ''}${r.etaMin !== null && r.etaMin !== undefined ? `, about ${r.etaMin} min left` : ''} [${r.source}]`);
  for (const c of b.coming) L.push(`Coming: ${c.why}.`);
  L.push('If one started now:');
  for (const [k, s] of Object.entries(b.shares)) L.push(`  ${k.padEnd(8)} ${s.workers ? `${s.workers} test workers` : `${s.threads} threads, ${s.ramGb} GB`}: ${s.why}`);
  return L.join('\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const b = await rigBudget();
  console.log(process.argv.includes('--json') ? JSON.stringify(b, null, 2) : rigText(b));
}

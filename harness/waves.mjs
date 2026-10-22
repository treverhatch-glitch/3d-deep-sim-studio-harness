#!/usr/bin/env node
/**
 * harness/waves.mjs — Fun check in waves (2.30d).
 *
 * Instead of each gameplay task blocking on an individual fun check (a real-input browser play),
 * tasks join a "wave". When the Producer deems a wave ready, it's marked for a single batch
 * playtest. This allows other development lanes to proceed without waiting. This module manages
 * the state of these waves: creating them, joining tasks, marking them ready for QA, and
 * checking the results of the playtest.
 *
 *   npm run wave -- status | ready --by <name> | check [W-n] --by <name> | on|off --by <name>
 * STUDIO_FUN_WAVES=0 (or `wave -- off`) goes back to 2.30b's per-task fun check.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, actor } from './event.mjs';

// Studio data (committed), like the queue: which gameplay work went into which wave, and how each wave did.
export const WAVES_FILE = path.join(REPO_ROOT, 'studio', 'waves.json');

function readWavesState() {
  try {
    return { on: true, next: 1, waves: [], ...JSON.parse(fs.readFileSync(WAVES_FILE, 'utf8')) };
  } catch {
    return { on: true, next: 1, waves: [] };
  }
}

function writeWavesState(state) {
  fs.mkdirSync(path.dirname(WAVES_FILE), { recursive: true });
  fs.writeFileSync(WAVES_FILE, JSON.stringify(state, null, 2) + '\n');
}

export function wavesOn(env = process.env) {
  if (env.STUDIO_FUN_WAVES === '0') return false;
  return readWavesState().on;
}

/** The open wave's id, or the id the next one will get. */
export function nextWaveId() {
  const st = readWavesState();
  return st.waves.find((w) => w.status === 'open')?.id || `W-${st.next}`;
}

export function listWaves() {
  return readWavesState().waves.slice().reverse();
}

export function waveFor(taskId) {
  return readWavesState().waves.find(w => w.tasks.includes(taskId)) || null;
}

export function currentWave() {
  const state = readWavesState();
  let openWave = state.waves.find(w => w.status === 'open');
  if (!openWave) {
    openWave = { id: `W-${state.next}`, status: 'open', tasks: [], openedAt: new Date().toISOString() };
    state.waves.push(openWave);
    state.next += 1;
    writeWavesState(state);
  }
  return openWave;
}

export function joinWave(taskId, { by } = {}) {
  const wave = currentWave(); // Ensures an open wave exists
  const state = readWavesState();
  const liveWave = state.waves.find(w => w.id === wave.id);
  if (!liveWave.tasks.includes(taskId)) {
    liveWave.tasks.push(taskId);
    writeWavesState(state);
    emitEvent({ type: 'wave.joined', agent: by || actor(), task: taskId, msg: `Task ${taskId} joined fun check wave ${liveWave.id}`, meta: { wave: liveWave.id } });
  }
  return liveWave;
}

export function markReady({ by }) {
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const state = readWavesState();
  const wave = state.waves.find(w => w.status === 'open');
  if (!wave) return { ok: false, message: 'No open wave to mark as ready.' };
  if (wave.tasks.length === 0) return { ok: false, message: `Wave ${wave.id} has no tasks.` };

  wave.status = 'batch-ready';
  wave.readyAt = new Date().toISOString();
  wave.readyBy = by;
  writeWavesState(state);
  emitEvent({ type: 'wave.ready', agent: by, to: 'qa-playtester', msg: `Wave ${wave.id} is batch-ready (${wave.tasks.length} tasks): run npm run play:browser, then npm run wave -- check`, meta: { wave: wave.id, tasks: wave.tasks.length } });
  return { ok: true, wave };
}

export async function checkWave({ id = null, by, reportsDir = path.join(REPO_ROOT, 'qa', 'reports'), now = new Date() } = {}) {
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const state = readWavesState();
  let wave;
  if (id) {
    wave = state.waves.find(w => w.id === id);
    if (!wave || wave.status !== 'batch-ready') return { ok: false, message: `Wave ${id || '(none)'} not found or not batch-ready.` };
  } else {
    wave = state.waves.filter(w => w.status === 'batch-ready').sort((a, b) => a.readyAt.localeCompare(b.readyAt))[0];
    if (!wave) return { ok: false, message: 'No batch-ready waves to check.' };
  }

  let newestReport, newestReportPath, newestReportTime = 0;
  try {
    for (const file of fs.readdirSync(reportsDir)) {
      if (!file.startsWith('browser_') || !file.endsWith('.json')) continue;
      const rPath = path.join(reportsDir, file);
      const r = JSON.parse(fs.readFileSync(rPath, 'utf8'));
      const rAt = Date.parse(r.at);
      if (rAt >= Date.parse(wave.readyAt) && rAt > newestReportTime) {
        newestReport = r;
        newestReportPath = path.relative(REPO_ROOT, rPath);
        newestReportTime = rAt;
      }
    }
  } catch { /* ignore if dir doesn't exist */ }

  if (!newestReport) return { ok: true, wave, result: 'no-play', message: `No browser play report for wave ${wave.id} after ${wave.readyAt}. Run 'npm run play:browser'.` };

  const failing = [];
  if (!newestReport.probes?.length) failing.push('no probes declared');
  else newestReport.probes.forEach(p => !p.ok && failing.push(`probe '${p.name}': ${p.why || 'failed'}`));
  (newestReport.simFeatures || []).forEach(sf => !sf.ok && failing.push(`simFeature '${sf.name}': failed`));

  wave.checkedAt = now.toISOString();
  wave.report = newestReportPath;
  if (failing.length === 0) {
    wave.status = 'passed';
    emitEvent({ type: 'wave.passed', agent: by, to: 'producer', msg: `Wave ${wave.id} passed fun check.`, meta: { wave: wave.id, tasks: wave.tasks, report: wave.report } });
    writeWavesState(state);
    return { ok: true, wave, result: 'passed' };
  }

  wave.status = 'failed';
  wave.failing = failing;
  const { addTask } = await import('./task.mjs');
  const fixTask = await addTask({ title: `Fix wave ${wave.id}: ${failing.slice(0, 2).join('; ')}`.slice(0, 180), role: 'builder', priority: 'P1', agent: by, meta: { wave: wave.id, after: [], infra: true, type: 'bug' } });
  if (fixTask.id) wave.fixTask = fixTask.id;
  emitEvent({ type: 'wave.failed', agent: by, to: 'producer', msg: `Wave ${wave.id} failed fun check: ${failing[0]}`, meta: { wave: wave.id, failing, fixTask: wave.fixTask, report: wave.report } });
  writeWavesState(state);
  return { ok: true, wave, result: 'failed' };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--by');
  const by = i >= 0 ? argv[i + 1] : null;
  const cmd = argv[0] || 'status';

  if (['on', 'off', 'ready', 'check'].includes(cmd) && !by) {
    console.error('Error: --by <name> is required for this command.');
    process.exit(1);
  }

  if (cmd === 'on' || cmd === 'off') {
    const state = readWavesState();
    state.on = cmd === 'on';
    writeWavesState(state);
    emitEvent({ type: 'wave.mode', agent: by, msg: `Fun check waves ${state.on ? 'enabled' : 'disabled'}` });
    console.log(`Fun check waves are now ${state.on ? 'on' : 'off'}.`);
  } else if (cmd === 'ready') {
    const res = markReady({ by });
    if (res.ok) console.log(`Wave ${res.wave.id} marked as batch-ready.`);
    else { console.error(`Error: ${res.message}`); process.exit(1); }
  } else if (cmd === 'check') {
    const waveId = argv.find(a => a.startsWith('W-')) || null;
    const res = await checkWave({ id: waveId, by });
    if (!res.ok) { console.error(`Error: ${res.message}`); process.exit(1); }
    console.log(res.result === 'no-play' ? res.message : `Wave ${res.wave.id} check result: ${res.result}.`);
  } else if (cmd === 'status') {
    const state = readWavesState();
    console.log(`Fun check waves are ${state.on ? 'on' : 'off'}.`);
    const open = state.waves.find(w => w.status === 'open');
    if (open) console.log(`\nOpen wave: ${open.id} (${open.tasks.length} tasks) ${open.tasks.join(' ')}`);
    const ready = state.waves.filter(w => w.status === 'batch-ready');
    if (ready.length > 0) {
      console.log('\nBatch-ready waves:');
      ready.forEach(w => console.log(`  ${w.id} (${w.tasks.length} tasks, ready by ${w.readyBy} at ${w.readyAt})`));
    }
    const results = state.waves.filter(w => ['passed', 'failed'].includes(w.status)).slice(-3).reverse();
    if (results.length > 0) {
      console.log('\nLast 3 results:');
      results.forEach(w => console.log(`  ${w.id}: ${w.status} on ${w.checkedAt?.slice(0, 10)}`));
    }
  } else {
    console.log('Usage: npm run wave -- <command>\n\n  status\n  on|off --by <name>\n  ready --by <name>\n  check [W-n] --by <name>');
  }
}

#!/usr/bin/env node
/**
 * harness/floors.mjs — manage parallel work streams (floors).
 *
 *   npm run floors -- status
 *   npm run floors -- open <n> --by <name>
 *   npm run floors -- stage <n> <build|art|polish|done> --by <name>
 *   npm run floors -- tick [--by supervisor]
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent, actor } from './event.mjs';
import { readBible, writeBible } from './bible.mjs';

const readJson = (f, d = null) => {
  try {
    return JSON.parse(fs.readFileSync(f, 'utf8'));
  } catch {
    return d;
  }
};

const FLOORS_CONFIG_FILE = path.join(REPO_ROOT, 'studio', 'floors.json');

async function checkPhaseScenarios(phase) {
  const config = readJson(FLOORS_CONFIG_FILE);
  const scenarioDir = path.join(REPO_ROOT, 'qa', 'scenarios', `phase-${phase}`);
  if (!fs.existsSync(scenarioDir)) {
    return config?.requireScenarios ? { ok: false, why: `required scenario folder qa/scenarios/phase-${phase}/ is missing` } : { ok: true };
  }
  const r = spawnSync(process.execPath, [path.join(REPO_ROOT, 'qa', 'check-phase-scenarios.mjs'), '--phase', phase], { encoding: 'utf8', timeout: Number(process.env.STUDIO_SCENARIO_TIMEOUT_MS || 60000) + 5000 });
  if (r.status !== 0) {
    return { ok: false, why: `phase-scenarios gate failed for Phase ${phase}: ${((r.stderr || '').match(/^(FAIL|ERROR).*$/gm) || [(r.stderr || r.stdout || '').trim().split('\n').pop()]).join('; ')}` };
  }
  return { ok: true };
}

export async function tick({ by = actor(), silent = false } = {}) {
  const config = readJson(FLOORS_CONFIG_FILE);
  if (!config?.autoOpen) return;

  const b = readBible();
  if (!b) return;

  const openFloors = b.phase.floors || [];
  const mainStage = b.phase.stage || 'build';
  const building = (mainStage === 'build' ? 1 : 0) + openFloors.filter(f => f.stage === 'build').length;
  const maxParallel = config.maxParallel || 1;

  if (building >= maxParallel) return;

  const lastOpen = openFloors.length ? Math.max(...openFloors.map(f => f.n)) : b.phase.open;
  const floorToOpen = lastOpen + 1;
  if (floorToOpen > 3) return;

  const prevFloor = openFloors.find(f => f.n === lastOpen) || { n: lastOpen, stage: mainStage };
  if (!['art', 'polish', 'done'].includes(prevFloor.stage)) return;

  const scenarios = await checkPhaseScenarios(lastOpen);
  if (!scenarios.ok) {
    if (!silent) console.log(`Cannot open floor ${floorToOpen}: ${scenarios.why}`);
    return;
  }

  await openFloor(floorToOpen, { by: 'floors-auto', reason: 'autoOpen', auto: true });
}

async function openFloor(n, { by, reason, auto = false }) {
  const b = readBible();
  if (!b) return { ok: false, message: 'No bible found.' };
  if (!b.signed) return { ok: false, message: 'Sign the Bible first.' };

  if (!auto) {
    if (!by || /^(producer|director|builder|agent|unknown|supervisor|floors-auto)$/i.test(by) || by === process.env.STUDIO_PRODUCER_NAME) {
      return { ok: false, message: 'A person opens a floor, not an agent: pass --by <your name>.' };
    }
  }

  b.phase.floors = b.phase.floors || [];
  const openFloors = b.phase.floors;
  const lastOpen = openFloors.length ? Math.max(...openFloors.map(f => f.n)) : b.phase.open;

  if (openFloors.some(f => f.n === n) || b.phase.open === n) {
    return { ok: false, message: `Floor ${n} is already open.` };
  }
  if (n !== lastOpen + 1) {
    return { ok: false, message: `Floor ${n} cannot be opened. Next available floor is ${lastOpen + 1}.` };
  }
  if (n > 3) {
    return { ok: false, message: `Cannot open floor ${n}: maximum phase is 3.` };
  }

  const scenarios = await checkPhaseScenarios(n - 1);
  if (!scenarios.ok) {
    return { ok: false, message: `Cannot open floor ${n}: ${scenarios.why}` };
  }

  b.phase.floors.push({ n, openedAt: new Date().toISOString(), by, stage: 'build', ...(reason ? { reason } : {}) });
  writeBible(b, { render: false });
  emitEvent({ type: 'floor.opened', agent: by, msg: `Floor ${n} opened at build stage.` });
  return { ok: true, message: `Floor ${n} opened.` };
}

async function setStage(n, stage, { by }) {
  const b = readBible();
  if (!b) return { ok: false, message: 'No bible found.' };
  
  if (b.phase.open === n) {
    const oldStage = b.phase.stage || 'build';
    b.phase.stage = stage;
    writeBible(b, { render: false });
    emitEvent({ type: 'floor.staged', agent: by, msg: `Main Phase ${n} moved from ${oldStage} to ${stage}.` });
    return { ok: true, message: `Main Phase ${n} is now in ${stage} stage.` };
  }

  const floor = (b.phase.floors || []).find(f => f.n === n);
  if (!floor) return { ok: false, message: `Floor ${n} is not open.` };

  const oldStage = floor.stage;
  floor.stage = stage;
  writeBible(b, { render: false });
  emitEvent({ type: 'floor.staged', agent: by, msg: `Floor ${n} moved from ${oldStage} to ${stage}.` });
  return { ok: true, message: `Floor ${n} is now in ${stage} stage.` };
}

function showStatus() {
  const config = readJson(FLOORS_CONFIG_FILE);
  if (!config) {
    console.log('No studio/floors.json file found. Floors are not configured.');
    return;
  }
  const b = readBible();
  const openFloors = b?.phase?.floors || [];

  console.log(`Max parallel floors in 'build' stage: ${config.maxParallel || 1}`);
  console.log(`Auto-open enabled: ${config.autoOpen || false}`);
  console.log('---');
  console.log(`Main phase: ${b?.phase?.open || 1} (${b?.phase?.stage || 'build'})`);
  if (!openFloors.length) {
    console.log('No additional floors are open.');
    return;
  }

  console.log('Open floors:');
  for (const floor of openFloors.sort((a, b) => a.n - b.n)) {
    console.log(`  - Floor ${floor.n}: ${floor.stage} (opened by ${floor.by} at ${floor.openedAt})`);
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const [cmd, ...rest] = argv.filter(a => !a.startsWith('--'));
  const by = flag('by') || actor();

  switch (cmd) {
    case 'status':
      showStatus();
      break;
    case 'tick':
      await tick({ by, silent: false });
      break;
    case 'open': {
      const n = Number(rest[0]);
      if (!n) { console.error('Usage: npm run floors -- open <n> --by <name>'); process.exit(1); }
      const res = await openFloor(n, { by });
      console.log(res.message);
      if (!res.ok) process.exit(1);
      break;
    }
    case 'stage': {
      const n = Number(rest[0]);
      const stage = rest[1];
      if (!n || !['build', 'art', 'polish', 'done'].includes(stage)) {
        console.error('Usage: npm run floors -- stage <n> <build|art|polish|done> --by <name>');
        process.exit(1);
      }
      const res = await setStage(n, stage, { by });
      console.log(res.message);
      if (!res.ok) process.exit(1);
      break;
    }
    default:
      console.log('Usage: npm run floors -- [status|tick|open|stage]');
      process.exit(1);
  }
}

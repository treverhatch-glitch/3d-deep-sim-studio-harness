#!/usr/bin/env node
/**
 * harness/mode.mjs — how fast the studio works, chosen by the game dev, and the MAX SPEED lever.
 *
 *   npm run mode                                 show the mode and what it sets
 *   npm run mode -- set precise|budget|fast|prototype|extreme --by <name> [--why "…"]
 *   npm run mode -- boost on|off --by <name> [--hours 4]   the MAX SPEED lever (also in every War Room view)
 *   npm run mode -- scope lite|full --by <name>  Lite: 6 gates in everyday verify and AGENTS.lite.md for agents
 *
 * The mode (studio/mode.json) sets how many agents may run at once, which work needs a review from
 * another model family, whether the watcher starts agents on its own, how often the Director and the
 * Producer check in, and which models to prefer. Intake asks for it; changing it later is logged.
 *
 * MAX SPEED is a lever on top of any mode: twice the agents (up to 12), the watcher starts agents on
 * its own, and the Director and the Producer check in far more often, so going faster doesn't mean
 * drifting further. It can switch itself off after --hours.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { activeCartridge, isTemplateCartridge } from './cartridge.mjs';

export const MODE_FILE = path.join(REPO_ROOT, 'studio', 'mode.json');

export const MODES = {
  precise: {
    label: 'Precise and slow',
    pitch: 'Few agents, a review on every build task, a full check after each one. Highest quality, slower.',
    maxAgents: 2,
    perRole: { builder: 1, 'qa-playtester': 1, rnd: 1, art: 1 },
    review: 'every-build',
    autoLaunch: false,
    directorEveryHours: 24,
    producerEveryHours: 8,
    models: 'strong',
  },
  budget: {
    label: 'Budget: cheaper and slower',
    pitch: 'One agent at a time, free and local models first, briefs compressed before strong models run. Cheapest, slowest.',
    maxAgents: 1,
    perRole: { builder: 1, 'qa-playtester': 1, rnd: 1, art: 1 },
    review: 'systems',
    autoLaunch: false,
    directorEveryHours: 24,
    producerEveryHours: 12,
    models: 'cheap',
  },
  fast: {
    label: 'Fast and furious',
    pitch: 'Several agents in parallel, reviews on whole systems, the watcher starts agents itself. Faster, more tokens, some risk of drift.',
    maxAgents: 4,
    perRole: { builder: 3, 'qa-playtester': 1, rnd: 1, art: 1 },
    review: 'systems',
    autoLaunch: true,
    directorEveryHours: 12,
    producerEveryHours: 4,
    models: 'mixed',
  },
  // From SendIt (3 h to a playable game outside the harness): one accountable lead, builders in
  // separate folders, one gate that plays the game, frames looked at before a merge. Until the phase
  // is proven fun, the Director reviews the phase, not every task.
  prototype: {
    label: 'Prototype sprint',
    pitch: 'One lead, a few builders in their own folders, one gate that plays the game, before/after frames looked at before each merge. The fastest way to something you can play; the Director reviews at the end of the phase.',
    maxAgents: 4,
    perRole: { builder: 3, 'qa-playtester': 1, rnd: 1, art: 1 },
    review: 'systems',
    autoLaunch: true,
    directorEveryHours: 24,
    producerEveryHours: 2,
    models: 'strong',
    prototype: true,
  },
  extreme: {
    label: 'Extreme speed',
    pitch: 'As many agents as the caps allow, all started automatically. Fastest; context and logic drift more, so the Director checks twice as often.',
    maxAgents: 8,
    perRole: { builder: 5, 'qa-playtester': 2, rnd: 2, art: 2 },
    review: 'systems',
    autoLaunch: true,
    directorEveryHours: 6,
    producerEveryHours: 2,
    models: 'mixed',
    warning: 'Extreme speed: more agents means more drift. Read the Director\'s reviews.',
  },
};
export const DEFAULT_MODE = 'precise';

export function readMode() {
  try {
    return JSON.parse(fs.readFileSync(MODE_FILE, 'utf8'));
  } catch {
    return { mode: null, history: [] };
  }
}

function save(m) {
  fs.mkdirSync(path.dirname(MODE_FILE), { recursive: true });
  fs.writeFileSync(MODE_FILE, `${JSON.stringify(m, null, 2)}\n`);
  return m;
}

/** The numbers everything else reads: the chosen mode, with the MAX SPEED lever applied. */
export function effectiveMode(m = readMode(), now = Date.now()) {
  const id = MODES[m.mode] ? m.mode : DEFAULT_MODE;
  const base = MODES[id];
  const boost = m.boost?.on && (!m.boost.until || Date.parse(m.boost.until) > now) ? m.boost : null;
  const eff = { id, chosen: Boolean(MODES[m.mode]), ...base, perRole: { ...base.perRole }, boost: Boolean(boost), boostUntil: boost?.until || null, boostBy: boost?.by || null };
  if (boost) {
    eff.maxAgents = Math.min(12, Math.max(4, base.maxAgents * 2));
    for (const k of Object.keys(eff.perRole)) eff.perRole[k] = Math.min(6, Math.max(2, eff.perRole[k] * 2));
    eff.autoLaunch = true;
    eff.directorEveryHours = Math.max(2, Math.round(base.directorEveryHours / 4));
    eff.producerEveryHours = 1;
  }
  return eff;
}

export function setMode(id, by, why = '') {
  if (!MODES[id]) return { ok: false, message: `Mode is one of: ${Object.keys(MODES).join(', ')}` };
  if (!by) return { ok: false, message: 'Say who chose it: --by <name>.' };
  const m = readMode();
  const prev = m.mode;
  m.history = [...(m.history || []), { mode: id, from: prev || null, by, why, at: new Date().toISOString() }].slice(-50);
  m.mode = id;
  save(m);
  emitEvent({ type: 'mode.set', agent: by, to: 'producer', msg: `Development mode: ${MODES[id].label}${prev && prev !== id ? ` (was ${MODES[prev]?.label || prev})` : ''}${why ? `: ${why}` : ''}` });
  return { ok: true, mode: effectiveMode(m) };
}

export function setBoost(on, by, hours = null) {
  if (!by) return { ok: false, message: 'Say who pulled the lever: --by <name>.' };
  const m = readMode();
  m.boost = on ? { on: true, by, at: new Date().toISOString(), until: hours ? new Date(Date.now() + Number(hours) * 3600000).toISOString() : null } : { on: false, by, at: new Date().toISOString() };
  m.history = [...(m.history || []), { boost: on, by, hours: hours || null, at: new Date().toISOString() }].slice(-50);
  save(m);
  const e = effectiveMode(m);
  emitEvent({ type: on ? 'mode.boost_on' : 'mode.boost_off', agent: by, to: 'producer', msg: on ? `MAX SPEED on (${by}${hours ? `, for ${hours} h` : ''}): up to ${e.maxAgents} agents, watcher starts agents, Director every ${e.directorEveryHours} h, Producer check-in every hour` : `MAX SPEED off (${by}); back to ${e.label}` });
  return { ok: true, mode: e };
}

// Scope (2.28): how much of the harness a studio carries day to day. Unset, a fresh clone (still on the
// template cartridge) is Lite and a studio that already builds a game is Full, so an existing studio
// changes nothing until someone chooses. new-game and onboard keep the scope the studio had. Lite runs the gates marked "lite" in
// studio/gates.json (6 by default) in everyday verify, and agents auto-load AGENTS.lite.md
// (about 400 tokens) instead of AGENTS.md. npm run release and CI still run everything.
export const SCOPES = { full: 'Full: every gate, AGENTS.md', lite: 'Lite: 6 gates in everyday verify, AGENTS.lite.md' };
export const scopeOf = (m = readMode()) => (m.scope === 'lite' || m.scope === 'full' ? m.scope : isTemplateCartridge(activeCartridge().name) ? 'lite' : 'full');
export const CLAUDE_MD = { full: '@AGENTS.md\n@studio/CURRENT_TASK.md\n', lite: '@AGENTS.lite.md\n@studio/CURRENT_TASK.md\n' };

export function setScope(id, by) {
  if (!SCOPES[id]) return { ok: false, message: 'Scope is lite or full.' };
  if (!by) return { ok: false, message: 'Say who chose it: --by <name>.' };
  const m = readMode();
  const prev = scopeOf(m);
  m.scope = id;
  m.history = [...(m.history || []), { scope: id, from: prev, by, at: new Date().toISOString() }].slice(-50);
  save(m);
  // What Claude Code loads into every session. Other tools read AGENTS.md or AGENTS.lite.md from the kickoff.
  try {
    fs.writeFileSync(path.join(REPO_ROOT, 'CLAUDE.md'), CLAUDE_MD[id]);
  } catch {}
  emitEvent({ type: 'mode.scope', agent: by, to: 'producer', msg: `Scope: ${SCOPES[id]}${prev !== id ? ` (was ${prev})` : ''}` });
  return { ok: true, mode: effectiveMode(m) };
}

export function describeMode(e = effectiveMode()) {
  return `${e.label}${e.chosen ? '' : ' (default; the game dev hasn\'t chosen yet: npm run mode -- set …)'}${e.boost ? `, MAX SPEED on${e.boostUntil ? ` until ${e.boostUntil.slice(11, 16)} UTC` : ''}` : ''}: up to ${e.maxAgents} agents (builders ${e.perRole.builder}), reviews on ${e.review === 'every-build' ? 'every build task' : 'whole systems'}, ${e.autoLaunch ? 'the watcher starts agents' : 'agents started by hand or npm run agent'}, Director every ${e.directorEveryHours} h, Producer every ${e.producerEveryHours} h.`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const flag = (k) => (argv.includes(`--${k}`) ? argv[argv.indexOf(`--${k}`) + 1] : null);
  const done = (r) => {
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(describeMode(r.mode));
    process.exit(0);
  };
  if (argv[0] === 'set') done(setMode(argv[1], flag('by'), flag('why') || ''));
  if (argv[0] === 'boost') done(setBoost(argv[1] !== 'off', flag('by'), flag('hours')));
  if (argv[0] === 'scope') {
    if (!argv[1] || argv[1].startsWith('--')) {
      console.log(SCOPES[scopeOf()]);
      process.exit(0);
    }
    const r = setScope(argv[1], flag('by'));
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`${SCOPES[argv[1]]}. CLAUDE.md now loads ${argv[1] === 'lite' ? 'AGENTS.lite.md' : 'AGENTS.md'}; commit it with studio/mode.json.`);
    process.exit(0);
  }
  console.log(describeMode());
  console.log(`Scope: ${SCOPES[scopeOf()]}`);
  console.log('\nModes:');
  for (const [id, m] of Object.entries(MODES)) console.log(`  ${id.padEnd(8)} ${m.label}: ${m.pitch}`);
  console.log('\nChange: npm run mode -- set <mode> --by <name>   MAX SPEED: npm run mode -- boost on|off --by <name> [--hours 4]   Scope: npm run mode -- scope lite|full --by <name>');
}

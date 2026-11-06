#!/usr/bin/env node
/**
 * harness/gate-stats.mjs — 2.79 (f): how often each gate was red. Measurement only: it switches nothing off.
 *
 *   npm run gates -- stats [--days 7] [--json]
 *
 * From the gates.run events of the last N days (full verifies only: a --only / fast-tier run is partial and counts for
 * no gate), per gate in studio/gates.json: runs (the verifies it was in scope for: in a lite studio only the `lite`
 * gates; a deep gate only on a deep verify, which the event doesn't tell, so a deep gate shows no runs), times red
 * (meta.failed lists the failed required gate ids), the last red date, its average time when the event recorded it
 * (meta.gateMs, written since 2.79; older events carry only the game's time) and "never red in N days".
 * The morning report (harness-health --morning) prints the same table.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DAY = 86400000;

/** The gates a verify in this scope runs: lite studio -> the `lite` gates; full -> every gate that isn't deep. */
export function gatesInScope(gates, scope = 'full') {
  const hasLite = gates.some((g) => 'lite' in g);
  const LITE = hasLite ? new Set(gates.filter((g) => g.lite).map((g) => g.id)) : new Set(['purity', 'isolation', 'golden', 'regressions', 'playtest', 'secrets']);
  const hasDeep = gates.some((g) => 'deep' in g);
  const DEEP = hasDeep ? new Set(gates.filter((g) => g.deep).map((g) => g.id)) : new Set(['selftest', 'hub-smoke', 'hud']);
  return gates.filter((g) => (scope === 'lite' ? LITE.has(g.id) : !DEEP.has(g.id)));
}

/** { days, verifies, rows: [{ id, runs, red, lastRed, avgMs, neverRed }], from } */
export function gateStats(events, gates, { scope = 'full', days = 7, now = Date.now() } = {}) {
  const since = now - days * DAY;
  const runs = (events || []).filter((e) => e.type === 'gates.run' && !e.meta?.partial && (Date.parse(e.ts) || 0) >= since && (Date.parse(e.ts) || 0) <= now);
  const inScope = gatesInScope(gates, scope);
  const rows = inScope.map((g) => {
    const red = runs.filter((e) => Array.isArray(e.meta?.failed) && e.meta.failed.includes(g.id));
    const ms = runs.map((e) => (e.meta?.gateMs && Number.isFinite(Number(e.meta.gateMs[g.id])) ? Number(e.meta.gateMs[g.id]) : g.id === 'game' && Number.isFinite(Number(e.meta?.gameMs)) ? Number(e.meta.gameMs) : null)).filter((x) => x !== null);
    const last = red.map((e) => e.ts).sort().pop() || null;
    return { id: g.id, runs: runs.length, red: red.length, lastRed: last ? String(last).slice(0, 10) : null, avgMs: ms.length ? Math.round(ms.reduce((a, b) => a + b, 0) / ms.length) : null, neverRed: red.length === 0 && runs.length > 0 };
  });
  const first = (events || []).map((e) => Date.parse(e.ts)).filter(Number.isFinite).sort((a, b) => a - b)[0];
  return { days, scope, verifies: runs.length, rows, eventsFrom: Number.isFinite(first) ? new Date(first).toISOString() : null, eventsCoverWindow: Number.isFinite(first) ? first <= since + DAY : false };
}

const dur = (ms) => (ms === null ? '-' : ms >= 60000 ? `${(ms / 60000).toFixed(1)} min` : `${(ms / 1000).toFixed(1)} s`);
export function renderGateStats(s) {
  const lines = [`Gate stats, last ${s.days} days (${s.verifies} full verifies, ${s.scope} scope; measurement only, nothing is switched off)`];
  if (!s.verifies) lines.push('  no full verify recorded in this window.');
  const w = Math.max(4, ...s.rows.map((r) => r.id.length));
  for (const r of s.rows) lines.push(`  ${r.id.padEnd(w)}  runs ${String(r.runs).padStart(4)}  red ${String(r.red).padStart(4)}  last red ${(r.lastRed || '-').padEnd(10)}  avg ${dur(r.avgMs).padEnd(9)}${r.neverRed ? `  never red in ${s.days} days` : ''}`);
  if (s.verifies && !s.eventsCoverWindow) lines.push(`  (the events file only reaches back to ${String(s.eventsFrom).slice(0, 10)})`);
  return `${lines.join('\n')}\n`;
}

/** `npm run gates -- stats ...` */
export async function gateStatsCli(argv, { root, events = null, now = Date.now() } = {}) {
  const i = argv.indexOf('--days');
  const days = i >= 0 && Number(argv[i + 1]) > 0 ? Number(argv[i + 1]) : 7;
  let gates = [];
  try { gates = JSON.parse(fs.readFileSync(path.join(root, 'studio', 'gates.json'), 'utf8')).gates || []; } catch {}
  const { readMode, scopeOf } = await import('./mode.mjs');
  const scope = scopeOf(readMode());
  const evs = events || (await import('./event.mjs')).readRecentEvents(0);
  const s = gateStats(evs, gates, { scope, days, now });
  process.stdout.write(argv.includes('--json') ? `${JSON.stringify(s)}\n` : renderGateStats(s));
  return 0;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  process.exit(await gateStatsCli(process.argv.slice(2), { root: path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..') }));
}

/**
 * harness/selftest-timing.mjs — per-unit timing of the self-test, so the slow and spawn-heavy units can be ranked.
 *
 * `node qa/selftest.mjs --timing [file]` writes, when the run ends (default .studio/selftest-timing.json):
 *   { at, shard: "i/N" | null, node, platform, totalMs, ran, units: [{ label, line, group?, shard, ms, spawns, asserts }] }
 * The units are the ones that ran here, slowest first. `spawns` counts the runner's run()/runAsync() calls in the
 * unit (its subprocesses), `asserts` its report() calls. The runner also prints the slowest units (timingLines).
 * Pure functions plus one writer that never throws: the self-test's result never depends on this file.
 */
import fs from 'node:fs';
import path from 'node:path';

const num = (v) => Math.max(0, Math.round(Number(v) || 0));

/** The report object for the units that ran (ms is set), slowest first. */
export function timingReport(units, { shard = null, at = Date.now(), node = process.version, platform = process.platform, complete = true } = {}) {
  const ran = (units || []).filter((u) => u && u.ms !== undefined && u.ms !== null);
  const rows = ran
    .map((u) => ({ label: String(u.label || ''), line: u.line ?? null, ...(u.group ? { group: u.group } : {}), shard: u.shard ?? null, ms: num(u.ms), spawns: num(u.spawns), asserts: num(u.asserts) }))
    .sort((a, b) => b.ms - a.ms || b.spawns - a.spawns || a.label.localeCompare(b.label));
  return {
    at: new Date(at).toISOString(),
    shard: shard ? `${shard.i}/${shard.n}` : null,
    node,
    platform,
    // Phase B2: the runner writes the file after every unit, so a killed run keeps what it finished; `complete` is
    // false until the run ends.
    complete: Boolean(complete),
    totalMs: rows.reduce((s, r) => s + r.ms, 0),
    ran: rows.length,
    units: rows,
  };
}

/** The lines the runner prints: a header and the `top` slowest units. */
export function timingLines(report, top = 20) {
  const rows = (report?.units || []).slice(0, Math.max(0, top));
  const head = `[selftest] timing: ${report?.ran ?? 0} unit(s) in ${Math.round((report?.totalMs || 0) / 1000)} s${report?.shard ? ` (shard ${report.shard})` : ''}; slowest ${rows.length}:`;
  return [head, ...rows.map((r) => `  ${String(Math.round(r.ms / 1000)).padStart(5)} s  ${String(r.spawns).padStart(4)} spawns  ${String(r.asserts).padStart(4)} asserts  ${r.label}${r.line ? ` (qa/selftest.mjs:${r.line})` : ''}`)];
}

/** Write the report as JSON. Returns the file written, or null (a timing file is a convenience, never a failure). */
export function writeTimingReport(file, report) {
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${JSON.stringify(report, null, 2)}\n`);
    return file;
  } catch {
    return null;
  }
}

/**
 * `--balance`: assign units to `n` shards greedily by recorded time (longest first, onto the lightest shard), so the
 * shards' sums come out even. `units` are { label, group? } in file order; `recorded` are timing rows ({ label, ms });
 * a unit with no recorded time counts as the median. A group moves as one item (its units stay together).
 * Returns Map label → shard (1..n); every unit gets exactly one.
 */
export function balanceShards(units, recorded, n) {
  const ms = new Map((recorded || []).filter((r) => r && r.label && Number.isFinite(Number(r.ms))).map((r) => [r.label, Number(r.ms)]));
  const known = [...ms.values()].sort((a, b) => a - b);
  const median = known.length ? known[Math.floor(known.length / 2)] : 1;
  const items = new Map();
  for (const u of units) {
    const k = u.group ? `group:${u.group}` : `unit:${u.label}`;
    const it = items.get(k) || { labels: [], ms: 0 };
    it.labels.push(u.label);
    it.ms += ms.has(u.label) ? ms.get(u.label) : median;
    items.set(k, it);
  }
  const load = Array(Math.max(1, n)).fill(0);
  const out = new Map();
  for (const it of [...items.values()].sort((a, b) => b.ms - a.ms)) {
    const k = load.indexOf(Math.min(...load));
    load[k] += it.ms;
    for (const l of it.labels) out.set(l, k + 1);
  }
  return out;
}

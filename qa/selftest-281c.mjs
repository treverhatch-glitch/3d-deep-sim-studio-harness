/**
 * qa/selftest-281c.mjs — 2.81 (c): the self-test runner's speed options (ported from the Fable 5.1 trial) and the
 * time-balanced shard split.
 *
 * `--only <labels>` runs named units, `--changed [ref]` the units a change touches (every unit when a shared file such
 * as package.json changed), `--jobs N` runs shards side by side, `--timing` ranks units and keeps the file as the run
 * goes, `--balance [file]` splits shards by recorded time. These checks use the selection functions on a fixture git
 * tree and the real unit list, and the pure balance function; they run no real unit and take seconds.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest281C({ dir, run, report, tmpRoot }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  const git = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
  const sel = await import(u('harness/selftest-select.mjs'));
  const tim = await import(u('harness/selftest-timing.mjs'));
  const source = fs.readFileSync(path.join(dir, 'qa', 'selftest.mjs'), 'utf8');
  const listed = JSON.parse(run(dir, 'node qa/selftest.mjs --list-shards 4').stdout);
  const units = listed.units;
  const picked = (s) => units.filter((x) => s.runs(x)).map((x) => x.label);

  await guard('2.81 (c): `--only selftest-280a` selects exactly that unit and `--only selftest-280a,selftest-280b` exactly those two, out of every unit the runner lists (fails on 2.80.0: no harness/selftest-select.mjs, no --only)', () => {
    const one = picked(sel.buildSelection(dir, { only: 'selftest-280a', source }));
    const two = picked(sel.buildSelection(dir, { only: 'selftest-280a,selftest-280b', source }));
    return [units.length > 100 && one.join() === 'selftest-280a' && two.join() === 'selftest-280a,selftest-280b', JSON.stringify({ n: units.length, one, two })];
  });

  await guard('2.81 (c): `--only zz-no-such-unit` selects no unit and the runner fails it ("matched no unit"); an unknown run prints that it is not the whole self-test (fails on 2.80.0: --only was ignored and the whole self-test ran)', () => {
    const none = picked(sel.buildSelection(dir, { only: 'zz-no-such-unit-zz', source }));
    const r = run(dir, 'node qa/selftest.mjs --only zz-no-such-unit-zz');
    return [none.length === 0 && r.status === 1 && /matched no unit/.test(r.stdout + r.stderr), `${none.length} ${r.status} ${(r.stdout + r.stderr).slice(-300)}`];
  });

  // A git tree to change: the copy, committed; each case edits one file and asks which units that touches.
  const g = (cmd) => run(dir, cmd, git);
  g('git init -q -b main && git add -A && git commit -qm base');
  const changedBy = (rel, text = '\n// 2.81c fixture change\n') => {
    fs.appendFileSync(path.join(dir, rel), text);
    const s = sel.buildSelection(dir, { changed: 'HEAD', source });
    const out = { files: s.files, all: s.all, labels: picked(s) };
    g(`git checkout -q -- ${rel}`);
    return out;
  };
  await guard('2.81 (c): `--changed <base>` after a change to one harness module (harness/lock.mjs) selects the units whose source names that module or a direct importer, a few of them and not every unit (fails on 2.80.0: no --changed, the whole self-test was the only choice)', () => {
    const r = changedBy('harness/lock.mjs');
    const text = (l) => sel.blockText(source, sel.unitBlocks(source), units.find((x) => x.label === l).line) + l;
    const named = r.labels.filter((l) => /lock\.mjs/.test(text(l)));
    return [r.files.join() === 'harness/lock.mjs' && !r.all && r.labels.length >= 1 && r.labels.length < units.length / 2 && named.length >= 1 && !r.labels.includes('selftest-280a'), JSON.stringify({ files: r.files, all: r.all, n: r.labels.length, of: units.length, named: named.length })];
  });

  await guard('2.81 (c): `--changed <base>` after a change to package.json selects every unit (a shared file can move any of them) (fails on 2.80.0: no --changed)', () => {
    const r = changedBy('package.json', '\n');
    return [r.all && r.labels.length === units.length && r.files.join() === 'package.json', JSON.stringify({ files: r.files, all: r.all, n: r.labels.length, of: units.length })];
  });

  await guard('2.81 (c): `--changed <base>` with no change since the base selects no unit, so the runner fails the empty selection instead of passing having checked nothing (fails on 2.80.0: no --changed)', () => {
    const s = sel.buildSelection(dir, { changed: 'HEAD', source });
    const r = run(dir, 'node qa/selftest.mjs --changed HEAD');
    return [picked(s).length === 0 && r.status === 1 && /matched no unit/.test(r.stdout + r.stderr), `${picked(s).length} ${r.status} ${(r.stdout + r.stderr).slice(-300)}`];
  });

  await guard('2.81 (c): `--list-shards 4` still lists every unit exactly once (unique labels, the same units as one shard), every shard has units, and a group shares a shard (fails on 2.80.0: n/a, a regression guard for the --shard plumbing)', () => {
    const all = JSON.parse(run(dir, 'node qa/selftest.mjs --list-shards 1').stdout).units;
    const groups = new Map();
    for (const x of units) if (x.group) groups.set(x.group, new Set([...(groups.get(x.group) || []), x.shard]));
    return [all.length === units.length && new Set(units.map((x) => x.label)).size === units.length && units.map((x) => x.label).join() === all.map((x) => x.label).join()
      && [1, 2, 3, 4].every((k) => units.some((x) => x.shard === k)) && [...groups.values()].every((s) => s.size === 1) && listed.strays.length === 0, `${all.length}/${units.length}`];
  });

  // A timing file with the units' times (a few missing), as `--timing` writes it.
  const rows = units.filter((_, i) => i % 7 !== 3).map((x, i) => ({ label: x.label, ms: 500 + ((i * 7919) % 9000) + (i === 5 ? 600000 : 0) }));
  const tf = path.join(tmpRoot, 'balance-timing.json');
  fs.writeFileSync(tf, JSON.stringify({ units: rows }));
  await guard('2.81 (c): `--list-shards 4 --balance <timing file>` lists every unit exactly once in the same order, every shard has units, groups stay together, and the shards\' recorded times differ by less than the slowest unit (fails on 2.80.0: shards were by count, no --balance)', () => {
    const r = run(dir, `node qa/selftest.mjs --list-shards 4 --balance "${tf}"`);
    const b = JSON.parse(r.stdout).units;
    const ms = new Map(rows.map((x) => [x.label, x.ms]));
    const sorted = [...ms.values()].sort((a, c) => a - c);
    const median = sorted[Math.floor(sorted.length / 2)];
    const sum = [0, 0, 0, 0];
    for (const x of b) sum[x.shard - 1] += ms.get(x.label) ?? median;
    const groups = new Map();
    for (const x of b) if (x.group) groups.set(x.group, new Set([...(groups.get(x.group) || []), x.shard]));
    const slowest = Math.max(...b.map((x) => ms.get(x.label) ?? median));
    const byCount = [0, 0, 0, 0];
    for (const x of units) byCount[x.shard - 1] += ms.get(x.label) ?? median;
    return [b.length === units.length && new Set(b.map((x) => x.label)).size === b.length && b.map((x) => x.label).join() === units.map((x) => x.label).join()
      && sum.every((s) => s > 0) && Math.max(...sum) - Math.min(...sum) < slowest && [...groups.values()].every((s) => s.size === 1)
      && Math.max(...sum) - Math.min(...sum) < Math.max(...byCount) - Math.min(...byCount), JSON.stringify({ status: r.status, sum, byCount, slowest, err: r.stderr.slice(-200) })];
  });

  await guard('2.81 (c): balanceShards puts longest units first onto the lightest shard (9,8,7,1,1,1 over 2 shards gives 14 and 13), counts an unrecorded unit as the median, and moves a group as one item (fails on 2.80.0: no balanceShards)', () => {
    const us = ['a', 'b', 'c', 'd', 'e', 'f'].map((label) => ({ label }));
    const m = tim.balanceShards(us, [{ label: 'a', ms: 9 }, { label: 'b', ms: 8 }, { label: 'c', ms: 7 }, { label: 'd', ms: 1 }, { label: 'e', ms: 1 }], 2);
    const sums = [0, 0];
    const ms = { a: 9, b: 8, c: 7, d: 1, e: 1, f: 7 }; // f has no time: the median of 9,8,7,1,1 is 7
    for (const [l, k] of m) sums[k - 1] += ms[l];
    const grouped = tim.balanceShards([{ label: 'x', group: 'g' }, { label: 'y', group: 'g' }, { label: 'z' }], [{ label: 'x', ms: 5 }, { label: 'y', ms: 5 }, { label: 'z', ms: 5 }], 2);
    return [m.size === 6 && Math.abs(sums[0] - sums[1]) <= 1 && grouped.get('x') === grouped.get('y') && grouped.get('z') !== grouped.get('x'), JSON.stringify({ sums, grouped: [...grouped] })];
  });

  await guard('2.81 (c): the timing report has one row per unit that ran (label, ms, spawns, asserts), slowest first, and a writer that keeps the file for a run that is still going (complete false) (fails on 2.80.0: no harness/selftest-timing.mjs, no --timing)', () => {
    const us = [{ label: 'a', line: 1, ms: 50, spawns: 2, asserts: 3 }, { label: 'b', line: 2, ms: 900, spawns: 0, asserts: 1 }, { label: 'c', line: 3 }];
    const part = tim.timingReport(us, { complete: false });
    const f = path.join(tmpRoot, 'timing-281c', 'selftest-timing.json');
    const wrote = tim.writeTimingReport(f, part);
    const back = JSON.parse(fs.readFileSync(f, 'utf8'));
    return [wrote === f && back.units.length === 2 && back.units[0].label === 'b' && back.units[1].spawns === 2 && back.complete === false && tim.timingLines(back, 5).length === 3, JSON.stringify(back)];
  });

  await guard('2.81 (c): `--jobs 99`, and `--jobs` together with `--shard`, are refused with exit 2 (fails on 2.80.0: no --jobs)', () => {
    const a = run(dir, 'node qa/selftest.mjs --jobs 99');
    const b = run(dir, 'node qa/selftest.mjs --jobs 2 --shard 1/2');
    return [a.status === 2 && b.status === 2, `${a.status} ${b.status} ${a.stderr}`];
  });

  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  await guard('2.81 (c): npm run selftest:changed is `--changed` and selftest:fast is `--jobs 4`, and the Linux CI shard step runs with --timing (fails on 2.80.0: neither script, no --timing)', () => {
    const ci = fs.readFileSync(path.join(dir, '.github', 'workflows', 'ci.yml'), 'utf8');
    return [/qa\/selftest\.mjs --changed$/.test(pkg.scripts['selftest:changed'] || '') && /qa\/selftest\.mjs --jobs 4$/.test(pkg.scripts['selftest:fast'] || '') && /--shard \$\{\{ matrix\.shard \}\}\/4 --timing/.test(ci), JSON.stringify([pkg.scripts['selftest:changed'], pkg.scripts['selftest:fast']])];
  });
}

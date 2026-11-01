/**
 * qa/selftest-266e.mjs — 2.66.0 (e), the pieces that join 2.66's parts: who may silence a check, and the Fix: line in
 * a train's hand-back.
 *   - studio/fuzz.ignore.json silences fuzz findings: not owner-only (the owner's decision, 2026-11-02: a game dev or
 *     an outside agent), but not a worker's call either. A lane that changes it, directly or through a config
 *     proposal, is tier C (released by a person, or an outside agent recording a person's permission).
 *   - docs/settings-baseline.json only shrinks: names added to it since the main branch's copy fail the docs check, so
 *     nobody has to guard it.
 *   - The train's hand-back detail (failLines) leaves out run-gates' "[gates] Fix:" lines, as it leaves out its FAIL lines.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest266E({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const { classifyLane } = await import(pathToFileURL(path.join(dir, 'harness', 'tiers.mjs')).href);
  const direct = classifyLane({ files: [{ path: 'studio/fuzz.ignore.json', status: 'M' }] });
  const viaProposal = classifyLane({ files: [{ path: 'studio-proposals/T-1.json', status: 'A' }], proposals: { 'studio-proposals/T-1.json': ['studio/fuzz.ignore.json'] } });
  const other = classifyLane({ files: [{ path: 'studio-proposals/T-2.json', status: 'A' }], proposals: { 'studio-proposals/T-2.json': ['studio/autonomy.json'] } });
  const lowered = classifyLane({ files: [{ path: 'studio/fuzz.ignore.json', status: 'M' }], settings: { tiers: { set: { silencer: 'A' } } } });
  report('2.66.0 (e): a lane that changes studio/fuzz.ignore.json (directly, or by a config proposal targeting it) is tier C, held for a game dev\'s release or an outside agent with their permission; a game\'s manifest can\'t lower it; a proposal for another unprotected file stays B (fails on 2.65.2: the ignore list was tier B, landing with no one looking)',
    direct.tier === 'C' && viaProposal.tier === 'C' && other.tier === 'B' && lowered.tier === 'C',
    JSON.stringify({ direct: direct.tier, viaProposal: viaProposal.tier, other: other.tier, lowered: lowered.tier }));

  // The baseline ratchet: a git copy whose main has the baseline; a branch that adds a name fails check-docs.
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd: dir, encoding: 'utf8' });
  g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'base', '--no-verify');
  const before = run(dir, 'node scripts/settings-map.mjs --check', { STUDIO_SETTINGS_BASE_REF: '' });
  const bf = path.join(dir, 'docs', 'settings-baseline.json');
  const j = JSON.parse(fs.readFileSync(bf, 'utf8'));
  const name = ['STUDIO', 'SNEAKED', 'IN', '266E'].join('_');
  fs.mkdirSync(path.join(dir, 'harness'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'harness', 'sneak-266e.mjs'), `export const v = process.env.${name} || 'x';\n`);
  j.undocumented = [...j.undocumented, name];
  fs.writeFileSync(bf, `${JSON.stringify(j, null, 2)}\n`);
  g('checkout', '-q', '-b', 'lane-266e'); g('add', '-A'); g('commit', '-qm', 'sneak', '--no-verify');
  const after = run(dir, 'node scripts/settings-map.mjs --check', { STUDIO_SETTINGS_BASE_REF: 'main' });
  const docs = run(dir, 'node scripts/check-docs.mjs', { STUDIO_SETTINGS_BASE_REF: 'main' });
  report('2.66.0 (e): docs/settings-baseline.json only shrinks: a branch that adds a new setting to it instead of documenting it fails settings-map --check and the docs gate ("gained 1 name(s) since the main branch ... it only shrinks"); on main itself the check passes (fails on 2.65.2: no baseline; on the first 2.66 build a hand-added name passed)',
    before.status === 0 && after.status === 1 && new RegExp(`gained 1 name\\(s\\) since the main branch \\(${name}\\).*only shrinks`).test(out(after)) && docs.status !== 0 && /only shrinks/.test(out(docs)),
    `before:\n${out(before).slice(-600)}\nafter:\n${out(after).slice(-800)}\ndocs:\n${out(docs).slice(-600)}`);

  const { failLines } = await import(pathToFileURL(path.join(dir, 'harness', 'train.mjs')).href);
  const fl = failLines(['[gates] FAIL game', '[gates] Fix: the game check failed: open the log and re-run npm run verify -- --only game', ' FAIL  src/b.test.ts > adds up', 'Error: expected 2'].join('\n'));
  report('2.66.0 (e): a train hand-back\'s failure detail keeps the game\'s own FAIL lines and leaves out run-gates\' "[gates] Fix:" line, which would take one of its 8 slots (fails on 2.65.2: no Fix lines existed to leave out)',
    fl.gates.join(',') === 'game' && fl.detail.length === 2 && !fl.detail.some((l) => /Fix:/.test(l)),
    JSON.stringify(fl));
}

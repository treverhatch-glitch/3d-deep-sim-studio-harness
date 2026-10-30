/**
 * qa/selftest-236.mjs — the 2.36.0 checks: a check that exits 0 but ran no tests is a silent green.
 * (Research pack: GUT 9.5.0 prints "Nothing was run" and exits 0; gdUnit4 leaves older reports behind.)
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest236({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const evFile = path.join(dir, '.studio', 'events-236.jsonl');
  const base = { AGENT_EVENTS_FILE: evFile, STUDIO_GATE_SLOTS: '0' };

  // 1. The phrases: each runner's "nothing ran" is caught; ordinary passes are not.
  const f = path.join(tmpRoot, `p236-${process.pid}.mjs`);
  fs.writeFileSync(f, `import { nothingRan } from ${u('harness/silent-green.mjs')};
const empty = ['Nothing was run.', 'No test files found, exiting with code 0', 'No tests found, exiting with code 0', 'collected 0 items', '# tests 0\\n# pass 0', 'Tests:       0 total', 'Test Files  0 passed', 'GUT: 0 tests, 0 passed', 'Total: 0'];
const real = ['Test Files  3 passed (3)\\n Tests  41 passed (41)', '# tests 12\\n# pass 12', 'Tests:       5 passed, 5 total', '9 passing\\n0 failing', 'collected 14 items', '[qa] PASS 6 scenarios', 'Total: 10, failures: 0'];
console.log(JSON.stringify({ empty: empty.map(nothingRan), real: real.map(nothingRan) }));`);
  const p = run(dir, `node "${f}"`, base);
  let j = {};
  try { j = JSON.parse(p.stdout.trim().split('\n').pop()); } catch {}
  report('2.36.0: "nothing ran" is recognised for GUT, vitest, jest, pytest, node:test and summary lines; ordinary passes (including "0 failing") are not flagged', Array.isArray(j.empty) && j.empty.every(Boolean) && j.real.every((x) => x === null), out(p));

  // 2. A studio game whose check exits 0 having run nothing: warned by default, failed with STUDIO_SILENT_GREEN=fail.
  fs.writeFileSync(path.join(dir, 'studio/game.json'), JSON.stringify({ game: 'zz-sg' }));
  fs.mkdirSync(path.join(dir, 'web/zz-sg/sim'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'web/zz-sg/index.html'), '<!doctype html>\n');
  const qa = path.join(dir, 'web/zz-sg/sim/qa.mjs');
  fs.writeFileSync(qa, "console.log('Nothing was run.'); process.exit(0);\n");
  const warn = run(dir, 'node harness/game-gates.mjs', base);
  const fail = run(dir, 'node harness/game-gates.mjs', { ...base, STUDIO_SILENT_GREEN: 'fail' });
  fs.writeFileSync(qa, "console.log('[qa] PASS 6 scenarios'); process.exit(0);\n");
  const real = run(dir, 'node harness/game-gates.mjs', { ...base, STUDIO_SILENT_GREEN: 'fail' });
  const evs = fs.existsSync(evFile) ? fs.readFileSync(evFile, 'utf8') : '';
  report('2.36.0: a game check that exits 0 but ran nothing passes with a WARN by default (opt-in), fails with STUDIO_SILENT_GREEN=fail, and a real pass still passes; each is logged as gate.silent_green', warn.status === 0 && /WARN .*passed but ran no tests \(GUT: nothing was run\)/.test(out(warn)) && fail.status !== 0 && /a check that ran nothing is not a pass/.test(out(fail)) && real.status === 0 && !/ran no tests/.test(out(real)) && (evs.match(/gate\.silent_green/g) || []).length === 2, `${out(warn)}\n---\n${out(fail)}\n---\n${out(real)}`);
  fs.rmSync(path.join(dir, 'studio/game.json'));

  // 3. Godot unit tests: exit 0 with no report from this run (an older report left behind) counts 0 tests.
  const g = path.join(dir, 'gtest');
  fs.mkdirSync(path.join(g, 'addons', 'gdUnit4'), { recursive: true });
  fs.writeFileSync(path.join(g, 'project.godot'), '[application]\nconfig/name="gtest"\n');
  const old = path.join(g, 'reports', 'report_1');
  fs.mkdirSync(old, { recursive: true });
  fs.writeFileSync(path.join(old, 'results.xml'), '<testsuites><testsuite name="Old"><testcase name="test_old" classname="Old"/></testsuite></testsuites>');
  const past = new Date(Date.now() - 3600000);
  fs.utimesSync(path.join(old, 'results.xml'), past, past);
  fs.utimesSync(old, past, past);
  const sh = path.join(g, 'addons', 'gdUnit4', 'runtest.sh');
  fs.writeFileSync(sh, '#!/bin/sh\necho "no suites"\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'fake-godot'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.writeFileSync(path.join(dir, 'studio', 'godot-unit.json'), JSON.stringify({ enabled: true, project: 'gtest', tests: 'res://test_gdunit', gdunit: 'v6.2.2', godot: '4.7.2', watch: ['sim'] }));
  const genv = { ...base, GODOT_BIN: path.join(dir, 'fake-godot'), STUDIO_GODOT_UNIT_ALL: '1' };
  if (process.platform === 'win32') {
    report('2.36.0: Godot unit gate silent green (skipped on Windows: the fake runner is a shell script)', true);
    return;
  }
  const gw = run(dir, 'node harness/godot-unit.mjs', genv);
  const gf = run(dir, 'node harness/godot-unit.mjs', { ...genv, STUDIO_SILENT_GREEN: 'fail' });
  const xml = '<testsuites><testsuite name="Economy"><testcase name="test_ok" classname="Economy"/></testsuite></testsuites>';
  fs.writeFileSync(sh, `#!/bin/sh\nmkdir -p reports/report_2\ncat > reports/report_2/results.xml <<'X'\n${xml}\nX\nexit 0\n`, { mode: 0o755 });
  const gr = run(dir, 'node harness/godot-unit.mjs', { ...genv, STUDIO_SILENT_GREEN: 'fail' });
  report('2.36.0: the Godot unit gate counts only a report written by this run: an older report left behind no longer makes "0 tests ran" green (WARN by default, FAIL opted in); a fresh report with tests passes', gw.status === 0 && /WARN godot-unit passed but ran no tests \(it counted 0 tests\)/.test(out(gw)) && gf.status !== 0 && /FAIL godot-unit passed but ran no tests/.test(out(gf)) && gr.status === 0 && /PASS \(exit code 0, 1 test\(s\)\)/.test(out(gr)), `${out(gw)}\n---\n${out(gf)}\n---\n${out(gr)}`);
}

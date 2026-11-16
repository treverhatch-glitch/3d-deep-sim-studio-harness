/**
 * qa/selftest-289a.mjs — 2.89 (a): which functions a studio runs (harness/usage-functions.mjs) and its page.
 * A real command in a repo copy leaves the record (and a second run adds nothing, and off leaves none); a process that
 * is not a studio command starts no recorder; recordFunctions and functionsReport on a made-up coverage result;
 * `commands-run --functions` with and without a record.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { guardCap3000Of, importInDirOf, out } from './kit.mjs';

const DEMO = `export function alpha() {
  return 1;
}
export function beta() {
  return 2;
}
export function gamma() {
  return 3;
}
`;
const DEMO_NESTED = `export function alpha() {
  return 1;
}
export function beta() {
  return 2;
}
export function gamma() {
  function inner() {
    return 4;
  }
  return inner() + 3;
}
`;

export async function selftest289A({ dir, report, tmpRoot, root: repoRoot, copyRepo }) {
  const guard = guardCap3000Of(report);
  // The parser is the harness's typescript dev dependency; the copies don't carry node_modules.
  const link = (d) => { if (fs.existsSync(path.join(repoRoot, 'node_modules', 'typescript')) && !fs.existsSync(path.join(d, 'node_modules'))) fs.symlinkSync(path.join(repoRoot, 'node_modules'), path.join(d, 'node_modules'), 'junction'); };
  link(dir);
  const imp = importInDirOf(dir);
  const U = await imp('harness/usage-functions.mjs');
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const cmd = (d, args, env = {}) => spawnSync(process.execPath, args, { windowsHide: true, cwd: d, encoding: 'utf8', timeout: 180000, env: { ...process.env, STUDIO_USAGE_FUNCTIONS: 'on', STUDIO_USAGE_FUNCTIONS_MIN: '', ...env } });
  const tsv = (d) => path.join(d, '.studio', 'usage', 'functions', `${version}.tsv`);
  const read = (f) => { try { return fs.readFileSync(f); } catch { return null; } };

  fs.mkdirSync(path.join(dir, '.studio'), { recursive: true });
  let first = null;
  await guard('2.89 (a) record: a real command (task list) in a studio leaves .studio/usage/functions/<version>.tsv with four tab-separated fields per line, a row for the file top level, and named functions whose line holds their name', () => {
    const r = cmd(dir, ['harness/task.mjs', 'list']);
    first = read(tsv(dir));
    if (!first) return [false, `no file; ${out(r).slice(-600)}`];
    const lines = first.toString('utf8').split('\n').filter(Boolean);
    const fields = lines.every((l) => l.split('\t').length === 4);
    const top = lines.includes('harness/task.mjs\t0\t1\t');
    const src = fs.readFileSync(path.join(dir, 'harness', 'task.mjs'), 'utf8').split('\n');
    const named = lines.map((l) => l.split('\t')).filter((p) => p[0] === 'harness/task.mjs' && p[3]);
    const found = named.filter((p) => (src[Number(p[2]) - 1] || '').includes(p[3]));
    return [fields && top && found.length > 0, JSON.stringify({ lines: lines.length, fields, top, named: named.length, found: found.length, head: lines.slice(0, 3) })];
  });
  await guard('2.89 (a) record: the same command again adds nothing (the file is byte for byte the same)', () => {
    cmd(dir, ['harness/task.mjs', 'list']);
    const second = read(tsv(dir));
    return [Boolean(first && second && Buffer.compare(first, second) === 0), `${first?.length} vs ${second?.length}`];
  });
  await guard('2.89 (a) off: with STUDIO_USAGE_FUNCTIONS=off the same command writes no usage/functions folder', () => {
    const d = copyRepo();
    try {
      fs.mkdirSync(path.join(d, '.studio'), { recursive: true });
      const r = cmd(d, ['harness/task.mjs', 'list'], { STUDIO_USAGE_FUNCTIONS: 'off' });
      return [r.status === 0 && !fs.existsSync(path.join(d, '.studio', 'usage', 'functions')), `status ${r.status} ${out(r).slice(-300)}`];
    } finally { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
  });
  await guard('2.89 (a) not a studio: startFunctionRecord returns false when the state folder does not exist and when the command is not under harness/ or scripts/', () => {
    const url = pathToFileURL(path.join(dir, 'harness', 'usage-functions.mjs')).href;
    const code = `import { startFunctionRecord as s } from ${JSON.stringify(url)};
const root = ${JSON.stringify(dir)};
const a = s({ argv: ['node', root + '/harness/task.mjs'], root, stateDir: ${JSON.stringify(path.join(tmpRoot, 'no-such-studio'))}, env: {} });
const b = s({ argv: ['node', root + '/qa/x.mjs'], root, stateDir: root + '/.studio', env: {} });
console.log(JSON.stringify({ a, b }));`;
    const r = spawnSync(process.execPath, ['--input-type=module', '-e', code], { windowsHide: true, cwd: dir, encoding: 'utf8', timeout: 60000, env: { ...process.env, STUDIO_USAGE_FUNCTIONS: 'on' } });
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop() || '';
    return [l === '{"a":false,"b":false}', `${l} ${out(r).slice(-300)}`];
  });

  // ---- recordFunctions and functionsReport on a made-up coverage result ----
  const root = path.join(tmpRoot, 'demo-289a');
  const stateDir = path.join(root, '.studio');
  fs.mkdirSync(path.join(root, 'harness'), { recursive: true });
  fs.mkdirSync(path.join(root, 'qa'), { recursive: true });
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'demo', version: '9.9.9' }));
  fs.writeFileSync(path.join(root, 'harness', 'demo.mjs'), DEMO);
  fs.writeFileSync(path.join(root, 'qa', 'x.mjs'), DEMO);
  const at = (src, s) => src.indexOf(s);
  const fn = (name, off, count) => ({ functionName: name, ranges: [{ startOffset: off, endOffset: off + 10, count }] });
  const result = [
    { url: pathToFileURL(path.join(root, 'harness', 'demo.mjs')).href, functions: [fn('alpha', at(DEMO, 'function alpha'), 1), fn('beta', at(DEMO, 'function beta'), 1), fn('gamma', at(DEMO, 'function gamma'), 0)] },
    { url: pathToFileURL(path.join(tmpRoot, 'elsewhere', 'harness', 'demo.mjs')).href, functions: [fn('outside', 0, 1)] },
    { url: pathToFileURL(path.join(root, 'qa', 'x.mjs')).href, functions: [fn('alpha', 0, 1)] },
  ];
  const opts = { root, stateDir, version: '9.9.9' };
  const file = U.functionsFile(stateDir, '9.9.9');
  await guard('2.89 (a) recordFunctions: on a coverage result it adds the two functions that ran, with their lines and names, and not the one with count 0, one outside the root or one under qa/; again it adds 0; a line written twice by hand still reads as 2 rows', () => {
    const n1 = U.recordFunctions(result, opts);
    const rows = U.readFunctions(file);
    const n2 = U.recordFunctions(result, opts);
    fs.appendFileSync(file, `${fs.readFileSync(file, 'utf8').split('\n')[0]}\n`);
    const again = U.readFunctions(file).length;
    const ok = n1 === 2 && n2 === 0 && rows.length === 2 && again === 2
      && rows[0].file === 'harness/demo.mjs' && rows[0].line === 1 && rows[0].name === 'alpha' && rows[1].line === 4 && rows[1].name === 'beta';
    return [ok, JSON.stringify({ n1, n2, rows, again })];
  });
  const ts = (await import(pathToFileURL(path.join(repoRoot, 'node_modules', 'typescript', 'lib', 'typescript.js')).href)).default;
  const R = await imp('scripts/commands-run.mjs');
  await guard('2.89 (a) report: the two recorded functions are ran, the third is never with its name and line, totals.ran is 2 and neverLines is the third function\'s line count', () => {
    const r = R.functionsReport(ts, { root, stateDir });
    const f = r.files.find((x) => x.file === 'harness/demo.mjs');
    const g = f?.never.find((x) => x.name === 'gamma');
    return [Boolean(f) && r.totals.ran === 2 && f.ran === 2 && f.functions === 3 && f.never.length === 1 && g?.line === 7 && g.lines === 3 && f.neverLines === 3 && r.version === '9.9.9', JSON.stringify({ totals: r.totals, f })];
  });
  await guard('2.89 (a) report: a function inside one that never ran adds no lines twice to neverLines', () => {
    fs.writeFileSync(path.join(root, 'harness', 'demo.mjs'), DEMO_NESTED);
    const r = R.functionsReport(ts, { root, stateDir });
    const f = r.files.find((x) => x.file === 'harness/demo.mjs');
    const gamma = f?.never.find((x) => x.name === 'gamma');
    // gamma now spans 7..12 = 6 lines; inner (8..10) is inside it and must not add 3 more.
    return [Boolean(f) && f.never.length === 2 && gamma?.lines === 6 && f.neverLines === 6, JSON.stringify(f)];
  });

  // ---- the page ----
  await guard('2.89 (a) page: commands-run --functions prints "Functions run in this studio on <version>" and exits 0 in a studio with a record, and the "No functions on record" line in one without', () => {
    const d = copyRepo();
    try {
      fs.mkdirSync(path.join(d, '.studio'), { recursive: true });
      link(d);
      const none = cmd(d, ['scripts/commands-run.mjs', '--functions'], { STUDIO_USAGE_FUNCTIONS: 'off' });
      fs.mkdirSync(path.dirname(tsv(d)), { recursive: true });
      fs.copyFileSync(tsv(dir), tsv(d));
      const some = cmd(d, ['scripts/commands-run.mjs', '--functions'], { STUDIO_USAGE_FUNCTIONS: 'off' });
      const ok = none.status === 0 && /^No functions on record/m.test(none.stdout) && some.status === 0 && new RegExp(`^Functions run in this studio on ${version.replace(/\./g, '\\.')}`, 'm').test(some.stdout);
      return [ok, JSON.stringify({ none: out(none).slice(0, 300), some: out(some).slice(0, 300), st: [none.status, some.status] })];
    } finally { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {} }
  });
}

/**
 * qa/selftest-286g.mjs — 2.86 (g): code that nothing uses, found by a tool and removed only with proof.
 *
 *   tool   scripts/unused-exports.mjs on a small made-up tree: a dead export is found; one named by a doc, a test, a
 *          hook or a dynamic import is not; one used only by its own command line part is INTERNAL; a module nobody names
 *          is UNREACHED; an exact duplicate is found and a fold that would make an import cycle is refused
 *   repo   on the real repo the tool runs and its DEAD count cannot creep up
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

// 2.86: the number of DEAD exports left in the repo. Lower it when you remove more; the check below fails when the
// tool finds more than this, so a new export that nothing uses cannot be added unnoticed. Print the list with
// `node scripts/unused-exports.mjs --list DEAD`.
export const DEAD_EXPORTS_ALLOWED = 8;

export async function selftest286G({ dir, report, tmpRoot }) {
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const T = path.join(tmpRoot, `s286g-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const tool = path.join(dir, 'scripts', 'unused-exports.mjs');
  const runTool = (root, ...args) => {
    const r = spawnSync(process.execPath, [tool, '--root', root, ...args], { windowsHide: true, encoding: 'utf8', timeout: 120000 });
    return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
  };
  const json = (root, ...args) => { const r = runTool(root, '--json', ...args); try { return JSON.parse(r.out); } catch { return { _raw: r.out + r.err }; } };

  // A made-up tree.
  const R = path.join(T, 'tree');
  const body = (n) => `{\n  const x = ${n};\n  const y = x + 1;\n  const z = y + 1;\n  const w = z + 1;\n  return w;\n}\n`;
  write(R, 'harness/a.mjs', [
    `export function deadFn(a) ${body(1)}`,
    `export function docFn(a) ${body(2)}`,
    `export function testFn(a) ${body(3)}`,
    `export function hookFn(a) ${body(4)}`,
    `export const innerConst = 5;`,
    `export function usesInner() { return innerConst; }`,
    `// a comment about commentedOnly(), which is not an export`,
    `export { listedDead };`,
    `function listedDead() { return 1; }`,
    '',
  ].join('\n'));
  write(R, 'harness/b.mjs', `export async function load() { const m = await import('./c.mjs'); return m.viaDynamic(); }\nimport { usesInner } from './a.mjs';\nexport const k = usesInner;\n`);
  write(R, 'harness/c.mjs', `export function viaDynamic() { return 1; }\n`);
  write(R, 'harness/cli.mjs', `export function cliOnly() { return 2; }\nif (process.argv[1]) cliOnly();\n`);
  write(R, 'harness/orphan.mjs', `export const nothing = 1;\n`);
  write(R, 'harness/tested.mjs', `export const onlyTests = 1;\n`);
  write(R, 'harness/docnamed.mjs', `export const q = 1;\n`);
  write(R, 'docs/A.md', '# A\nCall `docFn` and see harness/docnamed.mjs.\n');
  write(R, 'qa/t.mjs', `import { testFn } from '../harness/a.mjs';\nimport { onlyTests } from '../harness/tested.mjs';\ntestFn(onlyTests);\n`);
  write(R, '.claude/hooks/h.mjs', `import { hookFn } from '../../harness/a.mjs';\nhookFn();\n`);
  write(R, 'package.json', JSON.stringify({ scripts: { b: 'node harness/b.mjs' } }));

  await guard('tool: a dead export is found; one a doc, a hook or a dynamic import names is USED and one only a test names is TEST-ONLY; fails before this change: no tool', async () => {
    const rep = json(R);
    const cls = (n) => (rep.exports || []).find((e) => e.name === n)?.class;
    const got = { deadFn: cls('deadFn'), docFn: cls('docFn'), testFn: cls('testFn'), hookFn: cls('hookFn'), viaDynamic: cls('viaDynamic'), listedDead: cls('listedDead') };
    const want = { deadFn: 'DEAD', docFn: 'USED', testFn: 'TEST-ONLY', hookFn: 'USED', viaDynamic: 'USED', listedDead: 'DEAD' };
    return [JSON.stringify(got) === JSON.stringify(want), JSON.stringify({ got, raw: rep._raw })];
  });
  await guard('tool: a name only a test uses is TEST-ONLY, and the list prints the dead item with its file, line and size', async () => {
    const rep = json(R);
    const t = (rep.exports || []).find((e) => e.name === 'onlyTests');
    const l = runTool(R, '--list', 'DEAD').out;
    const m = l.match(/harness\/a\.mjs:1 deadFn \(function, (\d+) lines\)/);
    return [t?.class === 'TEST-ONLY' && m && Number(m[1]) === 7, JSON.stringify({ t, l })];
  });
  await guard('tool: an export used only inside its own file or by its own command line part is INTERNAL, not DEAD', async () => {
    const rep = json(R);
    const c = (n) => (rep.exports || []).find((e) => e.name === n)?.class;
    return [c('cliOnly') === 'INTERNAL' && c('innerConst') === 'INTERNAL', JSON.stringify({ cliOnly: c('cliOnly'), innerConst: c('innerConst') })];
  });
  await guard('tool: a module nobody names is UNREACHED; one a dynamic import, a doc or a package.json script names is not; one only a test names is marked testOnly', async () => {
    const rep = json(R);
    const u = Object.fromEntries((rep.unreached || []).map((x) => [x.file, x]));
    const ok = u['harness/orphan.mjs'] && !u['harness/orphan.mjs'].testOnly && !u['harness/c.mjs'] && !u['harness/docnamed.mjs'] && !u['harness/b.mjs'] && u['harness/tested.mjs']?.testOnly === true;
    return [ok, JSON.stringify(Object.keys(u))];
  });

  // Duplicates: `same` in p and q (q imports p: one-way, foldable); `twin` in x and y (they import each other: refused).
  const D = path.join(T, 'dups');
  const fn = (name) => `export function ${name}(a, b) {\n  // a comment that is not part of the body\n  const s = a + b;\n  const t = s * 2;\n  if (t > 10) return t;\n  return s;\n}\n`;
  write(D, 'harness/p.mjs', fn('same'));
  write(D, 'harness/q.mjs', `import { x1 } from './p.mjs';\nexport const q1 = x1;\n${fn('same').replace('// a comment that is not part of the body', '/* other words */')}`);
  write(D, 'harness/x.mjs', `import './y.mjs';\n${fn('twin').replace('s * 2', 's * 3')}`);
  write(D, 'harness/y.mjs', `import './x.mjs';\n${fn('twin').replace('s * 2', 's * 3')}`);
  await guard('duplicates: an identical function in two files is found (comments and spacing ignored); the one that can be imported without a cycle is folded, the pair that import each other is refused', async () => {
    const r = json(D, '--duplicates');
    const groups = r.groups || [];
    const same = groups.find((g) => g.name === 'same');
    const twin = groups.find((g) => g.name === 'twin');
    const ok = same && same.keep === 'harness/p.mjs' && same.fold.join() === 'harness/q.mjs'
      && twin && twin.fold.length === 0 && twin.refused.length === 1 && /import cycle/.test(twin.refused[0].reason);
    return [ok, JSON.stringify(r)];
  });

  await guard(`repo: the tool runs on the real repo and its DEAD count is not above ${DEAD_EXPORTS_ALLOWED}; lower DEAD_EXPORTS_ALLOWED in qa/selftest-286g.mjs when you remove more`, async () => {
    const r = spawnSync(process.execPath, [tool, '--json', '--root', dir], { windowsHide: true, encoding: 'utf8', timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
    const rep = JSON.parse(r.stdout);
    return [rep.counts.DEAD <= DEAD_EXPORTS_ALLOWED && rep.seconds < 30, `DEAD ${rep.counts.DEAD}, ${rep.seconds}s: ${(rep.exports || []).filter((e) => e.class === 'DEAD').map((e) => `${e.file}:${e.name}`).join(' ')}`];
  });
}

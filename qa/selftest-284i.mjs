/**
 * qa/selftest-284i.mjs — 2.84: the check for the import cycle that ends a command with exit 13.
 *
 * A module run as a command that awaits, at top level, a dynamic import of a module whose static imports lead back to
 * it never finishes: Node ends the process with exit 13 ("unsettled top-level await"). It shipped twice
 * (harness/engine-rules.mjs, harness/budget.mjs). scripts/check-top-level-await.mjs finds the rest.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest284I({ dir, report, tmpRoot, root }) {
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, ok, d); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 1500)); } };
  const script = path.join(dir, 'scripts', 'check-top-level-await.mjs');
  const node = (args, cwd = dir) => spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000 });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n/g, '\n');
  const base = fs.mkdtempSync(path.join(tmpRoot || process.env.TEMP || '.', 'tla-'));
  let n = 0;
  // A temp repo with a tiny harness/ of made-up modules; returns the check's result.
  const project = (files, extra = []) => {
    const d = path.join(base, `p${++n}`);
    for (const [f, text] of Object.entries(files)) { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), text); }
    const r = node([script, '--root', d, ...extra]);
    return { r, text: out(r), dir: d };
  };
  const guardLine = "const isMain = process.argv[1] && true;";
  const importsM = "import './m.mjs';\n";

  await guard('2.84 a module that awaits import(\'./x.mjs\') at top level inside an if block, where x statically imports it, is reported with the line and the chain, exit 1 (fails before this fix: no such check existed)', () => {
    const p = project({ 'harness/m.mjs': `${guardLine}\nif (isMain) {\n  await import('./x.mjs');\n}\n`, 'harness/x.mjs': importsM });
    return [p.r.status === 1 && /harness\/m\.mjs:3 awaits import\('\.\/x\.mjs'\) at top level, and x\.mjs reaches m\.mjs through static imports \(x \u2192 m\): run as a command this exits 13/.test(p.text), p.text];
  });
  await guard('2.84 the same await where x does not reach the module through static imports (a dynamic import back does not count) is not reported, PASS and exit 0', () => {
    const p = project({ 'harness/m.mjs': `${guardLine}\nif (isMain) { await import('./x.mjs'); }\n`, 'harness/x.mjs': "export const a = 1;\nexport async function later() { return import('./m.mjs'); }\n" });
    return [p.r.status === 0 && /^PASS — 2 modules checked/m.test(p.text), p.text];
  });
  await guard('2.84 a three-module chain (x imports a, a imports m) is reported and the whole chain is printed; so is an await inside a top-level try block', () => {
    const p = project({ 'harness/m.mjs': `${guardLine}\ntry {\n  await import('./x.mjs');\n} catch {}\n`, 'harness/x.mjs': "import './a.mjs';\n", 'harness/a.mjs': "export { y } from './m.mjs';\n" });
    return [p.r.status === 1 && /m\.mjs:3 .*\(x \u2192 a \u2192 m\)/.test(p.text), p.text];
  });
  await guard('2.84 one level of indirection is reported: a top-level `await helper()` where helper in the same file holds the dynamic import (the line is the await helper() line); a helper that is never awaited at top level is not', () => {
    const a = project({ 'harness/m.mjs': "async function helper() {\n  const x = await import('./x.mjs');\n  return x;\n}\nawait helper();\n", 'harness/x.mjs': importsM });
    const b = project({ 'harness/m.mjs': "async function helper() {\n  const x = await import('./x.mjs');\n  return x;\n}\nexport { helper };\n", 'harness/x.mjs': importsM });
    return [a.r.status === 1 && /m\.mjs:5 awaits import\('\.\/x\.mjs'\)/.test(a.text) && b.r.status === 0, `${a.text} || ${b.text}`];
  });
  await guard('2.84 the same await inside an async IIFE (the wrapper the fixed modules use) is not reported', () => {
    const p = project({ 'harness/m.mjs': `${guardLine}\nif (isMain) (async () => {\n  await import('./x.mjs');\n})().catch((e) => { console.error(e); process.exit(1); });\n`, 'harness/x.mjs': importsM });
    return [p.r.status === 0, p.text];
  });
  await guard('2.84 an await in an async function, an arrow, a class method, a string, a template literal, a comment or a regex literal is not reported, and the code after them is still read (a real one after them is)', () => {
    const body = [
      "async function f() { await import('./x.mjs'); }",
      "const g = async () => { await import('./x.mjs'); };",
      "class C { async m() { await import('./x.mjs'); } }",
      "const s = \"await import('./x.mjs')\"; const s2 = 'await import(\\'./x.mjs\\')';",
      "const t = `a ${1 + 1} await import('./x.mjs') ${`nested ${2}`}`;",
      "// await import('./x.mjs')",
      "/* await import('./x.mjs') */",
      "const re = /await import\\('.\\/x.mjs'\\)/; const div = 4 / 2 / 1;",
      "const o = { async k() { await import('./x.mjs'); } };",
    ].join('\n');
    const clean = project({ 'harness/m.mjs': `${body}\nexport { f, g, C, s, s2, t, re, div, o };\n`, 'harness/x.mjs': importsM });
    const dirty = project({ 'harness/m.mjs': `${body}\nawait import('./x.mjs');\n`, 'harness/x.mjs': importsM });
    return [clean.r.status === 0 && dirty.r.status === 1 && /m\.mjs:10 /.test(dirty.text), `${clean.text} || ${dirty.text}`];
  });
  await guard('2.84 --all lists, as information only with exit 0, a module with a top-level await that another module imports statically but that closes no cycle; without --all it is not listed, and a module nobody imports is not listed at all', () => {
    const files = { 'harness/m.mjs': "await Promise.resolve();\nexport const a = 1;\n", 'harness/x.mjs': importsM, 'harness/solo.mjs': "await Promise.resolve();\n" };
    const withAll = project(files, ['--all']); const plain = project(files);
    return [withAll.r.status === 0 && /harness\/m\.mjs:1 .*latent/.test(withAll.text) && !/solo/.test(withAll.text) && plain.r.status === 0 && !/latent/.test(plain.text) && /^PASS/m.test(plain.text), `${withAll.text} || ${plain.text}`];
  });
  await guard('2.84 --json gives the offenders with their chain', () => {
    const p = project({ 'harness/m.mjs': "await import('./x.mjs');\n", 'harness/x.mjs': importsM }, ['--json']);
    let j = null; try { j = JSON.parse(p.r.stdout); } catch {}
    return [p.r.status === 1 && j && j.ok === false && j.offenders[0]?.file === 'harness/m.mjs' && j.offenders[0].chain.join(',') === 'harness/x.mjs,harness/m.mjs', p.text.slice(0, 600)];
  });
  await guard('2.84 runtime proof: a made-up offender run with node really exits 13 (unsettled top-level await), and the version wrapped in an async function runs to the end with exit 0', () => {
    const files = (m) => ({ 'harness/m.mjs': m, 'harness/x.mjs': importsM });
    const head = "import path from 'node:path';\nimport { fileURLToPath } from 'node:url';\nconst isMain = path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url));\n";
    const bad = project(files(`${head}if (isMain) {\n  await import('./x.mjs');\n  console.log('reached the end');\n}\n`));
    const good = project(files(`${head}if (isMain) (async () => {\n  await import('./x.mjs');\n  console.log('reached the end');\n})().catch((e) => { console.error(e?.stack || String(e)); process.exit(1); });\n`));
    const rb = node([path.join(bad.dir, 'harness', 'm.mjs')], bad.dir); const rg = node([path.join(good.dir, 'harness', 'm.mjs')], good.dir);
    return [rb.status === 13 && !/reached the end/.test(out(rb)) && bad.r.status === 1 && rg.status === 0 && /reached the end/.test(out(rg)) && good.r.status === 0, `bad exit ${rb.status} check ${bad.r.status}; good exit ${rg.status} check ${good.r.status} ${out(rg).slice(0, 200)}`];
  });
  await guard('2.84 on this repo the check exits 0 (fails before this fix: harness/ask.mjs, engine-tracks.mjs, session-cap.mjs and waves.mjs each awaited an import in their command line whose static imports lead back to them)', () => {
    const r = node([script]);
    return [r.status === 0 && /^PASS — \d+ modules checked/m.test(out(r)), out(r).slice(0, 1500)];
  });
  await guard('2.84 `node harness/engine-tracks.mjs backfill --dry-run` finishes with exit 0 instead of exit 13 (fails before this fix: unsettled top-level await at the backfill line)', () => {
    const r = node(['harness/engine-tracks.mjs', 'backfill', '--dry-run']);
    return [r.status === 0 && /nothing to backfill|engine tracks/.test(out(r)), `exit ${r.status} ${out(r).slice(0, 400)}`];
  });
  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
}

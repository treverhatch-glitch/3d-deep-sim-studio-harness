/**
 * qa/selftest-286h.mjs — 2.86 (h): no name used and defined nowhere (scripts/check-names.mjs, npm run check:names).
 *   - a name declared in one block and read in another, a typo with a near miss and a shorthand property with no value
 *     are each reported with file, line and column, exit 1;
 *   - what Node and the language give (process, URL, fetch, setTimeout, a function declared further down, an import)
 *     is not reported; a clean tree exits 0; fixtures and node_modules are not read;
 *   - the engine train's capped hand-back text, where the name that started this was, reads its cap from a function
 *     in scope.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest286H({ report, tmpRoot, root }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const T = path.join(tmpRoot, `s286h-${process.pid}`);
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(T, rel)), { recursive: true }); fs.writeFileSync(path.join(T, rel), text); };
  const check = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'check-names.mjs'), ...args], { windowsHide: true, encoding: 'utf8', timeout: 240000 });
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;

  write('harness/a.mjs', ['export function handBack(st) {', '  if (st.capped) { const cap = 3; return cap; }', '  return `stopped at ${cap}`;', '}', 'export const card = () => ({ missing });', ''].join('\n'));
  write('scripts/b.mjs', ['import { handBack } from "../harness/a.mjs";', 'console.log(handBack({}), helperr);', 'function helper() {}', 'helper();', ''].join('\n'));
  write('harness/ok.mjs', ['import fs from "node:fs";', 'export const ok = () => [process.env.X, new URL("a:b"), typeof fetch, setTimeout, Buffer.from(""), fs.existsSync("."), later()];', 'function later() { return globalThis.structuredClone ? 1 : 0; }', ''].join('\n'));
  write('qa/fixtures/broken.mjs', 'export const x = neverDefined;\n');
  write('node_modules/dep/index.js', 'module.exports = neverDefinedEither;\n');
  const bad = check('--root', T);
  const j = (() => { try { return JSON.parse(check('--root', T, '--json').stdout); } catch { return {}; } })();
  await guard('2.86 (h) names: a name declared in another block ("cap"), a typo with a near miss ("helperr") and a shorthand property with no value ("missing") are each reported with file, line and column and the check exits 1 (fails before this fix: no such check; one such name reached a pull request)', () => [
    bad.status === 1 && /harness\/a\.mjs:3:\d+ Cannot find name 'cap'/.test(out(bad)) && /scripts\/b\.mjs:2:\d+ Cannot find name 'helperr'/.test(out(bad)) && /harness\/a\.mjs:5:\d+ No value exists in scope for the shorthand property 'missing'/.test(out(bad)) && /3 name\(s\) used and defined nowhere/.test(out(bad)) && j.found?.length === 3,
    out(bad).slice(-2500)]);
  await guard('2.86 (h) names: what Node and the language give (process, URL, fetch, setTimeout, Buffer, an import, a function declared further down) is not reported, and fixtures and node_modules are not read (fails before this fix: no such check)', () => [
    !/ok\.mjs|fixtures|node_modules/.test(out(bad)) && j.files === 3, JSON.stringify(j).slice(0, 2000)]);
  fs.rmSync(path.join(T, 'harness', 'a.mjs'));
  write('scripts/b.mjs', 'console.log(1);\n');
  const good = check('--root', T);
  await guard('2.86 (h) names: a clean tree exits 0 and says how many files it read (fails before this fix: no such check)', () => [good.status === 0 && /ok: 2 file\(s\), every name is defined/.test(out(good)), out(good).slice(-1500)]);
  const train = check('--json', path.join(root, 'harness', 'unity-train.mjs'));
  const src = fs.readFileSync(path.join(root, 'harness', 'unity-train.mjs'), 'utf8');
  await guard('2.86 (h) names: every name in the engine train is defined, and its "bisect stopped at its cap" hand-back reads the cap from a function in scope (fails before this fix: bisectMax was declared in a block the hand-back could not see, a ReferenceError that ended the train)', () => [
    train.status === 0 && /"found":\[\]/.test(train.stdout) && /\(STUDIO_ENGINE_BISECT_MAX \$\{bisectCap\(\)\}\)/.test(src) && /function bisectCap\(\) \{/.test(src), out(train).slice(-1500)]);
}

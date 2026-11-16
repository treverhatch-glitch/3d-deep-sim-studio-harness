/**
 * qa/selftest-287a.mjs — 2.87 (a): the length rule for comments (scripts/check-comments.mjs, npm run check:comments).
 * A file header over 12 lines and any other comment over 6 are named with file and line and the check exits 1; a header
 * of 12, a comment of 6, two short runs of // lines with code between them and comments at the end of code lines pass;
 * and harness/ and scripts/ themselves are within the rule.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { guardCap3000Of, out, writeInDirOf } from './kit.mjs';

export async function selftest287A({ report, tmpRoot, root }) {
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s287a-${process.pid}`);
  const write = writeInDirOf(T);
  const check = (...args) => spawnSync(process.execPath, [path.join(root, 'scripts', 'check-comments.mjs'), ...args], { windowsHide: true, encoding: 'utf8', timeout: 240000 });
  const header = (n) => ['/**', ...Array.from({ length: n - 2 }, (_, i) => ` * line ${i + 1} of the header`), ' */'].join('\n');
  const slashes = (n, pad = '') => Array.from({ length: n }, (_, i) => `${pad}// note ${i + 1}`).join('\n');

  write('harness/long-header.mjs', `${header(13)}\nexport const a = 1;\n`);
  write('harness/long-block.mjs', `${header(12)}\nexport const a = 1;\n\n${slashes(7)}\nexport const b = 2;\n\nexport function f() {\n  /*\n   * one\n   * two\n   * three\n   * four\n   * five\n   */\n  return 1;\n}\n`);
  write('scripts/fine.mjs', `#!/usr/bin/env node\n${header(12)}\nexport const a = 1; // a note at the end of a code line\n${slashes(6)}\nexport const b = 2;\n${slashes(6)}\nexport const c = { d: 3 }; /* another */ // and one more\n\n/** six\n * lines\n * of\n * a\n * block\n */\nexport const e = 4;\n`);
  write('harness/fixtures/skipped.mjs', `${header(40)}\nexport const a = 1;\n`);
  const bad = check('--root', T);
  const j = (() => { try { return JSON.parse(check('--root', T, '--json').stdout); } catch { return {}; } })();
  await guard('2.87 (a) comments: a file header of 13 lines is named with its file and line and the check exits 1 (fails before this fix: no such check; headers had grown to 70 lines)', () => [
    bad.status === 1 && /harness\/long-header\.mjs:1 the file header is 13 lines; the rule is 12/.test(out(bad)), out(bad).slice(-2000)]);
  await guard('2.87 (a) comments: a run of seven // lines and a seven-line block comment inside a function are each named, with the rule of 6 (fails before this fix: no such check)', () => [
    /harness\/long-block\.mjs:15 a comment is 7 lines; the rule is 6/.test(out(bad)) && /harness\/long-block\.mjs:25 a comment is 7 lines; the rule is 6/.test(out(bad)) && j.over?.length === 3 && /3 comment\(s\) over the rule/.test(out(bad)),
    out(bad).slice(-2000)]);
  await guard('2.87 (a) comments: a header of 12 lines after a #! line, comments of 6 lines, two runs of // lines with code between them and comments at the end of code lines are within the rule; fixtures are not read (fails before this fix: no such check)', () => [
    !/fine\.mjs|fixtures/.test(out(bad)) && j.files === 3, JSON.stringify(j).slice(0, 2000)]);
  fs.rmSync(path.join(T, 'harness', 'long-header.mjs'));
  fs.rmSync(path.join(T, 'harness', 'long-block.mjs'));
  const good = check('--root', T);
  await guard('2.87 (a) comments: a tree within the rule exits 0 and says how many files and comments it read (fails before this fix: no such check)', () => [good.status === 0 && /ok: 1 file\(s\), 4 comment\(s\)/.test(out(good)), out(good).slice(-1500)]);
  const own = check();
  await guard("2.87 (a) comments: every comment of harness/ and scripts/ is within the rule (fails before this fix: 418 comments were over it, 7,727 lines)", () => [own.status === 0 && /\[check-comments\] ok: \d+ file\(s\)/.test(out(own)), out(own).slice(-2500)]);
}

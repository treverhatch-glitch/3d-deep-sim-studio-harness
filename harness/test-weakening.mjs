#!/usr/bin/env node
/**
 * harness/test-weakening.mjs — 2.58.2 (PU-29): tests weakened to make a check pass need the owner's OK.
 *
 * Before 2.58.2 a weakened test (a `.skip`, a removed assert, a wider tolerance) was forbidden only by the rules text.
 * This reads the diff since the base branch (approve.mjs resolveBase; committed and not) in test files (*.test.*,
 * *.spec.*, tests/, test/, __tests__/, qa/, specs/, C# *.Tests/ and *Tests/ folders, test_*.py, *_test.*, *Test(s).cs|gd)
 * and test-runner configs (vitest/jest/playwright config, .mocharc, pytest.ini, *.runsettings), and flags:
 *
 *   assert-removed      assertion lines removed (expect, assert*, Assert.*, should, t.is, require.*, assert_* …) beyond
 *                       the ones added in the same place (hunk); new tests elsewhere don't make up for them; an assert
 *                       commented out counts as removed; one moved unchanged (to another file too) doesn't
 *   skip-added          .skip / .todo / xit / xdescribe / test.todo / [Ignore] / [Explicit] / Skip = "…" / @Disabled /
 *                       @Ignore / pytest skip and xfail / t.Skip / gdUnit do_skip / { skip: true } / #[ignore], added
 *                       (2.71.1: also chained, it.concurrent.skip; and skipIf / runIf added to an existing test or on an
 *                       env/CI condition: a new test that runs on one OS only is fine)
 *   env-skip            2.71.1: an early return on CI or an env variable (`if (process.env.CI) return`)
 *   expect-shadowed     2.71.1: expect/assert redefined, renamed on import, wrapped in a Proxy or the library mocked
 *   only-added          .only / fit / fdescribe (every other test stops running)
 *   timeout-raised      a test timeout raised (same line, bigger number after the word timeout)
 *   tolerance-widened   toBeCloseTo / places / precision / digits lowered; eps, tol, delta, margin, atol, rtol, approx,
 *                       an abs() bound or a 3-argument AreEqual raised (the last number on the same line)
 *   seed-special-case   a condition on a literal seed (`if (seed === 7)`, `[7, 9].includes(seed)`, `switch (seed)`), or
 *                       on a literal tick/frame/step that returns, continues, breaks or skips
 *   test-deleted        a test file deleted (a rename is not a delete)
 *   contract-*          2.62.0 (H): an agreed acceptance contract (studio/contracts/<ID>.json, harness/contracts.mjs) changed
 *                       beyond `passes`, agreed or extended by a worker, or a manual criterion passed without a
 *                       reviewer's or a person's signature; enforced with or without an owner key
 *   golden-edited       a golden or snapshot file (golden/, goldens/, __snapshots__/, *.snap, *.golden.*) changed or
 *                       deleted by a commit without a Golden-Reason trailer (a new snapshot is fine)
 *
 * Each finding names file:line, the kind and the line. Enforced once the base branch has an owner key (like the protected
 * files); before that the findings are a warning. Only the owner approves an intended change, by content:
 * `npm run approve -- tests --note "why"` signs exactly the findings listed now. STUDIO_WEAKENED_TESTS=off turns the
 * gate off, =on enforces it even without an owner key.
 *
 * Limits: it reads lines, not meaning. A weaker assert written in the same count (toBe → toBeTruthy), a helper that
 * always passes, a special case in the game code rather than the test, an assert removed and an unrelated one added in
 * the same place, and test files outside the names above aren't caught.
 *
 *   node harness/test-weakening.mjs [--json]
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { protectRoot, trustedEnv } from './gate-trust.mjs';
import { TASK_LINE_RE } from './board-line.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
// 2.71.1 (A16): STUDIO_PROTECT_ROOT is never used in a lane copy (harness/gate-trust.mjs).
const ROOT = protectRoot(path.resolve(HERE, '..')) || path.resolve(HERE, '..');
// 2.58.5 (H-7): STUDIO_HOOKS_MAX_BUFFER (bytes) lowers the read limit, for tests; an output over it is an error, never a
// silently cut diff (spawnSync stops at maxBuffer and returns what it had).
const MAX_BUFFER = Number(process.env.STUDIO_HOOKS_MAX_BUFFER) > 0 ? Number(process.env.STUDIO_HOOKS_MAX_BUFFER) : 512 * 1024 * 1024;
const git = (args, input) => {
  let r;
  try { r = spawnSync('git', ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', ...args], { windowsHide: true, cwd: ROOT, encoding: 'utf8', input, maxBuffer: MAX_BUFFER }); } catch (e) { throw new Error(`could not read git ${args[0]}: output too big (${e.code || e.message})`); }
  if (r.error) throw new Error(`could not read git ${args[0]}: ${r.error.code === 'ENOBUFS' ? `output over ${MAX_BUFFER} bytes` : r.error.message}`);
  return r;
};

const CODE_EXT = /\.(m?[jt]sx?|cjs|cts|mts|py|gd|cs|java|kt|kts|go|rs|rb|lua|c|cc|cpp|h|hpp|swift|php|scala|dart)$/i;
export function isGoldenPath(f) {
  return /(^|\/)(golden|goldens|__snapshots__)\//i.test(f) || /\.snap(shot)?$/i.test(f) || /\.golden(\.[^/]*)?$/i.test(f);
}
export function isTestConfig(f) {
  return /(^|\/)(vitest|jest|playwright|karma|cypress|vite)\.config\.[^/]+$/.test(f) || /(^|\/)\.mocharc(\.[^/]+)?$/.test(f) || /(^|\/)(pytest\.ini|[^/]*\.runsettings)$/.test(f);
}
export function isTestPath(f) {
  if (/(^|\/)(node_modules|\.git|addons\/gdUnit4)\//.test(f) || isGoldenPath(f)) return false;
  return /(^|\/)[^/]+\.(test|spec)\.[^/]+$/i.test(f)
    || /(^|\/)(tests?|__tests__|specs?|qa)\//i.test(f)
    || /(^|\/)[^/]*(\.Tests?|Tests)\//.test(f)
    || /(^|\/)(test_[^/]+\.(py|gd)|[^/]+_test\.(py|gd|go|rs|js|ts|mjs)|[^/]+Tests?\.(cs|gd|java|kt))$/.test(f);
}

const norm = (l) => l.trim().replace(/\s+/g, ' ');
const isComment = (l) => { const t = l.trim(); return /^(\/\/|\/\*|\*|--|;|<!--)/.test(t) || (/^#/.test(t) && !/^#\[/.test(t)); };
const ASSERT = /\bexpect\s*[.(]|\bassert\w*!?\s*[.(]|\bassert\s+[^\s=(]|\bAssert(That)?\.\w+|\.[Ss]hould\b|\bshould\.\w+|\bt\.(is|not|ok|notOk|true|false|truthy|falsy|deepEqual|equal|same|throws|regex|match|snapshot)\s*\(|\brequire\.\w+\s*\(|\bt\.(Error|Errorf|Fatal|Fatalf|Fail)\b|\bfail\s*\(/;
const SKIP = [
  /\b(it|test|describe|context|suite|specify|bench)(\.\w+)*\.(skip|todo|fixme)\b/, /\b(xit|xtest|xdescribe|xcontext|xspecify)\s*\(/,
  /\[\s*(Ignore|Explicit)\b/, /\bSkip\s*=\s*["@$]/, /@Disabled\b/, /@Ignore\b/, /@pytest\.mark\.(skip|skipif|xfail)\b/, /\bpytest\.skip\s*\(/,
  /@unittest\.skip/, /\bself\.skipTest\s*\(/, /\bt\.Skip(f|Now)?\s*\(/, /\bdo_skip\s*:?=\s*true\b/, /[{,]\s*(skip|todo)\s*:\s*true\b/, /#\[ignore\]/,
  /\bmarkTestSkipped\s*\(/, /\bpending\s*\(\s*\)/,
];
// 2.71.1 (H10, H13): a test that runs only under a condition, returns early on CI, or checks with a stand-in expect.
const CONDITIONAL = /\b(it|test|describe|context|suite|specify|bench)(\.\w+)*\.(skipIf|runIf)\s*\(/;
const STRIP_COND = /(\.\w+)*?\.(skipIf|runIf)\s*\((?:[^()]|\((?:[^()]|\([^()]*\))*\))*\)\s*/g;
const ENV_COND = /process\.env\b|import\.meta\.env\b|\bos\.environ\b|\bgetenv\s*\(|\b(Deno|Bun)\.env\b|\b(is_?)?CI\b|\bisCi\b|GITHUB_ACTIONS|\bVITEST\b|\bJEST_WORKER_ID\b/;
const envReturn = (t, next = '') => /\bif\b/.test(t) && ENV_COND.test(t) && (/\breturn\b/.test(t) || (/[{:]\s*$/.test(t.trim()) && /^\s*return\b/.test(next)));
const SHADOW = [
  /\bfunction\s+(expect|assert)\s*[(<]/, /\b(const|let|var)\s+(expect|assert)\s*(:[^=]+)?=(?!=|\s*(require|chai|await\s+import)\b)/,
  /\bexpect\s+as\s+\w+/, /[{,]\s*expect\s*:\s*\w+\s*[,}]/, /\b(globalThis|global|window|self)\s*\.\s*(expect|assert)\s*=[^=]/, /^\s*(expect|assert)\s*=[^=]/,
  /\b(vi|jest)\.(mock|doMock|spyOn)\s*\(\s*['"`](vitest|@jest\/globals|chai|expect|node:assert|assert)['"`]/,
];
const shadowHit = (t) => SHADOW.some((p) => p.test(t)) || (/\bnew\s+Proxy\s*\(/.test(t) && /\b(expect|assert)\b/.test(t));
const ONLY = [/\b(it|test|describe|context|suite|specify)\.only\b/, /\b(fit|fdescribe|fcontext)\s*\(/];
const SEED = [
  /\bseed\w*\s*(===?|!==?)\s*-?\d/i, /-?\d+\s*(===?|!==?)\s*\w*seed\b/i, /\[[\d,\s]+\]\.includes\(\s*\w*seed/i,
  /(?<!\bfor\s+)\bseed\w*\s+(not\s+)?in\s*[[(]/i, /\bswitch\s*\(\s*\w*seed\w*\s*\)/i, /\bmatch\s+\w*seed\w*\s*:/i,
];
// 2.58.5: an assertion about the seed itself (`expect(sim.seed !== 0).toBe(true)`, `assert seed != 0`) checks it, it
// doesn't special-case it; with a branch on the same line (if, a ternary, return/continue/skip) it still counts.
const assertsOnSeed = (t) => ASSERT.test(t) && !/\b(if|elif|else|unless|when|switch|match|return|continue|break|skip\w*)\b/.test(t) && !/(?<![?])\?(?![?.])/.test(t);
const TICK = /\b(tick|frame|step|turn)\w*\s*(===?|!==?|==|<=?|>=?)\s*\d+|\b\d+\s*(===?|!==?)\s*\w*(tick|frame|step)\b/i;
const NUM = /(?<![\w.])-?\d[\d_]*(\.\d+)?(e[-+]?\d+)?(?![\w])/gi;
const nums = (s) => [...s.matchAll(NUM)].map((m) => Number(m[0].replace(/_/g, '')));
const shape = (s) => norm(s).replace(NUM, '#');
const isTimeout = (l) => /\b(jest|vi)\.setTimeout\b/.test(l) || (/time-?out/i.test(l) && !/\b(set|clear)Timeout\b/.test(l));
const afterTimeout = (l) => { const i = l.search(/time-?out/i); return i < 0 ? null : nums(l.slice(i))[0] ?? null; };
const PRECISION = /toBeCloseTo|\b(places|precision|digits|decimal|numDigits)\b/i;
const TOLERANCE = /\b(eps(ilon)?|tol(erance)?|atol|rtol|abs_tol|rel_tol|approx\w*|\w*almost\w*|max_?diff|allowed_?error)\b|is_equal_approx|AreEqual\s*\([^,]+,[^,]+,|\babs\s*\(.*(<|toBeLessThan|is_less)/i;
const NAMED_TOL_RE = (names) => new RegExp(`\\b(${names})\\w*\\s*[:=]\\s*(-?[\\d_.]+(e[-+]?\\d+)?)`, 'i');
const NAMED_TOL = NAMED_TOL_RE('eps(?:ilon)?|tol(?:erance)?|atol|rtol|abs_tol|rel_tol|max_?diff|allowed_?error');
const NAMED_TOL_ASSERT = NAMED_TOL_RE('delta|margin|threshold'); // only on an assertion line (assertAlmostEqual(a, b, delta=…))
const namedTol = (l) => l.match(NAMED_TOL) || (ASSERT.test(l) ? l.match(NAMED_TOL_ASSERT) : null);
const NAMED_PREC = /\b(places|precision|digits|decimal)\s*[:=]\s*(\d+)/i;

/** Parse `git diff -U0` into files: { file, oldFile, deleted, added, hunks: [{ removed: [{line, text}], added: [{line, text}] }] }. */
export function parseDiff(text) {
  const files = [];
  let cur = null;
  let hunk = null;
  let inHeader = false;
  let oldLine = 0;
  let newLine = 0;
  const unq = (s) => s.replace(/^"(.*)"$/, '$1').replace(/\\(.)/g, '$1');
  for (const raw of String(text || '').split('\n')) {
    const l = raw.replace(/\r$/, '');
    if (l.startsWith('diff --git ')) { cur = { file: null, oldFile: null, deleted: false, isNew: false, hunks: [] }; files.push(cur); hunk = null; inHeader = true; continue; }
    if (!cur) continue;
    if (inHeader) {
      if (l.startsWith('deleted file mode')) cur.deleted = true;
      else if (l.startsWith('new file mode')) cur.isNew = true;
      else if (l.startsWith('rename from ')) cur.oldFile = unq(l.slice(12));
      else if (l.startsWith('rename to ')) cur.file = unq(l.slice(10));
      else if (l.startsWith('--- ')) { const p = unq(l.slice(4).replace(/\t.*$/, '')); if (p !== '/dev/null') cur.oldFile = cur.oldFile || p.replace(/^a\//, ''); }
      else if (l.startsWith('+++ ')) { const p = unq(l.slice(4).replace(/\t.*$/, '')); if (p !== '/dev/null') cur.file = p.replace(/^b\//, ''); }
    }
    const m = l.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (m) { inHeader = false; oldLine = Number(m[1]); newLine = Number(m[3]); hunk = { removed: [], added: [], at: Number(m[4] ?? 1) === 0 ? newLine + 1 : newLine }; cur.hunks.push(hunk); continue; }
    if (!hunk) continue;
    if (l.startsWith('-')) hunk.removed.push({ line: oldLine++, at: hunk.at, text: l.slice(1) });
    else if (l.startsWith('+')) hunk.added.push({ line: newLine++, text: l.slice(1) });
  }
  for (const f of files) { if (!f.file) f.file = f.oldFile; if (!f.oldFile) f.oldFile = f.file; }
  return files;
}

const fid = (kind, file, text) => crypto.createHash('sha256').update(`${kind}\n${file}\n${norm(text)}`).digest('hex').slice(0, 16);
const finding = (kind, file, line, text, detail = '') => ({ id: fid(kind, file, text), kind, file, line, text: norm(text).slice(0, 160), detail });

/** The weakenings in a parsed diff (test files only). Pure: the selftest feeds it diffs directly. */
export function weakeningsInDiff(files) {
  const out = [];
  const tests = files.filter((f) => isTestPath(f.file) || isTestPath(f.oldFile));
  for (const f of tests.filter((x) => x.deleted && CODE_EXT.test(x.oldFile))) out.push(finding('test-deleted', f.oldFile, 1, `deleted ${f.oldFile}`, 'a test file was deleted'));
  const live = tests.filter((f) => !f.deleted && CODE_EXT.test(f.file));
  // A line removed in one place and added unchanged in another (moved) cancels out, across files.
  const removedAll = new Map();
  const addedAll = new Map();
  const bump = (m, k) => m.set(k, (m.get(k) || 0) + 1);
  for (const f of live) for (const h of f.hunks) { for (const r of h.removed) if (!isComment(r.text)) bump(removedAll, norm(r.text)); for (const a of h.added) if (!isComment(a.text)) bump(addedAll, norm(a.text)); }
  const unmatched = (list, other) => { const left = new Map(other); return list.filter((x) => { const k = norm(x.text); if ((left.get(k) || 0) > 0) { left.set(k, left.get(k) - 1); return false; } return true; }); };
  for (const f of live) {
    const removed = f.hunks.flatMap((h) => h.removed).filter((r) => !isComment(r.text));
    const added = f.hunks.flatMap((h) => h.added).filter((a) => !isComment(a.text));
    const addedComments = f.hunks.flatMap((h) => h.added).filter((a) => isComment(a.text)).map((a) => norm(a.text));
    // Only asserts added in the same place (hunk) replace removed ones: new tests elsewhere in the file don't pay for them.
    for (const h of f.hunks) {
      const rA = unmatched(h.removed.filter((r) => !isComment(r.text) && ASSERT.test(r.text)), addedAll);
      const aA = unmatched(h.added.filter((a) => !isComment(a.text) && ASSERT.test(a.text)), removedAll);
      if (rA.length > aA.length) for (const r of rA) out.push(finding('assert-removed', f.file, r.at, r.text, `${addedComments.some((c) => c.includes(norm(r.text))) ? 'commented out; ' : ''}${rA.length} assertion(s) removed, ${aA.length} added in its place`));
    }
    for (const [kind, pats] of [['skip-added', SKIP], ['only-added', ONLY]]) {
      const hit = (t) => pats.some((p) => p.test(t));
      const add = unmatched(added.filter((a) => hit(a.text)), removedAll);
      const rem = removed.filter((r) => hit(r.text));
      if (add.length > rem.length) for (const a of add) out.push(finding(kind, f.file, a.line, a.text, kind === 'only-added' ? 'every other test in the file stops running' : 'a test no longer runs'));
    }
    // 2.71.1 (H10): skipIf / runIf added to an existing test (the same line before, without it), or on an env/CI condition.
    // A new test that runs only on one OS (it.runIf(process.platform === 'win32')) is not flagged.
    // The harness's own qa/*.mjs scripts read env variables by design (and are tier C / protected): not judged by these three.
    const own = /^qa\/[^/]+\.mjs$/.test(f.file);
    const removedHere = new Set(removed.map((r) => norm(r.text)));
    const cond = own ? [] : unmatched(added.filter((a) => CONDITIONAL.test(a.text) && (ENV_COND.test(a.text) || removedHere.has(norm(a.text.replace(STRIP_COND, ''))))), removedAll);
    for (const a of cond) out.push(finding('skip-added', f.file, a.line, a.text, ENV_COND.test(a.text) ? 'the test runs only when an env variable (CI…) says so' : 'an existing test now runs only under a condition'));
    // 2.71.1 (H10): an early return on CI or an env variable (if (process.env.CI) return): the test passes without checking.
    for (const h of own ? [] : f.hunks) {
      const hits = h.added.filter((a, i) => !isComment(a.text) && envReturn(a.text, h.added[i + 1]?.text || ''));
      for (const a of unmatched(hits, removedAll)) out.push(finding('env-skip', f.file, a.line, a.text, 'the test returns early on CI or an env variable, so it passes without checking'));
    }
    // 2.71.1 (H13): expect / assert shadowed, renamed on import, wrapped in a Proxy or mocked: checks that can't fail.
    for (const a of own ? [] : unmatched(added.filter((x) => shadowHit(x.text)), removedAll)) out.push(finding('expect-shadowed', f.file, a.line, a.text, 'the test\'s expect/assert is replaced, renamed or wrapped, so a failed check may not fail the test'));
    const seedHit = (t) => (SEED.some((p) => p.test(t)) && !assertsOnSeed(t)) || (TICK.test(t) && /\b(return|continue|break|skip\w*)\b/.test(t));
    const sAdd = unmatched(added.filter((a) => seedHit(a.text)), removedAll);
    const sRem = removed.filter((r) => seedHit(r.text));
    if (sAdd.length > sRem.length) for (const a of sAdd) out.push(finding('seed-special-case', f.file, a.line, a.text, 'the test behaves differently for one seed or tick'));
  }
  // Timeouts and tolerances: the same line before and after (numbers aside), in one hunk.
  for (const f of tests.filter((x) => !x.deleted).concat(files.filter((x) => !x.deleted && isTestConfig(x.file)))) {
    if (!CODE_EXT.test(f.file) && !isTestConfig(f.file)) continue;
    for (const h of f.hunks) {
      const used = new Set();
      for (const a of h.added) {
        if (isComment(a.text)) continue;
        const r = h.removed.find((x, i) => !used.has(i) && shape(x.text) === shape(a.text) && norm(x.text) !== norm(a.text) && (used.add(i), true));
        if (!r) continue;
        if (isTimeout(a.text)) {
          const before = afterTimeout(r.text);
          const now = afterTimeout(a.text);
          if (before !== null && now !== null && now > before) { out.push(finding('timeout-raised', f.file, a.line, a.text, `timeout ${before} → ${now}`)); continue; }
        }
        const np = a.text.match(NAMED_PREC); const rp = r.text.match(NAMED_PREC);
        const nt = namedTol(a.text); const rt = namedTol(r.text);
        let widened = null;
        if (np && rp && Number(np[2]) < Number(rp[2])) widened = `${rp[1]} ${rp[2]} → ${np[2]}`;
        else if (nt && rt && Math.abs(Number(nt[2].replace(/_/g, ''))) > Math.abs(Number(rt[2].replace(/_/g, '')))) widened = `${rt[1]} ${rt[2]} → ${nt[2]}`;
        else if (!np && !nt) {
          const na = nums(a.text).pop(); const nr = nums(r.text).pop();
          if (na !== undefined && nr !== undefined && na !== nr) {
            if (PRECISION.test(a.text) && na < nr) widened = `precision ${nr} → ${na}`;
            else if (!PRECISION.test(a.text) && TOLERANCE.test(a.text) && Math.abs(na) > Math.abs(nr)) widened = `tolerance ${nr} → ${na}`;
          }
        }
        if (widened) out.push(finding('tolerance-widened', f.file, a.line, a.text, widened));
      }
    }
  }
  return out;
}

const chunks = (arr, n) => { const out = []; for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n)); return out; };

/** 2.85 (g): the task ids on the board (studio/NEXT.md and studio/DONE.md of the main checkout, open or done). */
export function boardTaskIds(root = ROOT, env = process.env) {
  const lane = String(root).replace(/\\/g, '/').match(/^(.*)\/\.lanes\/[^/]+\/?$/);
  const main = env.STUDIO_MAIN_ROOT || (lane ? lane[1] : root);
  const ids = new Set();
  for (const f of ['NEXT.md', 'DONE.md']) {
    let text = '';
    try { text = fs.readFileSync(path.join(main, 'studio', f), 'utf8'); } catch { continue; }
    for (const line of text.replace(/\r\n/g, '\n').split('\n')) { const m = line.trim().match(TASK_LINE_RE); if (m) ids.add(m[2]); }
  }
  return ids;
}

/**
 * 2.85 (g): is a Golden-Reason enough? It was any non-empty text, so "x" waived the golden check. Strict: 20+ characters
 * and a task id that is on the board (open or done), in the board's form (T-123). STUDIO_GOLDEN_REASON=strict|loose; the
 * default is strict when the board has tasks, loose on a fresh studio (an empty board has no id to name).
 * Returns null when the reason is fine, else the sentence to show.
 */
export function goldenReasonProblem(reason, { ids = boardTaskIds(), env = process.env } = {}) {
  const mode = String(env.STUDIO_GOLDEN_REASON || '').toLowerCase();
  if (mode === 'loose' || (mode !== 'strict' && ids.size === 0)) return String(reason || '').trim() ? null : 'it is empty';
  const text = String(reason || '').trim();
  const named = (text.match(/\b[A-Z]+-\d+\b/g) || []).filter((id) => ids.has(id));
  if (text.length >= 20 && named.length) return null;
  return `a Golden-Reason must be at least 20 characters and name a task on the board (for example "T-123: the faster belt moves the end tick"); "${text.slice(0, 60)}" ${text.length < 20 ? 'is too short' : 'names no task on the board'}`;
}

/** Golden/snapshot files changed by a commit since the base with no Golden-Reason trailer (or a reason that names nothing). */
export function goldenWithoutReason(range, { env = process.env } = {}) {
  const log = git(['log', '--no-merges', '--no-renames', '--format=%x1e%H%x1f%B%x1f', '--name-status', range]);
  const ids = boardTaskIds(ROOT, env);
  const out = [];
  for (const rec of log.stdout.split('\x1e').filter((s) => s.includes('\x1f'))) {
    const [sha, msg, names] = rec.split('\x1f');
    const gr = msg.match(/^Golden-Reason:[ \t]*(\S.*)$/im);
    const problem = gr ? goldenReasonProblem(gr[1], { ids, env }) : null;
    if (gr && !problem) continue;
    for (const l of String(names || '').split('\n')) {
      const [st, file] = l.trim().split('\t');
      if (!file || !/^[MD]/.test(st) || !isGoldenPath(file)) continue;
      const subject = msg.split('\n')[0].trim();
      out.push({ ...finding('golden-edited', file, 1, `${subject} :: ${file}`, `commit ${sha.trim().slice(0, 8)} ${st === 'D' ? 'deletes' : 'changes'} it ${gr ? `with a Golden-Reason that is not enough: ${problem}` : 'with no Golden-Reason trailer'}`), sha: sha.trim() });
    }
  }
  return out;
}

/** Every weakening since the base: { base, findings }. */
export async function findWeakenings({ env = process.env } = {}) {
  const { changeBase } = await import('./hook-stamp.mjs');
  // 2.78.2 (B-120 again): the base and key every approve kind uses (approve.mjs judgeBase): with the key from local main
  // (a studio that doesn't push), weakenings are judged since local main, as a lane or train copy judges them.
  let b = null;
  try { b = (await import('./approve.mjs')).judgeBase(env, { exact: true }); } catch { b = null; }
  if (!b) b = await changeBase(env);
  if (!b) return { base: null, findings: [] };
  const names = git(['diff', '--name-status', '-M', '-z', b.base]).stdout.split('\0');
  const pairs = [];
  for (let i = 0; i < names.length; i++) {
    const st = names[i];
    if (!st) continue;
    if (/^[RC]/.test(st)) { pairs.push([names[i + 1], names[i + 2]]); i += 2; } else { pairs.push([names[i + 1]]); i += 1; }
  }
  // 2.58.5 (H-7): read only the files the rules look at (test code and test-runner configs; both names of a rename), not
  // every file under a test folder: fixtures, recordings and binary data there can be huge and are never judged.
  const judged = (f) => (isTestPath(f) && CODE_EXT.test(f)) || isTestConfig(f);
  const files = [];
  for (const pair of pairs) if (pair.some((f) => f && judged(f))) files.push(...pair);
  const wanted = [...new Set(files.filter(Boolean))].filter((f) => isTestPath(f) || isTestConfig(f));
  let parsed = [];
  for (const part of chunks(wanted, 100)) parsed = parsed.concat(parseDiff(git(['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', b.base, '--', ...part.map((f) => `:(literal)${f}`)]).stdout));
  // 2.62.0 (H): the contract rule beside the test rules: an agreed acceptance contract (studio/contracts/*.json) may
  // change only its `passes`; agreements, amendments, criteria in force and manual passes come from the right role.
  const { contractFindings } = await import('./contracts.mjs');
  const findings = [...weakeningsInDiff(parsed), ...goldenWithoutReason(`${b.base}..HEAD`), ...contractFindings({ base: b.base, root: ROOT, git, env })];
  return { base: b, findings };
}

const truthy = (v) => /^(on|1|true|yes)$/i.test(String(v || ''));
const falsy = (v) => /^(off|0|false|no)$/i.test(String(v || ''));

/** The gate: { ok, enforced, off, base, findings (unapproved), approved, why }. */
export async function checkWeakening({ env: envIn = process.env } = {}) {
  // 2.71.1 (A01b): in a lane copy STUDIO_WEAKENED_TESTS=off (and a named base) is ignored, and the result says so.
  const { env, note } = trustedEnv(ROOT, envIn);
  const r = await checkWeakeningWith(env);
  return note ? { ...r, note } : r;
}
async function checkWeakeningWith(env) {
  if (falsy(env.STUDIO_WEAKENED_TESTS)) return { ok: true, off: true, enforced: false, findings: [], why: 'off (STUDIO_WEAKENED_TESTS=off): tests are not checked for weakening' };
  const { base: b, findings } = await findWeakenings({ env });
  if (!b) return { ok: true, enforced: false, findings: [], why: 'no base branch to compare with, so no change to check' };
  const { ownerPublicKey, readApprovals, verifyApproval, enforcingKey, OWNER_PUB_REL, OWNER_KEY_HOWTO } = await import('./approve.mjs');
  // 2.78.2: with the key from local main (judgeBase), enforced only with STUDIO_MAIN_CHECKOUT_ENFORCE=on, as 2.78.1 left it.
  const pub = b.key ? enforcingKey(b, env) : ownerPublicKey(b.base);
  const enforced = truthy(env.STUDIO_WEAKENED_TESTS) || Boolean(pub);
  let approved = [];
  let open = findings;
  if (pub && findings.length) {
    const ok = new Set(readApprovals().filter((a) => a.approval?.kind === 'tests' && verifyApproval(a, pub)).flatMap((a) => (a.approval.findings || []).map((x) => x.id)));
    approved = findings.filter((x) => ok.has(x.id));
    open = findings.filter((x) => !ok.has(x.id));
  }
  // 2.62.0 (H): a changed agreed contract fails with or without an owner key: putting it back needs nobody's approval,
  // and the agreeing roles change a contract by agreeing it again (harness/contracts.mjs).
  const contract = open.filter((x) => String(x.kind).startsWith('contract-'));
  const tests = open.filter((x) => !String(x.kind).startsWith('contract-'));
  const why = open.length
    ? [tests.length ? `${tests.length} weakened test(s) since ${b.ref} without the owner's approval${enforced ? '' : `; a warning only: ${b.ref} has no owner key (${OWNER_PUB_REL}), so nobody can approve them yet (STUDIO_WEAKENED_TESTS=on enforces); ${OWNER_KEY_HOWTO}`}` : '',
      contract.length ? `${contract.length} change(s) to an agreed acceptance contract since ${b.ref} that only passes may make (enforced with or without an owner key)` : ''].filter(Boolean).join('; ')
    : `no weakened test since ${b.ref}${approved.length ? ` (${approved.length} change(s) approved by the owner)` : ''}`;
  return { ok: !contract.length && (!tests.length || !enforced), enforced, base: b.ref, baseSha: b.base, findings: open, approved, why };
}

export const formatFinding = (x) => `  ${x.file}:${x.line}  ${x.kind}  ${x.text}${x.detail ? `  (${x.detail})` : ''}`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  let r;
  try { r = await checkWeakening(); } catch (e) {
    if (process.argv.includes('--json')) console.log(JSON.stringify({ ok: false, error: e.message, findings: [], why: e.message }));
    else console.error(`[tests] FAIL ${e.message}`);
    process.exit(1);
  }
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  if (r.note) console.error(`[tests] note: ${r.note}`);
  if (r.off) { console.log(`[tests] ${r.why}`); process.exit(0); }
  if (!r.ok) {
    console.error(`[tests] FAIL ${r.why}:`);
    console.error(r.findings.map(formatFinding).join('\n'));
    if (r.findings.some((x) => String(x.kind).startsWith('contract-'))) console.error('[tests] A contract finding: put studio/contracts/<ID>.json back as it was agreed (only passes changes; npm run task -- contract <ID> check sets it). A worker proposes a criterion (contract <ID> add) and hands the task back; the Producer, the Director or the owner changes a contract by agreeing it again (contract <ID> agree --by <name> --why "…").');
    console.error('[tests] Put the test back as it was (or make the code pass it). A change the owner wants (an obsolete test, a real tolerance): on the owner\'s machine, npm run approve -- tests --note "why", then commit the approval file. An agent hands the task back with a note instead of approving or working around it. A golden change: commit it with a Golden-Reason trailer.');
    process.exit(1);
  }
  console.log(`[tests] ${r.findings.length ? 'note' : 'PASS'}: ${r.why}`);
  if (r.findings.length) console.log(r.findings.map(formatFinding).join('\n'));
  process.exit(0);
}

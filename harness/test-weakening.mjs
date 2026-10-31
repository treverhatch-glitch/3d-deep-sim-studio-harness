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
 *   only-added          .only / fit / fdescribe (every other test stops running)
 *   timeout-raised      a test timeout raised (same line, bigger number after the word timeout)
 *   tolerance-widened   toBeCloseTo / places / precision / digits lowered; eps, tol, delta, margin, atol, rtol, approx,
 *                       an abs() bound or a 3-argument AreEqual raised (the last number on the same line)
 *   seed-special-case   a condition on a literal seed (`if (seed === 7)`, `[7, 9].includes(seed)`, `switch (seed)`), or
 *                       on a literal tick/frame/step that returns, continues, breaks or skips
 *   test-deleted        a test file deleted (a rename is not a delete)
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
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.STUDIO_PROTECT_ROOT ? path.resolve(process.env.STUDIO_PROTECT_ROOT) : path.resolve(HERE, '..');
const git = (args, input) => spawnSync('git', ['-c', 'core.quotePath=false', '-c', 'diff.noprefix=false', '-c', 'diff.mnemonicPrefix=false', '-c', 'diff.relative=false', ...args], { cwd: ROOT, encoding: 'utf8', input, maxBuffer: 512 * 1024 * 1024 });

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
  /\b(it|test|describe|context|suite|specify|bench)\.(skip|todo|fixme)\b/, /\b(xit|xtest|xdescribe|xcontext|xspecify)\s*\(/,
  /\[\s*(Ignore|Explicit)\b/, /\bSkip\s*=\s*["@$]/, /@Disabled\b/, /@Ignore\b/, /@pytest\.mark\.(skip|skipif|xfail)\b/, /\bpytest\.skip\s*\(/,
  /@unittest\.skip/, /\bself\.skipTest\s*\(/, /\bt\.Skip(f|Now)?\s*\(/, /\bdo_skip\s*:?=\s*true\b/, /[{,]\s*(skip|todo)\s*:\s*true\b/, /#\[ignore\]/,
  /\bmarkTestSkipped\s*\(/, /\bpending\s*\(\s*\)/,
];
const ONLY = [/\b(it|test|describe|context|suite|specify)\.only\b/, /\b(fit|fdescribe|fcontext)\s*\(/];
const SEED = [
  /\bseed\w*\s*(===?|!==?)\s*-?\d/i, /-?\d+\s*(===?|!==?)\s*\w*seed\b/i, /\[[\d,\s]+\]\.includes\(\s*\w*seed/i,
  /\bseed\w*\s+(not\s+)?in\s*[[(]/i, /\bswitch\s*\(\s*\w*seed\w*\s*\)/i, /\bmatch\s+\w*seed\w*\s*:/i,
];
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
    const seedHit = (t) => SEED.some((p) => p.test(t)) || (TICK.test(t) && /\b(return|continue|break|skip\w*)\b/.test(t));
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

/** Golden/snapshot files changed by a commit since the base with no Golden-Reason trailer. */
export function goldenWithoutReason(range) {
  const log = git(['log', '--no-merges', '--no-renames', '--format=%x1e%H%x1f%B%x1f', '--name-status', range]);
  const out = [];
  for (const rec of log.stdout.split('\x1e').filter((s) => s.includes('\x1f'))) {
    const [sha, msg, names] = rec.split('\x1f');
    if (/^Golden-Reason:[ \t]*\S/im.test(msg)) continue;
    for (const l of String(names || '').split('\n')) {
      const [st, file] = l.trim().split('\t');
      if (!file || !/^[MD]/.test(st) || !isGoldenPath(file)) continue;
      const subject = msg.split('\n')[0].trim();
      out.push({ ...finding('golden-edited', file, 1, `${subject} :: ${file}`, `commit ${sha.trim().slice(0, 8)} ${st === 'D' ? 'deletes' : 'changes'} it with no Golden-Reason trailer`), sha: sha.trim() });
    }
  }
  return out;
}

/** Every weakening since the base: { base, findings }. */
export async function findWeakenings({ env = process.env } = {}) {
  const { changeBase } = await import('./hook-stamp.mjs');
  const b = await changeBase(env);
  if (!b) return { base: null, findings: [] };
  const names = git(['diff', '--name-status', '-M', '-z', b.base]).stdout.split('\0');
  const files = [];
  for (let i = 0; i < names.length; i++) {
    const st = names[i];
    if (!st) continue;
    if (/^[RC]/.test(st)) { files.push(names[i + 1], names[i + 2]); i += 2; } else { files.push(names[i + 1]); i += 1; }
  }
  const wanted = [...new Set(files.filter(Boolean))].filter((f) => isTestPath(f) || isTestConfig(f));
  let parsed = [];
  for (const part of chunks(wanted, 100)) parsed = parsed.concat(parseDiff(git(['diff', '-U0', '-M', '--no-color', '--no-ext-diff', '--no-textconv', b.base, '--', ...part.map((f) => `:(literal)${f}`)]).stdout));
  const findings = [...weakeningsInDiff(parsed), ...goldenWithoutReason(`${b.base}..HEAD`)];
  return { base: b, findings };
}

const truthy = (v) => /^(on|1|true|yes)$/i.test(String(v || ''));
const falsy = (v) => /^(off|0|false|no)$/i.test(String(v || ''));

/** The gate: { ok, enforced, off, base, findings (unapproved), approved, why }. */
export async function checkWeakening({ env = process.env } = {}) {
  if (falsy(env.STUDIO_WEAKENED_TESTS)) return { ok: true, off: true, enforced: false, findings: [], why: 'off (STUDIO_WEAKENED_TESTS=off): tests are not checked for weakening' };
  const { base: b, findings } = await findWeakenings({ env });
  if (!b) return { ok: true, enforced: false, findings: [], why: 'no base branch to compare with, so no change to check' };
  const { ownerPublicKey, readApprovals, verifyApproval, OWNER_PUB_REL } = await import('./approve.mjs');
  const pub = ownerPublicKey(b.base);
  const enforced = truthy(env.STUDIO_WEAKENED_TESTS) || Boolean(pub);
  let approved = [];
  let open = findings;
  if (pub && findings.length) {
    const ok = new Set(readApprovals().filter((a) => a.approval?.kind === 'tests' && verifyApproval(a, pub)).flatMap((a) => (a.approval.findings || []).map((x) => x.id)));
    approved = findings.filter((x) => ok.has(x.id));
    open = findings.filter((x) => !ok.has(x.id));
  }
  const why = open.length
    ? `${open.length} weakened test(s) since ${b.ref} without the owner's approval${enforced ? '' : `; a warning only: ${b.ref} has no owner key (${OWNER_PUB_REL}), so nobody can approve them yet (npm run approve -- keygen on the owner's machine; STUDIO_WEAKENED_TESTS=on enforces)`}`
    : `no weakened test since ${b.ref}${approved.length ? ` (${approved.length} change(s) approved by the owner)` : ''}`;
  return { ok: !open.length || !enforced, enforced, base: b.ref, baseSha: b.base, findings: open, approved, why };
}

export const formatFinding = (x) => `  ${x.file}:${x.line}  ${x.kind}  ${x.text}${x.detail ? `  (${x.detail})` : ''}`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const r = await checkWeakening();
  if (process.argv.includes('--json')) { console.log(JSON.stringify(r)); process.exit(r.ok ? 0 : 1); }
  if (r.off) { console.log(`[tests] ${r.why}`); process.exit(0); }
  if (!r.ok) {
    console.error(`[tests] FAIL ${r.why}:`);
    console.error(r.findings.map(formatFinding).join('\n'));
    console.error('[tests] Put the test back as it was (or make the code pass it). A change the owner wants (an obsolete test, a real tolerance): on the owner\'s machine, npm run approve -- tests --note "why", then commit the approval file. An agent hands the task back with a note instead of approving or working around it. A golden change: commit it with a Golden-Reason trailer.');
    process.exit(1);
  }
  console.log(`[tests] ${r.findings.length ? 'note' : 'PASS'}: ${r.why}`);
  if (r.findings.length) console.log(r.findings.map(formatFinding).join('\n'));
  process.exit(0);
}

/**
 * qa/selftest-283i.mjs — 2.83 (i): scorecard fixes, the cut of two unused modules, the studio's own command list.
 *
 *   cpu        the "machine samples under 25% CPU" measure reads the hourly machine.sample.summary events when the single
 *              samples are gone (since 2.80 they are folded), weighted by each summary's count; the summary now carries
 *              the counts (harness/telemetry.mjs, harness/score.mjs)
 *   progress   a studio's own progress command (studio/game.json engines.<x>.progress) prints under the engine block
 *   allowlist  studio/allowlist.json adds to the built-in command list; a malformed file is ignored (harness/allowlist.mjs)
 *   cut        nothing in harness/, scripts/, qa/ or package.json names the two removed modules
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest283I({ dir, root, report, tmpRoot }) {
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const T = path.join(tmpRoot, `s283i-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(dir, `.probe-283i-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: dir, env: { ...process.env, STUDIO_TELEMETRY: '' }, encoding: 'utf8', timeout: 120000 });
    try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{') || x.startsWith('[')).pop();
    try { return JSON.parse(l); } catch { return { _raw: `${r.stdout || ''}${r.stderr || ''}`.slice(-2000) }; }
  };

  // ---- cpu ----
  await guard('2.83: the CPU measure counts the hourly summaries when there are no single samples, weighted by their sample counts, and says how many old summaries it skipped (fails before this fix: "no machine samples", measure n/a)', () => {
    const p = probe(`import { countRest } from ${u('harness/score.mjs')};
const now = Date.parse('2026-11-10T12:00:00Z');
const sum = (h, cpu) => ({ ts: new Date(now - h * 3600000).toISOString(), type: 'machine.sample.summary', meta: { count: cpu ? cpu.n : 12, until: new Date(now - h * 3600000).toISOString(), ...(cpu ? { cpu } : {}) } });
const events = [sum(1, { n: 10, mean: 20, under25: 8, over90: 0 }), sum(2, { n: 30, mean: 50, under25: 10, over90: 3 }), sum(3, null)];
const r = countRest(events, { from: now - 86400000, now });
const none = countRest([sum(3, null)], { from: now - 86400000, now });
const single = countRest([{ ts: new Date(now - 1000).toISOString(), type: 'machine.sample', meta: { cpu: 10 } }, sum(1, { n: 10, mean: 20, under25: 8, over90: 0 })], { from: now - 86400000, now });
console.log(JSON.stringify({ pct: r.rigIdlePct, note: r.notes.rigIdlePct, none: [none.rigIdlePct, none.notes.rigIdlePct], single: single.rigIdlePct }));`);
    return [p.pct === 45 && /40 sample\(s\)/.test(p.note) && /1 older summary without CPU counts skipped/.test(p.note) && p.none?.[0] === null && /skipped/.test(p.none[1]) && p.single === 100, JSON.stringify(p)];
  });
  await guard('2.83: the summary the supervisor writes for machine samples carries cpu { n, mean, under25, over90 } (fails before this fix: only count, since, until, top, last)', () => {
    const p = probe(`import { emitSampled, flushTelemetry } from ${u('harness/telemetry.mjs')};
import fs from 'node:fs';
import path from 'node:path';
fs.rmSync(path.join(process.cwd(), '.studio', 'telemetry'), { recursive: true, force: true });
const got = [];
const now = Date.now();
for (const cpu of [10, 20, 95, 40]) emitSampled({ type: 'machine.sample', agent: 'supervisor', msg: 'x', meta: { cpu } }, 'sample', { now, emit: (e) => got.push(e), env: {} });
flushTelemetry({ now: now + 1000, all: true, emit: (e) => got.push(e) });
console.log(JSON.stringify(got.map((e) => [e.type, e.meta?.cpu || null])));`);
    const s = Array.isArray(p) ? p.find((x) => x[0] === 'machine.sample.summary') : null;
    return [s && s[1]?.n === 4 && s[1].mean === 41.3 && s[1].under25 === 2 && s[1].over90 === 1, JSON.stringify(p)];
  });

  // ---- progress ----
  const mkStudio = (name, engines, files = {}) => { const S = path.join(T, name); write(S, 'studio/game.json', JSON.stringify({ engines })); for (const [f, t] of Object.entries(files)) write(S, f, t); return S; };
  const S1 = mkStudio('progress', {
    two: { progress: 'node -e "console.log(\'  12 of 40 rooms playable\'); console.log(\'second line\')"' },
    bad: { progress: 'node -e "process.exit(1)"' },
    slow: { progress: 'node -e "setTimeout(()=>{},30000)"' },
    where: { cwd: 'eng', progress: 'node -e "console.log(require(\'path\').basename(process.cwd()))"' },
    none: { land: 'x' },
  }, { 'eng/keep.txt': 'x' });
  await guard('2.83: the progress command prints its first non-empty line under the engine block; a command that exits 1 or sleeps past the timeout says "not available" with the reason and never throws; the engine folder is the working folder (fails before this fix: no Progress lines)', async () => {
    const mod = await import(pathToFileURL(path.join(dir, 'harness', 'score.mjs')).href);
    const t0 = Date.now();
    const rows = mod.engineProgress(S1, { timeoutMs: 2000 });
    const took = Date.now() - t0;
    const text = mod.scoreText({ window: { from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z', days: 7, events: 0 }, measures: [], values: {}, notes: {}, engine: null, vision: null, progress: rows }).split('\n');
    const by = Object.fromEntries(rows.map((r) => [r.engine, r]));
    const ok = rows.length === 4 && by.two.line === '12 of 40 rooms playable' && by.bad.line === null && /exit 1/.test(by.bad.why) && by.slow.line === null && /timed out/.test(by.slow.why) && by.where.line === 'eng'
      && text.includes('Progress (two): 12 of 40 rooms playable') && text.some((l) => /^Progress \(bad\): not available \(exit 1\)$/.test(l)) && text.some((l) => /^Progress \(slow\): not available \(timed out/.test(l)) && took < 25000
      && mod.engineProgress(path.join(T, 'no-such-studio')).length === 0;
    return [ok, JSON.stringify({ rows, text, took })];
  });

  // ---- allowlist ----
  const al = async (root2) => { const m = await import(`${pathToFileURL(path.join(dir, 'harness', 'allowlist.mjs')).href}?r=${++pn}`); return m; };
  await guard('2.83: studio/allowlist.json entries are added to the built-in list (and to the --allowedTools patterns), the built-in ALLOWED export is unchanged, and the built-in list alone comes back when the file is missing (fails before this fix: no allowed(root))', async () => {
    const m = await al();
    const S = path.join(T, 'allow-ok');
    write(S, 'studio/allowlist.json', JSON.stringify([['mytool', '/opt/mytool/bin/mytool *'], ['other', 'other --version']]));
    const withFile = m.allowed(S);
    const without = m.allowed(path.join(T, 'allow-none'));
    const tools = m.allowedToolsList({ root: S });
    const note = m.allowedNote(S);
    const ok = withFile.length === m.ALLOWED.length + 2 && withFile.some(([n, p]) => n === 'mytool' && p === '/opt/mytool/bin/mytool *') && without.length === m.ALLOWED.length
      && tools.includes('Bash(/opt/mytool/bin/mytool *)') && tools.includes('Bash(node *)') && /`mytool`/.test(note);
    return [ok, JSON.stringify({ withFile: withFile.length, without: without.length })];
  });
  await guard('2.83: a malformed studio/allowlist.json (not JSON, not an array, a bad pair, a pattern with a newline or over 300 characters, over 50 entries) never crashes and never adds a bad entry', async () => {
    const m = await al();
    const check = (name, text) => { const S = path.join(T, `allow-${name}`); write(S, 'studio/allowlist.json', text); return m.studioAllowed(S); };
    const notJson = check('a', '{ nope');
    const notArray = check('b', '{"x":1}');
    const mixed = check('c', JSON.stringify([['good', 'good *'], ['nl', 'a\nb'], ['long', 'x'.repeat(301)], ['one'], [1, 2], 'str', ['ok300', 'y'.repeat(300)]]));
    const many = check('d', JSON.stringify(Array.from({ length: 60 }, (_, i) => [`t${i}`, `t${i} *`])));
    const ok = notJson.entries.length === 0 && notJson.problems.length === 1 && notArray.entries.length === 0 && notArray.problems.length === 1
      && mixed.entries.map(([n]) => n).join() === 'good,ok300' && mixed.problems.length === 5
      && many.entries.length === 50 && m.allowed(path.join(T, 'allow-a')).length === m.ALLOWED.length;
    return [ok, JSON.stringify({ notJson, notArray, mixed: mixed.problems, many: many.entries.length })];
  });

  // ---- the cut ----
  await guard('2.83: nothing in harness/, scripts/, qa/ or package.json names the two removed modules, and their files are gone (fails before this fix: package.json scripts and tests named them)', () => {
    const names = [['token', 'norms'].join('-'), ['ledger', 'mjs'].join('.')];
    const hits = [];
    const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, e.name); if (e.isDirectory()) { if (e.name !== 'node_modules') walk(p); } else if (/\.(mjs|js|json|sh)$/.test(e.name) && e.name !== 'selftest-283i.mjs') { const t = fs.readFileSync(p, 'utf8'); for (const n of names) if (t.includes(n)) hits.push(`${path.relative(dir, p)}: ${n}`); } } };
    for (const d of ['harness', 'scripts', 'qa']) walk(path.join(dir, d));
    for (const n of names) if (fs.readFileSync(path.join(dir, 'package.json'), 'utf8').includes(n)) hits.push(`package.json: ${n}`);
    const gone = !fs.existsSync(path.join(dir, 'harness', names[0] + '.mjs')) && !fs.existsSync(path.join(dir, 'harness', names[1]));
    return [hits.length === 0 && gone, hits.join('\n')];
  });

  try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* best effort */ }
}

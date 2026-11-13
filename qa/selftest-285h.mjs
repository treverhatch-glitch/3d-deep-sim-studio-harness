/**
 * qa/selftest-285h.mjs — 2.85 (h): less that nobody uses.
 *
 *   settings  a STUDIO_* name documented or used in a test that no production code reads fails the docs check
 *             (scripts/settings-map.mjs unreadNames, docs/settings-runtime.json lists the run-time families); the
 *             two names nothing read are gone
 *   events    (a crew's log: hotspot.overlap, task.overlap and watch.report were an eighth of all events)
 *   decider   (who may decide: the callers' answers pinned)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285H({ dir, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const T = path.join(tmpRoot, `s285h-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);

  // ================= 1. settings nothing reads =================
  // Invented names are spelled @NAME@ here and become the real name when written, so this file adds none to the settings scan.
  const nm = (t) => String(t).replace(/@([A-Z0-9_]+)@/g, 'STUDIO_$1');
  {
    const sm = await imp('scripts/settings-map.mjs');
    let n = 0;
    // A small studio: one production file that reads @LIVE_ONE@ and builds STUDIO_<ROLE>_CMD, docs, a test.
    const mini = ({ doc = '', test = '', runtime }) => {
      const R = path.join(T, `mini-${++n}`);
      write(R, 'harness/a.mjs', nm("// @ONLY_COMMENT@ is named here only\nexport const r = (e, role) => [e.@LIVE_ONE@, e[`STUDIO_${role.toUpperCase()}_CMD`]];\n"));
      write(R, 'docs/A.md', nm(`# A\n\`@LIVE_ONE@\` does a thing (default off).\n${doc}\n`));
      write(R, 'qa/selftest-x.mjs', nm(`const env = { @LIVE_ONE@: '1'${test} };\n`));
      write(R, 'docs/settings-runtime.json', nm(JSON.stringify(runtime || { families: [{ pattern: '^STUDIO_(BUILDER|QA)_CMD$', template: 'STUDIO_\\$\\{role\\.toUpperCase\\(\\)\\}_CMD' }], testOwned: [] })));
      write(R, 'docs/settings-baseline.json', JSON.stringify({ undocumented: [] }));
      return R;
    };
    const unread = (R) => sm.unreadNames(R).unread.map((u) => u.name);
    await guard('settings: a name only a doc mentions, and one only a test sets, fail the check; fails before this change: nothing asked whether a name is read', async () => {
      const R = mini({ doc: '`@DOC_ONLY@` was once a switch.', test: ", @TEST_ONLY@: '1'" });
      const u = unread(R);
      const c = sm.checkSettings(R);
      return [u.includes(nm('@DOC_ONLY@')) && u.includes(nm('@TEST_ONLY@')) && !c.ok && sm.checkLines(c).join('\n').includes(nm('@DOC_ONLY@')), JSON.stringify({ u, ok: c.ok })];
    });
    await guard('settings: a name production code reads and a run-time family pass; a name only in a comment does not', async () => {
      const R = mini({ doc: '`@ONLY_COMMENT@` is a setting. `@QA_CMD@` is the QA command.', test: ", @BUILDER_CMD@: 'x'" });
      const u = unread(R);
      return [!u.includes(nm('@LIVE_ONE@')) && !u.includes(nm('@QA_CMD@')) && !u.includes(nm('@BUILDER_CMD@')) && u.includes(nm('@ONLY_COMMENT@')), JSON.stringify(u)];
    });
    await guard('settings: a name outside every family is not hidden by one (a sound-designer command against a BUILDER|QA family)', async () => {
      const R = mini({ doc: '`@SOUND_CMD@` runs it.' });
      return [unread(R).includes(nm('@SOUND_CMD@')), JSON.stringify(unread(R))];
    });
    await guard('settings: a family whose builder is gone from production code is stale and fails; a test-owned name passes', async () => {
      const R = mini({ test: ", @MADE_UP@: '1'", runtime: { families: [{ pattern: '^@GONE@_[A-Z]+$', template: '@GONE@_\\$\\{' }], testOwned: [{ name: nm('@MADE_UP@'), why: 'a fixture' }] } });
      const r = sm.unreadNames(R);
      const c = sm.checkSettings(R);
      return [r.staleFamilies.length === 1 && !c.ok && !r.unread.some((x) => x.name === nm('@MADE_UP@')) && sm.checkLines(c).join('\n').includes('builder is gone'), JSON.stringify(r)];
    });
    await guard('settings: the docs check passes on this studio, and the two names nothing read (the old Planning Room switch, the engine VFX capture command) are gone from docs, code and tests', async () => {
      const r = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { windowsHide: true, cwd: dir, encoding: 'utf8' });
      const gone = [nm('@PLANNING_ROOM@'), nm('@VFX_CAPTURE_CMD@')];
      const left = spawnSync(process.execPath, ['-e', `const {scanCode,scanDocs}=await import('./scripts/settings-map.mjs');const c=scanCode('.'),d=scanDocs('.');console.log(${JSON.stringify(gone)}.filter((x)=>c.has(x)||d.has(x)).join(','))`], { windowsHide: true, cwd: dir, encoding: 'utf8' });
      return [r.status === 0 && /\[docs\] PASS/.test(out(r)) && !String(left.stdout).trim(), out(r).slice(-1200) + String(left.stdout)];
    });
  }

  // ================= 2. events nobody acts on =================
  // Evidence (the crew's 2.84 window, 2598 events): the three types are read (retro counts watch.report and reads its words;
  // plan-waves and the next board need one hotspot.overlap / task.overlap per fact), so they stay. hotspot.overlap and
  // task.overlap are already written once per fact (emit-seen.json); watch.report kept ONE slot for every text, so two
  // findings taking turns were each "new" every pass.
  {
    const wt = await imp('harness/watch.mjs');
    const seenFile = path.join(dir, '.studio', 'emit-seen.json');
    const fresh = () => { try { fs.rmSync(seenFile, { force: true }); } catch { /* none */ } };
    const MIN = 60000;
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    const run = (texts) => { const got = []; for (const [text, min, env] of texts) wt.recordReport(text, { now: t0 + min * MIN, emit: (e) => got.push(e.msg), env: { ...process.env, STUDIO_TELEMETRY: '', ...(env || {}) } }); return got; };
    await guard('events: the same watch.report text again within the hour (only its numbers changed) is written once; fails before this fix: one record per pass of two alternating texts', async () => {
      fresh();
      const got = run([['T-1 is held: parked 3 times', 0], ['T-1 is held: parked 4 times', 5], ['T-1 is held: parked 5 times', 12]]);
      return [got.length === 1, JSON.stringify(got)];
    });
    await guard('events: two findings taking turns (A, B, A, B inside the hour) are written once each, not four times', async () => {
      fresh();
      const A = 'T-1 is held: parked by watchdog'; const B = 'T-2 is held: queued for the train';
      const got = run([[A, 0], [B, 5], [A, 10], [B, 15], [A, 20]]);
      return [got.length === 2 && got[0] === A && got[1] === B, JSON.stringify(got)];
    });
    await guard('events: a changed watch.report text is written, and the same text again after the hour is written again', async () => {
      fresh();
      const got = run([['one finding', 0], ['another finding', 1], ['one finding', 61]]);
      return [got.length === 3, JSON.stringify(got)];
    });
    await guard('events: STUDIO_EVENT_REPEAT_MIN sets how long a text is not written again (5 minutes: written again at 6)', async () => {
      fresh();
      const env = { STUDIO_EVENT_REPEAT_MIN: '5' };
      const got = run([['standing', 0, env], ['standing', 4, env], ['standing', 6, env]]);
      return [got.length === 2, JSON.stringify(got)];
    });
    await guard('events: watch.mjs writes the standing report through recordReport, never straight to the log', async () => {
      const src = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8').replace(/\r\n/g, '\n');
      return [/recordReport\(wmsg\)/.test(src) && !/emitEvent\(\{ type: 'watch\.report'/.test(src), 'watch.mjs'];
    });
    fresh();
  }
}

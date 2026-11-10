/**
 * qa/selftest-277w.mjs — 2.77.0 (helper w): the War Room as a field terminal, the Train Room's loom and real loading bar,
 * and the hub pages that were cut.
 *   progress   harness/gate-progress.mjs: a run's progress (gates finished of the run's gates, the running one) and the
 *              ETA from recorded gate times (median of each gate still to run, plus what is left of the running one),
 *              marked an estimate under 3 recorded runs; the history keeps the last 10 passing, not cached, runs
 *   run-gates  a real verify writes .studio/gates/progress/<owner>.json as it goes (the train's runs as train-<id>) and
 *              adds its passing gate times to .studio/gates/gate-times.json
 *   (2.80: the War Room's train bar, cut pages, look, rail yard, folds, bars and beta card went with the War Room)
 * Each check fails on 2.76.0 (none of this exists there, or those pages still answer).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest277W({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction'); } catch {}
  }
  void run;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WATCH_INTERVAL: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '',
    STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_COMPACT_OUTPUT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', NODE_OPTIONS: '',
    STUDIO_MACHINE_SCAN: 'off', HUB_TOKEN: '', HUB_HOST: '', STUDIO_HEAVY_SLOTS: '0', ...ident,
  };
  const made = [];
  const nm = path.join(dir, 'node_modules');
  const studio = (name) => {
    const S = path.join(tmpRoot, `277w-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/locks', '.studio/train', '.studio/gates', '.studio/supervisor.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-277w.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']); g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { ...process.env, ...base, AGENT_EVENTS_FILE: ev } };
  };
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const read = (f) => { try { return fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n'); } catch { return ''; } };

  try {
    // ---- the progress module ----
    {
      const { S } = studio('progress');
      const st = path.join(S, '.studio');
      let mod = null;
      try { mod = await import(pathToFileURL(path.join(S, 'harness', 'gate-progress.mjs')).href); } catch (e) { mod = { error: e }; }
      await guard('277w progress: gates finished of the run\'s gates, the running one, and an ETA from recorded runs (median per gate, minus what the running one has done), an estimate under 3 runs (fails on 2.76.0: no harness/gate-progress.mjs)', () => {
        if (mod.error) return [false, String(mod.error)];
        const t0 = Date.parse('2026-11-04T10:00:00Z');
        const pr = mod.startProgress({ stateDir: st, owner: 'train-tr-x', gates: ['a', 'b', 'c', 'd'], now: t0 });
        pr.started('a', t0); pr.finished('a', { ms: 1000, ok: true });
        pr.started('b', t0 + 1000); pr.finished('b', { ms: 2000, ok: false });
        pr.started('c', t0 + 3000);
        const times = { a: [1000, 1000, 1000], b: [2000, 2000, 2000], c: [60000, 70000, 80000], d: [10000, 20000] };
        const p = mod.progressOf(st, 'train-tr-x', { now: t0 + 3000 + 30000, times });
        const noHist = mod.progressOf(st, 'train-tr-x', { now: t0 + 3000 + 30000, times: { c: [1] } });
        return [p && p.percent === 50 && p.done === 2 && p.total === 4 && p.step === 'c' && p.etaMs === (70000 - 30000) + 15000 && p.estimate === true && /fewer than 3 recorded runs of d/.test(p.why) && p.failed.join() === 'b'
          && noHist.etaMs === null && /no recorded run yet of d/.test(noHist.why) && mod.progressOf(st, 'nobody') === null, JSON.stringify({ p, noHist })];
      });
      await guard('277w progress: the gate history keeps each gate\'s last 10 passing runs; a cached row or a red one adds nothing (fails on 2.76.0)', () => {
        if (mod.error) return [false, String(mod.error)];
        for (let i = 1; i <= 12; i++) mod.recordGateTimes(st, [{ id: 'a', ok: true, ms: i * 100 }, { id: 'b', ok: false, ms: 5 }, { id: 'c', ok: true, cached: true, ms: 9 }]);
        const t = JSON.parse(read(mod.timesFile(st)) || '{}');
        return [Array.isArray(t.a) && t.a.length === 10 && t.a[0] === 300 && t.a[9] === 1200 && !t.b && !t.c, JSON.stringify(t)];
      });
    }

    // ---- a real verify writes them ----
    {
      const { S, env } = studio('rungates');
      const r = spawnSync(process.execPath, ['scripts/run-gates.mjs', '--only', 'purity,isolation'], { cwd: S, env: { ...env, STUDIO_LOCK_OWNER: 'train-tr-y' }, encoding: 'utf8', windowsHide: true, timeout: 240000 });
      const p = JSON.parse(read(path.join(S, '.studio', 'gates', 'progress', 'train-tr-y.json')) || 'null');
      const t = JSON.parse(read(path.join(S, '.studio', 'gates', 'gate-times.json')) || 'null');
      await guard('277w run-gates: a verify writes its live progress (as its STUDIO_LOCK_OWNER: the train\'s train-<id>) and adds its passing gate times to the history (fails on 2.76.0: neither file)', () => [
        r.status === 0 && p && p.gates.join() === 'purity,isolation' && p.done.length === 2 && p.done.every((d) => d.ok && Number.isFinite(d.ms)) && p.endedAt && p.current === null && t && t.purity?.length === 1 && t.isolation?.length === 1,
        `${r.status} ${String(r.stdout).slice(-400)}${String(r.stderr).slice(-400)}\nprogress ${JSON.stringify(p)}\ntimes ${JSON.stringify(t)}`]);
    }
    // 2.80: the War Room's train bar, the hub's pages, the page's look, folds, bars and beta card went with the War Room.
  } finally {
    await sleep(300);
    for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  }
}

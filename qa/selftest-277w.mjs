/**
 * qa/selftest-277w.mjs — 2.77.0 (helper w): the War Room as a field terminal, the Train Room's loom and real loading bar,
 * and the hub pages that were cut.
 *   progress   harness/gate-progress.mjs: a run's progress (gates finished of the run's gates, the running one) and the
 *              ETA from recorded gate times (median of each gate still to run, plus what is left of the running one),
 *              marked an estimate under 3 recorded runs; the history keeps the last 10 passing, not cached, runs
 *   run-gates  a real verify writes .studio/gates/progress/<owner>.json as it goes (the train's runs as train-<id>) and
 *              adds its passing gate times to .studio/gates/gate-times.json
 *   train      the War Room's running train carries that bar (harness/war-room.mjs)
 *   pages      the hub no longer serves the retired React War Room (/legacy), its source files or /human; / still works
 *   look       dark always (no light theme from the system; a light screen only by the person's button, in every view's
 *              header), the loom and the bar in the Train Room, the bursts and the bigger Studio floor
 *   rail yard  (round 2) the Studio floor's Rail Yard as a small loom with the same real bar, no brick railway
 *   folds      (round 2) the Control room's lower sections folded, closed by default, remembered per browser
 *   bars       (round 2) the floor's bottom bar and the Live badge sit in the page, over nothing
 *   beta       (round 2) beta mode (studio/beta.json) on the owner-proxy card
 * Each check fails on 2.76.0 (none of this exists there, or those pages still answer).
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import net from 'node:net';
import { spawn, spawnSync } from 'node:child_process';
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
  const kids = [];
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
  const freePort = () => new Promise((resolve) => { const s = net.createServer().listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); }); });
  const status = (port, p) => new Promise((resolve) => { http.get({ host: '127.0.0.1', port, path: p }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode)); }).on('error', () => resolve(0)); });
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

    // ---- the War Room's train carries the bar; the hub's cut pages; the page's look ----
    {
      const { S, ev, env } = studio('room');
      const now = Date.now();
      const st = path.join(S, '.studio');
      fs.mkdirSync(path.join(st, 'locks'), { recursive: true });
      fs.writeFileSync(path.join(st, 'locks', 'train.lock'), JSON.stringify({ pid: process.pid, at: now - 600000, id: 'tr-z', by: 'train-daemon' }));
      fs.mkdirSync(path.join(st, 'train', 'tr-z'), { recursive: true });
      fs.writeFileSync(path.join(st, 'train', 'tr-z', 'status.json'), JSON.stringify({ train: 'tr-z', step: 'verify', text: 'verify 1', lanes: 2 }));
      fs.mkdirSync(path.join(st, 'gates', 'progress'), { recursive: true });
      fs.writeFileSync(path.join(st, 'gates', 'progress', 'train-tr-z.json'), JSON.stringify({ owner: 'train-tr-z', startedAt: new Date(now - 60000).toISOString(), gates: ['a', 'b', 'c'], done: [{ id: 'a', ms: 1000, ok: true }], current: { id: 'b', startedAt: new Date(now - 5000).toISOString() }, endedAt: null }));
      fs.writeFileSync(path.join(st, 'gates', 'gate-times.json'), JSON.stringify({ b: [20000, 20000, 20000], c: [30000, 30000, 30000] }));
      fs.appendFileSync(ev, `${JSON.stringify({ ts: new Date(now - 590000).toISOString(), type: 'task.train.start', agent: 'train-daemon', meta: { train: 'tr-z', lanes: ['T-1', 'T-2'] } })}\n`);
      const probe = spawnSync(process.execPath, ['--input-type=module', '-e', "const w = await import('./harness/war-room.mjs'); const s = await w.warRoomState({ launched: [], agents: [], queue: { inProgress: [], backlog: [], done: [] } }); console.log(JSON.stringify((s.trains || []).find((t) => t.kind === 'web')?.bar || null));"], { cwd: S, env, encoding: 'utf8', windowsHide: true });
      let bar = null;
      try { bar = JSON.parse(String(probe.stdout).trim().split('\n').pop()); } catch {}
      await guard('277w train: the War Room\'s running train carries its verify\'s bar (1 of 3 checks, now b, an ETA from the history, not an estimate with 3 runs each) (fails on 2.76.0: no bar)', () => [
        bar && bar.percent === 33 && bar.done === 1 && bar.total === 3 && bar.step === 'b' && bar.estimate === false && bar.etaMs > 40000 && bar.etaMs <= 45000, `${probe.stderr.slice(-500)}\n${JSON.stringify(bar)}`]);
      const port = await freePort();
      const h = spawn(process.execPath, ['hub/server.mjs'], { cwd: S, env: { ...env, HUB_PORT: String(port) }, stdio: 'ignore', windowsHide: true });
      kids.push(h);
      let home = 0;
      for (let i = 0; i < 100 && home !== 200; i++) { home = await status(port, '/'); if (home !== 200) await sleep(150); }
      const cut = { legacy: await status(port, '/legacy'), tsx: await status(port, '/WarRoom.tsx'), human: await status(port, '/human'), page: await status(port, '/human.html') };
      await guard('277w pages: the retired React War Room (/legacy), its source files and /human are cut (404); the War Room (/) still answers (fails on 2.76.0: they answered 200)', () => [
        home === 200 && cut.legacy === 404 && cut.tsx === 404 && cut.human === 404 && cut.page === 404 && !fs.existsSync(path.join(S, 'hub', 'human.html')), JSON.stringify({ home, ...cut })]);
      h.kill();
      const page = read(path.join(S, 'hub', 'v3', 'index.html'));
      await guard('277w look: dark always: <html data-theme="dark">, no light theme from the system, the light set only under data-theme="light", a screen switch in all six headers (fails on 2.76.0: light followed the system)', () => [
        /<html lang="en" data-theme="dark">/.test(page) && !/prefers-color-scheme/.test(page) && /html\[data-theme="light"\] \{\s*--ds-bg:/.test(page) && (page.match(/<button type="button" class="themebtn" data-themebtn/g) || []).length === 6 && /store\.set\('hudTheme', t\)/.test(page),
        `prefers-color-scheme ${/prefers-color-scheme/.test(page)}; theme buttons ${(page.match(/class="themebtn"/g) || []).length}`]);
      await guard('277w look: the Train Room draws the loom and the verify bar, a landed task bursts out of its room, and the Studio floor is drawn larger on wide screens (fails on 2.76.0)', () => [
        /<svg class="loom"/.test(page) && /function verifyBar\(bar\)/.test(page) && /role="progressbar"/.test(page) && /function roomBurst\(roomId, text\)/.test(page) && /#tycoon \.office \{ zoom: 1\.3; \}/.test(page),
        'loom, verifyBar, roomBurst or the zoom missing']);
      // round 2: the Rail Yard is a small loom with the real bar; the Control room folds; the bars cover nothing
      const css = [...page.matchAll(/<style>([\s\S]*?)<\/style>/g)].map((m) => m[1]).join('\n');
      await guard('277w rail yard: the Studio floor\'s Rail Yard is a loom chamber (function miniLoom: main, waiting spools, the lanes as threads by state) with the verify\'s real bar under it, two columns wide; the brick railway is gone (fails on 2.76.0: cars on a brick wall)', () => [
        /function miniLoom\(web\)/.test(page) && /data-dyn="rloom"/.test(page) && /class="rbar"/.test(page) && /class="spool \$\{w\.held \? 'held' : 'queued'\}"/.test(page) && /class="thr \$\{esc\(l\.state\)\}"/.test(page) && /aria-valuenow="\$\{bar\.percent\}"/.test(page) && /\(estimate\)/.test(page)
          && /\.room\.r-rails \{ grid-column: span 2; \}/.test(css) && !/wl-brick fl-concrete r-rails/.test(page) && !/data-dyn="yard"/.test(page),
        `miniLoom ${/function miniLoom/.test(page)}; brick ${/wl-brick fl-concrete r-rails/.test(page)}; yard ${/data-dyn="yard"/.test(page)}`]);
      const folds = page.match(/<details class="fold" data-fold="[a-z]+"/g) || [];
      const row = (page.match(/<div class="foldrow"[\s\S]*?\n {2}<\/div>/) || [''])[0];
      await guard('277w folds: the Control room\'s lower sections are folds, closed by default (no open attribute), in one row under the columns, each remembered per browser through the try/catch store (fails on 2.76.0: no folds)', () => [
        folds.length >= 12 && (row.match(/<details class="fold"/g) || []).length === folds.length && !/<details class="fold"[^>]*\bopen\b/.test(page) && /store\.set\(k, d\.open \? 'open' : 'closed'\)/.test(page) && /hudFold:/.test(page) && /\.foldsec:has\(> details\[open\]\) \{ grid-column: 1 \/ -1; \}/.test(css)
          && ['o-hold', 'o-trains', 'o-clock', 'o-machine', 'o-proxy', 'o-agents'].every((id) => !row.includes(`id="${id}"`)),
        `folds ${folds.length}, in the row ${(row.match(/<details class="fold"/g) || []).length}`]);
      await guard('277w bars: the Studio floor\'s "Game in development" bar is not fixed or sticky over the rooms, and the Live badge moves into the current view\'s header (fails on 2.76.0: both sat over the page)', () => [
        /html body #tycoon \.dock \{ position: static; \}/.test(css) && /html body \.live \{ position: static;/.test(css) && /const placeLive = \(s\) =>/.test(page) && /const setSkin = \(s\) => \{ if \(!document\.getElementById\(s\)\) return; placeLive\(s\);/.test(page),
        `dock static ${/#tycoon \.dock \{ position: static; \}/.test(css)}; placeLive ${/placeLive/.test(page)}`]);
      // beta mode on the owner-proxy card: committed studio/beta.json on, read through harness/beta-mode.mjs
      fs.writeFileSync(path.join(S, 'studio', 'beta.json'), JSON.stringify({ on: true, by: 'owner-z', at: new Date(now - 3600000).toISOString(), why: 'harness build', agents: ['orch-z'] }, null, 2));
      g(S, ['add', 'studio/beta.json']); g(S, ['commit', '-qm', 'beta on', '--no-verify']);
      const bp = spawnSync(process.execPath, ['--input-type=module', '-e', "const w = await import('./harness/war-room.mjs'); const s = await w.warRoomState({ launched: [], agents: [], queue: { inProgress: [], backlog: [], done: [] } }); console.log(JSON.stringify(s.ownerProxy?.beta ?? null));"], { cwd: S, env, encoding: 'utf8', windowsHide: true });
      let beta = null;
      try { beta = JSON.parse(String(bp.stdout).trim().split('\n').pop()); } catch {}
      await guard('277w beta: the War Room\'s owner proxy carries beta mode (on, who, since, the agents) from studio/beta.json, and the card prints it (fails on 2.76.0: no beta on the card)', () => [
        beta && beta.on === true && beta.by === 'owner-z' && Number.isFinite(Date.parse(beta.at)) && beta.agents.join() === 'orch-z' && /Beta mode \$\{bt\.on \? 'on' : 'off'\}/.test(page) && /set by \$\{esc\(bt\.by \|\| '\?'\)\} since/.test(page),
        `${String(bp.stderr).slice(-400)}\n${JSON.stringify(beta)}`]);
    }
  } finally {
    for (const k of kids) { try { k.kill(); } catch {} }
    await sleep(300);
    for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch {} }
  }
}

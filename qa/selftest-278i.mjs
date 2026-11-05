/**
 * qa/selftest-278i.mjs — 2.78.0 (C2c): the flake triager's quiet re-run holds other heavy work back while it runs.
 *   The crew: "the alone re-run isn't alone if another verify is on the same port: PU-56 should also hold other
 *   verifies, not just wait for low CPU." PU-56's quiet re-run waited for the machine to be quiet, but a builder's verify
 *   could start the moment it began (and collide on a fixed test port, or load the machine again). Now, from the start
 *   of the quiet wait to the end of the re-run, a hold marker (.studio/locks/machine-heavy-quiet-hold-<pid>.json) keeps
 *   new non-landing heavy work (builder and lane verifies) waiting in the heavy queue, as for M6's train priority.
 *   It is bounded (STUDIO_FLAKE_HOLD_MIN, default the quiet wait + STUDIO_FLAKE_WAIT_MIN + the game check's timeout),
 *   released when the re-run ends, and ignored (removed) once past its bound or when its train's process is gone.
 *   (a) a live hold: a builder's verify doesn't take a free slot (it waits, naming the quiet re-run), a landing check
 *       takes one and the hold stays; once cleared, the builder takes a slot
 *   (b) a stale hold (past its bound, or its process gone) blocks nobody and is removed
 *   (c) the bound: STUDIO_FLAKE_HOLD_MIN, its default, and off
 *   (d) the train: flakeTriage holds during the quiet re-run only (not the first alone run) and releases it after
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest278I({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  void run; void harnessRoot;
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  // A person's terminal: no agent markers, no studio settings from the runner's own shell.
  const clean = {};
  for (const k of Object.keys(process.env)) if (!/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT)/i.test(k)) clean[k] = process.env[k];
  const base = { ...clean, STUDIO_WATCHDOG: 'off', STUDIO_MACHINE_SCAN: 'off', STUDIO_RAM_FLOOR_GB: '0', STUDIO_HEAVY_SLOTS: '2', STUDIO_HEAVY_WAIT_MIN: '0.03', STUDIO_HEAVY_POLL_MS: '100', STUDIO_GATE_SLOTS: '0', STUDIO_VERIFY_DETACH: 'off', CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '' };
  let n = 0;
  const made = [];
  const fixture = (name) => { const S = path.join(tmpRoot, `278i-${name}-${process.pid}-${++n}`); fs.mkdirSync(path.join(S, '.studio', 'locks'), { recursive: true }); made.push(S); return S; };
  const probe = (S, code, env = {}) => {
    const f = path.join(S, `.probe-278i-${++n}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...base, ...env }, encoding: 'utf8', timeout: 90000 });
    const text = `${r.stdout || ''}${r.stderr || ''}`;
    let j = null;
    try { j = JSON.parse((r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop()); } catch {}
    return { j, text };
  };
  const F = 'game/demo/tests/a.test.mjs';

  await guard('2.78.0 (C2c): while a quiet re-run holds the machine (its hold marker is live), a builder\'s verify doesn\'t take a free slot (HEAVY_BUSY, naming the quiet re-run and STUDIO_FLAKE_HOLD_MIN), a landing check takes one and the hold stays (unlike M6\'s marker), and once the hold is cleared the builder takes a slot (fails on 2.78.0 before C2c: no hold, the builder took the slot at once)', async () => {
    const S = fixture('hold');
    const p = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import * as H from ${u('harness/heavy.mjs')};
const root = process.cwd();
const r = {};
r.marked = Boolean(H.markQuietHold(root, { ms: 120000, owner: 'train-x1-flake', train: 'x1', file: ${JSON.stringify(F)} }));
r.files = fs.readdirSync(path.join(root, '.studio', 'locks')).filter((f) => /quiet-hold/.test(f));
try { const lk = H.acquireHeavy(root, 'builder verify', { kind: 'verify', env: { ...process.env, STUDIO_GATE_PRIORITY: '' } }); r.builder = 'took it'; lk.release(); } catch (e) { r.builder = e.code || e.message; r.builderMsg = e.message; }
try { const lk = H.acquireHeavy(root, 'train flake check', { kind: 'verify', owner: 'train-x1-flake', env: { ...process.env, STUDIO_GATE_PRIORITY: 'landing', STUDIO_LOCK_OWNER: 'train-x1-flake' } }); r.landing = 'took it'; lk.release(); } catch (e) { r.landing = e.code || e.message; }
r.holdAfterLanding = Boolean(H.quietHolding(root));
H.clearQuietHold(root);
H.clearTrainWait(root); // the train check's release left M6's 15 s hand-off for its next check: not this test's subject
r.left =fs.readdirSync(path.join(root, '.studio', 'locks')).filter((f) => /quiet-hold/.test(f));
try { const lk = H.acquireHeavy(root, 'builder verify', { kind: 'verify', env: { ...process.env, STUDIO_GATE_PRIORITY: '' } }); r.builder2 = 'took it'; lk.release(); } catch (e) { r.builder2 = e.code || e.message; }
console.log(JSON.stringify(r));
`);
    const r = p.j || {};
    const ok = r.marked === true && r.files?.length === 1 && r.builder === 'HEAVY_BUSY' && /quiet re-run/.test(r.builderMsg || '') && /STUDIO_FLAKE_HOLD_MIN/.test(r.builderMsg || '') && /a\.test\.mjs/.test(r.builderMsg || '')
      && r.landing === 'took it' && r.holdAfterLanding === true && r.left?.length === 0 && r.builder2 === 'took it';
    return [ok, p.j ? JSON.stringify(r).slice(0, 1500) : p.text.slice(-1200)];
  });

  await guard('2.78.0 (C2c): a hold never blocks forever: a live hand-written hold blocks a builder, but one past its bound ("until") or whose train process is gone is ignored and removed, and the builder takes a slot (fails on 2.78.0 before C2c: the live hold blocked nobody)', async () => {
    const S = fixture('stale');
    const dead = spawnSync(process.execPath, ['-e', ''], { windowsHide: true }).pid;
    const p = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import * as H from ${u('harness/heavy.mjs')};
const root = process.cwd();
const locks = path.join(root, '.studio', 'locks');
const now = Date.now();
const put = (pid, rec) => fs.writeFileSync(path.join(locks, 'machine-heavy-quiet-hold-' + pid + '.json'), JSON.stringify({ pid, at: now, file: ${JSON.stringify(F)}, owner: 'train-x2-flake', ...rec }));
const take = () => { try { const lk = H.acquireHeavy(root, 'builder verify', { kind: 'verify', env: { ...process.env, STUDIO_GATE_PRIORITY: '' } }); lk.release(); return 'took it'; } catch (e) { return e.code || e.message; } };
const r = {};
put(process.pid, { until: now + 120000 });
r.live = take();
fs.rmSync(path.join(locks, 'machine-heavy-quiet-hold-' + process.pid + '.json'), { force: true });
put(process.pid, { until: now - 1000 });
put(${dead}, { until: now + 120000 });
r.stale = take();
r.left = fs.readdirSync(locks).filter((f) => /quiet-hold/.test(f));
console.log(JSON.stringify(r));
`);
    const r = p.j || {};
    return [r.live === 'HEAVY_BUSY' && r.stale === 'took it' && Array.isArray(r.left) && r.left.length === 0, p.j ? JSON.stringify({ ...r, dead }) : p.text.slice(-1200)];
  });

  await guard('2.78.0 (C2c): the hold\'s bound is STUDIO_FLAKE_HOLD_MIN; its default is the quiet wait + STUDIO_FLAKE_WAIT_MIN + the game check\'s own timeout (10 + 10 + 10 = 30 min; 3 + 2 + 2 = 7 with those set); off or 0 holds nothing (markQuietHold writes no marker) (fails on 2.78.0 before C2c: no such setting)', async () => {
    const { flakeHoldMin } = await import(pathToFileURL(path.join(dir, 'harness', 'flakes.mjs')).href);
    const H = await import(pathToFileURL(path.join(dir, 'harness', 'heavy.mjs')).href);
    const S = fixture('bound');
    const d = flakeHoldMin({});
    const set = flakeHoldMin({ STUDIO_FLAKE_QUIET_WAIT_MIN: '3', STUDIO_FLAKE_WAIT_MIN: '2', STUDIO_GAME_GATE_TIMEOUT_MS: '120000' });
    const own = flakeHoldMin({ STUDIO_FLAKE_HOLD_MIN: '4' });
    const offv = flakeHoldMin({ STUDIO_FLAKE_HOLD_MIN: 'off' });
    const zero = flakeHoldMin({ STUDIO_FLAKE_HOLD_MIN: '0' });
    const none = H.markQuietHold(S, { ms: 0, file: F });
    const left = fs.readdirSync(path.join(S, '.studio', 'locks')).filter((f) => /quiet-hold/.test(f));
    return [d === 30 && set === 7 && own === 4 && offv === 0 && zero === 0 && none === null && left.length === 0, JSON.stringify({ d, set, own, offv, zero, none, left })];
  });

  await guard('2.78.0 (C2c): the train\'s flake triage holds other heavy work back during the quiet re-run only: the first alone run sees no hold, the quiet low-load re-run sees its train\'s hold, the file is labelled load-sensitive, the log names STUDIO_FLAKE_HOLD_MIN, and no hold is left after (fails on 2.78.0 before C2c: the quiet re-run ran with no hold)', async () => {
    const S = fixture('train');
    const D = path.join(S, 'copy');
    const seen = path.join(S, 'seen.log');
    writeIn(D, 'scripts/run-gates.mjs', [
      "import fs from 'node:fs'; import path from 'node:path';",
      "const locks = path.join(process.env.STUDIO_MAIN_ROOT, '.studio', 'locks');",
      "let hold = []; try { hold = fs.readdirSync(locks).filter((f) => /^machine-heavy-quiet-hold-\\d+\\.json$/.test(f)); } catch {}",
      "const low = process.env.STUDIO_TEST_WORKERS === '1';",
      "fs.appendFileSync(process.env.SEEN_LOG, JSON.stringify({ low, hold: hold.length }) + '\\n');",
      "if (low) { console.log('[gates] PASS game'); process.exit(0); }",
      "console.log('[game-gates] FAIL game:unit: exit 1'); console.log('[gates] FAIL game'); process.exit(1);", ''].join('\n'));
    const text = `[gates] FAIL game\n[game-gates] FAIL game:unit: exit 1\n[game-gates] failing test files in game:unit: ["${F}"]\n`;
    const p = probe(S, `import fs from 'node:fs'; import path from 'node:path';
import { flakeTriage } from ${u('harness/train.mjs')};
const lines = [];
const r = flakeTriage({ root: process.cwd(), dir: ${JSON.stringify(D)} }, { id: 'tr-hold', tree: 'cafe1234', text: ${JSON.stringify(text)}, log: (m) => lines.push(m) });
const left = fs.readdirSync(path.join(process.cwd(), '.studio', 'locks')).filter((f) => /quiet-hold/.test(f));
console.log(JSON.stringify({ labels: (r?.labels || []).map((x) => x.label), notRun: r?.notRun || null, left, lines }));
`, { SEEN_LOG: seen, STUDIO_FLAKE_QUIET_WAIT_MIN: '0.05' });
    const calls = (() => { try { return fs.readFileSync(seen, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const j = p.j || {};
    const ok = calls.length === 2 && calls[0].low === false && calls[0].hold === 0 && calls[1].low === true && calls[1].hold === 1
      && j.labels?.[0] === 'load-sensitive' && Array.isArray(j.left) && j.left.length === 0 && (j.lines || []).some((l) => /STUDIO_FLAKE_HOLD_MIN/.test(l));
    return [ok, `${JSON.stringify({ calls, j: p.j ? { ...j, lines: (j.lines || []).slice(-8) } : null })}${p.j ? '' : p.text.slice(-1200)}`.slice(0, 2500)];
  });

  for (const S of made) { try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 8, retryDelay: 300 }); } catch {} }
}

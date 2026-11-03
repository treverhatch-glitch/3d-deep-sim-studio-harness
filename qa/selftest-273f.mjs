/**
 * qa/selftest-273f.mjs — 2.73.0 (helper f): taking an update safely, and the overseer-stage machinery.
 *   preflight  `upgrade --preflight` (read-only): PASS/WARN/FAIL per item with Fix lines, exit 1 on a FAIL; the board, the
 *              owner key, a tracked .env, a configured tool that isn't there, an unreadable policy file, a lane with
 *              unlanded work; the webhook never printed; nothing written; --ref checks node against the ref's engines
 *   smoke      `upgrade --smoke`: a tiny verify and train on a made-up task in a scratch copy (never the real board), the
 *              machine scan and a dry supervisor pass, an upgrade.smoke event, the copy removed; a broken harness FAILs
 *   snapshot   `upgrade --merge` writes .studio/upgrades/<from>-to-<to>.json (landed/h, false reds per train, tokens per
 *              landed change by task, red verify %, workarounds/day); `autonomy -- impact` takes its before side from it
 *   predict    `release -- predict --metric --expect` writes docs/releases/<version>.json; impact scores hit / miss
 *   overseer   studio/overseer.json (protected, read as committed): `npm run overseer` shows the stage and whether the next
 *              stage's criteria hold from git trailers and the logs; `overseer -- record` is a person's, never the overseer's
 *   repro      `workaround -- repro <H-id>`: refused below stage 1 and for the studio itself; in a separate clone a branch,
 *              a selftest-style failing test and a PR body with the trailers
 *   scout      the weekly harness scout: off by default; on its day one research task with the scout template, once a
 *              week; the supervisor's pass runs it
 * Each check fails on 2.71.1 (none of these commands or files exist there).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest273F({ dir, run, report, tmpRoot, root }) {
  // The smoke's train runs the size check, which needs typescript: a copy made without node_modules (the full
  // selftest's copyRepo, CI shard 2/4 of 2.73.0) gets the harness's own, linked, as selftest-270t does.
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const nm = path.join(dir, 'node_modules');
  const base = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_COMPACT_OUTPUT: '', STUDIO_VERIFY_DETACH: 'off', STUDIO_VERIFY_RUN: '', STUDIO_HEAVY_SLOTS: '0', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '',
    STUDIO_HOOKS_CHECK: 'off', STUDIO_UPGRADE_REFRESH: 'off', STUDIO_GAME: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', npm_lifecycle_event: '', NODE_OPTIONS: '', npm_config_node_options: '',
    STUDIO_REPORT_WEBHOOK: '', STUDIO_UNITY: '', GODOT_BIN: '', STUDIO_HARNESS_SCOUT: '', STUDIO_SCOUT_DAY: '', STUDIO_TZ: '', STUDIO_IMPACT_MIN_N: '', STUDIO_UPGRADE_SNAPSHOT_DAYS: '', STUDIO_UPGRADE_WATCH_MIN: 'off',
    STUDIO_DISK_MIN_FREE_GB: '0.5', STUDIO_PREFLIGHT_MIN_RAM_GB: '0', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-273f-${process.pid}.pem`), ...ident,
  };
  let n = 0;
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `273f-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const x of ['.studio/agents', '.studio/locks', '.studio/gates', '.studio/train', '.studio/decisions.jsonl', '.studio/gates-last.json', '.studio/upgrades', '.studio/workarounds.jsonl', '.studio/harness-tasks.json', '.studio/harness-scout.json', 'docs/releases']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    const ev = path.join(S, '.studio', 'events-273f.jsonl');
    fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return { S, ev, env: { ...base, AGENT_EVENTS_FILE: ev } };
  };
  const events = (ev) => { try { return fs.readFileSync(ev, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const put = (ev, list) => fs.appendFileSync(ev, list.map((e) => `${JSON.stringify({ id: `evt_${++n}`, status: 'ok', ...e, ts: new Date(e.at).toISOString() })}\n`).join(''));
  const lastJson = (r) => { const t = String(r.stdout || '').trim(); try { return JSON.parse(t); } catch { const l = t.split('\n').filter((x) => x.startsWith('{')).pop(); try { return JSON.parse(l); } catch { return null; } } };
  const has = (S, rel) => fs.existsSync(path.join(S, rel));
  const commitAll = (S, msg) => { g(S, ['add', '-A']); return g(S, ['commit', '-qm', msg, '--no-verify']); };
  const H = 3600000; const DAY = 24 * H;

  // ---- preflight ----
  {
    const { S, env } = studio('pre');
    // A lane copy with a commit main doesn't have.
    const lane = path.join(S, '.lanes', 'bob-1');
    g(S, ['worktree', 'add', '-q', '-b', 'lane/bob-1', lane]);
    fs.writeFileSync(path.join(lane, 'notes-273f.md'), 'lane work\n');
    g(lane, ['add', '-A']); g(lane, ['commit', '-qm', 'lane work', '--no-verify']);
    // A tracked .env holding a webhook, a policy file that doesn't parse, an uncommitted board row, a missing editor.
    const secret = 'https://hooks.example.invalid/services/T000/B000/s3cr3t273f';
    fs.writeFileSync(path.join(S, '.env'), `STUDIO_REPORT_WEBHOOK=${secret}\n`);
    g(S, ['add', '-f', '.env']); g(S, ['commit', '-qm', 'env', '--no-verify']);
    fs.writeFileSync(path.join(S, 'studio', 'policy.json'), '{ "autonomous": ');
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'policy', '--no-verify']);
    fs.appendFileSync(path.join(S, 'studio', 'NEXT.md'), '- [ ] **T-901** [P1] (`builder`) — not committed\n');
    const before = { st: g(S, ['status', '--porcelain']).stdout, head: g(S, ['rev-parse', 'HEAD']).stdout, studio: fs.readdirSync(path.join(S, '.studio')).sort().join(',') };
    const r = run(S, 'node harness/upgrade-guard.mjs --preflight', { ...env, STUDIO_UNITY: path.join(tmpRoot, 'no-such-unity-273f', 'Unity') });
    const o = out(r);
    const after = { st: g(S, ['status', '--porcelain']).stdout, head: g(S, ['rev-parse', 'HEAD']).stdout, studio: fs.readdirSync(path.join(S, '.studio')).sort().join(',') };
    const line = (st, id) => new RegExp(`\\] ${st}\\s+${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}:`).test(o);
    await guard('273f preflight: --preflight lists PASS/WARN/FAIL per item with a Fix line under each FAIL and exits 1: the uncommitted board, no owner key, a tracked .env, STUDIO_UNITY not found, studio/policy.json unreadable, and the lane with an unlanded commit listed (fails on 2.71.1: no --preflight, only the board check)', () => [
      r.status === 1 && line('FAIL', 'board') && line('FAIL', 'owner-key') && line('FAIL', 'dotenv') && line('FAIL', 'STUDIO_UNITY') && line('FAIL', 'studio/policy.json') && line('WARN', 'lanes') && /bob-1 \(1 commit\(s\) not on main/.test(o)
        && line('PASS', 'node') && line('PASS', 'git') && (o.match(/\n\s+Fix: /g) || []).length >= 6 && /\[upgrade preflight\] FAIL: \d+ pass, \d+ warn, \d+ fail/.test(o),
      o.slice(-2500)]);
    await guard('273f preflight: the webhook is never printed, and the preflight writes nothing (git status, HEAD and .studio/ the same after it) (fails on 2.71.1: no webhook item)', () => [
      !o.includes(secret) && !o.includes('s3cr3t273f') && /webhook: STUDIO_REPORT_WEBHOOK is set \(an https URL; not shown\)/.test(o) && before.st === after.st && before.head === after.head && before.studio === after.studio,
      `${o.includes('s3cr3t273f') ? 'THE WEBHOOK WAS PRINTED' : ''}\n${o.slice(-800)}\nstatus before ${before.st}\nafter ${after.st}\n.studio ${before.studio} / ${after.studio}`]);
    // Fixed up: board committed, owner public key committed, policy fixed, .env untracked; a ref that asks for a newer node.
    g(S, ['rm', '-q', '--cached', '.env']); fs.rmSync(path.join(S, '.env'));
    fs.writeFileSync(path.join(S, 'studio', 'policy.json'), '{}\n');
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    fs.mkdirSync(path.join(S, 'studio', 'keys'), { recursive: true });
    fs.writeFileSync(path.join(S, 'studio', 'keys', 'owner-ed25519.pub.pem'), publicKey.export({ type: 'spki', format: 'pem' }));
    g(S, ['worktree', 'remove', '--force', lane]);
    commitAll(S, 'board, key, policy');
    const ok = run(S, 'node harness/upgrade-guard.mjs --preflight --json', { ...env, STUDIO_REPORT_WEBHOOK: secret });
    const j = lastJson(ok);
    g(S, ['checkout', '-qb', 'upstream']);
    const pj = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')); pj.engines = { node: '>=99.0.0' }; pj.version = '9.9.9';
    fs.writeFileSync(path.join(S, 'package.json'), `${JSON.stringify(pj, null, 2)}\n`);
    commitAll(S, 'harness 9.9.9 needs node 99');
    g(S, ['checkout', '-q', 'main']);
    const ref = run(S, 'node harness/upgrade-guard.mjs --preflight --ref upstream', env);
    await guard('273f preflight: green when the studio is ready (exit 0, owner key PASS, no FAIL, --json items, the webhook not in the output); --ref checks node against the ref\'s engines (">=99.0.0": FAIL node with a Fix, exit 1) (fails on 2.71.1)', () => [
      ok.status === 0 && j?.ok === true && Array.isArray(j.items) && j.items.some((i) => i.id === 'owner-key' && i.status === 'PASS') && !j.items.some((i) => i.status === 'FAIL') && !out(ok).includes('s3cr3t273f')
        && ref.status === 1 && /FAIL node: node [\d.]+, but upstream's package\.json asks >=99\.0\.0/.test(out(ref)) && /Fix: install node 99\.0\.0/.test(out(ref)),
      `ok ${ok.status}: ${out(ok).slice(-1500)}\nref ${ref.status}: ${out(ref).slice(-800)}`]);
  }

  // ---- smoke ----
  {
    const { S, ev, env } = studio('smoke');
    const tmp = path.join(tmpRoot, `273f-smoke-tmp-${process.pid}`);
    fs.mkdirSync(tmp, { recursive: true });
    const tenv = { ...env, TMPDIR: tmp, TEMP: tmp, TMP: tmp };
    const board = () => `${fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8')}|${fs.readFileSync(path.join(S, 'studio', 'DONE.md'), 'utf8')}`;
    const b0 = board(); const st0 = g(S, ['status', '--porcelain']).stdout;
    const r = run(S, 'node harness/upgrade-guard.mjs --smoke', tenv);
    const o = out(r);
    const e = events(ev).filter((x) => x.type === 'upgrade.smoke');
    await guard('273f smoke: --smoke runs a tiny verify and a tiny train on a made-up task in a scratch copy, the machine scan and a dry supervisor pass: PASS per item, exit 0, an upgrade.smoke event; the studio\'s board and files untouched, the copy removed (fails on 2.71.1: no --smoke)', () => [
      r.status === 0 && ['copy', 'verify', 'train', 'machine', 'supervisor'].every((id) => new RegExp(`\\] PASS\\s+${id}:`).test(o)) && /train: T-\d+ \(made up\)[^\n]*landed/.test(o)
        && e.length === 1 && e[0].meta?.ok === true && e[0].meta.items.length === 5 && board() === b0 && g(S, ['status', '--porcelain']).stdout === st0 && fs.readdirSync(tmp).length === 0,
      `${r.status}: ${o.slice(-2500)}\nevents ${JSON.stringify(e.map((x) => x.meta?.ok))}; left in tmp: ${fs.readdirSync(tmp).join(', ')}`]);
    // A harness whose supervisor can't load: that item FAILs with a Fix, exit 1.
    fs.appendFileSync(path.join(S, 'harness', 'supervisor.mjs'), '\nthrow new Error("broken-273f");\n');
    commitAll(S, 'a broken supervisor');
    const bad = run(S, 'node harness/upgrade-guard.mjs --smoke', tenv);
    await guard('273f smoke: a broken supervisor makes the supervisor item FAIL with a Fix line and the smoke exit 1 (the other items still PASS) (fails on 2.71.1)', () => [
      bad.status === 1 && /\] FAIL\s+supervisor:/.test(out(bad)) && /\n\s+Fix: /.test(out(bad)) && /\] PASS\s+train:/.test(out(bad)) && events(ev).filter((x) => x.type === 'upgrade.smoke').pop()?.meta?.ok === false && fs.readdirSync(tmp).length === 0,
      `${bad.status}: ${out(bad).slice(-1500)}`]);
  }

  // ---- before snapshot, impact, predictions ----
  {
    const { S, ev, env } = studio('snap');
    const v0 = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')).version;
    const now = Date.now();
    put(ev, [
      { type: 'task.done', task: 'T-500', at: now - 5 * DAY },
      { type: 'task.done', task: 'T-1', at: now - 2 * DAY },
      { type: 'task.done', task: 'T-2', at: now - DAY },
      { type: 'task.train.verify', status: 'blocked', at: now - 2 * DAY + H, meta: { train: 'tr1-1', tree: 'aaa', ok: false, ms: 600000 } },
      { type: 'task.train.verify', at: now - 2 * DAY + 2 * H, meta: { train: 'tr1-2', tree: 'aaa', ok: true, ms: 540000 } },
      { type: 'task.train.verify', at: now - DAY + H, meta: { train: 'tr2-1', tree: 'bbb', ok: true, ms: 480000 } },
      { type: 'harness.workaround', at: now - 2 * DAY, meta: { sig: 'a' } }, { type: 'harness.workaround', at: now - DAY, meta: { sig: 'b' } }, { type: 'harness.workaround', at: now - H, meta: { sig: 'c' } },
      { type: 'agent.session.end', agent: 'builder-1', task: 'T-1', tokensIn: 1000, tokensOut: 500, at: now - 2 * DAY + 30 * 60000, meta: {} },
    ]);
    g(S, ['checkout', '-qb', 'upstream']);
    const pj = JSON.parse(fs.readFileSync(path.join(S, 'package.json'), 'utf8')); pj.version = '9.9.9';
    fs.writeFileSync(path.join(S, 'package.json'), `${JSON.stringify(pj, null, 2)}\n`);
    commitAll(S, 'harness 9.9.9');
    g(S, ['checkout', '-q', 'main']);
    const m = run(S, 'node harness/upgrade-guard.mjs --merge upstream --by Pat', env);
    const rel = `.studio/upgrades/${v0}-to-9.9.9.json`;
    let doc = null; try { doc = JSON.parse(fs.readFileSync(path.join(S, rel), 'utf8')); } catch {}
    const mm = doc?.measures || {};
    const merged = events(ev).find((x) => x.type === 'upgrade.merged');
    await guard(`273f snapshot: upgrade --merge writes ${'.studio/upgrades/<from>-to-<to>.json'} just before it merges: landed/h (2 in 3 days), false reds per train (1 red whose tree went green later, 2 trains: 0.5), red verify % (33.3), tokens per landed change by task (T-1: 1500), workarounds/day (1); the merge says so and upgrade.merged names it (fails on 2.71.1: no snapshot)`, () => [
      m.status === 0 && doc?.kind === 'upgrade-baseline' && doc.from === v0 && doc.to === '9.9.9' && mm.landedPerHour?.n === 2 && mm.falseRedsPerTrain?.value === 0.5 && mm.falseRedsPerTrain?.n === 2 && mm.redVerifyPct?.value === 33.3
        && mm.tokensByTask?.top?.[0]?.task === 'T-1' && mm.tokensByTask.top[0].tokens === 1500 && mm.workaroundsPerDay?.value === 1 && /before snapshot \.studio\/upgrades\//.test(out(m)) && merged?.meta?.baseline === rel,
      `merge ${m.status}: ${out(m).slice(-1200)}\n${JSON.stringify(doc)?.slice(0, 1500)}`]);
    // The impact report takes its before side from the snapshot (a distinctive number put in it), and scores predictions.
    if (doc) { doc.measures.landedPerHour = { value: 42.5, n: 40, better: 'up' }; fs.writeFileSync(path.join(S, rel), JSON.stringify(doc, null, 2)); }
    const havePredict = has(S, 'harness/release-predict.mjs');
    const p1 = havePredict ? run(S, 'node scripts/release.mjs predict --metric landed/h --expect "+20%" --release 9.9.9 --by Pat --why "fewer waits"', env) : { status: null, stdout: '', stderr: 'no harness/release-predict.mjs' };
    const p2 = havePredict ? run(S, 'node scripts/release.mjs predict --metric false-reds --expect "-50%" --release 9.9.9 --by Pat', env) : p1;
    const p3 = havePredict ? run(S, 'node scripts/release.mjs predict --metric workarounds/day --expect "-30%" --release 9.9.9 --by Pat', env) : p1;
    const pBad = havePredict ? run(S, 'node scripts/release.mjs predict --metric happiness --expect "-30%" --release 9.9.9', env) : p1;
    let pdoc = null; try { pdoc = JSON.parse(fs.readFileSync(path.join(S, 'docs', 'releases', '9.9.9.json'), 'utf8')); } catch {}
    await guard('273f predict: release -- predict --metric <name> --expect "<±x%>" records the release\'s predictions in docs/releases/<version>.json (short names resolved, an unknown metric refused with exit 2) (fails on 2.71.1: no predict)', () => [
      p1.status === 0 && p2.status === 0 && p3.status === 0 && pBad.status === 2 && /unknown metric "happiness"/.test(out(pBad))
        && JSON.stringify((pdoc?.predictions || []).map((p) => [p.metric, p.expect])) === JSON.stringify([['landedPerHour', '+20%'], ['falseRedsPerTrain', '-50%'], ['workaroundsPerDay', '-30%']]) && pdoc.predictions[0].why === 'fewer waits',
      `${p1.status} ${p2.status} ${p3.status} ${pBad.status}: ${out(p1).slice(-300)} ${out(pBad).slice(-300)}\n${JSON.stringify(pdoc)}`]);
    const later = Date.now();
    put(ev, [
      { type: 'task.done', task: 'T-3', at: later }, { type: 'task.done', task: 'T-4', at: later },
      { type: 'task.train.verify', at: later, meta: { train: 'tr3-1', tree: 'ccc', ok: true, ms: 300000 } },
      { type: 'harness.workaround', at: later, meta: { sig: 'd' } }, { type: 'harness.workaround', at: later, meta: { sig: 'e' } },
    ]);
    const imp = run(S, 'node harness/autonomy.mjs impact --release 9.9.9 --json', { ...env, STUDIO_IMPACT_MIN_N: '1' });
    const j = lastJson(imp) || (() => { try { return JSON.parse(String(imp.stdout)); } catch { return null; } })();
    const row = (k) => (j?.rows || []).find((x) => x.key === k);
    const ex = (k) => (j?.extra || []).find((x) => x.key === k);
    const pr = (k) => (j?.predictions || []).find((x) => x.metric === k);
    await guard('273f impact: autonomy -- impact reads the snapshot when present: its numbers are the before side (landed/h 42.5 from the file, not the log), false reds per train and workarounds per day are compared too (extra rows), and the text marks the snapshot (fails on 2.71.1: before recomputed from the log, no baseline)', () => {
      const text = run(S, 'node harness/autonomy.mjs impact --release 9.9.9', { ...env, STUDIO_IMPACT_MIN_N: '1' });
      return [j?.ok && j.baseline?.file === rel && row('landedPerHour')?.before === 42.5 && row('redVerifyPct')?.before === 33.3 && ex('falseRedsPerTrain')?.before === 0.5 && ex('falseRedsPerTrain')?.after === 0 && ex('workaroundsPerDay')?.before === 1
        && /Before: the snapshot \.studio\/upgrades\/[^ ]+ taken/.test(out(text)) && /42\.5\*/.test(out(text)) && /false reds per train: 0\.5 -> 0/.test(out(text)),
      `${imp.status}: ${String(imp.stdout).slice(0, 2500)}\n${out(text).slice(-1500)}`];
    });
    await guard('273f impact: the release\'s predictions are scored with the measured change: landed/h "+20%" hit, false reds "-50%" hit (0.5 -> 0, -100%), workarounds/day "-30%" miss (fails on 2.71.1: no predictions)', () => [
      pr('landedPerHour')?.result === 'hit' && pr('falseRedsPerTrain')?.result === 'hit' && pr('falseRedsPerTrain')?.delta === -100 && pr('workaroundsPerDay')?.result === 'miss' && Number.isFinite(pr('workaroundsPerDay')?.delta),
      JSON.stringify(j?.predictions || null)]);
  }

  // ---- overseer, repro, scout ----
  {
    const { S, ev, env } = studio('over');
    const ov = (doc) => { fs.writeFileSync(path.join(S, 'studio', 'overseer.json'), `${JSON.stringify(doc, null, 2)}\n`); };
    const tenDays = new Date(Date.now() - 10 * DAY).toISOString();
    ov({ stage: 0, agent: 'opus-bot', setBy: 'Pat', setAt: tenDays });
    commitAll(S, 'overseer stage 0');
    const logW = run(S, 'node harness/workaround.mjs log "re-ran the next command" --why "it was refused" --cmd "npm run task -- next" --by opus-bot', env);
    const C = path.join(tmpRoot, `273f-harness-clone-${process.pid}`);
    g(tmpRoot, ['clone', '-q', S, C]);
    made.push(C);
    const r0 = run(S, `node harness/workaround.mjs repro H-001 --by opus-bot --harness-repo "${C}"`, env);
    await guard('273f repro: workaround -- repro refuses the overseer below stage 1 (stage 0: reporter), and no branch is made in the clone (fails on 2.71.1: no repro)', () => [
      logW.status === 0 && r0.status === 1 && /overseer stage is 0/.test(out(r0)) && !g(C, ['branch', '--list', 'repro/*']).stdout.trim(),
      `log ${logW.status}: ${out(logW).slice(-300)}\nrepro ${r0.status}: ${out(r0).slice(-500)}`]);
    ov({ stage: 1, agent: 'opus-bot', setBy: 'Pat', setAt: tenDays, criteria: { 2: { minDaysAtStage: 7, minAcceptedRepros: 1, maxProtectedAttempts: 0 } } });
    commitAll(S, 'overseer stage 1');
    const self = run(S, `node harness/workaround.mjs repro H-001 --by opus-bot --harness-repo "${S}"`, env);
    const sub = path.join(S, 'game'); fs.mkdirSync(sub, { recursive: true });
    const inner = run(S, `node harness/workaround.mjs repro H-001 --by opus-bot --harness-repo "${sub}"`, env);
    const headS = g(S, ['rev-parse', 'HEAD']).stdout;
    const ok = run(S, `node harness/workaround.mjs repro H-001 --by opus-bot --harness-repo "${C}" --commit`, env);
    const branch = g(C, ['symbolic-ref', '--short', 'HEAD']).stdout.trim();
    const testRel = 'qa/selftest-repro-h-001.mjs';
    const testText = fs.existsSync(path.join(C, testRel)) ? fs.readFileSync(path.join(C, testRel), 'utf8') : '';
    const body = (() => { try { return fs.readFileSync(path.join(C, '.studio', 'repro', 'H-001-PR.md'), 'utf8'); } catch { return ''; } })();
    const msg = g(C, ['log', '-1', '--format=%B']).stdout;
    const check = spawnSync(process.execPath, ['--check', path.join(C, testRel)], { windowsHide: true, encoding: 'utf8' });
    await guard('273f repro: refused for the studio itself and a folder inside it; in a separate clone: branch repro/h-001-<sig>, a selftest-style failing test (selftestReproH001, the evidence in its header, the safe recorded command run as node) committed with Repro-Of / Overseer-By, the PR body with the checklist and trailers; the studio untouched; an event (fails on 2.71.1)', () => [
      self.status === 1 && /SEPARATE clone/.test(out(self)) && inner.status === 1 && /SEPARATE clone/.test(out(inner))
        && ok.status === 0 && /^repro\/h-001-[\w-]+$/.test(branch) && /export async function selftestReproH001\(\{ dir, run, report, tmpRoot \}\)/.test(testText) && /"node harness\/task\.mjs next"/.test(testText) && /it was refused/.test(testText) && check.status === 0
        && /Repro-Of: H-001/.test(msg) && /Overseer-By: opus-bot/.test(msg) && /Repro-Of: H-001/.test(body) && /Overseer-By: opus-bot/.test(body) && /- \[ \] the check fails on the current harness/.test(body)
        && g(S, ['rev-parse', 'HEAD']).stdout === headS && g(S, ['symbolic-ref', '--short', 'HEAD']).stdout.trim() === 'main' && events(ev).some((e) => e.type === 'harness.repro_scaffolded' && e.meta?.task === 'H-001'),
      `self ${self.status}: ${out(self).slice(-300)}\ninner ${inner.status}: ${out(inner).slice(-300)}\nok ${ok.status}: ${out(ok).slice(-700)}\nbranch ${branch}; check ${check.status} ${check.stderr}\n${msg}\n${body.slice(0, 600)}`]);
    // The overseer's evidence: an Overseer-By / Repro-Of commit in the studio's history (as an update brings it).
    fs.writeFileSync(path.join(S, 'notes-273f.md'), 'from the harness\n');
    g(S, ['add', '-A']); g(S, ['commit', '-q', '--no-verify', '-m', 'test: failing repro of H-001\n\nRepro-Of: H-001\nOverseer-By: opus-bot']);
    const st1 = lastJson(run(S, 'node harness/overseer.mjs --json', env));
    ov({ stage: 3, agent: 'opus-bot', setBy: 'opus-bot', setAt: tenDays });
    const st2 = lastJson(run(S, 'node harness/overseer.mjs --json', env));
    g(S, ['checkout', '--', 'studio/overseer.json']);
    await guard('273f overseer: npm run overseer shows the stage the owner committed (1) and that stage 2\'s criteria hold (10 days, 1 accepted repro from the Repro-Of/Overseer-By commit, no protected attempt) as a suggestion; an uncommitted edit to stage 3 is ignored and named (fails on 2.71.1: no overseer)', () => [
      st1?.stage === 1 && st1.next === 2 && st1.evidence?.acceptedRepros === 1 && st1.evidence.mergedPrs >= 1 && st1.evidence.workaroundsLogged === 1 && st1.holds === true && /the owner may set "stage": 2/.test(st1.suggestion)
        && st2?.stage === 1 && st2.notes?.some((x) => /uncommitted edit \(stage 3\)/.test(x)),
      `${JSON.stringify(st1)?.slice(0, 1500)}\n${JSON.stringify(st2?.notes)}`]);
    const selfRec = run(S, 'node harness/overseer.mjs record repro-accepted H-002 --by opus-bot', env);
    const rec = run(S, 'node harness/overseer.mjs record repro-accepted H-002 --by Pat --note "merged upstream"', env);
    put(ev, [{ type: 'task.refused', agent: 'opus-bot', status: 'blocked', msg: 'Not queued: it changes a protected file (studio/gates.json)', at: Date.now() }]);
    const st3 = lastJson(run(S, 'node harness/overseer.mjs --json', env));
    let dec = []; try { dec = fs.readFileSync(path.join(S, '.studio', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    const prot = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'protected.json'), 'utf8')).globs || [];
    const approveText = fs.readFileSync(path.join(S, 'harness', 'approve.mjs'), 'utf8');
    await guard('273f overseer: record is a person\'s (the overseer\'s own refused; Pat\'s goes to the decision log and counts); a protected-file attempt by the overseer makes the criteria fail; studio/overseer.json is protected (studio/protected.json and the default list) (fails on 2.71.1)', () => [
      selfRec.status === 1 && /is the overseer/.test(out(selfRec)) && rec.status === 0 && dec.some((d) => d.action === 'overseer-repro-accepted' && d.subject === 'H-002' && d.by === 'Pat')
        && st3?.evidence?.acceptedRepros === 2 && st3.evidence.protectedAttempts === 1 && st3.holds === false && prot.includes('studio/overseer.json') && /'studio\/overseer\.json'/.test(approveText),
      `self ${selfRec.status}: ${out(selfRec).slice(-300)}\nrec ${rec.status}: ${out(rec).slice(-300)}\n${JSON.stringify(st3?.evidence)}`]);

    // ---- the weekly harness scout ----
    const probe = path.join(S, '.probe-273f-scout.mjs');
    const monday = Date.parse('2026-11-09T10:00:00Z');
    fs.writeFileSync(probe, [
      `import { scoutPass } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'harness-scout.mjs')).href)};`,
      `const now = ${monday};`,
      'const offRun = await scoutPass({ now, env: { ...process.env, STUDIO_HARNESS_SCOUT: "" } });',
      'const tuesday = await scoutPass({ now: now + 86400000, env: { ...process.env, STUDIO_HARNESS_SCOUT: "on" } });',
      'const first = await scoutPass({ now, env: { ...process.env, STUDIO_HARNESS_SCOUT: "on" } });',
      'const again = await scoutPass({ now: now + 3600000, env: { ...process.env, STUDIO_HARNESS_SCOUT: "on" } });',
      'const nextWeek = await scoutPass({ now: now + 7 * 86400000, env: { ...process.env, STUDIO_HARNESS_SCOUT: "on" } });',
      'const friday = await scoutPass({ now: now + 4 * 86400000, env: { ...process.env, STUDIO_HARNESS_SCOUT: "on", STUDIO_SCOUT_DAY: "fri" } });',
      'console.log(JSON.stringify({ offRun, tuesday, first, again, nextWeek, friday }));', ''].join('\n'));
    const sc = run(S, `node "${probe}"`, env);
    const sj = lastJson(sc);
    const tid = sj?.first?.task;
    const nextMd = fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8');
    const tpl = (() => { try { return fs.readFileSync(path.join(S, sj.first.file), 'utf8'); } catch { return ''; } })();
    await guard('273f scout: off by default; with STUDIO_HARNESS_SCOUT=on, on STUDIO_SCOUT_DAY (monday) ONE research task (role rnd) with the scout template (sources, the claim, measured or vendor claim, the scorecard number it could move), once a week and never while the last is open (fails on 2.71.1: no scout)', () => [
      sc.status === 0 && sj.offRun === null && sj.tuesday === null && /^T-\d+$/.test(tid || '') && sj.again === null && /still open/.test(sj.nextWeek?.line || '') && /still open/.test(sj.friday?.line || '')
        && new RegExp(`\\*\\*${tid}\\*\\* \\[P2\\] \\(\`rnd\`\\) — Research: weekly harness scout \\(week of 2026-11-09\\)`).test(nextMd) && (nextMd.match(/weekly harness scout/g) || []).length === 1
        && /## Sources/.test(tpl) && /- The claim:/.test(tpl) && /measured \| vendor claim/.test(tpl) && /Scorecard number it could move:/.test(tpl) && events(ev).some((e) => e.type === 'harness.scout_filed' && e.task === tid),
      `${sc.status}: ${out(sc).slice(-1500)}\n${tpl.slice(0, 400)}`]);
    const sup = path.join(S, '.probe-273f-sup.mjs');
    fs.writeFileSync(sup, [
      `import { supervise } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'supervisor.mjs')).href)};`,
      "const deps = { sessions: () => [], startAgent: () => ({ ok: false }), launchableRoles: () => [], nextAgentName: (r) => r + '-z', pauseAgent: () => ({ ok: true }), lanesInline: true, reportInline: true };",
      `const r = await supervise({ deps, dryRun: true }, { startedAt: Date.now() - 1000, names: [] }, ${monday + 14 * DAY});`,
      'console.log(JSON.stringify({ why: r.why || [] }));', ''].join('\n'));
    // Close the open scout task so the supervisor's pass would file the next one (a dry run: nothing is written).
    fs.writeFileSync(path.join(S, 'studio', 'NEXT.md'), nextMd.split('\n').filter((l) => !l.includes('weekly harness scout')).join('\n'));
    const sOn = lastJson(run(S, `node "${sup}"`, { ...env, STUDIO_HARNESS_SCOUT: 'on' }));
    const sOff = lastJson(run(S, `node "${sup}"`, env));
    await guard('273f scout: the supervisor\'s pass runs the scout (dry run: "would file", nothing written) and says nothing while it is off (fails on 2.71.1: no scout in the pass)', () => [
      (sOn?.why || []).some((w) => /harness scout: would file "Research: weekly harness scout \(week of 2026-11-23\)/.test(w)) && !(sOff?.why || []).some((w) => /harness scout/.test(w)) && !/2026-11-23/.test(fs.readFileSync(path.join(S, 'studio', 'NEXT.md'), 'utf8')),
      `${JSON.stringify(sOn)}\n${JSON.stringify(sOff)}`]);
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {} }
}

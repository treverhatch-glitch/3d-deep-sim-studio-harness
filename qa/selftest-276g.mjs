/**
 * qa/selftest-276g.mjs — 2.76.0 (the owner's request, 2026-11-04): beta mode, the owner gates off while the harness is
 * built, plus B-86 (the proxy answers owner asks), B-93 (approvals hash text with LF) and B-95 (owner allow rules for the
 * proxy's own session folder).
 *   switch    `beta on --by <owner>` (signed where the key is) / `beta off`; a worker or an agent's own shell can't
 *   covers    in beta mode the named agent and Producer/Director sessions act as the owner for every action but money and
 *             deletes; workers and builder sessions never; the beta words stand in for --permission
 *   approve   an approval without the key or the owner's words that counts while beta mode is on, not from a worker's
 *             commit, and not after `beta off`
 *   asks      the proxy / a beta actor answers an owner ask for the owner (recorded)
 *   crlf      a protected file approved with CRLF still matches once checked out with LF
 *   settings  `delegate -- claude-settings --owner --dir <folder> --write` writes the owner's command rules there
 * Each check fails on 2.75.0 (no beta mode).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest276G({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: 'pat@example.invalid', GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: 'pat@example.invalid' };
  const key = path.join(tmpRoot, `owner-276g-${process.pid}.pem`);
  const base = {
    ...ident, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off',
    STUDIO_GATE_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', NODE_OPTIONS: '', GITHUB_BASE_REF: '',
  };
  const owner = { ...base, STUDIO_OWNER_KEY: key };
  const noKey = path.join(tmpRoot, 'no-owner-key-276g.pem');
  const patch = { ...base, STUDIO_LOCK_OWNER: 'opus-1', STUDIO_OWNER_KEY: noKey };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };

  const S = path.join(tmpRoot, `276g-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio/agents', '.studio/locks', '.studio/gates', '.studio/train', '.studio/decisions.jsonl', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/asks']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  fs.rmSync(key, { force: true });
  g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
  g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
  const kg = run(S, 'node harness/approve.mjs keygen', owner);
  g(S, ['add', 'studio/keys']); g(S, ['commit', '-qm', 'keys: owner public key', '--no-verify']);
  const probe = (env, js, cwd = S) => {
    const f = path.join(cwd, '.probe-276g.mjs');
    fs.writeFileSync(f, js);
    const r = run(cwd, 'node .probe-276g.mjs', env);
    fs.rmSync(f, { force: true });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { error: out(r).slice(-600) }; }
  };
  const dfor = (env, action, by) => probe(env, `import('./harness/delegation.mjs').then((m) => { const d = m.delegationFor({ action: ${JSON.stringify(action)}, by: ${JSON.stringify(by)} }); console.log(JSON.stringify({ ok: d.ok, beta: Boolean(d.beta), why: d.why })); });`);

  await guard('2.76.0 (g) beta: before beta mode the outside agent covers nothing; a worker\'s shell and an agent\'s own shell (no owner proxy) can\'t turn it on; `beta on --by pat --agents opus-1` in the owner\'s terminal commits a signed studio/beta.json and `beta status` says ON (fails on 2.75.0: no beta command)', () => {
    const before = dfor(patch, 'unpark', 'opus-1');
    const worker = run(S, 'node harness/beta-mode.mjs on --by pat --no-commit', { ...base, STUDIO_LOCK_OWNER: 'builder-s1' });
    const agentShell = run(S, 'node harness/beta-mode.mjs on --by pat --no-commit', { ...base, CLAUDECODE: '1' });
    const on = run(S, 'node harness/beta-mode.mjs on --by pat --agents opus-1 --why "harness beta: fewer owner steps"', owner);
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(S, 'studio/beta.json'), 'utf8')); } catch {}
    const st = run(S, 'node harness/beta-mode.mjs status', base);
    const logged = g(S, ['log', '-1', '--format=%s', '--', 'studio/beta.json']).stdout.trim();
    return [kg.status === 0 && !before.ok && worker.status !== 0 && agentShell.status !== 0 && on.status === 0 && doc?.on === true && typeof doc.signature === 'string' && /beta: on/.test(logged) && /Beta mode is ON/.test(out(st)) && (doc.agents || []).includes('opus-1'),
      `before ${JSON.stringify(before)}\nworker ${worker.status} ${out(worker).slice(-200)}\nagent ${agentShell.status} ${out(agentShell).slice(-200)}\non ${on.status} ${out(on).slice(-300)}\n${JSON.stringify(doc).slice(0, 300)}\nstatus ${out(st).slice(-200)}`];
  });

  await guard('2.76.0 (g) beta covers: opus-1\'s shell and a Producer session act as the owner for any action (unpark, train-release, resume) with --by opus-1 or --by pat; never money or delete, a worker\'s name, a builder session; permissionText("") is the beta words there (fails on 2.75.0)', () => {
    const rows = {
      unpark: dfor(patch, 'unpark', 'opus-1'), release: dfor(patch, 'train-release', 'pat'), resume: dfor(patch, 'resume', 'opus-1'),
      producer: dfor({ ...base, STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1', STUDIO_OWNER_KEY: noKey }, 'yes', 'producer-s1'),
      money: dfor(patch, 'money', 'opus-1'), del: dfor(patch, 'delete', 'opus-1'),
      worker: dfor({ ...base, STUDIO_LOCK_OWNER: 'builder-s1', STUDIO_OWNER_KEY: noKey }, 'unpark', 'builder-s1'),
      builderSession: dfor({ ...base, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'opus-1', STUDIO_OWNER_KEY: noKey }, 'unpark', 'opus-1'),
      words: probe(patch, "import('./harness/permission.mjs').then((m) => console.log(JSON.stringify({ t: m.permissionText('') })));").t,
      wordsOther: probe({ ...base, STUDIO_LOCK_OWNER: 'helper-x' }, "import('./harness/permission.mjs').then((m) => console.log(JSON.stringify({ t: m.permissionText('') })));").t,
    };
    return [rows.unpark.ok && rows.unpark.beta && rows.release.ok && rows.resume.ok && rows.producer.ok && !rows.money.ok && !rows.del.ok && !rows.worker.ok && !rows.builderSession.ok
      && /beta mode: set by pat/.test(rows.words || '') && rows.wordsOther === '', JSON.stringify(rows).slice(0, 1400)];
  });

  // A lane with a protected change written with CRLF (studio/gates.json is on the shipped protected list).
  const lane = path.join(tmpRoot, `276g-lane-${process.pid}`);
  g(S, ['worktree', 'add', '-q', '-b', 'feat-276g', lane]);
  const gates = path.join(lane, 'studio', 'gates.json');
  let gj = {};
  try { gj = JSON.parse(fs.readFileSync(gates, 'utf8')); } catch {}
  const lf = `${JSON.stringify({ ...gj, note276g: 'a protected change' }, null, 2)}\n`;
  fs.writeFileSync(gates, lf.replace(/\n/g, '\r\n'));
  const show = (env = patch) => run(lane, 'node harness/approve.mjs show', env);
  let apFile = null;
  await guard('2.76.0 (g) beta approval: in opus-1\'s shell, with no private key and no --permission, `approve -- protected` writes an approval carrying studio/beta.json (no signature) that `approve -- show` accepts (fails on 2.75.0: "no owner key at …")', () => {
    const before = show();
    const ap = run(lane, 'node harness/approve.mjs protected --note "beta: the gates change is fine" --by pat', patch);
    const dirA = path.join(lane, 'studio', 'approvals');
    const files = fs.existsSync(dirA) ? fs.readdirSync(dirA).filter((f) => f.startsWith('protected-')) : [];
    apFile = files[0] ? path.join('studio', 'approvals', files[0]) : null;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(lane, apFile), 'utf8')); } catch {}
    // 2.78.2 (h, the owner's call): a beta approval counts only once committed, by someone who isn't a worker.
    if (apFile) { g(lane, ['add', apFile]); g(lane, ['commit', '-qm', 'approval\n\nStudio-Agent: opus-1', '--no-verify']); }
    const after = show();
    // The next check commits the approval itself (first as a builder): put it back to uncommitted, file kept.
    if (apFile) g(lane, ['reset', '-q', '--soft', 'HEAD~1']);
    return [before.status !== 0 && ap.status === 0 && doc?.signature === null && doc?.beta?.by === 'pat' && doc?.approval?.recordedBy === 'opus-1' && after.status === 0,
      `before ${before.status}: ${out(before).slice(-200)}\napprove ${ap.status}: ${out(ap).slice(-300)}\n${JSON.stringify(doc).slice(0, 400)}\nafter ${after.status}: ${out(after).slice(-200)}`];
  });

  await guard('2.76.0 (g, B-93) crlf: the change approved on CRLF bytes still matches once the file is committed and checked out with LF; a builder\'s commit of the approval doesn\'t count; after `beta off` on main it no longer counts (fails on 2.75.0)', () => {
    if (!apFile) return [false, 'no approval file from the previous check'];
    fs.writeFileSync(gates, lf);
    g(lane, ['add', 'studio/gates.json', apFile]);
    g(lane, ['commit', '-qm', 'gates + approval\n\nStudio-Agent: builder-s1', '--no-verify']);
    const builder = show();
    g(lane, ['commit', '-q', '--amend', '-m', 'gates + approval\n\nStudio-Agent: opus-1', '--no-verify']);
    const own = show();
    const off = run(S, 'node harness/beta-mode.mjs off --by pat', base);
    const after = show();
    return [builder.status !== 0 && own.status === 0 && off.status === 0 && after.status !== 0,
      `builder ${builder.status}: ${out(builder).slice(-200)}\nown ${own.status}: ${out(own).slice(-200)}\noff ${off.status}: ${out(off).slice(-200)}\nafter ${after.status}: ${out(after).slice(-200)}`];
  });

  await guard('2.76.0 (g, B-86) asks: with beta mode on again, opus-1 answers an owner ask with --by opus-1 and it is recorded as the owner\'s answer (recordedBy opus-1); with beta off and no proxy it is refused as before (fails on 2.75.0: "A person answers")', () => {
    const q = run(S, 'node harness/ask.mjs "Which stands first?" --options "north,south" --by producer-s1', base);
    const id = (out(q).match(/A-\d{3}/) || [])[0] || 'A-001';
    const refused = run(S, `node harness/ask.mjs answer ${id} north --by opus-1`, patch);
    const on = run(S, 'node harness/beta-mode.mjs on --by pat --agents opus-1', owner);
    const ans = run(S, `node harness/ask.mjs answer ${id} north --by opus-1`, patch);
    let a = null;
    try { a = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'asks', `${id}.json`), 'utf8')); } catch {}
    return [q.status === 0 && refused.status !== 0 && on.status === 0 && ans.status === 0 && a?.status === 'answered' && a?.answeredBy === 'pat' && a?.recordedBy === 'opus-1',
      `ask ${q.status} ${out(q).slice(-150)}\nrefused ${refused.status} ${out(refused).slice(-150)}\nanswer ${ans.status} ${out(ans).slice(-200)}\n${JSON.stringify(a).slice(0, 300)}`];
  });

  await guard('2.76.0 (g, B-95) settings: in beta mode opus-1 writes the owner\'s command rules (npm and npm.cmd prefix rules, no broad rule) into its own session\'s folder with `delegate -- claude-settings --owner --dir <folder> --write`; a worker can\'t (fails on 2.75.0: no --owner/--dir)', () => {
    const sess = path.join(tmpRoot, `276g-session-${process.pid}`);
    fs.mkdirSync(sess, { recursive: true });
    const w = run(S, `node harness/delegation.mjs claude-settings --owner --actions train-release --dir ${JSON.stringify(sess)} --write`, patch);
    const worker = run(S, `node harness/delegation.mjs claude-settings --owner --actions train-release --dir ${JSON.stringify(sess)} --write`, { ...base, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s2' });
    let s = null;
    try { s = JSON.parse(fs.readFileSync(path.join(sess, '.claude', 'settings.json'), 'utf8')); } catch {}
    const allow = s?.permissions?.allow || [];
    const broad = allow.some((r) => /Bash\(\*\)|npm run \*|^Bash\(npm run:\*\)$/.test(r));
    return [w.status === 0 && worker.status !== 0 && allow.includes('Bash(npm run approve -- protected:*)') && allow.includes('Bash(npm.cmd run task -- unpark:*)') && allow.includes('Bash(npm run ask -- answer:*)') && !broad,
      `write ${w.status}: ${out(w).slice(-300)}\nworker ${worker.status}: ${out(worker).slice(-200)}\n${JSON.stringify(allow).slice(0, 500)}`];
  });

  try { g(S, ['worktree', 'remove', '--force', lane]); } catch {}
  for (const p of [S, lane, key]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

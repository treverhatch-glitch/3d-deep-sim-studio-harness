/**
 * qa/selftest-2731o.mjs — 2.73.1 (B-67, the owner's emergency request): the standing owner proxy.
 *   grant     `delegate -- proxy <agent> --by <owner> --days N`: one owner-signed grant, actions ["*"], proxy: true
 *   covers    in the proxy's own shell (STUDIO_LOCK_OWNER=<agent>) delegationFor covers any action with --by <agent> or
 *             --by <owner>; never keys, a launched session, another shell's name; permissionText('') stands in
 *   approve   `approve -- protected --by <owner> --permission "<the owner's yes>"` without the private key: an approval
 *             that carries the signed grant; refused without the yes; counts in `approve -- show`; a builder's commit of
 *             it doesn't count; a revoke voids it
 *   compat    a 2.67-style grant (a few actions) still verifies and covers only its actions
 * Each check fails on 2.73.0 (no proxy grant, no unsigned approvals).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export async function selftest2731O({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: 'pat@example.invalid', GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: 'pat@example.invalid' };
  const key = path.join(tmpRoot, `owner-2731o-${process.pid}.pem`);
  const base = {
    ...ident, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off',
    STUDIO_GATE_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', NODE_OPTIONS: '', GITHUB_BASE_REF: '',
  };
  const owner = { ...base, STUDIO_OWNER_KEY: key };
  const proxy = { ...base, STUDIO_LOCK_OWNER: 'opus-1', STUDIO_OWNER_KEY: path.join(tmpRoot, 'no-owner-key-here.pem') };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };

  // A fresh studio: the harness files, a new repo on main, the owner key committed.
  const S = path.join(tmpRoot, `2731o-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio/agents', '.studio/locks', '.studio/gates', '.studio/train', '.studio/decisions.jsonl', 'studio/delegation.json', 'studio/approvals', 'studio/keys']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  if (fs.existsSync(path.join(dir, 'node_modules'))) { try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch {} }
  fs.rmSync(key, { force: true });
  g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
  g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
  const kg = run(S, 'node harness/approve.mjs keygen', owner);
  g(S, ['add', 'studio/keys']); g(S, ['commit', '-qm', 'keys: owner public key', '--no-verify']);
  const probe = (env, js) => {
    fs.writeFileSync(path.join(S, '.probe-2731o.mjs'), js);
    const r = run(S, 'node .probe-2731o.mjs', env);
    fs.rmSync(path.join(S, '.probe-2731o.mjs'), { force: true });
    try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { error: out(r).slice(-600) }; }
  };

  let grant = null;
  await guard('2.73.1 (o) proxy: `delegate -- proxy opus-1 --by pat --days 30` writes and commits ONE owner-signed grant (actions ["*"], proxy: true, 30 days); an agent\'s shell can\'t make one (fails on 2.73.0: no proxy command)', () => {
    const r = run(S, 'node harness/delegation.mjs proxy opus-1 --by pat --days 30 --why "run the studio while I am away"', owner);
    try { grant = JSON.parse(fs.readFileSync(path.join(S, 'studio/delegation.json'), 'utf8')); } catch { grant = null; }
    const logged = g(S, ['log', '-1', '--format=%s', '--', 'studio/delegation.json']).stdout.trim();
    const days = grant ? (Date.parse(grant.until) - Date.parse(grant.at)) / 86400000 : 0;
    const agentTry = run(S, 'node harness/delegation.mjs proxy opus-1 --by pat --no-commit', { ...owner, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' });
    return [kg.status === 0 && r.status === 0 && grant?.proxy === true && JSON.stringify(grant.actions) === '["*"]' && typeof grant.signature === 'string' && Math.round(days) === 30 && /delegate:/.test(logged) && agentTry.status !== 0,
      `${out(kg).slice(-200)}\n${out(r).slice(-400)}\n${JSON.stringify(grant).slice(0, 300)}\nlog: ${logged}\nagent: ${agentTry.status} ${out(agentTry).slice(-200)}`];
  });

  await guard('2.73.1 (o) proxy covers: in opus-1\'s shell delegationFor covers any action (train-release, unpark, resume) with --by opus-1 or --by pat; never keys, a launched session or another shell; permissionText("") is the grant\'s words there and "" elsewhere (fails on 2.73.0)', () => {
    const js = (action, by) => `import('./harness/delegation.mjs').then((m) => { const d = m.delegationFor({ action: ${JSON.stringify(action)}, by: ${JSON.stringify(by)} }); console.log(JSON.stringify({ ok: d.ok, why: d.why, proxy: d.proxy })); });`;
    const p = (env, action, by) => probe(env, js(action, by));
    const words = (env) => probe(env, "import('./harness/permission.mjs').then((m) => console.log(JSON.stringify({ t: m.permissionText('') })));").t;
    const rows = {
      release: p(proxy, 'train-release', 'opus-1'), unpark: p(proxy, 'unpark', 'pat'), resume: p(proxy, 'resume', 'opus-1'),
      keys: p(proxy, 'keys', 'opus-1'), launched: p({ ...proxy, STUDIO_ROLE: 'builder' }, 'train-release', 'opus-1'),
      other: p({ ...proxy, STUDIO_LOCK_OWNER: 'helper-x' }, 'train-release', 'pat'), patOwnShell: p(owner, 'train-release', 'pat'),
      wordsProxy: words(proxy), wordsOther: words({ ...proxy, STUDIO_LOCK_OWNER: 'helper-x' }), wordsWorker: words({ ...proxy, STUDIO_ROLE: 'builder' }),
    };
    return [rows.release.ok && rows.unpark.ok && rows.resume.ok && rows.release.proxy === true && !rows.keys.ok && !rows.launched.ok && !rows.other.ok && !rows.patOwnShell.ok
      && /owner proxy: the standing grant to opus-1 by pat/.test(rows.wordsProxy || '') && rows.wordsOther === '' && rows.wordsWorker === '', JSON.stringify(rows).slice(0, 1400)];
  });

  // A lane with a protected change (studio/gates.json is on the shipped protected list).
  const lane = path.join(tmpRoot, `2731o-lane-${process.pid}`);
  g(S, ['worktree', 'add', '-q', '-b', 'feat-2731o', lane]);
  const gates = path.join(lane, 'studio', 'gates.json');
  let gj = {};
  try { gj = JSON.parse(fs.readFileSync(gates, 'utf8')); } catch {}
  fs.writeFileSync(gates, `${JSON.stringify({ ...gj, note2731o: 'a protected change' }, null, 2)}\n`);
  g(lane, ['add', 'studio/gates.json']); g(lane, ['commit', '-qm', 'gates: a protected change', '--no-verify']);
  const show = (env = proxy) => run(lane, 'node harness/approve.mjs show', env);
  let apFile = null;
  await guard('2.73.1 (o) proxy approval: without the private key, `approve -- protected --by pat` in opus-1\'s shell is refused without the owner\'s yes, and with --permission "<the yes>" writes an approval carrying the signed grant (no signature) that `approve -- show` accepts (fails on 2.73.0: "no owner key at …")', () => {
    const before = show();
    const noYes = run(lane, 'node harness/approve.mjs protected --note "the owner agreed to this gates change" --by pat', proxy);
    const yes = run(lane, 'node harness/approve.mjs protected --note "the owner agreed to this gates change" --by pat --permission "Pat on chat 20:05: yes, ship the gates change"', proxy);
    const dirA = path.join(lane, 'studio', 'approvals');
    const files = fs.existsSync(dirA) ? fs.readdirSync(dirA).filter((f) => /^protected-/.test(f)) : [];
    apFile = files[0] ? path.join('studio', 'approvals', files[0]) : null;
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(lane, apFile), 'utf8')); } catch {}
    const after = show();
    return [before.status !== 0 && noYes.status !== 0 && /--permission/.test(out(noYes)) && yes.status === 0 && doc && doc.signature === null && doc.proxy?.grant?.signature === grant?.signature
      && doc.approval?.recordedBy === 'opus-1' && /yes, ship/.test(doc.approval?.permission || '') && after.status === 0,
      `before ${before.status}: ${out(before).slice(-200)}\nnoYes ${noYes.status}: ${out(noYes).slice(-300)}\nyes ${yes.status}: ${out(yes).slice(-300)}\n${JSON.stringify(doc?.approval || null).slice(0, 300)}\nafter ${after.status}: ${out(after).slice(-200)}`];
  });

  await guard('2.73.1 (o) proxy approval: committed in a builder\'s commit (Studio-Agent: builder-s1) it doesn\'t count; in the proxy\'s own commit it does; after `delegate -- revoke` on main it no longer counts (fails on 2.73.0)', () => {
    if (!apFile) return [false, 'no approval file from the previous check'];
    g(lane, ['add', apFile]);
    g(lane, ['commit', '-qm', 'approval\n\nStudio-Agent: builder-s1', '--no-verify']);
    const builder = show();
    g(lane, ['commit', '-q', '--amend', '-m', 'approval\n\nStudio-Agent: opus-1', '--no-verify']);
    const own = show();
    const rv = run(S, 'node harness/delegation.mjs revoke --by pat', owner);
    const revoked = show();
    return [builder.status !== 0 && own.status === 0 && rv.status === 0 && revoked.status !== 0,
      `builder ${builder.status}: ${out(builder).slice(-200)}\nown ${own.status}: ${out(own).slice(-200)}\nrevoke ${rv.status}: ${out(rv).slice(-200)}\nrevoked ${revoked.status}: ${out(revoked).slice(-200)}`];
  });

  await guard('2.73.1 (o) compat: a 2.67-style grant (train-release only, signed) still verifies and covers only its actions; the proxy\'s words are gone with it (fails on 2.73.0 only for the unpark row: none there either)', () => {
    const r = run(S, 'node harness/delegation.mjs grant opus-1 --actions train-release --hours 2 --by pat --why "a short grant"', owner);
    const js = (action) => `import('./harness/delegation.mjs').then((m) => { const d = m.delegationFor({ action: ${JSON.stringify(action)}, by: 'opus-1' }); console.log(JSON.stringify({ ok: d.ok, proxy: d.proxy || false, why: d.why })); });`;
    const rel = probe(proxy, js('train-release'));
    const unpark = probe(proxy, js('unpark'));
    const words = probe(proxy, "import('./harness/permission.mjs').then((m) => console.log(JSON.stringify({ t: m.permissionText('') })));").t;
    return [r.status === 0 && rel.ok && !rel.proxy && !unpark.ok && words === '', `${out(r).slice(-300)}\n${JSON.stringify({ rel, unpark, words })}`];
  });

  try { g(S, ['worktree', 'remove', '--force', lane]); } catch {}
  for (const p of [S, lane, key]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} }
}

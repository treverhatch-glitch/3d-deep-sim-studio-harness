/**
 * qa/selftest-277m.mjs — 2.77.0 (helper m): Windows-safe remote worker names, and tests for the maintainer's owner
 * command rules and scoped agents.
 *   owner     remote workers' lock owner is `remote-<worker>` (a colon is an NTFS stream separator); the old `remote:` form is still recognized
 *   rules     OWNER_RULES carry npm and npm.cmd prefix rules for agent stop/pause, task park/block/unblock/pause, beta on/off;
 *             narrowRule accepts each and refuses broad rules; `claude-settings --owner --dir <folder> --write` writes them in beta mode
 *   agents    .claude/agents/scout.md, fixer.md, architect.md: name + model haiku/sonnet/opus; scout has no Edit/Write
 * Each check fails on 2.76.0.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest277M({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: 'pat@example.invalid', GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: 'pat@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const imp = (rel) => import(`${pathToFileURL(path.join(dir, rel)).href}?m=${Date.now()}`);
  const NEW_CMDS = ['agent -- stop', 'agent -- pause', 'task -- park', 'task -- block', 'task -- unblock', 'task -- pause', 'beta -- on', 'beta -- off'];

  await guard('2.77.0 (m) owner: the remote worker\'s lock owner is remote-<worker> (no colon), the old remote:<worker> is still recognized, never written (fails on 2.76.0: no helper)', async () => {
    const m = await imp('harness/remote-workers.mjs');
    const src = fs.readFileSync(path.join(dir, 'harness/remote-workers.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const made = `${m.OWNER_PREFIX}web1`;
    const ok = made === 'remote-web1' && typeof m.isRemoteOwner === 'function' && m.isRemoteOwner('remote-web1') && m.isRemoteOwner('remote:web1') && !m.isRemoteOwner('builder-1') && !m.isRemoteOwner(null)
      && !/(?<![A-Z_])OWNER_PREFIX\s*=\s*'remote:'/.test(src);
    return [ok, `owner ${made}`];
  });

  await guard('2.77.0 (m) rules: OWNER_RULES has the npm and npm.cmd prefix rule for each of agent stop/pause, task park/block/unblock/pause, beta on/off; narrowRule accepts each and refuses broad rules (fails on 2.76.0)', async () => {
    const d = await imp('harness/delegation.mjs');
    const want = NEW_CMDS.flatMap((c) => [`Bash(npm run ${c}:*)`, `Bash(npm.cmd run ${c}:*)`]);
    const missing = want.filter((r) => !d.OWNER_RULES.includes(r));
    const refused = want.filter((r) => !d.narrowRule(r));
    const broad = ['Bash(npm run:*)', 'Bash(*)', 'Bash(npm.cmd run:*)', 'Bash(npm run beta:*)', 'Bash(npm run agent --:*)'].filter((r) => d.narrowRule(r));
    return [!missing.length && !refused.length && !broad.length, `missing ${missing} refused ${refused} broad-accepted ${broad}`];
  });

  await guard('2.77.0 (m) settings: in beta mode `delegate -- claude-settings --owner --dir <folder> --write` writes the new owner rules, and no broad rule (fails on 2.76.0)', () => {
    const key = path.join(tmpRoot, `owner-277m-${process.pid}.pem`);
    const base = {
      ...ident, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_LOCK_OWNER: '',
      STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off',
      STUDIO_GATE_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', NODE_OPTIONS: '', GITHUB_BASE_REF: '',
    };
    const owner = { ...base, STUDIO_OWNER_KEY: key };
    const patch = { ...base, STUDIO_LOCK_OWNER: 'opus-1', STUDIO_OWNER_KEY: path.join(tmpRoot, 'no-owner-key-277m.pem') };
    const S = path.join(tmpRoot, `277m-${process.pid}`);
    try {
      fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
      for (const x of ['.studio/agents', '.studio/locks', '.studio/gates', '.studio/train', '.studio/decisions.jsonl', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/asks']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
      fs.rmSync(key, { force: true });
      g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
      g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
      const kg = run(S, 'node harness/approve.mjs keygen', owner);
      g(S, ['add', 'studio/keys']); g(S, ['commit', '-qm', 'keys', '--no-verify']);
      const on = run(S, 'node harness/beta-mode.mjs on --by pat --agents opus-1 --why "test"', owner);
      const sess = path.join(tmpRoot, `277m-session-${process.pid}`);
      fs.mkdirSync(sess, { recursive: true });
      const w = run(S, `node harness/delegation.mjs claude-settings --owner --actions train-release --dir ${JSON.stringify(sess)} --write`, patch);
      let s = null;
      try { s = JSON.parse(fs.readFileSync(path.join(sess, '.claude', 'settings.json'), 'utf8')); } catch {}
      const allow = s?.permissions?.allow || [];
      const want = NEW_CMDS.flatMap((c) => [`Bash(npm run ${c}:*)`, `Bash(npm.cmd run ${c}:*)`]);
      const missing = want.filter((r) => !allow.includes(r));
      const broad = allow.some((r) => /Bash\(\*\)|^Bash\(npm( run|\.cmd run):\*\)$/.test(r));
      return [kg.status === 0 && on.status === 0 && w.status === 0 && !missing.length && !broad, `keygen ${kg.status} beta ${on.status} ${out(on).slice(-150)} write ${w.status} ${out(w).slice(-200)} missing ${missing}`];
    } finally { for (const p of [S, key]) { try { fs.rmSync(p, { recursive: true, force: true }); } catch {} } }
  });

  await guard('2.77.0 (m) agents: .claude/agents has scout (haiku), fixer (sonnet), architect (opus) with a name; scout\'s tools have no Edit/Write (fails on 2.76.0: no scoped agents)', () => {
    const fm = (n) => {
      const f = path.join(dir, '.claude', 'agents', `${n}.md`);
      if (!fs.existsSync(f)) return null;
      const m = fs.readFileSync(f, 'utf8').replace(/\r\n/g, '\n').match(/^---\n([\s\S]*?)\n---/);
      const o = {};
      for (const l of (m ? m[1] : '').split('\n')) { const k = l.match(/^([\w-]+):\s*(.*)$/); if (k) o[k[1]] = k[2].trim(); }
      return o;
    };
    const a = { scout: fm('scout'), fixer: fm('fixer'), architect: fm('architect') };
    const ok = a.scout?.name === 'scout' && a.scout.model === 'haiku' && a.fixer?.name === 'fixer' && a.fixer.model === 'sonnet' && a.architect?.name === 'architect' && a.architect.model === 'opus'
      && Boolean(a.scout.tools) && !/\b(Edit|Write|MultiEdit|NotebookEdit)\b/.test(a.scout.tools);
    return [ok, JSON.stringify(a)];
  });
}

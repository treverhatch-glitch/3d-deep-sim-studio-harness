/**
 * qa/selftest-283j.mjs — 2.83: the owner-only list tells code removed in a lane from deleted data.
 *
 * A crew's owner was paged for a task that removed three unwired modules: the owner's proxy was refused it. The list
 * (harness/owner-acts.mjs) now reads that for what it is, and nothing else: one word of data keeps the question the
 * owner's. A stand-in's answer to such an ask records the reading.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import { pathToFileURL } from 'node:url';

export async function selftest283J({ dir, report, tmpRoot, root }) {
  const guard = async (name, fn) => { try { const [ok, d] = await fn(); report(name, ok, d); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 1500)); } };
  const { ownerOnlyTopic, ownerOnlyReadAs, ownerOnlyAction } = await import(pathToFileURL(path.join(dir, 'harness', 'owner-acts.mjs')).href);
  const act = (q, why = '') => ownerOnlyTopic(q, why)?.act || null;
  const wrong = (cases) => cases.filter(([q, want]) => act(q) !== want).map(([q, want]) => `${JSON.stringify(q)}: got ${act(q)}, want ${want}`);

  const code = [
    ['T-456 (delete the unwired staff/, prestige/, gates/ modules with their tests) passed and is queued. Release it?', null],
    ['Delete the old helper functions in ui/panel.ts?', null],
    ['The port is live: delete the unused code of the old pathfinding module in this lane?', null],
  ];
  const data = [
    ['Delete the backups of the unwired modules?', 'delete'],
    ['Wipe the unused modules?', 'delete'],
    ['Delete the repo history of the test files?', 'delete'],
    ['Delete the save files?', 'delete'],
    ['Delete the branch with the unused code?', 'delete'],
    ['Delete the worktree of the old module?', 'delete'],
    ['Delete the lane of the old module?', 'delete'],
    ['Delete it?', 'delete'],
    ['Delete the unused test files with rm -rf?', 'delete'],
    ['Delete the events log and the old scripts?', 'delete'],
    ['Purge the dead code?', 'delete'],
    ['Delete .studio and the unused scripts?', 'delete'],
  ];
  await guard('2.83 the owner-only list, delete: removing code through a lane (modules, functions, tests, a named source file) is not the owner\'s "deleting data": it is reviewed and stays in git history (fails before this fix: a task that removed three unwired modules waited for the owner in person)', () => {
    const w = wrong(code); return [w.length === 0, w.join(' | ').slice(0, 1500)];
  });
  await guard('2.83 the owner-only list, delete: anything that names data stays the owner\'s (backups, history, saves, a branch, a worktree, logs, .studio), so does a wipe, purge or rm -r of anything, and so does a bare "delete it?"', () => {
    const w = wrong(data); return [w.length === 0, w.join(' | ').slice(0, 1500)];
  });
  await guard('2.83 the owner-only list: the action names are untouched (a delegation for "delete" or "wipe" is refused to a stand-in as before), keys and publishing are read as before, and each reading names itself', () => {
    const acts = ['delete', 'wipe'].every((a) => ownerOnlyAction(a));
    const others = act('Rotate the API key the player service uses?') === 'credentials' && act('Publish the in-game shop page?') === 'publish';
    const r2 = ownerOnlyReadAs(code[0][0]); const r3 = ownerOnlyReadAs(data[0][0]);
    return [acts && others && r2.length === 1 && r2[0].act === 'delete' && /not deleting data/.test(r2[0].why) && r3.length === 0,
      JSON.stringify({ acts, others, r2, r3 }).slice(0, 900)];
  });

  // The studio's own command list is the owner's to change, and never a blanket.
  await guard('2.83 the studio\'s own command list: studio/allowlist.json is on the protected list (an agent\'s lane cannot widen what agents may run without the owner\'s signed approval), and an entry whose pattern starts with a wildcard is skipped with a reason while a named command is kept', async () => {
    const prot = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'protected.json'), 'utf8'));
    const m = await import(pathToFileURL(path.join(dir, 'harness', 'allowlist.mjs')).href);
    const S = fs.mkdtempSync(path.join(tmpRoot, '283j-allow-'));
    fs.mkdirSync(path.join(S, 'studio'), { recursive: true });
    fs.writeFileSync(path.join(S, 'studio', 'allowlist.json'), JSON.stringify([['all', '*'], ['all2', ' * --x'], ['short', 'a *'], ['quoted', '"*" x'], ['tool', '/opt/tool/bin/tool *'], ['exact', 'tool --version']]));
    const r = m.studioAllowed(S);
    return [prot.globs.includes('studio/allowlist.json') && r.entries.map((e) => e[0]).join() === 'tool,exact' && r.problems.filter((x) => /starts with a wildcard/.test(x)).length === 4,
      JSON.stringify({ protectedHas: prot.globs.includes('studio/allowlist.json'), r }).slice(0, 900)];
  });

  // Through the real command, in a studio with beta mode on (the overseer the owner named answers asks for the owner):
  // the question about deleting save files is refused and stays open; the question about removing a module is answered.
  {
    const S = fs.mkdtempSync(path.join(tmpRoot, '283j-studio-'));
    const nm = path.join(root || dir, 'node_modules');
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/asks', 'studio/delegation.json', '.env']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    const writeIn = (rel, text) => { fs.mkdirSync(path.dirname(path.join(S, rel)), { recursive: true }); fs.writeFileSync(path.join(S, rel), text); };
    writeIn('.studio/events-283j.jsonl', '');
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    writeIn('studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    writeIn('studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
    const g = (...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd: S, encoding: 'utf8', env: gEnv() });
    g('init', '-q', '-b', 'main'); g('add', '-A'); g('commit', '-qm', 'studio, owner key, beta on', '--no-verify');
    const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_OUTSIDE_SIGNERS: '', CLAUDECODE: '', AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-283j.jsonl') };
    const node = (args, extra = {}) => spawnSync(process.execPath, args, { cwd: S, encoding: 'utf8', windowsHide: true, timeout: 120000, env: { ...process.env, ...ident, ...base, ...extra } });
    const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
    const asked = [
      node(['harness/ask.mjs', 'Delete the save files of the old build?', '--by', 'builder-s1'], { STUDIO_LOCK_OWNER: 'builder-s1' }),
      node(['harness/ask.mjs', 'T-9 removes the unwired shop/ module with its tests: go ahead?', '--by', 'builder-s1'], { STUDIO_LOCK_OWNER: 'builder-s1' }),
    ];
    const orch = { CLAUDECODE: '1' };
    const a2 = node(['harness/ask.mjs', 'answer', 'A-001', 'yes', '--by', 'overseer-1'], orch);
    const a3 = node(['harness/ask.mjs', 'answer', 'A-002', 'yes', '--by', 'overseer-1'], orch);
    const doc = (id) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'asks', `${id}.json`), 'utf8')); } catch { return null; } };
    const d2 = doc('A-001'); const d3 = doc('A-002');
    await guard('2.83 the owner-only list, through the ask command (beta mode, the overseer the owner named): a question about deleting save files is refused to it and stays open; a question about removing a module is answered, with no reading to record', () => [
      a2.status !== 0 && /deleting data/.test(out(a2)) && d2?.status === 'open'
        && a3.status === 0 && d3?.status === 'answered' && !d3.readAs,
      `${asked.map((r) => out(r).slice(-120)).join(' | ')} || ${out(a2).slice(-300)} | ${out(a3).slice(-200)} | ${JSON.stringify({ d2: d2 && d2.status, d3: d3 && { s: d3.status, readAs: d3.readAs } })}`.slice(0, 2200)]);
    try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
}

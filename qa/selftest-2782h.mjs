/**
 * qa/selftest-2782h.mjs — 2.78.2 (h): who makes which beta decision (the owner's rule, 2026-11-05), and one predicate for
 * every beta record (the 2.79 audit D1.1, reproduced by 2.78.2 (e)'s 7e).
 *   h1  a builder drops (never commits) a beta-format protected or force approval into studio/approvals/, which a lane
 *       copy shares through its studio/ link: the protected check and forceApproved accepted it.
 *   h2  a beta approval committed by a worker: a launched session whose name isn't worker-shaped (a sound session) counted.
 *   h3  the outside orchestrator's own approval: counts once committed, not before.
 *   h4  a Producer session's protected approval: refused unless the owner's switch; its board decisions stay; one made
 *       before 2.78.2 keeps counting until beta mode's session changes.
 *   h5  a Producer's lane release applied a held protected config part.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest2782H({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_HARNESS_REF: '', STUDIO_KEY_BASE: '', STUDIO_LANE_EVENTS: '', STUDIO_PRODUCER_APPROVES: '', STUDIO_MAIN_CHECKOUT_ENFORCE: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-2782h-${process.pid}.pem`) };
  let n = 0;
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
  const probe = (cwd, code, env) => { const f = path.join(cwd, `.probe-2782h-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(cwd, [f], env); fs.rmSync(f, { force: true }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const PROT = 'qa/controls-check.mjs';
  const BETA_AT = '2026-11-05T01:00:00.000Z';
  // A studio with an owner key and beta mode on (opus-1 the named outside agent), committed on main, and a builder's lane
  // copy made the way the launcher makes one (.lanes/<agent>, sparse without studio/ and .studio/, both linked to main's)
  // with a committed protected edit.
  const studio = (name) => {
    const S = path.join(tmpRoot, `2782h-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', 'studio/approvals', 'studio/keys', 'studio/beta.json', '.env']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    writeIn(S, '.studio/events-2782h.jsonl', '');
    writeIn(S, '.gitignore', `${fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') : ''}\n/.lanes/\n/.studio/\n.env\n`);
    const { publicKey } = crypto.generateKeyPairSync('ed25519');
    writeIn(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: BETA_AT, why: 'beta for the selftest', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    g(S, 'init', '-q', '-b', 'main'); g(S, 'config', 'core.autocrlf', 'false'); g(S, 'config', 'core.eol', 'lf');
    g(S, 'config', 'user.name', 't'); g(S, 'config', 'user.email', 't@example.invalid');
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio, owner key, beta on', '--no-verify');
    const L = path.join(S, '.lanes', 'builder-s1');
    g(S, 'worktree', 'add', '-q', '--no-checkout', '-b', 'lane/builder-s1', L);
    g(L, 'config', 'extensions.worktreeConfig', 'true');
    g(L, 'config', '--worktree', 'sparse.expectFilesOutsideOfPatterns', 'true');
    g(L, 'sparse-checkout', 'set', '--no-cone', '/*', '!/studio/', '!/.studio/');
    g(L, 'checkout', '-q', 'lane/builder-s1');
    fs.symlinkSync(path.join(S, 'studio'), path.join(L, 'studio'), process.platform === 'win32' ? 'junction' : 'dir');
    fs.symlinkSync(path.join(S, '.studio'), path.join(L, '.studio'), process.platform === 'win32' ? 'junction' : 'dir');
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(L, 'node_modules'), 'junction'); } catch {} }
    const ex = path.join(S, '.studio', 'lanes', 'builder-s1.exclude');
    writeIn(S, path.relative(S, ex), ['/studio', '/.studio', '/.env', 'node_modules', ''].join('\n'));
    g(L, 'config', '--worktree', 'core.excludesFile', ex);
    fs.appendFileSync(path.join(L, PROT), '\n// a builder edits a protected check\n');
    g(L, 'add', '-A'); g(L, 'commit', '-qm', 'builder: edit the controls check', '-m', 'Studio-Agent: builder-s1', '--no-verify');
    const env = { ...base, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-2782h.jsonl') };
    return { S, L, env };
  };
  const show = (L, env) => node(L, ['harness/approve.mjs', 'show'], env);
  const okShow = (r) => r.status === 0 && /OK: approved by/.test(out(r));
  // The beta-format approval of exactly the lane's change set, as `approve -- protected` writes it in beta mode.
  const record = (L, env, approval) => probe(L, `const a = await import(${u(L, 'harness/approve.mjs')}); const r = a.checkProtected(); console.log(JSON.stringify({ doc: { approval: { kind: 'protected', change: r.change, files: r.changes, base: r.base, by: 'pat', note: 'approved for the selftest', at: new Date().toISOString(), ...${JSON.stringify(approval)} }, signature: null, beta: { by: 'pat', at: ${JSON.stringify(BETA_AT)} } } }));`, env).j?.doc;
  const put = (S, name, doc) => writeIn(S, `studio/approvals/${name}.json`, `${JSON.stringify(doc, null, 2)}\n`);
  const commitIn = (S, rel, agent) => { g(S, 'add', '--', rel); return g(S, 'commit', '-qm', `approval ${path.basename(rel)}`, ...(agent ? ['-m', `Studio-Agent: ${agent}`] : []), '--no-verify', '--', rel); };

  // ---- h1: a dropped, uncommitted beta approval (protected, force) and a JSON naming another file ----
  {
    const { S, L, env } = studio('h1');
    const before = show(L, env);
    const doc = record(L, env, { recordedBy: 'opus-1', via: 'beta agent' });
    put(S, 'protected-dropped', doc); // dropped through the lane's studio/ link: it lands in the main checkout's folder
    const after = show(L, env);
    put(S, 'force-T-901', { approval: { kind: 'force', task: 'T-901', reason: 'dropped by a builder, never committed', by: 'pat', at: new Date().toISOString(), recordedBy: 'opus-1', via: 'beta agent' }, signature: null, beta: { by: 'pat', at: BETA_AT } });
    put(S, 'zz-named', { file: 'studio/approvals/elsewhere.json', approval: { kind: 'note' } });
    const p = probe(L, `const a = await import(${u(L, 'harness/approve.mjs')}); console.log(JSON.stringify({ force: a.forceApproved('T-901'), named: (a.readApprovals().find((x) => x.approval?.kind === 'note') || {}).file }));`, env);
    await guard('2.78.2 (h, h1; the 2.79 audit D1.1): in a lane copy, a builder-dropped, uncommitted beta-format approval (recordedBy the orchestrator, under the beta session on now) of exactly the lane\'s protected change set is REFUSED by the protected check, which says it isn\'t committed, and a dropped force approval doesn\'t let task done --force pass; readApprovals names each record by its real file, not a "file" key in the JSON (fails on 2.78.1: verifyApproval\'s beta branch took committedByAgent()=null, uncommitted, as fine, so both passed, and the JSON\'s own "file" won)', () => [
      before.status === 3 && Boolean(doc?.approval?.change) && after.status === 3 && /isn't committed/.test(out(after)) && p.j?.force?.ok === false && p.j?.named === 'studio/approvals/zz-named.json',
      JSON.stringify({ before: out(before).slice(-160), after: out(after).slice(-400), p: p.j || out(p).slice(-300) })]);
  }

  // ---- h2: committed by a worker (a worker-shaped name; a launched session whose name isn't) ----
  {
    const { S, L, env } = studio('h2');
    const doc = record(L, env, { recordedBy: 'opus-1', via: 'beta agent' });
    put(S, 'protected-w1', doc);
    commitIn(S, 'studio/approvals/protected-w1.json', 'builder-s1');
    const byBuilder = show(L, env);
    // A launched sound session (its session record says role sound) commits the same record.
    writeIn(S, '.studio/agents/sound-s2.json', `${JSON.stringify({ agent: 'sound-s2', role: 'sound', status: 'running' }, null, 2)}\n`);
    fs.rmSync(path.join(S, 'studio/approvals/protected-w1.json'));
    g(S, 'add', '-A', 'studio/approvals'); g(S, 'commit', '-qm', 'drop it', '--no-verify');
    put(S, 'protected-w2', doc);
    commitIn(S, 'studio/approvals/protected-w2.json', 'sound-s2');
    const bySound = show(L, env);
    await guard('2.78.2 (h, h2): a committed beta approval doesn\'t count when the commit is a worker\'s: a builder (builder-s1) or a launched session of any worker role, judged by its session record (sound-s2, role sound, a name the worker list doesn\'t have) (fails on 2.78.1: in a lane copy the commit was looked up in the lane\'s own history, where the linked studio/ has none, so even builder-s1\'s commit counted as uncommitted, i.e. fine; and only the worker-name list was asked, which hasn\'t sound-s2)', () => [
      Boolean(doc?.approval?.change) && byBuilder.status === 3 && bySound.status === 3,
      JSON.stringify({ byBuilder: out(byBuilder).slice(-300), bySound: out(bySound).slice(-300) })]);
  }

  // ---- h3: the outside orchestrator's own approval, committed ----
  {
    const { S, L, env } = studio('h3');
    const orch = { ...env, STUDIO_LOCK_OWNER: 'opus-1', CLAUDECODE: '1' };
    const made = node(L, ['harness/approve.mjs', 'protected', '--note', 'the orchestrator re-pins the controls check', '--by', 'pat'], orch);
    const file = (fs.readdirSync(path.join(S, 'studio', 'approvals')).find((f) => f.startsWith('protected-')) || '');
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'approvals', file), 'utf8')); } catch {}
    const uncommitted = show(L, env);
    const c = commitIn(S, `studio/approvals/${file}`, 'opus-1');
    const committed = show(L, env);
    await guard('2.78.2 (h, h3): the outside orchestrator (opus-1, beta mode\'s named agent, not launched by the harness) approves a lane\'s protected change in beta mode: `approve -- protected` writes it (decides: protected) and says to commit it; it counts once committed in the main checkout (the lane copy\'s studio/ link), not before (fails on 2.78.1: it counted uncommitted, the same gap as h1)', () => [
      made.status === 0 && /commit studio\/approvals\/protected-/.test(out(made)) && doc?.approval?.via === 'beta agent' && doc?.approval?.decides === 'protected'
        && uncommitted.status === 3 && c.status === 0 && okShow(committed),
      JSON.stringify({ made: out(made).slice(-400), via: doc?.approval?.via, decides: doc?.approval?.decides, uncommitted: out(uncommitted).slice(-200), committed: out(committed).slice(-200) })]);
  }

  // ---- h4: a Producer session: protected refused by default, the owner's switch, board decisions, grandfathered ----
  {
    const { S, L, env } = studio('h4');
    const prod = { ...env, STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' };
    const refused = node(L, ['harness/approve.mjs', 'protected', '--note', 'the producer approves the controls check', '--by', 'pat'], prod);
    const wrote = fs.existsSync(path.join(S, 'studio', 'approvals')) && fs.readdirSync(path.join(S, 'studio', 'approvals')).some((f) => f.startsWith('protected-'));
    const forced = node(L, ['harness/approve.mjs', 'force', 'T-902', '--reason', 'the producer closes it without its check', '--by', 'pat'], prod);
    // Board decisions stay: betaActor for a task type; a committed beta type record the Producer made counts.
    writeIn(S, 'studio/approvals/type-T-903.json', `${JSON.stringify({ approval: { kind: 'type', task: 'T-903', type: 'harness', by: 'pat', at: new Date().toISOString(), recordedBy: 'producer-s1', via: 'beta producer', decides: 'board' }, signature: null, beta: { by: 'pat', at: BETA_AT } }, null, 2)}\n`);
    commitIn(S, 'studio/approvals/type-T-903.json', 'producer-s1');
    const board = probe(S, `const bm = await import(${u(S, 'harness/beta-mode.mjs')}); const fs = await import('node:fs'); const doc = JSON.parse(fs.readFileSync('studio/approvals/type-T-903.json', 'utf8')); console.log(JSON.stringify({ actor: bm.betaActor({ kind: 'type' }).ok, prot: bm.betaActor({ kind: 'protected' }), rec: bm.betaRecordCommitted(process.cwd(), 'studio/approvals/type-T-903.json', doc) }));`, prod);
    // The owner's switch, in the main checkout's .env: the Producer's approval is written, and counts once committed.
    writeIn(S, '.env', 'STUDIO_PRODUCER_APPROVES=protected\n');
    const switched = node(L, ['harness/approve.mjs', 'protected', '--note', 'the producer approves the controls check', '--by', 'pat'], prod);
    const file = (fs.readdirSync(path.join(S, 'studio', 'approvals')).find((f) => f.startsWith('protected-')) || '');
    commitIn(S, `studio/approvals/${file}`, 'producer-s1');
    const on = show(L, env);
    writeIn(S, '.env', '');
    const off = show(L, env);
    // A Producer's protected approval committed before 2.78.2 (no decides field): counts until beta mode's session changes.
    const old = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'approvals', file), 'utf8'));
    delete old.approval.decides;
    put(S, path.basename(file, '.json'), old);
    commitIn(S, `studio/approvals/${file}`, 'producer-s1');
    const grand = show(L, env);
    writeIn(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-06T02:00:00.000Z', why: 'beta again', agents: ['opus-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    g(S, 'add', '--', 'studio/beta.json'); g(S, 'commit', '-qm', 'beta on again', '--no-verify', '--', 'studio/beta.json');
    const newSession = show(L, env);
    await guard('2.78.2 (h, h4): a launched Producer session in beta mode: `approve -- protected` and `approve -- force` are refused, saying to ask the orchestrator (opus-1) or the owner, and nothing is written; its board decisions stand (betaActor for a task type, a committed type record it made); with the owner\'s switch STUDIO_PRODUCER_APPROVES=protected in the main checkout\'s .env its protected approval is written and counts once committed, and stops counting when the switch is off; one recorded before 2.78.2 (no decides) counts until beta mode\'s session changes (fails on 2.78.1: the Producer\'s protected and force approvals were written and counted, as every beta actor\'s)', () => [
      refused.status === 1 && /ask the orchestrator \(opus-1\) or the owner/.test(out(refused)) && !wrote && forced.status === 1 && /ask the orchestrator/.test(out(forced))
        && board.j?.actor === true && board.j?.prot?.ok === false && board.j?.prot?.refused === true && board.j?.rec === true
        && switched.status === 0 && Boolean(file) && okShow(on) && off.status === 3 && okShow(grand) && newSession.status === 3,
      JSON.stringify({ refused: out(refused).slice(-400), wrote, forced: out(forced).slice(-200), board: board.j || out(board).slice(-300), switched: out(switched).slice(-300), on: out(on).slice(-200), off: out(off).slice(-300), grand: out(grand).slice(-200), newSession: out(newSession).slice(-200) })]);
  }

  // ---- h5: a lane release by a Producer no longer applies a held protected config part ----
  {
    const { S, env } = studio('h5');
    const code = `const cp = await import(${u(S, 'harness/config-proposal.mjs')}); const at = ${JSON.stringify(BETA_AT)}; const ok = (r) => cp.betaReleaseOk(r, process.cwd());
console.log(JSON.stringify({
  producer: ok({ by: 'producer-s1', beta: 'beta producer', betaAt: at, decides: 'board' }),
  producerDelegated: ok({ by: 'pat', recordedBy: 'producer-s1', beta: true, betaAt: at, decides: 'board' }),
  orchestrator: ok({ by: 'pat', recordedBy: 'opus-1', beta: true, betaAt: at, decides: 'board' }),
  old: ok({ by: 'producer-s1', beta: 'beta producer', betaAt: at }),
  worker: ok({ by: 'builder-s1', beta: true, betaAt: at }),
}));`;
    const off = probe(S, code, env);
    writeIn(S, '.env', 'STUDIO_PRODUCER_APPROVES=protected\n');
    const on = probe(S, code, env);
    const o = off.j || {}; const s = on.j || {};
    await guard('2.78.2 (h, h5): applying a held protected config part is a protected decision: a lane release recorded by a Producer session (as itself, or recorded for the owner) doesn\'t apply it, the orchestrator\'s does, one made before 2.78.2 (no decides) still does under the same beta session, a worker\'s never; with STUDIO_PRODUCER_APPROVES=protected the Producer\'s does (fails on 2.78.1: any non-worker beta release applied it)', () => [
      o.producer === false && o.producerDelegated === false && o.orchestrator === true && o.old === true && o.worker === false && s.producer === true && s.producerDelegated === true && s.worker === false,
      JSON.stringify({ off: off.j || out(off).slice(-300), on: on.j || out(on).slice(-300) })]);
  }
}

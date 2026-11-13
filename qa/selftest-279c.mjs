/**
 * qa/selftest-279c.mjs — 2.79 (c): the orchestrator signs for the owner in beta mode (the owner, 2026-11-06: "make it so
 * Patch can sign off on everything and not need me"; "Grokbot and Patch can approve as me"), what stays the owner's own,
 * and asks that repost after they were acted on (the crew's item 2.15, "cut the fat" 5.4 and 5.6).
 *   c1  asks: the orchestrator answers every kind (a protected-file ask too) with --by <its name>, from a shell that sets
 *       no STUDIO_LOCK_OWNER; logged (decisions log, an event with the actor); a Producer can't answer a protected one,
 *       a builder none.
 *   c2  outside signer: STUDIO_OUTSIDE_SIGNERS (the main checkout's .env) lets grokbot answer and approve as itself.
 *   c3  the owner-only list (deleting data, keys, publishing, beta off) refuses the orchestrator.
 *   c4  a release survives a catch-up merge of main that leaves the released files alone; a lane commit to one voids it;
 *       a builder can't release.
 *   c5  goldens: a merge of main is nobody's authorship, so the orchestrator who only refreshed the lane second-signs.
 *   c6  a harness ask posts once per state change; one whose task is no longer parked closes (ask.closed) and the same
 *       question back is counted for the digest, not posted.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest279C({ dir, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const nm = path.join(harnessRoot, 'node_modules');
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'core.autocrlf=false', '-c', 'core.eol=lf', '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
  const head = (cwd) => String(g(cwd, 'rev-parse', 'HEAD').stdout || '').trim();
  const writeIn = (cwd, rel, text) => { fs.mkdirSync(path.dirname(path.join(cwd, rel)), { recursive: true }); fs.writeFileSync(path.join(cwd, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const base = { STUDIO_REFILL_WAKE: 'off', STUDIO_WATCHDOG: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_TASK_BASE: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', STUDIO_HARNESS_REF: '', STUDIO_KEY_BASE: '', STUDIO_LANE_EVENTS: '', STUDIO_PRODUCER_APPROVES: '', STUDIO_OUTSIDE_SIGNERS: '', STUDIO_ASK_DIGEST_HOURS: '', STUDIO_MAIN_CHECKOUT_ENFORCE: '', STUDIO_PRODUCER_NAME: '', STUDIO_HOOKS_CHECK: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-279c-${process.pid}.pem`) };
  let n = 0;
  const node = (cwd, args, env) => spawnSync(process.execPath, args, { windowsHide: true, cwd, encoding: 'utf8', env: { ...process.env, ...ident, ...env }, timeout: 180000 });
  const probe = (cwd, code, env) => { const f = path.join(cwd, `.probe-279c-${++n}.mjs`); fs.writeFileSync(f, code); const r = node(cwd, [f], env); fs.rmSync(f, { force: true }); const l = String(r.stdout || '').trim().split('\n').filter((x) => x.startsWith('{')).pop(); let j = null; try { j = JSON.parse(l); } catch {} return { ...r, j }; };
  const u = (S, rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  const PROT = 'qa/controls-check.mjs';
  const BETA_AT = '2026-11-05T01:00:00.000Z';
  const events = (S) => { try { return fs.readFileSync(path.join(S, '.studio', 'events-279c.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const decisions = (S) => { try { return fs.readFileSync(path.join(S, '.studio', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  // A studio with an owner key and beta mode on (opus-1 the named outside agent, committed on main), and a builder's lane
  // copy made the way the launcher makes one, with a committed protected edit (as in qa/selftest-2782h.mjs).
  const studio = (name) => {
    const S = path.join(tmpRoot, `279c-${name}-${process.pid}-${++n}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
    for (const rel of ['.studio', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/asks', 'studio/delegation.json', 'studio/task-holds.json', '.env']) fs.rmSync(path.join(S, rel), { recursive: true, force: true });
    writeIn(S, '.studio/events-279c.jsonl', '');
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
    const env = { ...base, AGENT_EVENTS_FILE: path.join(S, '.studio', 'events-279c.jsonl') };
    return { S, L, env };
  };
  const askIn = (S, env, q) => node(S, ['harness/ask.mjs', q, '--by', 'builder-s1'], { ...env, STUDIO_LOCK_OWNER: 'builder-s1' });
  const answer = (S, env, id, by, extra = {}) => node(S, ['harness/ask.mjs', 'answer', id, 'yes', '--by', by], { ...env, ...extra });
  const askDoc = (S, id) => { try { return JSON.parse(fs.readFileSync(path.join(S, 'studio', 'asks', `${id}.json`), 'utf8')); } catch { return null; } };

  // ---- c1: asks, every kind, by the orchestrator; a Producer and a builder refused ----
  {
    const { S, env } = studio('c1');
    askIn(S, env, 'Re-pin the protected controls check (qa/controls-check.mjs) for T-174?'); // A-001, a protected-file ask
    askIn(S, env, 'Raise T-145\'s token budget to 2M?'); // A-002, a budget ask
    askIn(S, env, 'Re-pin the protected gate list for T-150?'); // A-003
    const prod = answer(S, env, 'A-003', 'producer-s1', { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' });
    const bld = answer(S, env, 'A-003', 'builder-s2', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s2' });
    const bldAsOwner = answer(S, env, 'A-003', 'pat', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s2' });
    // The orchestrator's chat shell: a coding agent's marker, no STUDIO_LOCK_OWNER, names itself with --by.
    const orch = { CLAUDECODE: '1' };
    const a1 = answer(S, env, 'A-001', 'opus-1', orch);
    const a2 = answer(S, env, 'A-002', 'opus-1', orch);
    const d1 = askDoc(S, 'A-001'); const d2 = askDoc(S, 'A-002'); const d3 = askDoc(S, 'A-003');
    const ev = events(S).filter((e) => e.type === 'ask.answered');
    const log = decisions(S).filter((d) => d.action === 'ask-answer');
    await guard('2.79 (c, c1): in beta mode the orchestrator answers any ask with `npm run ask -- answer A-x yes --by opus-1`, a protected-file ask and a budget ask too, from its chat shell (a coding agent\'s marker, no STUDIO_LOCK_OWNER); each is recorded as the owner\'s answer recorded by opus-1 (the ask file, an ask.answered event with opus-1 as its agent, a decisions-log entry); a Producer session is refused a protected-file ask (ask the orchestrator), a builder session every ask, also when it types the owner\'s name after --by, and that ask stays open (fails on 2.78.2: "A person answers" unless the shell set STUDIO_LOCK_OWNER=opus-1, no decisions-log entry, a Producer session answered protected-file asks as a board decision, and a builder session\'s --by pat counted as the owner\'s answer)', () => [
      a1.status === 0 && a2.status === 0 && d1?.status === 'answered' && d1.recordedBy === 'opus-1' && d1.answeredBy === 'pat' && d2?.recordedBy === 'opus-1'
        && ev.filter((e) => e.agent === 'opus-1').length === 2 && log.length === 2 && log.every((d) => d.by === 'opus-1')
        && prod.status === 1 && /ask the orchestrator/.test(out(prod)) && bld.status === 1 && bldAsOwner.status === 1 && d3?.status === 'open',
      JSON.stringify({ a1: out(a1).slice(-200), a2: out(a2).slice(-200), d1, ev: ev.map((e) => e.agent), log: log.length, prod: out(prod).slice(-300), bld: out(bld).slice(-200), bldAsOwner: out(bldAsOwner).slice(-200), d3: d3?.status })]);
  }

  // ---- c2: an outside signer (grokbot), named by the owner in the main checkout's .env ----
  {
    const { S, L, env } = studio('c2');
    askIn(S, env, 'Accept the re-recorded golden for T-200?');
    const before = answer(S, env, 'A-001', 'grokbot');
    const beforeDoc = askDoc(S, 'A-001');
    askIn(S, env, 'Accept the re-recorded golden for T-201?');
    // A builder session that names grokbot as an outside signer in its own environment gets nothing.
    const sneaky = answer(S, env, 'A-002', 'grokbot', { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s1', STUDIO_OUTSIDE_SIGNERS: 'grokbot' });
    const sneakyDoc = askDoc(S, 'A-002');
    writeIn(S, '.env', 'STUDIO_OUTSIDE_SIGNERS=grokbot\n');
    const after = answer(S, env, 'A-002', 'grokbot');
    const afterDoc = askDoc(S, 'A-002');
    // grokbot approves the lane's protected change as itself, in a shell that names nobody.
    const made = node(L, ['harness/approve.mjs', 'protected', '--note', 'grokbot re-pins the controls check for the owner', '--by', 'grokbot'], env);
    const file = (fs.existsSync(path.join(S, 'studio', 'approvals')) ? fs.readdirSync(path.join(S, 'studio', 'approvals')) : []).find((f) => f.startsWith('protected-')) || '';
    let doc = null;
    try { doc = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'approvals', file), 'utf8')); } catch {}
    if (file) { g(S, 'add', '--', `studio/approvals/${file}`); g(S, 'commit', '-qm', 'approval', '-m', 'Studio-Agent: grokbot', '--no-verify', '--', `studio/approvals/${file}`); }
    const show = node(L, ['harness/approve.mjs', 'show'], env);
    await guard('2.79 (c, c2): an outside signer the owner lists (STUDIO_OUTSIDE_SIGNERS=grokbot in the main checkout\'s .env) signs as itself under beta mode with --by grokbot, from a shell that names nobody: its answer is recorded as the owner\'s, recorded by grokbot, and its `approve -- protected` writes an approval recorded by grokbot that the protected check accepts once committed; before the owner lists it, --by grokbot was taken for a person\'s name (no recordedBy); a builder session that sets STUDIO_OUTSIDE_SIGNERS in its own environment is refused (fails on 2.78.2: no outside signers, so grokbot\'s answer was a "person" named grokbot and its approval wanted the owner key)', () => [
      before.status === 0 && !beforeDoc?.recordedBy && sneaky.status === 1 && sneakyDoc?.status === 'open'
        && after.status === 0 && afterDoc?.recordedBy === 'grokbot' && afterDoc?.answeredBy === 'pat' && afterDoc?.via === 'beta mode'
        && made.status === 0 && doc?.approval?.recordedBy === 'grokbot' && show.status === 0 && /OK: approved by/.test(out(show)),
      JSON.stringify({ before: out(before).slice(-160), beforeDoc: beforeDoc?.recordedBy, sneaky: out(sneaky).slice(-200), after: out(after).slice(-160), afterDoc, made: out(made).slice(-300), recordedBy: doc?.approval?.recordedBy, show: out(show).slice(-300) })]);
  }

  // ---- c3: the owner-only list refuses the orchestrator ----
  {
    const { S, env } = studio('c3');
    const opus = { STUDIO_LOCK_OWNER: 'opus-1' };
    askIn(S, env, 'Rotate the API key of the build bot?'); // A-001, keys
    askIn(S, env, 'Delete the old save files under saves/?'); // A-002, deleting data
    const keys = answer(S, env, 'A-001', 'opus-1', opus);
    const keysAsOwner = answer(S, env, 'A-001', 'pat', opus); // the orchestrator's shell typing the owner's name
    const del = answer(S, env, 'A-002', 'opus-1', { CLAUDECODE: '1' });
    const keyFile = path.join(tmpRoot, `279c-keygen-${process.pid}.pem`);
    const keygen = node(S, ['harness/approve.mjs', 'keygen', '--by', 'pat'], { ...env, ...opus, STUDIO_OWNER_KEY: keyFile });
    const dg = probe(S, `const d = await import(${u(S, 'harness/delegation.mjs')}); console.log(JSON.stringify({ publish: d.delegationFor({ action: 'publish', by: 'opus-1' }).ok, release: d.delegationFor({ action: 'train-release', by: 'opus-1' }).ok }));`, { ...env, ...opus });
    const off = node(S, ['harness/beta-mode.mjs', 'off', '--by', 'pat', '--no-commit'], { ...env, ...opus });
    const stillOn = JSON.parse(fs.readFileSync(path.join(S, 'studio', 'beta.json'), 'utf8')).on === true;
    const person = answer(S, env, 'A-001', 'pat');
    const personOff = node(S, ['harness/beta-mode.mjs', 'off', '--by', 'pat', '--no-commit'], env);
    await guard('2.79 (c, c3): what stays the owner\'s own refuses the orchestrator in beta mode, each saying so: an ask about keys (also when its shell types --by <the owner>) or deleting data, `approve -- keygen` (no key written), a delegated "publish", and `beta -- off`; the same orchestrator still releases lanes; the owner\'s own terminal answers the keys ask and turns beta mode off (fails on 2.78.2: the orchestrator answered both asks, made the key and turned beta mode off)', () => [
      keys.status === 1 && /stays the owner's own/.test(out(keys)) && keysAsOwner.status === 1 && del.status === 1 && /deleting data/.test(out(del))
        && keygen.status === 1 && /keys and credentials/.test(out(keygen)) && !fs.existsSync(keyFile)
        && dg.j?.publish === false && dg.j?.release === true && off.status === 1 && /turning beta mode off/.test(out(off)) && stillOn
        && person.status === 0 && askDoc(S, 'A-001')?.answeredBy === 'pat' && !askDoc(S, 'A-001')?.recordedBy && personOff.status === 0,
      JSON.stringify({ keys: out(keys).slice(-200), keysAsOwner: out(keysAsOwner).slice(-120), del: out(del).slice(-160), keygen: out(keygen).slice(-200), dg: dg.j || out(dg).slice(-300), off: out(off).slice(-200), stillOn, person: out(person).slice(-120), personOff: out(personOff).slice(-160) })]);
  }

  // ---- c4 + c5: a release survives a catch-up merge of main; goldens: a merge of main is nobody's authorship ----
  {
    const { S, L, env } = studio('c4');
    const opus = { ...env, STUDIO_LOCK_OWNER: 'opus-1' };
    const h1 = head(L);
    writeIn(S, '.studio/train/queue.json', `${JSON.stringify([{ task: 'T-500', agent: 'builder-s1', dir: L, branch: 'lane/builder-s1', head: h1, all: false, at: new Date().toISOString(), held: { tier: 'C', why: `protected files: ${PROT}`, head: h1, at: new Date().toISOString() } }], null, 2)}\n`);
    const T = u(S, 'harness/train.mjs');
    const worker = probe(S, `const t = await import(${T}); const r = t.releaseLane(process.cwd(), 'T-500', { by: 'pat' }); console.log(JSON.stringify({ ok: r.ok, message: r.message }));`, { ...env, STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' });
    const rel = probe(S, `const t = await import(${T}); const r = t.releaseLane(process.cwd(), 'T-500', { by: 'opus-1' }); console.log(JSON.stringify({ ok: r.ok, message: r.message }));`, opus);
    // main moves (a file the lane doesn't touch); the lane catches up with a merge of main made by the orchestrator.
    writeIn(S, 'docs/279c-main-moved.md', 'main moved\n');
    g(S, 'add', '--', 'docs/279c-main-moved.md'); g(S, 'commit', '-qm', 'main moves', '--no-verify');
    const m = g(L, 'merge', '--no-ff', '--no-edit', '-m', 'refresh the lane from main', '-m', 'Studio-Agent: opus-1', 'main');
    const h2 = head(L);
    const holdAt = (h) => probe(S, `const t = await import(${T}); const r = t.holdLane(process.cwd(), { task: 'T-500', agent: 'builder-s1', dir: ${JSON.stringify(L)}, branch: 'lane/builder-s1', head: ${JSON.stringify(h)} }, { tier: 'C', why: 'protected files: ${PROT}' }); console.log(JSON.stringify({ released: r.entry.released || null, heldNow: t.heldNow(r.entry) }));`, env);
    const at2 = holdAt(h2);
    // Goldens: authorship of the lane after the merge, and the second-signer rule.
    const gr = probe(S, `const gr = await import(${u(S, 'harness/golden-report.mjs')}); const { spawnSync } = await import('node:child_process');
const git = (...a) => String(spawnSync('git', a, { cwd: process.cwd(), encoding: 'utf8', windowsHide: true }).stdout || '').trim();
const tip = git('rev-parse', 'main'); const base = git('merge-base', tip, ${JSON.stringify(h2)});
const authors = gr.laneAuthors(process.cwd(), base, ${JSON.stringify(h2)}, 'builder-s1', { tip });
const held = { rerecord: { reports: [{ rel: 'cartridges/x/golden.json', ok: true, entry: { tick: 1 } }], authors } };
console.log(JSON.stringify({ authors, opus: gr.rerecordRefusal(held, { by: 'pat', agent: 'opus-1', delegated: true, beta: true }), builder: gr.rerecordRefusal(held, { by: 'pat', agent: 'builder-s1', delegated: true, beta: true }) }));`, env);
    // A new lane commit that touches the released file voids the release.
    fs.appendFileSync(path.join(L, PROT), '// and again\n');
    g(L, 'add', '-A'); g(L, 'commit', '-qm', 'builder: edit it again', '-m', 'Studio-Agent: builder-s1', '--no-verify');
    const at3 = holdAt(head(L));
    await guard('2.79 (c, c4): the orchestrator releases a tier-C hold; the release survives the lane catching up with main (a merge that touches none of the released files: a new head, the same lane content), carried to the new head with heldNow false; a lane commit that changes the released file voids it; a builder session can\'t release (fails on 2.78.2: the release was keyed on the raw head, so the catch-up merge voided it: the release loop)', () => [
      worker.j?.ok === false && rel.j?.ok === true && m.status === 0 && h2 !== h1 && at2.j?.released?.head === h2 && at2.j?.heldNow === false && at3.j?.released === null && at3.j?.heldNow === true,
      JSON.stringify({ worker: worker.j || out(worker).slice(-300), rel: rel.j || out(rel).slice(-300), merge: out(m).slice(-200), at2: at2.j || out(at2).slice(-300), at3: at3.j || out(at3).slice(-300) })]);
    await guard('2.79 (c, c5): a merge of main into a lane (the orchestrator\'s lane refresh) is nobody\'s authorship: the lane\'s authors are its builder only, so the orchestrator is a valid second signer for a re-recorded golden there, and the builder still isn\'t (fails on 2.78.2: the merge commit\'s Studio-Agent: opus-1 made opus-1 an author, so it couldn\'t second-sign)', () => [
      Array.isArray(gr.j?.authors) && gr.j.authors.includes('builder-s1') && !gr.j.authors.includes('opus-1') && gr.j.opus === '' && /author/.test(gr.j.builder || ''),
      JSON.stringify(gr.j || out(gr).slice(-400))]);
  }

  // ---- c6: a harness ask posts once per state change ----
  {
    const { S, env } = studio('c6');
    const code = `const rs = await import(${u(S, 'harness/rescue.mjs')}); const th = await import(${u(S, 'harness/task-hold.mjs')}); const fs = await import('node:fs');
const asks = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'agent.ask' && e.task === 'T-600').length;
const closed = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'ask.closed' && e.task === 'T-600').length;
const r = {};
rs.shelve('T-600', 'two rescue steps did not get it unstuck', { now: Date.parse('2026-11-06T01:00:00Z') });
rs.shelve('T-600', 'two rescue steps did not get it unstuck', { now: Date.parse('2026-11-06T01:20:00Z') });
r.twice = asks();
th.setHold('T-600', { parked: null }, { by: 'opus-1', msg: 'opus-1 unparked T-600' });
let ap = null; try { ap = await import(${u(S, 'harness/ask-post.mjs')}); } catch {}
if (ap) ap.closeStaleAsks({ now: Date.parse('2026-11-06T01:30:00Z') });
r.closed = closed();
rs.shelve('T-600', 'two rescue steps did not get it unstuck', { now: Date.parse('2026-11-06T01:50:00Z') });
r.back = asks();
r.open = ap ? ap.openPostedAsks().map((a) => ({ key: a.key, repeats: a.repeats, cameBack: a.cameBack })) : null;
console.log(JSON.stringify(r));`;
    const p = probe(S, code, env);
    const S2 = studio('c6d').S;
    const daily = probe(S2, code.replaceAll(pathToFileURL(S).href, pathToFileURL(S2).href).replace("rs.shelve('T-600', 'two rescue steps did not get it unstuck', { now: Date.parse('2026-11-06T01:00:00Z') });", "rs.shelve('T-601', 'x', { now: Date.parse('2026-11-04T01:00:00Z') });"), { ...env, AGENT_EVENTS_FILE: path.join(S2, '.studio', 'events-279c.jsonl'), STUDIO_ASK_DIGEST_HOURS: '0' });
    await guard('2.79 (c, c6): a harness ask (agent.ask, here a shelved task\'s "Needs you") posts once per state change: shelved again while still parked is not posted again; once the task is unparked the ask closes by itself (one ask.closed event), and the same ask coming back within STUDIO_ASK_DIGEST_HOURS (24) is counted for the daily digest, not posted; with STUDIO_ASK_DIGEST_HOURS=0 it posts again (fails on 2.78.2: every occurrence posted an agent.ask (3 here) and nothing closed one)', () => [
      p.j?.twice === 1 && p.j?.closed === 1 && p.j?.back === 1 && Array.isArray(p.j?.open) && p.j.open.some((a) => a.key === 'T-600:parked' && a.cameBack >= 1) && daily.j?.back === 2,
      JSON.stringify({ p: p.j || out(p).slice(-400), daily: daily.j || out(daily).slice(-300) })]);
  }
}

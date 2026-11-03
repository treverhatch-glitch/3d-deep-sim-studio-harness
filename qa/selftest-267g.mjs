/**
 * qa/selftest-267g.mjs — 2.67.0 (g): the owner's standing delegation to an outside agent, and --help never acts (B-47).
 *   1. `npm run delegate -- grant <agent> --actions … --hours N --by <owner>` from the owner's own terminal writes and
 *      commits studio/delegation.json; an agent's shell, a launched session or an agent's --by can't grant one.
 *   2. While it counts, the named agent runs train release, type, yes and hold with --by <agent> and no permission
 *      words; each use is recorded "under delegation <at> by <owner>", with a delegation.used event the digest counts.
 *   3. Expired, revoked, agent-committed, wrong agent, action not listed, a launched builder session or a worker:
 *      refused as before.
 *   4. With an owner key only the owner's signature counts: a signed grant works (also for type), a tampered one is ignored.
 *   5. `delegate -- claude-settings` prints (and --write merges) only the narrow rules; never broad, never deny.
 *   6. The file is on the shipped protected list (tier C).
 *   7. B-47: every task.mjs subcommand (walked from the code) and train, delegate, lanes, fuzz, denials with --help/-h
 *      print usage, exit 0, and write no file and no event (train --help starts no train).
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest267G({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const events = path.join(dir, '.studio', 'events-267g.jsonl');
  const noKey = path.join(tmpRoot, `no-owner-key-267g-${process.pid}.pem`);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_AGENT_MODEL: '', STUDIO_OWNER_KEY: noKey, AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const person = { ...env, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_LOCK_OWNER: '' };
  const agent = { ...person, CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'opus-bot' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const qf = path.join(dir, '.studio', 'train', 'queue.json');
  const queue = () => { try { return JSON.parse(fs.readFileSync(qf, 'utf8')); } catch { return []; } };
  const holdLane = (id) => {
    const q = queue().filter((e) => e.task !== id);
    q.push({ task: id, agent: 'builder-s1', dir: '', branch: `lane/${id}`, head: 'a'.repeat(40), note: '', at: new Date().toISOString(), held: { tier: 'C', why: 'changes harness/', head: 'a'.repeat(40), at: new Date().toISOString() } });
    fs.mkdirSync(path.dirname(qf), { recursive: true });
    fs.writeFileSync(qf, JSON.stringify(q, null, 2));
  };
  const entry = (id) => queue().find((e) => e.task === id) || {};
  const tm = (args, e = agent) => run(dir, `node harness/task.mjs ${args}`, e);
  const dl = (args, e = person) => run(dir, `node harness/delegation.mjs ${args}`, e);
  const delegFile = path.join(dir, 'studio', 'delegation.json');
  const hasModule = fs.existsSync(path.join(dir, 'harness', 'delegation.mjs'));

  // ---- a made-up studio in git, with the hooks (an agent's commits carry Studio-Agent) ----
  write('game/demo/notes.md', '# demo\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');
  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, person)).match(/"id": "(T-\d+)"/) || [])[1];
  const tA = addTask('Demo lane one'); const tB = addTask('Demo lane two'); const tC = addTask('Demo lane three'); const tD = addTask('Demo lane four');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'board', '--no-verify');

  // ---- 1. grants: an agent's shell, a launched session, an agent's --by: refused; the owner's terminal: written ----
  const grantArgs = 'grant opus-bot --actions train-release,type,yes,hold --hours 12 --by Dana --why "standing delegation for the merge conductor"';
  const preRelease = (holdLane(tA), tm(`train release ${tA} --by opus-bot`));
  const byAgent = dl(grantArgs, agent);
  const bySession = dl(grantArgs, { ...person, STUDIO_ROLE: 'producer' });
  const byStudioAgent = dl(grantArgs, { ...person, STUDIO_AGENT: 'opus-bot' });
  const agentBy = dl('grant opus-bot --actions train-release --hours 12 --by claude-a', person);
  const badAction = dl('grant opus-bot --actions train-release,approve --hours 12 --by Dana', person);
  const noFileYet = !fs.existsSync(delegFile);
  const granted = dl(grantArgs, person);
  const committed = g(dir, 'cat-file', '-e', 'HEAD:studio/delegation.json').status === 0;
  const listed = dl('list', person);
  report('2.67.0 (g #1): only the owner\'s own terminal grants a delegation: a coding agent\'s shell, a launched Producer session, STUDIO_AGENT, an agent\'s name in --by and a non-delegable action (approve) are refused and write nothing; the owner\'s grant writes and commits studio/delegation.json and `delegate list` says it counts (fails on 2.66.0: there is no npm run delegate)',
    hasModule && byAgent.status !== 0 && /CLAUDECODE/.test(out(byAgent)) && bySession.status !== 0 && byStudioAgent.status !== 0 && agentBy.status !== 0 && badAction.status !== 0 && /approve/.test(out(badAction)) && noFileYet
      && granted.status === 0 && committed && /counts now/.test(out(listed)),
    `${out(byAgent)}\n${out(bySession)}\n${out(byStudioAgent)}\n${out(agentBy)}\n${out(badAction)}\nnoFileYet=${noFileYet}\n${out(granted)}\ncommitted=${committed}\n${out(listed)}`);

  // ---- 2. the agent's release / type / yes / hold, no permission words, recorded under the delegation ----
  const rel = tm(`train release ${tA} --by opus-bot`);
  const eA = entry(tA);
  const ty = tm(`type ${tB} chore --by opus-bot --why "only notes change, nothing to regress"`);
  const tyShow = tm(`type ${tB}`, person);
  const yes = tm(`yes ${tC} --by opus-bot`);
  const hold = tm(`hold ${tC} --by opus-bot --why "waits for the merge chain"`);
  const used = evs().filter((e) => e.type === 'delegation.used');
  const ev = evs();
  report('2.67.0 (g #2): under the owner\'s delegation the named outside agent (a coding agent\'s shell) releases a held tier-C lane, retypes a task, says yes and holds a lane with --by <agent> and no --permission; each is recorded for the owner by the agent "under delegation <at> by Dana" (queue entry, task-types record that counts, task.dev_yes relay, task.held) with one delegation.used event per action (fails on 2.66.0: the same agent release without a delegation is refused as an agent\'s name)',
    preRelease.status !== 0 && rel.status === 0 && eA.released?.by === 'Dana' && eA.released?.recordedBy === 'opus-bot' && /under delegation .* by Dana/.test(eA.released?.permission || '')
      && ty.status === 0 && /"chore" task/.test(out(tyShow))
      && yes.status === 0 && ev.some((e) => e.type === 'task.dev_yes' && e.task === tC && e.agent === 'Dana' && e.meta?.relayedBy === 'opus-bot' && /under delegation/.test(e.meta?.quote || ''))
      && hold.status === 0 && ev.some((e) => e.type === 'task.held' && e.task === tC && /under delegation/.test(e.msg || ''))
      && ['train-release', 'type', 'yes', 'hold'].every((a) => used.some((e) => e.meta?.action === a && e.agent === 'opus-bot' && e.meta?.owner === 'Dana')),
    `pre=${out(preRelease)}\nrel=${out(rel)} ${JSON.stringify(eA.released)}\nty=${out(ty)}\nshow=${out(tyShow)}\nyes=${out(yes)}\nhold=${out(hold)}\nused=${JSON.stringify(used.map((e) => e.meta))}`);

  // The digest counts them.
  const dprobe = path.join(tmpRoot, `digest-267g-${process.pid}.mjs`);
  fs.writeFileSync(dprobe, `import { buildDigest } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'digest.mjs')).href)};\nconst d = await buildDigest();\nconsole.log(JSON.stringify({ text: d.text }));\n`);
  const dg = run(dir, `node "${dprobe}"`, person);
  report('2.67.0 (g #2): the daily digest says how many owner actions ran under delegation in 24 h (by action) and until when the delegation counts (fails on 2.66.0: no such line)',
    /4 owner actions run under delegation in 24 h/.test(out(dg)) && /counts until/.test(out(dg)), out(dg));

  // ---- 3. refused as before: action not listed, wrong agent, builder session, worker, expired, revoked, agent-committed ----
  holdLane(tD);
  const vis = tm(`visual ${tB} off --by opus-bot --why "no picture needed for notes"`);
  const other = tm(`train release ${tD} --by other-bot`, { ...agent, STUDIO_LOCK_OWNER: 'other-bot' });
  const builder = tm(`train release ${tD} --by opus-bot`, { ...agent, STUDIO_ROLE: 'builder' });
  const worker = tm(`train release ${tD} --by opus-bot`, { ...agent, STUDIO_LOCK_OWNER: 'builder-s3' });
  const lprobe = path.join(tmpRoot, `lane-267g-${process.pid}.mjs`);
  fs.writeFileSync(lprobe, `import { delegationFor } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'delegation.mjs')).href)};\nconsole.log(JSON.stringify({ lane: delegationFor({ action: 'train-release', by: 'opus-bot', lane: true, env: { CLAUDECODE: '1' } }), later: delegationFor({ action: 'train-release', by: 'opus-bot', now: Date.now() + 13 * 3600000, env: { CLAUDECODE: '1' } }) }));\n`);
  let lp = {}; try { lp = JSON.parse(String(run(dir, `node "${lprobe}"`, person).stdout).trim().split('\n').pop()); } catch {}
  const notReleased = !entry(tD).released;
  // expired: the owner's own committed file, its window over
  const doc = (() => { try { return JSON.parse(fs.readFileSync(delegFile, 'utf8')); } catch { return {}; } })();
  fs.writeFileSync(delegFile, JSON.stringify({ ...doc, at: new Date(Date.now() - 3 * 3600000).toISOString(), until: new Date(Date.now() - 3600000).toISOString() }, null, 2));
  g(dir, 'commit', '-qm', 'owner: old window', '--no-verify', '--', 'studio/delegation.json');
  const expired = tm(`train release ${tD} --by opus-bot`);
  // agent-committed (no owner key): the agent writes a fresh one and commits it through the hooks
  fs.writeFileSync(delegFile, JSON.stringify({ ...doc, until: new Date(Date.now() + 3600000).toISOString() }, null, 2));
  spawnSync('git', ['commit', '-q', '-m', 'agent grants itself', '--', 'studio/delegation.json'], { windowsHide: true, cwd: dir, encoding: 'utf8', env: { ...process.env, ...agent } });
  const trailer = /Studio-Agent: opus-bot/.test(g(dir, 'log', '-1', '--format=%B').stdout);
  const selfGranted = tm(`train release ${tD} --by opus-bot`);
  // revoked
  const regrant = dl(grantArgs, person);
  const okAgain = tm(`unhold ${tC} --by opus-bot`);
  const revoked = dl('revoke --by Dana', person);
  const afterRevoke = tm(`train release ${tD} --by opus-bot`);
  report('2.67.0 (g #3): no delegation applies, and the old rules refuse: an action it doesn\'t list (visual), another agent, a launched builder session, a worker\'s shell, a lane copy, after its window, an expired file, one the agent committed itself (Studio-Agent trailer) and after `delegate revoke`; the lane stays unreleased (fails on 2.66.0: no delegation module)',
    hasModule && vis.status !== 0 && /not visual/.test(out(vis)) && other.status !== 0 && builder.status !== 0 && /builder/.test(out(builder)) && worker.status !== 0 && lp.lane?.ok === false && /lane copy/.test(lp.lane?.why || '') && lp.later?.ok === false && /ended/.test(lp.later?.why || '')
      && expired.status !== 0 && /ended/.test(out(expired)) && trailer && selfGranted.status !== 0 && /Studio-Agent/.test(out(selfGranted))
      && regrant.status === 0 && okAgain.status === 0 && revoked.status === 0 && !fs.existsSync(delegFile) && afterRevoke.status !== 0 && notReleased && !entry(tD).released,
    `vis=${out(vis)}\nother=${out(other)}\nbuilder=${out(builder)}\nworker=${out(worker)}\nlp=${JSON.stringify(lp)}\nexpired=${out(expired)}\ntrailer=${trailer}\nself=${out(selfGranted)}\nregrant=${out(regrant)}\nunhold=${out(okAgain)}\nrevoked=${out(revoked)}\nafter=${out(afterRevoke)}`);

  // ---- 4. with an owner key: a signed grant counts (release and type); a tampered or unsigned file doesn't ----
  const keyFile = path.join(tmpRoot, `owner-267g-${process.pid}.pem`);
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
  write('studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  g(dir, 'add', 'studio/keys'); g(dir, 'commit', '-qm', 'owner key', '--no-verify');
  const tE = addTask('Demo lane five'); const tF = addTask('Demo lane six');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'board 2', '--no-verify');
  const noPriv = dl(grantArgs, person);
  const signedGrant = dl(grantArgs, { ...person, STUDIO_OWNER_KEY: keyFile });
  const signedDoc = (() => { try { return JSON.parse(fs.readFileSync(delegFile, 'utf8')); } catch { return {}; } })();
  holdLane(tE);
  const keyedRel = tm(`train release ${tE} --by opus-bot`);
  const keyedType = tm(`type ${tF} chore --by opus-bot --why "only notes change, nothing to regress"`);
  const keyedShow = tm(`type ${tF}`, person);
  fs.writeFileSync(delegFile, JSON.stringify({ ...signedDoc, actions: [...(signedDoc.actions || []), 'visual'] }, null, 2));
  g(dir, 'commit', '-qm', 'tamper', '--no-verify', '--', 'studio/delegation.json');
  holdLane(tD);
  const tampered = tm(`train release ${tD} --by opus-bot`);
  report('2.67.0 (g #4): with an owner key a grant is signed with it (refused without the private key); the signed delegation lets the agent release a held lane and retype a task (the type counts: it carries the signed delegation); a tampered file (an action added after signing) is ignored and the release refused (fails on 2.66.0: an agent can\'t release on permission once a key exists, and there is no delegation)',
    noPriv.status !== 0 && /owner key/.test(out(noPriv)) && signedGrant.status === 0 && typeof signedDoc.signature === 'string'
      && keyedRel.status === 0 && entry(tE).released?.recordedBy === 'opus-bot' && keyedType.status === 0 && /"chore" task/.test(out(keyedShow))
      && tampered.status !== 0 && /signature/.test(out(tampered)) && !entry(tD).released,
    `noPriv=${out(noPriv)}\nsigned=${out(signedGrant)}\nrel=${out(keyedRel)}\ntype=${out(keyedType)}\nshow=${out(keyedShow)}\ntampered=${out(tampered)}`);

  // ---- 5. claude-settings: only the narrow rules; --write merges as the owner, keeps deny and other keys ----
  const settingsF = path.join(dir, '.claude', 'settings.json');
  let before = {}; try { before = JSON.parse(fs.readFileSync(settingsF, 'utf8')); } catch {}
  fs.mkdirSync(path.dirname(settingsF), { recursive: true });
  fs.writeFileSync(settingsF, JSON.stringify({ ...before, permissions: { allow: ['Bash(git status*)'], deny: ['Bash(rm -rf:*)'] } }, null, 2));
  const printed = dl('claude-settings --actions train-release,type,yes,hold', person);
  const rules = out(printed).split('\n').map((l) => l.trim()).filter((l) => l.startsWith('Bash('));
  const narrow = rules.length > 0 && rules.every((r) => /^Bash\((npm run task --|node harness\/task\.mjs) (train release|type|yes|hold|unhold):\*\)$/.test(r)) && !rules.some((r) => r === 'Bash(*)' || /npm run \*/.test(r));
  const agentWrite = dl('claude-settings --actions train-release --write', agent);
  const wrote = dl('claude-settings --actions train-release,type,yes,hold --write', person);
  let after = {}; try { after = JSON.parse(fs.readFileSync(settingsF, 'utf8')); } catch {}
  const allow = after.permissions?.allow || [];
  report('2.67.0 (g #5): `delegate -- claude-settings` prints only narrow prefix rules for the delegated commands (npm and node forms; no Bash(*), no npm run *); --write from an agent\'s shell is refused; the owner\'s --write merges them into .claude/settings.json permissions.allow, keeping the existing allow rule, the deny rules and the hooks (fails on 2.66.0: no such command)',
    printed.status === 0 && narrow && rules.includes('Bash(npm run task -- train release:*)') && rules.includes('Bash(node harness/task.mjs unhold:*)')
      && agentWrite.status !== 0 && wrote.status === 0 && allow.includes('Bash(git status*)') && rules.every((r) => allow.includes(r)) && allow.length === rules.length + 1
      && JSON.stringify(after.permissions?.deny) === JSON.stringify(['Bash(rm -rf:*)']) && JSON.stringify(after.hooks) === JSON.stringify(before.hooks),
    `${out(printed)}\nagentWrite=${out(agentWrite)}\nwrote=${out(wrote)}\n${JSON.stringify(after.permissions)}`);

  // ---- 6. protected: approve.mjs DEFAULT_PROTECTED, tiers SHIPPED_PROTECTED, the shipped studio/protected.json; tier C ----
  const pprobe = path.join(tmpRoot, `prot-267g-${process.pid}.mjs`);
  fs.writeFileSync(pprobe, `import { DEFAULT_PROTECTED } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'approve.mjs')).href)};\nimport { SHIPPED_PROTECTED, classifyLane } from ${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'tiers.mjs')).href)};\nimport fs from 'node:fs';\nconsole.log(JSON.stringify({ d: DEFAULT_PROTECTED.includes('studio/delegation.json'), s: SHIPPED_PROTECTED.includes('studio/delegation.json'), f: JSON.parse(fs.readFileSync('studio/protected.json', 'utf8')).globs.includes('studio/delegation.json'), tier: classifyLane({ files: [{ path: 'studio/delegation.json', status: 'A' }] }).tier }));\n`);
  let pp = {}; try { pp = JSON.parse(String(run(dir, `node "${pprobe}"`, person).stdout).trim().split('\n').pop()); } catch {}
  report('2.67.0 (g #6): studio/delegation.json is on the shipped protected list (approve.mjs DEFAULT_PROTECTED, tiers SHIPPED_PROTECTED, studio/protected.json), so a lane that writes it is tier C (fails on 2.66.0: it isn\'t listed)',
    pp.d === true && pp.s === true && pp.f === true && pp.tier === 'C', JSON.stringify(pp));

  // ---- 7. B-47: --help / -h never acts ----
  const src = fs.readFileSync(path.join(dir, 'harness', 'task.mjs'), 'utf8');
  const subs = [...new Set([...src.matchAll(/cmd === '([a-z-]+)'/g)].map((m) => m[1]).concat(...[...src.matchAll(/\[((?:'[a-z-]+',?\s*)+)\]\.includes\(cmd\)/g)].map((m) => m[1].match(/[a-z-]+/g))))].sort();
  const snap = () => {
    const m = new Map();
    const walk = (d) => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { if (f.name === '.git' || f.name === 'node_modules') continue; const p = path.join(d, f.name); if (f.isDirectory()) walk(p); else { try { const st = fs.statSync(p); m.set(p, `${st.size}:${st.mtimeMs}`); } catch {} } } };
    walk(dir);
    return m;
  };
  const diff = (a, b) => [...new Set([...a.keys(), ...b.keys()])].filter((k) => a.get(k) !== b.get(k)).map((k) => path.relative(dir, k));
  const head0 = g(dir, 'rev-parse', 'HEAD').stdout.trim();
  holdLane(tD); // a queued lane a real train would try to run
  const s0 = snap();
  const nEv = evs().length;
  const bad = [];
  const calls = [
    ...subs.map((c) => `node harness/task.mjs ${c} --help`),
    ...['train', 'add', 'done', 'type', 'yes', 'hold'].map((c) => `node harness/task.mjs ${c} -h`),
    `node harness/task.mjs train release ${tD} --by opus-bot --help`, 'node harness/task.mjs train --now --help', 'node harness/task.mjs --help',
    'node harness/delegation.mjs --help', `node harness/delegation.mjs ${grantArgs} --help`, 'node harness/delegation.mjs revoke -h',
    'node harness/lanes.mjs --help', 'node harness/lanes.mjs refresh --all --by Dana --help', 'node qa/fuzz.mjs --help', 'node harness/denials.mjs --help', 'node harness/denials.mjs -h',
  ];
  for (const c of calls) {
    const r = run(dir, c, person);
    if (r.status !== 0 || !/usage|fuzz/i.test(out(r))) bad.push(`${c}: exit ${r.status}: ${out(r).slice(0, 300)}`);
  }
  const changed = diff(s0, snap());
  const newEv = evs().slice(nEv);
  report(`2.67.0 (g #7, B-47): --help and -h on every task.mjs subcommand found in the code (${subs.length}: ${subs.join(' ')}), train release/train --now, delegate (also grant … --help, which grants nothing), lanes (also refresh --all), fuzz and denials print usage and exit 0, and none writes a file, an event or a commit; train --help starts no train (fails on 2.66.0: train --help ran a real train)`,
    subs.length >= 30 && subs.includes('train') && !bad.length && !changed.length && !newEv.length && g(dir, 'rev-parse', 'HEAD').stdout.trim() === head0 && !newEv.some((e) => e.type === 'task.train.start'),
    `bad:\n${bad.join('\n')}\nchanged: ${changed.join(', ')}\nevents: ${newEv.map((e) => `${e.type} ${e.msg || ''}`.slice(0, 160)).join('\n')}`);
}

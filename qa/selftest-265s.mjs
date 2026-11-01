/**
 * qa/selftest-265s.mjs — 2.65.0 (helper s):
 *   B-40 full: a lane carries studio config through studio-proposals/<ID>.json; the landing (merge train, and the old
 *     one-lane task done path) applies it to main in a Config-From commit and removes the file; a conflict with main's
 *     newer value hands the lane back; a protected target makes the lane tier C (held until a person releases it), and
 *     with an owner key only the owner's signed approval applies it (else it is held on main, asked of a person, and
 *     `train config` applies it later); the edit guard names the route; the hooks gate exempts exactly such a commit.
 *   Visual noise baseline: "before" is captured twice; a change must reach max(1%, k x the camera's noise), capped; a
 *     scene noisier than the cap is "too noisy to judge", never a pass; the noise goes into the verdict and done-check.
 *   Windows orphans of a full verify's gates: each gate's shell is recorded in the machine:heavy holder's tree while the
 *     run holds it, and heavy stop / the next take find what a finished shell left running (simulated process lists).
 * A tiny studio: a made-up game whose check fails on a note that says BROKEN; lane copies with the commit hooks.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest265S({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const events = path.join(dir, '.studio', 'events-265s.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_BISECT: '', STUDIO_TRAIN_MIN: '', STUDIO_TRAIN_MAX: '', STUDIO_TRAIN_WAIT_MIN: '', STUDIO_TRAIN_POLL_S: '', STUDIO_TRAIN_LOCK_WAIT_MIN: '', STUDIO_TRAIN_RIDE_ALONG: '', STUDIO_TRAIN_MAX_HANDBACKS: '', STUDIO_ROLE: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_GAME_GATE_RETRY: '', STUDIO_GATE_SPAWN: '', STUDIO_VISUAL_NOISE: '', STUDIO_VISUAL_NOISE_K: '', STUDIO_VISUAL_NOISE_CAP: '', STUDIO_VISUAL_DIFF_MIN: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-265s-${process.pid}.pem`), AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const person = { ...env, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_LOCK_OWNER: '' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const mainHas = (rel) => g(dir, 'cat-file', '-e', `main:${rel}`).status === 0;
  const mainJson = (rel) => { try { return JSON.parse(g(dir, 'show', `main:${rel}`).stdout); } catch { return null; } };
  const diskJson = (rel) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel), 'utf8')); } catch { return null; } };
  const queueRaw = () => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'train', 'queue.json'), 'utf8')); } catch { return []; } };
  const doneBoard = () => `${fs.existsSync(path.join(dir, 'studio/DONE.md')) ? fs.readFileSync(path.join(dir, 'studio/DONE.md'), 'utf8') : ''}`;
  const isDone = (id) => new RegExp(`\\b${id}\\b`).test(doneBoard());
  const probe = (name, code, e = env) => {
    const f = path.join(tmpRoot, `probe-265s-${name}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, e);
    try { return JSON.parse(String(r.stdout || '').trim().split('\n').pop()); } catch { return { error: out(r).slice(-1500) }; }
  };
  const guard = async (name, fn) => { try { await fn(); } catch (e) { report(name, false, `threw: ${e.stack || e.message}`); } };

  // ================= B-40: the edit guard names the proposal route (pure) =================
  await guard('2.65.0 (s B-40): the lane studio guard names the proposal route', () => {
    const r = probe('guard', `import { decideEdit } from ${u('harness/lane-studio.mjs')};
const d = decideEdit('Edit', { file_path: 'studio/game.json' }, { env: { STUDIO_MAIN_ROOT: ${JSON.stringify(path.join(tmpRoot, 'some-main'))} }, dir: ${JSON.stringify(path.join(tmpRoot, 'some-lane'))} });
console.log(JSON.stringify({ reason: d?.hookSpecificOutput?.permissionDecisionReason || '' }));`);
    report('2.65.0 (s B-40): in a lane copy the studio-config edit guard still denies the edit, and its reason now names the sanctioned route (studio-proposals/<TASK-ID>.json, applied when the lane lands, Config-From) and still says to hand the task back if it isn\'t the task\'s to propose (fails on 2.64.0: it only said to hand the task back)',
      /studio-proposals\/<TASK-ID>\.json/.test(r.reason) && /Config-From/.test(r.reason) && /hand the task back/.test(r.reason), JSON.stringify(r));
  });

  // ================= B-40: the studio, its game and lanes =================
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', [
    "import fs from 'node:fs'; import path from 'node:path';",
    "let bad = 0;",
    "for (const d of ['game/demo/notes', 'docs/demo']) for (const f of fs.existsSync(d) ? fs.readdirSync(d) : []) if (fs.readFileSync(path.join(d, f), 'utf8').includes('BROKEN')) { console.log(`FAIL notes: ${f} says BROKEN`); bad += 1; }",
    "if (bad) process.exit(1);",
    "console.log('demo ok');", ''].join('\n'));
  write(dir, 'game/demo/notes/shared.md', '# Shared\n');
  write(dir, 'studio/tuning.json', `${JSON.stringify({ speed: { max: 3, min: 1 } }, null, 2)}\n`);
  write(dir, 'studio/locked.json', `${JSON.stringify({ limit: 3 }, null, 2)}\n`);
  { const pj = JSON.parse(fs.readFileSync(path.join(dir, 'studio/protected.json'), 'utf8')); pj.globs = [...(pj.globs || []), 'studio/locked.json']; write(dir, 'studio/protected.json', `${JSON.stringify(pj, null, 2)}\n`); }
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-265s-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u('harness/worktree.mjs')};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  /** A task, its lane copy, the task started there, files written and committed with the hooks. files may be a function of the id. */
  const lane = (agent, title, files) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(typeof files === 'function' ? files(id) : files)) write(ld, rel, text);
    g(ld, 'add', '-A');
    const c = spawnSync('git', ['commit', '-q', '-m', `${id}: ${title}`], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}` };
  };
  const proposal = (changes, why = 'tune the demo for the next playtest') => `${JSON.stringify({ changes, why }, null, 2)}\n`;
  const queueIt = (l, extra = {}) => run(l.dir, `node harness/task.mjs done ${l.id} --agent ${l.agent} --train`, { ...l.as, ...extra });
  const train = (e = {}) => run(dir, 'node harness/task.mjs train --by tester', { ...env, ...e });
  const lastMsg = () => g(dir, 'log', '-1', '--format=%B', 'main').stdout;

  // ---- 1. a non-protected proposal lands with its lane: applied in a Config-From commit, the file removed ----
  await guard('2.65.0 (s B-40 #1)', () => {
    const l1 = lane('cfg-a', 'Docs: tune speed', (id) => ({ 'docs/demo/tune.md': '# Tune\n', [`studio-proposals/${id}.json`]: proposal([{ file: 'studio/tuning.json', set: { 'speed.max': 5, '/extra/label': 'fast' } }]) }));
    const q = queueIt(l1);
    const t = train();
    const m = mainJson('studio/tuning.json');
    const disk = diskJson('studio/tuning.json');
    const msg = lastMsg();
    report('2.65.0 (s B-40 #1): a lane that commits studio-proposals/<ID>.json (non-protected studio/tuning.json) lands through the merge train and main then has the keys set (speed.max 5, extra.label "fast", speed.min kept) in a commit with "Config-From: <ID>" right after the landing; the proposal file is gone from main, the main checkout\'s file follows, a config.applied event is written and the train names it (fails on 2.64.0: the proposal landed as a plain file and studio/tuning.json never changed)',
      l1.ok && q.status === 0 && t.status === 0 && isDone(l1.id) && m?.speed?.max === 5 && m?.speed?.min === 1 && m?.extra?.label === 'fast' && disk?.speed?.max === 5
        && !mainHas(`studio-proposals/${l1.id}.json`) && new RegExp(`Config-From: ${l1.id}`).test(msg) && /Studio-Harness: config-from/.test(msg)
        && evs().some((e) => e.type === 'config.applied' && e.task === l1.id) && /config proposal/.test(out(t)),
      `${l1.log.slice(-300)}\nq: ${out(q).slice(-500)}\nt: ${out(t).slice(-1500)}\nmain=${JSON.stringify(m)} disk=${JSON.stringify(disk)}\nmsg=${msg}`);

    // The hooks gate exempts exactly that commit (only studio/*.json and studio-proposals/), not a forged one.
    const cfgSha = g(dir, 'rev-parse', 'main').stdout.trim();
    const blob = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: 'export const x = 1;\n', encoding: 'utf8' }).stdout.trim();
    const idx = path.join(tmpRoot, `idx-265s-${process.pid}`);
    const ie = { ...process.env, ...env, GIT_INDEX_FILE: idx };
    spawnSync('git', ['read-tree', cfgSha], { cwd: dir, env: ie });
    spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob},game/demo/sneak.mjs`], { cwd: dir, env: ie });
    const tree2 = spawnSync('git', ['write-tree'], { cwd: dir, env: ie, encoding: 'utf8' }).stdout.trim();
    const forged2 = spawnSync('git', ['commit-tree', tree2, '-p', cfgSha, '-m', `sneak code\n\nConfig-From: ${l1.id}\nStudio-Harness: config-from`], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();
    // A config-from commit as the harness makes it (only studio/tuning.json), made here by hand on top of main.
    const blob3 = spawnSync('git', ['hash-object', '-w', '--stdin'], { cwd: dir, input: '{ "speed": { "max": 6 } }\n', encoding: 'utf8' }).stdout.trim();
    spawnSync('git', ['read-tree', cfgSha], { cwd: dir, env: ie });
    spawnSync('git', ['update-index', '--add', '--cacheinfo', `100644,${blob3},studio/tuning.json`], { cwd: dir, env: ie });
    const tree3 = spawnSync('git', ['write-tree'], { cwd: dir, env: ie, encoding: 'utf8' }).stdout.trim();
    const byHand = spawnSync('git', ['commit-tree', tree3, '-p', cfgSha, '-m', `config from ${l1.id}: studio/tuning.json\n\nConfig-From: ${l1.id}\nStudio-Harness: config-from`], { cwd: dir, encoding: 'utf8', env: { ...process.env, ...env } }).stdout.trim();
    const hs = probe('hooks', `import { checkHookStamps } from ${u('harness/hook-stamp.mjs')};
const env = { ...process.env, STUDIO_HOOKS_CHECK: 'on' };
const a = await checkHookStamps({ env, range: { base: ${JSON.stringify(cfgSha)} + '~1', head: ${JSON.stringify(cfgSha)} } });
const b = await checkHookStamps({ env, range: { base: ${JSON.stringify(cfgSha)}, head: ${JSON.stringify(forged2)} } });
const c = await checkHookStamps({ env, range: { base: ${JSON.stringify(cfgSha)}, head: ${JSON.stringify(byHand)} } });
console.log(JSON.stringify({ a: { ok: a.ok, open: a.open.length, exempt: a.exempt }, b: { ok: b.ok, open: b.open.length }, c: { ok: c.ok, open: c.open.length } }));`, { ...env, STUDIO_PROTECT_ROOT: dir });
    report('2.65.0 (s B-40 #1): the hooks gate exempts the harness\'s Config-From commit (Studio-Harness: config-from, only studio/*.json and studio-proposals/ changed), and NOT a commit that carries the same trailers but changes game code (fails on 2.64.0: no such commit, and the trailer exempted nothing)',
      Boolean(forged2) && Boolean(byHand) && hs.a?.ok === true && hs.a?.open === 0 && hs.c?.ok === true && hs.c?.open === 0 && hs.b?.ok === false && hs.b?.open === 1, JSON.stringify(hs));
  });

  // ---- 2. a proposal whose key changed on main since the lane started is handed back, nothing applied ----
  await guard('2.65.0 (s B-40 #2)', () => {
    const l2 = lane('cfg-b', 'Docs: slower minimum', (id) => ({ 'docs/demo/min.md': '# Min\n', [`studio-proposals/${id}.json`]: proposal([{ file: 'studio/tuning.json', set: { 'speed.min': 2 } }]) }));
    const tj = diskJson('studio/tuning.json'); tj.speed.min = 0;
    write(dir, 'studio/tuning.json', `${JSON.stringify(tj, null, 2)}\n`);
    g(dir, 'add', 'studio/tuning.json'); g(dir, 'commit', '-qm', 'producer: minimum speed 0', '--no-verify');
    const q = queueIt(l2);
    const t = train();
    const dropped = evs().filter((e) => e.type === 'task.train.dropped' && e.task === l2.id).pop();
    report('2.65.0 (s B-40 #2): a lane proposing speed.min = 2 while main changed speed.min (1 -> 0) since the lane started is handed back before it lands, the note naming the file, the key and both values; main keeps 0 and lands nothing of it (fails on 2.64.0: the lane landed and nothing compared the values)',
      l2.ok && q.status === 0 && !isDone(l2.id) && mainJson('studio/tuning.json')?.speed?.min === 0 && !mainHas(`studio-proposals/${l2.id}.json`) && !mainHas('docs/demo/min.md')
        && /conflicts with main/.test(dropped?.msg || '') && /speed\.min/.test(dropped?.msg || '') && /is 0 on main/.test(dropped?.msg || ''),
      `${l2.log.slice(-300)}\nq: ${out(q).slice(-400)}\nt: ${out(t).slice(-1500)}\ndropped=${JSON.stringify(dropped)}`);
  });

  // ---- 3. a proposal for a protected file: tier C, held with the change named; a person's release applies it ----
  await guard('2.65.0 (s B-40 #3)', () => {
    const l3 = lane('cfg-c', 'Docs: raise the limit', (id) => ({ 'docs/demo/limit.md': '# Limit\n', [`studio-proposals/${id}.json`]: proposal([{ file: 'studio/locked.json', set: { limit: 9 } }, { file: 'studio/tuning.json', set: { 'speed.step': 1 } }]) }));
    const q = queueIt(l3);
    const t1 = train();
    const held = queueRaw().find((e) => e.task === l3.id);
    const notYet = mainJson('studio/locked.json')?.limit === 3 && !isDone(l3.id);
    const rel = run(dir, `node harness/task.mjs train release ${l3.id} --by Dana`, person);
    const t2 = train();
    const msg = g(dir, 'log', '-1', '--format=%B', 'main').stdout;
    report('2.65.0 (s B-40 #3): a lane whose proposal sets a protected file (studio/locked.json in studio/protected.json) is tier C: the train holds it, the hold naming studio/locked.json and "limit = 9"; after a person\'s release the next train lands it and applies both files, the commit saying the protected part was decided by Dana\'s release (fails on 2.64.0: the proposal was a tier B file, landed at once, and changed nothing)',
      l3.ok && q.status === 0 && /tier C/.test(out(q)) && held?.held?.tier === 'C' && /config proposal for a protected/.test(held?.held?.why || '') && /studio\/locked\.json: limit = 9/.test(held?.held?.why || '') && notYet
        && rel.status === 0 && t2.status === 0 && isDone(l3.id) && mainJson('studio/locked.json')?.limit === 9 && mainJson('studio/tuning.json')?.speed?.step === 1 && !mainHas(`studio-proposals/${l3.id}.json`)
        && /Protected part decided by: Dana's release/.test(msg),
      `${l3.log.slice(-300)}\nq: ${out(q).slice(-500)}\nt1: ${out(t1).slice(-800)}\nheld=${JSON.stringify(held)}\nrel: ${out(rel)}\nt2: ${out(t2).slice(-1500)}\nmsg=${msg}`);
  });

  // ---- 4. the old one-lane path (STUDIO_TRAIN=off): applied too; an invalid proposal is refused before it lands ----
  await guard('2.65.0 (s B-40 #4)', () => {
    const l4 = lane('cfg-d', 'Docs: max seven', (id) => ({ 'docs/demo/seven.md': '# Seven\n', [`studio-proposals/${id}.json`]: proposal([{ file: 'studio/tuning.json', set: { 'speed.max': 7 } }]) }));
    const d4 = run(l4.dir, `node harness/task.mjs done ${l4.id} --agent ${l4.agent} --force --reason "old landing path for the proposal check"`, { ...l4.as, STUDIO_TRAIN: 'off' });
    const l5 = lane('cfg-e', 'Docs: bad proposal', (id) => ({ 'docs/demo/bad.md': '# Bad\n', [`studio-proposals/${id}.json`]: proposal([{ file: 'harness/settings.json', set: { a: 1 } }]) }));
    const d5 = run(l5.dir, `node harness/task.mjs done ${l5.id} --agent ${l5.agent} --force --reason "old landing path for the proposal check"`, { ...l5.as, STUDIO_TRAIN: 'off' });
    report('2.65.0 (s B-40 #4): on the old one-lane path (STUDIO_TRAIN=off) a lane\'s proposal is applied right after it lands (speed.max 7, Config-From commit, file removed); a proposal naming a file outside studio/*.json is refused before anything lands, saying why (fails on 2.64.0: both landed as plain files)',
      l4.ok && d4.status === 0 && mainJson('studio/tuning.json')?.speed?.max === 7 && !mainHas(`studio-proposals/${l4.id}.json`) && mainHas('docs/demo/seven.md') && new RegExp(`Config-From: ${l4.id}`).test(lastMsg())
        && l5.ok && d5.status !== 0 && /can't be applied/.test(out(d5)) && /harness\/settings\.json/.test(out(d5)) && !mainHas('docs/demo/bad.md') && !mainHas(`studio-proposals/${l5.id}.json`),
      `${l4.log.slice(-300)}\nd4: ${out(d4).slice(-1200)}\nl5: ${l5.log.slice(-200)}\nd5: ${out(d5).slice(-800)}\nmain tuning=${JSON.stringify(mainJson('studio/tuning.json'))}`);
  });

  // ---- 5. with an owner key: the protected part waits for the owner's signature (held on main, a person asked) ----
  await guard('2.65.0 (s B-40 #5)', () => {
    const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
    const keyFile = path.join(tmpRoot, `owner-265s-${process.pid}.pem`);
    fs.writeFileSync(keyFile, privateKey.export({ type: 'pkcs8', format: 'pem' }));
    write(dir, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
    g(dir, 'add', 'studio/keys'); g(dir, 'commit', '-qm', 'owner key', '--no-verify');
    const l6 = lane('cfg-f', 'Docs: limit twelve', (id) => ({ 'docs/demo/twelve.md': '# Twelve\n', [`studio-proposals/${id}.json`]: proposal([{ file: 'studio/locked.json', set: { limit: 12 } }, { file: 'studio/tuning.json', set: { 'speed.max': 8 } }]) }));
    const q = queueIt(l6);
    train();
    const rel = run(dir, `node harness/task.mjs train release ${l6.id} --by Dana`, person);
    const t = train();
    const heldDoc = mainJson(`studio-proposals/${l6.id}.json`);
    const heldEv = evs().filter((e) => e.type === 'config.held' && e.task === l6.id).pop();
    const landedNoSig = isDone(l6.id) && mainJson('studio/tuning.json')?.speed?.max === 8 && mainJson('studio/locked.json')?.limit === 9 && heldDoc?.changes?.length === 1 && heldDoc.changes[0].file === 'studio/locked.json' && /signed approval/.test(heldDoc?.held || '') && heldEv?.to === 'human';
    const early = run(dir, `node harness/task.mjs train config ${l6.id} --by Dana`, person);
    const stillHeld = mainJson('studio/locked.json')?.limit === 9 && mainHas(`studio-proposals/${l6.id}.json`);
    const sign = run(dir, `node harness/approve.mjs proposal ${l6.id} --note "raise the limit for the playtest" --by Dana`, { ...person, STUDIO_OWNER_KEY: keyFile });
    const apply = run(dir, `node harness/task.mjs train config ${l6.id}`, env);
    report('2.65.0 (s B-40 #5): with an owner key, a released tier C lane lands and its non-protected part applies (speed.max 8), but the protected part (studio/locked.json) is held: it stays on main in the proposal with "held" naming the signed approval, a config.held event goes to a person, and train config without a signature applies nothing; after the owner signs (approve -- proposal <ID>) train config applies it (limit 12) and removes the proposal (fails on 2.64.0: no proposal route, no proposal approval)',
      l6.ok && q.status === 0 && rel.status === 0 && t.status === 0 && landedNoSig && early.status !== 0 && stillHeld
        && sign.status === 0 && apply.status === 0 && mainJson('studio/locked.json')?.limit === 12 && !mainHas(`studio-proposals/${l6.id}.json`),
      `${l6.log.slice(-300)}\nq: ${out(q).slice(-300)}\nrel: ${out(rel)}\nt: ${out(t).slice(-1200)}\nheld=${JSON.stringify(heldDoc)}\nev=${JSON.stringify(heldEv)}\nearly: ${out(early)}\nsign: ${out(sign)}\napply: ${out(apply)}\nlocked=${JSON.stringify(mainJson('studio/locked.json'))}`);
  });

  // ================= Visual proof: the per-camera noise baseline =================
  await guard('2.65.0 (s visual)', () => {
    const vp = probe('visual', `import fs from 'node:fs'; import path from 'node:path';
import { encodePng } from ${u('harness/png.mjs')};
import * as V from ${u('harness/visual-proof.mjs')};
const W = 64, H = 64;
// A gradient scene; "n cells brighter by 100" moves the mean luminance change by n * (100/255) / 4096.
const img = (bump = new Set()) => { const rgba = new Uint8Array(W * H * 4); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { const i = (y * W + x) * 4; const v = 40 + x + y + (bump.has(y * W + x) ? 100 : 0); rgba[i] = v; rgba[i + 1] = v; rgba[i + 2] = v; rgba[i + 3] = 255; } return { width: W, height: H, rgba }; };
const cells = (from, n) => new Set(Array.from({ length: n }, (_, k) => from + k));
const put = (task, side, im) => { const d = path.join(V.proofDir(task), side); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'deck.png'), encodePng(im)); };
const scene = img();
// T-971: noise 0.6% (63 cells), after changes 1.0% (105 other cells): over the old 1% line, under 2 x noise.
put('T-971', 'before', scene); put('T-971', 'before-noise', img(cells(0, 63))); put('T-971', 'after', img(cells(2000, 105)));
// T-972: the same noise, a real change of 2.5% (261 cells): clears 2 x noise.
put('T-972', 'before', scene); put('T-972', 'before-noise', img(cells(0, 63))); put('T-972', 'after', img(cells(2000, 261)));
// T-973: noise 3% (314 cells): 2 x noise is over the 5% cap, so even a 20% change is no pass.
put('T-973', 'before', scene); put('T-973', 'before-noise', img(cells(0, 314))); put('T-973', 'after', img(cells(1000, 2090)));
// T-974: an identical after, with a steady (zero-noise) before: never "changed".
put('T-974', 'before', scene); put('T-974', 'before-noise', scene); put('T-974', 'after', scene);
const r = { a: V.checkVisualProof('T-971'), b: V.checkVisualProof('T-972'), c: V.checkVisualProof('T-973'), d: V.checkVisualProof('T-974') };
// captureBeforeTwice: a capture function run twice, into before/ and before-noise/.
const calls = [];
const two = V.captureBeforeTwice((d) => { calls.push(path.basename(d)); fs.mkdirSync(d, { recursive: true }); fs.writeFileSync(path.join(d, 'deck.png'), encodePng(scene)); return { ok: true, files: ['deck.png'], why: '' }; }, V.proofDir('T-975'));
await V.recordVisual('T-972', r.b);
const verdict = JSON.parse(fs.readFileSync(path.join(path.dirname(V.proofDir('T-972')), 'verdict.json'), 'utf8'));
console.log(JSON.stringify({ r, calls, two: { ok: two.ok, noise: two.noise }, noiseDir: fs.existsSync(path.join(V.proofDir('T-975'), 'before-noise', 'deck.png')), verdict: verdict.parts.visual }));`);
    const cam = (x) => x?.cameras?.[0] || {};
    report('2.65.0 (s visual): with a measured noise of 0.6% (two before captures of the same code), a 1.0% change no longer passes: it must reach 2 x noise (1.2%, STUDIO_VISUAL_NOISE_K 2) and the failure names the camera and that bar; a 2.5% change still passes (fails on 2.64.0: the 1.0% change passed the fixed 1% line)',
      vp.r?.a?.ok === false && /deck: before and after are near-identical/.test(vp.r.a.why) && /2 x its noise 0\.60%/.test(vp.r.a.why) && Math.abs(cam(vp.r.a).noise - 0.00603) < 0.0002
        && vp.r?.b?.ok === true && cam(vp.r.b).need > 0.012 && cam(vp.r.b).diff > cam(vp.r.b).need, JSON.stringify(vp).slice(0, 2500));
    report('2.65.0 (s visual): a camera whose noise (3%) would put the bar over the cap (5%, STUDIO_VISUAL_NOISE_CAP) is "too noisy to judge" (an error naming the camera) even with a 20% change, and an identical after capture never passes as changed (fails on 2.64.0: the noisy scene passed)',
      vp.r?.c?.ok === false && /deck: the scene is too noisy to judge/.test(vp.r.c.why) && cam(vp.r.c).tooNoisy === true && vp.r?.d?.ok === false && /near-identical/.test(vp.r.d.why), JSON.stringify({ c: vp.r?.c, d: vp.r?.d, e: vp.error }).slice(0, 2000));
    report('2.65.0 (s visual): capturing "before" runs the capture twice (before/ and before-noise/), and the verdict (the proof JSON) records each camera\'s noise and the bar it had to clear (fails on 2.64.0: one capture, no noise anywhere)',
      JSON.stringify(vp.calls) === JSON.stringify(['before', 'before-noise']) && vp.two?.noise === true && vp.noiseDir === true && /noise 0\.006/.test((vp.verdict?.evidence || []).join(' ')) && /needs/.test((vp.verdict?.evidence || []).join(' ')) && /noise baseline/.test(vp.verdict?.why || ''),
      JSON.stringify({ calls: vp.calls, two: vp.two, noiseDir: vp.noiseDir, verdict: vp.verdict, e: vp.error }).slice(0, 2000));
    const tid = addTask('Render: the deck lights');
    const vdir = path.join(dir, '.studio', 'proof', tid, 'visual');
    fs.mkdirSync(path.dirname(vdir), { recursive: true });
    fs.cpSync(path.join(dir, '.studio', 'proof', 'T-972'), path.join(dir, '.studio', 'proof', tid), { recursive: true });
    const dc = run(dir, `node harness/done-check.mjs ${tid}`, env);
    report('2.65.0 (s visual): node harness/done-check.mjs <ID> shows the visual result on file with its noise baseline ("visual result: PASS", noise, needs) (fails on 2.64.0: no visual result line)',
      /visual result: PASS/.test(out(dc)) && /noise 0\.006/.test(out(dc)) && /needs/.test(out(dc)), out(dc).slice(-1500));
  });

  // ================= Windows orphans of a full verify's gates =================
  await guard('2.65.0 (s heavy)', () => {
    const t0 = Date.now() - 600000;
    const hp = probe('heavy', `import { runGateCommand, recordGateShell } from ${u('harness/gate-spawn.mjs')};
import { holderTree, killHolderTree } from ${u('harness/heavy.mjs')};
// A fake machine:heavy handle: update() applies to an in-memory record.
let rec = { pid: 100, identity: { start: ${t0} }, tree: { root: 100, groups: [], kill: 'taskkill /T /F <root>' } };
const lk = { update: (fn) => { rec = fn(rec); return true; } };
const win = await runGateCommand('node -e "console.log(41 + 1); process.exit(3)"', { cwd: process.cwd(), compact: true, lk, platform: 'win32', identity: (pid) => ({ start: ${t0} + 1000, cmd: 'cmd.exe', pid }) });
let syncCalls = 0;
const posix = await runGateCommand('echo hi', { cwd: process.cwd(), compact: true, lk: { update: () => { throw new Error('POSIX must not record'); } }, platform: 'linux', spawnSyncFn: (cmd, o) => { syncCalls += 1; return { status: 0, stdout: 'hi\\n', stderr: '', pid: 7 }; } });
// The simulated Windows process list (STUDIO_PROC_LIST_STUB shape): the verify (100) still runs; gate shell 200 ended and
// left vitest 300 (and its worker 301) naming it; 400 also names 200 but started before it (a reused number): not ours.
const shellRec = { 200: { start: ${t0} + 1000, cmd: 'cmd.exe' } };
const holder = { pid: 100, identity: { start: ${t0} }, tree: { root: 100, groups: [], kill: 'taskkill /T /F <root>', children: shellRec } };
const procs = [
  { pid: 100, ppid: 1, start: ${t0}, cmd: 'node.exe' },
  { pid: 300, ppid: 200, start: ${t0} + 2000, cmd: 'node.exe' },
  { pid: 301, ppid: 300, start: ${t0} + 2500, cmd: 'node.exe' },
  { pid: 400, ppid: 200, start: ${t0} - 50000, cmd: 'other.exe' },
];
const live = holderTree(holder, procs, { self: 999 });
// The verify is gone too (killed): the next take or heavy stop kills the orphans with taskkill /T /F.
const gone = procs.filter((p) => p.pid !== 100);
let listed = 0;
const killed = killHolderTree(holder, { listProcs: () => (listed++ === 0 ? gone : gone.filter((p) => p.pid === 400)), exec: () => ({ status: 0 }), platform: 'win32', graceMs: 50, self: 999 });
console.log(JSON.stringify({ win: { status: win.status, out: win.stdout.trim(), recorded: win.recorded, pid: win.pid }, children: Object.keys(rec.tree.children || {}), childRec: (rec.tree.children || {})[win.pid], posix: { status: posix.status, recorded: posix.recorded, syncCalls }, live: live.members, killed: { members: killed.members, commands: killed.commands } }));`);
    report('2.65.0 (s heavy): a gate run the Windows way (platform win32, a slot held) records its shell pid with its start identity in the machine:heavy holder\'s tree.children, keeps the gate\'s exit code and output; POSIX runs exactly the old spawnSync and records nothing (fails on 2.64.0: run-gates ran every gate with spawnSync and recorded no gate shell)',
      hp.win?.status === 3 && hp.win?.out === '42' && hp.win?.recorded === true && hp.children?.includes(String(hp.win.pid)) && hp.childRec?.cmd === 'cmd.exe' && hp.posix?.status === 0 && hp.posix?.recorded === false && hp.posix?.syncCalls === 1,
      JSON.stringify(hp).slice(0, 2000));
    report('2.65.0 (s heavy): with the verify still running, its tree includes what a finished gate shell left running (vitest 300 and its worker 301, still naming the dead shell) but not an older process that names the same number (400); once the verify is gone too, the take/stop kill is taskkill /T /F on that orphan (simulated Windows process list) (fails on 2.64.0: recorded children were looked at only after the holder died)',
      JSON.stringify(hp.live) === JSON.stringify([100, 300, 301]) && JSON.stringify(hp.killed?.members) === JSON.stringify([300, 301]) && (hp.killed?.commands || []).some((c) => c.join(' ') === 'taskkill /T /F /PID 300') && !(hp.killed?.commands || []).some((c) => c.includes('400')),
      JSON.stringify(hp).slice(0, 2000));

    // run-gates itself: a full-verify-like run holding machine:heavy records each gate's shell before the gate runs.
    const gd = path.join(tmpRoot, `gates-265s-${process.pid}`);
    fs.mkdirSync(path.join(gd, 'studio'), { recursive: true });
    const check = path.join(tmpRoot, `gate-check-265s-${process.pid}.cjs`);
    fs.writeFileSync(check, `const fs = require('fs'); const path = require('path');
const dir = path.join(${JSON.stringify(dir)}, '.studio', 'locks');
const f = fs.readdirSync(dir).filter((x) => /^machine-heavy-\\d+\\.lock$/.test(x)).map((x) => JSON.parse(fs.readFileSync(path.join(dir, x), 'utf8')))[0] || {};
const kids = Object.keys((f.tree && f.tree.children) || {});
const mine = [process.pid, process.ppid].map(String).some((p) => kids.includes(p));
console.log(mine ? 'GATE SHELL RECORDED ' + kids.join(',') : 'NOT RECORDED ' + JSON.stringify(f));
process.exit(mine ? 0 : 1);
`);
    const gjOld = fs.readFileSync(path.join(dir, 'studio/gates.json'), 'utf8');
    write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [{ id: 'shellrec', command: `node "${check}"`, required: true, heavy: true, cache: false }] }, null, 2)}\n`);
    const rg = run(dir, 'node scripts/run-gates.mjs --only shellrec --no-cache', { ...env, STUDIO_GATE_SPAWN: 'recorded', STUDIO_HEAVY_SLOTS: '1', STUDIO_COMPACT_OUTPUT: '', STUDIO_HEAVY_OWN_GROUP: 'off', STUDIO_HEAVY_HELD: '' });
    write(dir, 'studio/gates.json', gjOld);
    report('2.65.0 (s heavy): scripts/run-gates.mjs holding machine:heavy, run the Windows way (STUDIO_GATE_SPAWN=recorded on this OS), records the gate\'s shell in the holder\'s tree.children before the gate\'s own process runs (the gate reads the lock and finds its shell) (fails on 2.64.0: nothing recorded)',
      rg.status === 0 && /GATE SHELL RECORDED/.test(out(rg)) && /PASS shellrec/.test(out(rg)), out(rg).slice(-1500));
  });
}

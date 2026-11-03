/**
 * qa/selftest-273g.mjs — 2.73.0 (g): signed verify records, and golden re-records that need the harness's first-divergence
 * report plus a second signer (A13).
 *   1. A hand-written verify record AND a matching hand-written run log (the hole 2.71.1 left) are not reused: "not
 *      reused: unsigned record (hand-written or from an older harness)" (train and recordTrust, which task done uses).
 *   2. A real verify makes the studio's verify key outside the checkout (mode 600), never prints it, signs its run log;
 *      the train reuses that record; an edited signature, or the same files checked with another studio's key, are not.
 *   3. A key folder inside the checkout is refused: the verify says its record isn't signed, and it isn't reused.
 *   4. A red golden (and npm run golden -- --update on a changed answer) writes the signed first-divergence report
 *      .studio/gates/divergence/<golden>.json (tick, field, the recorded answer it replaces).
 *   5. The train holds a lane that re-records a golden with the report in its why; the lane's own agent can't release it
 *      (not even by delegation); another agent's delegation can, and the decision log records the tick and field.
 *   6. Without a report (none, or a hand-written one) the hold says so: a delegation is refused, a person releases it.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest273G({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', '-c', 'core.hooksPath=.no-hooks', ...a], { cwd: dir, encoding: 'utf8' });
  const writeIn = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const KEYS = path.join(tmpRoot, 'vk-273g');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, 'no-owner-key-273g.pem'), STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '', GITHUB_BASE_REF: '',
    STUDIO_LOCK_OWNER: '', STUDIO_VERIFY_RUN: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_ROLE: '', STUDIO_AGENT: '', CI: '', GITHUB_ACTIONS: '',
    CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_VERIFY_KEY_DIR: KEYS, STUDIO_DIVERGENCE_REF: '', STUDIO_GOLDEN_DIVERGENCE: '' };
  const json = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').filter((l) => l.startsWith('{')).pop()); } catch { return { _raw: out(r).slice(-2000) }; } };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, ok, detail); } catch (e) { report(name, false, e.stack || e.message); } };
  const probe = (name, code, extra = {}) => {
    const f = path.join(tmpRoot, `probe-273g-${name}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    return { ...json(r), _out: out(r).slice(-1500) };
  };
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const keyFiles = () => { try { return fs.readdirSync(KEYS).filter((n) => n.endsWith('.key')); } catch { return []; } };

  // ---- a made-up studio: a one-check verify, the example cartridge's goldens, git on main ----
  for (const f of ['studio/delegation.json', 'studio/policy.json', 'studio/keys/owner-ed25519.pub.pem', '.studio/decisions.jsonl', '.studio/train', '.studio/gates', '.studio/gates-last-full.json', '.studio/gates-last.json']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  writeIn('studio/gates.json', `${JSON.stringify({ gates: [{ id: 'game', command: 'node -e "process.exit(0)"', required: true, lite: true }] }, null, 2)}\n`);
  if (!fs.existsSync(path.join(dir, '.git'))) g('init', '-q', '-b', 'main');
  g('checkout', '-q', '-B', 'main');
  g('add', '-A'); g('commit', '-q', '--no-verify', '-m', 'studio 273g');
  const tree = g('rev-parse', 'HEAD^{tree}').stdout.trim();
  const headSha = g('rev-parse', 'HEAD').stdout.trim();
  const gatesDir = path.join(dir, '.studio', 'gates');
  const fresh = () => { for (const d of [gatesDir, path.join(dir, '.studio', 'train'), path.join(dir, '.studio', 'gates-last-full.json'), path.join(dir, '.studio', 'gates-last.json')]) fs.rmSync(d, { recursive: true, force: true }); };
  const verify = (owner, extra = {}) => run(dir, 'node scripts/run-gates.mjs --no-detach', { ...env, STUDIO_LOCK_OWNER: owner, ...extra });
  const recOf = (owner) => { try { return JSON.parse(fs.readFileSync(path.join(gatesDir, `${owner}-full.json`), 'utf8')); } catch { return null; } };
  const train = (name, extra = {}) => probe(`vt-${name}`, `import { verifyTree } from ${u('harness/train.mjs')};
import { recordTrust } from ${u('harness/gate-trust.mjs')};
import fs from 'node:fs'; import path from 'node:path';
const logs = [];
const r = verifyTree({ root: process.cwd(), dir: process.cwd() }, { id: 'tt-${name}', n: 1, tree: ${JSON.stringify(tree)}, changed: [], all: false, seen: new Map(), log: (m) => logs.push(m) });
let trust = null;
try { const g = path.join(process.cwd(), '.studio', 'gates'); const f = fs.readdirSync(g).find((n) => n.endsWith('-full.json')); if (f) trust = recordTrust(JSON.parse(fs.readFileSync(path.join(g, f), 'utf8')), [path.join(process.cwd(), '.studio')]); } catch {}
console.log(JSON.stringify({ reused: Boolean(r.reused), ok: r.ok, logs, trust }));
`, extra);

  // ---- 1. a hand-written record and a hand-written run log that matches it ----
  await guard('2.73.0 (g)(1): a hand-written verify record AND a hand-written run log with the matching digest are not reused: the train and recordTrust (task done\'s check) say "not reused: unsigned record (hand-written or from an older harness)" and the verify runs (fails on 2.72.0: the pair was reused)', () => {
    fresh();
    const p = probe('forge', `import { recordDigest } from ${u('harness/gate-trust.mjs')};
import fs from 'node:fs'; import path from 'node:path';
const g = path.join(process.cwd(), '.studio', 'gates');
const rec = { runId: 'f0f0f0f0f0f0f0f0', at: new Date().toISOString(), head: ${JSON.stringify(headSha)}, tree: ${JSON.stringify(tree)}, dirty: false, partial: false, scope: 'lite', tier: null, rows: [{ id: 'game', ok: true, required: true }] };
fs.mkdirSync(path.join(g, 'runs'), { recursive: true });
fs.writeFileSync(path.join(g, 'forger-full.json'), JSON.stringify(rec));
fs.writeFileSync(path.join(g, 'runs', rec.runId + '.json'), JSON.stringify({ runId: rec.runId, at: rec.at, head: rec.head, tree: rec.tree, dirty: false, digest: recordDigest(rec), by: 'scripts/run-gates.mjs' }));
console.log(JSON.stringify({ ok: true }));`);
    const t = train('forged');
    fresh();
    return [p.ok && !t.reused && t.logs?.some((l) => /not reused: unsigned record \(hand-written or from an older harness\)/.test(l)) && t.trust && !t.trust.ok && /unsigned record/.test(t.trust.why), JSON.stringify({ p, t }).slice(0, 2500)];
  });

  // ---- 2. an honest verify: the key, the signature, reuse; an edited signature or another studio's key ----
  await guard('2.73.0 (g)(2): a real verify makes the studio\'s verify key in STUDIO_VERIFY_KEY_DIR (outside the checkout, mode 600), never prints it, signs its run log (hmac-sha256 + key id), and the train reuses that record; the same run log with its signature edited, or checked with another studio\'s key folder, is not reused ("not signed by this studio\'s harness") (fails on 2.72.0: no key, no signature)', () => {
    fresh();
    fs.rmSync(KEYS, { recursive: true, force: true });
    const v = verify('ok-1');
    const rec = recOf('ok-1');
    const keys = keyFiles();
    const keyText = keys.length ? fs.readFileSync(path.join(KEYS, keys[0]), 'utf8').trim() : '';
    const mode = keys.length && process.platform !== 'win32' ? (fs.statSync(path.join(KEYS, keys[0])).mode & 0o777) : 0o600;
    const logFile = rec ? path.join(gatesDir, 'runs', `${rec.runId}.json`) : '';
    const log = rec ? JSON.parse(fs.readFileSync(logFile, 'utf8')) : null;
    const leaked = keyText && (out(v).includes(keyText) || JSON.stringify(rec).includes(keyText) || JSON.stringify(log).includes(keyText));
    const honest = train('honest');
    const other = train('other-key', { STUDIO_VERIFY_KEY_DIR: path.join(tmpRoot, 'vk-273g-other') });
    const flipped = { ...log, sig: { ...log.sig, value: `${log.sig.value[0] === '0' ? '1' : '0'}${log.sig.value.slice(1)}` } };
    fs.writeFileSync(logFile, JSON.stringify(flipped));
    const edited = train('edited');
    fresh();
    fs.rmSync(path.join(tmpRoot, 'vk-273g-other'), { recursive: true, force: true });
    const ok = v.status === 0 && keys.length === 1 && /^[0-9a-f]{64}$/.test(keyText) && mode === 0o600 && !leaked
      && log?.sig?.alg === 'hmac-sha256' && /^[0-9a-f]{12}$/.test(log.sig.keyId) && honest.reused
      && !other.reused && other.logs?.some((l) => /not signed by this studio's harness/.test(l))
      && !edited.reused && edited.logs?.some((l) => /not signed by this studio's harness \(bad signature/.test(l));
    return [ok, JSON.stringify({ v: out(v).slice(-600), keys, mode, leaked, sig: log?.sig ? { alg: log.sig.alg, keyId: log.sig.keyId } : null, honest: honest.logs, other: other.logs, edited: edited.logs }).slice(0, 3000)];
  });

  // ---- 3. a key folder inside the checkout ----
  await guard('2.73.0 (g)(3): STUDIO_VERIFY_KEY_DIR inside the checkout is refused: no key is made there, the verify says its record is not signed, and the train doesn\'t reuse it (fails on 2.72.0: the record was reused, nothing said)', () => {
    fresh();
    const inside = path.join(dir, '.studio', 'keys-273g');
    const v = verify('in-1', { STUDIO_VERIFY_KEY_DIR: inside });
    const t = train('inside', { STUDIO_VERIFY_KEY_DIR: inside });
    const made = fs.existsSync(inside) && fs.readdirSync(inside).length > 0;
    fs.rmSync(inside, { recursive: true, force: true });
    fresh();
    return [v.status === 0 && /record is not signed \(the verify key folder .* is inside a checkout of this studio/.test(out(v)) && !made && !t.reused, `${out(v).slice(-700)}\n${JSON.stringify(t).slice(0, 900)}`];
  });

  // ---- 4. the first-divergence report on a red golden and on --update ----
  const idx = path.join(dir, 'cartridges/example-sim/index.mjs');
  const orig = fs.readFileSync(idx, 'utf8');
  const BUGGED = orig.replace('state.resources.credits += t.baseIncome + units', 'state.resources.credits += (state.tick === 23 ? 1 : 0) + t.baseIncome + units');
  const GOLD = 'qa/golden/example-1337.json';
  const repFile = path.join(dir, '.studio', 'gates', 'divergence', 'qa__golden__example-1337.json');
  const repDir = path.dirname(repFile);
  const mainBlob = g('rev-parse', `main:${GOLD}`).stdout.trim();
  const entries = () => { try { return JSON.parse(fs.readFileSync(repFile, 'utf8')).entries || []; } catch { return []; } };
  /** A lane branch that re-records the golden after the sim change (check first unless noCheck), with its trailers. */
  const lane = (name, agent, { noCheck = false } = {}) => {
    g('checkout', '-q', '-B', `lane/${name}`, 'main');
    fs.writeFileSync(idx, BUGGED);
    const red = noCheck ? null : run(dir, 'node qa/check-golden.mjs', { ...env, STUDIO_LOCK_OWNER: agent });
    const upd = run(dir, 'node qa/check-golden.mjs --update', { ...env, STUDIO_LOCK_OWNER: agent, ...(noCheck ? { STUDIO_GOLDEN_DIVERGENCE: 'off' } : {}) });
    g('add', '-A', 'cartridges', 'qa/golden');
    g('commit', '-q', '--no-verify', '-m', `${name}: credits bonus at tick 23`, '-m', `Golden-Reason: the tick-23 bonus is intended\nStudio-Agent: ${agent}`);
    const head = g('rev-parse', 'HEAD').stdout.trim();
    g('checkout', '-q', 'main');
    return { red, upd, head };
  };
  fs.rmSync(repDir, { recursive: true, force: true });
  const L1 = lane('l1', 'opus-bot');
  await guard('2.73.0 (g)(4): a red golden writes its signed first-divergence report to .studio/gates/divergence/<golden>.json (tick 23, resources.credits, the recorded answer it replaces = main\'s blob, the new answer, who ran it); npm run golden -- --update on a changed answer writes it too, before the file changes (fails on 2.72.0: no report file)', () => {
    const e1 = entries();
    fs.rmSync(repDir, { recursive: true, force: true });
    g('checkout', '-q', '-B', 'lane/tmp4', 'main'); fs.writeFileSync(idx, BUGGED);
    const upd = run(dir, 'node qa/check-golden.mjs --update', { ...env, STUDIO_LOCK_OWNER: 'opus-bot' });
    const e2 = entries();
    g('checkout', '-q', '--', '.'); g('checkout', '-q', 'main'); g('branch', '-q', '-D', 'lane/tmp4');
    const good = (e) => e && e.rel === GOLD && e.blob === mainBlob && e.tick === 23 && e.field === 'resources.credits' && e.subsystem === 'resources' && /^[0-9a-f]{64}$/.test(e.answer || '') && e.agent === 'opus-bot' && e.sig?.alg === 'hmac-sha256';
    return [L1.red?.status === 1 && L1.upd.status === 0 && good(e1[0]) && upd.status === 0 && good(e2[0]), JSON.stringify({ red: out(L1.red || {}).slice(-500), e1: e1.slice(0, 2), e2: e2.slice(0, 1), upd: out(upd).slice(-400) }).slice(0, 3000)];
  });

  // ---- 5 and 6. the train's hold, the second signer and the decision log ----
  writeIn('studio/delegation.json', `${JSON.stringify({ agent: 'opus-bot', actions: ['train-release'], until: new Date(Date.now() + 6 * 3600e3).toISOString(), by: 'Dana', at: new Date().toISOString(), why: 'standing delegation for the merge conductor' }, null, 2)}\n`);
  g('add', 'studio/delegation.json'); g('commit', '-q', '--no-verify', '-m', 'delegation for opus-bot');
  // Lanes branch from main after the delegation commit (its golden blob is still main's).
  g('branch', '-q', '-f', 'lane/l1-base', 'main');
  const L1b = lane('l1b', 'opus-bot');
  const L2 = lane('l2', 'builder-x');
  const L3 = lane('l3', 'builder-y', { noCheck: true });
  const agentEnv = { STUDIO_LOCK_OWNER: 'opus-bot', CLAUDECODE: '1' };
  const personEnv = { STUDIO_LOCK_OWNER: '' };
  /** Hold the lane as the train does (its tier, why and re-record facts in the queue), then try each release in turn. */
  const holdAndRelease = (name, task, head, agent, releases) => {
    probe(`hr-${name}`, `import { laneTier, holdLane } from ${u('harness/train.mjs')};
const root = process.cwd();
const c = await laneTier(root, { head: ${JSON.stringify(head)}, task: ${JSON.stringify(task)}, agent: ${JSON.stringify(agent)}, dir: root });
holdLane(root, { task: ${JSON.stringify(task)}, agent: ${JSON.stringify(agent)}, dir: root, branch: 'lane/${name}', head: ${JSON.stringify(head)} }, { tier: c.tier, why: c.why.join('; '), ...(c.rerecord ? { rerecord: c.rerecord } : {}) });
console.log(JSON.stringify({ tier: c.tier }));`);
    return releases.map((r) => probe(`rl-${name}-${r.label}`, `import { releaseLane } from ${u('harness/train.mjs')};
console.log(JSON.stringify(releaseLane(process.cwd(), ${JSON.stringify(task)}, { by: ${JSON.stringify(r.by)} })));`, r.env));
  };
  const tierOf = (name, task, head, agent) => probe(`t-${name}`, `import { laneTier } from ${u('harness/train.mjs')};
const c = await laneTier(process.cwd(), { head: ${JSON.stringify(head)}, task: ${JSON.stringify(task)}, agent: ${JSON.stringify(agent)}, dir: process.cwd() });
console.log(JSON.stringify({ tier: c.tier, why: c.why.join('; ') }));`);
  const decisions = () => { try { return fs.readFileSync(path.join(dir, '.studio', 'decisions.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)).filter((d) => d.action === 'train-release'); } catch { return []; } };

  await guard('2.73.0 (g)(5): a lane that re-records a golden is held tier C with the harness\'s report in its why ("first divergence for qa/golden/example-1337.json: tick 23, resources.credits ..."); its own agent can\'t release it by delegation ("is this lane\'s author: ... needs a second signer"); another agent\'s lane is released by the same delegation and the decision log records the tick and field (fails on 2.72.0: no report in the hold, and the author released its own re-record)', () => {
    const t1 = tierOf('l1b', 'T-901', L1b.head, 'opus-bot');
    const r1 = holdAndRelease('l1b', 'T-901', L1b.head, 'opus-bot', [{ label: 'self', by: 'opus-bot', env: agentEnv }]);
    const r2 = holdAndRelease('l2', 'T-902', L2.head, 'builder-x', [{ label: 'other', by: 'opus-bot', env: agentEnv }]);
    const d2 = decisions().find((d) => d.subject === 'T-902');
    const ok = t1.tier === 'C' && /first divergence for qa\/golden\/example-1337\.json: tick 23, resources\.credits \S+ -> \S+ \(subsystem resources\)/.test(t1.why)
      && r1[0] && !r1[0].ok && /opus-bot is this lane's author .* needs a second signer/.test(r1[0].message)
      && r2[0]?.ok === true && /first divergence for qa\/golden\/example-1337\.json: tick 23/.test(r2[0].message)
      && d2 && /qa\/golden\/example-1337\.json: first divergence tick 23, resources\.credits/.test(d2.evidence) && !decisions().some((d) => d.subject === 'T-901');
    return [ok, JSON.stringify({ t1, r1, r2, d2 }).slice(0, 3000)];
  });

  await guard('2.73.0 (g)(6): a re-record with no report (no golden check ran before --update), or with a hand-written report entry, is held with "no first-divergence report ... only a person releases it"; the delegation is refused, a person (Dana, in her own terminal) releases it and the decision log says there was no report (fails on 2.72.0: the delegation released it and nothing named the missing report)', () => {
    fs.rmSync(repDir, { recursive: true, force: true });
    const r3 = holdAndRelease('l3', 'T-903', L3.head, 'builder-y', [{ label: 'deleg', by: 'opus-bot', env: agentEnv }, { label: 'person', by: 'Dana', env: personEnv }]);
    const d3 = decisions().find((d) => d.subject === 'T-903');
    // A hand-written entry for the same golden and answer counts as none.
    fs.mkdirSync(repDir, { recursive: true });
    fs.writeFileSync(repFile, JSON.stringify({ entries: [{ rel: GOLD, blob: mainBlob, answer: null, found: true, tick: 5, subsystem: 'resources', field: 'resources.credits', from: '1', to: '2', agent: 'builder-y' }] }));
    const t4 = tierOf('l3-forged', 'T-904', L3.head, 'builder-y');
    fs.rmSync(repDir, { recursive: true, force: true });
    const ok = r3[0] && !r3[0].ok && /no first-divergence report for qa\/golden\/example-1337\.json: no golden check ran on it before the re-record/.test(r3[0].message) && /a person does/.test(r3[0].message)
      && r3[1]?.ok === true && d3 && /qa\/golden\/example-1337\.json: no first-divergence report/.test(d3.evidence) && d3.by === 'Dana'
      && t4.tier === 'C' && /no first-divergence report for qa\/golden\/example-1337\.json: the report there is not the harness's \(unsigned/.test(t4.why);
    return [ok, JSON.stringify({ r3, d3, t4 }).slice(0, 3000)];
  });

  // put the studio back as it was (the cartridge, main, the delegation, the key folder)
  fs.writeFileSync(idx, orig);
  g('checkout', '-q', '-f', 'main');
  for (const b of ['l1', 'l1b', 'l2', 'l3', 'l1-base']) g('branch', '-q', '-D', `lane/${b}`);
  g('rm', '-q', 'studio/delegation.json'); g('commit', '-q', '--no-verify', '-m', 'drop the delegation');
  for (const f of ['.studio/train', '.studio/decisions.jsonl', '.studio/gates']) fs.rmSync(path.join(dir, f), { recursive: true, force: true });
  fs.rmSync(KEYS, { recursive: true, force: true });
}

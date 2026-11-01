/**
 * qa/selftest-262g.mjs — 2.62.0: the sealed replay bench and the component-removal review (harness/bench.mjs).
 *
 * A made-up studio with bench cases whose graders are hidden check files; a node stand-in agent
 * (STUDIO_BENCH_AGENT_CMD) that solves, half-solves, skips, stalls or overspends per a plan file, and records what it
 * could see. On 2.59.1 there is no bench command, so every check here fails.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest262G({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const work = path.join(tmpRoot, 'bench-262g');
  fs.mkdirSync(work, { recursive: true });
  const standin = path.join(work, 'standin.mjs');
  const planFile = path.join(work, 'plan.json');
  const logFile = path.join(work, 'standin.log');
  const copies = path.join(work, 'copies');
  const env = {
    ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '',
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_BENCH_DIR: '',
    STUDIO_BENCH_AGENT_CMD: `node "${standin}" {case} {try}`, STUDIO_BENCH_COPIES: copies, BENCH_STANDIN_PLAN: planFile, BENCH_STANDIN_LOG: logFile,
    STUDIO_WEAKENED_TESTS: '', STUDIO_HEAVY_SLOTS: '1',
  };
  const git = (cmd) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`, env);
  const bench = (args, e = {}) => run(dir, `node harness/bench.mjs ${args}`, { ...env, ...e });
  const standinLog = () => { try { return fs.readFileSync(logFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const runIdFrom = (r) => (out(r).match(/Bench run (\S+?)(?: without \S+)? \(harness/) || [])[1];
  const results = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'bench', id, 'results.json'), 'utf8')); } catch { return null; } };

  // The stand-in agent: what it does per case and try comes from the plan; it reports usage like a tool would.
  fs.writeFileSync(standin, `import fs from 'node:fs';
const [cs, tr] = process.argv.slice(2);
const t = Number(tr);
const plan = JSON.parse(fs.readFileSync(process.env.BENCH_STANDIN_PLAN, 'utf8'));
const rule = plan[cs] || 'none';
fs.appendFileSync(process.env.BENCH_STANDIN_LOG, JSON.stringify({ case: cs, try: t, sealed: !fs.existsSync('studio/bench'), hiddenAbsent: !fs.existsSync('qa/bench-' + cs + '.check.mjs'),
  onBoard: fs.readFileSync('studio/NEXT.md', 'utf8').includes('T-0'), brief: fs.existsSync('studio/handoffs') ? fs.readdirSync('studio/handoffs').map((f) => fs.readFileSync('studio/handoffs/' + f, 'utf8')).join('') : '',
  weak: process.env.STUDIO_WEAKENED_TESTS || null, maxTokens: process.env.STUDIO_TASK_MAX_TOKENS || null, ownRoot: process.env.STUDIO_MAIN_ROOT === process.cwd() }) + '\\n');
const solve = (ok) => { fs.mkdirSync('out', { recursive: true }); fs.writeFileSync('out/' + cs + '.txt', ok ? 'solved' : 'wrong'); };
let tokens = 1000;
if (rule === 'pass') solve(true);
else if (rule.startsWith('tries:')) solve(rule.slice(6).split('+').map(Number).includes(t));
else if (rule === 'mix') { if (t === 1) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 30000); solve(true); if (t === 2) tokens = 9000000; }
else if (rule === 'offfails') solve(process.env.STUDIO_WEAKENED_TESTS !== 'off');
console.log(JSON.stringify({ type: 'result', num_turns: 5, usage: { input_tokens: tokens, output_tokens: 200 } }));
`);

  git('init -q -b main');
  git('config core.autocrlf false');
  git('add -A');
  git('commit -q -m base --no-verify');
  // Cases: a hidden check file each (its grader), committed into the studio (so the start tree has studio/bench/).
  const ids = ['c1', 'c2', 'c3', 'c4', 'w1', 'w2', 'w3', 'w4', 'w5', 'w6'];
  const writeCases = (commit) => ids.forEach((id, i) => {
    const cdir = path.join(dir, 'studio', 'bench', 'cases');
    fs.mkdirSync(path.join(cdir, id, 'files', 'qa'), { recursive: true });
    fs.writeFileSync(path.join(cdir, id, 'files', 'qa', `bench-${id}.check.mjs`), `import fs from 'node:fs';\nlet t = ''; try { t = fs.readFileSync('out/${id}.txt', 'utf8').trim(); } catch {}\nprocess.exit(t === 'solved' ? 0 : 1);\n`);
    fs.writeFileSync(path.join(cdir, `${id}.json`), JSON.stringify({ id, from: { task: `T-0${10 + i}`, title: `Made-up task ${id}` }, commit, brief: `Write out/${id}.txt for case ${id} (made-up brief)`, grader: { pass: [`node qa/bench-${id}.check.mjs`], mustChange: ['out/**'] }, tokenCap: 100000, timeoutMin: id === 'c4' ? 0.05 : 5 }, null, 2));
  });
  writeCases('0'.repeat(40));
  git('add -A');
  git('commit -q -m "bench cases" --no-verify');
  const start = git('rev-parse HEAD').stdout.trim();
  writeCases(start);
  git('add -A');
  git('commit -q -m "bench cases at their commit" --no-verify');
  fs.writeFileSync(planFile, JSON.stringify({ c1: 'pass', c2: 'tries:1+2', c3: 'none', c4: 'mix', w1: 'offfails', w2: 'offfails', w3: 'offfails', w4: 'offfails', w5: 'offfails', w6: 'offfails' }));

  // 1. Who may spend tokens: --by a person; an agent only on a person's permission; workers never.
  const PERM = 'Hatch on Discord 2026-11-01 20:10, run the bench on c1 and c2';
  const noBy = bench('run --cases c1 --k 1 --yes');
  const agentNoPerm = bench('run --by hatch --cases c1 --k 1 --yes', { CLAUDECODE: '1' });
  const worker = bench(`run --by hatch --permission "${PERM}" --cases c1 --k 1 --yes`, { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s4' });
  const agentBy = bench('run --by opus-bot --cases c1 --k 1 --yes');
  report('2.62.0 (bench): a run without --by <person> is refused, as is an agent without --permission, a worker session with it, and an agent\'s name as --by; nothing ran',
    noBy.status === 1 && /who is asking/.test(out(noBy)) && agentNoPerm.status === 1 && /--permission/.test(out(agentNoPerm)) && worker.status === 1 && /builder/.test(out(worker))
      && agentBy.status === 1 && /agent's name/.test(out(agentBy)) && !standinLog().length,
    [noBy, agentNoPerm, worker, agentBy].map((r) => `${r.status}: ${out(r).slice(-300)}`).join('\n---\n'));

  // 2. The token ceiling first, and --yes to start.
  const dry = bench('run --by hatch --cases c1,c2 --k 3');
  report('2.62.0 (bench): a run prints its token ceiling (2 cases x 3 tries x 100,000 = 600,000) and starts nothing without --yes',
    dry.status === 2 && /token ceiling 600,000/.test(out(dry)) && /--yes/.test(out(dry)) && !standinLog().length && !fs.existsSync(path.join(dir, '.studio', 'bench')),
    `${dry.status}: ${out(dry)}`);

  // 3. k=3 over 4 cases: per-try results, pass@1, pass^k, caps enforced, the copy sealed.
  const r3 = bench('run --by hatch --cases c1,c2,c3,c4 --k 3 --yes --label k3');
  const id3 = runIdFrom(r3);
  const res3 = id3 ? results(id3) : null;
  const pc = res3?.score?.perCase || {};
  const t4 = (n) => (res3?.tries || []).find((t) => t.case === 'c4' && t.try === n) || {};
  const seen = standinLog();
  report('2.62.0 (bench): run --k 3 over 4 cases records every try in .studio/bench/<run>/results.json and scores them: c1 3/3, c2 2/3, c3 0/3, c4 1/3 (try 1 stopped at its timeout, try 2 over its token cap); pass@1 50%, pass^3 25%',
    r3.status === 0 && res3?.done === true && res3.tries.length === 12 && pc.c1?.passes === 3 && pc.c2?.passes === 2 && pc.c3?.passes === 0 && pc.c4?.passes === 1
      && t4(1).timedOut === true && t4(1).pass === false && t4(2).overCap === true && t4(2).pass === false && t4(3).pass === true
      && res3.score.pass1 === 0.5 && res3.score.passK === 0.25 && /pass@1 50%/.test(out(r3)) && /pass\^3 25%/.test(out(r3)) && res3.tries.filter((t) => !t.timedOut).every((t) => t.tokens > 0 && t.turns === 5) && t4(1).tokensUnknown === true,
    `${r3.status}: ${out(r3).slice(-1500)}\n${JSON.stringify(res3?.score || res3)?.slice(0, 1500)}`);
  report('2.62.0 (bench): each try runs in a clean copy without studio/bench/ and before its hidden grader files exist, with the task on its board and the brief as its note, the case\'s tokenCap as the task budget, and its own root; the copies are removed afterwards',
    seen.length === 12 && seen.every((s) => s.sealed && s.hiddenAbsent && s.onBoard && /made-up brief/.test(s.brief) && !/bench-c\d\.check/.test(s.brief) && s.maxTokens === '100000' && s.ownRoot)
      && !fs.existsSync(path.join(copies, id3 || 'none')) && git('for-each-ref refs/studio-bench').stdout.trim() === '',
    JSON.stringify(seen.slice(0, 3)));

  // 4. compare: paired, a sign test, a verdict; too few cases is said so.
  const synth = (name, rates) => {
    const perCase = Object.fromEntries(rates.map((r, i) => [`s${i}`, { tries: 3, passes: Math.round(r * 3), rate: r, allPass: r === 1, tokens: 1000 + i, turns: 5, minutes: 1 }]));
    const f = path.join(work, `${name}.json`);
    fs.writeFileSync(f, JSON.stringify({ id: name, by: 'hatch', k: 3, harness: { sha: 'a'.repeat(40) }, without: null, score: { perCase, pass1: 0, passK: 0, cases: rates.length } }));
    return f;
  };
  const worseA = synth('eight-a', [0, 0, 0.33, 0, 0.33, 0, 0, 0.67]);
  const betterB = synth('eight-b', [1, 1, 1, 0.67, 1, 1, 0.67, 1]);
  const cBetter = bench(`compare "${worseA}" "${betterB}"`);
  const cWorse = bench(`compare "${betterB}" "${worseA}"`);
  const few = bench(`compare "${synth('three-a', [0, 0, 0])}" "${synth('three-b', [1, 1, 1])}"`);
  const fourReal = id3 ? bench(`compare ${id3} ${id3}`) : { status: 1, stdout: 'no run' };
  report('2.62.0 (bench): compare pairs the cases, prints a sign-test p-value and says "better" (8 of 8 cases better, p = 0.0078) or "worse" the other way round; with 3 or 4 cases it says "not enough cases"',
    cBetter.status === 0 && /p = 0\.0078/.test(out(cBetter)) && /verdict: better/.test(out(cBetter)) && /tokens per try/.test(out(cBetter)) && /verdict: worse/.test(out(cWorse))
      && /not enough cases/.test(out(few)) && !/verdict: better/.test(out(few)) && /not enough cases/.test(out(fourReal)),
    [cBetter, cWorse, few, fourReal].map((r) => out(r).slice(-700)).join('\n---\n'));

  // 5. Component removal: --without sets the existing off-switch in the agent's env only; compare says whether it pays.
  const before = git('status --porcelain').stdout;
  const ws = 'w1,w2,w3,w4,w5,w6';
  const base = bench(`run --by hatch --cases ${ws} --k 1 --yes --label baseline`);
  const logBase = standinLog().length;
  const wo = bench(`run --by hatch --cases ${ws} --k 1 --yes --without weakened-tests`);
  const woLog = standinLog().slice(logBase);
  const idB = runIdFrom(base);
  const idW = runIdFrom(wo);
  const cmpW = idB && idW ? bench(`compare ${idB} ${idW}`) : { status: 1, stdout: 'no runs' };
  const bogus = bench('run --by hatch --cases w1 --k 1 --yes --without everything');
  report('2.62.0 (bench): run --without weakened-tests gives the agent STUDIO_WEAKENED_TESTS=off (the baseline doesn\'t), records it, changes no studio file, and compare against the baseline says the component still pays for itself; an unknown component is refused',
    base.status === 0 && wo.status === 0 && standinLog().slice(0, logBase).filter((s) => s.case.startsWith('w')).every((s) => s.weak === null) && woLog.length === 6 && woLog.every((s) => s.weak === 'off')
      && results(idW)?.without === 'weakened-tests' && results(idW)?.withoutEnv?.STUDIO_WEAKENED_TESTS === 'off' && git('status --porcelain').stdout === before
      && /verdict: worse/.test(out(cmpW)) && /component weakened-tests: still pays for itself/.test(out(cmpW)) && bogus.status === 1 && /no component/.test(out(bogus)),
    [base, wo, cmpW, bogus].map((r) => `${r.status}: ${out(r).slice(-600)}`).join('\n---\n'));

  // 6. add --from <task>: a person adds a case from a past task; its start commit and hidden tests come from git.
  fs.mkdirSync(path.join(dir, 'qa', 'made'), { recursive: true });
  const parent = git('rev-parse HEAD').stdout.trim();
  fs.writeFileSync(path.join(dir, 'qa', 'made', 'thing.test.mjs'), 'process.exit(0);\n');
  git('add -A');
  git('commit -q -m "add thing" --no-verify --trailer "Studio-Task: T-050"');
  const addNoBy = bench('add --from T-050 --pass "node qa/made/thing.test.mjs"');
  const added = bench('add --from T-050 --by hatch --id thing --hidden qa/made/thing.test.mjs --pass "node qa/made/thing.test.mjs" --brief-file AGENTS.lite.md');
  let c = null;
  try { c = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'bench', 'cases', 'thing.json'), 'utf8')); } catch {}
  report('2.62.0 (bench): add --from T-050 --by <person> writes a case starting at the task\'s first commit\'s parent, with its hidden test copied from the task\'s commit and the protected-folder note; without --by it is refused',
    addNoBy.status === 1 && added.status === 0 && c?.commit === parent && c?.from?.task === 'T-050' && c?.grader?.pass?.[0] === 'node qa/made/thing.test.mjs'
      && fs.existsSync(path.join(dir, 'studio', 'bench', 'cases', 'thing', 'files', 'qa', 'made', 'thing.test.mjs')) && /protected folder/.test(out(added)),
    `${out(addNoBy).slice(-300)}\n---\n${out(added).slice(-500)}\n${JSON.stringify(c)?.slice(0, 400)}`);

  // 7. The shipped protected list covers the bench.
  const prot = JSON.parse(fs.readFileSync(path.join(dir, 'studio', 'protected.json'), 'utf8')).globs || [];
  const { DEFAULT_PROTECTED } = await import(pathToFileURL(path.join(dir, 'harness', 'approve.mjs')).href);
  report('2.62.0 (bench): studio/bench/** is in the shipped protected list (studio/protected.json) and in approve.mjs\'s defaults',
    prot.includes('studio/bench/**') && DEFAULT_PROTECTED.includes('studio/bench/**'), JSON.stringify(prot));
}

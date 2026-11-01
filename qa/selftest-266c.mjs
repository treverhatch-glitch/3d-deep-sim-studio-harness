/**
 * qa/selftest-266c.mjs — 2.66.0 (helper c): hand-back facts written by the harness, and the blocked-command log.
 *   1. The merge train hands back a made-up lane whose game check fails: the hand-off entry starts with the facts
 *      block (the lane's changed files, every gate with PASS/FAIL, the failure signature from the failing test line,
 *      the seed, the train's verify log), then the train's prose.
 *   2. `task pause` from a lane copy: facts first (committed, uncommitted and untracked files; the holder's own verify
 *      record and its gate log), the agent's prose after; the task.paused event carries the prose only; the next
 *      agent's brief shows the facts before the notes. A refused task done's gates reach the next hand-back.
 *   3. Claude Code's permission_denials, read at session end from the result line(s), land in .studio/denials.jsonl
 *      with secrets redacted; a result line without the field records nothing.
 *   4. `npm run denials` lists the top commands and the count per task; the digest lists the allowlist candidates and
 *      says they are never added automatically; no settings or permission file changes.
 * Made-up studio ("demo"), made-up ids and secrets. Each check fails on 2.65.2.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL, fileURLToPath } from 'node:url';

export async function selftest266C({ dir, run, report, tmpRoot, root }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { cwd, encoding: 'utf8' });
  const write = (base, rel, text) => { fs.mkdirSync(path.dirname(path.join(base, rel)), { recursive: true }); fs.writeFileSync(path.join(base, rel), text); };
  const read = (rel) => { try { return fs.readFileSync(path.join(dir, rel), 'utf8'); } catch { return ''; } };
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const events = path.join(dir, '.studio', 'events-266c.jsonl');
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', GITHUB_BASE_REF: '', STUDIO_GAME: 'demo', STUDIO_REACHABILITY: 'off', STUDIO_DONE_NOOP: 'allow', STUDIO_DONE_REUSE_VERIFY: '', STUDIO_GATE_INCOMING_FILE: '', STUDIO_GATE_PRIORITY: '', STUDIO_GATE_CHANGED: '', STUDIO_GATE_PATHS: '', STUDIO_TRAIN: '', STUDIO_TRAIN_PREDICT: 'off', STUDIO_TRAIN_MIN: '', STUDIO_TRAIN_MAX: '', STUDIO_HOOKS_CHECK: 'on', STUDIO_LANE_LIVE_MIN: '0', STUDIO_COMPACT_OUTPUT: '', STUDIO_HOTSPOT_ASK: '', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_THREADS: '', STUDIO_BUILDER_CMD: '', STUDIO_PRODUCER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_AGENT_TOOL: '', STUDIO_REHEARSAL: '', STUDIO_LANELESS: 'shared', STUDIO_DIGEST: '', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-266c-${process.pid}.pem`), AGENT_EVENTS_FILE: events, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  if (!fs.existsSync(path.join(dir, 'node_modules', 'typescript')) && fs.existsSync(path.join(harnessRoot, 'node_modules', 'typescript'))) {
    try { fs.rmSync(path.join(dir, 'node_modules'), { force: true }); } catch {}
    fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(dir, 'node_modules'), 'junction');
  }
  let n = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p266c-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-1500) }; } catch { return { _out: out(r).slice(-2000) }; }
  };
  /** The newest entry of a task's hand-off file. */
  const newestEntry = (id) => { const t = read(`studio/handoffs/${id}.md`); const i = t.lastIndexOf('\n## '); return i === -1 ? '' : t.slice(i + 1); };
  const HEAD = 'Hand-back facts (written by the harness';
  const PERMISSION_FILES = ['.claude/settings.json', '.claude/settings.local.json', 'harness/allowlist.mjs', 'studio/autonomy.json', 'studio/protected.json'];
  const fingerprint = () => PERMISSION_FILES.map((f) => `${f}:${fs.existsSync(path.join(dir, f)) ? crypto.createHash('sha1').update(fs.readFileSync(path.join(dir, f))).digest('hex') : '-'}`).join('\n');
  const permsBefore = fingerprint();

  // ---- the studio ----
  write(dir, 'studio/gates.json', `${JSON.stringify({ gates: [
    { id: 'protected', command: 'node qa/protected-check.mjs', required: true, lite: true },
    { id: 'secrets', command: 'node scripts/secret-scan.mjs', required: true, lite: true },
    { id: 'hooks', command: 'node harness/hook-stamp.mjs check', required: true, lite: true, cache: false },
    { id: 'game', command: 'node harness/game-gates.mjs', required: true, lite: true, cache: false },
  ] }, null, 2)}\n`);
  write(dir, 'game/demo/studio.gates.json', `${JSON.stringify({ gates: [{ id: 'check', command: 'node game/demo/check.mjs' }] }, null, 2)}\n`);
  write(dir, 'game/demo/check.mjs', "console.log('spawn suite ok');\n");
  write(dir, 'game/demo/notes/reg.md', '# Registry\n\nentries: a\n\nend\n');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  g(dir, 'config', 'core.hooksPath', 'scripts/hooks');

  const addTask = (title) => (out(run(dir, `node harness/task.mjs add "${title}" --role builder --priority P1`, env)).match(/"id": "(T-\d+)"/) || [])[1];
  const laneProbe = path.join(tmpRoot, `lane-266c-${process.pid}.mjs`);
  fs.writeFileSync(laneProbe, `import { createLaneCopy } from ${u('harness/worktree.mjs')};\nconst r = createLaneCopy(process.argv[2], { task: process.argv[3] });\nconsole.log(JSON.stringify(r));\n`);
  const lane = (agent, title, files) => {
    const id = addTask(title);
    const made = run(dir, `node "${laneProbe}" ${agent} ${id}`, env);
    const ld = path.join(dir, '.lanes', agent);
    const as = { ...env, STUDIO_MAIN_ROOT: dir, STUDIO_LOCK_OWNER: agent };
    const st = run(ld, `node harness/task.mjs start ${id} --agent ${agent}`, as);
    for (const [rel, text] of Object.entries(files)) { write(ld, rel, text); g(ld, 'add', rel); }
    const c = spawnSync('git', ['commit', '-qm', `${id}: ${title}`], { cwd: ld, encoding: 'utf8', env: { ...process.env, ...as } });
    return { id, agent, dir: ld, as, ok: fs.existsSync(ld) && st.status === 0 && c.status === 0, log: `${out(made)}\n${out(st)}\n${out(c)}`.slice(-1500) };
  };

  // ---- 1. the merge train's hand-back ----
  const t = lane('tr-266c', 'Spawn crates by id', {
    'game/demo/check.mjs': "console.log('spawn suite (seed=4242)');\nconsole.log('  ok 1 boots');\nconsole.log('FAIL spawn: two crates share id 7 (seed=4242) (12 ms)');\nconsole.log('Tests: 1 failed, 1 passed');\nprocess.exit(1);\n",
    'game/demo/notes/crates.md': '# Crates\n',
  });
  const q = run(t.dir, `node harness/task.mjs done ${t.id} --agent ${t.agent} --train`, t.as);
  const tr = run(dir, 'node harness/task.mjs train --by tester', env);
  const e1 = newestEntry(t.id);
  const f1 = e1.indexOf(HEAD);
  const p1 = e1.indexOf('Not landed by merge train');
  report('2.66.0 (c, 1): the merge train hands back a made-up lane whose game check fails with a facts block BEFORE the train\'s prose: the lane\'s changed files (game/demo/check.mjs, game/demo/notes/crates.md), the gates of the verify log the note names, with PASS/FAIL (FAIL game), the failure signature from the failing test line ("FAIL spawn: two crates share id 7", no duration), the seed (4242) and that log\'s path (fails on 2.65.2: prose only)',
    t.ok && q.status === 0 && f1 !== -1 && p1 > f1
      && /Changed files since [0-9a-f]{8} \(2\): game\/demo\/check\.mjs, game\/demo\/notes\/crates\.md/.test(e1)
      && /Gates run \(the merge train's verify[^)]*\):[^\n]*FAIL game/.test(e1)
      && /Failure signature: game: [^\n]*FAIL spawn: two crates share id 7 \(seed=4242\) \[sig [0-9a-f]{8}\]/.test(e1) && !/12 ms/.test(e1.slice(f1, p1))
      && /Failing seed: 4242/.test(e1) && /Last verify log: \.studio\/train\/\S+-(verify|recheck)-\d+\.log/.test(e1) && e1.slice(f1, p1).includes(`Last verify log: ${(e1.slice(p1).match(/\b(?:Full log|Log): (\S+?)\.?\s/) || [])[1] || '(none named)'}`),
    `${t.log}\n--- queue:\n${out(q).slice(-800)}\n--- train:\n${out(tr).slice(-1500)}\n--- entry:\n${e1.slice(0, 2500)}`);

  // ---- 2. task pause, from a lane copy ----
  const p = lane('pa-266c', 'Crate ids stay unique', { 'game/demo/src/ids.js': 'export const next = 1;\n' });
  write(p.dir, 'game/demo/src/ids.js', 'export const next = 2;\n'); // uncommitted
  write(p.dir, 'game/demo/src/new-pool.js', 'export const pool = [];\n'); // untracked
  const at = new Date(Date.now() + 1000).toISOString();
  write(dir, `.studio/gates/${p.agent}.json`, `${JSON.stringify({ at, head: 'x', partial: false, rows: [{ id: 'protected', ok: true, required: true }, { id: 'game', ok: false, required: true }, { id: 'docs', ok: false, required: false }] }, null, 2)}\n`);
  write(dir, '.studio/gates/out/game.log', 'running crate suite --seed 99\n  ok 1 spawn\n  not ok 2 crate ids stay unique: expected 3 got 2 (8 ms)\n');
  const ps = run(p.dir, `node harness/task.mjs pause ${p.id} --agent ${p.agent} --note "Done: pool started. Next: reuse freed ids. Files: ids.js"`, p.as);
  const e2 = newestEntry(p.id);
  const f2 = e2.indexOf(HEAD);
  const p2 = e2.indexOf('Done: pool started');
  const pev = evs().filter((e) => e.type === 'task.paused' && e.task === p.id).pop();
  const focus = run(dir, `node harness/focus.mjs ${p.id} --agent next-266c`, env);
  const fo = out(focus);
  report('2.66.0 (c, 2): task pause from a lane copy writes the facts first: a committed file changed again uncommitted and an untracked file since the task\'s start (2), the holder\'s own verify (PASS protected, FAIL game; an optional gate isn\'t a failure), the signature from that gate\'s log ("game: not ok 2 crate ids stay unique: expected 3 got 2"), the seed (99), the log path; then the agent\'s prose; the task.paused event carries the prose only (fails on 2.65.2: no facts)',
    p.ok && ps.status === 0 && f2 !== -1 && p2 > f2
      && /Changed files since [0-9a-f]{8} \(2\): game\/demo\/src\/ids\.js, game\/demo\/src\/new-pool\.js/.test(e2)
      && new RegExp(`Gates run \\(${p.agent}'s verify[^)]*\\): PASS protected, FAIL game, PASS docs`).test(e2)
      && /Failure signature: game: not ok 2 crate ids stay unique: expected 3 got 2 \[sig/.test(e2) && /Failing seed: 99/.test(e2) && /Last verify log: \.studio\/gates\/out\/game\.log/.test(e2)
      && pev && !String(pev.msg).includes(HEAD) && /Done: pool started/.test(pev.msg),
    `${p.log}\n--- pause:\n${out(ps).slice(-800)}\n--- entry:\n${e2.slice(0, 2500)}\n--- event: ${JSON.stringify(pev)}`);
  report('2.66.0 (c, 2): the next agent\'s brief (.studio/briefs/<ID>.md) shows the newest facts block first, before the hand-back notes, inside the marked block, and the notes don\'t repeat it (fails on 2.65.2: notes only)',
    focus.status === 0 && fo.indexOf('Hand-back facts from the newest hand-back') !== -1 && fo.indexOf('| - Failure signature: game: not ok 2') !== -1
      && fo.indexOf('| - Failure signature: game: not ok 2') < fo.indexOf('Done: pool started') && fo.split('Failure signature').length === 2
      && fo.indexOf('----- BEGIN: written by agents or people -----') < fo.indexOf('Hand-back facts from the newest hand-back'),
    fo.slice(0, 3000));

  // A refused task done's gates (recorded at the refusal) are what the next hand-back says ran.
  const rf = probe(`import { recordGateRefusal, buildFacts, renderFacts } from ${u('harness/handback-facts.mjs')};
recordGateRefusal(${JSON.stringify(p.id)}, { gates: [{ id: 'game:check', ok: false }, { id: 'game:lint', ok: true }], text: 'FAIL crate ids stay unique after reload\\nexit 1: seed=31337' });
console.log(JSON.stringify({ text: renderFacts(buildFacts(${JSON.stringify(p.id)}, { agent: 'nobody-266c' })) }));`);
  report('2.66.0 (c, 2): a gate-refused task done is recorded (.studio/handback-facts/<ID>.json) and the next hand-back\'s facts name it: FAIL game:check, PASS game:lint, its failing test line, its seed (fails on 2.65.2: no such record)',
    /Gates run \(the refused task done[^)]*\): FAIL game:check, PASS game:lint/.test(rf.text || '') && /Failure signature: game:check: FAIL crate ids stay unique after reload/.test(rf.text || '') && /Failing seed: 31337/.test(rf.text || ''),
    JSON.stringify(rf).slice(0, 2000));

  // ---- 3. the blocked-command log ----
  const fake = path.join(tmpRoot, `fake-claude-266c-${process.pid}.mjs`);
  const tokenish = `sk-ant-${'aB3x'.repeat(8)}`;
  const ghp = `ghp_${'Zq9w'.repeat(9)}`;
  fs.writeFileSync(fake, `const withField = process.argv[2] === 'denials';
const d = (id, tool_name, tool_input) => ({ tool_name, tool_use_id: id, tool_input });
const first = [d('tu_1', 'Bash', { command: 'curl -H "Authorization: Bearer ${tokenish}" https://api.example.invalid/v1' }), d('tu_2', 'Bash', { command: 'GITHUB_TOKEN=${ghp} gh pr list' }), d('tu_3', 'Read', { file_path: '/home/someone/repo/studio/roles/builder.md' })];
const second = [d('tu_1', 'Bash', { command: 'curl -H "Authorization: Bearer ${tokenish}" https://api.example.invalid/v1' }), d('tu_4', 'Bash', { command: 'mysql -u app -p hunter2pass -e "select 1"' })];
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', num_turns: 2, usage: { input_tokens: 5, output_tokens: 10 }, ...(withField ? { permission_denials: first } : {}) }));
console.log(JSON.stringify({ type: 'result', subtype: 'success', result: 'ok', num_turns: 3, usage: { input_tokens: 5, output_tokens: 10 }, ...(withField ? { permission_denials: second } : {}) }));
`);
  const denialsFile = path.join(dir, '.studio', 'denials.jsonl');
  const s1 = run(dir, 'node harness/agent.mjs start --role builder --agent bu-266c --tool claude --model m-1', { ...env, STUDIO_BUILDER_CMD: `node "${fake}" denials` });
  const rows1 = (() => { try { return fs.readFileSync(denialsFile, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const raw1 = (() => { try { return fs.readFileSync(denialsFile, 'utf8'); } catch { return ''; } })();
  const s2 = run(dir, 'node harness/agent.mjs start --role builder --agent bu2-266c --tool claude --model m-1', { ...env, STUDIO_BUILDER_CMD: `node "${fake}" none` });
  const raw2 = (() => { try { return fs.readFileSync(denialsFile, 'utf8'); } catch { return ''; } })();
  report('2.66.0 (c, 3): at session end the launcher harvests permission_denials from every result line (4 unique by tool_use_id) into .studio/denials.jsonl with agent, role, tool, key and why; keys, tokens and passwords are redacted (no sk-ant-, ghp_ or hunter2pass on disk); a session whose result lines lack the field records nothing (fails on 2.65.2: nothing harvested)',
    s1.status === 0 && s2.status === 0 && rows1.length === 4 && rows1.every((r) => r.agent === 'bu-266c' && r.role === 'builder' && r.tool && r.key && r.why && r.command.length <= 200)
      && !raw1.includes(tokenish) && !raw1.includes(ghp) && !raw1.includes('hunter2pass') && rows1.some((r) => /Bearer \[removed\]/.test(r.command)) && rows1.some((r) => /GITHUB_TOKEN=\[removed\] gh pr list/.test(r.command))
      && rows1.some((r) => r.key === 'Bash(curl *)' && r.why === 'not on the list') && rows1.some((r) => r.key === 'Read(studio/roles/**)') && raw2 === raw1,
    `${out(s1).slice(-600)}\n${raw1.slice(0, 2000)}\n--- after the second: ${raw2.length} vs ${raw1.length}`);

  // ---- 4. npm run denials, the digest, and no permission file touched ----
  const rec = probe(`import { recordDenials } from ${u('harness/denials.mjs')};
const line = (ds) => JSON.stringify({ type: 'result', permission_denials: ds.map(([id, tool_name, command]) => ({ tool_name, tool_use_id: id, tool_input: { command } })) });
const a = recordDenials({ log: line([['a1', 'Bash', 'curl https://x.example.invalid'], ['a2', 'Bash', 'curl https://y.example.invalid'], ['a3', 'Bash', 'cat a.md; cat b.md']]), task: 'T-901', agent: 'b1', role: 'builder' });
const b = recordDenials({ log: line([['b1', 'Bash', 'docker compose up'], ['b2', 'Bash', 'curl https://z.example.invalid']]), task: 'T-902', agent: 'b2', role: 'builder' });
console.log(JSON.stringify({ a, b }));`);
  const sum = run(dir, 'npm run denials --silent', env);
  const so = out(sum);
  const dg = run(dir, 'npm run digest --silent -- --print', env);
  const dgo = out(dg);
  report('2.66.0 (c, 4): npm run denials lists the top blocked commands by count (Bash(curl *) first, 4) and the count per task (T-901 3, T-902 2), separates a chained command from the candidates, and says nothing is added automatically (fails on 2.65.2: no such command)',
    rec.a === 3 && rec.b === 2 && sum.status === 0 && /Top commands:\n\s+4\s+Bash\(curl \*\)/.test(so) && /\b3\s+T-901\b/.test(so) && /\b2\s+T-902\b/.test(so)
      && /Bash\(cat \*\)\s+\(chained/.test(so) && /Allowlist candidates: Bash\(curl \*\) \(4\)/.test(so) && !/Allowlist candidates:[^\n]*Bash\(cat/.test(so) && /added to a settings or permission file automatically/.test(so),
    `${JSON.stringify(rec)}\n${so.slice(-2000)}`);
  report('2.66.0 (c, 4): the daily digest lists the top allowlist candidates (Bash(curl *) 4, Bash(docker compose *) 1) and says they are never added to any settings or permission file automatically; .claude/settings.json, harness/allowlist.mjs and the studio config are byte-for-byte unchanged after the harvest, the summary and the digest (fails on 2.65.2: no candidates in the digest)',
    dg.status === 0 && /Allowlist candidates \(blocked commands, 7 days; suggestions only, never added to any settings or permission file automatically\): `Bash\(curl \*\)` 4, `Bash\(docker compose \*\)` 1/.test(dgo) && fingerprint() === permsBefore,
    `${dgo.slice(-1500)}\n--- permission files:\n${permsBefore}\n---\n${fingerprint()}`);
}

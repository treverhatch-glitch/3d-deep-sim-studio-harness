/**
 * qa/selftest-261e.mjs — 2.61.0, the learning edge (helper e): change records, the lesson → check ladder, and
 * load/follow telemetry. A made-up studio with synthetic events; no model, no network.
 *   1. A change record graded "regressed" files exactly one revert question for the owner (and nothing is reverted);
 *      "kept" and "no effect" file none; a second pass doesn't grade or ask again.
 *   2. Too few finished tasks on a side: "not enough data", the record keeps watching, no question.
 *   3. A failure signature that repeats after its lesson (matched by the signature id, no shared keywords) files one
 *      "Make the lesson a check" task, not two, and the upgrade notes carry the change verdicts.
 *   4. Skill follow rates per model from synthetic session logs (loaded / followed / unknown), and the session-end hook.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest261E({ dir, run, report }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT_MODEL: '', AGENT_EVENTS_FILE: '', AGENT_EVENTS_MIRROR: '', STUDIO_CHANGE_EVAL_TASKS: '10', STUDIO_CHANGE_EVAL_DAYS: '7', STUDIO_CHANGE_MIN_SAMPLE: '5', STUDIO_CHANGE_MARGIN: '0.1', STUDIO_AUTO_TRICKS: '0' };
  const probe = (name, code, e = {}) => {
    const f = path.join(dir, `.probe-261e-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, { ...env, ...e });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const state = path.join(dir, '.studio');
  fs.mkdirSync(state, { recursive: true });
  const evLine = (e) => JSON.stringify({ id: `evt_${Math.random().toString(36).slice(2)}`, agent: 'builder-1', model: null, status: 'ok', meta: {}, ...e });
  const writeEvents = (file, list) => fs.writeFileSync(path.join(state, file), `${list.map(evLine).join('\n')}\n`);
  const asks = () => (fs.existsSync(path.join(dir, 'studio/asks')) ? fs.readdirSync(path.join(dir, 'studio/asks')).filter((f) => /^A-\d+\.json$/.test(f)) : []);
  const rec = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/changes', `${id}.json`), 'utf8')); } catch { return null; } };
  const clearChanges = () => { for (const f of fs.existsSync(path.join(dir, 'studio/changes')) ? fs.readdirSync(path.join(dir, 'studio/changes')) : []) fs.rmSync(path.join(dir, 'studio/changes', f)); };
  const day = 86400000;
  const now = Date.now();
  const iso = (ms) => new Date(ms).toISOString();

  // Synthetic task histories: n finished "change" tasks around a moment; `hits` of them hit the failure message first.
  let tid = 500;
  const tasks = (fromMs, n, hits, msg, stepMs = 3600000) => {
    const list = [];
    for (let i = 0; i < n; i++) {
      const id = `T-${++tid}`;
      const t = fromMs + i * stepMs;
      list.push({ type: 'task.added', task: id, ts: iso(t - 1000), msg: `Queued ${id}`, meta: { type: 'change' } });
      if (i < hits) list.push({ type: 'task.not_done', task: id, ts: iso(t - 500), msg: `${id} not done yet: ${msg}` });
      list.push({ type: 'task.done', task: id, ts: iso(t), msg: `Done ${id}` });
    }
    return list;
  };
  const MSG_A = 'the size ratchet refused growth in the panel module';
  const MSG_B = 'no verify recorded after the last change';
  const MSG_C = 'uncommitted files in the game folders block the landing';
  const learnEnv = (file) => ({ AGENT_EVENTS_FILE: `.studio/${file}` });

  // 2. Too few tasks: a record 8 days old (due by days) with 3 finished tasks on each side.
  clearChanges();
  const atD = now - 8 * day;
  writeEvents('ev-261e-thin.jsonl', [...tasks(atD - 2 * day, 3, 1, MSG_A), ...tasks(atD + day, 3, 2, MSG_A)]);
  const addD = run(dir, `node harness/learn.mjs change add --kind skill --target studio/skills/builder.md --signature "task.not_done: T-1 not done yet: ${MSG_A}" --expect "fewer size refusals on change tasks" --risk "longer skill" --revert "git revert --no-edit HEAD" --json`, { ...env, ...learnEnv('ev-261e-thin.jsonl') });
  const idD = (() => { try { return JSON.parse(addD.stdout).id; } catch { return null; } })();
  if (idD) { const r = rec(idD); r.at = iso(atD); fs.writeFileSync(path.join(dir, 'studio/changes', `${idD}.json`), JSON.stringify(r)); }
  const evD = run(dir, 'node harness/learn.mjs change eval --json', { ...env, ...learnEnv('ev-261e-thin.jsonl') });
  const rD = rec(idD) || {};
  report('2.61e: a change record with fewer than STUDIO_CHANGE_MIN_SAMPLE finished tasks on a side says "not enough data", keeps watching and asks nothing',
    addD.status === 0 && Boolean(idD) && /not enough data/.test(out(evD)) && rD.status === 'watching' && rD.lastEval?.verdict === 'not enough data' && !rD.verdict && asks().length === 0,
    `${out(addD).slice(-400)}\n${out(evD).slice(-400)}\n${JSON.stringify(rD).slice(0, 600)}\nasks=${asks().length}`);

  // 1. Regressed / kept / no effect: three records made 3 days ago, 10 tasks before and 10 after each.
  clearChanges();
  const at = now - 3 * day;
  const evs = [
    ...tasks(at - 2 * day, 10, 1, MSG_A, 3600000), ...tasks(at + 3600000, 10, 6, MSG_A, 3600000),
  ];
  // B and C ride on the same tasks: every task before/after also carries their failure as needed.
  const before = evs.filter((e) => e.type === 'task.done' && Date.parse(e.ts) < at).map((e) => e.task);
  const after = evs.filter((e) => e.type === 'task.done' && Date.parse(e.ts) >= at).map((e) => e.task);
  const hit = (ids, msg, sideAt) => ids.map((id, i) => ({ type: 'task.not_done', task: id, ts: iso(sideAt + i * 1000), msg: `${id} not done yet: ${msg}` }));
  evs.push(...hit(before.slice(0, 6), MSG_B, at - 3 * day), ...hit(after.slice(0, 1), MSG_B, at + 60000));
  evs.push(...hit(before.slice(0, 2), MSG_C, at - 3 * day), ...hit(after.slice(0, 2), MSG_C, at + 60000));
  writeEvents('ev-261e-grade.jsonl', evs);
  const made = probe('grade-add', `import { addChange } from ${u('harness/changes.mjs')};
const at = ${JSON.stringify(iso(at))};
const a = addChange({ kind: 'harness', target: 'harness/size-rule', signatures: ['task.not_done: T-9 not done yet: ${MSG_A}'], expect: 'fewer size refusals', risk: 'misses real growth', revert: 'git revert --no-edit abc1234', at });
const b = addChange({ kind: 'skill', target: 'studio/skills/builder.md', signatures: ['task.not_done: T-9 not done yet: ${MSG_B}'], expect: 'verify after the last change', risk: 'none known', revert: 'git revert --no-edit def5678', at });
const c = addChange({ kind: 'pitfall', target: 'studio/PITFALLS.md line 3', signatures: ['${MSG_C}'], expect: 'fewer strays', risk: 'noise', revert: 'npm run pitfall -- remove 3', at });
console.log(JSON.stringify({ a: a.change?.id, b: b.change?.id, c: c.change?.id }));`, learnEnv('ev-261e-grade.jsonl'));
  const asks0 = asks().length;
  const g1 = run(dir, 'node harness/learn.mjs change eval --json', { ...env, ...learnEnv('ev-261e-grade.jsonl') });
  const g2 = run(dir, 'node harness/learn.mjs change eval --json', { ...env, ...learnEnv('ev-261e-grade.jsonl') });
  const A = rec(made.a) || {};
  const B = rec(made.b) || {};
  const C = rec(made.c) || {};
  const askFiles = asks();
  const theAsk = askFiles.length ? JSON.parse(fs.readFileSync(path.join(dir, 'studio/asks', askFiles[0]), 'utf8')) : {};
  report('2.61e: graded after N tasks: the change whose signature rose is "regressed" and files exactly one revert question (status open, no deadline, the revert command in it); "kept" and "no effect" file none; a second pass asks nothing more',
    A.status === 'regressed' && B.status === 'kept' && C.status === 'no effect' && askFiles.length - asks0 === 1 && A.proposal === theAsk.id && theAsk.status === 'open' && !theAsk.deadline && /git revert --no-edit abc1234/.test(theAsk.question) && !B.proposal && !C.proposal && /\[\]/.test(String(g2.stdout).trim()),
    `${JSON.stringify(made)}\n${out(g1).slice(-600)}\n${out(g2).slice(-300)}\nA=${JSON.stringify(A).slice(0, 500)}\nB=${B.status} C=${C.status} asks=${askFiles.join(',')}`);

  // 3. Lesson → check ladder: a lesson dated 2026-10-20 that names the failure's signature id and shares no keywords.
  const LMSG = 'T-77 not done yet: zebra quilting overflowed beyond seven lanterns';
  const sig = probe('sig', `import { signatureId, signature } from ${u('harness/changes.mjs')};
console.log(JSON.stringify({ id: signatureId('task.not_done: ' + signature(${JSON.stringify(LMSG)})) }));`);
  const failures = path.join(dir, 'studio/memory/failures.md');
  const fText = fs.existsSync(failures) ? fs.readFileSync(failures, 'utf8') : '# failures\n\n## Recorded Distilled Notes\n';
  fs.writeFileSync(failures, `${fText.trimEnd()}\n\n### [2026-10-20] BUG-LAD-1 — Hand-back rule\n- **What broke**: ${sig.id}\n- **How to avoid it next time**: hand it back early.\n`);
  writeEvents('ev-261e-ladder.jsonl', ['2026-10-19T10:00:00.000Z', '2026-10-25T10:00:00.000Z', '2026-10-26T10:00:00.000Z'].map((ts, i) => ({ type: 'task.not_done', task: `T-${77 + i}`, ts, msg: LMSG.replace('T-77', `T-${77 + i}`) })));
  const l1 = run(dir, 'node harness/learn.mjs', { ...env, ...learnEnv('ev-261e-ladder.jsonl') });
  const l2 = run(dir, 'node harness/learn.mjs', { ...env, ...learnEnv('ev-261e-ladder.jsonl') });
  const board = probe('board', `import { parseNextQueue } from ${u('harness/task.mjs')};
const q = parseNextQueue();
console.log(JSON.stringify({ titles: [...q.inProgress, ...q.backlog, ...q.done].map((t) => t.title + ' |' + t.role) }));`, learnEnv('ev-261e-ladder.jsonl'));
  const ladderTasks = (board.titles || []).filter((t) => /^Make the lesson a check: task\.not_done: /.test(t));
  const ledger = (() => { try { return JSON.parse(fs.readFileSync(path.join(dir, 'studio/changes/ladder.json'), 'utf8')); } catch { return {}; } })();
  const learned = fs.existsSync(path.join(dir, 'studio/memory/LEARNED.md')) ? fs.readFileSync(path.join(dir, 'studio/memory/LEARNED.md'), 'utf8') : '';
  report('2.61e: a failure that repeats after its lesson (matched by the signature id, no shared keywords) files one builder task "Make the lesson a check: <signature>", not two, recorded in studio/changes/ladder.json',
    l1.status === 0 && l2.status === 0 && ladderTasks.length === 1 && /\|builder$/.test(ladderTasks[0]) && ledger[sig.id]?.task && /matched by signature id/.test(learned),
    `${out(l1).slice(-500)}\n${JSON.stringify(board).slice(0, 800)}\n${JSON.stringify(ledger)}\n${learned.slice(0, 800)}`);
  const exp = run(dir, 'node harness/notes.mjs export', env);
  report('2.61e: the harness upgrade notes (npm run notes -- export) carry the change records\' verdicts',
    /### Change records/.test(out(exp)) && /regressed/.test(out(exp)) && /kept/.test(out(exp)) && /no effect/.test(out(exp)), out(exp).slice(-800));

  // 4. Follow telemetry: two models, synthetic kickoffs and logs, one skill with an evidence list and one without.
  fs.mkdirSync(path.join(dir, 'studio/skills'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'studio/skills/zz-proof.md'), '---\nevidence:\n  - fails-before | check-regressions\n  - /npm run verify\\b/\n---\n# Skill: zz-proof\n\n**Steps.**\n1. Prove it.\n');
  fs.writeFileSync(path.join(dir, 'studio/skills/zz-plain.md'), '# Skill: zz-plain\n\n**Steps.**\n1. Do it.\n');
  const pits = path.join(dir, 'studio/PITFALLS.md');
  fs.writeFileSync(pits, '# Pitfalls\n\n- never put the ceiling texture on floors (x, 2026-10-01)\n');
  writeEvents('ev-261e-follow.jsonl', []);
  fs.mkdirSync(path.join(state, 'kickoff'), { recursive: true });
  const kick = (agent, skills) => fs.writeFileSync(path.join(state, 'kickoff', `${agent}.md`), `You are a builder agent working in this made-up studio today.\nRead ${skills.map((s) => `\`studio/skills/${s}.md\``).join(' and ')}.\n- never put the ceiling texture on floors (x, 2026-10-01)\n`);
  kick('fa-1', ['zz-proof']); kick('fa-2', ['zz-proof']); kick('fb-1', ['zz-plain']);
  const fol = probe('follow', `import fs from 'node:fs';
import { recordFollow, followRates } from ${u('harness/scorecard.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
const k2 = fs.readFileSync('.studio/kickoff/fa-2.md', 'utf8');
recordFollow({ agent: 'fa-1', model: 'model-a', log: 'tool: Read studio/skills/zz-proof.md\\nran node qa/fails-before.mjs\\nnpm run verify passed' });
recordFollow({ agent: 'fa-2', model: 'model-a', log: k2 + '\\nedited a file and stopped' });
recordFollow({ agent: 'fb-1', model: 'model-b', log: 'cat studio/skills/zz-plain.md' });
const rows = followRates(readRecentEvents(0));
console.log(JSON.stringify({ rows }));`, learnEnv('ev-261e-follow.jsonl'));
  const sc = (() => { try { return JSON.parse(run(dir, 'node harness/scorecard.mjs --json', { ...env, ...learnEnv('ev-261e-follow.jsonl') }).stdout); } catch { return {}; } })();
  const ma = (sc.follow || []).find((r) => r.model === 'model-a') || {};
  const mb = (sc.follow || []).find((r) => r.model === 'model-b') || {};
  report('2.61e: the scorecard aggregates skill telemetry per model from session logs: loaded (an echoed prompt is not a read), followed (every evidence step in the log), unknown (no evidence list), pitfall lines given',
    ma.sessions === 2 && ma.given === 2 && ma.loadedRate === 0.5 && ma.followedRate === 0.5 && ma.unknownRate === 0 && ma.pitfallsPerSession === 1 && mb.given === 1 && mb.loadedRate === 1 && mb.unknownRate === 1 && mb.followedRate === null,
    `${JSON.stringify(fol).slice(0, 800)}\n${JSON.stringify(sc.follow)}`);

  // The session-end hook: harness/agent.mjs cleanUp records it for a launched session.
  kick('fc-1', ['zz-proof']);
  const hook = probe('hook', `import fs from 'node:fs';
import { cleanUp, AGENTS_DIR } from ${u('harness/agent.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
fs.mkdirSync(AGENTS_DIR, { recursive: true });
fs.writeFileSync(AGENTS_DIR + '/fc-1.json', JSON.stringify({ agent: 'fc-1', role: 'builder', tool: 'claude', model: 'model-c', status: 'running', startedAt: new Date().toISOString() }));
cleanUp('fc-1', { code: 0, log: 'Read studio/skills/zz-proof.md then check-regressions and npm run verify', role: 'builder', tool: 'claude', model: 'model-c' });
const e = readRecentEvents(0).filter((x) => x.type === 'skill.follow' && x.agent === 'fc-1').pop();
console.log(JSON.stringify({ e: e ? { model: e.model, skills: e.meta.skills } : null }));`, learnEnv('ev-261e-follow.jsonl'));
  report('2.61e: a launched session\'s end (agent.mjs cleanUp) writes one skill.follow event with what it was given and followed',
    hook.e?.model === 'model-c' && hook.e.skills?.[0]?.skill === 'studio/skills/zz-proof.md' && hook.e.skills[0].loaded === true && hook.e.skills[0].followed === true,
    JSON.stringify(hook).slice(0, 1200));

  for (const f of fs.readdirSync(dir).filter((n) => n.startsWith('.probe-261e-'))) fs.rmSync(path.join(dir, f), { force: true });
}

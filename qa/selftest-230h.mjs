/**
 * qa/selftest-230h.mjs — the 2.30h checks, run by qa/selftest.mjs on a copy of the repo.
 * Design fidelity, the Director's flow, reasoning-only replies, model limits as awareness, the CI watch,
 * the GDScript parse check and the lock version.
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { pathToFileURL } from 'node:url';

export async function selftest230h({ dir, run, report, tmpRoot }) {
  let n = 0;
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p230h-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try {
      return JSON.parse(r.stdout.trim().split('\n').pop());
    } catch {
      return { error: r.stdout + r.stderr };
    }
  };
  const write = (rel, text, mode) => {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), text, mode ? { mode } : undefined);
  };
  const win = process.platform === 'win32';
  // A program the harness can start on every platform: a .cmd wrapper on Windows, a node shebang elsewhere.
  const program = (name, js) => {
    write(`${name}.mjs`, js);
    if (win) {
      write(`${name}.cmd`, `@node "%~dp0${name}.mjs" %*\r\n`);
      return path.join(dir, `${name}.cmd`);
    }
    write(name, `#!/usr/bin/env node\nimport(${JSON.stringify(pathToFileURL(path.join(dir, `${name}.mjs`)).href)});\n`, 0o755);
    return path.join(dir, name);
  };

  // 1. Design fidelity.
  {
    const none = run(dir, 'node harness/fidelity.mjs');
    report('2.30h: the fidelity gate passes with a note when the game has no checklist', none.status === 0 && /no checklist/.test(none.stdout), `${none.stdout}${none.stderr}`);
    write('studio/fidelity.json', JSON.stringify({ reference: 'Youda Marina', mechanics: [
      { id: 'lose-money', says: 'the player can lose money', required: true },
      { id: 'varied-paths', says: 'ships take varied paths to their docks' },
      { id: 'night-shift', says: 'a night shift with fewer ships', required: false },
    ] }));
    write('qa/fidelity/lose-money.mjs', "export default async ({ cartridge, runScenario }) => {\n  const r = runScenario(cartridge, 'start-to-win', { seed: 1 });\n  return { ok: false, why: `money never went down in ${r.ticksRun} ticks` };\n};\n");
    write('qa/fidelity/varied-paths.mjs', 'export default async () => ({ ok: true, why: "3 distinct paths over 20 ships" });\n');
    const f1 = run(dir, 'node harness/fidelity.mjs');
    const out = `${f1.stdout}${f1.stderr}`;
    const fs1 = run(dir, 'node harness/fidelity.mjs --strict');
    report('2.30h: the fidelity report scores mechanics one by one and names a missing required one with the probe\'s reason; a report (exit 0), failing only with --strict', f1.status === 0 && fs1.status === 1 && /REPORT \(required missing\)/.test(out) && /1\/2 mechanics of Youda Marina/.test(out) && /MISSING lose-money/.test(out) && /money never went down in \d+ ticks/.test(out) && /unscored night-shift/.test(out), out);
    const sb = run(dir, 'node harness/fidelity.mjs send-back --by director');
    const sb2 = run(dir, 'node harness/fidelity.mjs send-back --by director');
    const next = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
    report('2.30h: send-back queues one builder task per missing or unprobed mechanic, once', (next.match(/\[fidelity:lose-money\]/g) || []).length === 1 && (next.match(/\[fidelity:night-shift\]/g) || []).length === 1 && !/\[fidelity:varied-paths\]/.test(next) && /nothing to send back/.test(sb2.stdout), `${sb.stdout}${sb.stderr}\n${sb2.stdout}`);
    write('studio/fidelity.json', JSON.stringify({ reference: 'Youda Marina', mechanics: [{ id: 'boats', says: 'copy the boat sprites and models from the original' }] }));
    const f2 = run(dir, 'node harness/fidelity.mjs');
    report('2.30h: a checklist entry that asks to copy the reference\'s code or art is refused (mechanics only)', f2.status === 1 && /mechanics only, never the reference's code or art/.test(`${f2.stdout}${f2.stderr}`), `${f2.stdout}${f2.stderr}`);
    fs.rmSync(path.join(dir, 'studio', 'fidelity.json'));
    // The Bible's fidelity section is the source when it has one.
    const bf = path.join(dir, 'studio', 'bible', 'bible.json');
    const had = fs.existsSync(bf) ? fs.readFileSync(bf, 'utf8') : null;
    write('studio/bible/bible.json', JSON.stringify({ ...(had ? JSON.parse(had) : {}), fidelity: { reference: 'Youda Marina', mechanics: [{ id: 'varied-paths', says: 'ships take varied paths' }] } }));
    const fb = run(dir, 'node harness/fidelity.mjs');
    report('2.30h: the fidelity report reads its mechanics list from the Game Bible', fb.status === 0 && /1\/1 mechanics of Youda Marina/.test(fb.stdout), `${fb.stdout}${fb.stderr}`);
    if (had) fs.writeFileSync(bf, had);
    else fs.rmSync(bf);
    fs.rmSync(path.join(dir, '.studio', 'fidelity-last.json'), { force: true });
  }

  // 2. The Director's flow.
  {
    const fr = probe(`import { flowReport } from ${u('harness/director-flow.mjs')};
const queue = { inProgress: [{ id: 'T-1', role: 'builder', title: 'Docks' }, { id: 'T-2', role: 'builder', title: 'Waves' }], backlog: [{ id: 'T-3', role: 'builder', title: 'Ships' }, { id: 'T-4', role: 'builder', title: 'HUD' }, { id: 'T-5', role: 'planner', title: 'Split' }, { id: 'T-6', role: 'builder', title: 'Held' }] };
const sessions = [{ agent: 'b-1', role: 'builder', running: true, task: 'T-2' }];
const locks = [{ key: 'task:T-2', owner: 'b-1' }];
const mode = { maxAgents: 4, perRole: { builder: 3 } };
const now = Date.parse('2026-10-23T10:00:00Z');
const a = flowReport({ queue, sessions, locks, held: (id) => id === 'T-6' ? 'after T-3' : null, mode, now });
const b = flowReport({ queue, sessions, locks, held: (id) => id === 'T-6' ? 'after T-3' : null, mode, now: now + 11 * 60000, prev: a });
const full = flowReport({ queue, sessions: [1,2,3,4].map((i) => ({ agent: 'b' + i, role: 'builder', running: true, task: 'T-' + i })), locks: [1,2,3,4].map((i) => ({ key: 'task:T-' + i, owner: 'b' + i })), mode, now });
console.log(JSON.stringify({ a, b, full }));`);
    report('2.30h: the flow sees idle builder slots against ready work on the whole board, the expired claim, and holds', fr.a?.expired?.join() === 'T-1' && fr.a.builders.idle === 1 && fr.a.ready.total === 3 && fr.a.ready.byRole.planner === 1 && fr.a.ready.held === 1 && fr.a.state === 'refilling', JSON.stringify(fr).slice(0, 700));
    report('2.30h: idle past STUDIO_FLOW_IDLE_MIN turns the flow "starved"; a full studio reads "full", not starved', fr.b?.state === 'starved' && fr.b.idleFor === 11 && fr.full?.state === 'full' && fr.full.starved === false, JSON.stringify({ b: fr.b?.state, idle: fr.b?.idleFor, full: fr.full?.state }));
    // Live pass on the copy: an in-progress task nobody holds goes back; the card file is written.
    const q = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
    const id = (q.match(/\*\*(T-\d+)\*\* \[P\d\] \(`builder`\)/) || [])[1];
    run(dir, `node harness/task.mjs start ${id} --agent builder-x`);
    run(dir, `node harness/lock.mjs release task:${id} --owner builder-x`);
    const fp = run(dir, 'node harness/director.mjs flow --json --no-fill');
    let flow = null;
    try {
      flow = JSON.parse(fp.stdout);
    } catch {}
    const after = fs.readFileSync(path.join(dir, 'studio', 'NEXT.md'), 'utf8');
    const inProg = (after.split(/##\s+BACKLOG/i)[0] || '');
    report('2.30h: the Director\'s flow pass hands back a claim that ran out and writes the War Room card', Boolean(flow) && flow.actions.some((x) => x.includes(`handed back ${id}`)) && !inProg.includes(`**${id}**`) && fs.existsSync(path.join(dir, '.studio', 'director-flow.json')), `${fp.stdout.slice(0, 500)}${fp.stderr}`);
    const br = run(dir, 'node harness/director.mjs brief');
    const brief = fs.existsSync(path.join(dir, '.studio', 'briefs', 'director.md')) ? fs.readFileSync(path.join(dir, '.studio', 'briefs', 'director.md'), 'utf8') : '';
    report('2.30h: the Director\'s brief carries the flow and the models\' limits (awareness, not locks)', /## The flow/.test(brief) && /You own the flow/.test(brief) && /## Models in use and their limits/.test(brief), `${br.stdout}${br.stderr}${brief.slice(-600)}`);
  }

  // 3. Reasoning-only replies are failed hand-offs, rerouted to another family.
  {
    const ro = probe(`import { isReasoningOnly, sessionReasoningOnly, rerouteFor } from ${u('harness/reasoning-only.mjs')};
const log = [JSON.stringify({ type: 'result', result: '', usage: { output_tokens: 3900 }, num_turns: 1 })].join('\\n');
const ok = [JSON.stringify({ type: 'result', result: 'Done: T-1', usage: { output_tokens: 3900 }, num_turns: 9 })].join('\\n');
const ev = [{ type: 'agent.session.start', task: 'T-1', model: 'glm-4.6' }, { type: 'agent.reasoning_only', task: 'T-1', model: 'glm-4.6' }];
console.log(JSON.stringify({ a: isReasoningOnly({ content: '', reasoning: 'Let me think' }), b: isReasoningOnly({ content: '<think>long</think>' }), c: isReasoningOnly({ content: '<think>x</think>Answer: 4', reasoning: 'x' }), d: sessionReasoningOnly(log), e: sessionReasoningOnly(ok), r: rerouteFor('T-1', ev, { STUDIO_REROUTE_MODELS: 'zai:glm-5,codex:gpt-5' }), s: rerouteFor('T-1', ev, {}), t: rerouteFor('T-1', [...ev, { type: 'agent.session.start', task: 'T-1', model: 'gpt-5' }], {}) }));`);
    report('2.30h: a reply with reasoning and no answer counts as failed; an answer after <think> does not; an empty session result is caught', ro.a === true && ro.b === true && ro.c === false && ro.d === true && ro.e === false, JSON.stringify(ro).slice(0, 500));
    report('2.30h: the reroute picks the first model of another family (suggested only when none is set; cleared once another session starts)', ro.r?.applied === true && ro.r.model === 'gpt-5' && ro.r.tool === 'codex' && ro.s?.applied === false && ro.s.fromFamily === 'zhipu' && ro.t === null, JSON.stringify({ r: ro.r, s: ro.s, t: ro.t }));
    // The router: a fake OpenAI-compatible server answers with reasoning only, then (second test) with text.
    const routerProbe = (mode) => probe(`import http from 'node:http';
const srv = http.createServer((req, res) => { let b = ''; req.on('data', (d) => (b += d)); req.on('end', () => { res.setHeader('content-type', 'application/json'); res.end(JSON.stringify({ model: 'glm-4.6', choices: [{ message: ${mode === 'ro' ? "{ content: '', reasoning_content: 'Let me think about this for a very long time' }" : "{ content: 'APPROVE' }"} }], usage: { prompt_tokens: 10, completion_tokens: 900 } })); }); });
await new Promise((r) => srv.listen(0, '127.0.0.1', r));
process.env.OLLAMA_BASE_URL = 'http://127.0.0.1:' + srv.address().port + '/v1';
process.env.OLLAMA_MODEL = 'glm-4.6';
const { routeChatCompletion } = await import(${u('harness/route.mjs')});
const r = await routeChatCompletion({ role: 'reviewer', customChain: ['ollama-local', 'ollama-local'], messages: [{ role: 'user', content: 'review' }], task: 'T-9' });
srv.close();
const fs = await import('node:fs');
const ev = fs.readFileSync('.studio/events.jsonl', 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l)).filter((e) => e.type === 'route.reasoning_only');
console.log(JSON.stringify({ ok: r.ok, content: r.content || null, attempts: r.attempts.map((a) => a.status), ev: ev.length }));`);
    const r1 = routerProbe('ro');
    const r2 = routerProbe('ok');
    report('2.30h: the router treats a reasoning-only reply as failed (route.reasoning_only), passes over that family for the call, and keeps a real answer', r1.ok === false && r1.attempts?.[0] === 'reasoning_only' && r1.attempts?.[1] === 'skipped_family' && r1.ev >= 1 && r2.ok === true && r2.content === 'APPROVE', JSON.stringify({ r1, r2 }).slice(0, 700));
  }

  // 4. Model limits: awareness for the Director, never a lock.
  {
    const ml = probe(`import { limitsFor, limitWatch } from ${u('harness/model-limits.mjs')};
const now = Date.now();
const ts = (ms) => new Date(now - ms).toISOString();
const ev = [];
for (let i = 0; i < 90; i++) ev.push({ type: 'route.success', model: 'gemini-2.5-pro', ts: ts(3600000), tokensIn: 1000 });
ev.push({ type: 'route.failover', model: 'glm-4.6', ts: ts(60000), msg: 'Failover from nvidia (429) -> cooling 60s' });
ev.push({ type: 'route.success', model: 'glm-4.6', ts: ts(30000), tokensIn: 120000 });
const rows = limitWatch({ events: ev, now, overrides: { '/glm/i': { context: 128000, rpm: 40, note: 'set by the studio' } } });
const by = Object.fromEntries(rows.map((r) => [r.model, r]));
console.log(JSON.stringify({ pro: limitsFor('gemini-2.5-pro', {}), g3: limitsFor('gemini-3.1-pro-preview', {}), unknown: limitsFor('my-model', {}), proFlags: by['gemini-2.5-pro'].flags, glm: by['glm-4.6'].flags, glmSrc: by['glm-4.6'].limits.source }));`);
    report('2.30h: each model\'s context and rate limits are on record (the studio file wins), and near-limit use and 429s are flagged for the Director', ml.pro?.rpd === 100 && ml.g3?.context === 1048576 && Object.keys(ml.unknown || {}).length === 0 && ml.proFlags?.some((f) => /90 of 100 requests a day/.test(f)) && ml.glm?.some((f) => /120,000-token prompt/.test(f)) && ml.glm.some((f) => /limit error/.test(f)) && ml.glmSrc === 'studio/model-limits.json', JSON.stringify(ml).slice(0, 700));
    const src = fs.readFileSync(path.join(dir, 'harness', 'route.mjs'), 'utf8') + fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
    report('2.30h: model limits never block: the router and the launcher don\'t read them', !/model-limits/.test(src), 'route.mjs or agent.mjs imports model-limits');
  }

  // 5. The CI watch: wait, re-run the failed jobs once, then alert.
  {
    const ghJs = (finalOk) => `import fs from 'node:fs';
const a = process.argv.slice(2); const st = ${JSON.stringify(path.join(dir, 'gh-state.json'))};
const s = fs.existsSync(st) ? JSON.parse(fs.readFileSync(st, 'utf8')) : { reruns: 0, lists: 0 };
if (a[0] === '--version') { console.log('gh version 0'); process.exit(0); }
if (a[0] === 'run' && a[1] === 'rerun') { s.reruns++; fs.writeFileSync(st, JSON.stringify(s)); process.exit(0); }
if (a[0] === 'run' && a[1] === 'list') { s.lists++; fs.writeFileSync(st, JSON.stringify(s));
  const done = s.lists > 1; const ok = s.reruns > 0 && ${finalOk};
  console.log(JSON.stringify([{ databaseId: 7, name: 'ci', workflowName: 'ci', status: done ? 'completed' : 'in_progress', conclusion: done ? (ok ? 'success' : 'failure') : '' }])); process.exit(0); }
if (a[0] === 'run' && a[1] === 'view') { const ok = s.reruns > 0 && ${finalOk}; console.log(JSON.stringify({ jobs: [{ name: 'windows', conclusion: ok ? 'success' : 'failure' }, { name: 'release-gate (22)', conclusion: 'success' }] })); process.exit(0); }
process.exit(1);`;
    const fakeRed = program('fake-gh-red', ghJs(false));
    const notify = `node -e "require('fs').writeFileSync('notified.txt', process.env.CI_SUMMARY)"`;
    const red = run(dir, 'node harness/ci-watch.mjs --sha abcdef1234567 --poll-sec 0', { STUDIO_GH: `"${fakeRed}"`, STUDIO_CI_NOTIFY_CMD: notify });
    const s1 = JSON.parse(fs.readFileSync(path.join(dir, 'gh-state.json'), 'utf8'));
    const rec = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'ci-watch.json'), 'utf8'));
    const evs = fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8');
    report('2.30h: the CI watch re-runs a failed job once, then raises ci.failed, runs the notify hook and records the card', red.status === 1 && s1.reruns === 1 && rec.state === 'red' && rec.failing.join() === 'ci/windows' && /"type":"ci.failed"/.test(evs) && fs.existsSync(path.join(dir, 'notified.txt')) && /CI red on abcdef1/.test(fs.readFileSync(path.join(dir, 'notified.txt'), 'utf8')), `${red.stdout}${red.stderr}${JSON.stringify(rec).slice(0, 300)}`);
    fs.rmSync(path.join(dir, 'gh-state.json'));
    fs.rmSync(path.join(dir, 'notified.txt'));
    const fakeGreen = program('fake-gh-green', ghJs(true));
    const green = run(dir, 'node harness/ci-watch.mjs --sha abcdef1234567 --poll-sec 0', { STUDIO_GH: `"${fakeGreen}"`, STUDIO_CI_NOTIFY_CMD: notify });
    const rec2 = JSON.parse(fs.readFileSync(path.join(dir, '.studio', 'ci-watch.json'), 'utf8'));
    report('2.30h: a job that passes on its one re-run reads "green after one re-run", with no alert', green.status === 0 && rec2.state === 'green after one re-run' && !fs.existsSync(path.join(dir, 'notified.txt')), `${green.stdout}${green.stderr}`);
    const al = probe(`import { ALERT_KINDS } from ${u('harness/alerts.mjs')}; console.log(JSON.stringify(ALERT_KINDS));`);
    report('2.30h: ci.failed and a starved flow are phone-alert kinds', Array.isArray(al) && al.includes('ci.failed') && al.includes('director.flow.starved'), JSON.stringify(al));
  }

  // 7. A GDScript that doesn't parse fails the engine gate, by name.
  {
    const godot = program('fake-godot', `import fs from 'node:fs'; import path from 'node:path';
const a = process.argv.slice(2); const p = a[a.indexOf('--path') + 1];
if (a.includes('--check-only')) { const f = a[a.indexOf('--script') + 1].replace('res://', '');
  if (/BROKEN/.test(fs.readFileSync(path.join(p, f), 'utf8'))) { console.log('SCRIPT ERROR: Parse Error: Expected parameter name.'); console.log('          at: GDScript::reload (res://' + f + ':2)'); process.exit(1); } }
process.exit(0);`);
    const proj = 'engine/example-sim';
    write(`${proj}/project.godot`, '[application]\nconfig/name="x"\n');
    write(`${proj}/.godot/.keep`, '');
    write(`${proj}/main.gd`, 'extends Node\nfunc _ready():\n\tpass\n');
    write(`${proj}/sim/boats.gd`, 'extends Node\nfunc _ready(:\n\tpass # BROKEN\n');
    write(`${proj}/addons/lib/x.gd`, 'BROKEN but an addon');
    write(`${proj}/engine.json`, JSON.stringify({ engine: 'godot', label: 'Godot 4', game: 'example-sim', folder: proj, track: 'engine:godot', gate: `"${godot}" --headless --path ${proj} --script res://tools/gate.gd` }));
    const cli = run(dir, `node harness/gdscript-parse.mjs ${proj} --godot "${godot}"`);
    const gate = run(dir, 'node scripts/check-engine.mjs', { STUDIO_CARTRIDGE: 'example-sim', STUDIO_GODOT: godot });
    const gout = `${gate.stdout}${gate.stderr}`;
    report('2.30h: the GDScript parse check names the script that doesn\'t parse and skips addons', cli.status === 1 && /1 of 2 script\(s\) don't parse/.test(cli.stderr) && /sim\/boats\.gd: SCRIPT ERROR: Parse Error/.test(cli.stderr) && !/addons/.test(cli.stderr), `${cli.stdout}${cli.stderr}`);
    report('2.30h: the engine gate fails when a GDScript doesn\'t parse, even though the engine\'s own run exited 0', gate.status === 1 && /sim\/boats\.gd/.test(gout) && /1\/2 GDScript file\(s\) parse/.test(gout), gout.slice(-600));
    write(`${proj}/sim/boats.gd`, 'extends Node\nfunc _ready():\n\tpass\n');
    const ok = run(dir, 'node scripts/check-engine.mjs', { STUDIO_CARTRIDGE: 'example-sim', STUDIO_GODOT: godot });
    report('2.30h: the engine gate passes once every GDScript parses', ok.status === 0 && /2\/2 GDScript file\(s\) parse/.test(ok.stdout), `${ok.stdout}${ok.stderr}`);
    fs.rmSync(path.join(dir, proj), { recursive: true, force: true });
  }

  // The release check sets package-lock.json's version itself (the 2.30d miss).
  {
    const lk = probe(`import fs from 'node:fs'; import { syncLockVersion } from ${u('scripts/lock-version.mjs')};
const f = 'package-lock.json'; const l = JSON.parse(fs.readFileSync(f, 'utf8')); l.version = '0.0.1'; l.packages[''].version = '0.0.1'; fs.writeFileSync(f, JSON.stringify(l));
const r = syncLockVersion(process.cwd(), '9.9.9-h'); const after = JSON.parse(fs.readFileSync(f, 'utf8'));
const again = syncLockVersion(process.cwd(), '9.9.9-h');
console.log(JSON.stringify({ r, v: after.version, p: after.packages[''].version, again: again.changed }));`);
    report('2.30h: the release step sets both package-lock.json versions to the release, and leaves a matching lock alone', lk.r?.changed === true && lk.r.from === '0.0.1' && lk.v === '9.9.9-h' && lk.p === '9.9.9-h' && lk.again === false, JSON.stringify(lk));
  }

  // The Director's per-task trick cap: default 3, clamped to 1..6, per-task override.
  {
    const tc = probe(`import { clampTricks, trickCap, setTrickCap, matchTricks, MAX_TRICKS } from ${u('harness/cheatsheet.mjs')};
const entries = Array.from({ length: 9 }, (_, i) => ({ id: 'C-' + i, tags: ['test'], text: 't' + i }));
const d = trickCap(); const a = matchTricks('test', { entries }).length;
setTrickCap(5, 'director'); const b = matchTricks('test', { entries }).length;
setTrickCap(40, 'director'); const c = trickCap();
const one = matchTricks('test', { entries, max: clampTricks(2) }).length;
setTrickCap(MAX_TRICKS, 'director');
console.log(JSON.stringify({ d, a, b, c, one, z: clampTricks(0), bad: clampTricks('x') }));`);
    report('2.30h: the Director can set the trick cap (default 3, never over 6) and a task can override it', tc.d === 3 && tc.a === 3 && tc.b === 5 && tc.c === 6 && tc.one === 2 && tc.z === 3 && tc.bad === 3, JSON.stringify(tc));
  }

  // Reviewer follow-ups: flow skips failing tasks, dead-agent locks, capture path, Claude/Opus ceiling.
  {
    const fr = probe(`import { flowReport } from ${u('harness/director-flow.mjs')}; import { failingTasks } from ${u('harness/breaker.mjs')};
const ev = [{ type: 'task.paused', task: 'T-1', meta: { reasonKey: 'verify failed' } }, { type: 'task.paused', task: 'T-2', meta: {} }, { type: 'task.paused', task: 'T-3', meta: { reasonKey: 'x' } }, { type: 'task.unblocked', task: 'T-3' }];
const failing = failingTasks(ev);
const queue = { inProgress: [], backlog: [{ id: 'T-1', role: 'builder', title: 'a' }, { id: 'T-2', role: 'builder', title: 'b' }, { id: 'T-4', role: 'builder', title: 'c' }] };
const r = flowReport({ queue, failing, held: (id) => (id === 'T-4' ? 'parked' : null) });
console.log(JSON.stringify({ f: [...failing], ready: r.ready.total, failingList: r.failing, held: r.ready.held }));`);
    report('2.30h: the flow refills only from clean work: a task whose last hand-back failed and a parked task are never counted ready', JSON.stringify(fr.f) === '["T-1"]' && fr.ready === 1 && JSON.stringify(fr.failingList) === '["T-1"]' && fr.held === 1, JSON.stringify(fr));
    const dl = probe(`import { claim, listLocks, releaseDeadOwners } from ${u('harness/lock.mjs')};
claim('task:T-90', 'builder-dead'); claim('task:T-91', 'builder-live'); claim('task:T-92', 'hatch');
const known = { 'builder-dead': false, 'builder-live': true };
const freed = releaseDeadOwners((o) => o in known && !known[o]);
const left = listLocks().map((l) => l.owner).sort();
console.log(JSON.stringify({ freed, left }));`);
    report('2.30h: locks of an agent whose process is gone are freed; a live agent\'s and a person\'s stay', dl.freed?.length === 1 && /builder-dead/.test(dl.freed[0]) && dl.left?.includes('builder-live') && dl.left?.includes('hatch') && !dl.left?.includes('builder-dead'), JSON.stringify(dl));
    const cp = probe(`import path from 'node:path'; import { engineCommand } from ${u('harness/engine.mjs')};
const c = engineCommand({ engine: 'godot', capture: '{bin} --path engine/g --write-movie engine/g/captures/frame.png --quit-after {frames}' }, 'capture', { frames: 5 });
const m = c.match(/--write-movie "([^"]+)"/);
console.log(JSON.stringify({ c, abs: Boolean(m && path.isAbsolute(m[1]) && m[1].endsWith(path.join('engine', 'g', 'captures', 'frame.png'))) }));`);
    report('2.30h: the Godot capture command writes frames to an absolute path (not relative to the project folder)', cp.abs === true, JSON.stringify(cp));
    const ml = probe(`import { limitsFor } from ${u('harness/model-limits.mjs')};
console.log(JSON.stringify({ o: limitsFor('claude-opus-4-1').context, o1m: limitsFor('claude-opus-4-6[1m]').context, s: limitsFor('sonnet').context }));`);
    report('2.30h: Claude/Opus have a context ceiling in the model limits, like the free models', ml.o === 200000 && ml.o1m === 1000000 && ml.s === 200000, JSON.stringify(ml));
  }
}

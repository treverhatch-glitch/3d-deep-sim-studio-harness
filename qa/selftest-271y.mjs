/**
 * qa/selftest-271y.mjs — 2.71.0 (helper y): the overseer's paperwork in the harness.
 *   board     `npm run next-board`: per role the tasks that can start, their blockers (an --after chain, a park), the
 *             overlaps 2.69 recorded, lanes waiting for the train (held ones named), what needs a person; under 150 words.
 *   post      `npm run report -- post` sends the report as JSON to STUDIO_REPORT_WEBHOOK: discord { content } split at
 *             2000 characters, slack { text }, json { what, text, at }; the host picks the format; --dry-run sends nothing.
 *   retry     one retry on a 5xx or 429 after Retry-After (capped at 30 s); a 4xx is not retried; a failure is a
 *             result and a report.posted error event, never a throw.
 *   secret    the webhook never appears in output, events, logs or state; launched agents don't get it.
 *   pass      the supervisor's pass posts the digest once a day at STUDIO_REPORT_HOUR and the board when it changed a
 *             lot (STUDIO_REPORT_NEXT_MIN); nothing without a webhook.
 *   brief     `npm run brief -- builder --write` composes the builder's brief from the real rules (under 800 words, its
 *             sources' hash, what it cut, the policy file when present); the kickoff uses it and rewrites it when a
 *             source changed or it was edited by hand.
 *   research  `task add --type research`: the template at task start, done refuses a write-up without a Sources section
 *             or a link, the game's docs folder when it has one, the digest lists finished research.
 * A local HTTP server (a separate process) stands in for the webhook: no network, no paid service.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest271Y({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', ...a], { windowsHide: true, cwd, encoding: 'utf8' });
  const write = (rel, text) => { fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true }); fs.writeFileSync(path.join(dir, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const events = path.join(dir, '.studio', 'events-271y.jsonl');
  const evs = () => { try { return fs.readFileSync(events, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  const addEvent = (e) => fs.appendFileSync(events, `${JSON.stringify({ ts: new Date().toISOString(), agent: 't', ...e })}\n`);
  // A made-up token, long enough to look like a real one; the URL points at the local stand-in.
  const TOKEN = `tok${'Q7x2'.repeat(10)}Zr9w`;
  const env = {
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '',
    STUDIO_ROLE: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_AGENT: '', STUDIO_OVERLAP: 'off', STUDIO_GAME: '', STUDIO_CARTRIDGE: '',
    STUDIO_REPORT_WEBHOOK: '', STUDIO_REPORT_FORMAT: '', STUDIO_REPORT_HOUR: '', STUDIO_REPORT_NEXT_MIN: '', STUDIO_DIGEST: 'off', STUDIO_HOOKS_CHECK: 'off',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-271y-${process.pid}.pem`), STUDIO_QUOTA_PROBE: 'off', STUDIO_MACHINE_SCAN: '', STUDIO_LANE_INFER: 'off',
    AGENT_EVENTS_FILE: events, AGENT_EVENTS_MIRROR: '', GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid',
  };
  let n = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(tmpRoot, `p271y-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, { ...env, ...extra });
    fs.rmSync(f, { force: true });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _out: out(r).slice(-3000) }; } catch { return { _out: out(r).slice(-3000) }; }
  };

  // ---- the stand-in webhook: a separate process (the CLIs run with spawnSync), logging each request to a file ----
  const srvFile = path.join(tmpRoot, `hook-271y-${process.pid}.mjs`);
  fs.writeFileSync(srvFile, `import http from 'node:http'; import fs from 'node:fs';
const [log, planFile] = process.argv.slice(2);
let i = 0; let last = null;
http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
  let raw = '200'; try { raw = fs.readFileSync(planFile, 'utf8').trim() || '200'; } catch {}
  if (raw !== last) { last = raw; i = 0; }
  const plan = raw.split('|').pop().split(',').filter(Boolean);
  const step = plan[Math.min(i, plan.length - 1)]; i += 1;
  const [code, ra] = step.split(':');
  fs.appendFileSync(log, JSON.stringify({ at: Date.now(), method: req.method, path: req.url, type: req.headers['content-type'], body: b }) + '\\n');
  res.writeHead(Number(code), ra ? { 'retry-after': ra } : {}); res.end(code === '200' || code === '204' ? '' : 'no');
}); }).listen(0, '127.0.0.1', function () { console.log('listening ' + this.address().port); });
`);
  const hookLog = path.join(tmpRoot, `hook-271y-${process.pid}.jsonl`);
  const planFile = path.join(tmpRoot, `hook-271y-plan-${process.pid}.txt`);
  fs.writeFileSync(planFile, '200');
  const srv = spawn(process.execPath, [srvFile, hookLog, planFile], { windowsHide: true, stdio: ['ignore', 'pipe', 'inherit'] });
  const port = await new Promise((resolve) => { let buf = ''; srv.stdout.on('data', (c) => { buf += c; const m = buf.match(/listening (\d+)/); if (m) resolve(Number(m[1])); }); setTimeout(() => resolve(0), 10000); });
  const HOOK = `http://127.0.0.1:${port}/api/hooks/9911/${TOKEN}`;
  const reqs = () => { try { return fs.readFileSync(hookLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
  let nonce = 0;
  const resetHook = (plan = '200') => { fs.writeFileSync(hookLog, ''); fs.writeFileSync(planFile, `${++nonce}|${plan}`); };
  const seen = []; // every output, for the "never printed" check
  const R = (cmd, extra = {}) => { const r = run(dir, cmd, { ...env, ...extra }); seen.push(out(r)); return r; };

  try {
    // ---- a made-up studio: a git checkout with its own board ----
    fs.mkdirSync(path.dirname(events), { recursive: true });
    fs.writeFileSync(events, '');
    for (const d of ['.studio/agents', '.studio/train', '.studio/briefs', '.lanes']) fs.rmSync(path.join(dir, d), { recursive: true, force: true });
    write('studio/NEXT.md', '# Next\n\n## IN_PROGRESS\n\n## BACKLOG\n\n## DONE\n');
    write('studio/DONE.md', '# Done\n');
    for (const f of ['studio/policy.json', 'studio/PITFALLS.md', 'studio/game.json']) fs.rmSync(path.join(dir, f), { force: true });
    g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false');
    g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
    const add = (title, extra = '') => (out(R(`node harness/task.mjs add "${title}" --priority P1 ${extra}`)).match(/"id": "(T-\d+)"/) || [])[1];
    const t1 = add('Stack crates three high', '--role builder');
    const t2 = add('Paint the crate yard gate', '--role builder');
    const t3 = add('Crane lifts stacked crates', `--role builder --after ${t1}`);
    const t4 = add('Night shift lighting', '--role builder');
    R(`node harness/task.mjs park ${t4} --by human --why "after the art pass"`);
    const t5 = add('First seeded run of the yard', '--role qa-playtester');
    write('.studio/train/queue.json', JSON.stringify([{ task: 'T-90', agent: 'builder-x', head: 'abc', held: { tier: 'C', why: 'changes a protected file' } }, { task: 'T-91', agent: 'builder-y', head: 'def' }]));
    addEvent({ type: 'task.overlap', task: t2, status: 'warn', msg: 'overlap', meta: { phase: 'start', with: [t1] } });

    // ---- 1. the what's-next board ----
    const b = R('npm run next-board --silent');
    const bt = out(b);
    const words = String(b.stdout || '').split(/\s+/).filter(Boolean).length;
    await guard('271y board: npm run next-board lists the builder tasks that can start, the --after chain and the park blocking the rest, the overlap 2.69 recorded, the train lanes waiting (the held one for your release), the other role, under 150 words (fails on 2.70.0: no next-board command)', () => [
      b.status === 0 && words > 0 && words < 150 && new RegExp(`builder: ${t1} `).test(bt) && bt.includes(t2) && new RegExp(`${t3} waits for ${t1}`).test(bt) && new RegExp(`${t4} parked`).test(bt)
        && new RegExp(`Overlaps: ${t2} with ${t1}`).test(bt) && /Trains: 1 queued \(T-91\); 1 held for your release \(T-90\)/.test(bt) && new RegExp(`qa-playtester: ${t5}`).test(bt) && /Needs a person/.test(bt),
      `${words} words\n${bt}`]);

    // ---- 2. posting: discord split, slack, json, the host choosing ----
    resetHook('200');
    const long = Array.from({ length: 90 }, (_, i) => `line ${i} ${'crate '.repeat(8)}`).join('\n');
    const pd = probe(`import { postReport } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify(await postReport({ what: 'status', text: ${JSON.stringify(long)} })));`, { STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_FORMAT: 'discord' });
    seen.push(pd._out);
    const dr = reqs();
    const parts = dr.map((r) => JSON.parse(r.body));
    await guard('271y post discord: STUDIO_REPORT_FORMAT=discord sends { content } parts of at most 2000 characters, split at line ends, in order, mentions off, as application/json POSTs that rebuild the whole text (fails on 2.70.0: no harness/report-post.mjs)', () => [
      pd.ok === true && pd.parts === parts.length && parts.length >= 2 && parts.every((p) => typeof p.content === 'string' && p.content.length <= 2000 && p.allowed_mentions) && parts.map((p) => p.content).join('\n') === long
        && dr.every((r) => r.method === 'POST' && /application\/json/.test(r.type || '')),
      JSON.stringify({ pd, n: parts.length, lens: parts.map((p) => p.content?.length) })]);
    resetHook('200');
    const st = R('npm run report --silent -- post --what status', { STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_FORMAT: 'slack' });
    const sr = reqs().map((r) => JSON.parse(r.body));
    resetHook('200');
    const js = R('npm run report --silent -- post --what next', { STUDIO_REPORT_WEBHOOK: HOOK });
    const jr = reqs().map((r) => JSON.parse(r.body));
    const fm = probe(`import { formatFor } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify({ d: formatFor('https://discord.com/api/webhooks/1/x', {}), s: formatFor('https://hooks.slack.com/services/T0/B0/x', {}), o: formatFor('https://example.invalid/hook', {}), f: formatFor('https://discord.com/api/webhooks/1/x', { STUDIO_REPORT_FORMAT: 'json' }) }));`);
    await guard('271y post slack/json: slack sends { text } (the status brief), an unknown host sends { what, text, at } (the what\'s-next board); discord.com and hooks.slack.com pick their formats, STUDIO_REPORT_FORMAT wins (fails on 2.70.0: no report command)', () => [
      st.status === 0 && sr.length === 1 && Object.keys(sr[0]).join() === 'text' && /^Studio \d\d:\d\d UTC/.test(sr[0].text)
        && js.status === 0 && jr.length === 1 && jr[0].what === 'next' && /^What's next/.test(jr[0].text) && jr[0].at
        && fm.d === 'discord' && fm.s === 'slack' && fm.o === 'json' && fm.f === 'json',
      `${out(st)}\n${JSON.stringify(sr)}\n${out(js)}\n${JSON.stringify(jr)}\n${JSON.stringify(fm)}`]);
    resetHook('200');
    const dry = R('npm run report --silent -- post --what next --dry-run', { STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_FORMAT: 'discord' });
    const none = R('npm run report --silent -- post --what status', { STUDIO_REPORT_WEBHOOK: '' });
    await guard('271y post dry-run and no webhook: --dry-run prints the payload and sends nothing; with no webhook set, the post is refused with how to set it, exit 1, nothing sent (fails on 2.70.0: no report command)', () => [
      dry.status === 0 && /dry run/.test(out(dry)) && /"content"/.test(out(dry)) && none.status === 1 && /STUDIO_REPORT_WEBHOOK/.test(out(none)) && reqs().length === 0,
      `${out(dry)}\n${out(none)}\n${reqs().length}`]);

    // ---- 3. retry ----
    resetHook('503,200');
    const r1 = probe(`import { postReport } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify(await postReport({ what: 'status', text: 'one' })));`, { STUDIO_REPORT_WEBHOOK: HOOK });
    const a1 = reqs().length;
    resetHook('429:1,200');
    const r2 = probe(`import { postReport } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify(await postReport({ what: 'status', text: 'two' })));`, { STUDIO_REPORT_WEBHOOK: HOOK });
    const q2 = reqs();
    resetHook('500,500,500');
    const r3 = R('npm run report --silent -- post --what status', { STUDIO_REPORT_WEBHOOK: HOOK });
    const a3 = reqs().length;
    resetHook('400');
    const r4 = probe(`import { postReport } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify(await postReport({ what: 'status', text: 'four' })));`, { STUDIO_REPORT_WEBHOOK: HOOK });
    const a4 = reqs().length;
    const ra = probe(`import { retryAfterMs } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify({ big: retryAfterMs('120'), one: retryAfterMs('1'), none: retryAfterMs(null), date: retryAfterMs(new Date(Date.now() + 5000).toUTCString()) }));`);
    const errEv = evs().filter((e) => e.type === 'report.posted' && e.status === 'error');
    await guard('271y retry: a 503 is retried once and posts; a 429 waits its Retry-After (1 s) before the one retry; a 500 twice is two tries, exit 1 and a report.posted error event, no throw; a 400 is not retried; Retry-After is capped at 30 s (fails on 2.70.0: no report command)', () => [
      r1.ok === true && r1.attempts === 2 && a1 === 2 && r2.ok === true && q2.length === 2 && q2[1].at - q2[0].at >= 900
        && r3.status === 1 && a3 === 2 && /not posted: HTTP 500/.test(out(r3)) && errEv.some((e) => e.meta?.attempts === 2 && e.meta?.status === 500)
        && r4.ok === false && r4.attempts === 1 && a4 === 1 && ra.big === 30000 && ra.one === 1000 && ra.none === 1000 && ra.date > 2000 && ra.date <= 5000,
      JSON.stringify({ r1, a1, r2, gap: q2.length === 2 ? q2[1].at - q2[0].at : null, r3: out(r3), a3, r4, a4, ra, errEv: errEv.length })]);

    // ---- 4. the webhook never shows ----
    const closed = `http://127.0.0.1:9/api/hooks/77/${TOKEN}`;
    const r5 = probe(`import { postReport } from ${u('harness/report-post.mjs')}; console.log(JSON.stringify(await postReport({ what: 'status', text: 'x' })));`, { STUDIO_REPORT_WEBHOOK: closed });
    seen.push(JSON.stringify(r5));
    write('.env', `STUDIO_REPORT_WEBHOOK=${HOOK}\n`);
    resetHook('200');
    const r6 = R('npm run report --silent -- post --what status', { STUDIO_REPORT_WEBHOOK: '' });
    const fromDotenv = reqs().length;
    fs.rmSync(path.join(dir, '.env'), { force: true });
    const ae = probe(`import { agentEnv } from ${u('harness/agent-env.mjs')}; const e = agentEnv({ tool: 'claude', role: 'builder', env: { PATH: '/bin', STUDIO_REPORT_WEBHOOK: 'secret-hook', STUDIO_GATE_SLOTS: '1' } }); console.log(JSON.stringify({ has: 'STUDIO_REPORT_WEBHOOK' in e, keeps: e.STUDIO_GATE_SLOTS }));`);
    const files = [];
    (function walk(d) { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else files.push(f); } })(path.join(dir, '.studio'));
    const leaked = files.filter((f) => { try { return fs.readFileSync(f, 'utf8').includes(TOKEN); } catch { return false; } });
    const printed = seen.filter((s) => s.includes(TOKEN) || s.includes(HOOK));
    const posted = evs().filter((e) => e.type === 'report.posted');
    await guard('271y secret: the webhook URL and its token appear in no output, error (a refused connection is scrubbed), event or .studio file; output names it "webhook ...<last 4>"; STUDIO_REPORT_WEBHOOK is read from .env; launched agents never get it (fails on 2.70.0: no report command, and agentEnv passes every STUDIO_ name)', () => [
      !printed.length && !leaked.length && posted.length >= 4 && posted.every((e) => !JSON.stringify(e).includes(TOKEN) && !JSON.stringify(e).includes(String(port)))
        && r5.ok === false && r5.why && !String(r5.why).includes(TOKEN) && /webhook \.\.\.Zr9w/.test(out(r6)) && r6.status === 0 && fromDotenv === 1 && ae.has === false && ae.keeps === '1',
      JSON.stringify({ printed: printed.map((s) => s.slice(0, 300)), leaked, r5, r6: out(r6), fromDotenv, ae, ev: posted.slice(-2) })]);

    // ---- 5. the supervisor's pass ----
    resetHook('200');
    const pass = (extra = {}) => probe(`import { reportPass } from ${u('harness/report-post.mjs')}; const r = await reportPass({ inline: true }); console.log(JSON.stringify({ posted: r.posted, why: r.why || null, line: r.line || null }));`, extra);
    const noHook = pass({ STUDIO_REPORT_HOUR: '0' });
    const p1 = pass({ STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_HOUR: '0', STUDIO_REPORT_NEXT_MIN: '0' });
    const q1 = reqs().map((r) => JSON.parse(r.body));
    const p2 = pass({ STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_HOUR: '0', STUDIO_REPORT_NEXT_MIN: '0' });
    add('Crate scanner', '--role builder'); add('Forklift path', '--role builder'); add('Yard fence', '--role builder');
    const p3 = pass({ STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_HOUR: '0', STUDIO_REPORT_NEXT_MIN: '0' });
    add('Gate sign', '--role builder'); add('Crate labels', '--role builder'); add('Crate colors', '--role builder');
    const p4 = pass({ STUDIO_REPORT_WEBHOOK: HOOK, STUDIO_REPORT_NEXT_MIN: '600' });
    const p5 = pass({ STUDIO_REPORT_WEBHOOK: HOOK });
    seen.push(JSON.stringify([p1, p2, p3, p4, p5]));
    await guard('271y pass: the supervisor\'s pass posts the digest once a day at STUDIO_REPORT_HOUR and the board on its first look; the same board again posts nothing; 3 new tasks post the board again; STUDIO_REPORT_NEXT_MIN holds it back; no webhook, nothing (fails on 2.70.0: no reportPass)', () => [
      noHook.posted?.length === 0 && p1.posted?.join() === 'digest,next' && q1.length === 2 && /Studio digest/.test(q1[0].text) && /^What's next/.test(q1[1].text)
        && p2.posted?.length === 0 && p3.posted?.join() === 'next' && p4.posted?.length === 0 && p5.posted?.length === 0 && /webhook \.\.\.Zr9w/.test(p1.line || ''),
      JSON.stringify({ noHook, p1, q1: q1.map((x) => String(x.text).slice(0, 40)), p2, p3, p4, p5 })]);

    // ---- 6. the builder's brief ----
    write('studio/PITFALLS.md', '# Pitfalls\n\n- [builder] never stack crates past the crane height (t, 2026-11-01)\n- [art] keep the yard palette (t, 2026-11-01)\n');
    write('studio/policy.json', JSON.stringify({ autonomous: { allowed: false }, never: ['money', 'delete-lanes'], notes: ['Ask before renaming crates in saves.'] }));
    const k0 = R('node harness/kickoff.mjs --role builder --agent builder-k0');
    const w = R('npm run brief --silent -- builder --write');
    const bf = path.join(dir, '.studio', 'briefs', 'role-builder.md');
    const text = fs.existsSync(bf) ? fs.readFileSync(bf, 'utf8') : '';
    const body = text.split('\n').slice(1).join('\n');
    const bw = body.split(/\s+/).filter(Boolean).length;
    await guard('271y brief: npm run brief -- builder --write writes .studio/briefs/role-builder.md from the real rules: the AGENTS file\'s Never rules, the builder pitfall (not the art one), the protected list, the gates with their Fix remedies, the policy file\'s "never" and notes, the claim/lane commands, its sources\' hash and what it cut, under 800 words; without it the kickoff reads the AGENTS file (fails on 2.70.0: `brief builder` prints a task brief, writes nothing)', () => [
      w.status === 0 && text.startsWith('<!-- generated') && /sources-sha256: [0-9a-f]{64}; body-sha256: [0-9a-f]{64}/.test(text) && bw <= 800 && /Never commit with `--no-verify`|Never edit `harness\/`/.test(body)
        && /crane height/.test(body) && !/yard palette/.test(body) && /`studio\/protected\.json`/.test(body) && /`golden`: .*golden -- --update/.test(body)
        && /money, delete-lanes/.test(body) && /renaming crates/.test(body) && /lock\.mjs claim path:/.test(body) && /(Cut to fit 800 words|Nothing was cut)/.test(body)
        && /Read `AGENTS(\.lite)?\.md`/.test(out(k0)) && !/role-builder/.test(out(k0)),
      `${bw} words\n${out(w).slice(-600)}\n${body.slice(0, 2500)}\nkickoff0: ${out(k0).slice(0, 400)}`]);
    write('studio/PITFALLS.md', '# Pitfalls\n\n- [builder] never stack crates past the crane height (t, 2026-11-01)\n- [builder] the forklift path is one-way (t, 2026-11-02)\n');
    const k1 = R('node harness/kickoff.mjs --role builder --agent builder-k1');
    const readBf = () => { try { return fs.readFileSync(bf, 'utf8'); } catch { return ''; } };
    const after1 = readBf();
    if (after1) fs.writeFileSync(bf, after1.replace('Never print', 'Always print'));
    const k2 = R('node harness/kickoff.mjs --role builder --agent builder-k2');
    const after2 = readBf();
    const rw = evs().filter((e) => e.type === 'brief.role.written').map((e) => e.meta?.why || '');
    const k3 = R('node harness/kickoff.mjs --role qa-playtester --agent qa-k3');
    await guard('271y brief kickoff: with a saved brief the builder kickoff reads it first; a changed source (a new pitfall) writes it again; a hand edit is noticed and written again from the sources; each rewrite is a brief.role.written event with why; other roles keep the AGENTS file (fails on 2.70.0: no generated brief)', () => [
      after1 && after2 && /Read `\.studio\/briefs\/role-builder\.md`/.test(out(k1)) && /forklift path is one-way/.test(after1) && /Read `\.studio\/briefs\/role-builder\.md`/.test(out(k2)) && !/Always print/.test(after2)
        && rw.some((x) => /source changed/.test(x)) && rw.some((x) => /edited by hand/.test(x)) && !/role-builder/.test(out(k3)),
      `${out(k1).slice(0, 400)}\n${rw.join(' | ')}\n${out(k3).slice(0, 300)}`]);

    // ---- 7. research ----
    const ra1 = R('node harness/task.mjs add "Which crate stacking limits do engines document" --type research --role builder');
    const tr = (out(ra1).match(/"id": "(T-\d+)"/) || [])[1];
    const s1 = R(`node harness/task.mjs start ${tr} --agent builder-r`);
    const rf = path.join(dir, 'docs', 'research', `${tr}.md`);
    const tpl = fs.existsSync(rf) ? fs.readFileSync(rf, 'utf8') : '';
    fs.mkdirSync(path.dirname(rf), { recursive: true }); // the old code writes no template: keep the steps below from throwing
    const c1 = R(`node harness/done-check.mjs ${tr}`);
    const d1 = R(`node harness/task.mjs done ${tr} --agent builder-r --check`);
    fs.writeFileSync(rf, tpl.replace('- (source title): (link), read (date)', '- Engine manual, stacking: https://example.invalid/manual/stacking, read 2026-11-02').replace('<!-- What to do next, in one or two lines, and the tasks it leads to. -->', 'Cap stacks at three crates.'));
    const c2 = R(`node harness/done-check.mjs ${tr}`);
    fs.writeFileSync(rf, tpl.replace('## Sources', '## Reading'));
    const c3 = R(`node harness/done-check.mjs ${tr}`);
    fs.rmSync(rf, { force: true });
    const c4 = R(`node harness/done-check.mjs ${tr}`);
    const rewrote = fs.existsSync(rf);
    await guard('271y research: --type research titles it "Research:"; task start writes the template (question, sources, findings, unverified, recommendation) to docs/research/<ID>.md; done refuses it with no link in Sources, or no Sources section; with a link it passes; a missing write-up gets the template and is refused (fails on 2.70.0: Unknown --type "research")', () => [
      ra1.status === 0 && /Research: Which crate/.test(out(ra1)) && s1.status === 0 && /## Question[\s\S]*## Sources[\s\S]*## Findings[\s\S]*## Unverified[\s\S]*## Recommendation/.test(tpl) && /docs\/research\//.test(out(s1))
        && c1.status === 1 && /"research" task/.test(out(c1)) && /\[ \] The write-up has a Sources section with at least one link: the Sources section of docs\/research\/T-\d+\.md has no link/.test(out(c1))
        && d1.status !== 0 && /Sources/.test(out(d1)) && /\[x\] The write-up has a Sources section/.test(out(c2)) && /\[x\] Research write-up/.test(out(c2))
        && /no "## Sources" section/.test(out(c3)) && c4.status === 1 && rewrote && /template is now at docs\/research\//.test(out(c4)),
      `${out(ra1).slice(0, 300)}\n${out(s1).slice(0, 400)}\n${out(c1)}\n${out(d1).slice(0, 600)}\n${out(c2)}\n${out(c3)}\n${out(c4)}`]);
    addEvent({ type: 'task.done', task: tr, msg: `Done ${tr}` });
    fs.writeFileSync(rf, tpl.replace('<!-- What to do next, in one or two lines, and the tasks it leads to. -->', 'Cap stacks at three crates and file the crane task.'));
    const dg = probe(`import { buildDigest } from ${u('harness/digest.mjs')}; const d = await buildDigest({}); console.log(JSON.stringify({ text: d.text }));`);
    write('game/crate-yard/docs/README.md', '# Crate yard docs\n');
    write('studio/game.json', JSON.stringify({ game: 'crate-yard' }));
    const gp = probe(`import { researchRel } from ${u('harness/research.mjs')}; console.log(JSON.stringify({ rel: researchRel('T-77') }));`);
    fs.rmSync(path.join(dir, 'studio', 'game.json'), { force: true });
    await guard('271y research digest: the digest lists research finished in 24 h with its write-up and the recommendation\'s first words; a game with its own docs folder keeps research in game/<name>/docs/research/ (fails on 2.70.0: no research line, no harness/research.mjs)', () => [
      new RegExp(`New research \\(1 in 24 h\\): ${tr} docs/research/${tr}\\.md \\("Cap stacks at three crates`).test(dg.text || '') && gp.rel === 'game/crate-yard/docs/research/T-77.md',
      `${dg.text || dg._out}\n${JSON.stringify(gp)}`]);
  } finally {
    try { srv.kill(); } catch {}
    for (const f of [srvFile, hookLog, planFile]) fs.rmSync(f, { force: true });
  }
}

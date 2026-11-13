/**
 * qa/selftest-285c.mjs — 2.85 (c): every ask resolves, and the "continue or hand off?" check decides by rule.
 *
 *   prices    a question with a price in it is an ordinary ask (harness/owner-acts.mjs): answered by the owner's
 *             stand-ins, with the ordinary deadline from its default
 *   timers    a default and no --timeout: STUDIO_ASK_TIMEOUT_H; no default: ask.stale once at STUDIO_ASK_STALE_H, never
 *             answered; the owner's own asks: never a deadline, never escalated (injected clock)
 *   refresh   the check point decides by rule (STUDIO_REFRESH_DECIDE): under the percentage it continues, over it or
 *             idle it hands off, no ask; `ask` mode still asks (harness/session-cap.mjs)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285C({ dir, root, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const tail = (r, n = 300) => `[${r.status}] ${out(r).replace(/\s+/g, ' ').trim().slice(-n)}`;
  const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv(), stdio: ['ignore', 'pipe', 'pipe'] });
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const harnessRoot = root || dir;
  const clean = {};
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const base = {
    ...clean, ...ident, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_VISUAL_GATE: 'off', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off',
    STUDIO_REACHABILITY: 'off', STUDIO_LANE_INFER: 'off', STUDIO_CREW_WATCH: 'off', STUDIO_OVERLAP: 'off', STUDIO_LANELESS: 'shared',
    STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285c-${process.pid}.pem`), CI: '', GITHUB_ACTIONS: '', NODE_OPTIONS: '', npm_lifecycle_event: '', npm_config_node_options: '',
  };

  const oa = await import(pathToFileURL(path.join(dir, 'harness', 'owner-acts.mjs')).href);

  // ---- the studio: beta mode naming overseer-1, signer-1 in the main checkout's .env ----
  const S = path.join(tmpRoot, `285c-studio-${process.pid}`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
  for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/task-holds.json', 'studio/asks', 'studio/decisions', 'studio/bible', 'studio/engine', 'studio/digest']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
  try { fs.symlinkSync(path.join(harnessRoot, 'node_modules'), path.join(S, 'node_modules'), process.platform === 'win32' ? 'junction' : 'dir'); } catch { /* the checks need no package */ }
  const { publicKey } = crypto.generateKeyPairSync('ed25519');
  write(S, 'studio/keys/owner-ed25519.pub.pem', publicKey.export({ type: 'spki', format: 'pem' }));
  write(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
  write(S, '.gitignore', `${fs.existsSync(path.join(dir, '.gitignore')) ? fs.readFileSync(path.join(dir, '.gitignore'), 'utf8') : ''}\n/.lanes/\n/.studio/\n.env\n`);
  write(S, '.env', 'STUDIO_OUTSIDE_SIGNERS=signer-1\n');
  const ev = path.join(S, '.studio', 'events-285c.jsonl');
  fs.mkdirSync(path.dirname(ev), { recursive: true }); fs.writeFileSync(ev, '');
  g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio, owner key, beta on', '--no-verify');
  const env = { ...process.env, ...base, AGENT_EVENTS_FILE: ev, STUDIO_MAIN_ROOT: S };
  const cli = (actor, args) => spawnSync(process.execPath, args, { windowsHide: true, cwd: S, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 120000, env: { ...env, ...actor } });
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(S, rel)).href);
  let pn = 0;
  const probe = (code, extra = {}) => {
    const f = path.join(S, `.probe-285c-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = cli(extra, [f]);
    try { fs.rmSync(f, { force: true }); } catch { /* left for the sweep */ }
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return { ...JSON.parse(l), _out: out(r).slice(-1200) }; } catch { return { _raw: out(r).slice(-2500) }; }
  };
  const OVER = { CLAUDECODE: '1', STUDIO_LOCK_OWNER: 'overseer-1' }; // the beta-mode named agent
  const ASKER = { STUDIO_LOCK_OWNER: 'builder-c1' };
  const askAs = (q, extra = []) => (out(cli(ASKER, ['harness/ask.mjs', q, '--by', 'builder-c1', ...extra])).match(/\b(A-\d+)\b/) || [])[1];
  const doc = (id) => readJson(path.join(S, 'studio', 'asks', `${id}.json`));

  // ---- 2. a question with a price in it is an ordinary ask ----
  {
    const q = 'Is 8 dollars a ride right?';
    const id = askAs(q, ['--options', 'yes,no', '--default', 'no', '--why', 'the lower one is the safer start']);
    const d0 = doc(id);
    const a = cli(OVER, ['harness/ask.mjs', 'answer', id, 'yes', '--by', 'overseer-1']);
    const d = doc(id);
    const H = 3600000;
    await guard('2.85 (c) a question with a price in it is an ordinary ask: "Is 8 dollars a ride right?" is not owner-only (harness/owner-acts.mjs), gets the ordinary STUDIO_ASK_TIMEOUT_H deadline from its default, and the beta-mode agent (overseer-1) answers it, recorded as its answer (fails before this change: it was owner-only, had no deadline and the stand-in was refused)', () => [
      oa.ownerOnlyTopic(q) === null && !d0?.ownerOnly && d0?.protected === false && Date.parse(d0?.deadline) - Date.parse(d0?.at) === 4 * H && a.status === 0 && d?.status === 'answered' && d?.recordedBy === 'overseer-1',
      JSON.stringify({ d0, d, a: tail(a, 400) })]);
  }

  // ---- 3. every ask resolves (injected clock) ----
  {
    const T0 = Date.parse('2026-11-13T00:00:00.000Z');
    const H = 3600000;
    const r = probe(`import fs from 'node:fs';
import path from 'node:path';
const m = await import(${u('harness/ask.mjs')});
fs.rmSync(path.join(process.cwd(), 'studio', 'asks'), { recursive: true, force: true });
const T0 = ${T0}; const H = ${H};
const evs = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const withDef = m.ask({ question: 'Which panel first, the gates or the shops?', options: ['gates', 'shops'], def: 'gates', why: 'the gates panel teaches the flow', by: 'builder-t1', now: T0 }).ask;
const noDef = m.ask({ question: 'Which colour for the gates panel?', options: ['blue', 'green'], by: 'builder-t1', now: T0 }).ask;
const owner = m.ask({ question: 'Should the build bot get its own access token?', options: ['yes', 'no'], def: 'no', why: 'safe', by: 'builder-t1', now: T0 }).ask;
const short = m.ask({ question: 'Which dock name style?', options: ['a', 'b'], def: 'a', by: 'builder-t1', now: T0, env: { STUDIO_ASK_TIMEOUT_H: '1' } }).ask;
// An ask made before 2.85: a default and no deadline at all.
fs.writeFileSync(path.join(m.ASKS_DIR, 'A-005.json'), JSON.stringify({ id: 'A-005', question: 'Old: which sign colour?', options: ['red', 'blue'], default: 'red', why: 'old', by: 'builder-t1', at: new Date(T0).toISOString(), deadline: null, protected: false, status: 'open' }));
const at3 = m.expireAsks(T0 + 3 * H);
const at4 = m.expireAsks(T0 + 4 * H + 1000);
const at7 = evs().filter((e) => e.type === 'ask.stale').length;
m.expireAsks(T0 + 7 * H);
const st7 = evs().filter((e) => e.type === 'ask.stale').length;
m.expireAsks(T0 + 8 * H + 1000);
m.expireAsks(T0 + 9 * H);
m.expireAsks(T0 + 100 * H);
const stale = evs().filter((e) => e.type === 'ask.stale');
const doc = (id) => JSON.parse(fs.readFileSync(path.join(m.ASKS_DIR, id + '.json'), 'utf8'));
const log = fs.readFileSync(path.join(process.cwd(), 'studio', 'decisions', 'decided-without-you.md'), 'utf8');
const timeouts = evs().filter((e) => e.type === 'decision.timeout').map((e) => ({ ask: e.meta?.ask, from: e.meta?.deadlineFrom || null }));
console.log(JSON.stringify({ withDef: { deadline: withDef.deadline, from: withDef.deadlineFrom }, short: short.deadline, noDef: noDef.deadline, owner: { deadline: owner.deadline, ownerOnly: owner.ownerOnly }, at3, at4, at7, st7, stale: stale.map((e) => ({ ask: e.meta?.ask, cmd: e.meta?.cmd, to: e.to, overseer: e.meta?.overseer })),
  s: { withDef: doc(withDef.id).status, noDef: doc(noDef.id).status, owner: doc(owner.id).status, old: doc('A-005').status, short: doc(short.id).status }, ans: doc(withDef.id).answer, inLog: [withDef.id, 'A-005'].every((x) => log.includes('## ' + x)), timeouts, ids: { withDef: withDef.id, noDef: noDef.id, owner: owner.id, short: short.id } }));`);
    const j = r;
    await guard('2.85 (c) every ask resolves: an ask with a --default and no --timeout gets STUDIO_ASK_TIMEOUT_H (4 h by default; 1 h when set), and at the deadline its default applies as an explicit timeout does (decision.timeout, studio/decisions/decided-without-you.md), not before; an ask made before 2.85 with a default and no deadline expires 4 h after it was asked (fails before this fix: it stayed open for good)', () => [
      j.withDef?.deadline === new Date(T0 + 4 * H).toISOString() && j.withDef.from === 'STUDIO_ASK_TIMEOUT_H' && j.short === new Date(T0 + H).toISOString()
        && Array.isArray(j.at3) && !j.at3.includes(j.ids.withDef) && j.at4.includes(j.ids.withDef) && j.at4.includes('A-005') && j.s.withDef === 'decided' && j.ans === 'gates' && j.s.old === 'decided' && j.inLog
        && j.timeouts.some((t) => t.ask === j.ids.withDef && t.from === null) && j.timeouts.some((t) => t.ask === 'A-005' && t.from === 'STUDIO_ASK_TIMEOUT_H'),
      JSON.stringify(j)]);
    await guard('2.85 (c) every ask resolves: an ask with no default is never answered by itself; at STUDIO_ASK_STALE_H (8 h) it is escalated once (ask.stale to the Producer, for the overseer, with the one command that answers it), not at 7 h and not again at 9 h or 100 h (fails before this fix: nothing ever said it was waiting)', () => [
      j.noDef === null && j.s?.noDef === 'open' && j.at7 === 0 && j.st7 === 0 && j.stale.length === 1 && j.stale[0].ask === j.ids.noDef && j.stale[0].to === 'producer' && j.stale[0].overseer === true && new RegExp(`npm run ask -- answer ${j.ids.noDef} `).test(j.stale[0].cmd || ''),
      JSON.stringify(j)]);
    await guard('2.85 (c) every ask resolves, the owner\'s own (guard): an owner-only ask (keys: "should the build bot get its own access token?") gets no deadline from its default, is never decided by a timer and never escalated as stale, even 100 h later', () => [
      j.owner?.deadline === null && j.owner.ownerOnly === 'credentials' && j.s?.owner === 'open' && !j.stale.some((e) => e.ask === j.ids.owner) && !j.timeouts.some((t) => t.ask === j.ids.owner), JSON.stringify(j)]);
    // The deadline check runs with no person: the watcher's pass calls expireAsks and the supervisor's timed passes run it.
    const watch = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8');
    const passes = fs.readFileSync(path.join(dir, 'harness', 'studio-passes.mjs'), 'utf8');
    // `list --open` shows the age of an open ask.
    write(S, 'studio/asks/A-099.json', JSON.stringify({ id: 'A-099', question: 'Which shade of grey?', options: [], default: null, why: '', by: 'builder-t1', at: new Date(Date.now() - 9 * H - 60000).toISOString(), deadline: null, protected: false, status: 'open' }));
    const list = cli({}, ['harness/ask.mjs', 'list', '--open']);
    await guard('2.85 (c) every ask resolves: `npm run ask -- list --open` shows each open ask\'s age and marks the owner\'s own as waiting for the owner; the deadline check runs with no person (the watcher\'s pass calls expireAsks, run from the supervisor\'s timed passes) (fails before this fix: no age shown)', () => [
      /A-099 \[open\] Which shade of grey\? \(open 9 h\)/.test(out(list)) && /waiting for the owner/.test(out(list)) && /expireAsks\(now\)/.test(watch) && /watchPass/.test(passes), tail(list, 900)]);
  }

  // ---- 4. the refresh check decides by rule ----
  {
    const r = probe(`import fs from 'node:fs';
const m = await import(${u('harness/session-cap.mjs')});
const line = (i, ctx, cmd) => JSON.stringify({ type: 'assistant', message: { id: 'm' + i, usage: { input_tokens: 10, cache_read_input_tokens: ctx, cache_creation_input_tokens: 0 }, content: cmd ? [{ type: 'tool_use', name: 'Bash', input: { command: cmd } }] : [] } });
const log = (n, ctx, workAt = -1) => Array.from({ length: n }, (_, i) => line(i, i === n - 1 ? ctx : 1000, i === workAt ? 'git -c core.autocrlf=false commit -qm "T-1: panel"' : null)).join('\\n');
const evs = () => fs.readFileSync(process.env.AGENT_EVENTS_FILE, 'utf8').split('\\n').filter(Boolean).map((l) => JSON.parse(l));
const run = (agent, l, model, env = {}) => { const h = m.heartbeatCheck(agent, { log: l, model, task: 'T-1', role: 'builder', env: { ...process.env, ...env } }); const f = m.readFlag(agent); return { decided: h.decided || null, checks: (f.checks || []).map((c) => ({ by: c.by, decision: c.decision })), endedBy: f.endedBy || null, asks: evs().filter((e) => e.type === 'agent.ask' && e.msg.includes('Check ' + agent + ':')).length, dec: evs().filter((e) => e.type === 'agent.refresh.decided' && e.agent === agent).map((e) => e.meta) }; };
const under = run('rule-under', log(61, 100000, 50), 'claude-opus-5-5');
const over = run('rule-over', log(61, 138110, 50), 'claude-opus-5-5');
const idle = run('rule-idle', log(61, 50000), 'claude-opus-5-5');
const unknown = run('rule-unknown', log(61, 138110, 55), 'some-new-model');
const asked = run('ask-mode', log(61, 138110, 50), 'claude-opus-5-5', { STUDIO_REFRESH_DECIDE: 'ask' });
console.log(JSON.stringify({ under, over, idle, unknown, asked }));`);
    const j = r;
    await guard('2.85 (c) refresh, by rule: a session past its check point under STUDIO_REFRESH_HANDOFF_PCT (100k of a 200k window, a commit 11 turns ago) continues, recorded as a check by "rule" with agent.refresh.decided (decision, why, turns, tokens, pct) and no ask raised; with an unknown model the window is twice the refresh point (138k of 240k: continue) (fails before this fix: every check point raised a "Continue or hand off" ask to the Producer)', () => [
      j.under?.decided?.decision === 'continue' && j.under.asks === 0 && j.under.checks.length === 1 && j.under.checks[0].by === 'rule' && j.under.checks[0].decision === 'continue' && !j.under.endedBy
        && j.under.dec.length === 1 && j.under.dec[0].decision === 'continue' && j.under.dec[0].turns === 61 && j.under.dec[0].tokens === 100010 && j.under.dec[0].pct === 50 && typeof j.under.dec[0].why === 'string'
        && j.unknown?.decided?.decision === 'continue' && j.unknown.dec[0]?.window === 240000 && j.unknown.asks === 0,
      JSON.stringify(j).slice(0, 3000)]);
    await guard('2.85 (c) refresh, by rule: over 60 % of the model\'s window (138k of 200k) the session hands off, and with no commit and no verify in 61 turns (STUDIO_REFRESH_IDLE_TURNS 40) it hands off too: each recorded as a hand-off check by "rule" with endedBy set (the launcher ends it as a refresh), no ask (fails before this fix: a card waited for a person, 4 of 45 never answered)', () => [
      j.over?.decided?.decision === 'handoff' && /60 %/.test(j.over.decided.why) && j.over.asks === 0 && j.over.checks[0]?.by === 'rule' && j.over.checks[0].decision === 'handoff' && /by the rule/.test(j.over.endedBy || '')
        && j.idle?.decided?.decision === 'handoff' && /no commit and no verify/.test(j.idle.decided.why) && j.idle.asks === 0 && j.idle.endedBy,
      JSON.stringify(j).slice(0, 3000)]);
    await guard('2.85 (c) refresh, ask mode (guard): with STUDIO_REFRESH_DECIDE=ask the check point raises the "Continue or hand off" ask as before and decides nothing itself', () => [
      j.asked?.asks === 1 && !j.asked.decided && j.asked.checks.length === 0 && j.asked.dec.length === 0 && !j.asked.endedBy, JSON.stringify(j.asked)]);
    const agent = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8');
    await guard('2.85 (c) refresh, by rule: the launcher ends a session the rule handed off as a refresh (kind "refresh"), as a person\'s `session -- check <agent> handoff` would', () => [
      /progress\?\.decided\?\.decision === 'handoff'[\s\S]{0,200}kind: 'refresh'[\s\S]{0,120}stopChild\(child\)/.test(agent), 'agent.mjs does not act on progress.decided']);
  }
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch { /* the sweep removes it */ }
}

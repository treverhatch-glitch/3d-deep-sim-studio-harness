/**
 * qa/selftest-259e.mjs — 2.59.0, from the crew's final brief of 2026-11-01 (items #15, #14, #8):
 *   #15 `npm run studio:resume -- --by <name> [--why …]` clears a halted supervisor the way the War Room's "Fixed it: try
 *       again" does (no hub token), records who and why (supervisor.resumed meta.by), refuses agents' names and launched
 *       sessions, and does nothing when the supervisor isn't halted. STUDIO_RESUME_BY (off by default) narrows who may.
 *   #14 STUDIO_KEYMAP_<ROLE> / STUDIO_KEYMAP_AGENT_<NAME> give one launched child a key under another name (agent beats
 *       role); names are logged, values never (log, events, session record, kickoff); names that aren't key names are
 *       refused, a pasted key is never echoed, and a mapping set inside a launched session (not in .env) is refused.
 *   #8  the launcher no longer holds a too-broad lane (a game's folder or source root, lock.mjs tooBroad) as a 6-hour
 *       session lock: in a lane copy it starts without that lock; in the main checkout it refuses and says how to
 *       narrow the lane, unless a person kept that lane wide (task add --lane … --wide "<why>" --by <name>).
 * The launches use a stand-in agent (a node script given as STUDIO_BUILDER_CMD) that records booleans and lock keys,
 * never a key's value. The made-up key values below are looked for where they must not be.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const FAKE_LANE_KEY = 'fake-lane-key-for-selftest-259e';
const FAKE_AGENT_KEY = 'fake-agent-key-for-selftest-259e';
const FAKE_MAIN_KEY = 'fake-main-key-for-selftest-259e';
const FAKE_HUB = 'fake-hub-token-for-selftest-259e-xxxxxxxx';
const FAKE_PASTED = 'sk-ant-fake-pasted-key-259e';
const QUIET = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_HEARTBEAT_SEC: '1', STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_MAIN_ROOT: '', STUDIO_BUILDER_CMD: '', STUDIO_AGENT_CMD: '', STUDIO_REHEARSAL: '', STUDIO_TOOL_CLAUDE_CMD: '', STUDIO_LANELESS: '', STUDIO_WORKTREES: '', STUDIO_AGENT_ENV: '', STUDIO_RESUME_BY: '', STUDIO_KEYMAP_BUILDER: '', STUDIO_KEYMAP_AGENT_KM_1: '', ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY_LANE: '', STUDIO_AGENT_TOOL: '', STUDIO_BUILDER_TOOL: '' };

export async function selftest259E({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (root, p) => JSON.stringify(pathToFileURL(path.join(root, p)).href);
  let n = 0;
  const probe = (root, code, env = {}) => {
    const f = path.join(root, `.probe-259e-${n++}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(root, `node ${path.basename(f)}`, { ...QUIET, ...env });
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _raw: out(r).slice(-800) }; } catch { return { _raw: out(r).slice(-1500) }; }
  };
  const guard = (name, fn) => { try { const [ok, detail] = fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };

  // ---------- #15: studio:resume ----------
  {
    const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
    const script = pkg.scripts?.['studio:resume'] || '';
    // Old code has no resume subcommand: `supervisor.mjs resume` would START a supervisor, so it is never run there.
    const has = /supervisor\.mjs resume/.test(script);
    const r = has ? probe(dir, `import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { STATUS_FILE, supervise } from ${u(dir, 'harness/supervisor.mjs')};
import { selfIdentity } from ${u(dir, 'harness/proc-identity.mjs')};
import { readRecentEvents } from ${u(dir, 'harness/event.mjs')};
const WHY = 'two sessions in a row ended with exit 127 (r-1, r-2): tool-x wasn\\'t found';
const RESUME = path.join('.studio', 'supervisor-resume');
const status = (halted) => fs.writeFileSync(STATUS_FILE, JSON.stringify({ pid: process.pid, identity: selfIdentity(), status: 'running', startedAt: new Date().toISOString(), ...(halted ? { halted: { at: new Date().toISOString(), code: 127, why: WHY } } : {}) }));
const cli = (args, env = {}) => { const x = spawnSync(process.execPath, ['harness/supervisor.mjs', 'resume', ...args], { encoding: 'utf8', env: { ...process.env, ...env } }); return { code: x.status, text: (x.stdout || '') + (x.stderr || ''), file: fs.existsSync(RESUME) }; };
const asked = () => readRecentEvents(5000).filter((e) => e.type === 'supervisor.resume_asked').length;
fs.mkdirSync('.studio', { recursive: true });
fs.writeFileSync(path.join('.studio', 'agent-names.json'), JSON.stringify({ 'api-': 3 }));
const out = {};
status(false);
out.notHalted = { ...cli(['--by', 'hatch']), asked: asked() };
status(true);
out.agent = cli(['--by', 'builder-s7']);
out.counter = cli(['--by', 'api-2']);
out.bot = cli(['--by', 'opus-bot']);
out.session = cli(['--by', 'hatch'], { STUDIO_ROLE: 'builder' });
out.allow = cli(['--by', 'sam'], { STUDIO_RESUME_BY: 'hatch' });
out.refusedAsked = asked();
out.person = cli(['--by', 'hatch', '--why', 'put tool-x on the PATH'], { STUDIO_RESUME_BY: 'Hatch,sam' });
const state = { startedAt: Date.now() - 60000, names: [], halted: { at: new Date().toISOString(), code: 127, why: WHY } };
const pass = await supervise({ dryRun: true }, state);
out.passWhy = pass.why;
out.stateHalted = state.halted;
out.fileAfter = fs.existsSync(RESUME);
const ev = readRecentEvents(5000);
out.askedEv = ev.filter((e) => e.type === 'supervisor.resume_asked').pop() || null;
out.resumed = ev.filter((e) => e.type === 'supervisor.resumed').pop() || null;
console.log(JSON.stringify(out));`, { STUDIO_AGENT_TOOL: '', STUDIO_WATCHDOG_LAUNCH: 'off' }) : null;
    guard('#15: npm run studio:resume -- --by hatch --why "…" on a halted supervisor writes the resume file (no hub token), prints what it cleared (the halt reason), and the next supervisor pass starts again with a supervisor.resumed event naming who (meta.by) and why', () => [
      has && r.person?.code === 0 && /Cleared the halt \(two sessions in a row ended with exit 127/.test(r.person.text) && r.person.file === true && r.askedEv?.meta?.by === 'hatch' && r.askedEv.meta.via === 'cli'
        && r.resumed?.meta?.by === 'hatch' && r.resumed.meta.why === 'put tool-x on the PATH' && /exit 127/.test(r.resumed.meta.cleared || '') && r.stateHalted === null && r.fileAfter === false && !(r.passWhy || []).some((w) => /^halted/.test(w)),
      has ? JSON.stringify({ person: r.person, askedEv: r.askedEv, resumed: r.resumed, passWhy: r.passWhy, raw: r._raw }).slice(0, 2500) : `package.json has no studio:resume script (${script || 'none'})`]);
    guard('#15: agents\' names are refused (builder-s7; api-2, a name the launcher hands out per .studio/agent-names.json; opus-bot): exit 1, nothing written, no event', () => [
      has && [r.agent, r.counter, r.bot].every((x) => x?.code === 1 && /is an agent's name/.test(x.text) && x.file === false) && r.refusedAsked === 0,
      has ? JSON.stringify({ agent: r.agent, counter: r.counter, bot: r.bot, refusedAsked: r.refusedAsked }) : 'no studio:resume script']);
    guard('#15: inside a launched session (STUDIO_ROLE set by the launcher) it refuses even a person\'s name: exit 1, nothing written', () => [
      has && r.session?.code === 1 && /inside a launched builder session/.test(r.session.text) && r.session.file === false,
      has ? JSON.stringify(r.session) : 'no studio:resume script']);
    guard('#15: not halted: "Not halted", exit 0, nothing written, no event', () => [
      has && r.notHalted?.code === 0 && /^Not halted/.test(r.notHalted.text) && r.notHalted.file === false && r.notHalted.asked === 0,
      has ? JSON.stringify(r.notHalted) : 'no studio:resume script']);
    guard('#15: STUDIO_RESUME_BY (off by default) narrows who may resume: a name outside it is refused, one inside it (any letter case) works', () => [
      has && r.allow?.code === 1 && /isn't in STUDIO_RESUME_BY/.test(r.allow.text) && r.allow.file === false && r.person?.code === 0,
      has ? JSON.stringify({ allow: r.allow, person: r.person?.code }) : 'no studio:resume script']);
  }

  // ---------- #14: the owner's key mapping ----------
  {
    const k = probe(dir, `import fs from 'node:fs';
import { agentEnv } from ${u(dir, 'harness/agent-env.mjs')};
const base = { PATH: process.env.PATH, ANTHROPIC_API_KEY: ${JSON.stringify(FAKE_MAIN_KEY)}, ANTHROPIC_API_KEY_LANE: ${JSON.stringify(FAKE_LANE_KEY)}, ANTHROPIC_API_KEY_AGENT: ${JSON.stringify(FAKE_AGENT_KEY)}, HUB_TOKEN: ${JSON.stringify(FAKE_HUB)} };
const run = (extra, more = {}) => { const notes = []; const e = agentEnv({ tool: 'claude', role: 'builder', agent: 'km-7', env: { ...base, ...extra }, notes, ...more }); return { e, notes }; };
const beat = run({ STUDIO_KEYMAP_BUILDER: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE,CLAUDE_API_KEY:ANTHROPIC_API_KEY_LANE', STUDIO_KEYMAP_AGENT_KM_7: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_AGENT' });
const other = run({ STUDIO_KEYMAP_BUILDER: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE', STUDIO_KEYMAP_AGENT_KM_7: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_AGENT' }, { agent: 'km-8' });
const bad = run({ STUDIO_KEYMAP_BUILDER: 'PATH:ANTHROPIC_API_KEY_LANE,ANTHROPIC_API_KEY:HUB_TOKEN,STUDIO_OWNER_KEY:ANTHROPIC_API_KEY_LANE,' + ${JSON.stringify(FAKE_PASTED)} + ',X_TOKEN:' + ${JSON.stringify(FAKE_PASTED.replace(/-/g, '_').toUpperCase())} });
const unset = run({ STUDIO_KEYMAP_BUILDER: 'ANTHROPIC_API_KEY:MISSING_API_KEY' });
// An agent hiring an agent: a mapping in its shell, not in .env, is refused; the same mapping in .env counts.
fs.rmSync('.env', { force: true });
const shell = run({ STUDIO_ROLE: 'producer', STUDIO_KEYMAP_BUILDER: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE' });
fs.writeFileSync('.env', 'STUDIO_KEYMAP_BUILDER=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE\\n');
const fromEnv = run({ STUDIO_ROLE: 'producer', STUDIO_KEYMAP_BUILDER: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE' });
fs.rmSync('.env', { force: true });
const v = (x) => ({ a: x.e.ANTHROPIC_API_KEY === ${JSON.stringify(FAKE_AGENT_KEY)} ? 'agent' : x.e.ANTHROPIC_API_KEY === ${JSON.stringify(FAKE_LANE_KEY)} ? 'lane' : x.e.ANTHROPIC_API_KEY === ${JSON.stringify(FAKE_MAIN_KEY)} ? 'main' : x.e.ANTHROPIC_API_KEY === undefined ? 'unset' : 'other', c: x.e.CLAUDE_API_KEY === ${JSON.stringify(FAKE_LANE_KEY)}, map: Object.keys(x.e).filter((k) => /KEYMAP/.test(k)).length, path: x.e.PATH === process.env.PATH, owner: 'STUDIO_OWNER_KEY' in x.e, hub: Object.values(x.e).includes(${JSON.stringify(FAKE_HUB)}), notes: x.notes });
console.log(JSON.stringify({ beat: v(beat), other: v(other), bad: v(bad), unset: v(unset), shell: v(shell), fromEnv: v(fromEnv) }));`);
    const notesText = JSON.stringify(k);
    guard('#14: agent beats role: STUDIO_KEYMAP_AGENT_KM_7 wins for ANTHROPIC_API_KEY over STUDIO_KEYMAP_BUILDER, the role\'s other target still applies, another builder gets the role\'s; the STUDIO_KEYMAP_ settings never reach the child', () => [
      k.beat?.a === 'agent' && k.beat.c === true && k.beat.map === 0 && k.other?.a === 'lane' && k.other.map === 0 && k.beat.notes.some((x) => /STUDIO_KEYMAP_AGENT_KM_7: ANTHROPIC_API_KEY gets the value of ANTHROPIC_API_KEY_AGENT/.test(x)),
      notesText.slice(0, 2000)]);
    guard('#14: names outside the key allow-list are refused and said in the notes (PATH, HUB_TOKEN, STUDIO_OWNER_KEY), the child keeps its own key, no HUB_TOKEN value reaches it, a pasted key in the setting is never echoed; a source that isn\'t set leaves the target unset (not the shared key)', () => [
      k.bad?.a === 'main' && k.bad.path && !k.bad.owner && !k.bad.hub && k.bad.notes.filter((x) => /refused/.test(x)).length === 5 && k.bad.notes.some((x) => /PATH isn't a key name/.test(x)) && k.bad.notes.some((x) => /HUB_TOKEN isn't a key name/.test(x)) && k.bad.notes.some((x) => /STUDIO_OWNER_KEY isn't a key name/.test(x))
        && !notesText.includes(FAKE_PASTED) && !notesText.includes(FAKE_PASTED.replace(/-/g, '_').toUpperCase()) && !notesText.includes(FAKE_LANE_KEY) && !notesText.includes(FAKE_HUB) && k.unset?.a === 'unset' && k.unset.notes.some((x) => /MISSING_API_KEY is not set/.test(x)),
      notesText.slice(0, 2500)]);
    guard('#14: inside a launched session a mapping set in its shell is refused (the child keeps its own key); the same mapping written in the studio\'s .env applies', () => [
      k.shell?.a === 'main' && k.shell.notes.some((x) => /refused, this runs inside a launched producer session/.test(x)) && k.fromEnv?.a === 'lane',
      notesText.slice(0, 2000)]);

    // End to end through the launcher: a custom command (credentials by prefix: none), so ANTHROPIC_API_KEY can only
    // come from the mapping. The stand-in records booleans, never the value.
    const rec = path.join(tmpRoot, 'rec-259e');
    fs.mkdirSync(rec, { recursive: true });
    const fake = path.join(tmpRoot, 'fake-agent-259e.cjs');
    fs.writeFileSync(fake, `const fs = require('fs'); const path = require('path');
const e = process.env;
let locks = [];
try { const d = path.join(e.STUDIO_MAIN_ROOT || process.cwd(), '.studio', 'locks'); locks = fs.readdirSync(d).filter((f) => f.endsWith('.lock')).map((f) => { try { return JSON.parse(fs.readFileSync(path.join(d, f), 'utf8')); } catch { return null; } }).filter((l) => l && l.owner === e.STUDIO_LOCK_OWNER).map((l) => l.key); } catch {}
fs.writeFileSync(path.join(${JSON.stringify(rec)}, (e.STUDIO_LOCK_OWNER || 'x') + '.json'), JSON.stringify({ cwd: process.cwd(), mainRoot: e.STUDIO_MAIN_ROOT || null, keyIsLane: e.ANTHROPIC_API_KEY === ${JSON.stringify(FAKE_LANE_KEY)}, keySet: Boolean(e.ANTHROPIC_API_KEY), keymapVars: Object.keys(e).filter((k) => /KEYMAP/.test(k)).length, locks }));
`);
    const recOf = (agent) => { try { return JSON.parse(fs.readFileSync(path.join(rec, `${agent}.json`), 'utf8')); } catch { return null; } };
    const id = (run(dir, 'node harness/task.mjs add "Keymap probe" --role builder --priority P1', QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
    const s = run(dir, `node harness/agent.mjs start --role builder --agent km-1 --task ${id} --tool claude --model m-1`, { ...QUIET, STUDIO_WORKTREES: 'off', STUDIO_BUILDER_CMD: `node "${fake}" {agent}`, ANTHROPIC_API_KEY: '', ANTHROPIC_API_KEY_LANE: FAKE_LANE_KEY, STUDIO_KEYMAP_BUILDER: 'ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE' });
    const r = recOf('km-1');
    const log = readText(path.join(dir, '.studio', 'agents', 'km-1.log'));
    const where = { log, events: readText(path.join(dir, '.studio', 'events.jsonl')), record: readText(path.join(dir, '.studio', 'agents', 'km-1.json')), kickoff: readText(path.join(dir, '.studio', 'kickoff', 'km-1.md')), stdout: out(s) };
    const leaks = Object.entries(where).filter(([, t]) => t.includes(FAKE_LANE_KEY)).map(([w]) => w);
    guard('#14 end to end: agent start with STUDIO_KEYMAP_BUILDER=ANTHROPIC_API_KEY:ANTHROPIC_API_KEY_LANE: the child gets the lane key as ANTHROPIC_API_KEY, the log names the mapping, and the value is in none of the log, events, session record, kickoff or the command\'s output', () => [
      s.status === 0 && r?.keyIsLane === true && r.keymapVars === 0 && /\[launcher\] key map STUDIO_KEYMAP_BUILDER: ANTHROPIC_API_KEY gets the value of ANTHROPIC_API_KEY_LANE \(value not shown\)/.test(log) && where.events.includes('"type":"agent.keymap"') && leaks.length === 0 && where.record.length > 0 && where.events.length > 0,
      `record: ${JSON.stringify(r)} leaks in: ${JSON.stringify(leaks)}\n${out(s).slice(-600)}\nlog: ${log.slice(0, 600)}`]);
  }

  // ---------- #8: the launcher's own lane claims ----------
  {
    const repo = path.join(tmpRoot, 'repo-259e');
    fs.cpSync(dir, repo, { recursive: true, filter: (src) => !/[\\/](node_modules|\.git|\.studio)$/.test(src) });
    try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(repo, 'node_modules'), 'junction'); } catch {}
    fs.mkdirSync(path.join(repo, 'game', 'demo', 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'game', 'demo', 'src', 'a.js'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(repo, 'game', 'demo', 'src', 'b.js'), 'export const b = 2;\n');
    const g = (cmd) => run(repo, `git -c user.email=t@t -c user.name=t ${cmd}`);
    g('init -q -b main');
    g('add -A');
    g('commit -qm base');
    const support = run(repo, `node -e "import('./harness/worktree.mjs').then(m=>console.log(JSON.stringify(m.worktreeSupport())))"`);
    const lanesOk = /"ok":true/.test(support.stdout);
    const fake = path.join(tmpRoot, 'fake-agent-259e.cjs');
    const recOf = (agent) => { try { return JSON.parse(fs.readFileSync(path.join(tmpRoot, 'rec-259e', `${agent}.json`), 'utf8')); } catch { return null; } };
    const add = (title, extra = '') => (run(repo, `node harness/task.mjs add "${title}" --role builder --priority P1 ${extra}`, QUIET).stdout.match(/"id": "(T-\d+)"/) || [])[1];
    const start = (agent, id, lane, env = {}) => run(repo, `node harness/agent.mjs start --role builder --agent ${agent} --task ${id} --lane ${lane} --tool claude --model m-1`, { ...QUIET, STUDIO_BUILDER_CMD: `node "${fake}" {agent}`, ...env });
    const evs = () => readText(path.join(repo, '.studio', 'events.jsonl')).split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return {}; } });
    const real = (p) => { try { return fs.realpathSync.native(p); } catch { return path.resolve(p); } };

    if (!lanesOk) report('#8: lane-copy checks skipped, this machine can\'t make lane copies (git 2.42+ needed)', true, support.stdout);
    else {
      const t1 = add('Broad lane in a copy', '--lane game/demo/src');
      g('add -A');
      g('commit -qm board');
      const s = start('lb-1', t1, 'game/demo/src');
      const r = recOf('lb-1');
      const ev = evs().filter((e) => e.agent === 'lb-1');
      guard('#8: in a lane copy, a too-broad lane (game/demo/src, a game\'s source root) is not held as a session lock, the session still starts there, and a lane.unlocked event says why (evidence: builder-s51 held path:<game>/src for an hour and other lanes\' commits were refused)', () => [
        s.status === 0 && r && real(r.cwd) === real(path.join(repo, '.lanes', 'lb-1')) && !r.locks.some((k) => /^path:game\/demo\/src$/.test(k)) && ev.some((e) => e.type === 'agent.session.start') && ev.some((e) => e.type === 'lane.unlocked' && /game\/demo\/src/.test(e.msg || '')),
        `record: ${JSON.stringify(r)}\n${out(s).slice(-600)}`]);
      const t2 = add('Narrow lane in a copy', '--lane game/demo/src/a.js');
      g('add -A');
      g('commit -qm board2');
      const s2 = start('ln-1', t2, 'game/demo/src/a.js');
      const r2 = recOf('ln-1');
      guard('#8: a narrow lane (one file) is still claimed for the session in its copy, as before (passes on 2.58.5 too: no regression)', () => [
        s2.status === 0 && r2 && real(r2.cwd) === real(path.join(repo, '.lanes', 'ln-1')) && r2.locks.includes('path:game/demo/src/a.js'),
        `record: ${JSON.stringify(r2)}\n${out(s2).slice(-600)}`]);
    }
    // The main checkout (no lane copies).
    const off = { STUDIO_WORKTREES: 'off' };
    const t3 = add('Broad lane in the main checkout', '--lane game/demo/src');
    const s3 = start('lm-1', t3, 'game/demo/src', off);
    const r3 = recOf('lm-1');
    const left = fs.existsSync(path.join(repo, '.studio', 'locks')) ? fs.readdirSync(path.join(repo, '.studio', 'locks')).filter((f) => f.endsWith('.lock')).map((f) => readText(path.join(repo, '.studio', 'locks', f))).filter((t) => t.includes('"lm-1"')) : [];
    guard('#8: in the main checkout a too-broad lane is refused before anything starts: exit 1, it says how to narrow it (npm run task -- lane <ID> …) and how a person keeps it wide, no lock is left, a launch.skipped event goes to a person', () => [
      s3.status === 1 && !r3 && new RegExp(`too broad to hold for a whole session in the main checkout.*npm run task -- lane ${t3} `).test(out(s3)) && /--wide "<why>" --by <you>/.test(out(s3)) && left.length === 0 && evs().some((e) => e.type === 'launch.skipped' && e.task === t3 && e.to === 'human'),
      `exit ${s3.status} record ${JSON.stringify(r3)} locks ${JSON.stringify(left)}\n${out(s3).slice(-800)}`]);
    const t4 = add('Wide on purpose', '--lane game/demo/src --wide "one refactor over the whole tree" --by hatch');
    const s4 = start('lw-1', t4, 'game/demo/src', off);
    const r4 = recOf('lw-1');
    const t5 = add('Wide by an agent', '--lane game/demo/src --wide "I want it all" --by builder-s9');
    const s5 = start('lw-2', t5, 'game/demo/src', off);
    const r5 = recOf('lw-2');
    const t6 = add('Narrow in the main checkout', '--lane game/demo/src/b.js');
    const s6 = start('ln-2', t6, 'game/demo/src/b.js', off);
    const r6 = recOf('ln-2');
    guard('#8: a lane a person kept wide (task add --lane game/demo/src --wide "<why>" --by hatch) still starts in the main checkout and holds it; the same --wide from an agent\'s name is refused; a narrow lane there is claimed as before', () => [
      s4.status === 0 && r4?.locks.includes('path:game/demo/src') && s5.status === 1 && !r5 && /too broad/.test(out(s5)) && s6.status === 0 && r6?.locks.includes('path:game/demo/src/b.js'),
      `wide-person ${s4.status} ${JSON.stringify(r4)}\nwide-agent ${s5.status} ${JSON.stringify(r5)} ${out(s5).slice(-300)}\nnarrow ${s6.status} ${JSON.stringify(r6)}`]);
    try { fs.rmSync(repo, { recursive: true, force: true, maxRetries: 5, retryDelay: 300 }); } catch {}
  }
}

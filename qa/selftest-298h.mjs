/**
 * qa/selftest-298h.mjs — 2.98 (h): a session's record (.studio/agents/<name>.json) is never seen half-written.
 * Every write goes through one writer (a temp file renamed over the record), a record that exists but won't read counts
 * as a session that is there (its name is busy, not free), and two patches of different fields both stay.
 * The probe runs in a copy of the repo and hooks fs, so the "between truncate and write" moment is hit on purpose.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, guardCap3000Of, out } from './kit.mjs';

const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap((e) => (e.isDirectory() ? walk(path.join(d, e.name)) : e.name.endsWith('.mjs') ? [path.join(d, e.name)] : []));

export async function selftest298H({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const evFile = path.join(tmpRoot, `events-298h-${process.pid}.jsonl`);
  const env = { ...clean, AGENT_EVENTS_FILE: evFile, STUDIO_WATCHDOG: 'off', STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-298h-${process.pid}.pem`), CI: '', NODE_OPTIONS: '' };
  const probeFile = path.join(dir, `.probe-298h-${process.pid}.mjs`);

  try {
    // ---- h1: the source has no plain write of a session record ----
    const plain = walk(path.join(dir, 'harness')).filter((f) => /writeFileSync\(\s*sessionFile/.test(fs.readFileSync(f, 'utf8'))).map((f) => path.relative(dir, f));
    await guard('2.98 (h1) no harness file writes a session record with a plain writeFileSync (fails before this fix: a plain write cut the file open for a moment, in 9 places)', () => [plain.length === 0, plain.join(', ')]);

    fs.writeFileSync(probeFile, `
import fs from 'node:fs';
import path from 'node:path';
const A = await import(${fileUrlRelSOf(dir)('harness/agent.mjs')});
const agent = 'probe-298h';
const file = path.join(A.AGENTS_DIR, agent + '.json');
const startedAt = new Date().toISOString();
fs.mkdirSync(A.AGENTS_DIR, { recursive: true });
fs.writeFileSync(file, JSON.stringify({ agent, role: 'builder', tool: 'x', model: 'm', status: 'running', pid: process.pid, supervisor: process.pid, startedAt, lastBeat: startedAt }));
const here = () => A.sessions().some((s) => s.agent === agent);
let looks = 0, absent = 0;
const look = () => { looks++; if (!here()) absent++; };
// The moment a plain write leaves the file empty, and the moment before a rename: a reader looks at both.
const write = fs.writeFileSync, rename = fs.renameSync;
fs.writeFileSync = function (f, ...rest) { if (path.resolve(String(f)) === file) { write.call(fs, f, ''); look(); } return write.call(fs, f, ...rest); };
fs.renameSync = function (a, b) { if (path.resolve(String(b)) === file) look(); return rename.call(fs, a, b); };
for (let i = 0; i < 200; i++) A.sayNow(agent, 'step ' + i);
fs.writeFileSync = write; fs.renameSync = rename;
const rec = JSON.parse(fs.readFileSync(file, 'utf8'));
const afterWrites = { looks, absent, now: rec.now };
// A cut record, and a name with no record at all.
fs.writeFileSync(path.join(A.AGENTS_DIR, 'cut-298h.json'), '{"agent":"cut-298h","status":"run');
const cut = A.sessions().find((s) => s.agent === 'cut-298h');
const gone = A.sessions().some((s) => s.agent === 'gone-298h');
// Two patches of different fields close together.
A.sayNow(agent, 'patched');
A.recordStop({ agent, startedAt }, 'tester');
const both = JSON.parse(fs.readFileSync(file, 'utf8'));
fs.rmSync(path.join(A.AGENTS_DIR, 'cut-298h.json'), { force: true });
fs.rmSync(file, { force: true });
console.log(JSON.stringify({ afterWrites, cut: cut ? { running: cut.running, status: cut.status } : null, gone, both: { now: both.now, stop: both.stopRequested?.by } }));
`);
    const r = spawnSync(process.execPath, [probeFile], { windowsHide: true, cwd: dir, env, encoding: 'utf8', timeout: 120000 });
    const line = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    let p = {};
    try { p = JSON.parse(line); } catch { p = { _raw: out(r).slice(-2000) }; }
    const w = p.afterWrites || {};
    await guard('2.98 (h2) while a writer rewrites a record 200 times, a reader looking at every write never misses the session (fails before this fix: it was absent at every plain write)', () => [w.looks >= 200 && w.absent === 0 && w.now === 'step 199', JSON.stringify(p)]);
    await guard('2.98 (h3) a record that exists but will not read is a running session, so its name is busy; a name with no record is free (fails before this fix: the cut record was absent and its name free)', () => [p.cut?.running === true && p.cut?.status === 'running' && p.gone === false, JSON.stringify(p)]);
    await guard('2.98 (h4) two patches of different fields close together both stay in the record (fails before this fix: nothing, it held before too; it guards the new patch helper)', () => [p.both?.now === 'patched' && p.both?.stop === 'tester', JSON.stringify(p)]);
  } finally {
    try { fs.rmSync(probeFile, { force: true }); } catch { /* the sweep */ }
    try { fs.rmSync(evFile, { force: true }); } catch { /* the sweep */ }
  }
}

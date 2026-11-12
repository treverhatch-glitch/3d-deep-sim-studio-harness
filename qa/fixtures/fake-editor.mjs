#!/usr/bin/env node
/**
 * qa/fixtures/fake-editor.mjs — 2.84 (s): a stand-in for a Unity editor started with -studioService <folder>, speaking
 * the editor service's file protocol (harness/editor-service.mjs), for qa/selftest-284s.mjs. Not a model of Unity:
 * only of the protocol.
 *
 * It holds <project>/Temp/UnityLockfile while it runs (and leaves it when it dies, as a crashed editor does), writes
 * heartbeat.json every -studioHeartbeatSec, answers one request at a time and appends its pid to
 * <project>/.fake-editor-starts. Its control file <project>/.fake-editor.json (read on each request):
 *   compileErrors  [{ file, line, code, message }] a compile answers with (also: a compile-error.txt in the project
 *                  gives one error "Assets/Broken.cs(3): CS0103 <its text>", so a branch can carry it)
 *   hangOnce       a kind: the next such request is never answered (the editor stays busy); cleared when used
 *   dieOnce        a kind: the editor exits on the next such request; cleared when used
 *   dieOnStart     exit right after taking the lock, before any heartbeat (while set)
 *   ignoreQuit     answer quit but keep running
 */
import fs from 'node:fs';
import path from 'node:path';

const argv = process.argv.slice(2);
const arg = (n) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : null; };
const project = path.resolve(arg('-projectPath') || '.');
const folder = arg('-studioService');
const beat = Math.max(0.05, Number(arg('-studioHeartbeatSec')) || 0.2) * 1000;
const logFile = arg('-logFile');
const ctlFile = path.join(project, '.fake-editor.json');
const ctl = () => { try { return JSON.parse(fs.readFileSync(ctlFile, 'utf8')); } catch { return {}; } };
const setCtl = (patch) => fs.writeFileSync(ctlFile, JSON.stringify({ ...ctl(), ...patch }));
const log = (m) => { if (logFile) try { fs.appendFileSync(logFile, `${m}\n`); } catch {} };
const atomic = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); const t = `${f}.${process.pid}.tmp`; fs.writeFileSync(t, JSON.stringify(v)); fs.renameSync(t, f); };

const lock = path.join(project, 'Temp', 'UnityLockfile');
fs.mkdirSync(path.dirname(lock), { recursive: true });
fs.writeFileSync(lock, String(process.pid));
fs.appendFileSync(path.join(project, '.fake-editor-starts'), `${process.pid}\n`);
log(`fake editor ${process.pid} on ${project}`);
if (!folder) process.exit(0); // a person's editor: no service
if (ctl().dieOnStart) process.exit(1);

let busy = null;
let hung = false;
const heartbeat = () => atomic(path.join(folder, 'heartbeat.json'), { pid: process.pid, at: Date.now(), busy, unityVersion: 'fake-6000.3', domainReloads: 0 });
heartbeat();
setInterval(heartbeat, beat);
// A tiny valid PNG (1x1, RGBA).
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');

function answer(req, resp) {
  atomic(path.join(folder, 'responses', `${req.id}.json`), { id: req.id, kind: req.kind, ms: 5, errors: [], ...resp });
  try { fs.rmSync(path.join(folder, 'requests', `${req.id}.json`), { force: true }); } catch {}
  busy = null;
  heartbeat();
}

function handle(req) {
  const c = ctl();
  if (c.dieOnce === req.kind) { setCtl({ dieOnce: null }); process.exit(1); }
  if (c.hangOnce === req.kind) { setCtl({ hangOnce: null }); hung = true; busy = req.id; heartbeat(); return; }
  busy = req.id;
  if (req.kind === 'compile') {
    const errors = Array.isArray(c.compileErrors) ? c.compileErrors.slice() : [];
    const ce = path.join(project, 'compile-error.txt');
    if (fs.existsSync(ce)) errors.push({ file: path.join(project, 'Assets', 'Broken.cs'), line: 3, code: 'CS0103', message: fs.readFileSync(ce, 'utf8').trim() });
    return answer(req, { ok: errors.length === 0, errors });
  }
  if (req.kind === 'test') {
    fs.mkdirSync(path.dirname(req.resultsPath), { recursive: true });
    fs.writeFileSync(req.resultsPath, `<?xml version="1.0"?>\n<test-run result="Passed" total="1" passed="1" failed="0"><test-case id="1" name="Works" fullname="Game.Rules.Tests.Works" result="Passed"/></test-run>\n`);
    return answer(req, { ok: true, results: req.resultsPath });
  }
  if (req.kind === 'capture') {
    fs.mkdirSync(path.dirname(req.out), { recursive: true });
    fs.writeFileSync(req.out, PNG);
    return answer(req, { ok: true, images: [req.out] });
  }
  if (req.kind === 'quit') {
    answer(req, { ok: true });
    if (!c.ignoreQuit) { try { fs.rmSync(lock, { force: true }); } catch {} process.exit(0); }
    return undefined;
  }
  return answer(req, { ok: true, why: req.kind === 'ping' ? 'fake-6000.3' : undefined });
}

setInterval(() => {
  if (hung) {
    // A hung editor still answers nothing but quit is not read either: only a kill ends it.
    return;
  }
  let names = [];
  try { names = fs.readdirSync(path.join(folder, 'requests')).filter((n) => n.endsWith('.json') && !n.startsWith('.')).sort(); } catch { return; }
  for (const n of names) {
    let req = null;
    try { req = JSON.parse(fs.readFileSync(path.join(folder, 'requests', n), 'utf8')); } catch { continue; }
    handle(req);
    if (hung) return;
  }
}, 50);

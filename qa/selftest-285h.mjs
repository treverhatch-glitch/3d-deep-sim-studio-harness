/**
 * qa/selftest-285h.mjs — 2.85 (h): less that nobody uses.
 *
 *   settings  a STUDIO_* name documented or used in a test that no production code reads fails the docs check
 *             (scripts/settings-map.mjs unreadNames, docs/settings-runtime.json lists the run-time families); the
 *             two names nothing read are gone
 *   events    (a crew's log: hotspot.overlap, task.overlap and watch.report were an eighth of all events)
 *   decider   (who may decide: the callers' answers pinned)
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest285H({ dir, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const write = (b, rel, text) => { fs.mkdirSync(path.dirname(path.join(b, rel)), { recursive: true }); fs.writeFileSync(path.join(b, rel), text); };
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 3000)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 3000)); } };
  const T = path.join(tmpRoot, `s285h-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const imp = (rel) => import(pathToFileURL(path.join(dir, rel)).href);

  // ================= 1. settings nothing reads =================
  // Invented names are spelled @NAME@ here and become the real name when written, so this file adds none to the settings scan.
  const nm = (t) => String(t).replace(/@([A-Z0-9_]+)@/g, 'STUDIO_$1');
  {
    const sm = await imp('scripts/settings-map.mjs');
    let n = 0;
    // A small studio: one production file that reads @LIVE_ONE@ and builds STUDIO_<ROLE>_CMD, docs, a test.
    const mini = ({ doc = '', test = '', runtime }) => {
      const R = path.join(T, `mini-${++n}`);
      write(R, 'harness/a.mjs', nm("// @ONLY_COMMENT@ is named here only\nexport const r = (e, role) => [e.@LIVE_ONE@, e[`STUDIO_${role.toUpperCase()}_CMD`]];\n"));
      write(R, 'docs/A.md', nm(`# A\n\`@LIVE_ONE@\` does a thing (default off).\n${doc}\n`));
      write(R, 'qa/selftest-x.mjs', nm(`const env = { @LIVE_ONE@: '1'${test} };\n`));
      write(R, 'docs/settings-runtime.json', nm(JSON.stringify(runtime || { families: [{ pattern: '^STUDIO_(BUILDER|QA)_CMD$', template: 'STUDIO_\\$\\{role\\.toUpperCase\\(\\)\\}_CMD' }], testOwned: [] })));
      write(R, 'docs/settings-baseline.json', JSON.stringify({ undocumented: [] }));
      return R;
    };
    const unread = (R) => sm.unreadNames(R).unread.map((u) => u.name);
    await guard('settings: a name only a doc mentions, and one only a test sets, fail the check; fails before this change: nothing asked whether a name is read', async () => {
      const R = mini({ doc: '`@DOC_ONLY@` was once a switch.', test: ", @TEST_ONLY@: '1'" });
      const u = unread(R);
      const c = sm.checkSettings(R);
      return [u.includes(nm('@DOC_ONLY@')) && u.includes(nm('@TEST_ONLY@')) && !c.ok && sm.checkLines(c).join('\n').includes(nm('@DOC_ONLY@')), JSON.stringify({ u, ok: c.ok })];
    });
    await guard('settings: a name production code reads and a run-time family pass; a name only in a comment does not', async () => {
      const R = mini({ doc: '`@ONLY_COMMENT@` is a setting. `@QA_CMD@` is the QA command.', test: ", @BUILDER_CMD@: 'x'" });
      const u = unread(R);
      return [!u.includes(nm('@LIVE_ONE@')) && !u.includes(nm('@QA_CMD@')) && !u.includes(nm('@BUILDER_CMD@')) && u.includes(nm('@ONLY_COMMENT@')), JSON.stringify(u)];
    });
    await guard('settings: a name outside every family is not hidden by one (a sound-designer command against a BUILDER|QA family)', async () => {
      const R = mini({ doc: '`@SOUND_CMD@` runs it.' });
      return [unread(R).includes(nm('@SOUND_CMD@')), JSON.stringify(unread(R))];
    });
    await guard('settings: a family whose builder is gone from production code is stale and fails; a test-owned name passes', async () => {
      const R = mini({ test: ", @MADE_UP@: '1'", runtime: { families: [{ pattern: '^@GONE@_[A-Z]+$', template: '@GONE@_\\$\\{' }], testOwned: [{ name: nm('@MADE_UP@'), why: 'a fixture' }] } });
      const r = sm.unreadNames(R);
      const c = sm.checkSettings(R);
      return [r.staleFamilies.length === 1 && !c.ok && !r.unread.some((x) => x.name === nm('@MADE_UP@')) && sm.checkLines(c).join('\n').includes('builder is gone'), JSON.stringify(r)];
    });
    await guard('settings: the docs check passes on this studio, and the two names nothing read (the old Planning Room switch, the engine VFX capture command) are gone from docs, code and tests', async () => {
      const r = spawnSync(process.execPath, ['scripts/check-docs.mjs'], { windowsHide: true, cwd: dir, encoding: 'utf8' });
      const gone = [nm('@PLANNING_ROOM@'), nm('@VFX_CAPTURE_CMD@')];
      const left = spawnSync(process.execPath, ['-e', `const {scanCode,scanDocs}=await import('./scripts/settings-map.mjs');const c=scanCode('.'),d=scanDocs('.');console.log(${JSON.stringify(gone)}.filter((x)=>c.has(x)||d.has(x)).join(','))`], { windowsHide: true, cwd: dir, encoding: 'utf8' });
      return [r.status === 0 && /\[docs\] PASS/.test(out(r)) && !String(left.stdout).trim(), out(r).slice(-1200) + String(left.stdout)];
    });
  }

  // ================= 2. events nobody acts on =================
  // Evidence (the crew's 2.84 window, 2598 events): the three types are read (retro counts watch.report and reads its words;
  // plan-waves and the next board need one hotspot.overlap / task.overlap per fact), so they stay. hotspot.overlap and
  // task.overlap are already written once per fact (emit-seen.json); watch.report kept ONE slot for every text, so two
  // findings taking turns were each "new" every pass.
  {
    const wt = await imp('harness/watch.mjs');
    const seenFile = path.join(dir, '.studio', 'emit-seen.json');
    const fresh = () => { try { fs.rmSync(seenFile, { force: true }); } catch { /* none */ } };
    const MIN = 60000;
    const t0 = Date.parse('2026-11-01T10:00:00Z');
    const run = (texts) => { const got = []; for (const [text, min, env] of texts) wt.recordReport(text, { now: t0 + min * MIN, emit: (e) => got.push(e.msg), env: { ...process.env, STUDIO_TELEMETRY: '', ...(env || {}) } }); return got; };
    await guard('events: the same watch.report text again within the hour (only its numbers changed) is written once; fails before this fix: one record per pass of two alternating texts', async () => {
      fresh();
      const got = run([['T-1 is held: parked 3 times', 0], ['T-1 is held: parked 4 times', 5], ['T-1 is held: parked 5 times', 12]]);
      return [got.length === 1, JSON.stringify(got)];
    });
    await guard('events: two findings taking turns (A, B, A, B inside the hour) are written once each, not four times', async () => {
      fresh();
      const A = 'T-1 is held: parked by watchdog'; const B = 'T-2 is held: queued for the train';
      const got = run([[A, 0], [B, 5], [A, 10], [B, 15], [A, 20]]);
      return [got.length === 2 && got[0] === A && got[1] === B, JSON.stringify(got)];
    });
    await guard('events: a changed watch.report text is written, and the same text again after the hour is written again', async () => {
      fresh();
      const got = run([['one finding', 0], ['another finding', 1], ['one finding', 61]]);
      return [got.length === 3, JSON.stringify(got)];
    });
    await guard('events: STUDIO_EVENT_REPEAT_MIN sets how long a text is not written again (5 minutes: written again at 6)', async () => {
      fresh();
      const env = { STUDIO_EVENT_REPEAT_MIN: '5' };
      const got = run([['standing', 0, env], ['standing', 4, env], ['standing', 6, env]]);
      return [got.length === 2, JSON.stringify(got)];
    });
    await guard('events: watch.mjs writes the standing report through recordReport, never straight to the log', async () => {
      const src = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8').replace(/\r\n/g, '\n');
      return [/recordReport\(wmsg\)/.test(src) && !/emitEvent\(\{ type: 'watch\.report'/.test(src), 'watch.mjs'];
    });
    fresh();
  }

  // ================= 3. who decides =================
  // harness/decider.mjs (deciderCheck) is kept, not folded into permission.mjs: it is built from permission.mjs's parts
  // (DECIDER_ROLES, WORKER_NAME, agentOnPermission, permissionText, standInMay) and adds the --by and --permission rules and
  // the owner's delegation that mayDecide (a tier question: board or protected) does not ask. These checks pin its answers
  // for each caller (the callers in flakes, crew-watch, supervisor, policy-rules, janitor, decisions-log, winddown, audit,
  // train-daemon all ask it), and show mayDecide would answer differently for an agent shell with no permission.
  {
    const crypto = await import('node:crypto'); void crypto;
    const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
    const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'core.autocrlf=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', env: gEnv() });
    const S = path.join(tmpRoot, `285h-studio-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', '.env', 'studio/beta.json', 'studio/delegation.json', 'studio/approvals', 'studio/task-holds.json', 'studio/mode.json', 'studio/policy.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    write(S, 'studio/beta.json', `${JSON.stringify({ on: true, by: 'pat', at: '2026-11-05T01:00:00.000Z', why: 'beta for the selftest', agents: ['overseer-1'], roles: ['producer', 'director'] }, null, 2)}\n`);
    write(S, '.gitignore', '/.lanes/\n/.studio/\n.env\n');
    write(S, '.env', 'STUDIO_OUTSIDE_SIGNERS=signer-1\n');
    g(S, 'init', '-q', '-b', 'main'); g(S, 'add', '-A'); g(S, 'commit', '-qm', 'studio with beta mode on', '--no-verify');
    const clean = {};
    for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
    const baseEnv = { ...process.env, ...clean, ...ident, STUDIO_OWNER_KEY: path.join(tmpRoot, `no-owner-key-285h-${process.pid}.pem`), STUDIO_MAIN_ROOT: S, CLAUDECODE: '', AI_AGENT: '' };
    const asked = (args, env = {}) => {
      const f = path.join(S, '.probe-285h.mjs');
      fs.writeFileSync(f, `import { deciderCheck } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'decider.mjs')).href)};
const r = await deciderCheck(${JSON.stringify(args)});
console.log(JSON.stringify({ ok: r.ok, via: r.via || null, recordedBy: r.recordedBy || null, by: r.by || null, why: r.why || null }));`);
      const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: S, env: { ...baseEnv, ...env }, encoding: 'utf8', timeout: 120000 });
      try { fs.rmSync(f, { force: true }); } catch { /* swept later */ }
      const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
      try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-800) }; }
    };
    const PERM = 'the owner said yes in chat at 10:02';
    const pin = (name, got, want) => guard(`decider: ${name}`, async () => [Object.keys(want).every((k) => (k === 'why' ? new RegExp(want.why).test(got.why || '') : got[k] === want[k])), JSON.stringify(got)]);
    await pin('the owner in their own terminal (no agent marker): allowed, as a person', asked({ by: 'alex' }), { ok: true, via: 'person', recordedBy: 'alex' });
    await pin('the owner\'s terminal where --by names an agent: refused', asked({ by: 'builder-2' }), { ok: false, why: 'worker agent' });
    await pin('no --by: refused ("Say who decides")', asked({ by: '' }), { ok: false, why: 'Say who decides' });
    await pin('a launched Producer session on a person\'s permission: allowed, via producer', asked({ by: 'alex', permission: PERM }, { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' }), { ok: true, via: 'producer', recordedBy: 'producer-s1' });
    await pin('a launched Producer session with no permission while beta mode is on: allowed, via producer (beta mode\'s words stand in for the permission)', asked({ by: 'alex' }, { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' }), { ok: true, via: 'producer' });
    await pin('a launched builder (a worker) with a permission: refused', asked({ by: 'alex', permission: PERM }, { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' }), { ok: false, why: 'launched builder session' });
    await pin('a worker\'s name in the lock owner outside a launched session: refused, with or without permission', asked({ by: 'alex', permission: PERM }, { STUDIO_LOCK_OWNER: 'qa-playtester-s2' }), { ok: false, why: 'worker agent' });
    await pin('an agent outside the harness (a coding agent\'s shell) on a person\'s permission: allowed, via outside agent', asked({ by: 'alex', permission: PERM }, { CLAUDECODE: '1' }), { ok: true, via: 'outside agent' });
    await pin('an agent outside the harness with no permission: refused', asked({ by: 'alex' }, { CLAUDECODE: '1' }), { ok: false, why: 'direct permission' });
    await pin('an agent outside the harness whose --by is an agent\'s name: refused', asked({ by: 'builder-2', permission: PERM }, { CLAUDECODE: '1' }), { ok: false, why: 'worker agent' });
    await pin('the beta-mode overseer (beta agent) with a stand-in kind and no permission: allowed, via beta agent', asked({ by: 'overseer-1', standIn: 'crew-resume' }), { ok: true, via: 'beta agent', recordedBy: 'overseer-1' });
    await pin('an outside signer with a stand-in kind and no permission: allowed, via signer', asked({ by: 'signer-1', standIn: 'crew-resume' }), { ok: true, via: 'signer', recordedBy: 'signer-1' });
    await pin('a stranger with a stand-in kind and no permission, in an agent\'s shell: refused', asked({ by: 'stranger-9', standIn: 'crew-resume' }, { CLAUDECODE: '1' }), { ok: false, why: 'direct permission' });
    await pin('a launched Producer session is no beta stand-in (STUDIO_ROLE set): its answer comes from the producer rule, not the stand-in one', asked({ by: 'overseer-1', standIn: 'crew-resume' }, { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' }), { ok: true, via: 'producer', recordedBy: 'producer-s1' });
    write(S, 'studio/beta.json', `${JSON.stringify({ on: false, by: 'pat', at: '2026-11-06T01:00:00.000Z', why: 'over', agents: [], roles: [] }, null, 2)}\n`);
    g(S, 'add', '-A'); g(S, 'commit', '-qm', 'beta off', '--no-verify');
    await pin('beta mode off: a launched Producer session with no permission is refused', asked({ by: 'alex' }, { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s1' }), { ok: false, why: 'direct permission' });
    await pin('beta mode off: the overseer with a stand-in kind and no permission, in an agent\'s shell, is refused', asked({ by: 'overseer-1', standIn: 'crew-resume' }, { CLAUDECODE: '1' }), { ok: false, why: 'direct permission' });
    await guard('decider: it cannot be replaced by mayDecide: for an agent shell with no permission mayDecide says yes (tier outside) and deciderCheck says no', async () => {
      const perm = await imp('harness/permission.mjs');
      const md = perm.mayDecide('hold', { tier: 'outside' }, { root: S });
      const dc = asked({ by: 'alex' }, { CLAUDECODE: '1' });
      return [md.ok === true && dc.ok === false, JSON.stringify({ md, dc })];
    });
  }
}

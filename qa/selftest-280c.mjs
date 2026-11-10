/**
 * qa/selftest-280c.mjs — 2.80 (c): the fixes the trim can't deliver (part c).
 *
 * N1 (P0): a stale .studio/machine.json (the supervisor off > 15 min) made machineProfile() null, the game check fell back
 * to 2 test workers and blew the gate timeout: a train of 3 good lanes ran 35 min and landed nothing. The profile is now
 * scanned inline when the stored one is missing or stale.
 *
 * Patch #24 / R3-14 (P1): a lock whose owner's session had ended could be taken by nobody until it expired (a P0 "fix
 * main" waited an hour), and `lock release <key> --owner X` from the orchestrator was refused by its STUDIO_LOCK_OWNER.
 *
 * Patch #14 / R3-7 (P1): a manual wind-down ("everything off") still started API-pool and Vertex builders; a usage
 * wind-down outlived removing STUDIO_USAGE_WINDDOWN_PCT; an agent's `winddown --now` had no end only a person could --off.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest280C({ dir, report, tmpRoot }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  let n = 0;
  const scratch = (tag) => { const d = path.join(tmpRoot || dir, `st-280c-${tag}-${process.pid}-${++n}`); fs.mkdirSync(path.join(d, '.studio'), { recursive: true }); return d; };

  // ---- N1: a missing or stale machine scan is taken again inline ----
  {
    const hb = await import(u('harness/heavy-budget.mjs'));
    await guard('2.80 (c) N1: machineProfile() scans the machine when .studio/machine.json is 3 h old or missing (and writes it for the next caller), so a game check gets its RAM-sized workers, not "no machine scan: 2"; STUDIO_MACHINE_SCAN=off, STUDIO_TEST_MACHINE=none and an injected machine: null still give null (fails on 2.79.2: a stale or missing scan gave null and 2 workers)', () => {
      const env = { STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: '', STUDIO_MACHINE_MAX_AGE_MIN: '' };
      const stale = scratch('stale');
      const file = path.join(stale, '.studio', 'machine.json');
      const oldAt = new Date(Date.now() - 3 * 3600000).toISOString();
      fs.writeFileSync(file, JSON.stringify({ at: oldAt, os: 'linux', cores: { logical: 8 }, ram: { totalGb: 32, freeGb: 20 }, cpu: { busy: 0.1 } }));
      const t0 = Date.now();
      const p = hb.machineProfile(stale, { env });
      const ms = Date.now() - t0;
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      const missing = scratch('missing');
      const pm = hb.machineProfile(missing, { env });
      const again = hb.machineProfile(missing, { env });
      const tw = hb.testWorkers({ profile: p, env: { ...env, STUDIO_TEST_WORKERS: '' }, root: stale });
      const offs = [hb.machineProfile(stale, { env: { ...env, STUDIO_MACHINE_SCAN: 'off' } }), hb.machineProfile(stale, { env: { ...env, STUDIO_TEST_MACHINE: 'none' } }), hb.machineProfile(stale, { env, machine: null })];
      const ok = p && Date.parse(p.at) >= t0 - 1000 && written.at !== oldAt && pm && fs.existsSync(path.join(missing, '.studio', 'machine.json')) && again?.at === pm.at
        && !/no machine scan/.test(tw.why) && offs.every((x) => x === null) && ms < 20000;
      return [ok, JSON.stringify({ at: p?.at, written: written.at, pm: pm?.at, again: again?.at, tw, offs, ms })];
    });
  }

  // A scratch studio holding a copy of harness/: its CLIs run with a clean env (no agent markers, no STUDIO_*).
  const clean = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^(STUDIO_|CLAUDECODE$|AI_AGENT$|CODEX_SANDBOX$|GEMINI_CLI$|AGENT_EVENTS_FILE$)/.test(k)));
  const studio = (tag) => {
    const S = scratch(tag);
    fs.cpSync(path.join(dir, 'harness'), path.join(S, 'harness'), { recursive: true });
    fs.copyFileSync(path.join(dir, 'package.json'), path.join(S, 'package.json'));
    const events = path.join(S, '.studio', `events-280c-${tag}.jsonl`);
    const node = (args, env = {}) => {
      const r = spawnSync(process.execPath, args, { cwd: S, encoding: 'utf8', windowsHide: true, env: { ...clean, AGENT_EVENTS_FILE: events, STUDIO_MAIN_ROOT: S, ...env } });
      let j = null; try { j = JSON.parse(r.stdout); } catch {}
      return { status: r.status, j, out: `${r.stdout}${r.stderr}`.replace(/\r\n/g, '\n').slice(-800) };
    };
    return { S, events, node };
  };

  // ---- Patch #24: sessionless locks and lock release --owner ----
  {
    const { S, events, node } = studio('locks');
    const lock = (args, env = {}) => node([path.join(S, 'harness', 'lock.mjs'), ...args], env);
    const as = (who, role = '') => ({ STUDIO_LOCK_OWNER: who, STUDIO_ROLE: role });
    lock(['claim', 'task:T-801', '--owner', 'builder-gone'], as('builder-gone', 'builder'));
    lock(['claim', 'path:game/sys/a.js', '--owner', 'builder-gone'], as('builder-gone', 'builder'));
    lock(['claim', 'task:T-802', '--owner', 'opus-1'], as('opus-1'));
    fs.mkdirSync(path.join(S, '.studio', 'agents'), { recursive: true });
    fs.writeFileSync(path.join(S, '.studio', 'agents', 'builder-gone.json'), JSON.stringify({ name: 'builder-gone', role: 'builder', status: 'ended', endedAt: new Date(Date.now() + 1000).toISOString() }));
    await guard('2.80 (c) #24: a task or path lock whose owner\'s session has ended counts as expired for a taker ("took over an expired lock of builder-gone (no live session)", a lock.taken_over event); a lock of an owner with no session record (the orchestrator) is still refused (fails on 2.79.2: claimed until it expired)', () => {
      const t = lock(['claim', 'task:T-801', '--owner', 'builder-new'], as('builder-new', 'builder'));
      const p = lock(['claim', 'path:game/sys/a.js', '--owner', 'builder-new'], as('builder-new', 'builder'));
      const keep = lock(['claim', 'task:T-802', '--owner', 'builder-new'], as('builder-new', 'builder'));
      let ev = ''; try { ev = fs.readFileSync(events, 'utf8'); } catch {}
      const ok = t.status === 0 && /took over an expired lock of builder-gone \(no live session\)/.test(t.j?.message || '') && t.j?.lock?.owner === 'builder-new'
        && p.status === 0 && /took over an expired lock of builder-gone/.test(p.j?.message || '') && keep.status === 1 && keep.j?.lock?.owner === 'opus-1'
        && (ev.match(/"lock\.taken_over"/g) || []).length === 2;
      return [ok, JSON.stringify({ t, p, keep, ev: ev.slice(-600) })];
    });
    lock(['claim', 'task:T-803', '--owner', 'hatch'], as('hatch'));
    lock(['claim', 'task:T-804', '--owner', 'hatch'], as('hatch'));
    await guard('2.80 (c) #24: `lock release <key> --owner hatch` from the orchestrator\'s shell (STUDIO_LOCK_OWNER=opus-1, not launched) releases hatch\'s lock; from a worker session it is refused, naming the rule (only a person, the orchestrator or a Producer/Director session) (fails on 2.79.2: the orchestrator was refused as "someone else (STUDIO_LOCK_OWNER=opus-1)")', () => {
      const orch = lock(['release', 'task:T-803', '--owner', 'hatch'], as('opus-1'));
      const worker = lock(['release', 'task:T-804', '--owner', 'hatch'], as('builder-new', 'builder'));
      const still = lock(['status', 'task:T-804']);
      const ok = orch.status === 0 && orch.j?.released === true && worker.status === 1 && /only a person, the orchestrator or a Producer\/Director session/.test(worker.j?.message || '')
        && JSON.stringify(still.j || {}).includes('hatch');
      return [ok, JSON.stringify({ orch, worker, still })];
    });
  }

  // ---- Patch #14 / R3-7: the wind-down ----
  {
    await guard('2.80 (c) #14: a manual wind-down ("everything off", winddown.json manual) returns before the API-pool / Vertex check, so it starts no paid builders; the usage wind-down keeps letting them through (fails on 2.79.2: the pass went on whenever apiPoolOn() or vertexReady.ok)', () => {
      const sup = fs.readFileSync(path.join(dir, 'harness', 'supervisor.mjs'), 'utf8').replace(/\r\n/g, '\n');
      const line = sup.split('\n').find((l) => /if \(wd\.active\)/.test(l)) || '';
      return [/wd\.state\?\.manual \|\| \(!apiPoolOn\(poolUsage\) && !vertexReady\.ok\)\) return \{ started: \[\]/.test(line), line.slice(0, 400) || 'no wd.active line'];
    });
    const { S, node } = studio('wd');
    const wdFile = path.join(S, '.studio', 'winddown.json');
    const cli = (args, env = {}) => node([path.join(S, 'harness', 'winddown.mjs'), ...args], env);
    const pass = (env, now) => node(['--input-type=module', '-e', `import { winddownPass } from ${JSON.stringify(pathToFileURL(path.join(S, 'harness', 'winddown.mjs')).href)}; console.log(JSON.stringify(winddownPass({ now: ${now}, env: process.env, rows: [{ tool: 'claude', pct: 0.95, weekly: true }] })));`], env);
    await guard('2.80 (c) #14: a usage wind-down that started at STUDIO_USAGE_WINDDOWN_PCT=90 ends on the next pass once the setting is removed (usage still 95%), and `studio:winddown` stops saying "Winding down" for it; with the setting still there it keeps going (fails on 2.79.2: it kept the threshold it started with)', () => {
      fs.writeFileSync(wdFile, JSON.stringify({ at: new Date(Date.now() - 600000).toISOString(), why: 'usage 95%', pct: 95, threshold: 90, tool: 'claude', resets: null, manual: false, by: null, until: null, file: '.studio/restart-log.md' }));
      const kept = pass({ STUDIO_USAGE_WINDDOWN_PCT: '90' }, Date.now());
      const said = cli([], {});
      const ended = pass({}, Date.now());
      const ok = kept.j?.active === true && /^Not winding down/.test(said.out) && ended.j?.resumed === true && !fs.existsSync(wdFile);
      return [ok, JSON.stringify({ kept, said, ended })];
    });
    await guard('2.80 (c) #14: an agent\'s `winddown --now` without --until is refused with the usage line; with --until <time> it winds down until then and the pass ends it by itself at that time; a person\'s --now needs no --until (fails on 2.79.2: an agent wound down with no end only a person could --off)', () => {
      fs.rmSync(wdFile, { force: true });
      const agent = { CLAUDECODE: '1' };
      const bare = cli(['--now', '--by', 'opus-1'], agent);
      const until = new Date(Date.now() + 3600000).toISOString();
      const timed = cli(['--now', '--by', 'opus-1', '--until', until], agent);
      const st = (() => { try { return JSON.parse(fs.readFileSync(wdFile, 'utf8')); } catch { return null; } })();
      const before = pass({}, Date.now() + 1800000);
      const after = pass({}, Date.now() + 3700000);
      const person = cli(['--now', '--by', 'hatch'], {});
      const ok = bare.status === 1 && /--until <time>/.test(bare.out) && timed.status === 0 && st?.manual === true && Date.parse(st.until) === Date.parse(until)
        && before.j?.active === true && after.j?.resumed === true && person.status === 0;
      return [ok, JSON.stringify({ bare, timed, st, before, after, person })];
    });
  }
}

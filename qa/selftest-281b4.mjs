/**
 * qa/selftest-281b4.mjs - 2.81 (b4), ported from the R2 trial (B5: P4, and the prompt-cap half of P7).
 *   P4  a session whose process is gone is ended by `task next` (not only the watch loop), its agent.session.end carries
 *       meta.endedAt (last heartbeat + STUDIO_GONE_GRACE_S, capped at the detection time) and meta.detectedAt (now);
 *       a second pass inside STUDIO_GONE_CHECK_S writes nothing; a live PID with the same old heartbeat is not ended.
 *   P7  a proxy launch whose assembled prompt files are over STUDIO_VERTEX_MAX_PROMPT_TOKENS is refused before the
 *       proxy starts (agent.start_refused {preflight}). The trial's no-task refusal is not ported: 2.80 (d, A2) has one.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest281B4({ dir, run, report, root }) {
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const state = path.join(dir, '.studio');
  const agentsDir = path.join(state, 'agents');
  const eventsFile = path.join(state, 'events.jsonl');
  const events = () => { try { return fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
  const ends = (agent) => events().filter((e) => e.type === 'agent.session.end' && e.agent === agent);
  fs.mkdirSync(agentsDir, { recursive: true });
  const threeHAgo = new Date(Date.now() - 3 * 3600 * 1000);
  const startedAt = new Date(threeHAgo.getTime() - 600000).toISOString();
  const record = (agent, pid) => fs.writeFileSync(path.join(agentsDir, `${agent}.json`), JSON.stringify({ agent, role: 'planner', tool: 'claude', model: 'm', status: 'running', pid, startedAt, lastBeat: threeHAgo.toISOString() }, null, 2));
  const env = { STUDIO_GONE_CHECK_S: '60', STUDIO_GONE_GRACE_S: '120' };

  // ---- P4: the dead one and the live one, one pass ----
  const live = spawn(process.execPath, ['-e', 'setTimeout(()=>{}, 20000)'], { windowsHide: true, stdio: 'ignore' });
  try {
    record('planner-dead', 999999);
    record('planner-live', live.pid);
    const t0 = Date.now();
    const r1 = run(dir, 'node harness/task.mjs next', env);
    const t1 = Date.now();
    const e1 = ends('planner-dead');
    await guard('P4 task next ends a session whose process is gone: one agent.session.end', () => [e1.length === 1, `${out(r1)}\n${JSON.stringify(e1)}`]);
    const m = e1[0]?.meta || {};
    const endedMs = Date.parse(m.endedAt || '');
    const wantMs = threeHAgo.getTime() + 120000;
    await guard('P4 meta.endedAt = last heartbeat + grace (not now)', () => [Math.abs(endedMs - wantMs) < 2000 && t1 - endedMs > 2 * 3600 * 1000, JSON.stringify(m)]);
    const detMs = Date.parse(m.detectedAt || '');
    await guard('P4 meta.detectedAt is about now and ts is kept as the detection time', () => [detMs >= t0 - 2000 && detMs <= t1 + 2000 && Math.abs(Date.parse(e1[0]?.ts || '') - detMs) < 5000, JSON.stringify({ m, ts: e1[0]?.ts })]);
    const rec = JSON.parse(fs.readFileSync(path.join(agentsDir, 'planner-dead.json'), 'utf8'));
    await guard('P4 the dead session record is marked ended', () => [rec.status === 'ended', JSON.stringify(rec)]);
    await guard('P4 a live PID with the same old heartbeat is not marked gone (liveness is PID + start time, not the beat)', () => [ends('planner-live').length === 0 && JSON.parse(fs.readFileSync(path.join(agentsDir, 'planner-live.json'), 'utf8')).status === 'running', JSON.stringify(ends('planner-live'))]);
    const stamp = (() => { try { return JSON.parse(fs.readFileSync(path.join(state, 'gone-check.json'), 'utf8')); } catch { return null; } })();
    await guard('P4 the pass is stamped in .studio/gone-check.json', () => [Boolean(stamp?.at), JSON.stringify(stamp)]);

    // a second dead session appears; a second next inside the interval must not run the pass
    record('planner-dead2', 999998);
    run(dir, 'node harness/task.mjs next', env);
    await guard('P4 a second next within STUDIO_GONE_CHECK_S writes no second end event (neither for the first nor a new one)', () => [ends('planner-dead').length === 1 && ends('planner-dead2').length === 0, JSON.stringify(events().filter((e) => e.type === 'agent.session.end'))]);
    // the interval over (stamp aged): the pass runs again and ends the new one
    fs.writeFileSync(path.join(state, 'gone-check.json'), JSON.stringify({ at: Date.now() - 120000 }));
    run(dir, 'node harness/task.mjs next', env);
    await guard('P4 after the interval the pass runs again; still one end event per session', () => [ends('planner-dead').length === 1 && ends('planner-dead2').length === 1, JSON.stringify(events().filter((e) => e.type === 'agent.session.end').map((e) => e.agent))]);
  } finally { try { live.kill(); } catch {} }

  // ---- P4: the session-hours readers prefer meta.endedAt (the death estimate) over the detection time ----
  {
    const t = (iso) => new Date(Date.parse('2026-11-01T00:00:00Z') + iso * 60000).toISOString();
    const evs = [
      { ts: t(0), type: 'agent.session.start', agent: 'p-1', model: 'm', task: 'T-9', meta: { tool: 'claude' } },
      { ts: t(1), type: 'task.start', agent: 'p-1', task: 'T-9' },
      { ts: t(600), type: 'agent.session.end', agent: 'p-1', model: 'm', task: 'T-9', status: 'error', meta: { reason: 'process gone', endedAt: t(12), detectedAt: t(600) } },
    ];
    // metrics closes an open attempt on its agent's session end when that end names no task (or another one): that path.
    const evsNoTask = evs.map((e) => (e.type === 'agent.session.end' ? { ...e, task: undefined } : e));
    const M = await import(pathToFileURL(path.join(dir, 'harness', 'metrics.mjs')).href);
    const P = await import(pathToFileURL(path.join(dir, 'harness', 'model-pools.mjs')).href);
    const att = M.buildAttempts(evsNoTask, { now: Date.parse(t(700)) }).find((a) => a.task === 'T-9');
    const row = P.buildOutcomes(evs, { cfg: P.DEFAULT_MODELS, now: Date.parse(t(700)) }).find((r) => r.agent === 'p-1');
    await guard('P4 metrics (attempt end) and model-pools (session end) use meta.endedAt, not the detection time (fails on 2.80: 10 h instead of 12 min)', () => [att?.end === Date.parse(t(12)) && row?.end === t(12), JSON.stringify({ end: att?.end, want: Date.parse(t(12)), row })]);
  }

  // ---- P7 (prompt cap only), end to end: refused before the proxy starts, nothing is sent ----
  const tid = (() => { try { return JSON.parse(run(dir, 'node harness/task.mjs add "Prompt cap probe" --role builder --lane cartridges/example-sim', {}).stdout).id; } catch { return null; } })();
  const before = events().length;
  const big = run(dir, `node harness/agent.mjs start --role builder --agent builder-cap1 --tool vertex --task ${tid} --attach`, { STUDIO_VERTEX_MAX_PROMPT_TOKENS: '5' });
  const evs = events().slice(before);
  const refused = evs.find((e) => e.type === 'agent.start_refused' && e.agent === 'builder-cap1' && e.meta?.preflight);
  await guard('P7 a vertex launch whose prompt files are over STUDIO_VERTEX_MAX_PROMPT_TOKENS is refused before the proxy starts: agent.start_refused {preflight} names the bytes and the cap (fails on 2.80: the proxy refused it after one billed request)', () => [Boolean(tid) && Boolean(refused) && refused.meta.promptBytes > 20 && refused.meta.cap === 5 && /over the prompt cap of 5/.test(refused.msg) && !/started the studio's Vertex proxy/.test(out(big)), `${big.status} ${out(big).slice(-1500)}\n${JSON.stringify(evs.map((e) => [e.type, e.msg]))}`]);
  const before2 = events().length;
  const small = run(dir, `node harness/agent.mjs start --role builder --agent builder-cap2 --tool vertex --task ${tid} --attach`, { STUDIO_VERTEX_MAX_PROMPT_TOKENS: '0' });
  await guard('P7 a cap of 0 (no cap) refuses nothing at the preflight', () => [!events().slice(before2).some((e) => e.type === 'agent.start_refused' && e.meta?.preflight), `${small.status} ${out(small).slice(-600)}`]);
  void root;
}

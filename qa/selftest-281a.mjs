/**
 * qa/selftest-281a.mjs — 2.81 (a): the round scorecard, the overseer's official role, engine first by default.
 *
 *   npm run score        fifteen fixed measures from a studio's logs (harness/score.mjs, docs/SCORECARD.md)
 *   npm run overseer     role | can <action> | pass (harness/overseer.mjs, docs/OVERSEER.md): a script's verdict from
 *                        the studio's own grants; lock release --owner for the owner's stand-ins
 *   engine first         a studio with exactly one engine gives it the push unless someone decided otherwise
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest281A({ dir, run, report, tmpRoot }) {
  const u = (rel, base = dir) => pathToFileURL(path.join(base, rel)).href;
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n/g, '\n');
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); } catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); } };
  const ident = { GIT_AUTHOR_NAME: 'Pat', GIT_AUTHOR_EMAIL: 'pat@example.invalid', GIT_COMMITTER_NAME: 'Pat', GIT_COMMITTER_EMAIL: 'pat@example.invalid' };
  const key = path.join(tmpRoot, `owner-281a-${process.pid}.pem`);
  const base = {
    ...ident, CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_ROLE: '', STUDIO_AGENT: '', STUDIO_LOCK_OWNER: '', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_WATCHDOG: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_HOOKS_CHECK: 'off', STUDIO_MACHINE_SCAN: 'off', NODE_OPTIONS: '', GITHUB_BASE_REF: '', AGENT_EVENTS_FILE: '',
  };
  const owner = { ...base, STUDIO_OWNER_KEY: key };
  const gEnv = () => { const e = { ...process.env, ...ident }; for (const k of Object.keys(e)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*|NO_REPLACE_OBJECTS)$/.test(k)) delete e[k]; return e; };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: gEnv(), windowsHide: true });
  const made = [];
  const studio = (name) => {
    const S = path.join(tmpRoot, `281a-${name}-${process.pid}`);
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    for (const x of ['.studio', 'studio/delegation.json', 'studio/approvals', 'studio/keys', 'studio/beta.json', 'studio/asks', 'studio/scores', 'studio/mode.json', 'studio/game.json']) fs.rmSync(path.join(S, x), { recursive: true, force: true });
    g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
    g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
    made.push(S);
    return S;
  };

  // ---- the round scorecard ----
  {
    const S = studio('score');
    const t0 = Date.parse('2026-03-02T00:00:00Z');
    const at = (min) => new Date(t0 + min * 60000).toISOString();
    const ev = (min, type, extra = {}) => ({ id: `e${min}-${type}`, ts: at(min), type, agent: 'harness', ...extra });
    const events = [
      ev(0, 'task.added', { task: 'T-1', agent: 'producer-1' }), ev(0, 'task.added', { task: 'T-2', agent: 'producer-1' }),
      ev(10, 'task.start', { task: 'T-1', agent: 'builder-s1' }), ev(10, 'task.start', { task: 'T-2', agent: 'builder-s2' }),
      ev(30, 'gates.run', { agent: 'builder-s1', meta: { ms: 600000, scoped: false, partial: false } }),
      ev(31, 'gates.run', { agent: 'builder-s2', meta: { ms: 60000, scoped: true, partial: true } }),
      ev(40, 'task.paused', { task: 'T-2', agent: 'builder-s2' }),
      ev(70, 'task.done', { task: 'T-1', agent: 'builder-s1', status: 'done' }),
      ev(120, 'task.start', { task: 'T-2', agent: 'builder-s3' }),
      ev(200, 'gates.run', { agent: 'builder-s3', meta: { ms: 600000, scoped: false, partial: false } }),
      ev(230, 'task.train.done', { agent: 'train', meta: { train: 'tr1', landed: ['T-1', 'T-2'], dropped: ['T-3'] } }),
      ev(240, 'task.done', { task: 'T-2', agent: 'builder-s3', status: 'done' }),
      ev(241, 'engine.land', { agent: 'line-producer', task: 'T-9', meta: { engine: 'unity', status: 'pass' } }),
      ev(242, 'engine.land', { agent: 'line-producer', task: 'T-8', meta: { engine: 'unity', status: 'red' } }),
      ev(243, 'session.stall', { agent: 'watchdog', task: 'T-2' }),
      ev(244, 'agent.session.end', { agent: 'builder-s3', meta: { role: 'builder', costUsd: 3, reason: 'finished' } }),
      ev(245, 'agent.session.end', { agent: 'producer-1', meta: { role: 'producer', costUsd: 1, reason: 'finished' } }),
    ];
    const evFile = path.join(S, 'crew-events.jsonl');
    fs.writeFileSync(evFile, `${events.map((e) => JSON.stringify(e)).join('\n')}\n`);
    const mFile = path.join(S, 'crew-machine.jsonl');
    fs.writeFileSync(mFile, `${[[5, 10], [50, 50], [100, 20], [200, 95]].map(([min, cpu]) => JSON.stringify({ at: at(min), cpu, ram: [8, 32] })).join('\n')}\n`);
    const first = run(S, `node harness/score.mjs --events "${evFile}" --machine "${mFile}" --days 1 --json --record round-a --note "selftest"`, base);
    let j = null;
    try { j = JSON.parse(String(first.stdout).trim().split('\n').pop()); } catch { j = null; }
    const v = j?.values || {};
    await guard('2.81 (a) score: the scorecard counts fifteen fixed measures from an exported log: done on the first claim 50% (T-2 was claimed twice), lanes dropped 33.3% (1 of 3), full verify median 10 min (a scoped run is not counted), task added to done 4 h, Producer and Director spend 25%, engine land runs passed 50%, machine under 25% CPU in 50% of samples (fails on 2.80.0: no harness/score.mjs)', () => [
      first.status === 0 && j?.measures?.length === 15 && v.firstClaimDonePct === 50 && v.laneDropPct === 33.3 && v.fullVerifyP50Min === 10 && v.leadTimeP50H === 4 && v.coordinationSpendPct === 25 && v.engineLandPassPct === 50 && v.rigIdlePct === 50
        && Object.keys(v).length === 15 && j.measures.every((m) => m.id in v),
      out(first).slice(-1500)]);
    const rec = path.join(S, 'studio', 'scores', 'round-a.json');
    const second = run(S, `node harness/score.mjs --events "${evFile}" --machine "${mFile}" --days 1 --record round-b`, base);
    await guard('2.81 (a) score: --record writes studio/scores/<label>.json with the window, the values and the note, and the next run shows each measure against the last record ("was …") and says which record it compared with; every line says ok, MISS or n/a against its target (fails on 2.80.0: no scorecard)', () => {
      let saved = null;
      try { saved = JSON.parse(fs.readFileSync(rec, 'utf8')); } catch { saved = null; }
      const t = out(second);
      return [saved?.label === 'round-a' && saved.note === 'selftest' && saved.values?.laneDropPct === 33.3 && saved.window?.days === 1
        && second.status === 0 && /Compared with "round-a"/.test(t) && /Lanes a merge train dropped: 33\.3% \(was 33\.3%\)/.test(t) && /MISS Lanes a merge train dropped/.test(t) && /ok {3}Landed, then reopened/.test(t) && /Recorded as studio\/scores\/round-b\.json/.test(t),
      t.slice(-1800)];
    });
    const bad = run(S, 'node harness/score.mjs --events no-such-file.jsonl', base);
    await guard('2.81 (a) score: an events file with nothing in it is an error, not a card of zeros (fails on 2.80.0: no scorecard)', () => [bad.status === 1 && /no events in/.test(out(bad)), out(bad).slice(-400)]);
  }

  // ---- the overseer's role ----
  {
    const S = studio('overseer');
    fs.rmSync(key, { force: true });
    run(S, 'node harness/approve.mjs keygen', owner);
    g(S, ['add', 'studio/keys']); g(S, ['commit', '-qm', 'keys: owner public key', '--no-verify']);
    const can = (action, by = 'opus-1', env = base) => { const r = run(S, `node harness/overseer.mjs can ${action} --by ${by} --json`, env); let j = null; try { j = JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { j = null; } return { code: r.status, ...(j || { verdict: null, why: out(r).slice(-300) }) }; };
    const before = { force: can('force'), type: can('type'), money: can('money'), merge: can('merge-main'), fix: can('harness-fix'), log: can('workaround-log') };
    const on = run(S, 'node harness/beta-mode.mjs on --by pat --agents opus-1 --why "selftest: the overseer signs"', owner);
    const after = { force: can('force'), type: can('type'), hooks: can('hooks'), money: can('money'), del: can('delete'), grant: can('delegate'), stage: can('stage'), other: can('force', 'opus-9'), worker: can('force', 'builder-s1') };
    await guard('2.81 (a) overseer: `overseer can <action> --by <agent>` is a script\'s verdict from the studio\'s own files: with no grant a board or protected decision is "ask" (exit 1); once beta mode names the agent they are "yes" (exit 0) for that agent only, never for another agent or a worker name; money, deleting data, granting itself more and raising its own stage are "human-only" (exit 3) before and after; harness fixes follow the stage in studio/overseer.json (stage 0: logging workarounds yes, a fix ask) (fails on 2.80.0: no such command)', () => [
      before.force.verdict === 'ask' && before.force.code === 1 && before.type.verdict === 'ask' && before.money.verdict === 'human-only' && before.money.code === 3 && before.merge.verdict === 'human-only' && before.fix.verdict === 'ask' && before.log.verdict === 'yes' && before.log.code === 0
        && on.status === 0 && after.force.verdict === 'yes' && after.force.code === 0 && after.type.verdict === 'yes' && after.hooks.verdict === 'yes'
        && after.money.verdict === 'human-only' && after.del.verdict === 'human-only' && after.grant.verdict === 'human-only' && after.stage.verdict === 'human-only'
        && after.other.verdict === 'ask' && after.worker.verdict === 'ask',
      JSON.stringify({ before, after, on: out(on).slice(-300) })]);
    const role = run(S, 'node harness/overseer.mjs role --by opus-1', base);
    await guard('2.81 (a) overseer: `overseer role` prints the role as the studio stands: what it does as itself, each thing it signs as the owner with yes or ask, and the human-only list (real money, deleting data, keys, publishing, merging a harness release, granting itself more) (fails on 2.80.0: no such command)', () => {
      const t = out(role);
      return [role.status === 0 && /Overseer role: opus-1, stage 0/.test(t) && /Does, as itself: queue order and priority/.test(t) && /yes {2}force:/.test(t) && /yes {2}protected:/.test(t) && /Human-only, whatever the grant: real money/.test(t) && /merging a harness release into its main branch/.test(t) && /granting, widening or extending/.test(t), t.slice(-1500)];
    });
    const ov = await import(u('harness/overseer.mjs'));
    const now = Date.parse('2026-03-03T12:00:00Z');
    const e = (h, type, extra = {}) => ({ ts: new Date(now - h * 3600000).toISOString(), type, ...extra });
    const pass = await ov.overseerPass({ now, hours: 24, events: [e(20, 'task.start', { task: 'T-5' }), e(15, 'task.start', { task: 'T-5' }), e(9, 'task.start', { task: 'T-5' }), e(8, 'task.start', { task: 'T-6' }), e(7, 'task.done', { task: 'T-6' }), e(6, 'session.stall', { task: 'T-5' }), e(5, 'task.train.red_main', {}), e(30, 'task.start', { task: 'T-old' })],
      records: [1, 2, 3].map((n) => ({ id: `W-${n}`, sig: 'Sabc', signature: 'task train: re ran refused harness command task train' })).concat([{ id: 'W-9', sig: 'Sone', signature: 'once' }]) });
    await guard('2.81 (a) overseer: `overseer pass` lists what needs the overseer in the window, each with the attention it needs: a task claimed 3 times and not done is planning, a workaround repeated 3 times in a week is review, a stall is routine, a red main is review; a done task and a single workaround are not listed (fails on 2.80.0: no such command)', () => {
      const kinds = Object.fromEntries(pass.items.map((i) => [i.what.replace(/^\d+ /, '').slice(0, 24), i.kind]));
      const text = ov.passText(pass);
      return [pass.landed === 1 && pass.items.length === 4 && pass.items.some((i) => i.kind === 'planning' && /T-5 \(3\)/.test(i.detail) && !/T-6|T-old/.test(i.detail)) && pass.items.some((i) => i.kind === 'review' && /3x task train/.test(i.detail) && !/once/.test(i.detail))
        && pass.items.some((i) => i.kind === 'routine' && /stall/.test(i.what)) && pass.items.some((i) => i.kind === 'review' && /main itself red/.test(i.what)) && /\[planning\]/.test(text) && /Next: /.test(text),
      JSON.stringify({ kinds, items: pass.items })];
    });
    // lock release --owner: the owner's stand-ins (2.80 knew only STUDIO_OUTSIDE_SIGNERS; the crew's orchestrator is named by beta mode and the proxy).
    const KEYP = 'path:docs/NOTES-281A.md';
    const locked = () => { const r = run(S, `node harness/lock.mjs status ${KEYP}`, base); try { return Boolean(JSON.parse(String(r.stdout).trim().split('\n').pop()).locked); } catch { return /"locked":\s*true/.test(out(r)); } };
    const claim = run(S, `node harness/lock.mjs claim ${KEYP} --owner builder-x`, { ...base, STUDIO_LOCK_OWNER: 'builder-x' });
    const stranger = run(S, `node harness/lock.mjs release ${KEYP} --owner builder-x`, { ...base, STUDIO_LOCK_OWNER: 'opus-9' });
    const held = locked() ? 1 : 0;
    const standIn = run(S, `node harness/lock.mjs release ${KEYP} --owner builder-x`, { ...base, STUDIO_LOCK_OWNER: 'opus-1' });
    const left = locked() ? 1 : 0;
    await guard('2.81 (a) overseer: `lock release <key> --owner <agent>` from an agent beta mode names (opus-1) releases that agent\'s lock; from an agent no grant names (opus-9) it is refused with the rule and the lock stays (fails on 2.80.0: only STUDIO_OUTSIDE_SIGNERS counted, so the owner\'s proxy and beta mode\'s agent were refused)', () => [
      claim.status === 0 && stranger.status !== 0 && /releases another's lock/.test(out(stranger)) && held >= 1 && standIn.status === 0 && left === 0,
      JSON.stringify({ claim: out(claim).slice(-200), stranger: out(stranger).slice(-300), standIn: out(standIn).slice(-300), held, left })]);
  }

  // ---- engine first by default ----
  {
    const er = await import(u('harness/engine-ram.mjs'));
    const mode = await import(u('harness/mode.mjs'));
    const mk = (name, engines, push) => {
      const R = path.join(tmpRoot, `281a-eng-${name}-${process.pid}`);
      fs.mkdirSync(path.join(R, 'studio'), { recursive: true });
      fs.writeFileSync(path.join(R, 'studio', 'game.json'), JSON.stringify({ game: 'demo', engines }));
      if (push !== undefined) fs.writeFileSync(path.join(R, 'studio', 'mode.json'), JSON.stringify({ enginePush: push }));
      made.push(R);
      return R;
    };
    const now = Date.parse('2026-03-03T12:00:00Z');
    const one = mk('one', { unity: { folder: 'engine/demo' } });
    const two = mk('two', { unity: {}, godot: {} });
    const none = mk('none', {});
    const off = mk('off', { unity: {} }, { on: false, engine: 'unity', by: 'pat', at: '2026-03-01T00:00:00Z' });
    const on = mk('on', { unity: {}, godot: {} }, { on: true, engine: 'godot', by: 'pat', at: '2026-03-01T00:00:00Z', until: null });
    const ended = mk('ended', { unity: {} }, { on: true, engine: 'unity', by: 'pat', at: '2026-03-01T00:00:00Z', until: '2026-03-02T00:00:00Z' });
    await guard('2.81 (a) engine first: a studio with exactly one engine in studio/game.json gives it the push when nobody decided (the engine line and the Line Producer read the same answer); two engines or none: no default; `engine-push off` stays off; an explicit push wins; a timed push that ended falls back to the default (fails on 2.80.0: no push unless someone switched it on)', () => {
      const read = (R) => { let m = {}; try { m = JSON.parse(fs.readFileSync(path.join(R, 'studio', 'mode.json'), 'utf8')); } catch { m = {}; } return { ram: er.pushEngine(R, now), mode: mode.enginePushOf(m, now, R)?.engine ?? null, auto: Boolean(mode.enginePushOf(m, now, R)?.auto) }; };
      const r = { one: read(one), two: read(two), none: read(none), off: read(off), on: read(on), ended: read(ended) };
      return [r.one.ram === 'unity' && r.one.mode === 'unity' && r.one.auto && r.two.ram === null && r.two.mode === null && r.none.ram === null && r.off.ram === null && r.off.mode === null
        && r.on.ram === 'godot' && r.on.mode === 'godot' && !r.on.auto && r.ended.ram === 'unity' && r.ended.mode === 'unity' && r.ended.auto,
      JSON.stringify(r)];
    });
  }

  for (const d of made) { try { fs.rmSync(d, { recursive: true, force: true, maxRetries: 4, retryDelay: 200 }); } catch { /* best effort */ } }
  try { fs.rmSync(key, { force: true }); } catch { /* none */ }
}

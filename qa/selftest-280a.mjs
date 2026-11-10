/**
 * qa/selftest-280a.mjs — 2.80.0 (a): the crew's local patches folded in (HANDOFF field notes A1, 13).
 *
 * The launcher's claim step for an aider-run builder timed out at 120 s on a loaded PC (a first claim builds the lane
 * copy), and a claim that was recorded before the step died stayed with an agent that never ran. The allowlist lacked
 * dotnet, which a Unity studio's .NET sim tests need.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest280A({ dir, report }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  const ap = await import(u('harness/aider-protocol.mjs'));
  const { ALLOWED } = await import(u('harness/allowlist.mjs'));

  await guard('2.80 (a): the aider claim step waits 480 s by default (STUDIO_AIDER_CLAIM_TIMEOUT_MS changes it) and a timeout says so in the hand-back line (fails on 2.79.2: 120 s, and a timeout read "exit null")', () => {
    const seen = [];
    const run = (_bin, _args, opts) => { seen.push(opts.timeout); return { status: null, signal: 'SIGTERM', error: { code: 'ETIMEDOUT' }, stdout: '', stderr: '' }; };
    const timedOut = ap.claimTask({ agent: 'builder-1', task: 'T-1', cwd: dir, env: {}, run });
    const failed = ap.claimTask({ agent: 'builder-1', task: 'T-1', cwd: dir, env: {}, run: () => ({ status: 1, stdout: '', stderr: 'refused: not yours\n' }), timeoutMs: 5000 });
    const ok = ap.claimTask({ agent: 'builder-1', task: 'T-1', cwd: dir, env: {}, run: () => ({ status: 0, stdout: 'started\n', stderr: '' }) });
    return [seen[0] === (Number(process.env.STUDIO_AIDER_CLAIM_TIMEOUT_MS) || 480000) && !timedOut.ok && /timed out after \d+ s/.test(timedOut.out) && !failed.ok && /refused: not yours/.test(failed.out) && ok.ok,
      JSON.stringify({ seen, timedOut, failed, ok })];
  });

  await guard('2.80 (a): when the claim step fails after the claim was recorded, the launcher hands the task back before it reports the failed start, and only when the claim is this agent\'s (fails on 2.79.2: the task stayed claimed by an agent that never ran)', () => {
    const src = fs.readFileSync(path.join(dir, 'harness', 'agent.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const at = src.indexOf('const c = claimTask({ agent, task, model, cwd, env });');
    const block = at >= 0 ? src.slice(at, at + 900) : '';
    const release = block.indexOf('pauseTask(task, agent,');
    return [at >= 0 && release > 0 && /l\.key === `task:\$\{task\}` && l\.owner === agent/.test(block.slice(0, release)) && release < block.indexOf('throw new Error(`${task} could not be claimed'),
      block.slice(0, 700) || 'no claim step'];
  });

  await guard('2.80 (a): dotnet is on the list of commands an agent may run without asking (a Unity studio\'s .NET tests), and no entry names one machine\'s install path (fails on 2.79.2: no dotnet)', () => [
    ALLOWED.some(([n, p]) => n === 'dotnet' && p === 'dotnet *') && ALLOWED.every(([, p]) => !/[A-Za-z]:[\\/]|\/usr\/|Program Files/.test(p)),
    JSON.stringify(ALLOWED)]);
}

/**
 * harness/train-gate.mjs — 2.97 (d): what a train checks before it takes its lock and picks its batch.
 *   drainLine()     '' or the one line a train prints when the drain is on: no train starts during a drain
 *   harnessGate()   null when this process runs the harness on disk (harness-version.mjs chainGuard); else
 *                   { restart, line }: a train that waited while the harness changed starts again, once
 *   restartSelf()   that new process: same arguments and environment, output to the same files, detached on
 *                   Windows; STUDIO_TRAIN_RESTARTED marks it, so a second change ends it instead of a loop
 *   trainGate()     both, as one call; gateResult() what a train that stopped there returns
 *   drainResume()   after `drain off`: queued web lanes get their train from the usual starter (kickTrain);
 *                   engine queues wait for the Line Producer's next pass, as always
 * After the lock is taken nothing restarts: the upgrade guard (upgrade-guard.mjs runningTrains) covers that span.
 */
import fs from 'node:fs';
import { spawn } from 'node:child_process';
import { chainGuard } from './harness-version.mjs';

export const RESTARTED = 'STUDIO_TRAIN_RESTARTED';

export async function drainLine(what = 'train') {
  let d = null;
  try { d = await (await import('./busy.mjs')).readDrain(); } catch { return ''; }
  return d?.on ? `No ${what} was started: the drain is on (by ${d.by || '?'}${d.why ? `: ${d.why}` : ''}). Queued lanes stay queued; npm run task -- drain off starts their train.` : '';
}

export function harnessGate({ env = process.env, ...given } = {}) {
  const cg = chainGuard({ env, ...given });
  if (cg.ok) return null;
  const v = cg.was?.version && cg.now?.version && cg.was.version !== cg.now.version ? `${cg.was.version} -> ${cg.now.version}` : cg.why.replace(/^.*\((.*)\)$/, '$1');
  if (env[RESTARTED]) return { restart: false, line: `the harness changed again while this train waited (${v}); it was started again once already, so it stops here. Its lanes stay queued: npm run task -- train --by <you> starts a train.` };
  return { restart: true, line: `the harness changed while this train waited (${v}): starting again on the new code` };
}

/** The drain, then the harness: null to go on, else { drain } or { restart, line }. */
export async function trainGate(deps = {}) {
  const dl = await deps.drained?.();
  return dl ? { drain: dl } : harnessGate();
}
/** What a train that stopped at its gate returns; with deps.restart it starts the same command again first. */
export function gateResult(g, { id, deps = {}, log = () => {}, extra = {} }) {
  const none = { id, landed: [], dropped: [], deferred: [], ...extra };
  if (g.drain) return { ...none, ok: false, drained: true, message: g.drain };
  log(`[train] ${g.line}`);
  const pid = g.restart && deps.restart ? deps.restart() : null;
  if (pid) return { ...none, ok: true, restarted: pid, message: `Started again on the new code (pid ${pid}); this process ends.` };
  return { ...none, ok: false, notRun: true, message: g.restart ? `Nothing landed: ${g.line.replace(/: starting again on the new code$/, '')}; run it again.` : `Nothing landed: ${g.line}` };
}

export function restartSelf({ env = process.env, argv = process.argv, cwd = process.cwd() } = {}) {
  const child = spawn(process.execPath, [...process.execArgv, ...argv.slice(1)], { cwd, env: { ...env, [RESTARTED]: '1' }, stdio: 'inherit', detached: process.platform === 'win32', windowsHide: true });
  child.on('error', () => {});
  child.unref();
  // A followed train (train-detach.mjs followDetached): the follower reads the new pid from here.
  const f = String(env.STUDIO_TRAIN_FOLLOWED || '').trim();
  if (f && child.pid) { try { fs.writeFileSync(`${f}.next`, String(child.pid)); } catch { /* the follower says it ended */ } }
  return child.pid || null;
}

export async function drainResume(root, { by = '', env = process.env, kick = null } = {}) {
  if (!(await import('./train.mjs')).readQueue(root).length) return '';
  try { return (await (kick || (await import('./train-detach.mjs')).kickTrain)(root, { by, env })).line; } catch (e) { return `Couldn't start a train for the queued lanes (${e.message}); npm run task -- train --by <you> lands them.`; }
}

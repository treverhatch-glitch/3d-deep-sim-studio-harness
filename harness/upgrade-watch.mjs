/**
 * harness/upgrade-watch.mjs — 2.69.0 (s): watch for a newer harness, and take it in the owner's quiet hours.
 *
 * The crew's orchestrator watched for harness upgrades with one-shot timers, checked CI, upgraded and refreshed the
 * lanes by hand. Now:
 *
 *   npm run upgrade -- watch [--json]                one check now (fetch, compare versions, CI, decide)
 *   npm run upgrade -- watch auto on --by <person> [--permission "<their words or a link>"] [--ref <remote>/<branch>]
 *   npm run upgrade -- watch auto off [--by <name>]  (anyone: it only takes power away)
 *   npm run upgrade -- watch status                  the switch and the last check
 *
 * Which harness: the "ref" in studio/upgrade.json, else main on the remote of STUDIO_HARNESS_REF (the harness remote
 * the studio already uses), else upstream/main when the studio has an `upstream` remote. A check fetches that branch
 * (git, GIT_TERMINAL_PROMPT=0, STUDIO_UPGRADE_FETCH_MS, 60000) and compares its package.json version with the studio's.
 * A newer one has its CI read from the public GitHub API (combined status and check runs of that commit, no token).
 * Not a GitHub remote, the API unreachable, or CI not finished green: never upgraded automatically, only reported.
 *
 * It upgrades on its own only when all of these hold, else it reports or waits (an upgrade.watch event each time the
 * answer changes):
 *   - auto-upgrade is on: studio/upgrade.json { auto: true, by, … } as committed in the main checkout (the switch
 *     records who: a person in their own terminal, an agent outside the harness or a Producer/Director session with
 *     that person's --permission, or the agent the owner's delegation covers for "upgrade-auto"; workers never; the
 *     last commit that changed the file must not be a worker's);
 *   - CI on that commit is green;
 *   - now is inside STUDIO_UPGRADE_WINDOW ("03:00-05:00", local time; unset: report only);
 *   - no merge train runs (.studio/locks/train.lock), no heavy work (a verify) holds machine:heavy, and no agent session
 *     is running (lanes mid-session): it waits for the next check.
 * Then it runs `upgrade --merge` (harness/upgrade-guard.mjs: the board check, the backup, the hooks, the upgrade.merged
 * event, the 2.67.0 lanes refresh) for the person recorded in the switch, and files one builder task per lane the
 * refresh found conflicted. The supervisor runs a check every STUDIO_UPGRADE_WATCH_MIN (60; off: never). The running
 * supervisor keeps the old harness in memory: the result says to restart it.
 *
 * upgrade-guard.mjs's CLI uses top-level await: it is imported here only inside functions (no import cycle).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { emitEvent } from './event.mjs';

export const UPGRADE_REL = 'studio/upgrade.json';
const git = (root, args, opts = {}) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, ...opts });
const out1 = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const stateFile = (root) => path.join(root, '.studio', 'upgrade-watch.json');
// upgrade-guard.mjs as its CLI passes itself in (a module whose top-level await is still running can't import itself back).
const loadGuard = async (g) => g || import('./upgrade-guard.mjs');
const off = (v) => /^(off|0|false|no)$/i.test(String(v || '').trim());

/** studio/upgrade.json as committed at HEAD (never the working copy), or null. */
export function committedSetting(root) {
  const r = git(root, ['show', `HEAD:${UPGRADE_REL}`]);
  if (r.status !== 0) return null;
  try { return JSON.parse(r.stdout); } catch { return null; }
}

/** The harness ref to watch: { ref, remote, branch, source } or { ref: null, why }. */
export async function watchRef(root, env = process.env) {
  const remotes = new Set(String(git(root, ['remote']).stdout || '').split('\n').map((x) => x.trim()).filter(Boolean));
  const split = (ref, source) => {
    const s = String(ref || '').trim();
    const remote = [...remotes].sort((a, b) => b.length - a.length).find((r) => s.startsWith(`${r}/`));
    if (!remote || s.includes('..')) return { ref: null, why: `${source} names "${s}", which isn't <remote>/<branch> on a remote this studio has (git remote -v)` };
    return { ref: s, remote, branch: s.slice(remote.length + 1), source };
  };
  const cfg = committedSetting(root);
  if (cfg?.ref) return split(cfg.ref, UPGRADE_REL);
  let declared = '';
  try { declared = (await import('./hook-stamp.mjs')).declaredHarnessRef(env, root); } catch { declared = String(env.STUDIO_HARNESS_REF || '').trim(); }
  if (declared) {
    const r = split(declared, 'STUDIO_HARNESS_REF');
    if (r.ref) return { ...r, ref: `${r.remote}/main`, branch: 'main', source: `main on STUDIO_HARNESS_REF's remote (${r.remote})` };
    return r;
  }
  if (remotes.has('upstream')) return { ref: 'upstream/main', remote: 'upstream', branch: 'main', source: 'the upstream remote' };
  return { ref: null, why: `no harness remote: set "ref" in ${UPGRADE_REL} (npm run upgrade -- watch auto on --ref <remote>/<branch> …), STUDIO_HARNESS_REF, or add the harness as the upstream remote` };
}

/** Compare dotted versions: 1 when a is newer than b. */
export function versionCmp(a, b) {
  const p = (v) => String(v || '0').replace(/^v/, '').split(/[.+-]/).slice(0, 3).map((x) => Number.parseInt(x, 10) || 0);
  const A = p(a); const B = p(b);
  for (let i = 0; i < 3; i += 1) if ((A[i] || 0) !== (B[i] || 0)) return (A[i] || 0) > (B[i] || 0) ? 1 : -1;
  return 0;
}
const versionAt = (root, rev) => { try { return JSON.parse(git(root, ['show', `${rev}:package.json`]).stdout).version || null; } catch { return null; } };

/** owner/repo of a GitHub remote URL (https, ssh or scp form), or null. */
export function githubRepo(url) {
  const m = String(url || '').trim().match(/github\.com[:/]+([^/\s]+)\/([^/\s]+?)(?:\.git)?\/?$/i);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/** Judge GitHub's answers: { state: green | red | pending | unknown, why }. */
export function judgeCi({ status = null, checks = null } = {}) {
  const runs = Array.isArray(checks?.check_runs) ? checks.check_runs : [];
  const statuses = Array.isArray(status?.statuses) ? status.statuses : [];
  if (!runs.length && !statuses.length) return { state: 'unknown', why: 'no CI result on that commit' };
  const bad = runs.filter((r) => r.status === 'completed' && !['success', 'neutral', 'skipped'].includes(r.conclusion));
  const failedStatus = statuses.filter((s) => ['failure', 'error'].includes(s.state));
  if (bad.length || failedStatus.length) return { state: 'red', why: `failed: ${[...bad.map((r) => `${r.name} (${r.conclusion})`), ...failedStatus.map((s) => `${s.context} (${s.state})`)].slice(0, 4).join(', ')}` };
  const waiting = runs.filter((r) => r.status !== 'completed').length + statuses.filter((s) => s.state === 'pending').length;
  if (waiting) return { state: 'pending', why: `${waiting} check(s) still running` };
  return { state: 'green', why: `${runs.length} check run(s)${statuses.length ? ` and ${statuses.length} status(es)` : ''} passed` };
}

/** CI of <sha> on a GitHub remote, from the public API (no token): { state, why }. Not GitHub or unreachable: unknown. */
export async function ciStatus({ url, sha, env = process.env, fetchImpl = globalThis.fetch } = {}) {
  const gh = githubRepo(url);
  if (!gh) return { state: 'unknown', why: 'the harness remote is not on GitHub, so its CI can\'t be read' };
  if (typeof fetchImpl !== 'function') return { state: 'unknown', why: 'this Node has no fetch' };
  const base = `https://api.github.com/repos/${encodeURIComponent(gh.owner)}/${encodeURIComponent(gh.repo)}/commits/${sha}`;
  const get = async (p) => {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), Math.max(1000, Number(env.STUDIO_UPGRADE_FETCH_MS) || 60000) / 4);
    try {
      const r = await fetchImpl(`${base}${p}`, { headers: { Accept: 'application/vnd.github+json', 'User-Agent': 'studio-upgrade-watch' }, signal: ac.signal });
      if (!r.ok) throw new Error(`GitHub API answered ${r.status}`);
      return await r.json();
    } finally { clearTimeout(t); }
  };
  try {
    const [status, checks] = await Promise.all([get('/status'), get('/check-runs?per_page=100')]);
    return judgeCi({ status, checks });
  } catch (e) {
    return { state: 'unknown', why: `the GitHub API wasn't reachable (${String(e.message || e).slice(0, 120)})` };
  }
}

/** Is `now` (local time) inside "HH:MM-HH:MM"? A window may wrap past midnight. Unset or unreadable: null. */
export function inUpgradeWindow(win, now = Date.now()) {
  const m = String(win || '').trim().match(/^(\d{1,2}):(\d{2})\s*-\s*(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  const d = new Date(now);
  const t = d.getHours() * 60 + d.getMinutes();
  const a = Number(m[1]) * 60 + Number(m[2]);
  const b = Number(m[3]) * 60 + Number(m[4]);
  return a <= b ? t >= a && t < b : t >= a || t < b;
}

const pidAlive = (pid) => { try { process.kill(Number(pid), 0); return true; } catch (e) { return e.code === 'EPERM'; } };

/** Why an upgrade must wait now, or '': a train, heavy work (a verify), or agent sessions running. */
export async function busyNow(root, env = process.env) {
  const why = [];
  const tl = readJson(path.join(root, '.studio', 'locks', 'train.lock'), null);
  if (tl?.pid && pidAlive(tl.pid) && Date.now() - Number(tl.at || 0) < Number(env.STUDIO_TRAIN_STALE_MIN || 360) * 60000) why.push(`a merge train is running (${tl.id || 'train'}, pid ${tl.pid})`);
  try {
    const h = await import('./heavy.mjs');
    const holders = h.heavyHolders(root, { env });
    if (holders.length) why.push(`heavy work is running: ${holders.slice(0, 2).map((x) => h.describeHolder(x)).join(', ')}`);
  } catch {}
  try {
    const { sessionRunning } = await import('./lanes.mjs');
    const dir = path.join(root, '.studio', 'agents');
    const live = (fs.existsSync(dir) ? fs.readdirSync(dir) : []).filter((f) => f.endsWith('.json')).map((f) => sessionRunning(root, f.slice(0, -5))).filter(Boolean);
    if (live.length) why.push(`${live.length} agent session(s) running (${live.slice(0, 3).map((s) => `${s.agent}${s.task ? ` on ${s.task}` : ''}`).join(', ')}): lanes are mid-session`);
  } catch {}
  return why.join('; ');
}

/**
 * The auto-upgrade switch as it counts: { on, by, setBy, at, via, why }. Read from HEAD; the last commit that changed
 * it must not carry a worker's Studio-Agent trailer, and `by` must be a person's name.
 */
export async function readAuto(root) {
  const doc = committedSetting(root);
  if (!doc) return { on: false, why: `${UPGRADE_REL} isn't committed: auto-upgrade is off` };
  if (doc.auto !== true) return { on: false, doc, why: `auto-upgrade is off (${UPGRADE_REL}${doc.by ? `, ${doc.by}` : ''})` };
  const last = git(root, ['log', '-1', '--format=%B', '--', UPGRADE_REL]);
  const agent = (String(last.stdout || '').match(/^Studio-Agent:\s*(.+)$/m) || [])[1];
  try {
    const perm = await import('./permission.mjs');
    if (agent && !perm.permittedSetter(agent.trim())) return { on: false, doc, why: `${UPGRADE_REL} was last changed by a worker (${agent.trim()}): it doesn't count` };
  } catch {}
  try {
    const { agentLikeName } = await import('./agent-env.mjs');
    if (!doc.by || agentLikeName(String(doc.by), { stateDir: path.join(root, '.studio') })) return { on: false, doc, why: `${UPGRADE_REL} names "${doc.by || ''}" as the person, which is an agent's name: it doesn't count` };
  } catch {}
  return { on: true, doc, by: String(doc.by), setBy: doc.setBy || doc.by, at: doc.at || null, via: doc.via || null, why: '' };
}

/** `watch auto on|off`: { ok, message }. On: a person, or an agent on a person's permission, or the delegated agent. */
export async function setAuto({ on, by = '', permission = '', ref = '', root, env = process.env, commit = true, now = new Date(), guard: given = null } = {}) {
  const who = String(by || '').trim();
  const refuse = (m) => ({ ok: false, message: `Not changed: ${m}` });
  const guard = await loadGuard(given);
  if (!root || !guard.repoRoot(root)) return refuse('this isn\'t a git checkout; run it in the studio\'s main checkout');
  if (!guard.isMainCheckout(root)) return refuse('this is a lane copy; switch it in the studio\'s main checkout');
  let rec;
  if (on) {
    let d = { ok: false };
    try { d = (await import('./delegation.mjs')).delegationFor({ action: 'upgrade-auto', by: who, env, root }); } catch {}
    if (d.ok) rec = { by: d.owner, setBy: d.agent, via: 'delegation', permission: d.permission };
    else {
      const w = await guard.whoActs({ by: who, permission, env, root });
      if (!w.ok) return refuse(`${w.why}${d.why ? ` (${d.why})` : ''}`);
      rec = { by: who, setBy: w.via === 'person' ? who : w.recordedBy, via: w.via, permission: w.permission || null };
    }
    if (ref && !/^[\w.-]+\/[\w./-]+$/.test(ref)) return refuse('--ref takes <remote>/<branch>');
  } else {
    const owner = String(env.STUDIO_LOCK_OWNER || '').trim();
    rec = { by: who || owner || 'someone', setBy: owner || who || 'someone', via: 'off' };
  }
  const prev = committedSetting(root) || {};
  const doc = { auto: Boolean(on), ref: ref || prev.ref || undefined, by: rec.by.slice(0, 60), setBy: String(rec.setBy).slice(0, 80), via: rec.via, ...(rec.permission ? { permission: String(rec.permission).slice(0, 300) } : {}), at: now.toISOString() };
  fs.mkdirSync(path.join(root, 'studio'), { recursive: true });
  fs.writeFileSync(path.join(root, UPGRADE_REL), `${JSON.stringify(doc, null, 2)}\n`);
  let note = '';
  if (commit) {
    git(root, ['add', '--', UPGRADE_REL]);
    const c = git(root, ['commit', '--only', '-m', `upgrade: auto ${on ? 'on' : 'off'} by ${doc.by}${doc.setBy !== doc.by ? ` (set by ${doc.setBy})` : ''}`, '--', UPGRADE_REL]);
    note = c.status === 0 ? ` Committed ${UPGRADE_REL}.` : ` Committing it failed (${String(c.stderr || c.stdout).trim().split('\n').pop()}): it counts once ${UPGRADE_REL} is committed.`;
  } else note = ` Not committed: it counts once ${UPGRADE_REL} is committed.`;
  try { const dm = await import('./decisions-log.mjs'); dm.logDecision({ action: 'upgrade-auto', subject: UPGRADE_REL, by: doc.setBy, as: rec.via === 'delegation' ? `delegation ${String(rec.permission || '').slice(0, 60)}` : dm.asOf({ via: rec.via === 'off' ? 'person' : rec.via, permission: rec.permission }), why: `auto-upgrade ${on ? 'on' : 'off'}`, evidence: doc.ref || '', undo: { kind: 'text', text: `npm run upgrade -- watch auto ${on ? 'off' : 'on'} --by <name>` }, root }); } catch {}
  emitEvent({ type: 'upgrade.auto', agent: doc.setBy, to: 'producer', msg: `auto-upgrade ${on ? 'on' : 'off'}: ${doc.by}${doc.setBy !== doc.by ? ` (set by ${doc.setBy}, ${doc.via})` : ''}`.slice(0, 400), meta: { ...doc } });
  const win = String(env.STUDIO_UPGRADE_WINDOW || '').trim();
  return { ok: true, doc, message: `Auto-upgrade ${on ? `on for ${doc.by}${doc.setBy !== doc.by ? ` (set by ${doc.setBy}, ${doc.via})` : ''}` : 'off'}.${note}${on && !win ? ' STUDIO_UPGRADE_WINDOW is unset, so the watch only reports until it names a daily window (for example 03:00-05:00).' : ''}` };
}

function writeState(root, s) {
  try { fs.mkdirSync(path.dirname(stateFile(root)), { recursive: true }); fs.writeFileSync(stateFile(root), `${JSON.stringify(s, null, 2)}\n`); } catch {}
}
export const readWatchState = (root) => readJson(stateFile(root), {});

/** One builder task per lane the refresh left conflicted (title dedupe by addTask). */
async function fileConflictTasks(root, lanes, to, by) {
  const filed = [];
  if (!lanes?.conflicted?.length) return filed;
  try {
    const task = await import('./task.mjs');
    for (const c of lanes.conflicted) {
      const files = (c.files || []).slice(0, 4).join(', ') || 'files git named in the refresh';
      const r = task.addTask({ title: `Resolve the harness ${to} upgrade conflict in lane ${c.lane}: merge main into it and resolve ${files} (npm run lanes -- refresh ${c.lane})`.slice(0, 200), role: 'builder', priority: 'P1', agent: task.PRODUCER_NAME(), overlap: false, meta: { origin: 'upgrade-watch', promoted: true, upgradeConflict: { lane: c.lane, files: c.files || [], to, by } } });
      if (r?.id) filed.push(r.id);
    }
  } catch {}
  return filed;
}

/**
 * One watch check: { status, ref, sha, ours, theirs, ci, lines, merged?, filed? }. status: no-ref | unreachable |
 * current | available | refused | waiting | merged | failed. deps (tests): { ci: async ({ url, sha }) => ({ state, why }) }.
 */
export async function upgradeWatch({ root, env = process.env, now = Date.now(), dryRun = false, deps = {}, guard: given = null } = {}) {
  const res = { status: '', lines: [] };
  const done = (status, line, extra = {}) => {
    Object.assign(res, { status, ...extra });
    res.lines.push(`[upgrade watch] ${line}`);
    const prev = readWatchState(root);
    const key = `${status}|${res.sha || ''}|${extra.cause || ''}`;
    if (!dryRun) {
      writeState(root, { ...prev, lastPoll: new Date(now).toISOString(), status, ref: res.ref || null, sha: res.sha || null, ours: res.ours || null, theirs: res.theirs || null, ci: res.ci || null, line, key });
      if (status !== 'no-ref' && (prev.key !== key || ['merged', 'failed'].includes(status))) {
        emitEvent({ type: 'upgrade.watch', agent: 'upgrade-watch', to: ['available', 'refused', 'failed', 'merged'].includes(status) ? 'producer' : null, status: status === 'failed' ? 'blocked' : ['refused', 'waiting'].includes(status) ? 'warn' : 'ok', msg: line.slice(0, 600), meta: { status, ref: res.ref || null, sha: res.sha || null, from: res.ours || null, to: res.theirs || null, ci: res.ci?.state || null, cause: extra.cause || null, filed: res.filed || [] } });
      }
    }
    return res;
  };
  const w = await watchRef(root, env);
  if (!w.ref) return done('no-ref', w.why);
  res.ref = w.ref;
  const f = git(root, ['fetch', '--quiet', '--no-tags', w.remote, `+refs/heads/${w.branch}:refs/remotes/${w.remote}/${w.branch}`], { timeout: Math.max(1000, Number(env.STUDIO_UPGRADE_FETCH_MS) || 60000), env: { ...process.env, ...env, GIT_TERMINAL_PROMPT: '0' } });
  if (f.status !== 0) return done('unreachable', `couldn't fetch ${w.ref} (${String(f.stderr || f.error?.message || `exit ${f.status}`).trim().split('\n').pop().slice(0, 160)}); trying again at the next check`);
  const sha = out1(git(root, ['rev-parse', '--verify', '--quiet', `refs/remotes/${w.remote}/${w.branch}^{commit}`]));
  res.sha = sha;
  res.ours = versionAt(root, 'HEAD');
  res.theirs = versionAt(root, sha);
  if (!sha || git(root, ['merge-base', '--is-ancestor', sha, 'HEAD']).status === 0 || versionCmp(res.theirs, res.ours) <= 0) return done('current', `the studio has harness ${res.ours || '?'}; ${w.ref} is ${res.theirs || '?'}${sha ? ` (${sha.slice(0, 10)})` : ''}: nothing newer`);
  const url = out1(git(root, ['remote', 'get-url', w.remote]));
  res.ci = deps.ci ? await deps.ci({ url, sha }) : await ciStatus({ url, sha, env });
  const what = `harness ${res.theirs} on ${w.ref} (${sha.slice(0, 10)}; the studio has ${res.ours || '?'}), CI ${res.ci.state}: ${res.ci.why}`;
  const auto = await readAuto(root);
  if (!auto.on) return done('available', `${what}. Report only: ${auto.why}. To take it: npm run upgrade -- --merge ${w.ref} --by <you>; to let the watch take updates in a daily window: npm run upgrade -- watch auto on --by <you> and STUDIO_UPGRADE_WINDOW`, { cause: 'auto-off' });
  if (res.ci.state !== 'green') return done('refused', `${what}. Not upgrading automatically: CI must be green on that commit (a person can still take it: npm run upgrade -- --merge ${w.ref} --by <you>)`, { cause: `ci-${res.ci.state}` });
  const win = String(env.STUDIO_UPGRADE_WINDOW || '').trim();
  const inside = inUpgradeWindow(win, now);
  if (inside === null) return done('available', `${what}. Report only: STUDIO_UPGRADE_WINDOW is ${win ? `"${win}", not HH:MM-HH:MM` : 'unset'} (auto-upgrade is on for ${auto.by})`, { cause: 'no-window' });
  if (!inside) return done('waiting', `${what}. Waiting for the upgrade window ${win}`, { cause: 'window' });
  const busy = await busyNow(root, env);
  if (busy) return done('waiting', `${what}. Waiting: ${busy}`, { cause: 'busy' });
  if (dryRun) return done('waiting', `${what}. Would upgrade now (dry run)`, { cause: 'dry-run' });
  const guard = await loadGuard(given);
  const permission = `auto-upgrade switched on by ${auto.by}${auto.setBy !== auto.by ? ` (set by ${auto.setBy})` : ''} at ${auto.at || '?'} in ${UPGRADE_REL}; CI green on ${sha.slice(0, 10)}; window ${win}`;
  const m = await guard.upgradeMerge({ ref: w.ref, by: auto.by, permission, root, env });
  res.lines.push(...(m.lines || []));
  if (!m.ok) return done('failed', `${what}. The automatic upgrade didn't merge: ${String((m.lines || []).slice(-1)[0] || '').replace(/^\[upgrade\] /, '').slice(0, 300)}`, { cause: 'merge' });
  res.merged = { commit: m.commit, backup: m.backup };
  res.filed = await fileConflictTasks(root, m.lanes, res.theirs, auto.by);
  const lanes = m.lanes?.ran ? `lanes: ${m.lanes.refreshed.length} refreshed, ${m.lanes.conflicted.length} conflicted${res.filed.length ? ` (fix tasks ${res.filed.join(', ')})` : ''}, ${m.lanes.red.length} red, ${m.lanes.skipped.length} skipped` : 'lanes not refreshed';
  return done('merged', `merged harness ${res.ours} -> ${res.theirs} from ${w.ref} for ${auto.by} in the window ${win}: ${String(m.commit || '').slice(0, 10)}, backup ${m.backup}; ${lanes}. Restart the supervisor so it runs the new harness (npm run studio:stop, then npm run studio:start)`, { cause: 'merged' });
}

/** The supervisor's hook: a check every STUDIO_UPGRADE_WATCH_MIN (60; off: never). { line } or null. Never throws. */
export async function supervisorWatch({ now = Date.now(), dryRun = false, env = process.env, root = null, deps = {} } = {}) {
  try {
    if (off(env.STUDIO_UPGRADE_WATCH_MIN)) return null;
    const every = Math.max(1, Number(env.STUDIO_UPGRADE_WATCH_MIN) || 60) * 60000;
    const guard = await import('./upgrade-guard.mjs');
    const r = root || guard.repoRoot(process.cwd());
    if (!r) return null;
    const last = Date.parse(readWatchState(r).lastPoll || '') || 0;
    if (now - last < every) return null;
    const w = await upgradeWatch({ root: r, env, now, dryRun, deps });
    return ['available', 'refused', 'waiting', 'merged', 'failed'].includes(w.status) ? { line: w.lines[w.lines.length - 1].replace(/^\[upgrade watch\] /, 'upgrade watch: ').slice(0, 300), status: w.status } : { line: '', status: w.status };
  } catch { return null; }
}

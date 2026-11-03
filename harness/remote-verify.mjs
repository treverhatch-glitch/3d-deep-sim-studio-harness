/**
 * harness/remote-verify.mjs — 2.69.0 (q): a merge train's verify on the repo's own CI (optional, off by default).
 *
 * STUDIO_VERIFY_REMOTE=github: for a PUBLIC GitHub repo, with a token the owner set (GH_TOKEN or GITHUB_TOKEN in the
 * environment; never printed, never put on a command line), the train pushes its integration commit to a throwaway
 * branch train/<id> on origin, waits for the repo's CI on that commit (GitHub REST check-runs) and lets the NAMED check
 * run (STUDIO_VERIFY_REMOTE_CHECK, a pattern; default release-gate) stand for the game's own checks only: every
 * matching run completed with success (skipped or neutral don't count, so a CI that skips the suite can't pass it).
 * The safety gates never come from the remote: the train runs every non-game, non-engine gate locally on the same
 * tree (localGateIds; protected, secrets, hooks, weakened-tests, golden, regressions, ...) and both must pass. Any error, a private repo, no check run starting within STUDIO_VERIFY_REMOTE_START_MIN (10), or no
 * result within STUDIO_VERIFY_REMOTE_TIMEOUT_MIN (60): the local verify runs, as before. A red CI result also runs the
 * local verify: its record names the failing checks the prefix search re-checks. Afterwards the train deletes its own
 * train/<id> branch, only that exact name and only when this push created it; no other remote ref is ever touched.
 * Cost: GitHub's standard runners are free for public repos; a private repo would use paid minutes, so it is never
 * used (the owner decides money).
 * The client is injectable (tests use a fake one; no network in tests).
 */
import { spawnSync } from 'node:child_process';

const num = (v, d) => (v === undefined || v === null || String(v).trim() === '' || !Number.isFinite(Number(v)) ? d : Number(v));
export const remoteMode = (env = process.env) => (/^github$/i.test(String(env.STUDIO_VERIFY_REMOTE || '').trim()) ? 'github' : 'off');
export const remoteTimeoutMs = (env = process.env) => Math.max(1, num(env.STUDIO_VERIFY_REMOTE_TIMEOUT_MIN, 60)) * 60000;
export const remoteStartMs = (env = process.env) => Math.max(1, num(env.STUDIO_VERIFY_REMOTE_START_MIN, 10)) * 60000;
const pollMs = (env = process.env) => Math.max(1, num(env.STUDIO_VERIFY_REMOTE_POLL_S, 30)) * 1000;
/** STUDIO_VERIFY_REMOTE_CHECK: the check-run name pattern that stands for the game checks (default release-gate). */
export function remoteCheckPattern(env = process.env) {
  const raw = String(env.STUDIO_VERIFY_REMOTE_CHECK ?? '').trim() || 'release-gate';
  try { return new RegExp(raw, 'i'); } catch { return new RegExp(raw.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'); }
}

/**
 * The gates the train still runs locally when the remote stands for the game checks: every studio gate except the
 * game's checks (game-gates.mjs ids), the engine gates (engine, engine:*, godot-unit) and heavy ones (heavy: true,
 * browser-play). gates: studio/gates.json "gates".
 */
export function localGateIds(gates = [], gameIds = ['game']) {
  const heavy = (g) => g.heavy === true || g.id === 'browser-play' || /^engine(:|$)/.test(String(g.id)) || g.id === 'godot-unit' || gameIds.includes(g.id) || /game-gates\.mjs/.test(String(g.command || ''));
  return (Array.isArray(gates) ? gates : []).filter((g) => g && g.id && !heavy(g)).map((g) => g.id);
}

const tokenOf = (env) => String(env.GH_TOKEN || env.GITHUB_TOKEN || '').trim();
/** The only branch name this module pushes or deletes. */
export const trainBranch = (id) => `train/${id}`;
const safeBranch = (b) => /^train\/[A-Za-z0-9._-]+$/.test(String(b || ''));

/** { owner, repo } of a github.com remote URL (https, ssh, scp-like), or null. */
export function parseGithubRemote(url) {
  const m = String(url || '').trim().match(/^(?:https?:\/\/(?:[^@/]+@)?github\.com\/|ssh:\/\/git@github\.com\/|git@github\.com:)([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+?)(?:\.git)?\/?$/);
  return m ? { owner: m[1], repo: m[2] } : null;
}

/**
 * The real client: GitHub REST (fetch) and git push. The token goes in a request header and, for the push, in git's
 * environment (GIT_CONFIG_* extraheader), never on a command line or in a log.
 */
export function githubClient({ root, owner, repo, token, remote = 'origin', fetchImpl = globalThis.fetch } = {}) {
  const api = async (method, p) => {
    const r = await fetchImpl(`https://api.github.com/repos/${owner}/${repo}${p}`, { method, headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', 'X-GitHub-Api-Version': '2022-11-28', 'User-Agent': 'studio-train' } });
    if (method === 'DELETE') { if (r.status !== 204 && r.status !== 422) throw new Error(`DELETE ${p}: HTTP ${r.status}`); return null; }
    if (r.status === 404) return null;
    if (!r.ok) throw new Error(`${method} ${p}: HTTP ${r.status}`);
    return r.json();
  };
  return {
    async repo() { const j = await api('GET', ''); if (!j) throw new Error('repo not found (or the token cannot see it)'); return { private: j.private !== false, visibility: j.visibility || (j.private ? 'private' : 'public') }; },
    async branchExists(branch) { if (!safeBranch(branch)) throw new Error(`refusing branch ${branch}`); return Boolean(await api('GET', `/git/ref/heads/${branch}`)); },
    async push(sha, branch) {
      if (!safeBranch(branch)) throw new Error(`refusing branch ${branch}`);
      const env = { ...process.env, GIT_TERMINAL_PROMPT: '0', GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.https://github.com/.extraheader', GIT_CONFIG_VALUE_0: `AUTHORIZATION: basic ${Buffer.from(`x-access-token:${token}`).toString('base64')}` };
      const r = spawnSync('git', ['push', '--quiet', remote, `${sha}:refs/heads/${branch}`], { windowsHide: true, cwd: root, env, encoding: 'utf8', timeout: 10 * 60000 });
      if (r.status !== 0) throw new Error(`git push exited ${r.status}: ${String(r.stderr || '').trim().split('\n').pop()}`);
    },
    async checkRuns(sha) { const j = await api('GET', `/commits/${sha}/check-runs?per_page=100`); return (j?.check_runs || []).map((c) => ({ name: c.name, status: c.status, conclusion: c.conclusion, url: c.html_url || null })); },
    async deleteBranch(branch) { if (!safeBranch(branch)) throw new Error(`refusing branch ${branch}`); await api('DELETE', `/git/refs/heads/${branch}`); },
  };
}

/**
 * Verify commit `sha` on the repo's CI. Returns { used: true, ok, why, runs, ms } (a CI result) or { used: false, why }
 * (fall back to the local verify). opts.client: an injected client; opts.now / opts.sleep: test clocks.
 */
export async function remoteVerify({ root, id, sha, env = process.env, client = null, log = () => {}, now = () => Date.now(), sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  if (remoteMode(env) === 'off') return { used: false, why: 'off' };
  const token = tokenOf(env);
  const scrub = (t) => (token ? String(t).split(token).join('***') : String(t));
  const branch = trainBranch(id);
  if (!safeBranch(branch)) return { used: false, why: `train id ${id} is not a safe branch name` };
  if (!token && !client) return { used: false, why: 'no GH_TOKEN or GITHUB_TOKEN in the environment' };
  let c = client;
  if (!c) {
    const u = spawnSync('git', ['remote', 'get-url', 'origin'], { windowsHide: true, cwd: root, encoding: 'utf8' });
    const gh = parseGithubRemote(u.stdout);
    if (!gh) return { used: false, why: 'origin is not a github.com repo' };
    c = githubClient({ root, ...gh, token });
  }
  const t0 = now();
  let created = false;
  try {
    const info = await c.repo();
    if (info.private) return { used: false, why: 'the repo is private: its CI would use paid minutes (STUDIO_VERIFY_REMOTE is for public repos)' };
    if (await c.branchExists(branch)) return { used: false, why: `${branch} already exists on origin: not touched` };
    await c.push(sha, branch);
    created = true;
    const pat = remoteCheckPattern(env);
    log(`remote verify: pushed ${String(sha).slice(0, 8)} to ${branch}; waiting for the repo's CI check ${pat} (up to ${Math.round(remoteTimeoutMs(env) / 60000)} min)`);
    for (;;) {
      const all = await c.checkRuns(sha);
      const runs = all.filter((r) => pat.test(String(r.name || '')));
      const waited = now() - t0;
      if (!runs.length && (waited >= remoteStartMs(env) || (all.length && all.every((r) => r.status === 'completed')))) return { used: false, why: `no CI check run named ${pat} on ${branch}${all.length ? ` (it ran ${all.map((r) => r.name).slice(0, 5).join(', ')})` : ` within ${Math.round(remoteStartMs(env) / 60000)} min`} (STUDIO_VERIFY_REMOTE_CHECK, STUDIO_VERIFY_REMOTE_START_MIN; does the workflow run on pushes to any branch?)` };
      if (runs.length && runs.every((r) => r.status === 'completed')) {
        const bad = runs.filter((r) => r.conclusion !== 'success');
        return { used: true, ok: !bad.length, runs, ms: now() - t0, why: bad.length ? `CI red: ${bad.map((r) => `${r.name} ${r.conclusion}`).join(', ')}` : `CI green: ${runs.map((r) => r.name).join(', ')}` };
      }
      if (waited >= remoteTimeoutMs(env)) return { used: false, why: `no CI result within ${Math.round(remoteTimeoutMs(env) / 60000)} min (STUDIO_VERIFY_REMOTE_TIMEOUT_MIN)` };
      await sleep(pollMs(env));
    }
  } catch (e) {
    return { used: false, why: `remote verify failed: ${scrub(e?.message || e).slice(0, 300)}` };
  } finally {
    if (created) {
      try { await c.deleteBranch(branch); } catch (e) { log(`remote verify: could not delete ${branch}: ${scrub(e?.message || e).slice(0, 200)}`); }
    }
  }
}

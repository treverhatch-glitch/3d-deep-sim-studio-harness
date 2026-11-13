/**
 * harness/hooks-upgrade-hint.mjs — 2.85 (e): the one fix when the hooks gate's unstamped commits came in with a harness
 * release merged by a plain `git merge`.
 *
 * A crew's overseer merged a harness release with `git merge` instead of `npm run upgrade -- --merge <ref>`. The release's
 * commits were made without this studio's hooks, so they carry no stamps; `upgrade --merge` lists them as exempt
 * (hook-stamp.mjs grandfatherRange), a plain merge does not. The hooks gate then refused every `task done`, and agents
 * wrote "only a person can fix this (git reset --soft ...)": a reset would have re-made the release's commits as the
 * studio's own. The fix is one command: `node harness/hook-stamp.mjs grandfather --ref <the release's remote ref>`.
 *
 * upgradeMergeHint(open, { cwd, base }) recognises the case and nothing wider: every unstamped commit is a merge M on the
 * studio's first-parent line, or reachable from M's second parent, where M changed package.json's "version" and touched
 * only harness-owned paths (HARNESS_OWNED below). It exempts nothing itself: it says the command and who may run it
 * (a person; in beta mode a stand-in may, by harness/beta-mode.mjs standInMay('protected'): the rule is not changed here).
 */
import { spawnSync } from 'node:child_process';

/** Paths a harness release owns (a release that touches anything else is not recognised: the hint stays silent). */
export const HARNESS_OWNED = /^(harness|scripts|qa|tools|docs|hub|templates|\.github|\.claude)\/|^(package\.json|package-lock\.json|[^/]+\.md|\.gitignore|\.gitattributes|\.npmrc|\.nvmrc)$/;
const git = (cwd, ...a) => spawnSync('git', ['-c', 'core.quotePath=false', ...a], { windowsHide: true, cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
const ok1 = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const versionAt = (cwd, rev) => { try { return JSON.parse(ok1(git(cwd, 'show', `${rev}:package.json`)) || 'null')?.version ?? null; } catch { return null; } };

/** Is merge M (parents p1, p2) a harness release merge? { ok, from, to, files } */
export function releaseMerge(cwd, m, p1) {
  const files = ok1(git(cwd, 'diff', '--name-only', p1, m)).split('\n').map((s) => s.trim()).filter(Boolean);
  if (!files.length || !files.includes('package.json') || !files.every((f) => HARNESS_OWNED.test(f))) return { ok: false, files };
  const from = versionAt(cwd, p1);
  const to = versionAt(cwd, m);
  return { ok: Boolean(to) && from !== to, from, to, files };
}

/** The remote-tracking refs holding sha (origin's first), or []. */
export function remoteRefsWith(cwd, sha) {
  const refs = ok1(git(cwd, 'for-each-ref', '--contains', sha, '--format=%(refname:short)', 'refs/remotes')).split('\n').map((s) => s.trim()).filter((s) => s && !/\/HEAD$/.test(s));
  return refs.sort((a, b) => Number(!a.startsWith('origin/')) - Number(!b.startsWith('origin/')));
}

/** Who may run the command, in words: { line, you }. */
export async function whoMayGrandfather({ env = process.env, root = undefined } = {}) {
  try {
    const bm = await import('./beta-mode.mjs');
    const me = String(env.STUDIO_LOCK_OWNER || '').trim();
    const si = me ? bm.standInMay('protected', { by: me, env, ...(root ? { root } : {}) }) : { ok: false };
    if (si.ok) return { you: true, line: `you may run it: ${si.who} is the owner's stand-in in beta mode (${si.via})` };
    const b = bm.readBeta(root ? { root } : {});
    if (b.on) return { you: false, line: `a person runs it, or in beta mode one of its stand-ins (${(b.doc?.agents || []).join(', ') || 'none named'}); not a worker` };
    return { you: false, line: 'a person runs it (beta mode is off); not an agent' };
  } catch { return { you: false, line: 'a person runs it' }; }
}

/**
 * open: the hooks gate's unstamped commits ([{ sha }]). base: the gate's base sha. Returns null, or { merge, ref, refs,
 * count, from, to, command, who, lines }.
 */
export async function upgradeMergeHint(open, { cwd = process.cwd(), base = null, env = process.env } = {}) {
  if (!Array.isArray(open) || !open.length) return null;
  const range = base ? `${base}..HEAD` : 'HEAD';
  const merges = ok1(git(cwd, 'log', '--merges', '--first-parent', '--format=%H %P', '-n', '200', range)).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length >= 3);
  const want = new Set(open.map((o) => String(o.sha || '').trim()).filter(Boolean));
  for (const [m, p1, p2] of merges) {
    const rel = releaseMerge(cwd, m, p1);
    if (!rel.ok) continue;
    const brought = new Set(ok1(git(cwd, 'rev-list', `${p1}..${p2}`)).split('\n').map((s) => s.trim()).filter(Boolean));
    brought.add(m);
    if (![...want].every((s) => brought.has(s))) continue;
    const refs = remoteRefsWith(cwd, p2);
    const ref = refs[0] || null;
    const command = `node harness/hook-stamp.mjs grandfather --ref ${ref || '<the release\'s remote-tracking ref, e.g. origin/main after git fetch>'}`;
    const who = await whoMayGrandfather({ env, root: cwd });
    const n = want.size;
    const lines = [
      `These ${n} unstamped commit(s) came in with the harness release ${rel.from || '?'} -> ${rel.to} merged by ${m.slice(0, 8)} with a plain git merge (npm run upgrade -- --merge <ref> lists a release's commits for this gate itself; a plain merge does not).`,
      `The one fix (no reset, no re-commit: they are the release's commits, not this studio's): ${command}`,
      `Who: ${who.line}. It lists the release's commits as exempt, nothing else.`,
    ];
    return { merge: m, ref, refs, count: n, from: rel.from, to: rel.to, command, who: who.line, you: who.you, lines };
  }
  return null;
}

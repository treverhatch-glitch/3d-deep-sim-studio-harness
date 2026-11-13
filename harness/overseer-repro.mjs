/**
 * harness/overseer-repro.mjs — 2.73.0 (f): `npm run workaround -- repro <H-id> --by <agent> --harness-repo <clone>
 * [--base <ref>] [--commit]`, the overseer's stage-1 work: a failing-test PR branch for the harness, from a harness task.
 *
 * In a SEPARATE clone of the harness repo (--harness-repo: never the studio, never inside it, never a lane copy; it must
 * look like the harness: harness/workaround.mjs and qa/selftest.mjs; its working tree clean) it makes the branch
 * repro/<h-id>-<sig> from --base (default: the clone's HEAD) and writes:
 *   qa/selftest-repro-<h-id>.mjs   a test in the harness's selftest style (export async function selftestRepro<H…>({ dir,
 *                                  run, report, tmpRoot })): a made-up studio copied from the harness, the task's evidence
 *                                  in its header, one check per recorded command of a safe shape (npm run <script> …, node
 *                                  harness|scripts|qa/<file>.mjs …: no shell operators) that it is accepted there, or one
 *                                  TODO check that fails when the task recorded none. A scaffold: whoever opens the PR
 *                                  makes it reproduce the evidence (it must FAIL on the current harness).
 *   .studio/repro/<H-id>-PR.md     the PR body: the task, its evidence, a checklist, and the trailers (Repro-Of,
 *                                  Repro-Signature, Overseer-By) that `npm run overseer` counts once the PR reaches the
 *                                  harness and the studio takes the update. (.studio/ is not committed.)
 * The test file is staged; --commit commits it with those trailers through the clone's hooks. Nothing is pushed.
 *
 * Who: an agent from overseer stage 1 (studio/overseer.json, as committed); a person (a harness maintainer) at any stage;
 * never a game-builder session (a worker STUDIO_ROLE). Records a harness.repro_scaffolded event in the studio.
 * Paperwork: no model, no network. UNTESTED on Windows: the clone's path checks use real paths, lower-cased there.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { clean, readTasks } from './workaround.mjs';
import { readOverseer } from './overseer.mjs';

const WORKER_ROLES = new Set(['builder', 'qa', 'qa-playtester', 'artist', 'art', 'reviewer', 'tester', 'designer', 'sound', 'writer', 'playtester']);
const git = (cwd, args, env = process.env) => spawnSync('git', ['-c', 'core.quotePath=false', ...args], { cwd, encoding: 'utf8', env, maxBuffer: 32 * 1024 * 1024, windowsHide: true });
const out1 = (r) => (r.status === 0 ? String(r.stdout || '').trim() : '');
const real = (p) => { let r = path.resolve(p); try { r = fs.realpathSync.native(p); } catch {} return process.platform === 'win32' ? r.toLowerCase() : r; };
const inside = (child, parent) => { const rel = path.relative(parent, child); return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel)); };

/** A recorded command the scaffold may run in its made-up studio: npm run <script> … or node <harness|scripts|qa file> …, no shell operators. */
export function safeCommand(cmd) {
  const c = String(cmd || '').trim();
  if (!c || c.length > 200) return false;
  if (/[;&|<>`$\\\r\n(){}*?!~]/.test(c)) return false;
  if ((c.match(/"/g) || []).length % 2 || c.includes("'")) return false;
  return /^(npm run [\w:.-]+( -- .*)?|node (harness|scripts|qa)\/[\w./-]+\.mjs( .*)?)$/.test(c) && !/\.\./.test(c);
}

/** npm run <script> -- args -> the script's node command (the selftest runs node directly). */
export function nodeCommand(cmd, scripts = {}) {
  const m = String(cmd).match(/^npm run ([\w:.-]+)(?: -- (.*))?$/);
  if (!m) return cmd;
  const s = String(scripts[m[1]] || '');
  if (!/^node [\w./-]+\.mjs( [\w./-]+)*$/.test(s)) return null;
  return `${s}${m[2] ? ` ${m[2]}` : ''}`;
}

const idPart = (id) => String(id).toLowerCase().replace(/[^a-z0-9]+/g, '-');
const fnName = (id) => `selftestRepro${String(id).replace(/[^A-Za-z0-9]/g, '')}`;
const comment = (s) => clean(s, 300).replace(/\*\//g, '* /');

export function reproTestText(t, { commands, by, now = Date.now(), harnessVersion = '?' }) {
  const id = t.id;
  const fn = fnName(id);
  const ev = [...(t.evidence || [])].reverse().slice(0, 5);
  return `/**
 * qa/selftest-repro-${idPart(id)}.mjs — a failing reproduction of the studio's harness task ${id}: ${comment(t.title)}
 * Signature \`${comment(t.signature)}\` (${comment(t.sig)}), seen ${Number(t.occurrences) || 0} time(s), first ${comment(t.firstSeen || '?')}, last ${comment(t.lastSeen || '?')}.
 * SCAFFOLD written by \`npm run workaround -- repro ${id} --by ${comment(by)}\` on ${new Date(now).toISOString().slice(0, 10)} (harness ${comment(harnessVersion)}).
 *
 * What the harness did wrong (as reported): ${(t.why || []).map(comment).join(' | ') || '(not said)'}
 * Evidence (latest first, secrets removed by the studio):
${ev.map((e) => ` *   - ${comment(e)}`).join('\n') || ' *   - (none recorded)'}
 *
 * To finish it: make the made-up studio below reproduce the evidence, so the check FAILS on the current harness and
 * PASSES once the harness is fixed (say in the PR which line fails). Made-up studios only: no game content, no network.
 * Register it in qa/selftest.mjs after the last registration block (the same pattern), as every selftest file is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';

export const REPRO = ${JSON.stringify({ task: id, signature: clean(t.signature, 200), sig: clean(t.sig, 40), commands }, null, 2)};

export async function ${fn}({ dir, run, report, tmpRoot }) {
  const out = (r) => \`\${r.stdout || ''}\${r.stderr || ''}\`;
  const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
  const g = (cwd, args) => spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, ...ident } });
  // A made-up studio: a copy of the harness under test, its own git repo, a fresh event log.
  const S = path.join(tmpRoot, \`repro-${idPart(id)}-\${process.pid}\`);
  fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\\\/](\\.git|\\.lanes|node_modules)$/.test(src) });
  const nm = path.join(dir, 'node_modules');
  if (fs.existsSync(nm)) { try { fs.symlinkSync(fs.realpathSync(nm), path.join(S, 'node_modules'), 'junction'); } catch {} }
  const events = path.join(S, '.studio', 'events-repro-${idPart(id)}.jsonl');
  fs.mkdirSync(path.dirname(events), { recursive: true }); fs.writeFileSync(events, '');
  g(S, ['init', '-q', '-b', 'main']); g(S, ['config', 'core.autocrlf', 'false']);
  g(S, ['add', '-A']); g(S, ['commit', '-qm', 'studio', '--no-verify']);
  const env = { STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', STUDIO_ROLE: '', AGENT_EVENTS_FILE: events, STUDIO_OWNER_KEY: path.join(tmpRoot, \`no-owner-key-repro-\${process.pid}.pem\`), ...ident };
  // TODO: set up what the evidence shows (the board, a lane, the files the command meets) before the commands run.
  ${commands.length ? `for (const cmd of REPRO.commands) {
    const r = run(S, cmd, env);
    report(\`repro ${id}: \\\`\${cmd}\\\` is accepted in a made-up studio (the workaround \${REPRO.signature}; fails while the harness refuses it)\`, r.status === 0, out(r).slice(-1500));
  }` : `report('repro ${id}: TODO reproduce the evidence above (the task recorded no command to run)', false, 'scaffold: write the reproduction; it must fail on the current harness');`}
  try { fs.rmSync(S, { recursive: true, force: true, maxRetries: 4, retryDelay: 300 }); } catch {}
}
`;
}

export function prBodyText(t, { by, branch, base, file, stage }) {
  const ev = [...(t.evidence || [])].reverse().slice(0, 5);
  return [
    `## Repro: ${t.id} ${clean(t.title, 120)}`,
    '',
    `A failing test only (overseer stage ${stage}: no fix in this PR). Branch \`${branch}\` from \`${base.slice(0, 12)}\`.`,
    '',
    `- Harness task: ${t.id} in the studio's studio/HARNESS-TASKS.md; signature \`${clean(t.signature, 200)}\` (${clean(t.sig, 40)}), seen ${Number(t.occurrences) || 0} time(s), first ${clean(t.firstSeen || '?', 40)}, last ${clean(t.lastSeen || '?', 40)}; by ${(t.by || []).map((x) => clean(x, 60)).join(', ') || '?'}`,
    `- What the harness did wrong (as reported): ${(t.why || []).map((x) => clean(x, 300)).join(' | ') || '(not said)'}`,
    ...(t.commands?.length ? [`- Commands: ${t.commands.map((c) => `\`${clean(c, 200)}\``).join(', ')}`] : []),
    '- Evidence (latest first, secrets removed):',
    ...(ev.length ? ev.map((e) => `  - ${clean(e, 300)}`) : ['  - (none recorded)']),
    '',
    '### The test',
    `\`${file}\`: FAILS on \`${base.slice(0, 12)}\` (paste the FAIL line here) and passes once the harness is fixed.`,
    '',
    '### Checklist',
    '- [ ] the check fails on the current harness (the FAIL line is pasted above)',
    '- [ ] made-up studios only: no game content, no network, no keys or tokens',
    '- [ ] registered in qa/selftest.mjs after the last registration block',
    '- [ ] no gate or protected file change (those stay the owner\'s)',
    '',
    'Keep these lines in the merge or squash commit message (npm run overseer counts them):',
    '',
    `Repro-Of: ${t.id}`,
    `Repro-Signature: ${clean(t.sig, 40)}`,
    `Overseer-By: ${clean(by, 60)}`,
    '',
  ].join('\n');
}

/** The scaffold. Returns { ok, code, lines, branch?, file?, body? }. */
export async function reproScaffold({ id, by, harnessRepo, base = null, commit = false, env = process.env, root = REPO_ROOT, now = Date.now() } = {}) {
  const stop = (why, code = 1) => ({ ok: false, code, lines: [`[repro] Not scaffolded: ${why}`] });
  if (!id || !String(by || '').trim() || !harnessRepo) return stop('Usage: npm run workaround -- repro <H-id> --by <agent> --harness-repo <a separate clone of the harness> [--base <ref>] [--commit]', 2);
  if (WORKER_ROLES.has(String(env.STUDIO_ROLE || '').toLowerCase())) return stop(`a ${env.STUDIO_ROLE} session doesn't write harness PRs; harness tasks are for whoever maintains the harness`);
  const who = String(by).trim();
  let agentLike = true;
  try { agentLike = (await import('./agent-env.mjs')).agentLikeName(who, { stateDir: path.join(root, '.studio') }); } catch { agentLike = true; }
  const o = readOverseer(root);
  const isOverseer = o.agent && o.agent.toLowerCase() === who.toLowerCase();
  if ((agentLike || isOverseer) && o.stage < 1) return stop(`${who} is an agent and the overseer stage is ${o.stage} (reporter: it logs workarounds). Repro PRs start at stage 1, which the owner sets in studio/overseer.json (npm run overseer shows whether its criteria hold)`);
  const t = readTasks().tasks.find((x) => x.id.toLowerCase() === String(id).toLowerCase());
  if (!t) return stop(`no harness task ${id} (npm run workaround -- tasks --all)`);
  // The clone: a separate harness checkout, never the studio or anything inside it.
  const dir = path.resolve(String(harnessRepo));
  if (!fs.existsSync(dir)) return stop(`--harness-repo ${dir} doesn't exist: clone the harness there first (git clone <the harness repo> <dir>)`);
  const top = out1(git(dir, ['rev-parse', '--show-toplevel']));
  if (!top) return stop(`${dir} isn't a git checkout: clone the harness there first`);
  const studioTop = out1(git(root, ['rev-parse', '--show-toplevel'])) || root;
  if (inside(real(top), real(studioTop)) || inside(real(studioTop), real(top))) return stop(`${top} is the studio or inside it (a lane copy, its installed harness): use a SEPARATE clone of the harness repo`);
  if (out1(git(top, ['rev-parse', '--git-common-dir'])) && real(path.resolve(top, out1(git(top, ['rev-parse', '--git-common-dir'])))) === real(path.resolve(studioTop, out1(git(studioTop, ['rev-parse', '--git-common-dir'])) || '.git'))) return stop(`${top} shares the studio's git folder (a worktree of it): use a SEPARATE clone of the harness repo`);
  if (!fs.existsSync(path.join(top, 'harness', 'workaround.mjs')) || !fs.existsSync(path.join(top, 'qa', 'selftest.mjs'))) return stop(`${top} doesn't look like the harness repo (no harness/workaround.mjs and qa/selftest.mjs)`);
  const dirty = String(git(top, ['status', '--porcelain', '--untracked-files=no']).stdout || '').split('\n').filter((l) => l.length > 3);
  if (dirty.length) return stop(`the clone has uncommitted changes (${dirty.slice(0, 3).map((l) => l.slice(3)).join(', ')}): commit or put them aside there first; this never stashes`);
  const baseSha = out1(git(top, ['rev-parse', '--verify', '--quiet', `${base || 'HEAD'}^{commit}`]));
  if (!baseSha) return stop(`--base ${base || 'HEAD'} doesn't name a commit in the clone (git fetch there first)`);
  const branch = `repro/${idPart(t.id)}-${String(t.sig || 'x').replace(/[^\w-]/g, '').slice(0, 8)}`;
  if (out1(git(top, ['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`]))) return stop(`the clone already has the branch ${branch}: finish that one, or delete it there (git branch -D ${branch}) to start again`);
  let scripts = {};
  try { scripts = JSON.parse(fs.readFileSync(path.join(top, 'package.json'), 'utf8')).scripts || {}; } catch {}
  const commands = [...new Set((t.commands || []).filter(safeCommand).map((c) => nodeCommand(c, scripts)).filter(Boolean))].slice(0, 5);
  let harnessVersion = '?';
  try { harnessVersion = JSON.parse(git(top, ['show', `${baseSha}:package.json`]).stdout).version || '?'; } catch {}
  const co = git(top, ['checkout', '-q', '-b', branch, baseSha]);
  if (co.status !== 0) return stop(`git checkout -b ${branch} failed in the clone: ${String(co.stderr || '').trim().slice(0, 300)}`);
  const rel = `qa/selftest-repro-${idPart(t.id)}.mjs`;
  fs.writeFileSync(path.join(top, ...rel.split('/')), reproTestText(t, { commands, by: who, now, harnessVersion }));
  const bodyRel = `.studio/repro/${t.id}-PR.md`;
  const bodyFile = path.join(top, ...bodyRel.split('/'));
  fs.mkdirSync(path.dirname(bodyFile), { recursive: true });
  fs.writeFileSync(bodyFile, prBodyText(t, { by: who, branch, base: baseSha, file: rel, stage: o.stage }));
  git(top, ['add', '--', rel]);
  const lines = [`[repro] ${t.id}: branch ${branch} in ${top} (from ${baseSha.slice(0, 10)}), ${rel} written and staged (${commands.length ? `${commands.length} command check(s)` : 'one TODO check'}); PR body in ${bodyFile}.`];
  let committed = null;
  if (commit) {
    const msg = `test: failing repro of studio harness task ${t.id} (${clean(t.title, 80)})\n\nRepro-Of: ${t.id}\nRepro-Signature: ${clean(t.sig, 40)}\nOverseer-By: ${who}\n`;
    const c = spawnSync('git', ['commit', '-q', '-F', '-'], { cwd: top, input: msg, encoding: 'utf8', env, windowsHide: true });
    if (c.status !== 0) lines.push(`[repro] not committed: the clone's hooks refused it: ${`${c.stdout || ''}${c.stderr || ''}`.trim().split('\n').slice(-4).join(' / ').slice(0, 400)}`);
    else committed = out1(git(top, ['rev-parse', 'HEAD']));
  }
  lines.push(committed ? `[repro] committed ${committed.slice(0, 10)} with Repro-Of / Repro-Signature / Overseer-By. Next: make the check reproduce the evidence (it must FAIL on ${baseSha.slice(0, 10)}), push the branch and open the PR with that body.` : `[repro] Next: make the check reproduce the evidence (it must FAIL on ${baseSha.slice(0, 10)}), then commit with the trailers the PR body lists (Repro-Of: ${t.id}, Overseer-By: ${who}), push the branch and open the PR with that body.`);
  try { emitEvent({ type: 'harness.repro_scaffolded', agent: who.slice(0, 60), msg: `Repro scaffold for harness task ${t.id} on branch ${branch} (a separate harness clone)${committed ? `, committed ${committed.slice(0, 10)}` : ''}`.slice(0, 400), meta: { task: t.id, sig: t.sig, branch, base: baseSha, file: rel, by: who, stage: o.stage, committed } }); } catch {}
  return { ok: true, code: 0, lines, branch, file: rel, body: bodyFile, commit: committed };
}

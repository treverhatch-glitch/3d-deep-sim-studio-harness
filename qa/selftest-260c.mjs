/**
 * qa/selftest-260c.mjs — 2.60.0 (#3, #4): the upgrade path for an orchestrator, and the hooks gate vs an unmerged
 * harness ref.
 *
 * #3: `npm run upgrade -- --snapshot` didn't exist on the old main (it arrives with the upgrade); the documented merge
 * was refused by the main-checkout guard, so the orchestrator used the raw STUDIO_MAIN_COMMIT=allow override; a bundle
 * merge that brings goldens needs a Golden-Reason; an old stash's board rows had no helper. Now: a bootstrap one-liner
 * runs the new guard from the ref (and the guard finds the studio by git, not by its own folder); `--merge <ref> --by
 * <person> [--permission]` backs up, merges through the hooks with the guard opened for exactly that merge, and records
 * who and on whose permission; `--restore-stash <sha>` keeps both sides' rows and never drops.
 * #4: STUDIO_HARNESS_REF=<remote>/<branch> exempts the harness branch's own commits, as the remote has them.
 *
 * Fixture: the copied harness is the harness repo (H), a bare clone is its remote, the studio (S) is a clone of that
 * remote with the hooks installed and one lane copy (so the main-checkout guard is on). No network.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest260C({ dir, run, report, tmpRoot }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const q = (p) => JSON.stringify(p);
  const base = path.join(tmpRoot, `c260-${process.pid}`);
  fs.mkdirSync(base, { recursive: true });
  const U = path.join(base, 'upstream.git');
  const S = path.join(base, 'studio');
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const env = {
    ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '',
    STUDIO_MAIN_COMMIT: '', STUDIO_UPGRADE_MERGE: '', STUDIO_HARNESS_REF: '', STUDIO_MAIN_ROOT: '', STUDIO_PROTECT_BASE: '', STUDIO_PROTECT_ROOT: '',
    STUDIO_HOOKS_CHECK: '', STUDIO_LANE_HARNESS: '', GITHUB_BASE_REF: '', GITHUB_EVENT_NAME: '', AGENT_EVENTS_FILE: '', STUDIO_EXPERIMENT: '', STUDIO_AGENT_MODEL: '',
    STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', GIT_TERMINAL_PROMPT: '0',
  };
  const g = (cwd, args, e = {}) => run(cwd, `git -c core.autocrlf=false ${args}`, { ...env, ...e });
  const sg = (args, e = {}) => g(S, args, e);
  const upgrade = (args, e = {}) => run(S, `node harness/upgrade-guard.mjs ${args}`, { ...env, ...e });
  // Quoted: cmd.exe (Windows) treats ^ as its escape character, so HEAD^2 would reach git as HEAD2.
  const head = (rev = 'HEAD') => sg(`rev-parse "${rev}"`).stdout.trim();
  const body = (rev = 'HEAD') => sg(`log -1 --format=%B ${rev}`).stdout;
  const write = (root, rel, text) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
  const read = (rel) => fs.readFileSync(path.join(S, rel), 'utf8');
  const golden = (n) => `${JSON.stringify(Object.fromEntries(Array.from({ length: 12 }, (_, i) => [`k${i}`, i === 1 ? n.a : i === 10 ? n.b : i])), null, 2)}\n`;
  const PERM = 'Hatch on Discord 2026-11-01 19:09, take the harness update now';
  const version = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')).version;
  const bump = (v) => { const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8')); pkg.version = v; write(dir, 'package.json', `${JSON.stringify(pkg, null, 2)}\n`); };

  // ---- the harness repo (H = the copied tree) and its remote ----
  g(dir, 'init -q -b main');
  write(dir, 'qa/golden/shared.json', golden({ a: 'one', b: 'ten' }));
  // The board as a studio has it (the self-test's copy may hold a fixture board without DONE.md).
  for (const [rel, heading] of [['studio/NEXT.md', '## BACKLOG\n'], ['studio/DONE.md', '## DONE\n']]) {
    const now = fs.existsSync(path.join(dir, rel)) ? fs.readFileSync(path.join(dir, rel), 'utf8').replace(/\r\n/g, '\n') : '';
    write(dir, rel, now.includes(heading) ? now : `${now}\n${heading}`);
  }
  g(dir, 'add -A');
  g(dir, 'commit -q --no-verify -m "harness base"');
  g(dir, `clone -q --bare ${q(dir)} ${q(U)}`);
  g(dir, `remote add origin ${q(U)}`);
  // claude/260: a new version, a harness file, a new golden, and a change to a golden the studio also changed.
  g(dir, 'checkout -q -b claude/260');
  bump('2.60.0');
  write(dir, 'harness/new-in-260.txt', 'new in 2.60.0\n');
  write(dir, 'qa/golden/upgrade-new.json', '{ "recorded": 1 }\n');
  write(dir, 'qa/golden/shared.json', golden({ a: 'one', b: 'TEN (harness)' }));
  g(dir, 'add -A');
  g(dir, 'commit -q --no-verify -m "2.60.0: the harness release commit (no stamp)"');
  g(dir, 'checkout -q -b claude/260b');
  bump('2.60.1');
  write(dir, 'harness/new-in-260b.txt', 'new in 2.60.1\n');
  g(dir, 'add -A');
  g(dir, 'commit -q --no-verify -m "2.60.1: a follow-up"');
  g(dir, 'checkout -q -b claude/260c');
  write(dir, 'README.md', `harness readme line one, changed upstream\n${fs.readFileSync(path.join(dir, 'README.md'), 'utf8')}`);
  g(dir, 'commit -q --no-verify -am "2.60.2: readme"');
  g(dir, 'push -q origin claude/260 claude/260b claude/260c');

  // ---- the studio: a clone of the harness remote, hooks installed, one lane copy ----
  g(base, `clone -q ${q(U)} ${q(S)}`);
  try { fs.symlinkSync(fs.realpathSync(path.join(dir, 'node_modules')), path.join(S, 'node_modules'), 'junction'); } catch {}
  sg('config core.autocrlf false');
  sg('config core.hooksPath scripts/hooks');
  write(S, 'qa/golden/shared.json', golden({ a: 'ONE (studio)', b: 'ten' }));
  const studioGolden = sg('commit -q -am "studio: re-record shared" -m "Golden-Reason: the studio\'s own retune moves k1"');
  sg('worktree add -q .lanes/builder-1 -b lane/builder-1');
  write(S, 'studio/NEXT.md', read('studio/NEXT.md').replace('## BACKLOG\n', '## BACKLOG\n- [ ] **T-100** [P1] (`builder`) — studio work queued this morning\n'));
  sg('commit -q -am "board: T-100"');

  // ---- 3a: bootstrap — the new guard, run from a copy outside harness/, works on the studio it runs in ----
  const elsewhere = path.join(base, 'elsewhere');
  fs.mkdirSync(elsewhere, { recursive: true });
  fs.copyFileSync(path.join(dir, 'harness', 'upgrade-guard.mjs'), path.join(elsewhere, 'upgrade-guard.mjs'));
  fs.appendFileSync(path.join(S, 'studio/DONE.md'), '- [x] **T-099** finished, row not committed\n');
  const copyDirty = run(S, `node ${q(path.join(elsewhere, 'upgrade-guard.mjs'))} --check`, env);
  sg('commit -q -am "board: T-099 row"');
  const copyClean = run(S, `node ${q(path.join(elsewhere, 'upgrade-guard.mjs'))} --check`, env);
  const rel = fs.readFileSync(path.join(dir, 'docs/RELEASE.md'), 'utf8');
  const oneLiner = (rel.split('\n').find((l) => /node -e ".*upgrade-guard\.mjs/.test(l)) || '').replace(/^[\s>*`-]+|`\s*$/g, '').replace(/<ref>/g, 'origin/claude/260');
  const boot = oneLiner ? run(S, oneLiner, env) : { status: 1, stdout: '', stderr: 'no node -e one-liner in docs/RELEASE.md' };
  const bootCheck = run(S, 'node .studio/upgrade-guard.mjs --check', env);
  report('2.60.0 (#3a): the upgrade guard copied outside harness/ checks the studio it runs in (found by git, not by its own folder): refuses an uncommitted board row, passes once committed; RELEASE.md\'s node one-liner writes the ref\'s guard to .studio/ and it runs there',
    copyDirty.status === 1 && /STOP: 1 board file/.test(out(copyDirty)) && /studio\/DONE\.md/.test(out(copyDirty))
      && copyClean.status === 0 && /OK: every board file is committed/.test(out(copyClean))
      && boot.status === 0 && bootCheck.status === 0 && /OK: every board file is committed/.test(out(bootCheck)),
    `${out(copyDirty)}\n---\n${out(copyClean)}\n---one-liner: ${oneLiner}\n${out(boot)}\n${out(bootCheck)}`);

  // ---- 3b: who may merge ----
  const before = head();
  const worker = upgrade(`--merge origin/claude/260 --by hatch --permission "${PERM}"`, { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' });
  const workerShell = upgrade(`--merge origin/claude/260 --by hatch --permission "${PERM}"`, { STUDIO_LOCK_OWNER: 'builder-s3' });
  const noPerm = upgrade('--merge origin/claude/260 --by hatch', { CLAUDECODE: '1' });
  const agentBy = upgrade(`--merge origin/claude/260 --by opus-bot --permission "${PERM}"`, { CLAUDECODE: '1' });
  report('2.60.0 (#3b): upgrade --merge refuses a worker (a builder session or a worker\'s shell) even with --permission, an agent without --permission, and --by naming an agent; nothing merged, no backup made',
    worker.status === 1 && /builder session can't/.test(out(worker)) && workerShell.status === 1 && /builder-s3 is a worker agent/.test(out(workerShell))
      && noPerm.status === 1 && /needs the person's direct permission/.test(out(noPerm)) && agentBy.status === 1 && /agent's name/.test(out(agentBy))
      && head() === before && !sg('branch --list backup/*').stdout.trim(),
    [worker, workerShell, noPerm, agentBy].map(out).join('\n---\n'));

  // The documented raw merge is refused by the main-checkout guard (why --merge exists).
  sg('merge -q --no-ff --no-commit origin/claude/260');
  const raw = sg('commit -m "merge the harness by hand"');
  sg('merge --abort');

  // A golden the merge combined with the studio's own change needs a person's reason; a golden straight from the ref doesn't.
  const combined = upgrade('--merge origin/claude/260 --by hatch');
  const afterCombined = { head: head(), merging: sg('rev-parse -q --verify MERGE_HEAD').status === 0 };
  const sha260 = sg('rev-parse origin/claude/260').stdout.trim();
  const person = upgrade('--merge origin/claude/260 --by hatch --golden-reason "the 2.60.0 sim fix moves k10; k1 stays the studio\'s"');
  const msg1 = body();
  const fromRefLine = (msg1.match(/^Golden-Reason: from origin\/claude\/260 \(upgrade\):.*$/m) || [''])[0];
  const events = (() => { try { return fs.readFileSync(path.join(S, '.studio', 'events.jsonl'), 'utf8'); } catch { return ''; } })();
  report('2.60.0 (#3b): a person\'s upgrade --merge backs main up as backup/pre-<version>, merges through the hooks (the merge is stamped) and records Upgrade-By / Upgrade-Recorded-By / Upgrade-Ref / Upgrade-Versions in the merge commit and an upgrade.merged event; the raw merge is refused by the main-checkout guard',
    studioGolden.status === 0 && /only studio\/ notes and the board/.test(out(raw)) && raw.status !== 0
      && person.status === 0 && head('HEAD^2') === sha260 && head('HEAD^1') === before && head('backup/pre-2.60.0') === before
      && /^Upgrade-By: hatch$/m.test(msg1) && /^Upgrade-Recorded-By: a person's terminal$/m.test(msg1) && new RegExp(`^Upgrade-Ref: origin/claude/260 ${sha260}$`, 'm').test(msg1)
      && new RegExp(`^Upgrade-Versions: ${version.replace(/\./g, '\\.')} -> 2\\.60\\.0$`, 'm').test(msg1) && !/^Upgrade-Permission:/m.test(msg1)
      && /^Studio-Hooks: v\w+ t\w+ merge$/m.test(msg1) && /"type":"upgrade\.merged"/.test(events),
    `${out(raw).slice(-300)}\n---\n${out(person)}\n---\n${msg1}`);
  report('2.60.0 (#3c): upgrade --merge adds "Golden-Reason: from <ref> (upgrade)" only for goldens that come unchanged from the ref; a golden combined with the studio\'s change is refused (merge undone) until a person gives --golden-reason',
    combined.status === 1 && /golden file\(s\) differ from origin\/claude\/260's/.test(out(combined)) && /qa\/golden\/shared\.json/.test(out(combined)) && !/upgrade-new/.test(out(combined))
      && afterCombined.head === before && !afterCombined.merging
      && /qa\/golden\/upgrade-new\.json/.test(fromRefLine) && !/shared\.json/.test(fromRefLine) && /^Golden-Reason: the 2\.60\.0 sim fix moves k10.*shared\.json/m.test(msg1),
    `${out(combined)}\n---\n${msg1}`);

  // The allowance is for that merge only: the same variable doesn't let a plain commit through.
  fs.appendFileSync(path.join(S, 'README.md'), 'studio edit on main\n');
  sg('add README.md');
  const sneak = sg('commit -m "game work on main"', { STUDIO_UPGRADE_MERGE: sha260 });
  sg('reset -q HEAD README.md'); sg('checkout -q -- README.md');
  report('2.60.0 (#3b): the main-checkout guard opened for the upgrade merge commit (no STUDIO_MAIN_COMMIT=allow anywhere) and only for it: STUDIO_UPGRADE_MERGE=<the merged commit> doesn\'t let an ordinary commit on main through',
    person.status === 0 && head('HEAD^2') === sha260 && sneak.status !== 0 && /only studio\/ notes and the board/.test(out(sneak)), out(sneak));

  // An agent outside the harness, on the owner's permission.
  const before2 = head();
  const bot = upgrade(`--merge origin/claude/260b --by hatch --permission "${PERM}"`, { CLAUDECODE: '1' });
  const msg2 = body();
  report('2.60.0 (#3b): an agent outside the harness merges on the owner\'s permission: Upgrade-Permission and Upgrade-Recorded-By (the coding agent) are in the merge commit; backup/pre-2.60.1 made',
    bot.status === 0 && head('HEAD^1') === before2 && head('backup/pre-2.60.1') === before2 && new RegExp(`^Upgrade-Permission: ${PERM}$`, 'm').test(msg2)
      && /^Upgrade-Recorded-By: a coding agent \(CLAUDECODE\)$/m.test(msg2) && /^Upgrade-By: hatch$/m.test(msg2),
    `${out(bot)}\n---\n${msg2}`);

  // A conflict stops, lists the files, advises git merge --abort, resolves nothing.
  write(S, 'README.md', `studio readme line one\n${read('README.md')}`);
  sg('commit -q -am "studio readme"', { STUDIO_MAIN_COMMIT: 'allow' });
  const before3 = head();
  const clash = upgrade('--merge origin/claude/260c --by hatch');
  const stillMerging = sg('rev-parse -q --verify MERGE_HEAD').status === 0;
  const markers = /^<<<<<<< /m.test(read('README.md'));
  sg('merge --abort');
  report('2.60.0 (#3b): a merge that conflicts stops: the files are listed with the git merge --abort advice, nothing is committed or resolved',
    clash.status === 1 && /conflicts in 1 file/.test(out(clash)) && /^\s+README\.md$/m.test(out(clash)) && /git merge --abort/.test(out(clash)) && head() === before3 && stillMerging && markers,
    out(clash));

  // ---- 3d: an old stash's board rows, both sides kept, never dropped ----
  write(S, 'studio/NEXT.md', read('studio/NEXT.md').replace('## BACKLOG\n', '## BACKLOG\n- [ ] **T-201** [P1] (`builder`) — added before the upgrade, stashed\n'));
  write(S, 'studio/DONE.md', read('studio/DONE.md').replace('## DONE\n', '## DONE\n- [x] **T-198** [P1] (`builder`) — finished before the upgrade, stashed\n'));
  sg('stash push -q -m "pre-upgrade-260c" -- studio/NEXT.md studio/DONE.md');
  const stashSha = sg('rev-parse stash@{0}').stdout.trim();
  write(S, 'studio/NEXT.md', read('studio/NEXT.md').replace('## BACKLOG\n', '## BACKLOG\n- [ ] **T-202** [P1] (`builder`) — added after the upgrade\n'));
  write(S, 'studio/DONE.md', read('studio/DONE.md').replace('## DONE\n', '## DONE\n- [x] **T-199** [P1] (`builder`) — finished after the upgrade\n'));
  sg('commit -q -am "board: rows after the upgrade"');
  const before4 = head();
  const restore = upgrade(`--restore-stash ${stashSha} --by hatch`);
  const next = read('studio/NEXT.md');
  const done = read('studio/DONE.md');
  const kept = sg('stash list --format=%H').stdout.includes(stashSha);
  report('2.60.0 (#3d): upgrade --restore-stash merges the stash\'s board rows into the committed board keeping both sides (NEXT.md and DONE.md), commits, keeps the stash and only prints the git stash drop to run',
    restore.status === 0 && /T-201/.test(next) && /T-202/.test(next) && /T-100/.test(next) && /T-198/.test(done) && /T-199/.test(done) && !/<<<<<<<|>>>>>>>/.test(next + done)
      && head('HEAD^1') === before4 && new RegExp(`^Upgrade-Restored-Stash: ${stashSha}$`, 'm').test(body()) && kept && /git stash drop stash@\{0\}/.test(out(restore)) && /The stash is kept/.test(out(restore)),
    `${out(restore)}\n---\n${next}\n---\n${done}`);

  // A conflict on a line that isn't a task row is refused, listed, nothing written.
  write(S, 'studio/NEXT.md', read('studio/NEXT.md').replace('## BACKLOG\n', '## BACKLOG (stashed heading)\n'));
  sg('stash push -q -m "heading-260c" -- studio/NEXT.md');
  const headingSha = sg('rev-parse stash@{0}').stdout.trim();
  write(S, 'studio/NEXT.md', read('studio/NEXT.md').replace('## BACKLOG\n', '## BACKLOG (main heading)\n'));
  sg('commit -q -am "board: heading"');
  const before5 = head();
  const nextBefore = read('studio/NEXT.md');
  const refuse = upgrade(`--restore-stash ${headingSha} --by hatch`);
  report('2.60.0 (#3d): --restore-stash refuses and lists a conflict on a line that isn\'t a task row, writing nothing; a worker can\'t run it',
    refuse.status === 1 && /studio\/NEXT\.md: both sides changed a line that isn't a task row/.test(out(refuse)) && head() === before5 && read('studio/NEXT.md') === nextBefore
      && sg('stash list --format=%H').stdout.includes(headingSha) && upgrade(`--restore-stash ${headingSha} --by hatch`, { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s3' }).status === 1,
    out(refuse));

  // ---- #4: STUDIO_HARNESS_REF ----
  const hooks = (e = {}) => run(S, 'node harness/hook-stamp.mjs check', { ...env, ...e });
  const noRef = hooks();
  write(S, '.env', 'STUDIO_HARNESS_REF=origin/claude/260b\n');
  const withRef = hooks();
  fs.rmSync(path.join(S, '.env'));
  const sha260b = sg('rev-parse origin/claude/260b').stdout.trim();
  report('2.60.0 (#4): the hooks gate lists the harness branch\'s unstamped release commits; with STUDIO_HARNESS_REF=origin/claude/260b in .env (confirmed on the remote) they are exempt and the output names the ref and commit used',
    noRef.status === 1 && /2\.60\.0: the harness release commit/.test(out(noRef))
      && withRef.status === 0 && new RegExp(`STUDIO_HARNESS_REF=origin/claude/260b \\(${sha260b.slice(0, 10)}, confirmed on origin\\): 2 harness commit\\(s\\) exempt`).test(out(withRef)),
    `${out(noRef).slice(0, 1200)}\n---\n${out(withRef).slice(0, 1200)}`);

  // An agent's local branch with the same name, and a remote-tracking ref moved by hand, don't count.
  const tree = head('HEAD^{tree}');
  const fake = sg(`commit-tree ${tree} -p HEAD -m "local work dressed as the harness"`).stdout.trim();
  sg(`branch origin/claude/zz ${fake}`);
  sg(`merge -q --no-ff ${fake} -m "merge the local branch"`);
  const local = hooks({ STUDIO_HARNESS_REF: 'origin/claude/zz' });
  sg(`update-ref refs/remotes/origin/claude/zz ${fake}`);
  const forged = hooks({ STUDIO_HARNESS_REF: 'origin/claude/zz' });
  const both = hooks({ STUDIO_HARNESS_REF: 'origin/claude/260b' });
  report('2.60.0 (#4): STUDIO_HARNESS_REF naming a local branch (or a remote-tracking ref moved by hand to a local commit) exempts nothing: the gate still lists the commit and says why the ref wasn\'t used; the real ref still exempts only its own commits',
    local.status === 1 && /local work dressed as the harness/.test(out(local)) && /STUDIO_HARNESS_REF=origin\/claude\/zz not used: there is no remote-tracking branch/.test(out(local))
      && forged.status === 1 && /local work dressed as the harness/.test(out(forged)) && /origin has no branch claude\/zz/.test(out(forged))
      && both.status === 1 && /local work dressed as the harness/.test(out(both)) && !/the harness release commit/.test(out(both)),
    `${out(local).slice(0, 1000)}\n---\n${out(forged).slice(0, 1000)}\n---\n${out(both).slice(0, 1000)}`);

  try { fs.rmSync(base, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch {}
}

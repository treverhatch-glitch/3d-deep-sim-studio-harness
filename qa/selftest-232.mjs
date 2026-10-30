/**
 * qa/selftest-232.mjs — the 2.32.0 checks, run by qa/selftest.mjs on a copy of the repo.
 * The Game Bible's controls list against each track's real-input results (qa/controls-check.mjs).
 * The Godot side (tools/gate.gd pressing tools/controls.gd, and a dead button failing it) is proven by
 * scripts/check-engine-template.mjs in CI's engine-godot job, which has a real Godot.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest232({ dir, run, report, tmpRoot }) {
  const u = (rel) => JSON.stringify(pathToFileURL(path.join(dir, rel)).href);
  let n = 0;
  const probe = (code, env = {}) => {
    const f = path.join(tmpRoot, `p232-${++n}-${process.pid}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node "${f}"`, env);
    try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: `${r.stdout}${r.stderr}` }; }
  };
  const area = (name, bible, reports) => {
    const d = path.join(tmpRoot, `ctl-${name}-${process.pid}`);
    fs.mkdirSync(path.join(d, 'reports'), { recursive: true });
    if (bible) fs.writeFileSync(path.join(d, 'controls.json'), JSON.stringify(bible));
    for (const [f, j] of Object.entries(reports || {})) fs.writeFileSync(path.join(d, 'reports', f), JSON.stringify(j));
    return d;
  };
  const check = (d, template = false) => probe(`import { controlsCheck } from ${u('qa/controls-check.mjs')};
console.log(JSON.stringify(await controlsCheck({ bibleFile: ${JSON.stringify(path.join(d, 'controls.json'))}, reportsDir: ${JSON.stringify(path.join(d, 'reports'))}, template: ${template} })));`);
  const bible = { tracks: ['web', 'godot'], controls: [{ id: 'build-pier', name: 'Pier tool + click on the shore', expect: 'a pier appears' }, { id: 'take-loan', name: 'Bank: Take loan', expect: 'cash and debt go up' }] };
  const web = { controls: [{ id: 'build-pier', ok: true }, { id: 'take-loan', ok: true }] };
  const godotGood = { engine: 'godot', controls: [{ id: 'build-pier', ok: true }, { id: 'take-loan', ok: true }] };

  const good = check(area('good', bible, { 'browser_1.json': web, 'controls-godot-g.json': godotGood }));
  report('2.32.0: every Bible control passing by real input on every shipped track passes the controls check', good.ok === true && good.checked === 4, JSON.stringify(good));

  const none = check(area('none', null, { 'browser_1.json': web }));
  report('2.32.0: a real game with no controls list in the Bible fails (fail closed); the template passes with a note', none.ok === false && /lists no controls/.test(none.problems?.[0] || '') && check(area('none-t', null, {}), true).ok === true, JSON.stringify(none));

  // The Marina failure: the Godot build's test never pressed the build controls.
  const missing = check(area('missing', bible, { 'browser_1.json': web, 'controls-godot-g.json': { controls: [{ id: 'take-loan', ok: true }] } }));
  report('2.32.0: a Bible control the Godot input test never pressed fails the check, naming the track and the control', missing.ok === false && missing.problems.some((p) => /^godot: "build-pier" .*never pressed/.test(p)), JSON.stringify(missing));

  const dead = check(area('dead', bible, { 'browser_1.json': { controls: [{ id: 'build-pier', ok: true }, { id: 'take-loan', ok: false, why: 'cash unchanged' }] }, 'controls-godot-g.json': godotGood }));
  const unchecked = check(area('unchecked', bible, { 'browser_1.json': { controls: [{ id: 'build-pier', ok: null }, { id: 'take-loan', ok: true }] }, 'controls-godot-g.json': godotGood }));
  report('2.32.0: a dead control fails, and a result with no check of its effect (ok: null) is not a pass', dead.ok === false && dead.problems.some((p) => /web: "take-loan" did nothing \(cash unchanged\)/.test(p)) && unchecked.ok === false && unchecked.problems.some((p) => /no check of what it should do/.test(p)), JSON.stringify({ dead, unchecked }));

  const noTrack = check(area('notrack', bible, { 'browser_1.json': web }));
  report('2.32.0: a track the Bible ships with no real-input results at all fails', noTrack.ok === false && noTrack.problems.some((p) => /^godot: no real-input results/.test(p)), JSON.stringify(noTrack));

  // Newest report wins: an old pass doesn't hide a new failure.
  const d = area('newest', { tracks: ['web'], controls: [{ id: 'take-loan' }] }, { 'browser_1.json': { controls: [{ id: 'take-loan', ok: true }] } });
  const later = path.join(d, 'reports', 'browser_2.json');
  fs.writeFileSync(later, JSON.stringify({ controls: [{ id: 'take-loan', ok: false }] }));
  const t = Date.now() / 1000 + 5;
  fs.utimesSync(later, t, t);
  const newest = check(d);
  report('2.32.0: the newest real-input report decides (an older pass never hides a newer failure)', newest.ok === false, JSON.stringify(newest));

  // The shipped example game's Bible ids match the cartridge's browser controls.
  const tpl = probe(`import fs from 'node:fs';
const b = JSON.parse(fs.readFileSync(${JSON.stringify(path.join(dir, 'studio', 'bible', 'controls.json'))}, 'utf8'));
const { browser } = await import(${u('cartridges/example-sim/qa.mjs')});
console.log(JSON.stringify({ bible: b.controls.map((c) => c.id).sort(), web: browser.controls.map((c) => c.id).sort() }));`);
  report('2.32.0: the example game\'s Bible controls and its browser test press the same ids', JSON.stringify(tpl.bible) === JSON.stringify(tpl.web) && tpl.bible?.length === 2, JSON.stringify(tpl));

  // ---- protected files and forced dones need the owner's signed approval ----
  {
    const sh = (cmd, env = {}) => run(dir, cmd, { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', STUDIO_PROTECT_BASE: 'main', ...env });
    const ownerKey = path.join(tmpRoot, `owner-${process.pid}.pem`);
    const agentKey = path.join(tmpRoot, `agent-${process.pid}.pem`);
    sh('git init -q -b main && git add -A && git commit -qm base');
    const before = sh('node qa/protected-check.mjs');
    sh('node harness/approve.mjs keygen', { STUDIO_OWNER_KEY: ownerKey });
    sh('git add -A && git commit -qm "owner key"');
    sh('git checkout -q -b feature');
    const qa = path.join(dir, 'cartridges', 'example-sim', 'qa.mjs');
    fs.writeFileSync(qa, fs.readFileSync(qa, 'utf8').replace("expect: 'won' }", "expect: 'lost' }"));
    const unapproved = sh('node qa/protected-check.mjs');
    report('2.32.0: no owner key on the base: protected files are not enforced yet, and the check says so', before.status === 0 && /no owner key/.test(before.stdout), before.stdout + before.stderr);
    report('2.32.0: changing a scenario\'s expected outcome (the green-wash from the review) fails the protected check without the owner\'s approval', unapproved.status !== 0 && /cartridges\/example-sim\/qa\.mjs/.test(unapproved.stderr), unapproved.stdout + unapproved.stderr);
    // An agent makes its own key, swaps it into the branch and signs: the base's key is the one that counts.
    sh('node harness/approve.mjs keygen --force', { STUDIO_OWNER_KEY: agentKey });
    const forged = sh('node harness/approve.mjs protected --note "agent says this is fine"', { STUDIO_OWNER_KEY: agentKey });
    const afterForge = sh('node qa/protected-check.mjs');
    report('2.32.0: an approval signed with an agent\'s own key (even with that key swapped into the branch) does not pass', forged.status === 0 && afterForge.status !== 0, afterForge.stdout + afterForge.stderr);
    sh('git checkout -q main -- studio/keys && rm -rf studio/approvals');
    const owner = sh('node harness/approve.mjs protected --note "the owner wants a losing run here"', { STUDIO_OWNER_KEY: ownerKey });
    const approved = sh('node qa/protected-check.mjs');
    fs.writeFileSync(qa, `${fs.readFileSync(qa, 'utf8')}\n// one more edit after the approval\n`);
    const edited = sh('node qa/protected-check.mjs');
    report('2.32.0: the owner\'s approval passes exactly the approved contents; any later edit needs a new approval', owner.status === 0 && approved.status === 0 && /approved by/.test(approved.stdout) && edited.status !== 0 && /different contents/.test(edited.stderr), [owner, approved, edited].map((r) => r.stdout + r.stderr).join('\n---\n'));
    // A new regression replay needs no approval (it only makes the judge stricter); editing an existing one does.
    sh('git checkout -q -- . && git clean -qfd studio/approvals && git stash -q -u || true');
    const regDir = path.join(dir, 'qa', 'regressions');
    fs.writeFileSync(path.join(regDir, 'zz-new-232.json'), JSON.stringify({ id: 'zz', seed: 1, tick: 2 }));
    const added = sh('node qa/protected-check.mjs');
    const existing = fs.readdirSync(regDir).find((f) => f.endsWith('.json') && f !== 'zz-new-232.json');
    fs.appendFileSync(path.join(regDir, existing), '\n');
    const changedReg = sh('node qa/protected-check.mjs');
    fs.rmSync(path.join(regDir, 'zz-new-232.json'));
    sh(`git checkout -q -- "qa/regressions/${existing}"`);
    report('2.32.0: a new regression replay needs no approval; editing an existing one does', added.status === 0 && changedReg.status !== 0 && changedReg.stderr.includes(existing), [added, changedReg].map((r) => r.stdout + r.stderr).join('\n---\n'));
    // A forced done needs the owner's approval for that task once there is an owner key.
    const add = sh('node harness/task.mjs add "Approval probe: close it by force" --role builder');
    const id = ((add.stdout + add.stderr).match(/T-\d+/) || [])[0];
    sh(`node harness/task.mjs start ${id} --agent builder-z`);
    const forcedNo = sh(`node harness/task.mjs done ${id} --agent builder-z --force --reason "the check can't pass here" --accepted-by trever`);
    const ownerForce = sh(`node harness/approve.mjs force ${id} --reason "the owner closes it by hand"`, { STUDIO_OWNER_KEY: ownerKey });
    const forcedYes = sh(`node harness/task.mjs done ${id} --agent builder-z --force`, { STUDIO_DONE_GAME_GATES: 'skip', STUDIO_DONE_UNCOMMITTED: 'allow', STUDIO_VISUAL_GATE: 'off' });
    report('2.32.0: with an owner key, task done --force (and a typed --accepted-by) is refused without the owner\'s signed approval for that task, and closes with it', Boolean(id) && forcedNo.status !== 0 && /without the owner's approval/.test(forcedNo.stderr) && ownerForce.status === 0 && forcedYes.status === 0, [add, forcedNo, ownerForce, forcedYes].map((r) => r.stdout + r.stderr).join('\n---\n').slice(0, 2500));
  }
}


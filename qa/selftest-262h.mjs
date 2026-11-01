/**
 * qa/selftest-262h.mjs — 2.62.0 (H): per-task acceptance contracts (harness/contracts.mjs).
 *
 * A contract is studio/contracts/<ID>.json: checkable criteria agreed before coding, after which only `passes`
 * changes. The Producer/Director, the owner, or an agent on a person's permission agrees it; a worker only proposes.
 * The weakened-tests gate refuses a change to an agreed contract beyond `passes`; done-check needs every criterion in
 * force passing; the reviewer gets the contract in its brief; studio/game.json "contracts.required" makes one
 * mandatory for a task type. A made-up studio; every check fails on 2.59.1 (no contract command, no rule).
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest262H({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const ident = { GIT_AUTHOR_NAME: 'hatch', GIT_AUTHOR_EMAIL: 'owner@example.com', GIT_COMMITTER_NAME: 'hatch', GIT_COMMITTER_EMAIL: 'owner@example.com' };
  const env = { ...ident, STUDIO_ROLE: '', STUDIO_LOCK_OWNER: '', STUDIO_AGENT: '', CLAUDECODE: '', AI_AGENT: '', CODEX_SANDBOX: '', GEMINI_CLI: '', STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_WEAKENED_TESTS: '', STUDIO_PROTECT_BASE: '', STUDIO_OWNER_KEY: '' };
  const PROD = { STUDIO_ROLE: 'producer', STUDIO_LOCK_OWNER: 'producer-s3' };
  const BUILDER = { STUDIO_ROLE: 'builder', STUDIO_LOCK_OWNER: 'builder-s9' };
  const REVIEWER = { STUDIO_ROLE: 'reviewer', STUDIO_LOCK_OWNER: 'reviewer-s4' };
  const git = (cmd, e = {}) => run(dir, `git -c user.name=selftest -c user.email=selftest@example.com ${cmd}`, { ...env, ...e });
  const task = (cmd, e = {}) => run(dir, `node harness/task.mjs ${cmd}`, { ...env, ...e });
  const add = (title) => JSON.parse(task(`add "${title}" --role builder`).stdout).id;
  const doneCheck = (id, e = {}) => out(run(dir, `node harness/done-check.mjs ${id}`, { ...env, ...e }));
  const gate = (e = {}) => run(dir, 'node harness/test-weakening.mjs --json', { ...env, STUDIO_PROTECT_BASE: 'main', ...e });
  const gateJson = (r) => { try { return JSON.parse(String(r.stdout).trim().split('\n').pop()); } catch { return { _raw: out(r).slice(-800) }; } };
  const rel = (id) => `studio/contracts/${id}.json`;
  const read = (id) => { try { return JSON.parse(fs.readFileSync(path.join(dir, rel(id)), 'utf8')); } catch { return null; } };
  const write = (id, c) => fs.writeFileSync(path.join(dir, rel(id)), `${JSON.stringify(c, null, 2)}\n`);
  // A check command with no quoting: works the same in cmd.exe and sh.
  fs.writeFileSync(path.join(dir, 'probe-262h.mjs'), "import fs from 'node:fs';\nprocess.exit(fs.existsSync('feature-262h.txt') ? 0 : 1);\n");

  git('init -q -b main');
  git('config core.autocrlf false');
  git('add -A');
  git('commit -q -m base --no-verify');

  // 1. The Producer writes and agrees a contract; check runs the command and sets passes.
  const t1 = add('Add the hangar door panel');
  const a1 = task(`contract ${t1} add "The door panel opens and closes" --check "node probe-262h.mjs"`, PROD);
  const a2 = task(`contract ${t1} add "The panel copy reads well" --manual`, PROD);
  const ag = task(`contract ${t1} agree`, PROD);
  const c1 = read(t1) || {};
  const red = task(`contract ${t1} check`);
  const passesRed = read(t1)?.criteria?.[0]?.passes;
  fs.writeFileSync(path.join(dir, 'feature-262h.txt'), 'built\n');
  const green = task(`contract ${t1} check`);
  const after = read(t1) || {};
  const shown = task(`contract ${t1} show`);
  const headMsg = git('log -1 --format=%s').stdout;
  report('2.62.0 (H): contract add/agree/check: a Producer session adds a command and a manual criterion and agrees the contract (committed); check leaves passes false while the command fails and sets it true once it succeeds (the manual one waits for a signature, so check still exits 1); show lists both',
    a1.status === 0 && a2.status === 0 && ag.status === 0 && c1.agreedBy === 'producer-s3' && c1.criteria?.length === 2 && c1.criteria[0].check?.kind === 'command' && /contract agreed/.test(headMsg)
      && red.status !== 0 && passesRed === false && /0 of 2 criteria pass/.test(out(red)) && /1 of 2 criteria pass/.test(out(green)) && /C2 .*not signed yet/s.test(out(green)) && after.criteria?.[0]?.passes === true && /\[x\] C1/.test(out(shown)) && /\[ \] C2/.test(out(shown)),
    [a1, a2, ag, red, green, shown].map((r) => out(r).slice(-300)).join('\n---\n') + `\n${JSON.stringify(after).slice(0, 600)}`);

  // 2. A worker proposes; its agree and its sign are refused; the proposal waits until the Producer agrees again.
  const prop = task(`contract ${t1} add "The panel closes with Escape" --check "node probe-262h.mjs"`, BUILDER);
  const wAgree = task(`contract ${t1} agree --by hatch --why "a builder agreeing its own"`, BUILDER);
  const wSign = task(`contract ${t1} sign C2 pass --by builder-s9`, BUILDER);
  const proposed = (read(t1)?.criteria || []).find((x) => x.id === 'C3') || {};
  const dcWait = doneCheck(t1);
  const ok2 = prop.status === 0 && proposed.status === 'proposed' && proposed.proposedBy === 'builder-s9' && wAgree.status !== 0 && /worker/.test(out(wAgree)) && read(t1)?.agreedBy === 'producer-s3'
    && wSign.status !== 0 && /C3 proposed by builder-s9, not in force/.test(dcWait) && !/Contract C3/.test(dcWait);
  const rSign = task(`contract ${t1} sign C2 pass --note "copy reads fine"`, REVIEWER);
  const again = task(`contract ${t1} agree --why "accept the builder's Escape criterion"`, PROD);
  const c3 = (read(t1)?.criteria || []).find((x) => x.id === 'C3') || {};
  report('2.62.0 (H): a worker (builder-s9) may propose a criterion (it lands as proposed and done-check doesn\'t count it) but its agree and its sign of a manual criterion are refused; a reviewer signs the manual one; the Producer agreeing again puts the proposal in force, as an amendment',
    ok2 && rSign.status === 0 && read(t1)?.criteria?.[1]?.signed?.by === 'reviewer-s4' && again.status === 0 && !c3.status && read(t1)?.amendments?.length === 1,
    [prop, wAgree, wSign, rSign, again].map((r) => out(r).slice(-300)).join('\n---\n') + `\n${dcWait.slice(-600)}`);

  // 3. The gate: a worker's commit may flip passes, never change an agreed criterion's text, add one in force, or agree.
  // (On a harness with no contract command the file is written here, so the gate's half of the check still runs.)
  if (!read(t1)?.criteria?.[2]) {
    fs.mkdirSync(path.join(dir, 'studio/contracts'), { recursive: true });
    write(t1, { task: t1, criteria: [1, 2, 3].map((n) => ({ id: `C${n}`, text: `criterion ${n}`, check: { kind: 'manual' }, passes: false })), agreedBy: 'producer-s3', agreedAt: new Date().toISOString() });
  }
  git(`add -A`);
  git('commit -q -m "contract and feature" --no-verify');
  git('checkout -q -b lane-262h');
  const base = read(t1);
  const flip = JSON.parse(JSON.stringify(base));
  flip.criteria[2].passes = !flip.criteria[2].passes;
  write(t1, flip);
  git(`commit -q -am "T: flip passes" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const gFlip = gate();
  const edit = JSON.parse(JSON.stringify(flip));
  edit.criteria[0].text = 'The door panel exists';
  write(t1, edit);
  git(`commit -q -am "T: easier criterion" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const gEdit = gate();
  const gEditJ = gateJson(gEdit);
  write(t1, flip);
  git(`commit -q -am "T: put it back" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const gBack = gate();
  const extra = JSON.parse(JSON.stringify(flip));
  extra.criteria.push({ id: 'C4', text: 'Anything goes', check: { kind: 'manual' }, passes: true, signed: { by: 'builder-s9', verdict: 'pass', at: new Date().toISOString() } });
  extra.criteria[1].text = extra.criteria[1].text; // unchanged
  write(t1, extra);
  git(`commit -q -am "T: add my own" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const gAdd = gateJson(gate());
  write(t1, flip);
  git(`commit -q -am "T: put it back again" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const t2 = add('Add the fuel truck route');
  write(t2, { task: t2, criteria: [{ id: 'C1', text: 'Something easy', check: { kind: 'manual' }, passes: false }], agreedBy: 'hatch', agreedAt: new Date().toISOString() });
  git(`add ${rel(t2)}`);
  git(`commit -q -m "T: my own contract" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const gAgree = gateJson(gate());
  const kinds = (j) => (j.findings || []).map((x) => x.kind);
  report('2.62.0 (H): the weakened-tests gate judges studio/contracts/*.json since the base: a builder\'s commit flipping passes passes; editing an agreed criterion\'s text fails (contract-criterion-changed, with no owner key) and passes again once put back; adding a criterion in force with a self-signed pass, or agreeing a contract itself, fails',
    gFlip.status === 0 && gEdit.status !== 0 && kinds(gEditJ).includes('contract-criterion-changed') && gBack.status === 0
      && gAdd.ok === false && kinds(gAdd).includes('contract-criterion-added-by-worker') && kinds(gAdd).includes('contract-manual-unsigned')
      && gAgree.ok === false && kinds(gAgree).includes('contract-agreed-by-worker'),
    [out(gFlip), out(gEdit), out(gBack), JSON.stringify(gAdd), JSON.stringify(gAgree)].map((s) => s.slice(-700)).join('\n---\n'));
  fs.rmSync(path.join(dir, rel(t2)), { force: true });
  git(`commit -q -am "drop" --no-verify`);
  // The agreeing roles may amend (an amendment with a reason); a builder's edit after it is judged against it.
  const amend = task(`contract ${t1} remove C3 --why "the Escape key is out of scope" --no-commit`, PROD);
  git(`commit -q -am "T: amend" --no-verify --trailer "Studio-Agent: producer-s3"`);
  const gAmend = gate();
  const late = read(t1) || { criteria: [{}] };
  late.criteria[0].text = 'Something easier';
  write(t1, late);
  git(`commit -q -am "T: easier after the amendment" --no-verify --trailer "Studio-Agent: builder-s9"`);
  const gLate = gateJson(gate());
  report('2.62.0 (H): a Producer session\'s amendment in the lane (contract remove … --why, its own commit) passes the gate; a builder\'s edit after the amendment is still refused',
    amend.status === 0 && read(t1)?.amendments?.length === 2 && gAmend.status === 0 && gLate.ok === false && kinds(gLate).includes('contract-criterion-changed'),
    `${out(amend).slice(-300)}\n${out(gAmend).slice(-500)}\n${JSON.stringify(gLate).slice(0, 600)}`);
  git('checkout -q main');

  // 4. done-check: blocked while a criterion fails, clear when all pass; passes typed by hand counts for nothing; a task
  //    without a contract is unaffected.
  const t3 = add('Add the baggage belt counter');
  task(`contract ${t3} add "The counter shows the bag count" --check "node probe-262h.mjs"`, PROD);
  task(`contract ${t3} add "The belt doc names the counter" --file docs-262h/belt.md --contains "bag count"`, PROD);
  task(`contract ${t3} agree`, PROD);
  fs.rmSync(path.join(dir, 'feature-262h.txt'), { force: true });
  task(`contract ${t3} check`);
  const dcRed = doneCheck(t3);
  const hand = read(t3);
  if (hand?.criteria?.[0]) { hand.criteria[0].passes = true; write(t3, hand); }
  const dcHand = doneCheck(t3);
  fs.writeFileSync(path.join(dir, 'feature-262h.txt'), 'built\n');
  fs.mkdirSync(path.join(dir, 'docs-262h'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'docs-262h/belt.md'), '# Belt\nThe counter shows the bag count.\n');
  const chk = task(`contract ${t3} check`);
  const dcGreen = doneCheck(t3);
  fs.writeFileSync(path.join(dir, 'other-262h.txt'), 'a later change\n');
  const dcStale = doneCheck(t3);
  const t4 = add('Add the apron lights');
  const dcNone = doneCheck(t4);
  report('2.62.0 (H): done-check blocks a task with an agreed contract while a criterion fails (and names it), ignores a passes: true typed by hand, clears every contract line once contract check passes on the work as it is, asks for a new check after the files change; a task with no contract gets no contract line',
    /\[ \] Contract C1: .*never checked|\[ \] Contract C1: .*failed when last checked/.test(dcRed) && /\[ \] Contract C2: .*doesn't exist/.test(dcRed) && /Not done yet/.test(dcRed)
      && /\[ \] Contract C1: .*passes is set by the check, not by hand/.test(dcHand)
      && chk.status === 0 && /\[x\] Contract C1/.test(dcGreen) && /\[x\] Contract C2/.test(dcGreen) && !/\[ \] Contract/.test(dcGreen)
      && /\[ \] Contract C1: .*files changed since it was checked/.test(dcStale) && !/contract/i.test(dcNone),
    [dcRed, dcHand, out(chk), dcGreen, dcStale, dcNone].map((s) => s.slice(-700)).join('\n---\n'));

  // 5. studio/game.json "contracts": { "required": ["change"] } makes one mandatory for change tasks only.
  fs.mkdirSync(path.join(dir, 'studio'), { recursive: true });
  const gameFile = path.join(dir, 'studio/game.json');
  const had = fs.existsSync(gameFile) ? fs.readFileSync(gameFile, 'utf8') : null;
  fs.writeFileSync(gameFile, JSON.stringify({ ...(had ? JSON.parse(had) : {}), contracts: { required: ['change'] } }, null, 2));
  const dcReq = doneCheck(t4);
  const t5 = add('Docs: explain the apron lights');
  const dcDocs = doneCheck(t5);
  if (had === null) fs.rmSync(gameFile, { force: true }); else fs.writeFileSync(gameFile, had);
  report('2.62.0 (H): with studio/game.json "contracts": { "required": ["change"] } a change task without an agreed contract is not done (and says how to get one); a docs task is unaffected',
    /\[ \] An agreed acceptance contract \(studio\/game.json requires one for "change" tasks\)/.test(dcReq) && /contract .* agree/.test(dcReq) && !/contract/i.test(dcDocs),
    `${dcReq.slice(-800)}\n---\n${dcDocs.slice(-400)}`);

  // 6. The reviewer's brief carries the contract.
  git('add -A');
  git(`commit -q -m "${t3}: belt counter" --no-verify --trailer "Studio-Task: ${t3}"`);
  const f = path.join(dir, '.probe-262h-review.mjs');
  fs.writeFileSync(f, `import { gather, prompt } from ${u('harness/review.mjs')};
const g = gather(${JSON.stringify(t3)}, { implementer: 'claude-opus-5-5' });
console.log(JSON.stringify({ error: g.error || null, user: g.error ? '' : prompt(g)[1].content }));`);
  const rv = run(dir, `node ${path.basename(f)}`, env);
  let rj = {};
  try { rj = JSON.parse(String(rv.stdout).trim().split('\n').pop()); } catch { rj = { _raw: out(rv).slice(-800) }; }
  report('2.62.0 (H): npm run review sends the agreed contract with the diff and asks for a met/not met line per criterion',
    /Acceptance contract \(studio\/contracts\//.test(rj.user || '') && /C1: The counter shows the bag count/.test(rj.user || '') && /CONTRACT <id>: met or not met/.test(rj.user || ''),
    JSON.stringify(rj).slice(0, 1200));
}

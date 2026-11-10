// 2.81 (b2), ported from the R2 trial (B3, P2): the anchor spec (harness/anchors.mjs) and said-vs-did at task done
// (harness/said-vs-did.mjs).
// A task cites anchors; the brief prints their acceptance lines; done records met | unmet | unknown from the
// deliverable, never the note; a claimed command that prints something else, or a file the note names that the task
// never touched, is refused with the label `claim` and a review.verdict {claim-mismatch} event.
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest281B2({ dir, run, report }) {
  const env = { STUDIO_PRODUCER_NAME: 'prod-1', STUDIO_CLAIM_TIMEOUT_S: '120' };
  const events = () => fs.readFileSync(path.join(dir, '.studio', 'events.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  // The copy has no repository; the anchor judge and the file claims read git, so the copy gets one.
  if (!fs.existsSync(path.join(dir, '.git'))) {
    run(dir, 'git init -q', env);
    run(dir, 'git add -A', env);
    run(dir, 'git -c user.name=t -c user.email=t@t commit -q -m "copy"', env);
  }
  const A = await import(pathToFileURL(path.join(dir, 'harness', 'anchors.mjs')).href);
  const S = await import(pathToFileURL(path.join(dir, 'harness', 'said-vs-did.mjs')).href);

  // The schema is game-agnostic and refuses what it cannot judge.
  const bad = A.anchorProblems({ id: 'X', game: '', feature: 'f', acceptance: [], evidence: { status: 'sure' } });
  report('anchors: a malformed anchor is named by each problem (id, game, acceptance, evidence.status)', bad.length === 4 && bad.some((p) => /evidence\.status/.test(p)), bad.join('; '));
  const a1 = run(dir, 'node harness/anchors.mjs add --game "Reference Tycoon" --feature "Boarding queue" --behaviour "passengers queue at the gate before boarding" --number "queue_max=40" --acceptance "a boarding queue forms at the gate and drains at 1 per tick" --evidence references/ref-tycoon-queue.png --kind screenshot --provenance "owner, 2026-11-08" --status verified', env);
  const a2 = run(dir, 'node harness/anchors.mjs add --game "Reference Tycoon" --feature "Delay board" --acceptance "a delay board lists late flights"', env);
  const lib = A.readAnchors(path.join(dir, 'studio', 'references', 'anchors.json'));
  report('anchors: add writes A1 (verified evidence with path and provenance) and A2 (no evidence: needs-reference) to studio/references/anchors.json', a1.status === 0 && a2.status === 0 && lib.length === 2 && lib[0].id === 'A1' && lib[0].evidence.status === 'verified' && lib[1].id === 'A2' && lib[1].evidence.status === 'needs-reference', `${a1.stdout}${a1.stderr}${a2.stdout}${a2.stderr}`);

  // A task cites anchors; an unknown id is refused; the brief prints the acceptance lines.
  const refused = run(dir, 'node harness/task.mjs add "Boarding queue at the gate" --anchors A1,A9', env);
  report('task add --anchors: an id not in the spec is refused and nothing is queued', refused.status === 1 && /no anchor A9/.test(refused.stderr), refused.stdout + refused.stderr);
  const added = run(dir, 'node harness/task.mjs add "Boarding queue at the gate" --anchors A1,A2', env);
  const id = (() => { try { return JSON.parse(added.stdout).id; } catch { return null; } })();
  report('task add --anchors A1,A2 queues the task with the anchors in its record', Boolean(id) && events().some((e) => e.type === 'task.added' && e.task === id && Array.isArray(e.meta?.anchors) && e.meta.anchors.join() === 'A1,A2'), added.stdout + added.stderr);
  const silent = run(dir, 'node harness/task.mjs add "Wire the delay board"', env);
  report('task add without --anchors, in a studio that has an anchor spec, gets a note (never a refusal)', silent.status === 0 && /cites none/.test(silent.stderr), silent.stdout + silent.stderr);
  run(dir, `node harness/task.mjs start ${id} --agent builder-1`, env);
  run(dir, `node harness/focus.mjs ${id} --agent builder-1`, env);
  const brief = fs.readFileSync(path.join(dir, '.studio', 'briefs', `${id}.md`), 'utf8');
  report('the brief prints each cited anchor with its behaviours, numbers, acceptance lines and evidence status under "Done means"', /## Anchors this task must match/.test(brief) && /A1 Reference Tycoon: Boarding queue \(evidence verified/.test(brief) && /accept when: a boarding queue forms/.test(brief) && /number: queue_max = 40/.test(brief) && /A2 Reference Tycoon: Delay board \(evidence needs-reference/.test(brief), brief.slice(-1500));

  // Anchor verdicts come from the deliverable: a committed file naming A1 → met; A2 → unknown (its reference was never checked).
  fs.writeFileSync(path.join(dir, 'cartridges', 'example-sim', 'boarding-queue.test.mjs'), "// A1: boarding queue forms at the gate\nexport const anchor = 'A1';\n");
  run(dir, 'git add -A', env);
  run(dir, `git -c user.name=t -c user.email=t@t commit -q -m "${id}: boarding queue" -m "Studio-Task: ${id}"`, env);
  const j = A.judgeAnchors(id, { cwd: dir, anchors: lib });
  report('judgeAnchors: A1 is met by the committed file that names it; A2 is unknown (needs-reference), never green', j.summary.A1 === 'met' && j.summary.A2 === 'unknown' && /boarding-queue\.test\.mjs/.test(j.rows[0].why), JSON.stringify(j));
  const dc = run(dir, `node harness/done-check.mjs ${id}`, env);
  report('done-check prints the anchor verdicts and a WARN for the unknown one', /anchors: A1 met, A2 unknown/.test(dc.stdout) && /WARN anchor A2 unknown/.test(dc.stdout), dc.stdout + dc.stderr);
  const strict = run(dir, `node harness/done-check.mjs ${id}`, { ...env, STUDIO_ANCHORS: 'fail' });
  report('STUDIO_ANCHORS=fail: a met anchor stays a passed row and unknown stays a warning (no refusal for an unchecked reference)', /\[x\] Anchor A1 matched/.test(strict.stdout) && /WARN anchor A2 unknown/.test(strict.stdout), strict.stdout);

  // Said-vs-did: a true claim holds; a false claim and a made-up file are a claim mismatch.
  const ok1 = S.parseClaim('node harness/anchors.mjs validate => anchors: 2 valid');
  const notAllowed = S.parseClaim('rm -rf x => done');
  report('parseClaim: "<command> => <last line>" parses; a command outside the allowlist is not re-run (unverifiable), a shell pipe is malformed', ok1.allowed === true && ok1.expect === 'anchors: 2 valid' && notAllowed.allowed === false && S.parseClaim('a | b => c').error, JSON.stringify([ok1, notAllowed]));
  const good = S.judgeClaims(id, { claims: ['node harness/anchors.mjs validate => anchors: 2 valid'], note: `added cartridges/example-sim/boarding-queue.test.mjs`, cwd: dir, env: { ...process.env, ...env } });
  report('judgeClaims: a claim whose re-run prints the claimed line, and a note naming a file the task committed, hold', good.ok && good.results[0].verdict === 'matches' && good.files.unchanged.length === 0, JSON.stringify(good));
  const badJ = S.judgeClaims(id, { claims: ['node harness/anchors.mjs validate => anchors: 7 valid', 'rm -rf x => done'], note: 'also fixed cartridges/example-sim/made-up-file.mjs', cwd: dir, env: { ...process.env, ...env } });
  report('judgeClaims: a re-run that prints something else is a mismatch, an unlisted command is unverifiable (never green), a file the task never touched is claimed-but-unchanged', !badJ.ok && badJ.results[0].verdict === 'mismatch' && badJ.results[1].verdict === 'unverifiable' && badJ.files.unchanged.join() === 'cartridges/example-sim/made-up-file.mjs' && badJ.mismatches.length === 2, JSON.stringify(badJ));
  const done = run(dir, `node harness/task.mjs done ${id} --agent builder-1 --claim "node harness/anchors.mjs validate => anchors: 7 valid" --note "see cartridges/example-sim/made-up-file.mjs"`, { ...env, STUDIO_TRAIN: 'off' });
  const verdicts = events().filter((e) => e.type === 'review.verdict' && e.task === id);
  report('task done --claim with a false claim is refused ("what the note says does not match") and emits review.verdict {claim-mismatch} with the evidence', done.status !== 0 && /does not match what the harness sees/.test(done.stdout + done.stderr) && /\[ \] claim node harness\/anchors\.mjs validate: mismatch/.test(done.stdout + done.stderr) && verdicts.length === 1 && verdicts[0].meta?.verdict === 'claim-mismatch' && verdicts[0].meta.mismatches.length === 2, `${done.stdout}${done.stderr}\n${JSON.stringify(verdicts)}`);
  const check = run(dir, `node harness/task.mjs done ${id} --agent builder-1 --check --claim "node harness/anchors.mjs validate => anchors: 7 valid"`, env);
  report('task done --check does not re-run a claim (the closing done does) and records no verdict', !/claim node harness\/anchors\.mjs validate: mismatch/.test(check.stdout + check.stderr) && events().filter((e) => e.type === 'review.verdict' && e.task === id).length === 1, check.stdout + check.stderr);

  // 2.81 decisions: --claim stays optional (no claim: judged as before), and a re-run only reads.
  const writes = S.parseClaim('npm run golden -- --update => golden updated');
  const writes2 = S.parseClaim('node harness/anchors.mjs add --game x => A3 added');
  const reads = S.parseClaim('node qa/check-regressions.mjs => ok');
  report('parseClaim: a command that would write (--update, anchors add) is not re-run (unverifiable, never green); the regressions check is', writes.allowed === false && writes2.allowed === false && reads.allowed === true, JSON.stringify([writes, writes2, reads]));
  const plain = run(dir, `node harness/task.mjs done ${id} --agent builder-1 --check --note "see cartridges/example-sim/made-up-file.mjs"`, env);
  report('task done with no --claim is judged as before: a note naming a file the task never touched is not a claim refusal', !/does not match what the harness sees/.test(plain.stdout + plain.stderr) && events().filter((e) => e.type === 'review.verdict' && e.task === id).length === 1, plain.stdout + plain.stderr);
}

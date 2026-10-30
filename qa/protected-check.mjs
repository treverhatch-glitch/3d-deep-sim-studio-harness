#!/usr/bin/env node
/**
 * qa/protected-check.mjs — 2.32.0: protected files (studio/protected.json) change only with the owner's
 * signed approval (harness/approve.mjs). Compares the branch with its base (the PR's base in CI, the
 * studio's branch in a lane copy, else origin/main). Not enforced until the base has an owner key.
 *
 * CI runs the BASE branch's copy of this file against the PR's checkout (STUDIO_PROTECT_ROOT), so a branch
 * can't weaken the check that judges it; locally it runs from the working copy, as a fast warning.
 *
 *   node qa/protected-check.mjs [--json]
 */
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkProtected } from '../harness/approve.mjs';

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const r = checkProtected();
  if (process.argv.includes('--json')) console.log(JSON.stringify(r));
  if (!r.ok) {
    console.error(`[protected] FAIL ${r.why}:`);
    for (const c of r.changes) console.error(`  ${c.path}`);
    console.error('[protected] Only the owner can approve these: on the owner\'s machine, npm run approve -- protected --note "why", then commit the approval file. An agent should hand the task back instead of working around it.');
    process.exit(1);
  }
  console.log(`[protected] ${r.enforced ? 'PASS' : 'note'}: ${r.why}`);
}

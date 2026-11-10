#!/usr/bin/env node
/**
 * harness/policy.mjs — 2.71.0 (x): `npm run policy`, the studio policy file's CLI. The rules: harness/policy-rules.mjs
 * (import that one from other modules, never this CLI).
 */
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { mainRoot } from './worktree.mjs';
import { POLICY_REL, PROPOSAL_REL, AUTONOMOUS_ELIGIBLE, DEFAULT_REVIEW_H, NEVER_WORDS, readPolicy, policyText, setAutonomous, confirmProposal, declineProposal } from './policy-rules.mjs';
import { readJson } from './fsafe.mjs';


export const USAGE = `Usage: npm run policy [-- --json]                          the rules in force, and whether ${POLICY_REL} counts
       npm run policy -- autonomous on --agent <name> [--actions ${AUTONOMOUS_ELIGIBLE.join(',')}] [--review-h ${DEFAULT_REVIEW_H}] --by <owner> [--why "…"] [--no-commit]
       npm run policy -- autonomous off --by <owner> [--no-commit]
       npm run policy -- confirm --by <owner> [--no-commit]   turn on the proposed autonomous mode
       npm run policy -- decline --by <name>                  drop the proposal
The owner runs autonomous on/off and confirm in their own terminal. A game dev proposes: npm run autonomy -- mode autonomous on --agent <name> --by <dev>.
Anyone but a worker pauses it at once: npm run autonomy -- mode autonomous off --by <name>. Never autonomous: ${NEVER_WORDS}.`;

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) { console.log(USAGE); process.exit(0); }
  const opt = (k) => { const i = argv.indexOf(k); return i >= 0 && argv[i + 1] !== undefined && !String(argv[i + 1]).startsWith('--') ? argv[i + 1] : null; };
  const cmd = argv[0] && !argv[0].startsWith('--') ? argv[0] : 'show';
  const done = (r) => { (r.ok ? console.log : console.error)(r.message); process.exit(r.ok ? 0 : 1); };
  if (cmd === 'show') {
    if (argv.includes('--json')) { const p = readPolicy(); console.log(JSON.stringify({ counts: p.counts, why: p.why, signed: p.signed, commit: p.commit, paused: p.paused, effective: p.effective, proposal: readJson(path.join(mainRoot(), PROPOSAL_REL)) }, null, 2)); process.exit(0); }
    console.log(policyText());
    process.exit(0);
  }
  if (cmd === 'autonomous' && ['on', 'off'].includes(argv[1])) done(await setAutonomous({ on: argv[1] === 'on', agent: opt('--agent') || '', actions: opt('--actions'), reviewH: opt('--review-h'), by: opt('--by'), why: opt('--why') || '', commit: !argv.includes('--no-commit') }));
  if (cmd === 'confirm') done(await confirmProposal({ by: opt('--by'), commit: !argv.includes('--no-commit') }));
  if (cmd === 'decline') done(declineProposal({ by: opt('--by') }));
  console.error(USAGE);
  process.exit(1);
}

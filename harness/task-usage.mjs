/**
 * harness/task-usage.mjs — 2.67.0 (B-47): usage text for every `npm run task -- <subcommand>`, and the --help rule.
 *
 * `node harness/task.mjs train --help` started a real train: the CLI ignored --help. Now task.mjs checks wantsHelp()
 * before it reads the board or does anything else, prints usageFor(cmd) and exits 0. No imports: loading this module
 * can't act or write.
 */
const T = 'npm run task --';
export const TASK_USAGE = {
  next: `${T} next [--role <role>] [--agent <you>]   the next task you may start`,
  show: `${T} show <TASK_ID>   one task and its state`,
  drain: `${T} drain [--by <name>]   stop handing out new work, let running work finish`,
  list: `${T} list   the board`,
  stop: `${T} stop [--by <name>]   stop the queue`,
  resume: `${T} resume [--by <name>]   start the queue again`,
  trunk: `${T} trunk   whether main is green`,
  type: `${T} type <TASK_ID> [<change|chore|bug|docs|…|auto> --by <owner> --why "<reason>" [--permission "<the owner's words or a link>"]] [--no-commit]`,
  visual: `${T} visual <TASK_ID> [off|on|auto --by <owner> --why "<reason>" [--permission "<the owner's words or a link>"]] [--no-commit]`,
  start: `${T} start <TASK_ID> --agent <unique-name> [--model m] [--dry-run]   (--dry-run: the checks and what would happen, nothing changed)`,
  pause: `${T} pause <TASK_ID> --agent <owner> --note "where you stopped and what is left"`,
  reopen: `${T} reopen <TASK_ID> --reason "what was wrong" (the task must be done)`,
  done: `${T} done <TASK_ID> --agent <owner> [--check] [--train [--branch <Unity branch>] [--tag <word>]] [--note "..."] [--force --reason "<10+ chars>"]`,
  tag: `${T} tag <TASK_ID> <word>|none   an engine lane's tag: only train --engine <name> --tag <word> takes it`,
  train: `${T} train [--unity] [--max N] [--now] [--dry-run] [--by <name>] [--wait <min>] [--detach | --foreground] | train status | train release <TASK_ID> --by <name> [--permission "…"] | train cancel [<train id>] --by <name> [--why "…"] | train config <TASK_ID> [--by <name>] | train dequeue <TASK_ID> [--engine <name>] [--by <name>] | train --engine <name> [--only T-a,T-b] [--tag <word>] | train cancel --engine <name> --by <name> [--why "…"] | train auto off|on --engine <name> --by <name> [--why "…"] [--hours N]`,
  unblock: `${T} unblock <TASK_ID> --by <name> [--note "what was fixed"]`,
  game: `${T} game [<name>] --by <name>`,
  note: `${T} note <TASK_ID> "<ruling>" --by <name>`,
  hold: `${T} hold <TASK_ID> --by <name> --why "<what it waits for: the merge chain, the next train …>"`,
  unhold: `${T} unhold <TASK_ID> --by <name>`,
  after: `${T} after <TASK_ID> <T-x>[,<T-y>] | --remove <T-x>[,<T-y>] | --set <T-x>,<T-y> | --clear [--by <name>]   what the task waits for`,
  holds: `${T} holds   every hold, park, block and lane`,
  park: `${T} park <TASK_ID> --by <name> --why "…" [--until T-ID|phase:N|time]`,
  unpark: `${T} unpark <TASK_ID> --by <name>`,
  block: `${T} block <TASK_ID> --until <T-ID|ISO time> --by <name> [--why "…"]`,
  lane: `${T} lane <TASK_ID> <folder|a.js,b.js|none> --by <name> [--wide "<why>"]`,
  yes: `${T} yes <TASK_ID> --by <dev> [--quote "…" --source "…" when relayed]`,
  drop: `${T} drop <TASK_ID> --why "…" [--by <name>]`,
  reorder: `${T} reorder <TASK_ID> --to top|bottom|<n> | --before <TASK_ID> [--by <name>]`,
  contract: `${T} contract <TASK_ID> [show | add "<text>" [--check "<command>" | --file <path> [--contains "<text>"] | --manual] | agree --by <name> [--permission "…"] [--why "…"] | check | sign <CID> pass|fail --by <name> | remove <CID> [--by <name> --why "…"]] [--no-commit]`,
  review: `${T} review [<TASK_ID>]   tasks waiting for review`,
  pending: `${T} pending   tasks waiting for review`,
  proposed: `${T} proposed   tasks proposed for the live queue`,
  promote: `${T} promote <TASK_ID> --by <name>   put a proposed task on the live queue`,
  add: `${T} add "<Task Title>" [--role builder] [--priority P1] [--type bug|chore|…] [--size 1-5] [--lane <folder>] [--after T-x] [--start --agent <you>] …`,
};
export const GENERAL_USAGE = 'Usage: node harness/task.mjs [next | list | start <ID> [--model m] | pause <ID> --note "..." | done <ID> | add "<Title>" [--after T-x] | park|unpark|unblock <ID> | block <ID> --until <T-ID|time> | lane <ID> <folder|a.js,b.js|none> | track <ID> engine:<name> | holds | note <ID> "<ruling>" --by <name> | yes <ID> --by <dev> | drop <ID> --why "…" | reorder <ID> --to top|bottom|<n> | --before <ID>]\n`<subcommand> --help` shows one subcommand.';

/** --help or -h anywhere on the command line (as its own word). */
export const wantsHelp = (argv) => argv.includes('--help') || argv.includes('-h');
/** The usage for one subcommand (or the general one), always starting "Usage:". */
export const usageFor = (cmd) => (cmd && TASK_USAGE[cmd] ? `Usage: ${TASK_USAGE[cmd]}` : GENERAL_USAGE);

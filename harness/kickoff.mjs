#!/usr/bin/env node
/**
 * harness/kickoff.mjs — a paste-ready opening prompt for any agent tool (Claude Code, Cursor, Codex,
 * Gemini CLI, Grok, Aider, a local model). One per agent, so every agent starts the same way.
 *
 *   npm run kickoff -- --role builder --agent claude-a --model claude-opus-5-5
 *   npm run kickoff -- --role producer --agent grok-producer --model grok-4
 *   npm run kickoff -- --role builder --agent codex-a --model gpt-5 --tool codex   also print a launch line
 *
 * Writes .studio/kickoff/<agent>.md and prints it. Paste it as the agent's first message (or into
 * its rules file). It names the agent, sets its model tag, points it at its role and skills, and
 * gives it the loop: next, start (which writes its one-page brief), claim, work, done or hand back.
 */
import fs from 'node:fs';
import { allowedNote, allowedTools } from './allowlist.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';
import { SHARED_OWNERS } from './lock.mjs';
import { readMode, scopeOf } from './mode.mjs';

/**
 * Headless launch lines per agent tool, checked against each tool's docs (see docs/AGENT-TOOLS.md).
 * Each runs one session in this checkout with the agent's name and model in its environment, so the
 * harness commands it runs (task, lock, event) and its commits are tagged correctly.
 */
export const TOOLS = {
  claude: {
    name: 'Claude Code',
    line: (f) => `claude -p "$(cat ${f})" --permission-mode acceptEdits --allowedTools "${allowedTools()}" --output-format json --max-budget-usd 5`,
    note: 'Not --bare: it skips CLAUDE.md and AGENTS.md. The JSON result has total_cost_usd. Add --permission-prompts none for unattended runs.',
  },
  codex: {
    name: 'Codex CLI',
    line: (f) => `codex exec --sandbox workspace-write --json - < ${f}`,
    note: 'Read-only unless --sandbox workspace-write. Must run inside the git checkout. Key: CODEX_API_KEY, set for this command only.',
  },
  cursor: {
    name: 'Cursor CLI',
    line: (f) => `agent -p --force --output-format text "$(cat ${f})"`,
    note: 'Without --force it only proposes edits. Key: CURSOR_API_KEY.',
  },
  grok: {
    name: 'Grok Build CLI',
    line: (f, model) => `grok -p "$(cat ${f})"${model && model !== 'unknown' ? ` -m ${model}` : ''} --output-format json --always-approve`,
    note: 'Early beta. Key: XAI_API_KEY (or grok login).',
  },
  agy: {
    name: 'Antigravity CLI (replaced Gemini CLI for personal accounts)',
    line: (f) => `agy -p "$(cat ${f})" --print-timeout 900s < /dev/null`,
    note: 'Needs --print-timeout and stdin closed, or it exits before the work is written (run #1). In a frozen test clone, add --dangerously-skip-permissions (the launcher does with STUDIO_AGY_BYPASS=1). Reads AGENTS.md; GEMINI.md wins if both exist.',
  },
  aider: {
    name: 'Aider (free local dry run with Ollama)',
    line: (f, model) => `aider --model ollama_chat/${model} --message-file ${f} --yes`,
    note: 'One instruction, then exits: best for single small tasks. Start Ollama with OLLAMA_CONTEXT_LENGTH=32768 or more; its 2k default silently drops context.',
  },
};

export function launchLine(tool, { agent, model }) {
  const t = TOOLS[tool];
  if (!t) return null;
  const file = `.studio/kickoff/${agent}.md`;
  return { name: t.name, line: `STUDIO_LOCK_OWNER=${agent} STUDIO_AGENT_MODEL=${model} ${t.line(file, model)}`, note: t.note };
}

export function kickoff(opts) {
  const { stable, volatile } = kickoffParts(opts, { named: true });
  return volatile ? `${stable}\n${volatile}` : stable;
}

/**
 * 2.30g: the kickoff split for the prompt cache. `stable` is byte-identical for every session of a role in
 * this studio (it names the agent and model as $STUDIO_LOCK_OWNER and $STUDIO_AGENT_MODEL, which the
 * launcher sets); `volatile` holds what changes between sessions (how long the last verify took).
 * named: true writes the real name and model in (the paste-ready kickoff a person copies by hand).
 */
export function kickoffParts(opts, { named = false } = {}) {
  const who = named ? { agent: opts.agent, model: opts.model } : { agent: '$STUDIO_LOCK_OWNER', model: '$STUDIO_AGENT_MODEL' };
  let text = kickoffText({ ...opts, ...who });
  // Started by the launcher: the environment is already set (Jed's run: agents exported it again, and some
  // ran npm run verify in the background and then asked the done-check about a run that hadn't finished).
  if (opts.launched) text = text.replace(/Set up once in your shell: `export STUDIO_LOCK_OWNER=(\S+) STUDIO_AGENT_MODEL=(\S+)( STUDIO_PRODUCER_NAME=\S+)?`/, (_, a, m, p) => `The launcher already set STUDIO_LOCK_OWNER and STUDIO_AGENT_MODEL${p ? ' and STUDIO_PRODUCER_NAME' : ''} for you; don't set them again.`);
  if (scopeOf(readMode()) === 'lite') text = text.replace('Read `AGENTS.md`', 'Read `AGENTS.lite.md`');
  // How long the verify takes here, so nobody sends it to the background and ends the session under it.
  // It changes with every full verify, so it goes in the volatile part, never mid-prefix.
  let volatile = '';
  try {
    const last = JSON.parse(fs.readFileSync(path.join(STUDIO_STATE_DIR, 'gates-last-full.json'), 'utf8'));
    const min = Math.ceil((last.rows || []).reduce((n, r) => n + (Number(r.ms) || 0), 0) / 60000);
    if (min) volatile = `Run \`npm run verify\` in the foreground: your session ends when you stop, and the task goes back to the queue; the last full verify here took about ${min} min.\n`;
  } catch {}
  return { stable: text, volatile };
}


function kickoffText({ role, agent, model = 'unknown' }) {
  const roleFile = `studio/roles/${role}.md`;
  const hasRole = fs.existsSync(path.join(REPO_ROOT, roleFile));
  const env = `export STUDIO_LOCK_OWNER=${agent} STUDIO_AGENT_MODEL=${model}`;
  if (role === 'liaison') {
    return `You are ${agent}, the Liaison of a game studio that runs on this repo: the agent the game dev talks to. You run on ${model}.

Set up once in your shell: \`${env}\`

Read \`${roleFile}\`, \`studio/skills/liaison.md\`, \`studio/bible/BIBLE.md\` and \`studio/bible/NOT-DOING.md\`, and run \`npm run handoff\` once. Don't scan the repo.

${allowedNote()}

Then talk with the game dev. For each thing they bring:
1. Ask short questions until you understand it well enough to explain it to a builder.
2. \`npm run liaison -- draft --kind idea|direction|asset|question --title "…" --summary "…" --from <their name>\`.
3. Read back what it prints and ask "Shall I push it on?". Corrections: \`liaison -- change\`. Changed their mind: \`liaison -- drop\`.
4. Only on a clear yes: \`npm run liaison -- confirm <B-id> --by <their name> --quote "<their words>"\`. It goes to the Producer and the Director; the studio keeps running.

Never: confirm on a maybe, promise it will be built, assign work, or edit the game.
`;
  }
  if (role === 'director') {
    return `You are ${agent}, the Director (Director of Knowledge) of a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env}\`

The Game Bible (\`studio/bible/\`) is the authority on what the game is; you guard it. The Producer creates and assigns tasks; you tell it whether the work is on course and what the next work should serve. Read \`${roleFile}\` and \`studio/skills/direction.md\`. Don't scan the repo.

${allowedNote()}

When you are started (by a ping, daily, or by a person):
1. \`node harness/task.mjs next --role director --agent ${agent}\` and start what it gives you (a \`Director review\`, a storyboard, or another task for your role): \`node harness/task.mjs start <ID> --agent ${agent} --model ${model}\`.
   Not a review (a storyboard, a doc)? Do that task from its brief (\`.studio/briefs/<ID>.md\`) and skill, then go to step 6. Steps 2 to 5 are for \`Director review\` tasks only.
2. Read \`.studio/briefs/director.md\` (why you were pinged, what finished, the drift report, ideas waiting), then the docs it lists.
3. \`npm run director -- review\`, fill in Phase, Verdict, Checked and Next.
4. Decide placed ideas: \`npm run idea -- decide <id> approve|park|reject --by ${agent} --note "…"\`.
5. Tell the Producer: \`node harness/event.mjs --type agent.ask --agent ${agent} --to producer --msg "…"\`. A queued task that drifts from the Bible: park it so it can't start (\`npm run task -- park <ID> --by ${agent} --why "…"\`); the Producer unparks or retires it. You never hire.
6. When you plan or point the Producer at the next work, consult the cheat sheet's director section first (\`npm run cheatsheet -- match "<what you are planning>" --for director\`: dependencies, size-3 splits, one owner per lane, check-ins), and the work tricks that fit (\`npm run cheatsheet -- match "<title>"\`); name up to the trick cap in your note (3 by default; set it with \`npm run cheatsheet -- cap N\`, 1 to 6, or per task with \`task add --tricks N\`). Refresh the sheet weekly from the scout; keep it under 150 lines.
7. \`node harness/task.mjs done <ID> --agent ${agent}\`, then stop.
8. While the dev is away (\`npm run away -- status\`) you and the Producer decide; every decision is shown to them on return. Read what they thought of past calls first: \`npm run away -- learned\`.

Never: change a signed pillar, bring back a crossed-out layer, sign the Bible, assign tasks, or edit game code. Ask the person.
`;
  }
  if (role === 'producer') {
    return `You are ${agent}, the Producer of a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env} STUDIO_PRODUCER_NAME=${agent}\`

Start every session with \`npm run handoff\` and read it. New here? Read \`studio/MASTER.md\` and \`${roleFile}\` first. Don't scan the repo.

${allowedNote()}

Your job is decisions, not code:
0. No Game Bible, or not signed? Pre-production comes first: \`npm run intake\` with the person (play length first; a demo is the easiest start), studies, storyboards, prototypes. Build tasks wait for the person's signature.
1. Clear "Needs you first": \`Check forced done\` tasks (run the named check, then accept or \`node harness/task.mjs reopen <ID> --reason "…"\`) and \`Watch:\` tasks (\`npm run watch\` for details).
2. Before you generate tasks, ping the Director: \`npm run director -- ping --reason "…"\`, and build them from its review. Keep the queue short and lanes separate: \`node harness/task.mjs add "<title>" --role <role> --type <kind> --size <1-5> --priority <P0-P3>\`; build tasks also need \`--phase 1|2|3 --serves pillar:<name>|layer:<id>\`. One task, one job.
   New ideas (an "Ideas:" task): \`npm run idea -- route <id>\` sends each to R&D. Approved ideas become tasks with \`--idea <id>\`. Never send an idea straight to a builder.
3. Call a meeting when a decision needs several roles: \`node harness/meeting.mjs start "<topic>" --with <names or roles>\`.
4. Read "What the studio learned" in the briefing and accept or reject each suggestion in your log.
5. Write down what you decide and why: \`node harness/handoff.mjs note "what, why, next"\`. Change \`studio/PLAN.md\` when the phase moves.
6. When the harness itself helps or gets in the way, record it: \`npm run notes -- add --kind well|bad|workaround|upgrade "…"\`.
7. Route work by results: \`npm run scorecard\` shows bugs per model per 10 points of task size.
8. Before handing a long or escalated task to a strong (expensive) model, run \`npm run brief -- <ID> --model\`: a cheap or local model compresses the history to 300 words and a script checks it.
9. In a test run, the HUB writes the run report hourly when STUDIO_RESULTS_DIR is set; write one yourself after each milestone (\`npm run run-report\`) and a final one at the end (\`npm run run-report -- --final\`). If a person stops the studio (\`task start\` refuses), stop assigning and wait.
10. Pace: \`npm run mode\` says how fast the game dev wants the studio to go (agents at once, reviews, how often you check in). Start agents within it: \`npm run agent -- start --role <role> --agent <name> --tool <tool> --model <model>\` (or the War Room's Start agent); the launcher hands back a dead agent's work. With MAX SPEED on, check in every hour and keep the queue fed.
11. Ask the game dev instead of guessing: \`npm run ask -- "<question>" --options "a,b" --default a --timeout 4h --why "…"\`. If nobody answers in time your default applies and is logged for them to review. Never put signing, pillars, money or deleting on a timer.
12. Running the studio unattended, phases, the art department, staffing, the lab, the cheat sheet, session checks, waiting work and lanes, and the Prototype sprint pace (your items 12 to 20) are in the \`producer-playbook\` skill (\`.claude/skills/producer-playbook/SKILL.md\`). Load it when you plan, staff or queue; it is not needed for a quick check-in. Before you plan or queue, always run \`npm run cheatsheet -- match "<plan>" --for director\`.

21. The dev's words are the spec. When you turn their feedback into tasks, add them with \`--origin dev --asked "<their words>"\`, then show the dev one card: \`npm run intent -- echo --asked "<what they asked>" --wont "<what you will not change>" --tasks <IDs> --by ${agent}\`. Anything you or an agent thought of is agent-proposed (the default); an agent-proposed mechanic waits for the dev's yes (\`npm run task -- yes <ID> --by <dev>\`), other work starts at once. Steer the queue with \`npm run task -- drop <ID> --why "…"\` and \`npm run task -- reorder <ID> --to top\`, never by editing NEXT.md. When the dev says "do it now" about a phase, they open it themselves (War Room, "Your call") or you relay it: \`npm run bible -- phase open <n> --now "<their words>" --by <dev> --source "<where they said it>"\`. The risk is logged.
22. 2.30d: only you, the Director and the planner add to the live queue; other roles' adds wait on \`npm run task -- proposed\` with a reason. Promote them in batches: \`npm run task -- promote P-3,P-4 --by ${agent}\` (or \`--all\`, \`--drop P-5\`). Builder tasks are size 3 at most: \`--size 4|5\` queues a planner split first. Forced work is "done (pending)": \`npm run task -- pending\`; a person or a reviewer from another model family closes it (\`task review <ID> --close|--reopen --by <name> --model <m>\`). Gameplay work joins the open fun wave; mark it ready when the batch is in a good state (\`npm run wave -- ready --by ${agent}\`) and keep other lanes building. While the dev is away you decide; read \`npm run away -- learned\` to see what they confirmed or sent back.

You are also the overseer. The studio's memory is its files, so whatever you learn and don't write down is lost:
- Watch how the run goes, not just the game: agents following the loop or not, refusals and why, hand-backs, drift, spend, what the harness made easy or hard.
- Each session, before you stop, evaluate it: \`npm run notes -- add --kind eval "score 1-5; what worked; what didn't; what to change next time"\`, and note harness problems with \`--kind bad|workaround|upgrade\`.
- Read \`npm run learn\` (what keeps happening, lessons that didn't stick, suggestions never handled) and turn the top item into a task, a skill change or a decision.
- Never delete or rewrite earlier notes; add newer ones. They are backed up daily if STUDIO_BACKUP_DIR is set.

Never: edit game code yourself, push to a remote (a person pushes), put keys in files, change the vision lock without a person, or change the harness itself during a test run (it is frozen; note problems instead).
Before you stop: write a log note with what the next Producer should do, and your evaluation.
`;
  }
  return `You are ${agent}, a \`${role}\` agent in a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env}\`

Read \`AGENTS.md\`, \`studio/skills/README.md\`${hasRole ? ` and \`${roleFile}\`` : ''}. Don't scan the rest of the repo; your task brief tells you what to open.

${allowedNote()}

Loop:
1. \`node harness/task.mjs next --role ${role} --agent ${agent}\` gives your most urgent task (or the one you already hold). \`node harness/task.mjs show <ID>\` shows its notes and checklist.
2. \`node harness/task.mjs start <ID> --agent ${agent} --model ${model}\`. It writes your one-page brief to \`.studio/briefs/<ID>.md\`: read that (its pre-approved tricks you may use without asking), it has the steps, what done means, notes from anyone before you, and what not to touch. If it says the history is long, run \`npm run brief -- <ID>\` and read the 300-word summary instead of the logs.
3. Claim what you will edit: \`node harness/lock.mjs claim path:<folder> --owner ${agent}\`.
4. Work in small steps; run the narrowest check first. Three failed tries: stop and hand back with a note.
5. Run \`npm run verify\` in the foreground and wait for it (never in the background), then \`node harness/task.mjs done <ID> --agent ${agent}\`. If it refuses, do what it says is missing. Only \`--force\` with a reason; the Producer will check it.
6. Release your claims (\`node harness/lock.mjs release <key> --owner ${agent}\`) and go back to 1.

Running low on usage or being stopped: \`node harness/task.mjs pause <ID> --agent ${agent} --note "what is done, what is left, files touched"\`.
Found a bug outside your task: \`node harness/task.mjs add "<what broke>" --type bug --caused-by <task, if you know it>\`.
Need the Producer: \`node harness/event.mjs --type agent.ask --agent ${agent} --to producer --msg "<question>"\`.

If \`task start\` says the studio is stopped, finish your step, hand back what you hold and wait.
Never: edit files someone else holds, change a golden hash without regenerating it in the same commit, put keys in files, push to a remote (a person pushes), or edit the harness (harness/, hub/, qa/ scripts, scripts/, tools/, studio/gates.json) during a test run: note the problem with \`npm run notes -- add --kind bad "…"\` instead. A script of your own for this game (an art pass, a capture, a check) goes in \`game/<game>/tools/\`, never in the harness's \`tools/\`.
`;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const arg = (k) => {
    const i = process.argv.indexOf(`--${k}`);
    return i >= 0 ? process.argv[i + 1] : null;
  };
  const role = arg('role');
  const agent = arg('agent');
  if (!role || !agent) {
    console.error(`Usage: npm run kickoff -- --role <role> --agent <unique-name> [--model <model>] [--tool ${Object.keys(TOOLS).join('|')}]`);
    process.exit(1);
  }
  if (SHARED_OWNERS.has(agent.toLowerCase()) && role !== 'producer') {
    console.error(`"${agent}" is shared by many agents; pick a unique name such as ${role}-1 or claude-a.`);
    process.exit(1);
  }
  const text = kickoff({ role, agent, model: arg('model') || 'unknown' });
  const dir = path.join(STUDIO_STATE_DIR, 'kickoff');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${agent}.md`), text);
  console.log(text);
  console.log(`Saved to .studio/kickoff/${agent}.md`);
  const tool = arg('tool');
  if (tool) {
    const l = launchLine(tool, { agent, model: arg('model') || 'unknown' });
    if (!l) {
      console.error(`Unknown tool "${tool}". Known: ${Object.keys(TOOLS).join(', ')}`);
      process.exit(1);
    }
    console.log(`\nLaunch it headless with ${l.name}, from the repo root:\n\n  ${l.line}\n\n${l.note}\nOne line runs one session; run it again (or in a loop) to keep the agent working. Or paste the prompt into the tool's chat.`);
  }
}

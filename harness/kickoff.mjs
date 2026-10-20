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
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';
import { SHARED_OWNERS } from './lock.mjs';

/**
 * Headless launch lines per agent tool, checked against each tool's docs (see docs/AGENT-TOOLS.md).
 * Each runs one session in this checkout with the agent's name and model in its environment, so the
 * harness commands it runs (task, lock, event) and its commits are tagged correctly.
 */
export const TOOLS = {
  claude: {
    name: 'Claude Code',
    line: (f) => `claude -p "$(cat ${f})" --permission-mode acceptEdits --allowedTools "Bash(node harness/*),Bash(npm run *),Bash(npm test*),Bash(git status*),Bash(git diff *),Bash(git add *),Bash(git commit *)" --output-format json --max-budget-usd 5`,
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
    line: (f) => `script -qc 'agy -p "$(cat ${f})"' /dev/null`,
    note: 'Wrapped in script(1): agy 1.1 can print nothing when stdout is not a terminal. Reads AGENTS.md; GEMINI.md wins if both exist.',
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

export function kickoff({ role, agent, model = 'unknown' }) {
  const roleFile = `studio/roles/${role}.md`;
  const hasRole = fs.existsSync(path.join(REPO_ROOT, roleFile));
  const env = `export STUDIO_LOCK_OWNER=${agent} STUDIO_AGENT_MODEL=${model}`;
  if (role === 'director') {
    return `You are ${agent}, the Director (Director of Knowledge) of a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env}\`

The Game Bible (\`studio/bible/\`) is the authority on what the game is; you guard it. The Producer creates and assigns tasks; you tell it whether the work is on course and what the next work should serve. Read \`${roleFile}\` and \`studio/skills/direction.md\`. Don't scan the repo.

When you are started (by a ping, daily, or by a person):
1. \`node harness/task.mjs next\` and start the open \`Director review\` task: \`node harness/task.mjs start <ID> --agent ${agent} --model ${model}\`.
2. Read \`.studio/briefs/director.md\` (why you were pinged, what finished, the drift report, ideas waiting), then the docs it lists.
3. \`npm run director -- review\`, fill in Phase, Verdict, Checked and Next.
4. Decide placed ideas: \`npm run idea -- decide <id> approve|park|reject --by ${agent} --note "…"\`.
5. Tell the Producer: \`node harness/event.mjs --type agent.ask --agent ${agent} --to producer --msg "…"\`.
6. \`node harness/task.mjs done <ID> --agent ${agent}\`, then stop.

Never: change a signed pillar, bring back a crossed-out layer, sign the Bible, assign tasks, or edit game code. Ask the person.
`;
  }
  if (role === 'producer') {
    return `You are ${agent}, the Producer of a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env} STUDIO_PRODUCER_NAME=${agent}\`

Start every session with \`npm run handoff\` and read it. New here? Read \`studio/MASTER.md\` and \`${roleFile}\` first. Don't scan the repo.

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

Never: edit game code yourself, push to a remote (a person pushes), put keys in files, or change the vision lock without a person.
Before you stop: write a log note with what the next Producer should do.
`;
  }
  return `You are ${agent}, a \`${role}\` agent in a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env}\`

Read \`AGENTS.md\`, \`studio/skills/README.md\`${hasRole ? ` and \`${roleFile}\`` : ''}. Don't scan the rest of the repo; your task brief tells you what to open.

Loop:
1. \`node harness/task.mjs next\` and pick the top task for \`${role}\` (the Producer sets priorities).
2. \`node harness/task.mjs start <ID> --agent ${agent} --model ${model}\`. It writes your one-page brief to \`.studio/briefs/<ID>.md\`: read that, it has the steps, what done means, notes from anyone before you, and what not to touch. If it says the history is long, run \`npm run brief -- <ID>\` and read the 300-word summary instead of the logs.
3. Claim what you will edit: \`node harness/lock.mjs claim path:<folder> --owner ${agent}\`.
4. Work in small steps; run the narrowest check first. Three failed tries: stop and hand back with a note.
5. \`node harness/task.mjs done <ID> --agent ${agent}\`. If it refuses, do what it says is missing. Only \`--force\` with a reason; the Producer will check it.
6. Release your claims (\`node harness/lock.mjs release <key> --owner ${agent}\`) and go back to 1.

Running low on usage or being stopped: \`node harness/task.mjs pause <ID> --agent ${agent} --note "what is done, what is left, files touched"\`.
Found a bug outside your task: \`node harness/task.mjs add "<what broke>" --type bug --caused-by <task, if you know it>\`.
Need the Producer: \`node harness/event.mjs --type agent.ask --agent ${agent} --to producer --msg "<question>"\`.

Never: edit files someone else holds, change a golden hash without regenerating it in the same commit, put keys in files, or push to a remote (a person pushes).
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

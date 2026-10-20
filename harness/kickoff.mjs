#!/usr/bin/env node
/**
 * harness/kickoff.mjs — a paste-ready opening prompt for any agent tool (Claude Code, Cursor, Codex,
 * Gemini CLI, Grok, Aider, a local model). One per agent, so every agent starts the same way.
 *
 *   npm run kickoff -- --role builder --agent claude-a --model claude-opus-5-5
 *   npm run kickoff -- --role producer --agent grok-producer --model grok-4
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

export function kickoff({ role, agent, model = 'unknown' }) {
  const roleFile = `studio/roles/${role}.md`;
  const hasRole = fs.existsSync(path.join(REPO_ROOT, roleFile));
  const env = `export STUDIO_LOCK_OWNER=${agent} STUDIO_AGENT_MODEL=${model}`;
  if (role === 'producer') {
    return `You are ${agent}, the Producer of a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env} STUDIO_PRODUCER_NAME=${agent}\`

Start every session with \`npm run handoff\` and read it. New here? Read \`studio/MASTER.md\` and \`${roleFile}\` first. Don't scan the repo.

Your job is decisions, not code:
1. Clear "Needs you first": \`Check forced done\` tasks (run the named check, then accept or \`node harness/task.mjs reopen <ID> --reason "…"\`) and \`Watch:\` tasks (\`npm run watch\` for details).
2. Keep the queue short and lanes separate: \`node harness/task.mjs add "<title>" --role <role> --type <kind> --size <1-5> --priority <P0-P3>\`. One task, one job.
3. Call a meeting when a decision needs several roles: \`node harness/meeting.mjs start "<topic>" --with <names or roles>\`.
4. Read "What the studio learned" in the briefing and accept or reject each suggestion in your log.
5. Write down what you decide and why: \`node harness/handoff.mjs note "what, why, next"\`. Change \`studio/PLAN.md\` when the phase moves.
6. When the harness itself helps or gets in the way, record it: \`npm run notes -- add --kind well|bad|workaround|upgrade "…"\`.
7. Route work by results: \`npm run scorecard\` shows bugs per model per 10 points of task size.

Never: edit game code yourself, push to a remote (a person pushes), put keys in files, or change the vision lock without a person.
Before you stop: write a log note with what the next Producer should do.
`;
  }
  return `You are ${agent}, a \`${role}\` agent in a game studio that runs on this repo. You run on ${model}.

Set up once in your shell: \`${env}\`

Read \`AGENTS.md\`, \`studio/skills/README.md\`${hasRole ? ` and \`${roleFile}\`` : ''}. Don't scan the rest of the repo; your task brief tells you what to open.

Loop:
1. \`node harness/task.mjs next\` and pick the top task for \`${role}\` (the Producer sets priorities).
2. \`node harness/task.mjs start <ID> --agent ${agent} --model ${model}\`. It writes your one-page brief to \`.studio/briefs/<ID>.md\`: read that, it has the steps, what done means, notes from anyone before you, and what not to touch.
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
    console.error('Usage: npm run kickoff -- --role <role> --agent <unique-name> [--model <model>]');
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
}

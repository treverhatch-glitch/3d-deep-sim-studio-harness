/**
 * harness/task-pin.mjs — 2.77.0 (n, B-92 launcher side): a session started with --task works only that task.
 *
 * The crew's evidence: builder-agy10 was started with `--task T-152`, took a P0 rescue (T-183) instead and ran
 * `task done --train` for it, with T-152's unlanded commits in its lane. The launcher (harness/agent.mjs runAgent)
 * now gives every session it starts on a task (any tool: claude, agy, codex, a custom command) STUDIO_TASK_PIN=<task>
 * in its environment, records `pinned` on the session, and says so in the kickoff. From such a session:
 *   - `task start <other>` is refused (task.start_refused, meta.pin), and so is
 *   - `task done <other>` in every form that closes or queues it (plain, --train); --check and --train-check (read
 *     only, and the train's own lane check) are not.
 * The pinned task itself is never refused. A rescue or a P0 for another task is someone else's session.
 * STUDIO_TASK_PIN is set only by the launcher; a person's shell has none, so nothing changes there.
 */

const ID = /^[A-Za-z][\w.-]{0,40}$/;

/** The task this session is pinned to (STUDIO_TASK_PIN), or null. */
export function pinnedTask(env = process.env) {
  const v = String(env.STUDIO_TASK_PIN || '').trim();
  return v && ID.test(v) && !/^(off|none|0|false|no)$/i.test(v) ? v : null;
}

/**
 * '' when this session may act on taskId, else the refusal text. action: 'start' | 'done' | 'train'.
 */
export function pinRefusal(taskId, { action = 'start', env = process.env } = {}) {
  const pin = pinnedTask(env);
  const id = String(taskId || '').trim();
  if (!pin || !id || id.toLowerCase() === pin.toLowerCase()) return '';
  const who = String(env.STUDIO_LOCK_OWNER || '').trim() || 'this session';
  const verb = action === 'train' ? `queue ${id} for the train (task done --train)` : action === 'done' ? `close ${id} (task done)` : `start ${id}`;
  return `${who} was started on ${pin} and works only that task, so it can't ${verb} (B-92: a session started with --task keeps it). Finish ${pin} (task done ${pin}) or hand it back (task pause ${pin} --note "…"), then stop: ${id} gets a session of its own from the supervisor or the Producer.`;
}

/** The kickoff line for a pinned session. */
export const pinKickoff = (task) => `\nThis session is pinned to ${task}: work only ${task}. \`task start\` of any other task is refused here, and so is \`task done\` (or \`--train\`) of another task. A rescue, a P0 or a task you notice on the board is someone else's session: say it in your hand-back note instead. When ${task} is done or handed back, stop.\n`;

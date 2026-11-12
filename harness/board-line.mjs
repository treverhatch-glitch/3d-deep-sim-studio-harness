/**
 * harness/board-line.mjs — 2.84: the one pattern for a task line on the board (studio/NEXT.md, studio/DONE.md).
 *
 * "- [ ] **T-123** [P1] (`builder`) — Title", plus the drifts people make by hand (2.58.0, P-057): an ASCII "-" (or
 * "--", "–") for the "—", a role without backticks, "[X]", a "*" bullet, a lower-case priority. Groups: 1 the mark,
 * 2 the id, 3 the priority, 4 the backtick (or none), 5 the role, 6 the title. harness/task.mjs reads and writes the
 * board with it; a reader that needs no more than ids, roles and titles imports it from here (no other imports).
 */
export const TASK_LINE_RE = /^[-*]\s+\[([ xX>~])\]\s+\*\*([A-Z]+-\d+)\*\*\s+\[([Pp][0-3])\]\s+\((`?)([^`()]+?)\4\)\s+(?:—|–|--?)\s+(.+)$/;

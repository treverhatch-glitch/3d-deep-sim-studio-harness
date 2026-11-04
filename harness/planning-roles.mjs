/**
 * harness/planning-roles.mjs — the planning roles (Producer, Director, Planner), in a module with no imports.
 * 2.67.0: worktree.mjs and profile-guard.mjs read it from here instead of from stall.mjs. stall.mjs's CLI uses
 * top-level await, and once task-hold.mjs imported reclassify.mjs (B-38), `node harness/stall.mjs` reached
 * worktree.mjs before stall.mjs had defined the set: "Cannot access 'PLANNING_ROLES' before initialization".
 */
// 2.76.0 (k): the Line Producer (harness/line-producer.mjs) is code on the supervisor's loop; a session someone starts in
// that role (a judgement call) works in the main checkout like the other planning roles.
export const PLANNING_ROLES = new Set(['producer', 'director', 'planner', 'line-producer']);

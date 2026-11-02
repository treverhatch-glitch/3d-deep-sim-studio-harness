/**
 * harness/planning-roles.mjs — the planning roles (Producer, Director, Planner), in a module with no imports.
 * 2.67.0: worktree.mjs and profile-guard.mjs read it from here instead of from stall.mjs. stall.mjs's CLI uses
 * top-level await, and once task-hold.mjs imported reclassify.mjs (B-38), `node harness/stall.mjs` reached
 * worktree.mjs before stall.mjs had defined the set: "Cannot access 'PLANNING_ROLES' before initialization".
 */
export const PLANNING_ROLES = new Set(['producer', 'director', 'planner']);

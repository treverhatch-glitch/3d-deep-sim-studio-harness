# Handoff: round 2.87, shorter with the same behaviour (`studio/notes/HANDOFF-2.87-2026-11-16.md`)

Written by the harness maintainer session (Fable 5.2) on 2026-11-16. Release notes: docs/RELEASE-2.87.0.md. Only the
two newest handoffs and release notes are kept; older ones are in git history.

## Where it stands

- 2.87 is on `claude/287`. It is not merged: the owner says when.
- 2.86.1 (one engine-train fix, P-339) is on `claude/2861`, pull request #88, not merged. 2.87 was branched from
  2.86.0: whichever lands second merges main first (CHANGELOG.md, PROBLEMS.md and the version will conflict).
- A crew runs 2.86.0 since 14 November. Its land script and game file have not taken 2.86's settings (see the release
  notes): the note for the overseer says which.
- The consolidation map (a document of 15 November, outside the repository) lists the later steps. Its estimates for
  one-line helpers are wrong by a wide margin (P-341); its overlap findings stand.

## How the round was built

- **Comments.** A tool (kept outside the repository) listed every comment over the rule with the three lines of code
  after it. Ten helpers each rewrote one batch as JSON, never touching a file; the tool refused any text that was not
  purely a comment, was over its cap, still cited a release, dropped a JSDoc tag line or changed the indent, then put
  the text back by exact match. `scripts/same-code.mjs` then compared code tokens with the commit before.
- **The test kit.** One helper wrote a codemod on the TypeScript parser: a definition was replaced only when its body
  equalled the kit's, or equalled it but for one captured `const`. A second pass merged exports that were one function
  under different parameter names.

## Decisions made on judgment

1. **A hard cap, and no exceptions list.** The longest headers held real descriptions (the train's steps, the hook
   stamp's limits). They also repeated docs/WORK-ORGANIZATION.md and docs/SECURITY.md. One rule that a check can hold
   was worth more than keeping two copies.
2. **Version numbers of tools are not release numbers.** The first pass dropped "git 2.38+" because the form check
   read it as a release. Four were restored by hand.
3. **The harness's own helpers wait.** Replacing one-line definitions saves about 100 lines over 236 files. It goes
   with the next round's merges, where a shared module is needed anyway.
4. **A fault found in the field goes out on its own.** 2.86.1 is a separate, small pull request so a crew can take it
   without the 640-file trim.

## For the next round

- The map's step 2: reports that compute the same measure, the folder-size walk (three copies), the two code stamps,
  briefs and planning helpers, and a shared helper module for `harness/`.
- The stop a test stand-in could not show (P-339): give every stand-in land script the habits of a real one (it
  records, it is slow, it ignores what it does not know).

# Patch #2 crosscheck (`docs/PATCH-2-CROSSCHECK.md`)

The crew's list of 2026-11-04 (items P1.1 to P9.7) against what shipped in 2.76.0, 2.76.1 and 2.77.0.
DONE = shipped (version, commit). DONE (differently) = shipped another way, with the reason. PARTLY = what is left.

| ID | Status | What shipped |
|---|---|---|
| P1.1 | DONE | 2.76.0 563e517, 391acde: beta mode (`npm run beta -- on\|off\|status`): releases, golden re-records, protected approvals, asks, type, park/unpark without the owner key, each use logged. 2.77.0 093cf87: the daily digest lists them ("Beta mode" section). |
| P1.2 | DONE | 2.76.0 87079ce: in beta mode the hand-back cap goes to the orchestrator and the Producer, with one Rescue task. |
| P1.3 | DONE | 2.76.0 87079ce: infrastructure hand-backs don't count; a release is kept for the same task and commit. |
| P1.4 | DONE | 2.76.0 391acde: `delegate -- claude-settings --owner --dir <folder> --write` writes the owner's command rules into the orchestrator's own folder. 2.77.0 d2ecdf5: plus agent stop/pause, task park/block/unblock/pause, beta on/off. |
| P1.5 | DONE | 2.76.0: never money, spending, payments or deletes; workers never act as the owner; tests and the train's full verify stay. |
| P2.1 | DONE | 2.76.0 76e893c (B-88): life record and heartbeat; a dead train is found, recorded with its last step, its lock freed and its lanes kept for the next train. |
| P2.2 | DONE | 2.76.0 f2f5e7a (B-89): test workers are shared by cores, the train's verify first. |
| P2.3 | DONE | 2.76.0 ace09db (B-90/W-0084). |
| P2.4 | DONE | 2.76.0 2cab572: the train refuses a mixed lane before its verify. 2.77.0 768f42e: the launcher doesn't merge one either (`lane.mixed_skipped`). |
| P2.5 | DONE | 2.77.0 (n): a session started with `--task` is pinned to it (`task start`/`task done` of another task refused); the train refuses mixed lanes (2.76.0). |
| P2.6 | DONE | 2.76.0 391acde (B-93): approvals hash text with LF endings. |
| P2.7 | DONE | 2.76.0 7ba7d1d (B-94). |
| P2.8 | DONE | = P1.4. |
| P2.9 | DONE | 2.77.0 383f5c2 (B-96): a new lane copy carries the branch holding the task's approved contents. |
| P2.10 | DONE | 2.76.0 87079ce (W-0081): a missing lane copy is made again from its branch. |
| P2.11 | DONE (differently) | 2.76.0 4281e52: W-0070, W-0072, W-0073 folded in. W-0071 (12 test workers) is replaced by B-89's core shares: remove the local cap. |
| P4.1 | PARTLY | 2.76.0 f492409: builder target from the rig, why each task can't start, stale locks, lost lane copies, chain-breakers first on the strongest model. Left: the Line Producer doesn't build a clean lane for a mixed one by itself; `npm run lane -- create <T-ID> --from <branch>` (2.77.0 5d45bdd) does it in one command. |
| P4.2 | PARTLY | 2.76.0 f2f5e7a + 2.77.0 e45dc9f: a live job catalog (train verify, builder verify, lane check, soak, Unity, art bake) with one priority table. Left: filling idle capacity with long lanes; multi-rig beyond remote workers. |
| P4.3 | DONE | 2.77.0 (n): Flash for small, Argon for normal, Claude for hard/chain-breakers and after a Gemini failure; no model trials on chain-breakers. |
| P4.4 | DONE | 2.76.0 f492409. |
| P4.5 | DONE | 2.76.0 3cd6af0. |
| P4.6 | DONE | 2.76.0 e65328d. |
| P5.1 | DONE | 2.77.0 (u): engine passes are board tasks (`--track engine:<x> --scope --visual-check --refs`), judged in their own repo, launched into a worktree of it. |
| P5.2 | DONE | 2.77.0 (u): the engine train is the landing path, started by the Line Producer beside the web train (own lock). Not yet run against a real Unity editor. |
| P5.3 | DONE | 2.77.0 (u): the land run is a recorded heavy job, started in quiet windows; infrastructure aborts stay NOT RUN. |
| P5.4 | DONE | 2.77.0 (u): `npm run engine -- tune` for the listed settings, logged with an undo. |
| P5.5 | DONE | 2.77.0 (u): `npm run visual -- …`: fixed-camera shots, reference photos side by side, the builder's look, a review by someone else ("toyish" blocks done), shots sent to the owner. No code scores a picture. |
| P5.6 | DONE | 2.77.0 (u): one engine table (harness/engine-tracks.mjs) for Unity, Godot or any engine. |
| P6.1–P6.4 | DONE | 2.76.0 8a06793: the Communicator. |
| P7.1 | DONE | 2.77.0 782d0f0: `npm run remote -- mark\|brief\|fetch`; cloud branches land only through the normal train. |
| P7.2 | DONE | 2.77.0: docs/REMOTE-WORKERS.md says how to point it at a push-enabled remote; the train, board, locks, .studio and Unity stay local. |
| P8.1 | DONE (differently) | 2.76.0 00fb2d6: the write_file rule and GEMINI.md. Pipes and chains are not allowed by a rule on purpose (a chain rule lets any command through); GEMINI.md tells Gemini to run one command per call. |
| P8.2 | DONE | 2.76.0 4281e52. |
| P8.3 | DONE | 2.77.0 (n): agy refuses a non-Gemini model unless forced. |
| P8.4 | DONE | 2.77.0 (n) pinning; 2.76.0 ace09db stale owners. |
| P8.5 | DONE | 2.77.0 (n): the protected step is routed to an approver (beta or proxy) and the task held, instead of stranded. |
| P8.6 | DONE | 2.77.0 (n): model pools in studio/models.json, Gemini preferred, success rate per size. agy has no quota command in the evidence: its quota is read only if `STUDIO_AGY_QUOTA_CMD` names one. |
| P8.7 | DONE | 2.77.0 (n): agy usage and model recorded, or "not reported" with an estimate (never 0). |
| P9.1 | DONE (differently) | 2.77.0 db1b0d0: record files on main don't restart a train; a file some checks read re-runs only those checks. No main freeze: re-running the affected checks covers the case without blocking main. |
| P9.2 | DONE | 2.77.0 5741208. |
| P9.3 | DONE | 2.77.0 fd52df7: known-red-on-main tests listed once, with a counter. |
| P9.4 | DONE | 2.77.0 5d45bdd: `npm run lane -- create`. |
| P9.5 | DONE | 2.77.0 fd52df7: if the only reds are known-red tests that also fail on main alone, the train lands and reports them. |
| P9.6 | PIPELINE | see the 2.77.0 CHANGELOG entry. |
| P9.7 | DONE | = P5.2. |

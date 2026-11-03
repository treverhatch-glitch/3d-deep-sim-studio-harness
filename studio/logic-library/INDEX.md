# Gameplay logic library (`studio/logic-library/INDEX.md`)

Code a game here already landed, for the next game or the next task to reuse. Written by `npm run logic -- index`
(add and confirm rewrite it) from `library.json`; one line per module: name, stack, what it does, interface,
assumptions, the game and harness version it landed in, its tests and golden. Before writing gameplay logic:
`npm run logic -- need "<what>"`. Each module keeps its code and a language-neutral `spec.json` under `modules/<name>/`.

- **example-step-toward** [ts] moves a number toward a target by at most a fixed step per call, never past it (made-up example) · `stepToward(value: number, target: number, maxStep: number): number` · assumes plain finite numbers; a negative step counts as 0 · example (made up) @ 2.72.0 · tests: spec 5 case(s); golden: none · confirmed (example)

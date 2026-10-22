# Cheat sheet (`studio/CHEATSHEET.md`)

Tricks and tools that make agents faster or cheaper on game work. One entry per line:
`- C-NN [tags] trick → link (licence; note)`. Keep it under 150 lines; never reuse an id.

**How it is used.** Before a task is handed out, whoever assigns it (the Producer, or the Director)
runs `npm run cheatsheet -- attach <ID> --by <name>`: it matches the task's title and tags against the
`[tags]` here and attaches up to 3 matching lines to the task's brief as **pre-approved**: the agent may
use them for that task without asking. The approval is recorded (`cheatsheet.preapproved`: task, trick
ids, approved by). Anything not attached follows the normal approval rules (AGENTS.md section 5).
One small file read, no wait. The Director refreshes this file weekly from the scout. Nothing here is
installed by the harness; an entry is a pointer, not a dependency. Licences marked "check" have not
been confirmed for commercial use.

## For the Director and Producer (planning, splitting, assigning, check-ins)
Tagged `director`; `npm run cheatsheet -- match "<what you are planning>" --for director` shows them.
- C-01 [director, plan, queue, dependency, after, blocked] Hand out only work whose prerequisites are merged and whose files are free: `--after T-n`, `task block`, `npm run task -- holds` → harness/task-hold.mjs (this repo)
- C-02 [director, plan, split, size, queue] Builder tasks are size 3 or less; split a 4 or 5 into linked parts before queueing (`task add --size`) (this repo)
- C-03 [director, assign, lane, owner, parallel] One owner per lane: give every builder task a `--lane <folder>`, never two builders in one folder → studio/rules/lanes.md (this repo)
- C-04 [director, checkin, refresh, session, long] A "Check <agent>" card: continue only with a live repro, otherwise hand off → `npm run session -- check` (this repo)
- C-05 [director, model, assign, tier, cost] Route by tier: builders mid, planning top, check-ins cheap, reviewer another family → `npm run models:check` (this repo)
- C-06 [director, plan, history, brief, long] Long task history: `npm run brief -- <ID> --model` before a strong model reads it → harness/prepare-brief.mjs (this repo)
- C-07 [director, queue, duplicate, retry, loop] Before re-queueing, check what was already tried: the task's hand-back notes and `git log --grep <ID>` → studio/handoffs (this repo)
- C-08 [director, review, scorecard, route] Route by results: bugs per model per 10 points → `npm run scorecard` (this repo)

## The harness's own tricks
- C-09 [verify, gates, test, done] Run the narrowest gate first, then `npm run verify` once in the foreground → scripts/run-gates.mjs (MIT; this repo)
- C-10 [golden, hash, sim, determinism] A changed golden hash: `npm run golden -- --update` in the same commit; see what moved with scripts/golden-diff.mjs → qa/golden (this repo)
- C-11 [bug, replay, regression, seed] Replay the failing seed/tick instead of re-running the game: `node harness/replay.mjs --trace .studio/last-seed-failure.json` → harness/replay.mjs (this repo)
- C-12 [bug, lesson, memory] Distil a fixed bug into 4 bullets so the next agent doesn't relearn it → scripts/distill-bug.mjs (this repo)
- C-13 [find, function, code, search, map] One call finds a function, constant or TUNING key: `npm run map -- find <name>` → harness/map.mjs (this repo)
- C-14 [context, refresh, handoff, long] Refresh at the task boundary or ~120k tokens / 40 turns: hand back with done / failed / next / rules, a fresh session continues → harness/session-cap.mjs (this repo)
- C-15 [tokens, shell, output, unattended] Filter shell output before the agent reads it → https://github.com/rtk-ai/rtk (Apache-2.0; `npm run setup:token-savers`, off by default)
- C-16 [docs, markdown, search, context] Read a paragraph, not the whole doc: local markdown search → https://github.com/tobi/qmd (MIT; off by default)
- C-17 [code, symbol, refactor, lsp] Symbol-level lookups and edits over LSP → https://github.com/oraios/serena (MIT; off by default)
- C-18 [browser, ui, hud, screenshot, qa, web] Browser snapshots and screenshots for QA → Playwright MCP (Apache-2.0; on)
- C-19 [perf, web, fps, lighthouse] Perf traces and Lighthouse for the web build → Chrome DevTools MCP (Apache-2.0; off)
- C-20 [playtest, video, recording, review] Index screen recordings into searchable frames, OCR and transcripts → https://github.com/oxbshw/watch-skill (MIT)
- C-21 [art, blender, model, 3d, asset] Agent-driven Blender → blender-mcp / blender-orchestrator (MIT / see repo)
- C-22 [godot, engine, editor, port] Agent control of the Godot editor → https://github.com/hi-godot/godot-ai (MIT)
- C-23 [reverse, binary, build, pck] Inspect a built game (Godot PCK, IL2CPP, web bundles) → https://github.com/morluto/rea (MIT; pinned at rea-agents@6.7.0)

## Engine and tests
- C-24 [godot, run, debug, scene, engine] Run the Godot project, read its debug output and edit scenes over MCP → https://github.com/Coding-Solo/godot-mcp (MIT)
- C-25 [godot, test, unit, gate, gdscript] Godot unit tests for fast in-session checks → https://github.com/bitwes/Gut (MIT)
- C-26 [godot, test, ci, gdscript] Godot test framework with a CI runner → https://github.com/MikeSchulze/gdUnit4 (MIT)
- C-27 [docs, api, godot, library, version] Current library docs for agents (Godot 4.x APIs), so nobody guesses old APIs → https://github.com/upstash/context7 (MIT)

## Tokens, sessions and memory
- C-28 [tokens, usage, ledger, claude] Read Claude Code's own usage logs per session → https://github.com/ryoppippi/ccusage (MIT)
- C-29 [context, compaction, handoff, hermes] Write the hand-back as the last turn on the already-cached prompt, not with a separate summariser → https://github.com/Elevatormusic/hermes-warm-compaction (Apache-2.0)
- C-30 [logs, search, history, jsonl, memory] Query big JSONL logs and task history without loading them into context → https://github.com/elstongun/leviathan (licence: check)
- C-31 [hermes, plugins, quota] Official Hermes plugins (incl. Claude Subscription DirectSDK) → https://github.com/NousResearch/hermes-official-plugins (MIT)
- C-32 [memory, handoff, hermes, workspace] Ideas for long-lived agent memory and a shared workspace → https://github.com/pju-hoge/a-letter-to-junior-agents (licence: check)
- C-33 [tracing, eval, agents, sessions] Traces and evals per agent and session → https://github.com/langfuse/langfuse (MIT core)
- C-34 [routing, models, budget, gateway] Gateway with per-key budgets, for model routing → https://github.com/BerriAI/litellm (MIT core)

## Review and rules
- C-35 [claude, plugins, hooks, review] Official Claude Code plugins; take only claude-md-management, hookify, code-review, pr-review-toolkit, code-simplifier, session-report, skill-creator, security-guidance → https://github.com/anthropics/claude-plugins-official (Apache-2.0)
- C-36 [rules, hooks, force, guard] Turn a repeated bad pattern into a hook (for example "no --force") → hookify in claude-plugins-official (Apache-2.0)
- C-37 [regression, agents, ci, failures] Graded agent traces; failures become replay tests → https://github.com/jwuthri-cloud/Tracely-ai (MIT)
- C-38 [subagents, plugins] A marketplace of subagents; pick single ones → https://github.com/wshobson/agents (MIT)
- C-39 [safety, sandbox, exec, network] Sandbox that limits what an agent can run, read and reach → https://github.com/strands-agents/box (licence: check)
- C-40 [tasks, memory, issues] Git-backed issue memory for agents (reference for the NEXT/DONE split) → https://github.com/steveyegge/beads (reference)

## Audio, art and trailers
- C-41 [audio, sound, sfx, music, qa] Agents hear, review and make sound, CPU-only (an audio QA gate) → https://github.com/Leonxlnx/earshot (MIT)
- C-42 [audio, music, sfx, placeholder] Local background music and sound effects (Apple Silicon) → https://github.com/kanaworksai-hue/audio-studio-mcp (MIT)
- C-43 [voice, tts, dialogue] Text-to-speech for voiceovers, dev-side only → https://huggingface.co/fishaudio/drama-3 (licence "other": check before any use)
- C-44 [concept, art, image] Fast text-to-image for concept art → https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo (licence "other": check)
- C-45 [concept, art, image, edit] Image-to-image edits for concept art → https://huggingface.co/black-forest-labs/flux-3-image-klein (licence "other": check)
- C-46 [trailer, video, promo] Agent-made promo films with music → https://github.com/alchaincyf/huashu-motion (MIT)
- C-47 [trailer, video, html] HTML to video, built for agents → https://github.com/heygen-com/hyperframes (Apache-2.0)

## Models for cheap roles
- C-48 [model, cheap, reader, vision, checker] A cheap, fast model that reads images; a candidate for check-ins and summaries → https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash-1017 (MIT)
- C-49 [embeddings, search, cheatsheet, history] Embeddings to search this sheet and task history → https://huggingface.co/google/embeddinggemma-2 (apache-2.0)
- C-50 [scout, news, models] Daily radar of new models, products and repos, to keep this sheet fresh → https://github.com/zhuyansen/new-term-radar (MIT)

## Art: free assets and references (record every one: `npm run asset -- add … --licence … --source …`)
Only CC0 or CC-BY files go into the game; CC-BY needs its credit line in the asset ledger. References (style, mechanics) go to `npm run ref -- add`, never into assets/.
- C-51 [art, asset, texture, hdri, model, cc0] CC0 textures, HDRIs and models (send a User-Agent header) → https://polyhaven.com (CC0)
- C-52 [art, asset, sprite, model, ui, audio, cc0, placeholder] CC0 game asset packs: sprites, UI, 3D kits, sounds → https://kenney.nl/assets (CC0)
- C-53 [art, asset, texture, material, pbr, cc0] CC0 PBR materials and textures → https://ambientcg.com (CC0)
- C-54 [art, asset, sprite, audio, music, opengameart] Community game art and audio; licences vary per file, take only CC0 or CC-BY → https://opengameart.org (per file: check)
- C-55 [art, asset, model, 3d, sketchfab] Downloadable 3D models; filter to CC0 or CC-BY and keep the author's credit → https://sketchfab.com/features/free-3d-models (per model: check)

## QA and eyes (playing the build like a person)
- C-56 [qa, playtest, browser, click, screenshot, console] Load, click, screenshot and read the console of the web build → https://github.com/microsoft/playwright-mcp (Apache-2.0; in studio/plugins.json, on)
- C-57 [qa, perf, fps, browser, trace] FPS, perf traces and Lighthouse on the web build → https://github.com/ChromeDevTools/chrome-devtools-mcp (Apache-2.0; in studio/plugins.json)
- C-58 [qa, playtest, visual, human, browser] Human-like visual playtests by an agent driving the browser → https://github.com/browser-use/browser-use (MIT)
- C-59 [qa, playtest, scripted, browser, regression] Reliable scripted browser runs (act/extract/observe) → https://github.com/browserbase/stagehand (MIT)

## Web prototype engines (throwaway prototypes; real builds go through the Godot web export)
- C-60 [prototype, web, 2d, phaser] 2D web game framework → https://github.com/phaserjs/phaser (MIT)
- C-61 [prototype, web, 3d, threejs, renderer] 3D rendering in the browser → https://github.com/mrdoob/three.js (MIT)
- C-62 [prototype, web, 3d, physics, inspector, babylon] 3D engine with built-in physics and an inspector → https://github.com/BabylonJS/Babylon.js (Apache-2.0)
- C-63 [prototype, web, 3d, playcanvas] 3D web engine → https://github.com/playcanvas/engine (MIT)
- C-64 [prototype, web, 2d, kaplay, fast] Very fast 2D prototypes → https://github.com/kaplayjs/kaplay (MIT)

## Sim and physics rules
- C-65 [sim, physics, collision, vehicle, boat, movement, steering, godot, jolt] Moving game objects (vehicles, boats, people) have real collision shapes and move through the engine's physics and collision queries (Godot: Jolt, move_and_slide / shape casts) with avoidance steering; never scripted position moves that skip collision → Godot Jolt physics docs (rule)

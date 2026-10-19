# Serena (Symbol-Level Code Access)

Recommended for large codebases (50k+ lines). Lets agents look up and edit by symbol (functions, classes, types) over LSP instead of reading whole files.

## Why it helps

- Avoids loading entire files of a 100k-line TypeScript project into context.
- Works with TypeScript.
- Complements RTK (shell output) and QMD (docs).

## Setup (high level)

Serena is typically used as an MCP server. See the upstream repo for current install steps:

https://github.com/oraios/serena

Once running, agents should prefer symbol lookup / targeted edits over full-file reads when working in the sim or large modules.

## When to add it

Add Serena (or an equivalent LSP-based tool) once the game codebase is large enough that full-file reads become expensive. It is optional for small projects.

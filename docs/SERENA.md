# Serena — Symbol-Level LSP Code Access (`docs/SERENA.md`)

Essential for 50,000–100,000+ line TypeScript simulations. Lets agents look up and edit functions, classes, and interfaces by symbol over the TypeScript Language Server (LSP) instead of reading whole 2,000-line files into context.

Upstream: **https://github.com/oraios/serena**

## Pre-Configured in `.mcp.json`

Running `./scripts/setup-token-savers.sh` writes the `serena` entry into [`.mcp.json`](../.mcp.json):

```json
{
  "mcpServers": {
    "serena": {
      "command": "uvx",
      "args": [
        "--from",
        "git+https://github.com/oraios/serena@v2.1.0",
        "serena",
        "start-mcp-server",
        "--context",
        "ide",
        "--project",
        "."
      ]
    }
  }
}
```

Complements **RTK** (`rtk-ai/rtk` for shell output compression) and **QMD** (`tobi/qmd` for local Markdown RAG).

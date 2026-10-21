#!/usr/bin/env node
// Checks the optional token-saver tools (rtk, qmd, uvx for serena, jq, duckdb) and, with --install, tries
// to install the missing ones it can. Writes .mcp.json and .claude/settings.json only when they are
// missing (both ship with the repo). Plain Node, so it runs in PowerShell without Git Bash.
//   node scripts/setup-token-savers.mjs [--check | --install]
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const install = process.argv.includes('--install');
const win = process.platform === 'win32';
const where = (bin) => {
  const r = spawnSync(win ? 'where' : 'which', [bin], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.split(/\r?\n/)[0].trim() : null;
};
const sh = (cmd, args) => spawnSync(cmd, args, { stdio: 'inherit', shell: win }).status === 0;

const TOOLS = [
  ['rtk', 'cargo install --git https://github.com/rtk-ai/rtk (or brew install rtk-ai/tap/rtk)'],
  ['qmd', 'npm install -g github:tobi/qmd'],
  ['uvx', 'pip install uv (runs the serena MCP server)'],
  ['jq', win ? 'winget install jqlang.jq' : 'brew install jq / apt install jq'],
  ['duckdb', win ? 'winget install DuckDB.cli' : 'brew install duckdb'],
];

console.log(`Token-saver tools (${install ? '--install' : '--check'})`);
for (const [bin, hint] of TOOLS) {
  const at = where(bin);
  console.log(at ? `  [OK] ${bin}: ${at}` : `  [MISSING] ${bin}: ${hint}`);
}

if (install) {
  console.log('\nInstalling what can be installed from here...');
  if (!where('rtk') && where('cargo')) sh('cargo', ['install', '--git', 'https://github.com/rtk-ai/rtk']);
  if (where('rtk')) sh('rtk', ['init', '-g']);
  if (!where('qmd') && where('npm')) sh('npm', ['install', '-g', 'github:tobi/qmd']);
}

const MCP = {
  mcpServers: {
    qmd: { command: 'qmd', args: ['mcp'] },
    serena: { command: 'uvx', args: ['--from', 'git+https://github.com/oraios/serena@v2.1.0', 'serena', 'start-mcp-server', '--context', 'ide', '--project', '.'] },
    playwright: { command: 'npx', args: ['-y', '@playwright/mcp@0.0.83', '--headless', '--caps=vision'] },
  },
};
const SETTINGS = {
  hooks: {
    SessionStart: [{ matcher: '', hooks: [{ type: 'command', command: 'node scripts/session-start.mjs' }] }],
    PreCompact: [{ matcher: '', hooks: [{ type: 'command', command: 'node scripts/pre-compact.mjs' }] }],
  },
};
for (const [rel, body] of [['.mcp.json', MCP], ['.claude/settings.json', SETTINGS]]) {
  const file = path.join(ROOT, rel);
  if (fs.existsSync(file)) {
    console.log(`  [OK] ${rel} already exists; left as it is.`);
    continue;
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n');
  console.log(`  [WROTE] ${rel}`);
}

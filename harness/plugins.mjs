#!/usr/bin/env node
/**
 * harness/plugins.mjs — the plugin registry (studio/plugins.json).
 *
 *   node harness/plugins.mjs list               every plugin, its licence, division and on/off
 *   node harness/plugins.mjs enable <id>        switch one on (plugins marked approval: human ask first)
 *   node harness/plugins.mjs disable <id>
 *   node harness/plugins.mjs mcp                MCP config JSON for every enabled plugin with an MCP server
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const PLUGINS_FILE = path.join(REPO_ROOT, 'studio', 'plugins.json');

export function readPlugins() {
  return JSON.parse(fs.readFileSync(PLUGINS_FILE, 'utf8'));
}

function save(cfg) {
  fs.writeFileSync(PLUGINS_FILE, JSON.stringify(cfg, null, 2) + '\n');
}

export function mcpConfig(cfg = readPlugins()) {
  const servers = {};
  for (const p of cfg.plugins) if (p.enabled && p.mcp) servers[p.id] = p.mcp;
  return { mcpServers: servers };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd = 'list', id] = process.argv.slice(2);
  const cfg = readPlugins();
  const find = () => {
    const p = cfg.plugins.find((x) => x.id === id);
    if (!p) {
      console.error(`No plugin "${id}". Run: node harness/plugins.mjs list`);
      process.exit(1);
    }
    return p;
  };
  if (cmd === 'list') {
    for (const p of cfg.plugins) {
      console.log(`${p.enabled ? '[on] ' : '[off]'} ${p.id.padEnd(22)} ${String(p.license).padEnd(11)} ${String(p.division).padEnd(11)} ${p.what}`);
    }
  } else if (cmd === 'enable' || cmd === 'disable') {
    const p = find();
    p.enabled = cmd === 'enable';
    save(cfg);
    emitEvent({ type: `plugin.${cmd}`, agent: process.env.STUDIO_LOCK_OWNER || 'producer', target: p.id, msg: `${p.name} ${cmd}d` });
    console.log(`${p.name} ${cmd}d.${p.enabled && p.approval === 'human' ? ` A person approves its use; read ${p.rules}.` : ''}${p.enabled && p.install ? ` Install: ${p.install}` : ''}`);
  } else if (cmd === 'mcp') {
    console.log(JSON.stringify(mcpConfig(cfg), null, 2));
  } else {
    console.log('Usage: node harness/plugins.mjs list | enable <id> | disable <id> | mcp');
    process.exit(1);
  }
}

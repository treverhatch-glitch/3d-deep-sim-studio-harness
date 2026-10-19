#!/usr/bin/env node
/**
 * harness/agents.mjs — Unlimited Dynamic Role, Department & Swarm Loader
 *
 * Ships with the 5 lean starter roles (`producer`, `designer-calibrator`,
 * `builder`, `qa-playtester`, `reviewer`) in `studio/roles/`, while allowing
 * studios to define an UNLIMITED number of custom agents, departments, or
 * nested swarms in `studio/roles/` (including subdirectories) and `studio/presets/`.
 *
 * Zero agent caps. Zero vendor lock-in.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { getChainForRole } from './models.config.mjs';
import { REPO_ROOT } from './event.mjs';

const ROLES_DIR = path.join(REPO_ROOT, 'studio', 'roles');
const PRESETS_DIR = path.join(REPO_ROOT, 'studio', 'presets');

/**
 * Parse simple YAML frontmatter (`--- ... ---`) at the top of a Markdown file
 * without requiring external dependencies.
 */
export function parseFrontmatter(markdown) {
  const normalized = markdown.replace(/\r\n/g, '\n');
  if (!normalized.startsWith('---\n')) {
    return { meta: {}, body: normalized.trim() };
  }
  const endIdx = normalized.indexOf('\n---\n', 4);
  if (endIdx === -1) {
    return { meta: {}, body: normalized.trim() };
  }
  const rawYaml = normalized.slice(4, endIdx);
  const body = normalized.slice(endIdx + 5).trim();
  const meta = {};

  for (const line of rawYaml.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const colon = trimmed.indexOf(':');
    if (colon === -1) continue;
    const key = trimmed.slice(0, colon).trim();
    let val = trimmed.slice(colon + 1).trim();

    if (val.startsWith('[') && val.endsWith(']')) {
      meta[key] = val
        .slice(1, -1)
        .split(',')
        .map((s) => s.trim().replace(/^['"]|['"]$/g, ''))
        .filter(Boolean);
    } else {
      meta[key] = val.replace(/^['"]|['"]$/g, '');
    }
  }
  return { meta, body };
}

function walkMarkdownFiles(dir, acc = []) {
  if (!fs.existsSync(dir)) return acc;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      walkMarkdownFiles(full, acc);
    } else if (entry.isFile() && entry.name.endsWith('.md')) {
      acc.push(full);
    }
  }
  return acc;
}

/**
 * Load all roles defined in `studio/roles/` and nested department folders (no upper limit on agent count).
 */
export function loadAllRoles() {
  const files = walkMarkdownFiles(ROLES_DIR);
  const roles = [];

  for (const file of files) {
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const rel = path.relative(ROLES_DIR, file).replace(/\\/g, '/');
    const slug = meta.id || path.basename(file, '.md');
    const customChain = Array.isArray(meta.modelChain) ? meta.modelChain : null;

    roles.push({
      id: slug,
      title: meta.title || slug,
      tier: meta.tier || 'specialist',
      department: meta.department || (rel.includes('/') ? path.dirname(rel) : 'core'),
      swarm: meta.swarm || 'default',
      modelChain: getChainForRole(slug, customChain),
      tools: Array.isArray(meta.tools) ? meta.tools : [],
      rules: Array.isArray(meta.rules) ? meta.rules : [],
      filePath: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
      body,
    });
  }

  return roles.sort((a, b) => a.id.localeCompare(b.id));
}

export function loadPresets() {
  const files = walkMarkdownFiles(PRESETS_DIR);
  return files.map((file) => {
    const raw = fs.readFileSync(file, 'utf8');
    const { meta, body } = parseFrontmatter(raw);
    const id = meta.id || path.basename(file, '.md');
    return {
      id,
      title: meta.title || id,
      replacesRole: meta.replacesRole || 'producer',
      compatibleClients: Array.isArray(meta.compatibleClients)
        ? meta.compatibleClients
        : ['Grok Bot', 'Claude Code', 'Cursor', 'Gemini CLI', 'Codex', 'OpenAI', 'Ollama'],
      filePath: path.relative(REPO_ROOT, file).replace(/\\/g, '/'),
      body,
    };
  });
}

export function getRole(roleId) {
  const all = loadAllRoles();
  return all.find((r) => r.id === roleId) || null;
}

/**
 * Scaffold a brand-new custom agent role or department agent in `studio/roles/`.
 */
export function scaffoldRole({ id, title, tier = 'specialist', department = 'custom', swarm = 'default', description = '' }) {
  const subDir = department && department !== 'core' && department !== 'custom'
    ? path.join(ROLES_DIR, department)
    : ROLES_DIR;
  fs.mkdirSync(subDir, { recursive: true });
  const target = path.join(subDir, `${id}.md`);

  const content = `---
id: ${id}
title: ${title || id}
tier: ${tier}
department: ${department}
swarm: ${swarm}
modelChain: [vertex-gemini-flash, nvidia-glm-flash, groq-llama-70b, openrouter-free, ollama-local]
tools: [rtk, qmd, serena]
rules: [AGENTS.md, studio/rules/sim-purity.md]
---

# Role: ${title || id} (\`${id}\`)

${description || 'Custom specialist agent added to the studio roster.'}

## Responsibilities
1. Read \`studio/CURRENT_TASK.md\` and \`studio/llms.txt\` before opening source files.
2. Execute assigned tasks from \`studio/NEXT.md\` within your department (\`${department}\`).
3. Emit passive progress events via \`node harness/event.mjs --agent ${id}\`.
`;
  fs.writeFileSync(target, content, 'utf8');
  return path.relative(REPO_ROOT, target).replace(/\\/g, '/');
}

// CLI interface
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const [cmd = 'list', arg1, ...rest] = process.argv.slice(2);

  if (cmd === 'list') {
    const roles = loadAllRoles();
    const presets = loadPresets();
    console.log(`\n=== Active Studio Roles (${roles.length} loaded — unlimited supported) ===`);
    for (const r of roles) {
      console.log(`  • ${r.id.padEnd(22)} [${r.tier.padEnd(10)} | dept: ${r.department}] -> chain: ${r.modelChain.slice(0, 3).join(' → ')}... (${r.filePath})`);
    }
    console.log(`\n=== Swappable Producer / Workflow Presets (${presets.length}) ===`);
    for (const p of presets) {
      console.log(`  • ${p.id.padEnd(22)} (${p.title}) -> ${p.filePath}`);
    }
    process.exit(0);
  }

  if (cmd === 'show' && arg1) {
    const role = getRole(arg1);
    if (!role) {
      console.error(`Role "${arg1}" not found in studio/roles/.`);
      process.exit(1);
    }
    console.log(JSON.stringify(role, null, 2));
    process.exit(0);
  }

  if (cmd === 'create' && arg1) {
    const title = rest.join(' ') || arg1;
    const createdPath = scaffoldRole({ id: arg1, title });
    console.log(`Created new role "${arg1}" at ${createdPath}`);
    process.exit(0);
  }

  if (cmd === 'json') {
    console.log(JSON.stringify({ roles: loadAllRoles(), presets: loadPresets() }, null, 2));
    process.exit(0);
  }

  console.log('Usage: node harness/agents.mjs [list | show <role-id> | create <role-id> <Title> | json]');
}

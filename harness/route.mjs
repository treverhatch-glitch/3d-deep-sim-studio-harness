#!/usr/bin/env node
/**
 * harness/route.mjs — Zero-Server Plug-and-Play Multi-Model Failover Router
 *
 * Implements the `freecc:auto` failover engine:
 *  1. Resolves the ordered provider chain for the requested studio role.
 *  2. Expands multi-key environment variables (e.g. NVIDIA_API_KEY, NVIDIA_API_KEY_2).
 *  3. Skips any channel currently cooling down in `.studio/cooldowns.json`.
 *  4. Calls the provider (OpenAI-compatible `/chat/completions`, Anthropic `/v1/messages`,
 *     or local Ollama).
 *  5. On HTTP 429, 5xx, quota exhaustion, or network error: places that channel in a
 *     30s+ cooldown, logs a `route.failover` event to `.studio/events.jsonl`, and
 *     immediately tries the next channel with zero downtime.
 *  6. Writes a run ledger to `.studio/runs/<run-id>/ledger.json` (UltraGameStudio pattern).
 *  7. If all channels fail, returns an HTTP 503-style failure ledger with full diagnostics.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PROVIDERS, COOLDOWN_DEFAULTS, getChainForRole } from './models.config.mjs';
import { emitEvent, readRecentEvents, STUDIO_STATE_DIR, REPO_ROOT } from './event.mjs';

const COOLDOWN_FILE = path.join(STUDIO_STATE_DIR, 'cooldowns.json');
const RUNS_DIR = path.join(STUDIO_STATE_DIR, 'runs');

/** Load `.env` if present (zero external dotenv dependency). */
export function loadDotEnv() {
  const envPath = path.join(REPO_ROOT, '.env');
  if (!fs.existsSync(envPath)) return;
  const lines = fs.readFileSync(envPath, 'utf8').split(/\r?\n/);
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq === -1) continue;
    const key = trimmed.slice(0, eq).trim();
    const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
    if (key && val !== '' && process.env[key] === undefined) {
      process.env[key] = val;
    }
  }
}

export function readCooldowns() {
  try {
    if (!fs.existsSync(COOLDOWN_FILE)) return {};
    return JSON.parse(fs.readFileSync(COOLDOWN_FILE, 'utf8'));
  } catch {
    return {};
  }
}

export function writeCooldowns(map) {
  fs.mkdirSync(path.dirname(COOLDOWN_FILE), { recursive: true });
  fs.writeFileSync(COOLDOWN_FILE, JSON.stringify(map, null, 2), 'utf8');
}

export function isCoolingDown(channelKey, now = Date.now(), cooldowns = readCooldowns()) {
  const entry = cooldowns[channelKey];
  if (!entry) return false;
  if (entry.untilMs > now) return entry;
  return false;
}

export function markCooldown(channelKey, durationMs, reason, statusCode = 429) {
  const cooldowns = readCooldowns();
  const waitMs = Math.max(durationMs, COOLDOWN_DEFAULTS.rateLimitMs);
  cooldowns[channelKey] = {
    channelKey,
    statusCode,
    reason,
    markedAt: new Date().toISOString(),
    untilMs: Date.now() + waitMs,
    waitSeconds: Math.round(waitMs / 1000),
  };
  writeCooldowns(cooldowns);
  return cooldowns[channelKey];
}

/**
 * Resolve all available (provider, apiKey, keySlot) channels for a provider definition.
 */
export function resolveProviderChannels(providerDef) {
  if (!providerDef) return [];
  if (providerDef.protocol === 'ollama') {
    return [{
      channelKey: `${providerDef.id}#local`,
      provider: providerDef,
      apiKey: 'ollama-local',
      keyEnv: 'OLLAMA_BASE_URL',
    }];
  }

  const channels = [];
  for (const envName of providerDef.envKeys || []) {
    const raw = process.env[envName];
    if (!raw || !raw.trim()) continue;
    // Support comma-separated key pools in a single env var
    const keys = raw.split(',').map((k) => k.trim()).filter(Boolean);
    keys.forEach((k, idx) => {
      const slot = keys.length > 1 ? `${envName}[${idx + 1}]` : envName;
      channels.push({
        channelKey: `${providerDef.id}#${slot}`,
        provider: providerDef,
        apiKey: k,
        keyEnv: slot,
      });
    });
  }
  return channels;
}

/**
 * Inspect the full status of all configured providers and channels (0 tokens).
 */
export function getRouterMatrix(role = 'producer') {
  loadDotEnv();
  const chain = getChainForRole(role);
  const cooldowns = readCooldowns();
  const now = Date.now();

  return chain.map((providerId, order) => {
    const def = PROVIDERS[providerId];
    if (!def) {
      return {
        order: order + 1,
        provider: providerId,
        providerId,
        model: 'unknown',
        coolingDown: false,
        cooldownRemainingMs: 0,
        status: 'unknown_provider',
        channels: [],
      };
    }
    const channels = resolveProviderChannels(def);
    const providerCd = isCoolingDown(def.id, now, cooldowns);
    const channelStates = channels.map((c) => {
      const cd = isCoolingDown(c.channelKey, now, cooldowns) || providerCd;
      return {
        channelKey: c.channelKey,
        keyEnv: c.keyEnv,
        status: cd ? 'cooldown' : 'ready',
        cooldownRemainingSec: cd ? Math.max(0, Math.ceil((cd.untilMs - now) / 1000)) : 0,
        lastReason: cd ? cd.reason : null,
      };
    });
    const anyChannelCd = channelStates.find((c) => c.status === 'cooldown');
    const remMs = providerCd
      ? Math.max(0, providerCd.untilMs - now)
      : anyChannelCd
      ? anyChannelCd.cooldownRemainingSec * 1000
      : 0;
    return {
      order: order + 1,
      provider: def.id,
      providerId: def.id,
      label: def.label,
      tier: def.tier,
      model: def.model,
      configured: channels.length > 0,
      coolingDown: remMs > 0,
      cooldownRemainingMs: remMs,
      channels: channelStates,
    };
  });
}

async function callChannel(channel, { messages, temperature = 0.2, maxTokens = 2048 }) {
  const { provider, apiKey } = channel;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), COOLDOWN_DEFAULTS.requestTimeoutMs);

  try {
    if (provider.protocol === 'anthropic') {
      const systemMsgs = messages.filter((m) => m.role === 'system').map((m) => m.content).join('\n\n');
      const chatMsgs = messages
        .filter((m) => m.role !== 'system')
        .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: String(m.content) }));

      const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/messages`, {
        method: 'POST',
        signal: controller.signal,
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': apiKey,
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify({
          model: provider.model,
          max_tokens: maxTokens,
          temperature,
          ...(systemMsgs ? { system: systemMsgs } : {}),
          messages: chatMsgs.length ? chatMsgs : [{ role: 'user', content: 'Hello' }],
        }),
      });

      const retryAfterSec = Number(res.headers.get('retry-after') || 0);
      const bodyText = await res.text();
      if (!res.ok) {
        const err = new Error(`HTTP ${res.status} from ${provider.id}: ${bodyText.slice(0, 240)}`);
        err.status = res.status;
        err.retryAfterMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
        throw err;
      }

      const data = JSON.parse(bodyText);
      const content = Array.isArray(data.content)
        ? data.content.map((c) => c.text || '').join('')
        : '';
      return {
        content,
        model: data.model || provider.model,
        tokensIn: data.usage?.input_tokens || 0,
        tokensOut: data.usage?.output_tokens || 0,
      };
    }

    // OpenAI-compatible protocol (Vertex/Gemini OpenAI endpoint, NVIDIA NIM, Groq, OpenRouter, xAI Grok, OpenAI, Ollama)
    const headers = {
      'Content-Type': 'application/json',
      ...(provider.extraHeaders || {}),
    };
    if (apiKey && provider.protocol !== 'ollama') {
      headers.Authorization = `Bearer ${apiKey}`;
    }

    const res = await fetch(`${provider.baseUrl.replace(/\/$/, '')}/chat/completions`, {
      method: 'POST',
      signal: controller.signal,
      headers,
      body: JSON.stringify({
        model: provider.model,
        messages,
        temperature,
        max_tokens: maxTokens,
      }),
    });

    const retryAfterSec = Number(res.headers.get('retry-after') || 0);
    const bodyText = await res.text();
    if (!res.ok) {
      const err = new Error(`HTTP ${res.status} from ${provider.id}: ${bodyText.slice(0, 240)}`);
      err.status = res.status;
      err.retryAfterMs = retryAfterSec > 0 ? retryAfterSec * 1000 : 0;
      throw err;
    }

    const data = JSON.parse(bodyText);
    const choice = data.choices?.[0]?.message?.content ?? '';
    return {
      content: choice,
      model: data.model || provider.model,
      tokensIn: data.usage?.prompt_tokens || 0,
      tokensOut: data.usage?.completion_tokens || 0,
    };
  } finally {
    clearTimeout(timer);
  }
}

function writeRunLedger(runId, ledger) {
  const dir = path.join(RUNS_DIR, runId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'ledger.json'), JSON.stringify(ledger, null, 2), 'utf8');
}

/**
 * Execute a routed chat completion across the role's failover chain (`freecc:auto`).
 */
/**
 * Daily spend cap: STUDIO_DAILY_TOKEN_CAP (tokens in + out across every provider, since local
 * midnight). 0 or unset means no cap. Counted from route.success events, as reported by providers.
 */
export function spendToday() {
  const midnight = new Date();
  midnight.setHours(0, 0, 0, 0);
  return readRecentEvents(20000)
    .filter((e) => e.type === 'route.success' && Date.parse(e.ts) >= midnight.getTime())
    .reduce((n, e) => n + Number(e.tokensIn || 0) + Number(e.tokensOut || 0), 0);
}

export async function routeChatCompletion({
  role = 'producer',
  messages = [],
  customChain = null,
  temperature = 0.2,
  maxTokens = 2048,
  task = null,
  dryRun = false,
} = {}) {
  loadDotEnv();
  const runId = `run_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
  const cap = Number(process.env.STUDIO_DAILY_TOKEN_CAP || 0);
  if (cap > 0) {
    const used = spendToday();
    if (used >= cap) {
      const capped = { ok: false, status: 429, capped: true, runId, role, error: `Daily token cap reached: ${used.toLocaleString()} of ${cap.toLocaleString()} (STUDIO_DAILY_TOKEN_CAP). Raise it on purpose or wait until tomorrow.`, attempts: [] };
      writeRunLedger(runId, capped);
      emitEvent({ type: 'route.capped', agent: role, task, status: 'error', msg: capped.error });
      return capped;
    }
  }
  const chainIds = getChainForRole(role, customChain);
  const attempts = [];

  for (const providerId of chainIds) {
    const def = PROVIDERS[providerId];
    if (!def) continue;

    const channels = resolveProviderChannels(def);
    if (channels.length === 0) {
      attempts.push({ providerId, status: 'skipped_unconfigured', reason: `Missing ${def.envKeys.join(' or ')}` });
      continue;
    }

    for (const channel of channels) {
      const cd = isCoolingDown(channel.channelKey);
      if (cd) {
        attempts.push({
          channelKey: channel.channelKey,
          providerId: def.id,
          status: 'skipped_cooldown',
          untilMs: cd.untilMs,
          reason: cd.reason,
        });
        continue;
      }

      if (dryRun) {
        const result = {
          ok: true,
          status: 200,
          dryRun: true,
          runId,
          role,
          selectedChannel: channel.channelKey,
          provider: def.id,
          model: def.model,
          tier: def.tier,
          attempts,
        };
        writeRunLedger(runId, result);
        return result;
      }

      const startMs = Date.now();
      try {
        emitEvent({
          type: 'route.attempt',
          agent: role,
          provider: def.id,
          model: def.model,
          task,
          msg: `Routing ${role} -> ${channel.channelKey} (${def.model})`,
        });

        const response = await callChannel(channel, { messages, temperature, maxTokens });
        const latencyMs = Date.now() - startMs;

        emitEvent({
          type: 'route.success',
          agent: role,
          provider: def.id,
          model: response.model,
          task,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          latencyMs,
          msg: `Completed via ${channel.channelKey} in ${latencyMs}ms`,
        });

        const ledger = {
          ok: true,
          status: 200,
          runId,
          role,
          selectedChannel: channel.channelKey,
          provider: def.id,
          model: response.model,
          tier: def.tier,
          latencyMs,
          tokensIn: response.tokensIn,
          tokensOut: response.tokensOut,
          content: response.content,
          attempts,
        };
        writeRunLedger(runId, ledger);
        return ledger;
      } catch (err) {
        const latencyMs = Date.now() - startMs;
        const statusCode = err.status || 503;
        const isQuota = /quota|insufficient|credit|billing/i.test(err.message);
        const baseCooldown = isQuota
          ? COOLDOWN_DEFAULTS.quotaExhaustedMs
          : statusCode === 429
            ? COOLDOWN_DEFAULTS.rateLimitMs
            : COOLDOWN_DEFAULTS.serverErrorMs;
        const cooldownMs = Math.max(baseCooldown, err.retryAfterMs || 0);

        const cdEntry = markCooldown(channel.channelKey, cooldownMs, err.message, statusCode);
        attempts.push({
          channelKey: channel.channelKey,
          providerId: def.id,
          status: 'failed',
          statusCode,
          latencyMs,
          cooldownSeconds: cdEntry.waitSeconds,
          error: err.message,
        });

        emitEvent({
          type: 'route.failover',
          agent: role,
          provider: def.id,
          model: def.model,
          task,
          status: 'warn',
          latencyMs,
          msg: `Failover from ${channel.channelKey} (${statusCode}) -> cooling ${cdEntry.waitSeconds}s`,
          meta: { statusCode, cooldownSeconds: cdEntry.waitSeconds },
        });
      }
    }
  }

  // Every channel in the chain was either unconfigured, on cooldown, or failed (UltraGameStudio 503 pattern)
  const failureLedger = {
    ok: false,
    status: 503,
    runId,
    role,
    error: 'All configured provider channels in the failover chain are exhausted or cooling down.',
    attempts,
  };
  writeRunLedger(runId, failureLedger);
  emitEvent({
    type: 'route.exhausted',
    agent: role,
    task,
    status: 'error',
    msg: `503: All channels exhausted for role "${role}" (${attempts.length} checked)`,
  });
  return failureLedger;
}

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

// CLI execution
if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseArgs(process.argv.slice(2));
  const role = args.role || 'producer';

  if (args.status || args.matrix || (!args.prompt && !args['dry-run'])) {
    const matrix = getRouterMatrix(role);
    console.log(`\n=== freecc:auto Failover Matrix (role: ${role}) ===`);
    for (const row of matrix) {
      const stateStr = !row.configured
        ? 'UNCONFIGURED (no key in env)'
        : row.channels.map((c) => `${c.channelKey}:${c.status}${c.cooldownRemainingSec ? `(${c.cooldownRemainingSec}s)` : ''}`).join(', ');
      console.log(`  ${row.order}. [${row.tier.toUpperCase()}] ${row.providerId} (${row.model}) -> ${stateStr}`);
    }
    process.exit(0);
  }

  const messages = [];
  if (args.system) messages.push({ role: 'system', content: args.system });
  messages.push({ role: 'user', content: args.prompt || 'Ping check' });

  const res = await routeChatCompletion({
    role,
    messages,
    task: args.task || null,
    dryRun: Boolean(args['dry-run']),
  });

  console.log(JSON.stringify(res, null, 2));
  process.exit(res.ok ? 0 : 1);
}

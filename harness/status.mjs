#!/usr/bin/env node
/**
 * harness/status.mjs — Zero-Token Studio Status Snapshot
 *
 * Reads `.studio/events.jsonl`, `.studio/usage.json`, `.studio/war-room.config.json`,
 * `.studio/cooldowns.json`, `studio/NEXT.md`, `studio/CURRENT_TASK.md`,
 * `studio/VISION_LOCK.md`, `studio/llms.txt`, `studio/done/`, and `studio/roles/`
 * locally without calling any LLM.
 * Solves the "Full-Context Re-Read Tax" caused by asking an agent "What are you doing?".
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { readRecentEvents, REPO_ROOT, STUDIO_STATE_DIR } from './event.mjs';
import { parseNextQueue } from './task.mjs';
import { loadAllRoles, loadPresets } from './agents.mjs';
import { getRouterMatrix } from './route.mjs';

export const USAGE_FILE = process.env.STUDIO_USAGE_FILE
  ? path.resolve(REPO_ROOT, process.env.STUDIO_USAGE_FILE)
  : path.join(STUDIO_STATE_DIR, 'usage.json');

export const WAR_ROOM_CONFIG_FILE = process.env.WAR_ROOM_CONFIG_FILE
  ? path.resolve(REPO_ROOT, process.env.WAR_ROOM_CONFIG_FILE)
  : path.join(STUDIO_STATE_DIR, 'war-room.config.json');

export function readSubscriptionUsage() {
  try {
    if (fs.existsSync(USAGE_FILE)) {
      return JSON.parse(fs.readFileSync(USAGE_FILE, 'utf8'));
    }
  } catch {
    // fallback below
  }
  // Nothing recorded yet: report zeros, never invented savings (docs/TELEMETRY.md).
  return {
    updatedAt: new Date().toISOString(),
    zeroTokenHubActive: true,
    measured: false,
    tokenSavers: {
      rtkCompressionPct: 0,
      qmdRagActive: false,
      serenaLspActive: false,
      avoidedCheckInTokens: 0,
      tokensSavedToday: 0,
      estimatedDollarsPreserved: 0,
    },
    subscriptions: [],
  };
}

export function writeSubscriptionUsage(nextUsage) {
  fs.mkdirSync(path.dirname(USAGE_FILE), { recursive: true });
  const current = readSubscriptionUsage();
  const merged = {
    ...current,
    ...nextUsage,
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(USAGE_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

export function readWarRoomConfig() {
  try {
    if (fs.existsSync(WAR_ROOM_CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(WAR_ROOM_CONFIG_FILE, 'utf8'));
    }
  } catch {
    // fallback below
  }
  return {
    updatedAt: new Date().toISOString(),
    theme: {
      crtScanlines: true,
      glassBlurPx: 12,
      accentColor: '#00F0FF',
      secondaryAccent: '#0EA5E9',
      backgroundColor: '#06080E',
    },
    producerPreset: process.env.STUDIO_PRODUCER_PRESET || 'grok-bot',
    viewport: {
      activeSource: 'cdp',
      novncUrl: process.env.NOVNC_URL || 'http://localhost:6080/vnc.html?autoconnect=true&resize=scale',
      novncWsUrl: 'ws://localhost:6080/websockify',
      webrtcUrl: 'http://localhost:8889/agent-stream',
      hmrUrl: process.env.PLAYTEST_URL || 'http://localhost:5173/?playtest=1',
      showUisentinelOverlay: true,
      showSimTelemetryOverlay: true,
      manualControlEnabled: false,
      targetFps: 30,
    },
    terminal: {
      activeTab: 'events',
      readOnlyShell: true,
      roleFilter: 'ALL',
      regexFilter: '',
    },
    layout: {
      leftColumnWidthPct: 54,
      topRowHeightPct: 58,
    },
  };
}

export function writeWarRoomConfig(patch) {
  fs.mkdirSync(path.dirname(WAR_ROOM_CONFIG_FILE), { recursive: true });
  const current = readWarRoomConfig();
  const merged = {
    ...current,
    ...patch,
    theme: { ...(current.theme || {}), ...(patch.theme || {}) },
    viewport: { ...(current.viewport || {}), ...(patch.viewport || {}) },
    terminal: { ...(current.terminal || {}), ...(patch.terminal || {}) },
    layout: { ...(current.layout || {}), ...(patch.layout || {}) },
    updatedAt: new Date().toISOString(),
  };
  fs.writeFileSync(WAR_ROOM_CONFIG_FILE, JSON.stringify(merged, null, 2) + '\n', 'utf8');
  return merged;
}

export function findLatestQaScreenshot() {
  const reportsDir = path.join(REPO_ROOT, 'qa', 'reports');
  if (!fs.existsSync(reportsDir)) return null;
  const pngs = fs
    .readdirSync(reportsDir)
    .filter((f) => f.endsWith('.png'))
    .map((f) => ({
      name: f,
      mtime: fs.statSync(path.join(reportsDir, f)).mtimeMs,
    }))
    .sort((a, b) => b.mtime - a.mtime);
  return pngs[0] ? `/api/latest-screenshot?f=${encodeURIComponent(pngs[0].name)}` : null;
}

export function readContextHealth() {
  const targets = [
    { id: 'current_task', label: 'studio/CURRENT_TASK.md', relPath: 'studio/CURRENT_TASK.md' },
    { id: 'vision_lock', label: 'studio/VISION_LOCK.md', relPath: 'studio/VISION_LOCK.md' },
    { id: 'llms_txt', label: 'studio/llms.txt', relPath: 'studio/llms.txt' },
    { id: 'next_md', label: 'studio/NEXT.md', relPath: 'studio/NEXT.md' },
  ];
  const now = Date.now();
  return targets.map((t) => {
    const full = path.join(REPO_ROOT, t.relPath);
    if (!fs.existsSync(full)) {
      return { ...t, exists: false, updatedAt: null, ageSec: null, status: 'missing' };
    }
    const stat = fs.statSync(full);
    const ageSec = Math.max(0, Math.round((now - stat.mtimeMs) / 1000));
    const status = ageSec < 3600 ? 'synced' : ageSec < 86400 ? 'warm' : 'stale';
    return {
      ...t,
      exists: true,
      updatedAt: new Date(stat.mtimeMs).toISOString(),
      ageSec,
      sizeBytes: stat.size,
      status,
    };
  });
}

export function readDoneArchive() {
  const doneDir = path.join(REPO_ROOT, 'studio', 'done');
  if (!fs.existsSync(doneDir)) return [];
  return fs
    .readdirSync(doneDir)
    .filter((f) => f.endsWith('.md') && f !== 'README.md')
    .map((f) => {
      const full = path.join(doneDir, f);
      const stat = fs.statSync(full);
      return {
        file: `studio/done/${f}`,
        id: f.replace(/\.md$/, ''),
        updatedAt: new Date(stat.mtimeMs).toISOString(),
      };
    })
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

export function buildStudioSnapshot() {
  const events = readRecentEvents(250);
  const queue = parseNextQueue();
  const rawRoles = loadAllRoles();
  const presets = loadPresets();
  const usage = readSubscriptionUsage();
  const warRoomConfig = readWarRoomConfig();
  const contextHealth = readContextHealth();
  const doneArchive = readDoneArchive();

  // Attach dynamic provider chains & live telemetry per role (never capped)
  const roles = rawRoles.map((r) => {
    const roleSlug = r.slug || r.id;
    const chain = getRouterMatrix(roleSlug);
    const roleEvents = events.filter(
      (e) =>
        e.agent === roleSlug ||
        (roleSlug === 'producer' && (e.agent === 'grok-producer' || e.agent === 'head-producer'))
    );
    const lastEvt = roleEvents[roleEvents.length - 1] || null;
    const coolingEntry = chain.find((c) => c.coolingDown);
    const activeProvider = chain.find((c) => !c.coolingDown) || chain[0] || {
      provider: r.preferredChain?.[0] || 'vertex-gemini-flash',
      model: 'gemini-2.5-flash',
    };

    let status = 'IDLE';
    if (coolingEntry) {
      status = 'FAILOVER_COOLDOWN';
    } else if (lastEvt) {
      const rawStatus = String(lastEvt.status || lastEvt.type || '').toUpperCase();
      if (rawStatus.includes('VITEST') || rawStatus.includes('TEST')) status = 'RUNNING_VITEST';
      else if (rawStatus.includes('PLAYTEST') || rawStatus.includes('QA')) status = 'PLAYTESTING';
      else if (rawStatus.includes('FAILOVER') || rawStatus.includes('COOLDOWN')) status = 'FAILOVER_COOLDOWN';
      else if (
        rawStatus.includes('START') ||
        rawStatus.includes('CODE') ||
        rawStatus.includes('CODING') ||
        rawStatus.includes('BUILD') ||
        rawStatus.includes('EDIT')
      ) {
        status = 'CODING';
      }
    }

    const rtkSaved = roleEvents.reduce((sum, e) => sum + Number(e.tokensSaved || 0), 0);
    const filesModified = Array.from(
      new Set(
        roleEvents
          .map((e) => e.target || e.file)
          .filter((f) => typeof f === 'string' && f.trim().length > 0 && f !== 'none')
      )
    );

    const firstEvt = roleEvents[0] || null;
    const startedAt = lastEvt?.startedAt || firstEvt?.ts || null;
    const durationMs =
      lastEvt?.durationMs != null
        ? Number(lastEvt.durationMs)
        : firstEvt && lastEvt && firstEvt !== lastEvt
        ? Math.max(0, new Date(lastEvt.ts).getTime() - new Date(firstEvt.ts).getTime())
        : 0;

    return {
      ...r,
      id: roleSlug,
      slug: roleSlug,
      status,
      activeProvider: lastEvt?.provider || activeProvider.provider,
      activeModel: lastEvt?.model || activeProvider.model,
      cooldownRemainingMs: coolingEntry ? coolingEntry.cooldownRemainingMs : 0,
      coolingProvider: coolingEntry ? coolingEntry.provider : null,
      taskId: lastEvt?.task || queue.inProgress.find((t) => t.role === roleSlug)?.id || null,
      targetFile: lastEvt?.target || filesModified[filesModified.length - 1] || null,
      startedAt,
      durationMs,
      lastEventAt: lastEvt?.ts || null,
      lastMessage: lastEvt?.msg || 'Standing by for task dispatch',
      tokensSavedByRtk: rtkSaved,
      filesModified,
      providerChain: chain,
      recentEvents: roleEvents.slice(-15).reverse(),
    };
  });

  const router = getRouterMatrix('producer');

  const totals = events.reduce(
    (acc, e) => {
      acc.tokensIn += Number(e.tokensIn || 0);
      acc.tokensOut += Number(e.tokensOut || 0);
      acc.tokensSaved += Number(e.tokensSaved || 0);
      if (e.type === 'route.failover' || String(e.status).includes('FAILOVER')) acc.failovers += 1;
      if (e.type === 'qa.bug' || e.status === 'error') acc.errors += 1;
      return acc;
    },
    { tokensIn: 0, tokensOut: 0, tokensSaved: 0, failovers: 0, errors: 0 }
  );

  // Only savings a tool measured and reported (tokensSaved on events, e.g. from rtk). No estimates.
  const checkInTaxAvoided = totals.tokensSaved;

  return {
    generatedAt: new Date().toISOString(),
    llmTokensUsedForStatus: 0,
    producerPreset: warRoomConfig.producerPreset || process.env.STUDIO_PRODUCER_PRESET || 'grok-bot',
    rolesCount: roles.length,
    roles,
    presets,
    queue,
    doneArchive,
    contextHealth,
    router,
    usage,
    warRoomConfig,
    liveView: {
      latestScreenshot: findLatestQaScreenshot(),
      novncUrl: warRoomConfig.viewport?.novncUrl || process.env.NOVNC_URL || 'http://127.0.0.1:6080/vnc.html',
      novncWsUrl: warRoomConfig.viewport?.novncWsUrl || 'ws://127.0.0.1:6080/websockify',
      webrtcUrl: warRoomConfig.viewport?.webrtcUrl || 'http://127.0.0.1:8889/agent-stream',
      playtestUrl: warRoomConfig.viewport?.hmrUrl || process.env.PLAYTEST_URL || 'http://127.0.0.1:5173/?playtest=1',
    },
    telemetry: {
      totalEvents: events.length,
      ...totals,
      estimatedTokensSaved: checkInTaxAvoided,
      rtkCompressionPct: Number(usage?.tokenSavers?.rtkCompressionPct || 0),
      measured: checkInTaxAvoided > 0,
      estimatedDollarsPreserved: Number(usage?.tokenSavers?.estimatedDollarsPreserved || 0),
    },
    recentEvents: events.slice(-40).reverse(),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  // 2.65.0: the fixed-format brief for a chat channel, under 100 words (harness/brief-status.mjs).
  if (process.argv.includes('--brief')) {
    const opt = (k) => (process.argv.includes(k) ? process.argv[process.argv.indexOf(k) + 1] : null);
    const nowArg = Date.parse(opt('--now') || '');
    const { briefStatus } = await import('./brief-status.mjs');
    const b = await briefStatus({ since: opt('--since'), now: Number.isFinite(nowArg) ? nowArg : Date.now(), peek: process.argv.includes('--peek') });
    console.log(process.argv.includes('--json') ? JSON.stringify({ text: b.text, words: b.words, facts: b.facts }) : b.text);
    process.exit(0);
  }
  const snap = buildStudioSnapshot();
  if (process.argv.includes('--json')) {
    console.log(JSON.stringify(snap, null, 2));
    process.exit(0);
  }

  console.log('====================================================================');
  console.log(' 3D DEEP-SIM AI STUDIO — PASSIVE STATUS (0 LLM TOKENS CONSUMED)');
  console.log('====================================================================');
  console.log(` Producer Preset : ${snap.producerPreset} (${snap.rolesCount} roles loaded)`);
  console.log(` Active Tasks    : ${snap.queue.inProgress.length} in progress | ${snap.queue.backlog.length} backlog | ${snap.queue.done.length} done`);
  if (snap.queue.inProgress[0]) {
    const t = snap.queue.inProgress[0];
    console.log(` Current Focus   : [${t.id}] (${t.role}) ${t.title}`);
  } else if (snap.queue.backlog[0]) {
    const t = snap.queue.backlog[0];
    console.log(` Next Up         : [${t.id}] (${t.role}) ${t.title}`);
  }
  console.log(` Token Telemetry : ${snap.telemetry.tokensIn} in / ${snap.telemetry.tokensOut} out | ${snap.telemetry.measured ? `${snap.telemetry.estimatedTokensSaved.toLocaleString()} saved (measured)` : 'savings not measured'} | ${snap.telemetry.failovers} failovers`);
  console.log(` Subscriptions   : ${(snap.usage.subscriptions || []).length} tracked in .studio/usage.json`);
  console.log('--------------------------------------------------------------------');
  console.log(' Recent Events (.studio/events.jsonl):');
  for (const e of snap.recentEvents.slice(0, 6)) {
    console.log(`  [${e.ts.slice(11, 19)}] (${e.agent}) ${e.type}: ${e.msg}`);
  }
  console.log('====================================================================');
}

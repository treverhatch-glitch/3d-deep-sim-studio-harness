#!/usr/bin/env node
/**
 * harness/alerts.mjs — phone alerts for important studio events (2.30d).
 * This module sends opt-in push notifications via ntfy or Telegram for events like a stopped
 * studio or a task needing review. Configuration is stored locally and secrets are read from
 * environment variables, never from files. For ntfy, use a long, unguessable topic name for privacy.
 *
 *   npm run alerts -- on --channel ntfy --topic <t> --by <name>
 *   npm run alerts -- on --channel telegram --chat <id> --by <name>
 *   npm run alerts -- off --by <name>
 *   npm run alerts -- status | test | pass
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { STUDIO_STATE_DIR, emitEvent, readRecentEvents, actor } from './event.mjs';

const ALERTS_FILE = path.join(STUDIO_STATE_DIR, 'alerts.json');
const ALERTS_CURSOR_FILE = path.join(STUDIO_STATE_DIR, 'alerts-cursor.json');

export const ALERT_KINDS = ['studio.stopped', 'watchdog.action', 'task.pending_review', 'away.summary_ready', 'task.parked', 'budget.stop', 'director.flow.starved', 'ci.failed'];

export function readAlerts() {
  try {
    return { on: false, kinds: ALERT_KINDS, ...JSON.parse(fs.readFileSync(ALERTS_FILE, 'utf8')) };
  } catch {
    return { on: false, kinds: ALERT_KINDS };
  }
}

export function setAlerts(opts, by) {
  if (!by) return { ok: false, message: 'Say who: --by <name>.' };
  const { on, channel, topic, server, chatId, kinds } = opts;
  if (on) {
    if (!['ntfy', 'telegram'].includes(channel)) return { ok: false, message: 'Invalid channel. Use "ntfy" or "telegram".' };
    if (channel === 'telegram' && !chatId) return { ok: false, message: 'Telegram channel requires a --chat <id>.' };
    if (channel === 'ntfy' && !topic && !process.env.STUDIO_NTFY_TOPIC) return { ok: false, message: 'ntfy channel requires a --topic <name> or STUDIO_NTFY_TOPIC env var.' };
  }

  const alerts = { on: Boolean(on), by, at: new Date().toISOString() };
  if (alerts.on) {
    Object.assign(alerts, { channel, kinds: kinds || ALERT_KINDS });
    if (channel === 'ntfy') Object.assign(alerts, { topic, server: server || 'https://ntfy.sh' });
    if (channel === 'telegram') Object.assign(alerts, { chatId });
  }

  fs.mkdirSync(STUDIO_STATE_DIR, { recursive: true });
  fs.writeFileSync(ALERTS_FILE, JSON.stringify(alerts, null, 2) + '\n');
  emitEvent({ type: 'alerts.config', agent: by, msg: `Alerts ${alerts.on ? `turned on (${alerts.channel})` : 'turned off'}.` });
  return { ok: true, alerts };
}

export function formatAlert(event) {
  const title = event.type.split('.').map(w => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  let body = event.msg || '';
  if (event.task) body = `Task ${event.task}: ${body}`;
  if (body.length > 300) body = body.slice(0, 297) + '...';
  return { title, body };
}

export function shouldAlert(event, cfg) {
  return cfg.on && (cfg.kinds || ALERT_KINDS).includes(event.type);
}

export async function sendAlert(event, { cfg = readAlerts(), env = process.env, fetchImpl = globalThis.fetch, dryRun = false } = {}) {
  if (!shouldAlert(event, cfg)) return { sent: false, reason: 'Alert condition not met.' };

  const { title, body } = formatAlert(event);
  const ntfyTopic = env.STUDIO_NTFY_TOPIC || cfg.topic;
  const ntfyToken = env.STUDIO_NTFY_TOKEN;
  const telegramToken = env.STUDIO_TELEGRAM_BOT_TOKEN;

  let request;
  if (cfg.channel === 'ntfy' && ntfyTopic) {
    const headers = { Title: title, Tags: 'bell' };
    if (ntfyToken) headers.Authorization = `Bearer ${ntfyToken}`;
    request = {
      url: `${cfg.server || 'https://ntfy.sh'}/${ntfyTopic}`,
      opts: { method: 'POST', headers, body, signal: AbortSignal.timeout(5000) },
    };
    if (dryRun && request.opts.headers.Authorization) request.opts.headers.Authorization = 'Bearer ***';
  } else if (cfg.channel === 'telegram' && cfg.chatId && telegramToken) {
    request = {
      url: `https://api.telegram.org/bot${telegramToken}/sendMessage`,
      opts: {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: cfg.chatId, text: `${title}\n\n${body}` }),
        signal: AbortSignal.timeout(5000),
      },
    };
    if (dryRun) request.url = request.url.replace(telegramToken, '***');
  } else {
    return { sent: false, channel: cfg.channel, reason: 'Alert channel misconfigured or secrets missing.' };
  }

  if (dryRun) return { sent: false, channel: cfg.channel, request };

  try {
    const res = await fetchImpl(request.url, request.opts);
    if (!res.ok) return { sent: false, channel: cfg.channel, reason: `HTTP ${res.status}` };
    return { sent: true, channel: cfg.channel };
  } catch (err) {
    const why = err.name === 'AbortError' || err.name === 'TimeoutError' ? 'Request timed out.' : String(err.message || err);
    return { sent: false, channel: cfg.channel, reason: telegramToken ? why.split(telegramToken).join('***') : why };
  }
}

export async function alertPass({ events = readRecentEvents(2000), cfg = readAlerts(), fetchImpl, dryRun } = {}) {
  if (!cfg.on) return { sent: 0, skipped: 0, failed: 0 };
  events = events.filter((e) => !String(e.type).startsWith('alert.'));
  let cursor = { lastId: 0, lastTs: '' };
  try { cursor = JSON.parse(fs.readFileSync(ALERTS_CURSOR_FILE, 'utf8')); } catch {}

  // Event ids are strings (evt_<ms>_<rand>): find the cursor's place by id, else fall back to its time.
  const at = cursor.lastId ? events.findIndex((e) => e.id === cursor.lastId) : -1;
  const newEvents = at >= 0 ? events.slice(at + 1) : events.filter((e) => !cursor.lastTs || String(e.ts) > cursor.lastTs);
  if (!newEvents.length) return { sent: 0, skipped: 0, failed: 0 };

  if (!cursor.lastId) { // First run, just set cursor
    const lastEvent = newEvents[newEvents.length - 1];
    fs.writeFileSync(ALERTS_CURSOR_FILE, JSON.stringify({ lastId: lastEvent.id, lastTs: lastEvent.ts }, null, 2) + '\n');
    return { sent: 0, skipped: newEvents.length, failed: 0 };
  }

  let sent = 0, failed = 0, skipped = 0;
  let lastProcessedEvent = null;

  for (const event of newEvents) {
    if (!shouldAlert(event, cfg)) {
      skipped++;
      continue;
    }
    if (sent >= 5) {
      skipped++;
      continue;
    }
    const result = await sendAlert(event, { cfg, fetchImpl, dryRun });
    const meta = { channel: result.channel, kind: event.type };
    if (result.sent) {
      sent++;
      emitEvent({ type: 'alert.sent', agent: 'harness', msg: `Sent alert for ${event.type}`, meta });
    } else {
      failed++;
      emitEvent({ type: 'alert.failed', agent: 'harness', msg: `Failed to send alert for ${event.type}: ${result.reason}`, meta });
    }
    lastProcessedEvent = event;
  }

  if (lastProcessedEvent) {
    fs.writeFileSync(ALERTS_CURSOR_FILE, JSON.stringify({ lastId: lastProcessedEvent.id, lastTs: lastProcessedEvent.ts }, null, 2) + '\n');
  }

  return { sent, skipped, failed };
}


if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const arg = (k) => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : undefined; };
  const by = arg('--by') || actor();
  const cmd = argv[0] || 'status';

  if (cmd === 'on' || cmd === 'off') {
    const opts = {
      on: cmd === 'on',
      channel: arg('--channel'),
      topic: arg('--topic'),
      server: arg('--server'),
      chatId: arg('--chat'),
    };
    const r = setAlerts(opts, by);
    if (!r.ok) { console.error(r.message); process.exit(1); }
    console.log(`Alerts ${r.alerts.on ? 'on' : 'off'}.`);
  } else if (cmd === 'pass') {
    const r = await alertPass();
    console.log(`Alert pass: ${r.sent} sent, ${r.failed} failed, ${r.skipped} skipped.`);
  } else if (cmd === 'test') {
    const r = await sendAlert({ type: 'studio.stopped', msg: 'This is a test alert from the harness.' }, { dryRun: argv.includes('--dry-run') });
    if (r.request) { console.log(JSON.stringify({ url: r.request.url, headers: r.request.opts.headers, body: r.request.opts.body }, null, 2)); process.exit(0); }
    console.log(r.sent ? `Test alert sent via ${r.channel}.` : `Failed to send test alert: ${r.reason}`);
  } else if (cmd !== 'status') {
    console.log('Usage: npm run alerts -- on --channel <...> | off | status | test | pass');
    process.exit(1);
  } else {
    const cfg = readAlerts();
    if (cfg.on) {
      console.log(`Alerts are ON for ${by} via ${cfg.channel} (since ${cfg.at}).`);
      console.log('Kinds:', cfg.kinds.join(', '));
    } else {
      console.log('Alerts are OFF.');
    }
  }
}

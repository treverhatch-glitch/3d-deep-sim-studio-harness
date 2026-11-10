#!/usr/bin/env node
/**
 * harness/report-post.mjs — 2.71.0 (y): the owner's reports, posted to a webhook (overseer duty 9).
 *
 *   npm run report -- post [--what status|next|digest] [--dry-run]
 *
 * The crew's overseer pasted the studio's status and "what's next" into the owner's chat by hand. Now the harness
 * builds the text from what already exists (status: `npm run status -- --brief`'s text, harness/brief-status.mjs,
 * read with peek so the brief's "since" mark doesn't move; next: the what's-next board, harness/next-board.mjs;
 * digest: today's studio/digest/<date>.md, else the digest built now, harness/digest.mjs) and POSTs it as JSON:
 *   - discord: { content } (split into parts of at most 2000 characters, at line ends where it can; mentions off),
 *   - slack:   { text },
 *   - json:    { what, text, at }.
 * STUDIO_REPORT_FORMAT=discord|slack|json picks one; unset, the URL's host decides (discord.com, hooks.slack.com),
 * else json. One retry on a 5xx or 429, after Retry-After (seconds or a date; at most 30 s; 1 s when absent).
 *
 * The webhook is a secret: STUDIO_REPORT_WEBHOOK from the environment or the studio's .env (never committed: .env is
 * ignored and the secrets gate flags Discord and Slack webhook URLs). It is never printed: output and logs say
 * "webhook ...<last 4>", events carry no part of it, and any error text is scrubbed of it. Launched agents never get it
 * (harness/agent-env.mjs). postReport() never throws: a failure is a result ({ ok: false, why }) and a report.posted
 * event with status error.
 *
 * The supervisor (reportPass) posts the digest once a day at or after STUDIO_REPORT_HOUR local time (unset: never),
 * and the what's-next board when the queue changed a lot (3 tasks or trains in or out since the last post, or half of
 * a smaller board) and STUDIO_REPORT_NEXT_MIN (120) minutes have passed since it (off: never). Nothing posts
 * without a webhook. Each post is one report.posted event: { what, format, parts, attempts, status, ok, auto }.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { loadDotEnv } from './dotenv.mjs';
import { readJson } from './fsafe.mjs';

export const WHATS = ['status', 'next', 'digest'];
export const DISCORD_MAX = 2000;
export const RETRY_MAX_MS = 30000;
const STATE = (root) => path.join(root, '.studio', 'report-post.json');
const writeJson = (f, v) => { try { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, `${JSON.stringify(v, null, 2)}\n`); } catch {} };

/** The webhook: { url, source: 'env' | '.env' }, { bad: true } for a value that isn't an http(s) URL, or null. */
export function webhookFrom(env = process.env, root = REPO_ROOT) {
  let url = String(env.STUDIO_REPORT_WEBHOOK || '').trim();
  let source = 'env';
  if (!url) {
    const file = {};
    try { loadDotEnv(path.join(root, '.env'), file); } catch {}
    url = String(file.STUDIO_REPORT_WEBHOOK || '').trim();
    source = '.env';
  }
  if (!url) return null;
  if (!/^https?:\/\/[^\s/]+/i.test(url)) return { url: null, bad: true, source };
  return { url, source };
}

/** How a webhook is named anywhere it is shown: "webhook ...<last 4>". */
export const maskWebhook = (url) => `webhook ...${String(url || '').slice(-4)}`;

/** Text with every form of the URL (whole, without its query, its path) replaced by its mask. */
export function scrub(text, url) {
  let s = String(text ?? '');
  if (!url) return s;
  const forms = new Set([url]);
  try {
    const u = new URL(url);
    forms.add(`${u.origin}${u.pathname}`);
    if (u.pathname.length > 5) forms.add(u.pathname);
    for (const seg of u.pathname.split('/')) if (seg.length >= 12) forms.add(seg);
    if (u.search.length > 5) forms.add(u.search);
  } catch {}
  for (const f of [...forms].sort((a, b) => b.length - a.length)) s = s.split(f).join(maskWebhook(url));
  return s;
}

/** discord | slack | json: STUDIO_REPORT_FORMAT, else by the URL's host, else json. */
export function formatFor(url, env = process.env) {
  const f = String(env.STUDIO_REPORT_FORMAT || '').trim().toLowerCase();
  if (['discord', 'slack', 'json'].includes(f)) return f;
  let host = '';
  try { host = new URL(url).hostname.toLowerCase(); } catch {}
  if (/(^|\.)discord(app)?\.com$/.test(host)) return 'discord';
  if (host === 'hooks.slack.com') return 'slack';
  return 'json';
}

/** Discord's limit: parts of at most `max` characters, cut at a line end when one is in the part, else hard. */
export function splitText(text, max = DISCORD_MAX) {
  const parts = [];
  let rest = String(text || '');
  while (rest.length > max) {
    let at = rest.lastIndexOf('\n', max);
    if (at < max / 2) at = max;
    parts.push(rest.slice(0, at));
    rest = rest.slice(at).replace(/^\n/, '');
  }
  if (rest.length || !parts.length) parts.push(rest);
  return parts;
}

/** The request bodies for one report, in order. */
export function payloads(text, format, { what = 'status', now = Date.now() } = {}) {
  if (format === 'discord') return splitText(text).map((content) => ({ content, allowed_mentions: { parse: [] } }));
  if (format === 'slack') return [{ text }];
  return [{ what, text, at: new Date(now).toISOString() }];
}

/** Retry-After in ms: seconds or an HTTP date; at most RETRY_MAX_MS; 1 s when absent or unreadable. */
export function retryAfterMs(v, now = Date.now()) {
  const s = String(v ?? '').trim();
  if (!s) return 1000;
  let ms = Number.isFinite(Number(s)) ? Number(s) * 1000 : Date.parse(s) - now;
  if (!Number.isFinite(ms)) ms = 1000;
  return Math.max(0, Math.min(RETRY_MAX_MS, Math.round(ms)));
}

const sleepMs = (ms) => new Promise((r) => setTimeout(r, ms));

/** POST one body; one retry on 5xx/429. Never throws: { ok, status, attempts, why }. */
export async function postOnce(url, body, { fetchImpl = globalThis.fetch, sleep = sleepMs, timeoutMs = 15000 } = {}) {
  let attempts = 0;
  let last = { ok: false, status: 0, why: 'not sent' };
  while (attempts < 2) {
    attempts += 1;
    try {
      const res = await fetchImpl(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
      if (res.ok) return { ok: true, status: res.status, attempts };
      last = { ok: false, status: res.status, why: `HTTP ${res.status}` };
      if ((res.status >= 500 || res.status === 429) && attempts < 2) { await sleep(retryAfterMs(res.headers?.get?.('retry-after'))); continue; }
      return { ...last, attempts };
    } catch (e) {
      return { ok: false, status: 0, attempts, why: scrub(`${e?.cause?.code || e?.name || 'error'}: ${e?.cause?.message || e?.message || e}`, url).slice(0, 200) };
    }
  }
  return { ...last, attempts };
}

/** The report's text: { text } or { why } when it couldn't be built. */
export async function reportText(what, { root = REPO_ROOT, now = Date.now() } = {}) {
  if (what === 'status') return { text: (await (await import('./brief-status.mjs')).briefStatus({ now, peek: true, root })).text };
  if (what === 'next') return { text: (await (await import('./next-board.mjs')).nextBoard({ root, now })).text };
  if (what === 'digest') {
    const d = await import('./digest.mjs');
    const file = d.digestFile(d.localDate(now), root);
    try { if (fs.existsSync(file)) return { text: fs.readFileSync(file, 'utf8').trim() }; } catch {}
    return { text: (await d.buildDigest({ now, root })).text.trim() };
  }
  return { why: `unknown report "${what}" (status, next or digest)` };
}

/**
 * Build and post one report. Never throws. { ok, what, format, parts, attempts, status, target, why, payloads? }.
 * dryRun: nothing is sent or recorded; the payloads come back. deps (tests): { fetchImpl, sleep }.
 */
export async function postReport({ what = 'status', dryRun = false, env = process.env, root = REPO_ROOT, now = Date.now(), auto = false, text = null, deps = {} } = {}) {
  let hook = null;
  try {
    if (!WHATS.includes(what)) return { ok: false, what, why: `unknown report "${what}": use status, next or digest` };
    hook = webhookFrom(env, root);
    let body = text;
    if (body === null) { const r = await reportText(what, { root, now }); if (r.why) return { ok: false, what, why: r.why }; body = r.text; }
    const format = hook?.url ? formatFor(hook.url, env) : formatFor('', env);
    const bodies = payloads(body, format, { what, now });
    const target = hook?.url ? maskWebhook(hook.url) : 'no webhook';
    if (dryRun) return { ok: true, dryRun: true, what, format, parts: bodies.length, target, payloads: bodies, text: body, ...(hook?.url ? {} : { why: hook?.bad ? 'STUDIO_REPORT_WEBHOOK is not an http(s) URL' : 'no webhook set (STUDIO_REPORT_WEBHOOK, in the environment or .env)' }) };
    if (!hook?.url) return { ok: false, what, format, target, why: hook?.bad ? 'STUDIO_REPORT_WEBHOOK is not an http(s) URL: nothing sent' : 'no webhook set: put STUDIO_REPORT_WEBHOOK in the environment or the studio\'s .env (never commit it)' };
    let res = { ok: true, status: 0, attempts: 0 };
    let attempts = 0;
    let sent = 0;
    for (const b of bodies) {
      res = await postOnce(hook.url, b, { fetchImpl: deps.fetchImpl || globalThis.fetch, sleep: deps.sleep || sleepMs });
      attempts += res.attempts || 0;
      if (!res.ok) break;
      sent += 1;
    }
    const out = { ok: res.ok, what, format, parts: bodies.length, sent, attempts, status: res.status, target, ...(res.ok ? {} : { why: scrub(res.why || 'failed', hook.url) }) };
    try {
      emitEvent({
        type: 'report.posted', agent: 'report', to: 'human', status: res.ok ? 'ok' : 'error',
        msg: res.ok ? `Posted the ${what} report (${format}, ${bodies.length} part${bodies.length === 1 ? '' : 's'})${auto ? ' (supervisor)' : ''}` : `Couldn't post the ${what} report: ${out.why} after ${attempts} tr${attempts === 1 ? 'y' : 'ies'}${sent ? ` (${sent} of ${bodies.length} parts sent)` : ''}`,
        meta: { what, format, parts: bodies.length, sent, attempts, status: res.status, ok: res.ok, auto, source: hook.source },
      });
    } catch { /* the post stands without its record */ }
    return out;
  } catch (e) {
    return { ok: false, what, why: scrub(`the report failed: ${e?.message || e}`, hook?.url).slice(0, 300) };
  }
}

/** The local date, YYYY-MM-DD. */
const localDate = (now) => { const d = new Date(now); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

/** Whether the board changed a lot: at least 3 items in or out, or half of the last board's items. */
export function changedALot(prev, cur) {
  if (!Array.isArray(prev)) return cur.length > 0;
  const a = new Set(prev); const b = new Set(cur);
  let d = 0;
  for (const x of a) if (!b.has(x)) d += 1;
  for (const x of b) if (!a.has(x)) d += 1;
  return d >= Math.max(1, Math.min(3, Math.ceil(a.size / 2)));
}

/** STUDIO_REPORT_HOUR: 0..23, or null (never). */
export function reportHour(env = process.env) {
  const v = String(env.STUDIO_REPORT_HOUR ?? '').trim();
  if (v === '' || !Number.isFinite(Number(v))) return null;
  return Math.min(23, Math.max(0, Math.round(Number(v))));
}
/** STUDIO_REPORT_NEXT_MIN: minutes, or null (off). */
export function nextEveryMin(env = process.env) {
  const v = String(env.STUDIO_REPORT_NEXT_MIN ?? '').trim().toLowerCase();
  if (/^(off|no|false)$/.test(v)) return null;
  return v !== '' && Number.isFinite(Number(v)) && Number(v) >= 0 ? Number(v) : 120;
}

/**
 * The supervisor's pass: which reports are due, posted in a detached child (inline: here, awaited; tests).
 * State in .studio/report-post.json { digestDate, nextAt, nextSig, checkedAt }; a due report is marked before it is
 * sent, so a failing webhook is tried once per due report, not every pass. Never throws. { posted: [], line }.
 */
export async function reportPass({ root = REPO_ROOT, env = process.env, now = Date.now(), inline = false, deps = {} } = {}) {
  try {
    const hook = webhookFrom(env, root);
    if (!hook?.url) return { posted: [], why: 'no webhook' };
    const st = readJson(STATE(root), {}) || {};
    const due = [];
    const hour = reportHour(env);
    if (hour !== null && new Date(now).getHours() >= hour && st.digestDate !== localDate(now)) { st.digestDate = localDate(now); due.push('digest'); }
    const every = nextEveryMin(env);
    const lastNext = Date.parse(st.nextAt || '') || 0;
    const lastCheck = Date.parse(st.checkedAt || '') || 0;
    if (every !== null && now - lastNext >= every * 60000 && now - lastCheck >= Math.min(10, every) * 60000) {
      st.checkedAt = new Date(now).toISOString();
      const facts = await (await import('./next-board.mjs')).nextBoardFacts({ root, now, deps: { ...(deps.board || {}), needs: false } });
      if (changedALot(st.nextSig, facts.sig)) { st.nextAt = new Date(now).toISOString(); st.nextSig = facts.sig; due.push('next'); }
    }
    writeJson(STATE(root), st);
    if (!due.length) return { posted: [], why: 'nothing due' };
    if (inline) {
      const results = [];
      for (const what of due) results.push(await postReport({ what, env, root, now, auto: true, deps }));
      return { posted: due, results, line: `posted ${due.join(' and ')} to ${maskWebhook(hook.url)}` };
    }
    for (const what of due) {
      try {
        const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'post', '--what', what, '--auto'], { cwd: root, env: { ...env }, detached: true, stdio: 'ignore', windowsHide: true });
        child.unref();
      } catch { /* the next due report tries again */ }
    }
    return { posted: due, detached: true, line: `posting ${due.join(' and ')} to ${maskWebhook(hook.url)}` };
  } catch (e) {
    return { posted: [], why: scrub(String(e?.message || e), webhookFrom(env, root)?.url) };
  }
}

/** The CLI: returns the exit code, never calls process.exit (2.77.1, M4: the Windows libuv exit race, see exit-drain.mjs). */
export async function reportCli(argv = process.argv.slice(2)) {
  const usage = 'Usage: npm run report -- post [--what status|next|digest] [--dry-run]   (posts to STUDIO_REPORT_WEBHOOK; STUDIO_REPORT_FORMAT=discord|slack|json)';
  if (argv.includes('--help') || argv.includes('-h')) { console.log(usage); return (0); }
  if (argv[0] !== 'post') { console.error(usage); return (2); }
  const what = argv.includes('--what') ? String(argv[argv.indexOf('--what') + 1] || '') : 'status';
  if (!WHATS.includes(what)) { console.error(`Unknown --what "${what}". ${usage}`); return (2); }
  const r = await postReport({ what, dryRun: argv.includes('--dry-run'), auto: argv.includes('--auto') });
  if (r.dryRun) {
    console.log(`[report] dry run: the ${what} report as ${r.format}, ${r.parts} part${r.parts === 1 ? '' : 's'}, to ${r.target}${r.why ? ` (${r.why})` : ''}. Nothing was sent.`);
    for (const p of r.payloads) console.log(JSON.stringify(p, null, 2));
    return (0);
  }
  if (r.ok) console.log(`[report] posted the ${what} report to ${r.target} (${r.format}, ${r.parts} part${r.parts === 1 ? '' : 's'}${r.attempts > r.parts ? `, after a retry` : ''}).`);
  else console.error(`[report] not posted: ${r.why}${r.target ? ` (${r.target})` : ''}`);
  return (r.ok ? 0 : 1);
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const { exitWhenDrained } = await import('./exit-drain.mjs');
  exitWhenDrained(await reportCli());
}

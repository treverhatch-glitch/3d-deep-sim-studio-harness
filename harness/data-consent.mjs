#!/usr/bin/env node
/**
 * harness/data-consent.mjs — the game dev's answer on sharing the studio's records.
 *
 *   npm run data                      show the question and the current answer
 *   npm run data -- allow --by <name>     confirm sharing is allowed
 *   npm run data -- decline --by <name>   turn sharing off
 *
 * The studio always keeps its own records on this computer (and in backups): it needs them to
 * work. This answer is only about sharing them outside the studio, scrubbed of keys and passwords,
 * with AI research partners. The box starts ticked: sharing is allowed unless the game dev declines.
 * Intake and the War Room's Game plan view show the question; every change is kept with who and
 * when, and every export records the answer it relied on, including whether it was only the
 * pre-ticked default or a confirmed yes.
 *
 * Stored in studio/data-consent.json. No file means the default: allowed, not yet shown.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';

export const CONSENT_FILE = path.join(REPO_ROOT, 'studio', 'data-consent.json');
export const QUESTION = 'Share this studio\'s work records (tasks, checks, reviews and outcomes, with keys and passwords removed) with AI research partners to help improve game-making models?';
export const DETAIL = 'Ticked by default. Untick to decline; you can change it any time. Records always stay on this computer and in your backups either way. Your game\'s code is only included if an export asks for it.';

export function readConsent() {
  try {
    const c = JSON.parse(fs.readFileSync(CONSENT_FILE, 'utf8'));
    return { share: c.share !== false, how: c.how || 'default', shown: Boolean(c.shown), by: c.by || null, at: c.at || null, history: c.history || [] };
  } catch {
    return { share: true, how: 'default', shown: false, by: null, at: null, history: [] };
  }
}

function write(c, msg) {
  const { history = [], ...now } = c;
  const next = { ...now, question: QUESTION, history: [...history, { share: now.share, how: now.how, by: now.by, at: now.at }].slice(-50) };
  fs.mkdirSync(path.dirname(CONSENT_FILE), { recursive: true });
  fs.writeFileSync(CONSENT_FILE, `${JSON.stringify(next, null, 2)}\n`);
  emitEvent({ type: 'data.consent', agent: now.by || 'producer', to: 'producer', msg });
  return readConsent();
}

/** The question was shown and left as it was: the pre-ticked default stands, now on record as shown. */
export function markShown(by = 'game dev') {
  const c = readConsent();
  if (c.shown) return c;
  return write({ ...c, shown: true, how: c.how === 'default' ? 'default' : c.how, by: c.by || by, at: new Date().toISOString() }, `Data-sharing question shown to ${by}; left ${c.share ? 'ticked (allowed)' : 'unticked'}`);
}

/** The game dev's own answer. */
export function setConsent(share, by) {
  if (!by) return { ok: false, message: 'Say who answers: --by <name>.' };
  const c = readConsent();
  const now = write({ ...c, share: Boolean(share), how: share ? 'confirmed' : 'declined', shown: true, by, at: new Date().toISOString() }, `${by} ${share ? 'confirmed sharing is allowed' : 'declined sharing'}`);
  return { ok: true, consent: now };
}

/** One line for manifests and the HUD. */
export function describeConsent(c = readConsent()) {
  if (!c.share) return `declined by ${c.by} on ${String(c.at).slice(0, 10)}`;
  if (c.how === 'confirmed') return `allowed, confirmed by ${c.by} on ${String(c.at).slice(0, 10)}`;
  return c.shown ? `allowed by default (pre-ticked, shown to ${c.by} on ${String(c.at).slice(0, 10)}, not declined)` : 'allowed by default (pre-ticked; not shown to the game dev yet)';
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const i = argv.indexOf('--by');
  const by = i >= 0 ? argv[i + 1] : null;
  if (argv[0] === 'allow' || argv[0] === 'decline') {
    const r = setConsent(argv[0] === 'allow', by);
    if (!r.ok) {
      console.error(r.message);
      process.exit(1);
    }
    console.log(`Sharing: ${describeConsent(r.consent)}.`);
  } else {
    const c = readConsent();
    console.log(`${QUESTION}\n[${c.share ? 'x' : ' '}] ${c.share ? 'Yes' : 'No'}. ${DETAIL}\n\nNow: ${describeConsent(c)}.\nChange it: npm run data -- decline --by <name>   or   npm run data -- allow --by <name>`);
  }
}

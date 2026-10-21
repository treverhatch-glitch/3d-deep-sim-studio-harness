#!/usr/bin/env node
/**
 * harness/game-id.mjs — every game gets an ID of its own, made once, without anyone asking.
 *
 *   npm run game-id                 show this studio's game and its ID (and make one if it has none)
 *   npm run game-id -- --all        every cartridge
 *
 * The ID (gid_ + 26 characters, 128 random bits) lives in cartridges/<game>/cartridge.json with the
 * game's name, when it was made, the harness version, and its parent's ID when it was started from
 * another game (a setup or a copy), so a game's family tree can be followed.
 *
 * It is stamped on goldens, regressions, signed results and saved builds, and on events. A golden or
 * regression whose gameId isn't its cartridge's fails the gates: results from another game (two games
 * built side by side, a copied folder, a marketplace upload) can't pass as this one's.
 *
 * It is public on purpose and is not mixed into seeds or state hashes: anyone must be able to replay
 * a game from its code and a seed and get the same hash, including a port to another engine. Proving
 * who made a game is the job of signed results (harness/sign.mjs), not of a secret.
 * Template cartridges (example-sim, _template) have no ID.
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from './event.mjs';
import { activeCartridge, isTemplateCartridge, listCartridges } from './cartridge.mjs';

const B32 = 'abcdefghjkmnpqrstvwxyz0123456789'; // no i, l, o, u: easy to read aloud
export const metaFile = (name) => path.join(REPO_ROOT, 'cartridges', name, 'cartridge.json');
export const isGameId = (x) => /^gid_[a-z0-9]{26}$/.test(String(x || ''));

export function mintGameId(bytes = crypto.randomBytes(17)) {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const b of bytes) {
    value = (value << 8) | b;
    bits += 8;
    while (bits >= 5 && out.length < 26) {
      out += B32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  return `gid_${out.slice(0, 26)}`;
}

export function readGameIdentity(name) {
  if (!name) return null;
  try {
    const m = JSON.parse(fs.readFileSync(metaFile(name), 'utf8'));
    return isGameId(m.id) ? m : null;
  } catch {
    return null;
  }
}

/** The game's identity, made now if it has none. Template cartridges never get one. */
export function ensureGameId(name, { parent = null, by = 'harness', title = null } = {}) {
  if (!name || isTemplateCartridge(name) || !fs.existsSync(path.join(REPO_ROOT, 'cartridges', name))) return null;
  const have = readGameIdentity(name);
  if (have) return have;
  let version = null;
  try {
    version = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'package.json'), 'utf8')).version;
  } catch {
    // no package.json
  }
  let old = {};
  try {
    old = JSON.parse(fs.readFileSync(metaFile(name), 'utf8'));
  } catch {
    // none yet
  }
  const meta = { ...old, id: mintGameId(), cartridge: name, name: title || old.name || name, created: new Date().toISOString(), harness: version, ...(parent ? { parent } : {}) };
  fs.writeFileSync(metaFile(name), `${JSON.stringify(meta, null, 2)}\n`);
  emitEvent({ type: 'game.id', agent: by, msg: `${name} has its game ID: ${meta.id}${parent ? ` (started from ${parent})` : ''}` });
  return meta;
}

/** A copy of a game becomes a new game: a new ID, with the old one as its parent. */
export function reidentify(name, { by = 'harness' } = {}) {
  const old = readGameIdentity(name);
  if (!old) return ensureGameId(name, { by });
  fs.writeFileSync(metaFile(name), `${JSON.stringify({ ...old, id: mintGameId(), created: new Date().toISOString(), parent: old.id }, null, 2)}\n`);
  return readGameIdentity(name);
}

/** The ID a recording should carry, and whether a recording's own gameId belongs to this cartridge. */
export function gameIdFor(name) {
  return readGameIdentity(name)?.id || null;
}
export function checkRecordingId(spec, name) {
  const mine = gameIdFor(name);
  if (!spec.gameId || !mine) return { ok: true, missing: Boolean(mine && !spec.gameId) };
  return spec.gameId === mine ? { ok: true } : { ok: false, message: `recorded for game ${spec.gameId}, but cartridges/${name} is ${mine}: results from another game (a copy or a second studio). Re-record with npm run golden -- --update if this game really changed hands.` };
}

let cached;
/** This studio's game ID, for events (read once per process). */
export function currentGameId() {
  if (cached !== undefined) return cached;
  const name = activeCartridge().name;
  cached = !name || isTemplateCartridge(name) ? null : gameIdFor(name);
  return cached;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const names = process.argv.includes('--all') ? listCartridges() : [activeCartridge().name].filter(Boolean);
  for (const n of names) {
    if (isTemplateCartridge(n)) {
      console.log(`${n}: a template cartridge, no game ID`);
      continue;
    }
    const m = ensureGameId(n, { by: process.env.STUDIO_LOCK_OWNER || 'harness' });
    console.log(m ? `${n}: ${m.id}${m.parent ? ` (from ${m.parent})` : ''}, made ${m.created.slice(0, 10)}` : `${n}: no cartridge folder`);
  }
  if (!names.length) console.log('No game yet: npm run new-game <name> makes one with its ID.');
}

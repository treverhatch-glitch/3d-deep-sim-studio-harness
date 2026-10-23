/**
 * scripts/lock-version.mjs — keep package-lock.json's version in step with package.json (2.30h).
 * `npm run release` calls this, so a bumped package.json never ships with a lagging lock (the 2.30d miss).
 */
import fs from 'node:fs';
import path from 'node:path';

/** Sets both "version" fields in package-lock.json to `version`. Returns { from, to, changed }. */
export function syncLockVersion(root, version) {
  const f = path.join(root, 'package-lock.json');
  if (!fs.existsSync(f)) return { from: null, to: null, changed: false };
  const lock = JSON.parse(fs.readFileSync(f, 'utf8'));
  const from = lock.version ?? null;
  if (from === version && (!lock.packages?.[''] || lock.packages[''].version === version)) return { from, to: version, changed: false };
  lock.version = version;
  if (lock.packages?.['']) lock.packages[''].version = version;
  fs.writeFileSync(f, `${JSON.stringify(lock, null, 2)}\n`);
  return { from, to: version, changed: true };
}

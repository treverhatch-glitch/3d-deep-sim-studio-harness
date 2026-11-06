/**
 * Queue one line for the Communicator's next post (`.studio/comm/notices.jsonl`). Kept apart from communicator.mjs:
 * that module runs its CLI with a top-level await, so a module it imports while running (mode.mjs, spend-budget.mjs …)
 * must not import it back, or the import never settles (`npm run comm -- preview` exited 13, 2.79.1).
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT } from './event.mjs';

export function queueNotice({ key, text, kind = 'notice', root = REPO_ROOT } = {}) {
  const f = path.join(root, '.studio', 'comm', 'notices.jsonl');
  fs.mkdirSync(path.dirname(f), { recursive: true });
  fs.appendFileSync(f, `${JSON.stringify({ key: key || `${kind}:${Date.now()}`, kind, text: String(text || '').slice(0, 1000), at: new Date().toISOString() })}\n`);
}

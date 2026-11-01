#!/usr/bin/env node
// 2.60.1 (B-40): PreToolUse hook. In a lane copy (.lanes/<agent>) studio/ is a link to the main checkout's, so an edit
// to studio config there lands straight in main. Edit/Write/MultiEdit/NotebookEdit of studio config are denied in a
// lane copy; the reason names the sanctioned route (harness/lane-studio.mjs). STUDIO_LANE_STUDIO_GUARD=off disables.
import { decideEdit } from '../../harness/lane-studio.mjs';

if (process.argv[1] && import.meta.url.endsWith(process.argv[1].split(/[\/\\]/).pop())) {
  let data = '';
  const quit = setTimeout(() => process.exit(0), 3000);
  process.stdin.on('data', (c) => (data += c));
  process.stdin.on('end', () => {
    clearTimeout(quit);
    try {
      const i = JSON.parse(data);
      const d = decideEdit(i.tool_name, i.tool_input, { dir: process.env.CLAUDE_PROJECT_DIR || i.cwd || process.cwd() });
      if (d) process.stdout.write(JSON.stringify(d));
    } catch {}
    process.exit(0);
  });
}

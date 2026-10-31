/**
 * qa/selftest-249.mjs — 2.49.0 (U-004): npm run logs reads the studio logs' 2-minute summary.
 */
import fs from 'node:fs';
import path from 'node:path';

export async function selftest249({ dir, run, report }) {
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const none = run(dir, 'node harness/logs.mjs');
  const d = path.join(dir, 'studio/logs');
  fs.mkdirSync(d, { recursive: true });
  fs.writeFileSync(path.join(d, 'README.md'), '# Studio logs\n\n## Latest summary — today\n- Done: the dice.\n\n## The files\n');
  fs.writeFileSync(path.join(d, 'PROBLEMS.md'), '# Problems\n\n### P-001 — Repo is public · open\n- x\n\n### P-002 — Template copy on Windows · fixed 2026-10-31\n- y\n\n### P-003 — GPU unread · open\n- z\n');
  fs.writeFileSync(path.join(d, 'PROPOSALS.md'), '# Proposals\n\n### U-001 — Second repo · approved 2026-10-31, done\n\n### U-002 — Logs command · waiting\n');
  fs.writeFileSync(path.join(d, 'WORK-LOG.md'), '| Date | Who |\n| --- | --- |\n| 2026-10-31 | a | x |\n| 2026-10-31 | b | y |\n');
  const full = run(dir, 'node harness/logs.mjs');
  const brief = run(dir, 'node harness/logs.mjs --brief');
  report('2.49.0 (U-004): npm run logs prints the latest summary, the open problems and the proposals waiting for the owner; --brief is three lines for a chat post; no logs folder is a note, not an error', none.status === 0 && /no studio\/logs\/ folder yet/.test(out(none)) && full.status === 0 && /Latest summary — today/.test(out(full)) && /Open problems \(2\)\n- P-001 Repo is public\n- P-003 GPU unread/.test(out(full)) && /Proposals waiting for your OK \(1\)\n- U-002 Logs command/.test(out(full)) && out(brief).trim().split('\n').length === 3 && /2 task\(s\) logged · 2 open problem\(s\) · 1 proposal\(s\) waiting/.test(out(brief)), `${out(none)}\n---\n${out(full)}\n---\n${out(brief)}`);
}

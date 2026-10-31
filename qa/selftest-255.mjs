/**
 * qa/selftest-255.mjs — 2.55.0: fixes from the crew's own logs (P-028, P-030, P-031, P-032), approved by the owner.
 *   P-028: a launcher session that ended before a claim was made never hands that claim back or frees it (a chat
 *          bot claiming under the same name later keeps its task); a claim made during the session still goes back.
 *   P-030: `onboard --sync --dry-run` lists what would come in and writes nothing.
 *   P-031: hub:build's type check doesn't rely on the shell expanding *.tsx (cmd and PowerShell don't).
 *   P-032: with no pace chosen, nothing starts on its own (the Director included); the dev gets a note once an hour.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest255({ dir, run, report, tmpRoot }) {
  const u = (p) => JSON.stringify(pathToFileURL(path.join(dir, p)).href);
  const out = (r) => `${r.stdout || ''}${r.stderr || ''}`;
  const probe = (name, code, env = {}) => {
    const f = path.join(dir, `.probe-255-${name}.mjs`);
    fs.writeFileSync(f, code);
    const r = run(dir, `node ${path.basename(f)}`, env);
    const line = String(r.stdout || '').trim().split('\n').filter((l) => l.startsWith('{')).pop();
    try { return { ...JSON.parse(line), _err: r.stderr }; } catch { return { _raw: out(r).slice(-1500) }; }
  };

  // P-028: claims and an old session record under the same name.
  const claims = probe('claims', `import fs from 'node:fs';
import path from 'node:path';
import { claim as acquire, listLocks } from ${u('harness/lock.mjs')};
import { releaseDeadLocks, AGENTS_DIR } from ${u('harness/agent.mjs')};
const now = Date.now();
fs.mkdirSync(AGENTS_DIR, { recursive: true });
// opus-1 ended 30 min ago; old-1 ended 1 min ago.
const rec = (agent, minAgo) => fs.writeFileSync(path.join(AGENTS_DIR, agent + '.json'), JSON.stringify({ agent, role: 'producer', status: 'ended', pid: 999999, endedAt: new Date(now - minAgo * 60000).toISOString(), startedAt: new Date(now - 90 * 60000).toISOString() }));
rec('opus-1', 30); rec('old-1', 1);
acquire('task:T-926', 'opus-1', 3600);      // claimed now, after opus-1's session ended: a chat bot with that name
acquire('path:game/x/src/a', 'opus-1', 3600);
// old-1's claim was made while its session ran: write it with a claim time before the end.
acquire('task:T-927', 'old-1', 3600);
const lf = fs.readdirSync('.studio/locks').find((f) => f.includes('T-927'));
const lp = path.join('.studio/locks', lf); const l = JSON.parse(fs.readFileSync(lp, 'utf8')); l.claimedAt = new Date(now - 10 * 60000).toISOString(); fs.writeFileSync(lp, JSON.stringify(l));
const freed = await releaseDeadLocks();
console.log(JSON.stringify({ freed, left: listLocks().map((x) => x.key + ' ' + x.owner).sort() }));`);
  report('2.55.0 (P-028): a session that ended before a claim was made doesn\'t free it (a chat bot reusing the name keeps its task and paths); a claim made while the session ran is still freed',
    claims.left?.includes('task:T-926 opus-1') && claims.left?.includes('path:game/x/src/a opus-1') && !claims.left?.some((k) => k.startsWith('task:T-927')) && claims.freed?.some((f) => /T-927/.test(f)), JSON.stringify(claims).slice(0, 1200));
  const watchSrc = fs.readFileSync(path.join(dir, 'harness', 'watch.mjs'), 'utf8');
  report('2.55.0 (P-028): the watcher\'s hand-back for an ended session skips a claim made after that session ended', /2\.55\.0 \(P-028\)/.test(watchSrc) && /staleRecord/.test(watchSrc), '');

  // P-030: --sync --dry-run writes nothing.
  const g = (cwd, ...a) => spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  const env = { AGENT_EVENTS_FILE: path.join(dir, '.studio', 'events-255.jsonl'), STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0' };
  const src = path.join(tmpRoot, `pier-255-${process.pid}`);
  fs.mkdirSync(path.join(src, 'src'), { recursive: true });
  fs.writeFileSync(path.join(src, 'package.json'), JSON.stringify({ name: 'pier', scripts: { test: 'vitest run' } }, null, 2));
  fs.writeFileSync(path.join(src, 'src/boats.ts'), 'export const boats = 1;\n');
  g(src, 'init', '-q', '-b', 'main'); g(src, 'add', '-A'); g(src, 'commit', '-qm', 'start');
  g(dir, 'init', '-q', '-b', 'main'); g(dir, 'config', 'core.autocrlf', 'false'); g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'studio', '--no-verify');
  run(dir, `node scripts/onboard-game.mjs --path "${src}" --name Pier --adopt`, env);
  g(dir, 'add', '-A'); g(dir, 'commit', '-qm', 'adopt', '--no-verify');
  fs.writeFileSync(path.join(src, 'src/boats.ts'), 'export const boats = 4; // upstream\n');
  g(src, 'commit', '-qam', 'upstream work');
  const head = g(dir, 'rev-parse', 'HEAD').stdout.trim();
  const originBefore = fs.readFileSync(path.join(dir, 'studio/game/ORIGIN.json'), 'utf8');
  const dry = run(dir, 'node scripts/onboard-game.mjs --sync --dry-run', env);
  const after = {
    head: g(dir, 'rev-parse', 'HEAD').stdout.trim(),
    origin: fs.readFileSync(path.join(dir, 'studio/game/ORIGIN.json'), 'utf8'),
    boats: fs.readFileSync(path.join(dir, 'game/pier/src/boats.ts'), 'utf8'),
    dirty: g(dir, 'status', '--porcelain', '--untracked-files=no').stdout.trim(),
  };
  const real = run(dir, 'node scripts/onboard-game.mjs --sync', env);
  report('2.55.0 (P-030): onboard --sync --dry-run lists the commits and files it would bring in and writes nothing (no patch, no ORIGIN.json change, no commit); without --dry-run it syncs',
    dry.status === 0 && /dry run: --sync would bring in 1 commit\(s\) \(1 file\(s\)\)/.test(out(dry)) && /upstream work/.test(out(dry)) && /file: src\/boats\.ts/.test(out(dry)) && after.head === head && after.origin === originBefore && /boats = 1;/.test(after.boats) && after.dirty === '' && real.status === 0 && /synced 1 commit/.test(out(real)) && /boats = 4/.test(fs.readFileSync(path.join(dir, 'game/pier/src/boats.ts'), 'utf8')),
    `${out(dry)}\n---\n${JSON.stringify(after)}\n---\n${out(real)}`);

  // P-031: hub:build's type check without a shell glob.
  const pkg = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  let tsc = null;
  try { tsc = JSON.parse(fs.readFileSync(path.join(dir, 'hub', 'tsconfig.check.json'), 'utf8')); } catch {}
  report('2.55.0 (P-031): hub:build type-checks through hub/tsconfig.check.json (TypeScript expands *.tsx itself), not a shell glob Windows doesn\'t expand',
    /tsc -p tsconfig\.check\.json/.test(pkg.scripts['hub:build'] || '') && !/\*\.tsx/.test(pkg.scripts['hub:build'] || '') && JSON.stringify(tsc?.include) === '["*.tsx"]' && tsc?.compilerOptions?.noEmit === true && tsc?.compilerOptions?.jsx === 'react-jsx', `${pkg.scripts['hub:build']}\n${JSON.stringify(tsc)}`);

  // P-032: no pace chosen, nothing starts on its own; one note an hour.
  const pace = probe('pace', `import fs from 'node:fs';
import { fillAgents } from ${u('harness/agent.mjs')};
import { readRecentEvents } from ${u('harness/event.mjs')};
fs.rmSync('studio/mode.json', { force: true });
const a = await fillAgents({ byDirector: true });
const b = await fillAgents({ byDirector: true });
console.log(JSON.stringify({ a, b, notes: readRecentEvents(2000).filter((e) => e.type === 'pace.unchosen').length }));`, { STUDIO_AGENT_TOOL: 'custom', STUDIO_AGENT_CMD: 'node -e ""', STUDIO_MODE: '' });
  report('2.55.0 (P-032): with no pace chosen the Director\'s refill starts no agent, and the dev gets one "no pace is chosen" note an hour (not one per pass)',
    pace.a?.started?.length === 0 && /no pace chosen/.test(pace.a?.why || '') && pace.b?.started?.length === 0 && pace.notes === 1, JSON.stringify(pace).slice(0, 1200));
}

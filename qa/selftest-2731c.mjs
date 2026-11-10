/**
 * qa/selftest-2731c.mjs — 2.73.1 (helper c, B-59): no console window flashes on Windows when the harness starts a process.
 *   static    every child_process call (spawn, spawnSync, exec, execSync, execFile, execFileSync, fork) in harness/,
 *             hub/, scripts/, tools/, qa/*.mjs, qa/fixtures/ and .claude/hooks/ passes `windowsHide: true` in an options
 *             object written at the call, except the few in VISIBLE (each with its reason; an entry that no longer
 *             matches exactly one call fails too, so the list can't go stale); the node snippets inside the git hooks too
 *   detached  every detached child (hub, supervisor, daemons, background passes) passes windowsHide
 *   launcher  harness/launch.mjs starts an agent's tool (spawnAgent, spawnAgentSync) with windowsHide, whatever the caller
 *             passed
 *   runtime   commands run in a copy under a recorder (node --import, the test's own process only) start every child
 *             with windowsHide
 *   docs      docs/SECURITY.md says the NODE_OPTIONS preload stopgap can go after 2.73.1, and how
 *   scrub     (not a fix: unchanged on purpose) gate-env still drops a code-loading NODE_OPTIONS and names the preload
 * windowsHide does nothing off Windows, so on Linux this checks the options, not the windows. Every check but `scrub`
 * fails on 2.73.0 (hundreds of calls without the option; the launcher and both commands start children without it; no
 * note in SECURITY.md).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { pathToFileURL, fileURLToPath } from 'node:url';

export const CP_FUNCTIONS = ['spawn', 'spawnSync', 'exec', 'execSync', 'execFile', 'execFileSync', 'fork'];

/**
 * Calls that may show a window on purpose: the file, the start of the call's text (spaces collapsed) and why. Each must
 * match exactly one call that has no windowsHide: true.
 */
export const VISIBLE = [
  { file: 'harness/engine.mjs', call: "spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: 10 * 60000 })", why: '`npm run engine -- capture` runs the engine track\'s capture command, which renders frames in a real window: a window started hidden may render nothing' },
  { file: 'harness/visual-proof.mjs', call: "spawnSync('xvfb-run', ['-a', '-s', '-screen 0 1280x720x24', bin, ...runArgs], opts)", why: 'the visual proof\'s Godot capture run (not --headless) renders the named cameras in a real window (Linux: a virtual display)' },
  { file: 'harness/visual-proof.mjs', call: 'spawnSync(bin, runArgs, opts)', why: 'the visual proof\'s Godot capture run (not --headless) renders the named cameras in a real window' },
  { file: 'harness/visual-proof.mjs', call: "spawnSync(cmd, { cwd: REPO_ROOT, shell: true, encoding: 'utf8', timeout: timeoutMs, maxBuffer: 32 * 1024 * 1024, env: rv.env })", why: 'the game\'s own visual capture command (its game config\'s capture line) may render in a real window' },
];

const SCAN_DIRS = ['harness', 'scripts', 'tools', path.join('qa', 'fixtures'), path.join('.claude', 'hooks')];

/** The JS files the check reads, relative to root (forward slashes). */
export function scanFiles(root) {
  const out = [];
  const walk = (d) => {
    let list = [];
    try { list = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of list) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) { if (!/^(node_modules|\.git|dist|build)$/.test(e.name)) walk(p); } else if (/\.(mjs|cjs|js)$/.test(e.name)) out.push(p);
    }
  };
  for (const d of SCAN_DIRS) walk(path.join(root, d));
  try { for (const e of fs.readdirSync(path.join(root, 'qa'))) if (/\.mjs$/.test(e)) out.push(path.join(root, 'qa', e)); } catch {}
  return [...new Set(out)].map((f) => path.relative(root, f).split(path.sep).join('/')).sort();
}

/**
 * Every child_process call in those files: [{ file, line, fn, hide, detached, text }]. hide: the options object at the
 * call has `windowsHide: true`. Calls are found through what each file imports from child_process (named, namespace,
 * default, require, await import), so a local wrapper's own call is what counts.
 */
export function childProcessCalls(root, ts) {
  const FNS = new Set(CP_FUNCTIONS);
  const rows = [];
  const isCP = (n) => n && ts.isStringLiteral(n) && /^(node:)?child_process$/.test(n.text);
  const isLoad = (e) => ts.isCallExpression(e) && (e.expression.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(e.expression) && e.expression.text === 'require')) && isCP(e.arguments[0]);
  const bare = (e) => { while (e && (ts.isParenthesizedExpression(e) || ts.isAwaitExpression(e))) e = e.expression; return e; };
  for (const file of scanFiles(root)) {
    const text = fs.readFileSync(path.join(root, file), 'utf8');
    if (!text.includes('child_process')) continue;
    const sf = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true, ts.ScriptKind.JS);
    const named = new Map();
    const ns = new Set();
    const bind = (n) => {
      if (ts.isImportDeclaration(n) && isCP(n.moduleSpecifier) && n.importClause) {
        const c = n.importClause;
        if (c.name) ns.add(c.name.text);
        if (c.namedBindings) {
          if (ts.isNamespaceImport(c.namedBindings)) ns.add(c.namedBindings.name.text);
          else for (const s of c.namedBindings.elements) named.set(s.name.text, (s.propertyName || s.name).text);
        }
      }
      if (ts.isVariableDeclaration(n) && n.initializer && isLoad(bare(n.initializer))) {
        if (ts.isIdentifier(n.name)) ns.add(n.name.text);
        else if (ts.isObjectBindingPattern(n.name)) for (const el of n.name.elements) if (ts.isIdentifier(el.name)) named.set(el.name.text, (el.propertyName || el.name).text);
      }
      ts.forEachChild(n, bind);
    };
    bind(sf);
    const isNs = (e) => { e = bare(e); return ts.isIdentifier(e) ? ns.has(e.text) : isLoad(e); };
    const visit = (n) => {
      if (ts.isCallExpression(n)) {
        const c = n.expression;
        let fn = null;
        if (ts.isIdentifier(c) && named.has(c.text)) fn = named.get(c.text);
        else if (ts.isPropertyAccessExpression(c) && isNs(c.expression)) fn = c.name.text;
        if (fn && FNS.has(fn)) {
          const a = n.arguments;
          // The options argument: exec/execSync(cmd, options); the others (file, [args], options).
          let o = null;
          if (fn === 'exec' || fn === 'execSync') o = a[1];
          else o = a[1] && ts.isObjectLiteralExpression(a[1]) ? a[1] : a[2];
          const lit = o && ts.isObjectLiteralExpression(o) ? o : null;
          const prop = (k) => lit && lit.properties.find((p) => ts.isPropertyAssignment(p) && p.name && p.name.text === k);
          const hp = prop('windowsHide');
          const dp = prop('detached');
          const t = text.slice(n.getStart(), n.getEnd()).replace(/\s+/g, ' ');
          rows.push({ file, line: sf.getLineAndCharacterOfPosition(n.getStart()).line + 1, fn, hide: Boolean(hp && hp.initializer.kind === ts.SyntaxKind.TrueKeyword), detached: Boolean(dp && dp.initializer.kind !== ts.SyntaxKind.FalseKeyword), text: t });
        }
      }
      ts.forEachChild(n, visit);
    };
    visit(sf);
  }
  return rows;
}

/** { missing, stale, visible, total }: calls without windowsHide that VISIBLE doesn't name; VISIBLE entries that don't match exactly one. */
export function windowsHideAudit(rows, allow = VISIBLE) {
  const hits = allow.map((v) => rows.filter((r) => r.file === v.file && !r.hide && r.text.startsWith(v.call)));
  const allowed = new Set(hits.flat());
  return {
    total: rows.length,
    missing: rows.filter((r) => !r.hide && !allowed.has(r)),
    stale: allow.filter((v, i) => hits[i].length !== 1 || !String(v.why || '').trim()),
    visible: allowed.size,
  };
}

export async function selftest2731C({ dir, run, report, tmpRoot, root }) {
  const harnessRoot = root || path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  const guard = async (name, fn) => { try { const [ok, detail] = await fn(); report(name, Boolean(ok), detail); } catch (e) { report(name, false, e.stack || String(e)); } };
  let ts = null;
  for (const base of [dir, harnessRoot]) {
    try { ts = createRequire(path.join(base, 'package.json'))('typescript'); break; } catch {}
  }
  const where = (r) => `${r.file}:${r.line} ${r.text.slice(0, 140)}`;
  let rows = [];
  try { rows = ts ? childProcessCalls(dir, ts) : []; } catch {}

  await guard('2.73.1 (B-59): every child_process call in harness/, hub/, scripts/, tools/, qa/ and .claude/hooks/ passes windowsHide: true (the few that show a window on purpose are listed with a reason)', () => {
    if (!ts) return [false, 'typescript not found (needed to read the sources): run npm ci'];
    const a = windowsHideAudit(rows);
    // The git hooks are bash; the node snippets in them start git too.
    const hookLines = [];
    try {
      for (const f of fs.readdirSync(path.join(dir, 'scripts', 'hooks'))) {
        fs.readFileSync(path.join(dir, 'scripts', 'hooks', f), 'utf8').split('\n').forEach((l, i) => { if (/\b(execFileSync|execSync|spawnSync|spawn|execFile)\(/.test(l) && !/windowsHide:\s*true/.test(l)) hookLines.push(`scripts/hooks/${f}:${i + 1} ${l.trim().slice(0, 120)}`); });
      }
    } catch {}
    const ok = a.total > 300 && !a.missing.length && !a.stale.length && !hookLines.length;
    return [ok, `${a.total} calls, ${a.missing.length} without windowsHide:\n${a.missing.slice(0, 25).map(where).join('\n')}${a.missing.length > 25 ? `\n... and ${a.missing.length - 25} more` : ''}${a.stale.length ? `\nVISIBLE entries matching no single call: ${a.stale.map((v) => `${v.file} ${v.call}`).join('; ')}` : ''}${hookLines.length ? `\nhooks: ${hookLines.join('\n')}` : ''}`];
  });

  await guard('2.73.1 (B-59): every detached child (hub, supervisor, train daemon, background passes) is started with windowsHide', () => {
    if (!ts) return [false, 'typescript not found'];
    const det = rows.filter((r) => r.detached);
    const bad = det.filter((r) => !r.hide);
    return [det.length >= 10 && !bad.length, `${det.length} detached spawns, ${bad.length} without windowsHide:\n${bad.map(where).join('\n')}`];
  });

  // A recorder for the test's own node process only: wraps child_process and notes each call's windowsHide.
  const rec = path.join(tmpRoot, `rec-2731c-${process.pid}.mjs`);
  fs.writeFileSync(rec, `import cp from 'node:child_process';
import { syncBuiltinESMExports } from 'node:module';
import fs from 'node:fs';
const out = process.env.REC_2731C;
for (const fn of ${JSON.stringify(CP_FUNCTIONS)}) {
  const orig = cp[fn];
  cp[fn] = function (...a) {
    let o = fn === 'exec' || fn === 'execSync' ? a[1] : (Array.isArray(a[1]) ? a[2] : a[1]);
    if (typeof o !== 'object' || o === null) o = {};
    try { fs.appendFileSync(out, JSON.stringify({ fn, cmd: String(a[0]).slice(0, 80), hide: o.windowsHide === true }) + '\\n'); } catch {}
    return orig.apply(this, a);
  };
}
syncBuiltinESMExports();
`);
  const recorded = (args, cwd, extraEnv = {}) => {
    const log = path.join(tmpRoot, `rec-2731c-${process.pid}-${Math.random().toString(36).slice(2)}.jsonl`);
    const env = { ...process.env, STUDIO_REFILL_WAKE: 'off', STUDIO_TASK_BUDGET: 'off', STUDIO_GATE_SLOTS: '0', STUDIO_WATCHDOG: 'off', STUDIO_MAIN_ROOT: '', STUDIO_LOCK_OWNER: '', NODE_OPTIONS: '', ...extraEnv, REC_2731C: log };
    const r = spawnSync(process.execPath, ['--import', pathToFileURL(rec).href, ...args], { cwd, env, encoding: 'utf8', timeout: 120000, windowsHide: true });
    let calls = [];
    try { calls = fs.readFileSync(log, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch {}
    try { fs.rmSync(log, { force: true }); } catch {}
    return { r, calls };
  };

  await guard('2.73.1 (B-59): the launcher starts an agent\'s tool (spawnAgent, spawnAgentSync) with windowsHide, even when the caller passes none', () => {
    const probe = path.join(tmpRoot, `launch-2731c-${process.pid}.mjs`);
    fs.writeFileSync(probe, `const { spawnAgentSync, spawnAgent } = await import(${JSON.stringify(pathToFileURL(path.join(dir, 'harness', 'launch.mjs')).href)});
spawnAgentSync([process.execPath, '-e', '0'], { encoding: 'utf8' });
const { child } = spawnAgent([process.execPath, '-e', '0'], { stdio: 'ignore' });
child.on('exit', () => process.exit(0));
`);
    const { r, calls } = recorded([probe], dir);
    return [r.status === 0 && calls.length === 2 && calls.every((c) => c.hide), `exit ${r.status}; ${JSON.stringify(calls)}\n${r.stderr || ''}`];
  });

  await guard('2.73.1 (B-59): commands run for real (handoff, preflight) start every child with windowsHide', () => {
    // A studio copy with a git repository, so the commands' git calls run.
    const S = path.join(tmpRoot, `2731c-rt-${process.pid}`);
    fs.rmSync(S, { recursive: true, force: true });
    fs.cpSync(dir, S, { recursive: true, filter: (src) => !/[\\/](\.git|\.lanes|node_modules)$/.test(src) });
    const ident = { GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@example.invalid', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@example.invalid' };
    const gEnv = { ...process.env, ...ident };
    for (const k of Object.keys(gEnv)) if (/^GIT_(DIR|WORK_TREE|INDEX_FILE|CONFIG.*)$/.test(k)) delete gEnv[k];
    for (const a of [['init', '-q', '-b', 'main'], ['config', 'core.autocrlf', 'false'], ['add', '-A'], ['commit', '-qm', 'studio', '--no-verify']]) spawnSync('git', a, { cwd: S, env: gEnv, encoding: 'utf8', windowsHide: true });
    const out = [];
    let ok = true;
    for (const args of [['harness/handoff.mjs'], ['scripts/preflight.mjs']]) {
      const { calls } = recorded(args, S, ident);
      const bad = calls.filter((c) => !c.hide);
      if (calls.length < 5 || bad.length) ok = false;
      out.push(`${args.join(' ')}: ${calls.length} children, ${bad.length} without windowsHide ${JSON.stringify(bad.slice(0, 5))}`);
    }
    try { fs.rmSync(S, { recursive: true, force: true }); } catch {}
    return [ok, out.join('\n')];
  });

  await guard('2.73.1 (B-59): docs/SECURITY.md says the NODE_OPTIONS windowsHide preload can be removed after 2.73.1, and how', () => {
    const doc = fs.readFileSync(path.join(dir, 'docs', 'SECURITY.md'), 'utf8');
    const ok = /2\.73\.1/.test(doc) && /windowsHide/.test(doc) && /preload/i.test(doc) && /Remove-Item Env:NODE_OPTIONS|setx NODE_OPTIONS|\[Environment\]::SetEnvironmentVariable\('NODE_OPTIONS'/.test(doc);
    return [ok, 'SECURITY.md has no 2.73.1 note on removing the windowsHide preload'];
  });

  await guard('2.73.1 (B-59, unchanged on purpose): gate-env still drops a code-loading NODE_OPTIONS from gate children and names the preload in its own process', async () => {
    const { scrubGateEnv, preloadedNodeOptions } = await import(pathToFileURL(path.join(dir, 'harness', 'gate-env.mjs')).href);
    const env = { NODE_OPTIONS: '--require C:\\hide-windows.cjs --max-old-space-size=4096', npm_config_node_options: '--import x' };
    const { env: clean, dropped } = scrubGateEnv(env);
    const pre = preloadedNodeOptions(env);
    const ok = clean.NODE_OPTIONS === '--max-old-space-size=4096' && !('npm_config_node_options' in clean) && dropped.some((d) => /NODE_OPTIONS/.test(d)) && pre.includes('--require');
    return [ok, JSON.stringify({ clean: clean.NODE_OPTIONS, dropped, pre })];
  });
}

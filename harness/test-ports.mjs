#!/usr/bin/env node
/**
 * harness/test-ports.mjs — 2.77.3 (C2, B-108): fixed test ports, and the failures they cause.
 *
 * Every browser e2e file of a crew's game started its own vite server on a hard-coded port (strictPort). Two verifies
 * running the same file at once (a train and a builder, or two trains) collided: the second server failed ("Port 46117
 * is already in use", "listen EADDRINUSE"), or the test drove the other tree's server. The flake triager (harness/
 * flakes.mjs) called those "load-flake" or "real", a different file each run. Here:
 *
 *   portCollision(text, { file })  the first port-collision line in a run's output, as { port, line }, or null:
 *                                  EADDRINUSE, "address already in use", vite's "Port N is already in use" (strictPort),
 *                                  Playwright's "<url> is already used". With `file`, a line near a mention of that file
 *                                  wins. The triager labels such a red "port-collision" (its own kind: not real, not a
 *                                  timing flake, never quarantined).
 *   fixedPortFindings(root, dirs)  test files and test-runner configs that start a server on a literal port with
 *                                  strictPort (or Playwright's reuseExistingServer, which drives whatever already
 *                                  listens there): [{ file, line, port, text }]. Advisory only: the game gate prints
 *                                  them as `[game-gates] WARN game:test-ports: …` (shown even when the check passes);
 *                                  it never fails a check. STUDIO_TEST_PORTS=off turns the scan off.
 *
 * The rule (studio/rules/test-ports.md): a test asks the OS for a free port (listen on port 0, or a helper that does)
 * and passes it on; a fixed port is fine only for a server no two runs ever start at once.
 *
 *   node harness/test-ports.mjs [--json] [<dir> ...]   the findings (default: the studio game's folder); exit 0 always
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { isTestPath, isTestConfig } from './test-weakening.mjs';

const toPosix = (p) => String(p).replace(/\\/g, '/');
const off = (v) => /^(off|0|false|no)$/i.test(String(v ?? '').trim());
export const testPortsOn = (env = process.env) => !off(env.STUDIO_TEST_PORTS);

// One regex per message shape; the port is the first group that matched.
const COLLISION = [
  /\bEADDRINUSE\b/,
  /\baddress already in use\b/i,
  /\bPort (\d{2,5}) is (?:already )?in use\b/i,
  /\bport (\d{2,5}) (?:is )?already (?:in use|taken|used)\b/i,
  /\bhttps?:\/\/[\w.-]+:(\d{2,5})\/?\S* is already used\b/i,
  /\bstrictPort\b[^\n]*?\b(\d{4,5})\b/,
];

/**
 * The port-collision line in a run's output: { port (number or null), line } or null. With `file`, the hit nearest
 * a line naming that file (its basename) is chosen; else the first one.
 */
export function portCollision(text, { file = '' } = {}) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const hits = [];
  for (let i = 0; i < lines.length; i += 1) {
    for (const re of COLLISION) {
      const m = lines[i].match(re);
      if (!m) continue;
      // The port: the pattern's own group, else "host:port" / "port N" on the line (EADDRINUSE 127.0.0.1:46117, :::46117).
      const port = m.slice(1).find((x) => x) || (lines[i].match(/:(\d{2,5})(?![\d\w.:])/g) || []).map((x) => x.slice(1)).pop() || (lines[i].match(/\bport\s+(\d{2,5})\b/i) || [])[1] || null;
      hits.push({ i, port: port ? Number(port) : null, line: lines[i].trim().slice(0, 240) });
      break;
    }
  }
  if (!hits.length) return null;
  let pick = hits[0];
  const base = file ? path.posix.basename(toPosix(file)) : '';
  if (base) {
    const near = lines.map((l, i) => (l.includes(base) ? i : -1)).filter((i) => i >= 0);
    if (near.length) pick = hits.slice().sort((a, b) => Math.min(...near.map((n) => Math.abs(n - a.i))) - Math.min(...near.map((n) => Math.abs(n - b.i))))[0];
  }
  // A port named on another hit (the error line often names it, the stack line doesn't).
  const port = pick.port ?? hits.find((h) => h.port)?.port ?? null;
  return { port, line: pick.line };
}

/** The triager's words for a port collision (harness/flakes.mjs). */
export function portCollisionWhy(pc, { alone }) {
  const p = pc.port ? `port ${pc.port}` : 'a fixed port';
  return `${alone ? 'fails alone too, on' : 'passes alone; the red run hit'} a port collision (${pc.line}): ${p} was already in use, most likely by another verify running the same test at the same time. Give the test a free port (listen on port 0, or a helper that finds one) instead of a fixed one with strictPort (studio/rules/test-ports.md). Not a timing flake and not this lane's failure`;
}

const CODE = /\.(m?[jt]sx?|c[jt]s|json)$/i;
const E2E = /(^|[/._-])(e2e|browser|playwright|puppeteer|webdriver|smoke)([/._-]|$)/i;
const STRICT = /\bstrictPort\b(?!['"]?\s*[:=]\s*false)|--strict-?port\b|\breuseExistingServer\b(?!['"]?\s*[:=]\s*false)/;
// A literal port where a server is told which one to use.
const PORT_LIT = [
  /\bport\s*[:=]\s*(\d{4,5})\b/i,
  /--port[= ](\d{4,5})\b/,
  /\b(?:PORT|[A-Z_]*_PORT)\s*=\s*['"]?(\d{4,5})\b/,
  /\.listen\(\s*(\d{4,5})\b/,
  /\b(?:localhost|127\.0\.0\.1|0\.0\.0\.0):(\d{4,5})\b/,
];

function walk(root, rel, out, depth = 0) {
  if (depth > 12) return out;
  let st;
  try { st = fs.statSync(path.join(root, rel)); } catch { return out; }
  if (st.isFile()) { if (CODE.test(rel)) out.push(toPosix(rel)); return out; }
  let list = [];
  try { list = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of list) {
    if (['node_modules', '.git', 'dist', 'build', '.lanes', '.studio', 'coverage'].includes(e.name)) continue;
    walk(root, path.join(rel, e.name), out, depth + 1);
  }
  return out;
}

/**
 * Test files and test-runner configs under `dirs` (relative to root) that hard-code a server port with strictPort or
 * reuseExistingServer: [{ file, line, port, text }]. Comment lines are skipped. Never throws.
 */
export function fixedPortFindings(root, dirs = ['.'], { maxFiles = 4000 } = {}) {
  const out = [];
  try {
    const files = [...new Set(dirs.flatMap((d) => walk(root, toPosix(d).replace(/\/+$/, '') || '.', [])))].map((f) => f.replace(/^\.\//, '')).slice(0, maxFiles);
    for (const f of files) {
      if (!isTestConfig(f) && !(isTestPath(f) && E2E.test(f)) && !/(^|\/)(e2e|browser)[^/]*\//i.test(f)) continue;
      let text;
      try { text = fs.readFileSync(path.join(root, f), 'utf8'); } catch { continue; }
      if (!STRICT.test(text)) continue;
      const lines = text.replace(/\r\n?/g, '\n').split('\n');
      for (let i = 0; i < lines.length; i += 1) {
        const l = lines[i];
        if (/^\s*(\/\/|\*|\/\*|#)/.test(l)) continue;
        for (const re of PORT_LIT) {
          const m = l.match(re);
          if (!m) continue;
          const port = Number(m[1]);
          if (port < 1024 || port > 65535) break;
          out.push({ file: f, line: i + 1, port, text: l.trim().slice(0, 160) });
          break;
        }
      }
    }
  } catch {}
  return out;
}

/** The advisory lines for a game folder (the game gate prints them), or []. */
export function fixedPortWarnings(root, dirs, env = process.env) {
  if (!testPortsOn(env)) return [];
  const f = fixedPortFindings(root, dirs);
  if (!f.length) return [];
  const files = [...new Set(f.map((x) => x.file))];
  return [
    ...f.slice(0, 8).map((x) => `[game-gates] WARN game:test-ports: ${x.file}:${x.line} starts a test server on the fixed port ${x.port} (${x.text}); two verifies running it at once collide ("port in use", or the test drives the other tree's server)`),
    `[game-gates] WARN game:test-ports: ${f.length} fixed test port(s) in ${files.length} file(s): give each run a free port (listen on port 0, or a helper that finds one) and pass it to the server and the test (studio/rules/test-ports.md); advisory only, STUDIO_TEST_PORTS=off hides it`,
  ];
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const argv = process.argv.slice(2);
  const json = argv.includes('--json');
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
  let dirs = argv.filter((a) => !a.startsWith('--'));
  if (!dirs.length) {
    const { gameFolder } = await import('./test-rng.mjs');
    const g = gameFolder(root);
    dirs = [g || '.'];
  }
  const f = fixedPortFindings(root, dirs);
  if (json) console.log(JSON.stringify({ dirs, findings: f }));
  else {
    for (const x of f) console.log(`${x.file}:${x.line} [TEST_PORT ${x.port}] ${x.text}`);
    console.log(f.length ? `[test-ports] ${f.length} fixed test port(s) with strictPort/reuseExistingServer (advisory): give each run a free port (studio/rules/test-ports.md)` : `[test-ports] ok: no fixed test port with strictPort in ${dirs.join(', ')}`);
  }
  process.exit(0);
}

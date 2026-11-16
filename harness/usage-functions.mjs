/**
 * harness/usage-functions.mjs — which harness functions a studio actually runs, so code nobody runs is found by
 * evidence and not by guess. harness/event.mjs starts it when the process is a harness/ or scripts/ command of a studio
 * (.studio exists): V8 counts function calls in this process (node:inspector, function level, no source or values),
 * and at exit the functions not yet on record are appended to .studio/usage/functions/<version>.tsv as
 * file <tab> start offset <tab> line <tab> name. A process that runs long also writes every
 * STUDIO_USAGE_FUNCTIONS_MIN minutes (10). STUDIO_USAGE_FUNCTIONS=off turns it off.
 * `npm run commands-run -- --functions` reads the record. A leaf: node built-ins only. It never throws.
 */
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';

const MAX_BYTES = 8 * 1024 * 1024;
const isOff = (v) => /^(off|0|false|no)$/i.test(String(v || ''));
let started = false;

export const functionsFile = (stateDir, version) => path.join(stateDir, 'usage', 'functions', `${String(version || '0').replace(/[^A-Za-z0-9._-]/g, '_')}.tsv`);

/** The record as rows: [{ file, offset, line, name }], one per function (a row written twice by two processes counts once). */
export function readFunctions(file) {
  const seen = new Set(); const rows = [];
  let text = ''; try { text = fs.readFileSync(file, 'utf8'); } catch { return rows; }
  for (const l of text.split('\n')) {
    const [f, o, line, name = ''] = l.split('\t');
    if (!f || !/^\d+$/.test(o || '') || seen.has(`${f}\t${o}`)) continue;
    seen.add(`${f}\t${o}`); rows.push({ file: f, offset: Number(o), line: Number(line) || 0, name });
  }
  return rows;
}

/**
 * Append the called functions of a coverage result (Profiler.takePreciseCoverage's `result`) that the record lacks.
 * Only files under root's harness/ and scripts/. Returns how many rows it added.
 */
export function recordFunctions(result, { root, stateDir, version }) {
  const file = functionsFile(stateDir, version);
  let size = 0; try { size = fs.statSync(file).size; } catch { size = 0; }
  if (size > MAX_BYTES) return 0;
  const have = new Set(readFunctions(file).map((r) => `${r.file}\t${r.offset}`));
  const base = `${pathToFileURL(root).href.replace(/\/$/, '')}/`;
  const out = [];
  for (const sc of result || []) {
    if (!String(sc.url || '').startsWith(base)) continue;
    let rel = ''; try { rel = decodeURIComponent(sc.url.slice(base.length).replace(/[?#].*$/, '')); } catch { continue; }
    if (!/^(harness|scripts)\/[^\t\n]+\.m?js$/.test(rel)) continue;
    let src = null;
    for (const f of sc.functions || []) {
      const r = f.ranges?.[0];
      if (!r || !r.count) continue;
      const key = `${rel}\t${r.startOffset}`;
      if (have.has(key)) continue;
      have.add(key);
      if (src === null) { try { src = fs.readFileSync(path.join(root, rel), 'utf8'); } catch { src = ''; } }
      let line = 1; for (let i = src.indexOf('\n'); i !== -1 && i < r.startOffset; i = src.indexOf('\n', i + 1)) line++;
      out.push(`${key}\t${line}\t${String(f.functionName || '').replace(/[\t\r\n]/g, ' ').slice(0, 80)}`);
    }
  }
  if (!out.length) return 0;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, `${out.join('\n')}\n`);
  return out.length;
}

/** Start the record for this process. True when it started; false when off, not a studio command, or not possible. */
export function startFunctionRecord({ argv = process.argv, root, stateDir, env = process.env } = {}) {
  try {
    if (started || isOff(env.STUDIO_USAGE_FUNCTIONS)) return false;
    const rel = argv[1] ? path.relative(root, path.resolve(argv[1])).split(path.sep).join('/') : '';
    if (!/^(harness|scripts)\/[A-Za-z0-9._-]+\.mjs$/.test(rel) || !fs.existsSync(stateDir)) return false;
    const require = createRequire(import.meta.url);
    if (!require('node:worker_threads').isMainThread) return false;
    const version = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
    const session = new (require('node:inspector').Session)();
    session.connect();
    session.post('Profiler.enable');
    session.post('Profiler.startPreciseCoverage', { callCount: false, detailed: false });
    const flush = () => {
      try { session.post('Profiler.takePreciseCoverage', (err, r) => { if (!err && r) { try { recordFunctions(r.result, { root, stateDir, version }); } catch { /* a record, never a crash */ } } }); } catch { /* the same */ }
    };
    process.on('exit', flush);
    const min = Number(env.STUDIO_USAGE_FUNCTIONS_MIN);
    setInterval(flush, (Number.isFinite(min) && min > 0 ? min : 10) * 60000).unref();
    started = true;
    return true;
  } catch { return false; }
}

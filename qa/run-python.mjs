#!/usr/bin/env node
/**
 * qa/run-python.mjs <script.py> [args…] — run a Python 3 script on any OS.
 *
 * Tries `python3`, `python`, then `py -3`, and keeps the first that really answers with a
 * Python 3 version (the Windows Store alias for python3 exits 9009 and is skipped).
 * STUDIO_PYTHON picks one explicitly.
 */
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export function findPython() {
  const tries = process.env.STUDIO_PYTHON ? [process.env.STUDIO_PYTHON.split(' ')] : [['python3'], ['python'], ['py', '-3']];
  for (const [cmd, ...pre] of tries) {
    const r = spawnSync(cmd, [...pre, '--version'], { encoding: 'utf8' });
    if (r.status === 0 && /Python 3\./.test(`${r.stdout}${r.stderr}`)) return { cmd, pre };
  }
  return null;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const py = findPython();
  if (!py) {
    console.error('[python] FAIL no Python 3 found (tried python3, python, py -3). Install it from https://www.python.org/downloads/ (on Windows tick "Add python.exe to PATH"), or set STUDIO_PYTHON.');
    process.exit(1);
  }
  const r = spawnSync(py.cmd, [...py.pre, ...process.argv.slice(2)], { stdio: 'inherit', env: { ...process.env, PYTHONIOENCODING: 'utf-8', PYTHONUTF8: '1' } });
  process.exit(r.status ?? 1);
}

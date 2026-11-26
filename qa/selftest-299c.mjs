/**
 * qa/selftest-299c.mjs — 2.99 (c): Play Mode focus for a mixed batch, and Play Mode time per fixture.
 * (1) paths that match play.focus.skip need no Play Mode: with the rest mapped, the stage is focus; one path no
 * entry takes sends it to full. (2) engines.<x>.play.times is read after a land run that ran the play stage.
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileUrlOf as fileUrlRelSOf, guardCap3000Of, out } from './kit.mjs';

export async function selftest299C({ dir, report, tmpRoot }) {
  const guard = guardCap3000Of(report);
  const T = path.join(tmpRoot, `s299c-${process.pid}`);
  fs.mkdirSync(T, { recursive: true });
  const clean = {};
  // Windows: the helpers below get a cut-down environment; PowerShell (used to read a process's start time and to list a
  // process tree) needs Windows' own system variables, which any real shell has. Pass those through as they are.
  if (process.platform === 'win32') for (const k of Object.keys(process.env)) if (/^(SystemRoot|windir|SystemDrive|ComSpec|PATHEXT|PATH|TEMP|TMP|USERPROFILE|APPDATA|LOCALAPPDATA|ProgramData|ALLUSERSPROFILE|PUBLIC|ProgramFiles|ProgramFiles\(x86\)|ProgramW6432|CommonProgramFiles|CommonProgramW6432|PSModulePath|PROCESSOR_ARCHITECTURE|NUMBER_OF_PROCESSORS|OS|COMPUTERNAME|HOMEDRIVE|HOMEPATH|USERNAME)$/i.test(k)) clean[k] = process.env[k];
  for (const k of Object.keys(process.env)) if (/^(CLAUDE|CODEX|CURSOR|AIDER|GEMINI|STUDIO_|AGENT_|AI_AGENT|ANTHROPIC|OPENAI)/i.test(k)) clean[k] = '';
  const u = fileUrlRelSOf(dir);
  let pn = 0;
  const probe = (code) => {
    const f = path.join(T, `probe-${++pn}.mjs`);
    fs.writeFileSync(f, code);
    const r = spawnSync(process.execPath, [f], { windowsHide: true, cwd: dir, env: { ...clean, NODE_OPTIONS: '' }, encoding: 'utf8', timeout: 240000 });
    const l = String(r.stdout || '').split('\n').filter((x) => x.startsWith('{')).pop();
    try { return JSON.parse(l); } catch { return { _raw: out(r).slice(-2500) }; }
  };

  try {
    // ---- (1) the decision ----
    const focus = { map: [{ match: '^Game/Ui/([A-Za-z]+)/', filter: 'Game.PlayTests.$1' }], smoke: 'Game.PlayTests.Smoke', skip: ['^Sim/'] };
    const sel = probe(`import { playSelection } from ${u('harness/engine-rules.mjs')};
const cfg = { play: { focus: ${JSON.stringify(focus)} } };
const sims = Array.from({ length: 30 }, (_, i) => 'Sim/Fees/F' + i + '.cs');
const ui = Array.from({ length: 12 }, (_, i) => 'Game/Ui/Hangar/P' + i + '.cs');
console.log(JSON.stringify({
  mixed: playSelection({ changed: [...sims, ...ui], cfg }),
  other: playSelection({ changed: [...sims, ...ui, 'Game/Scenes/Main.unity'], cfg }),
  allSkip: playSelection({ changed: sims, cfg }),
  full: playSelection({ changed: [...sims, ...ui], cfg, full: true, fullWhy: 'a full land run' }),
}));`);
    await guard('2.99 (c1) a mixed batch of skip paths and mapped paths runs focus: the mapped entries\' filters plus smoke, and the why line names both counts (fails before this fix: the skip paths counted as unmapped and the stage ran in full)', () => [
      sel.mixed?.mode === 'focus' && sel.mixed.filter === 'Game.PlayTests.Hangar;Game.PlayTests.Smoke' && /12 changed path\(s\) mapped by play\.focus, 30 more need no Play Mode \(play\.focus\.skip\)/.test(sel.mixed.why), JSON.stringify(sel.mixed || sel)]);
    await guard('2.99 (c2) one path that matches neither skip nor a map entry sends the stage to full, and the why line names that path alone (fails before this fix: the skip paths were named as unmapped too)', () => [
      sel.other?.mode === 'full' && sel.other.unmatched?.join() === 'Game/Scenes/Main.unity' && /1 changed path\(s\) match no play\.focus\.map entry: Game\/Scenes\/Main\.unity$/.test(sel.other.why), JSON.stringify(sel.other || sel)]);
    await guard('2.99 (c3) a batch where every path matches skip is still mode skip', () => [sel.allSkip?.mode === 'skip' && sel.allSkip.filter === '', JSON.stringify(sel.allSkip || sel)]);
    await guard('2.99 (c4) a full land run never focuses, even for a mixed batch', () => [sel.full?.mode === 'full' && sel.full.why === 'a full land run', JSON.stringify(sel.full || sel)]);
  } finally {
    try { fs.rmSync(T, { recursive: true, force: true, maxRetries: 8, retryDelay: 500 }); } catch { /* the sweep */ }
  }
}

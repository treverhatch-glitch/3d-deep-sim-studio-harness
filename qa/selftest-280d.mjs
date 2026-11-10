/**
 * qa/selftest-280d.mjs — 2.80 (d): small fixes from the crew's trials (aider start with no task, ask subcommands, BOM in
 * studio/game.json, landing build of an adopted game, board-only paths, dry-run status, godot-unit N/A, telemetry noise).
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export async function selftest280D({ dir, report, tmpRoot }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  const node = (args, { env = {}, cwd = dir, input } = {}) => {
    const r = spawnSync(process.execPath, args, { cwd, encoding: 'utf8', windowsHide: true, timeout: 120000, input, env: { ...process.env, ...env } });
    return { code: r.status, out: `${r.stdout || ''}${r.stderr || ''}`.replace(/\r\n/g, '\n') };
  };
  const probe = (code, env) => {
    const f = path.join(tmpRoot, `p280d-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
    fs.writeFileSync(f, code);
    const r = node([f], { env });
    try { fs.rmSync(f, { force: true }); } catch {}
    return r;
  };

  await guard('2.80 (d) #1: a builder on an aider-run tool (vertex, nim, aider) with no --task is refused before anything starts, saying to pass --task (fails on 2.79.2: the launch went ahead and aider ran with its whole repo map)', async () => {
    const src = (tool, task) => `import { startAgent } from ${JSON.stringify(u('harness/agent.mjs'))};
const r = startAgent({ role: 'builder', agent: 'builder-t280d', tool: ${JSON.stringify(tool)}, model: 'm'${task ? `, task: ${JSON.stringify(task)}` : ''} });
console.log('R ' + JSON.stringify({ ok: r.ok, message: r.message }));`;
    const rows = ['vertex', 'nim', 'aider'].map((t) => {
      const r = probe(src(t, null));
      const j = JSON.parse((r.out.split('\n').find((l) => l.startsWith('R ')) || 'R {}').slice(2));
      return { t, ok: j.ok, msg: j.message };
    });
    return [rows.every((x) => x.ok === false && /--task/.test(x.msg || '') && /no task/.test(x.msg || '')), JSON.stringify(rows)];
  });
}

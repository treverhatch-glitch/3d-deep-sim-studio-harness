/**
 * qa/selftest-2792b.mjs — 2.79.2 (b): STUDIO_VERTEX_SHARE=0 holds on every start path.
 *
 * The crew's PC, 2.79.1: the orchestrator set STUDIO_VERTEX_SHARE=0 and two more Vertex builders started 8 minutes later.
 * Two paths skipped the share: vertexPick returned Vertex whenever the plan's budget was high (before reading the share),
 * and the pool router kept a task that had started on Vertex there ("it keeps that model until it lands or fails"),
 * which the supervisor launched as is.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest2792B({ dir, report }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  const vx = await import(u('harness/vertex.mjs'));
  const mp = await import(u('harness/model-pools.mjs'));
  const ready = { ok: true, why: '' };

  await guard('2.79.2 (b): with STUDIO_VERTEX_SHARE=0 the supervisor\'s Vertex pick says no in every mode, also when the plan\'s budget is high; with a share it still picks (fails on 2.79.1: a high plan budget returned Vertex before the share was read)', () => {
    const off = { STUDIO_VERTEX_SHARE: '0' };
    const highOff = vx.vertexPick({ role: 'builder', taskId: 'T-1', live: [], cap: 6, high: true, env: off, events: [], ready });
    const lowOff = vx.vertexPick({ role: 'builder', taskId: 'T-1', live: [], cap: 6, high: false, env: off, events: [], ready });
    const highOn = vx.vertexPick({ role: 'builder', taskId: 'T-1', live: [], cap: 6, high: true, env: { STUDIO_VERTEX_SHARE: '0.5' }, events: [], ready });
    const lowOn = vx.vertexPick({ role: 'builder', taskId: 'T-1', live: [], cap: 6, high: false, env: { STUDIO_VERTEX_SHARE: '0.5' }, events: [], ready });
    return [Boolean(highOff.skip) && Boolean(lowOff.skip) && /STUDIO_VERTEX_SHARE=0/.test(highOff.skip) && highOn.tool === 'vertex' && lowOn.tool === 'vertex',
      JSON.stringify({ highOff, lowOff, highOn, lowOn })];
  });

  await guard('2.79.2 (b): the pool router doesn\'t keep a task on Vertex because it started there (the supervisor picks Vertex per start); a task that started on a Claude model still keeps it (fails on 2.79.1: "it keeps that model until it lands or fails" for Vertex too)', () => {
    const cfg = mp.readModels();
    const onVertex = mp.pickPool({ size: 'small', startedOn: { model: 'google/gemini-3-flash-preview', tool: 'vertex' } }, { cfg });
    const firstClaude = Object.values(cfg.pools || {}).map((p) => p?.model).find((m) => /claude|sonnet|opus/i.test(String(m || '')));
    const onClaude = firstClaude ? mp.pickPool({ size: 'small', startedOn: { model: firstClaude, tool: 'claude' } }, { cfg }) : null;
    return [!/keeps that model/.test(onVertex?.why || '') && onVertex?.tool !== 'vertex' && (!onClaude || /keeps that model/.test(onClaude.why || '')),
      JSON.stringify({ onVertex, onClaude, firstClaude })];
  });

  await guard('2.79.2 (b): the supervisor runs a route that keeps a task on Vertex through the same Vertex check as a new pick (share, budget cut, earlier failures) and starts it on the plan\'s tool when Vertex may not take it (fails on 2.79.1: the route\'s tool was launched as is)', () => {
    const sup = fs.readFileSync(path.join(dir, 'harness', 'supervisor.mjs'), 'utf8').replace(/\r\n/g, '\n');
    const at = sup.indexOf("if (lr.tool === 'vertex') {");
    const block = at >= 0 ? sup.slice(at, at + 900) : '';
    return [at >= 0 && /vertexPick\(/.test(block) && /lr\.tool = null; lr\.model = null;/.test(block) && at < sup.indexOf('const r = startAgent({ role: g.role, agent, tool: vx ?'),
      block.slice(0, 600) || 'no such block'];
  });
}

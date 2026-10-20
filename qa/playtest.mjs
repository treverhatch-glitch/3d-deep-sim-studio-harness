#!/usr/bin/env node
/**
 * qa/playtest.mjs — two-stage playtest for any cartridge.
 *
 *   node qa/playtest.mjs [--cartridge name] [--scenario start-to-win] [--seed 1337] [--ticks N]
 *                        [--stage 1|2] [--url http://127.0.0.1:5173/?playtest=1] [--out report.json]
 *
 * Stage 1 loads cartridges/<name> through harness/cartridge.mjs (its qa.mjs adapter when it has one)
 * and plays a scenario one tick at a time. It stops at the first tick that throws, freezes or breaks an
 * invariant and records THAT tick from the cartridge's own state, plus every action taken, so
 * `node harness/replay.mjs --trace` reproduces it. It also checks save/load and determinism.
 * Stage 2 opens the game in Playwright when a URL is serving: console errors, layout overflow, a screenshot.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { emitEvent, REPO_ROOT } from '../harness/event.mjs';
import { cartridgeFromArgv, groupActions, loadCartridge, replay } from '../harness/cartridge.mjs';

const REPORTS_DIR = path.join(REPO_ROOT, 'qa', 'reports');
const STAGE1 = 'Stage 1 (cartridge)';

/**
 * Stage 1: play the cartridge tick by tick and stop at the first real failure.
 */
export async function runStage1ProgrammaticQA({ seed = 1337, ticks, cartridge, scenario } = {}) {
  const startMs = Date.now();
  const cart = await loadCartridge(cartridge || cartridgeFromArgv([]));
  const scName = scenario || (cart.scenarios['start-to-win'] ? 'start-to-win' : null);
  const sc = scName ? cart.scenarios[scName] : null;
  if (scenario && !sc) throw new Error(`cartridge ${cart.name} has no scenario "${scenario}"`);
  const maxTicks = Number(ticks || sc?.maxTicks || 200);
  const scripted = groupActions(sc?.actions || []);
  const adapter = cart.createAdapter();
  const findings = [];
  const actions = [];
  const add = (f, tick) => findings.push({ stage: STAGE1, expected: 'no violation', actual: f.summary, ...f, tick });

  let state = adapter.init(seed);
  let outcome = null;
  let ticksRun = 0;
  const mid = Math.max(1, Math.floor(maxTicks / 2));
  for (let t = 1; t <= maxTicks; t++) {
    const acts = [...(scripted.get(t) || [])];
    if (typeof sc?.policy === 'function') {
      const extra = sc.policy(adapter.getState(), t);
      if (extra) acts.push(...(Array.isArray(extra) ? extra : [extra]));
    }
    for (const action of acts) actions.push({ tick: t, action });
    const before = adapter.getState().tick;
    try {
      state = adapter.step(1, acts.length ? acts : null);
    } catch (err) {
      add({ id: 'QA-STAGE1-STEP-THREW', severity: 'P0', summary: `step threw: ${String(err?.message || err)}` }, t);
      break;
    }
    ticksRun = t;
    if (!(state.tick > before) && !state.paused) {
      add({ id: 'QA-STAGE1-FROZEN-TICK', severity: 'P0', summary: `tick stayed at ${before} after step()` }, t);
      break;
    }
    const broken = adapter.invariants(state);
    if (broken.length) {
      for (const f of broken) add(f, state.tick ?? t);
      break;
    }
    if (t === mid) {
      const before = cart.sha256(adapter.getState());
      adapter.deserialize(adapter.serialize());
      const after = cart.sha256(adapter.getState());
      if (before !== after) {
        add({ id: 'QA-STAGE1-SERIALIZATION-DRIFT', severity: 'P0', summary: 'save/load changed the state hash', expected: before, actual: after }, state.tick ?? t);
        break;
      }
    }
    outcome = cart.outcome(state);
    if (outcome) break;
  }

  const finalHash = adapter.getHash();
  const finalSha256 = cart.sha256(adapter.getState());
  if (!findings.length) {
    const again = replay(cart, { seed, tick: ticksRun, actions });
    if (again.sha256 !== finalSha256) {
      add({ id: 'QA-STAGE1-NONDETERMINISTIC', severity: 'P0', summary: 'replaying the same seed and actions gave a different state (sha256)', expected: finalSha256, actual: again.sha256 }, ticksRun);
    }
    const expected = sc?.expect;
    if (expected && outcome && outcome !== expected) {
      add({ id: 'QA-STAGE1-UNEXPECTED-OUTCOME', severity: 'P1', summary: `scenario ${scName} ended "${outcome}"`, expected, actual: outcome }, ticksRun);
    }
    if (expected && !outcome && ticksRun >= (sc.maxTicks ?? Infinity)) {
      add({ id: 'QA-STAGE1-NO-OUTCOME', severity: 'P1', summary: `scenario ${scName} never ended in ${sc.maxTicks} ticks`, expected, actual: 'none' }, ticksRun);
    }
  }

  const failingTick = findings.length ? findings[0].tick ?? null : null;
  return {
    stage: 1,
    cartridge: cart.name,
    adapter: adapter.name,
    scenario: scName,
    seed,
    ticksRun,
    failingTick,
    tick: failingTick,
    outcome,
    finalHash,
    finalSha256,
    actions,
    durationMs: Date.now() - startMs,
    passed: findings.length === 0,
    findings,
  };
}

/**
 * Stage 2: Visual, Accessibility Tree & UISentinel Layout QA
 */
export async function runStage2VisualQA({ url = process.env.PLAYTEST_URL || 'http://127.0.0.1:5173/?playtest=1', runId } = {}) {
  const startMs = Date.now();
  const findings = [];
  let reachable = false;

  try {
    const probe = await fetch(url, { method: 'GET', signal: AbortSignal.timeout(1500) });
    reachable = probe.ok;
  } catch {
    reachable = false;
  }

  if (!reachable) {
    return {
      stage: 2,
      url,
      mode: 'offline-skipped',
      durationMs: Date.now() - startMs,
      passed: true,
      note: `Target URL (${url}) is not currently serving. Stage 2 live browser capture skipped cleanly; launch your cartridge or HUB server and re-run with --url.`,
      findings: [],
    };
  }

  let playwrightMod = null;
  try {
    playwrightMod = await import('playwright');
  } catch {
    return {
      stage: 2,
      url,
      mode: 'playwright-not-installed',
      durationMs: Date.now() - startMs,
      passed: true,
      note: 'Playwright package not installed yet (`npx playwright install chromium`).',
      findings: [],
    };
  }

  const browser = await playwrightMod.chromium.launch({ headless: true });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const consoleErrors = [];
    page.on('console', (msg) => {
      if (msg.type() === 'error') consoleErrors.push(msg.text());
    });
    page.on('pageerror', (err) => consoleErrors.push(String(err)));

    await page.goto(url, { waitUntil: 'networkidle', timeout: 15000 });

    // 1. Check `window.__sim` bridge if `?playtest=1` is active
    const hasWindowSim = await page.evaluate(() => typeof window.__sim === 'object' && window.__sim !== null);

    // 2. Capture Accessibility snapshot (`microsoft/playwright-mcp` pattern)
    let ariaTree = '';
    try {
      ariaTree = await page.locator('body').ariaSnapshot();
    } catch {
      ariaTree = 'ariaSnapshot unavailable';
    }

    // 3. Run UISentinel-style layout & horizontal overflow checks
    const layoutAudit = await page.evaluate(() => {
      const docWidth = document.documentElement.clientWidth;
      const scrollWidth = document.documentElement.scrollWidth;
      return {
        horizontalOverflowPx: Math.max(0, scrollWidth - docWidth),
        canvasCount: document.querySelectorAll('canvas, svg').length,
      };
    });

    if (layoutAudit.horizontalOverflowPx > 4) {
      findings.push({
        id: 'QA-STAGE2-LAYOUT-OVERFLOW',
        severity: 'P2',
        stage: 'Stage 2 (Visual / UISentinel)',
        summary: `Horizontal viewport overflow detected (${layoutAudit.horizontalOverflowPx}px)`,
        expected: 'scrollWidth <= clientWidth',
        actual: `${layoutAudit.horizontalOverflowPx}px overflow`,
      });
    }

    if (consoleErrors.length > 0) {
      findings.push({
        id: 'QA-STAGE2-CONSOLE-ERR',
        severity: 'P1',
        stage: 'Stage 2 (Visual / Console)',
        summary: `${consoleErrors.length} runtime console/page error(s) captured`,
        expected: '0 console errors',
        actual: consoleErrors.slice(0, 3).join(' | '),
      });
    }

    fs.mkdirSync(REPORTS_DIR, { recursive: true });
    const screenshotPath = path.join(REPORTS_DIR, `${runId}-stage2.png`);
    await page.screenshot({ path: screenshotPath, fullPage: false });

    return {
      stage: 2,
      url,
      mode: 'live-browser',
      hasWindowSim,
      layoutAudit,
      ariaPreview: ariaTree.slice(0, 500),
      screenshot: path.relative(REPO_ROOT, screenshotPath).replace(/\\/g, '/'),
      durationMs: Date.now() - startMs,
      passed: findings.length === 0,
      findings,
    };
  } finally {
    await browser.close();
  }
}

function formatMarkdownReport(report) {
  const allFindings = [
    ...(report.stage1?.findings || []),
    ...(report.stage2?.findings || []),
  ];

  const lines = [
    `# Two-Stage QA Playtest Report — \`${report.runId}\``,
    '',
    `- **Timestamp**: ${report.timestamp}`,
    `- **Overall Verdict**: **${report.passed ? 'PASS' : 'FAIL'}**`,
    `- **Stage 1 (Programmatic \`?playtest=1\` / Adapter)**: ${report.stage1 ? (report.stage1.passed ? 'PASS' : 'FAIL') : 'SKIPPED'}`,
    `- **Stage 2 (Visual Playwright + UISentinel)**: ${report.stage2 ? `${report.stage2.passed ? 'PASS' : 'FAIL'} (${report.stage2.mode})` : 'SKIPPED'}`,
    '',
    '## Stage 1 (cartridge)',
    report.stage1
      ? [
          `- **Cartridge**: \`${report.stage1.cartridge}\` (adapter \`${report.stage1.adapter}\`)`,
          `- **Scenario**: \`${report.stage1.scenario ?? 'none'}\` · **Seed**: \`${report.stage1.seed}\``,
          `- **Ticks run**: \`${report.stage1.ticksRun}\` · **Outcome**: \`${report.stage1.outcome ?? 'none'}\``,
          `- **Failing tick**: \`${report.stage1.failingTick ?? 'none'}\``,
          `- **State hash (display, FNV-1a 64)**: \`${report.stage1.finalHash}\``,
          `- **State SHA-256 (verification)**: \`${report.stage1.finalSha256}\``,
          `- **Replay**: \`node harness/replay.mjs --trace .studio/last-seed-failure.json\` after a closed-loop failure`,
          `- **Duration**: \`${report.stage1.durationMs}ms\``,
        ].join('\n')
      : '_Stage 1 not run._',
    '',
    '## Stage 2 Telemetry (Playwright Accessibility + UISentinel Layout)',
    report.stage2
      ? [
          `- **Target URL**: \`${report.stage2.url}\``,
          `- **Mode**: \`${report.stage2.mode}\``,
          ...(report.stage2.note ? [`- **Note**: ${report.stage2.note}`] : []),
          ...(report.stage2.screenshot ? [`- **Screenshot**: \`${report.stage2.screenshot}\``] : []),
        ].join('\n')
      : '_Stage 2 not run._',
    '',
    `## Structured Findings (${allFindings.length})`,
  ];

  if (allFindings.length === 0) {
    lines.push('', 'No P0/P1/P2 regressions detected. Determinism, serialization, and tick invariants held.');
  } else {
    for (const f of allFindings) {
      lines.push(
        '',
        `### [${f.severity}] ${f.id} — ${f.summary}`,
        `- **Stage**: ${f.stage}`,
        `- **Expected**: \`${f.expected}\``,
        `- **Actual**: \`${f.actual}\``
      );
    }
  }

  return lines.join('\n') + '\n';
}

function parseCli(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const k = a.slice(2);
      const next = argv[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        out[k] = next;
        i++;
      } else {
        out[k] = true;
      }
    }
  }
  return out;
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  const args = parseCli(process.argv.slice(2));
  const stageFilter = args.stage ? Number(args.stage) : 0; // 0 = both stages
  const seed = Number(args.seed || 1337);
  const runId = `qa_${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}_${seed}`;

  emitEvent({ type: 'qa.start', agent: 'qa-playtester', msg: `Starting playtest ${runId}` });

  let stage1 = null;
  if (stageFilter !== 2) {
    try {
      stage1 = await runStage1ProgrammaticQA({ seed, ticks: args.ticks ? Number(args.ticks) : undefined, cartridge: args.cartridge, scenario: args.scenario });
    } catch (err) {
      stage1 = { stage: 1, passed: false, seed, failingTick: null, actions: [], findings: [{ id: 'QA-STAGE1-LOAD', severity: 'P0', stage: STAGE1, summary: String(err?.message || err), expected: 'cartridge loads', actual: 'error' }] };
    }
  }
  const stage2 = stageFilter === 1 ? null : await runStage2VisualQA({ url: args.url, runId });

  const passed = (stage1 ? stage1.passed : true) && (stage2 ? stage2.passed : true);
  const report = { runId, timestamp: new Date().toISOString(), passed, stage1, stage2 };

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const jsonFile = path.join(REPORTS_DIR, `${runId}.json`);
  const mdFile = path.join(REPORTS_DIR, `${runId}.md`);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdFile, formatMarkdownReport(report), 'utf8');
  if (args.out && args.out !== true) {
    fs.mkdirSync(path.dirname(path.resolve(REPO_ROOT, args.out)), { recursive: true });
    fs.writeFileSync(path.resolve(REPO_ROOT, args.out), JSON.stringify(report, null, 2), 'utf8');
  }

  emitEvent({
    type: passed ? 'qa.pass' : 'qa.bug',
    agent: 'qa-playtester',
    status: passed ? 'ok' : 'error',
    msg: `QA ${runId} ${passed ? 'PASSED' : `FAILED at tick ${stage1?.failingTick ?? '?'}`} (${stage1?.cartridge || 'n/a'}, hash=${stage1?.finalHash || 'n/a'}, report=${path.relative(REPO_ROOT, mdFile).replace(/\\/g, '/')})`,
  });

  if (args.quiet) console.log(`[playtest] ${passed ? 'PASS' : 'FAIL'} ${path.relative(REPO_ROOT, mdFile)}`);
  else console.log(JSON.stringify(report, null, 2));
  process.exit(passed ? 0 : 1);
}

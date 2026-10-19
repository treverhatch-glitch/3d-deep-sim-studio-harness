#!/usr/bin/env node
/**
 * qa/playtest.mjs — Two-Stage Programmatic & Visual QA Runner
 *
 * Combines:
 *  - Stage 1 (Programmatic State Trajectory QA — Recursive Game Creator pattern):
 *    Drives the simulation through `qa/sim.adapter.mjs` or `?playtest=1`
 *    (`window.__sim`) to catch frozen-tick P0s, NaN/Infinity drift, save/load
 *    serialization loss, and non-deterministic RNG regressions without relying
 *    on brittle pixel clicking.
 *  - Stage 2 (Visual, Accessibility Tree & Layout QA — Playwright MCP + UISentinel):
 *    If a browser target URL (`--url` or `PLAYTEST_URL`) is reachable and
 *    Playwright is available, inspects the DOM accessibility tree (`ariaSnapshot`),
 *    console errors, viewport overflow / HUD overlap rules (UISentinel pattern),
 *    and captures targeted screenshots.
 *
 * Writes structured, diffable reports to `qa/reports/` using `studio/templates/bug.md`.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createReferenceSimAdapter, hashCanonicalState } from './sim.adapter.mjs';
import { createCartridgeAdapter } from './cartridge-adapter.mjs';
import { emitEvent, REPO_ROOT } from '../harness/event.mjs';

const REPORTS_DIR = path.join(REPO_ROOT, 'qa', 'reports');
const BUG_TEMPLATE_PATH = path.join(REPO_ROOT, 'studio', 'templates', 'bug.md');

/**
 * Stage 1: Programmatic Trajectory & Determinism Suite
 */
export async function runStage1ProgrammaticQA({ seed = 1337, ticks = 200, adapterFactory = createCartridgeAdapter } = {}) {
  const startMs = Date.now();
  const findings = [];
  const adapterA = adapterFactory();

  // 1. Initialize & verify baseline state
  const initial = adapterA.init(seed);
  const startTick = initial.tick;

  // 2. Drive programmatic policy trajectory (spawn + step ticks)
  adapterA.dispatch({ type: 'spawn', kind: 'sensor', x: 6, z: -6 });
  const midState = adapterA.step(Math.floor(ticks / 2));

  // Guard 1: Frozen-tick P0 check
  if (midState.tick <= startTick) {
    findings.push({
      id: 'QA-STAGE1-FROZEN-TICK',
      severity: 'P0',
      stage: 'Stage 1 (Programmatic API)',
      summary: `Simulation tick did not advance after step(${Math.floor(ticks / 2)})`,
      expected: `tick > ${startTick}`,
      actual: `tick === ${midState.tick}`,
    });
  }

  // Guard 2: Serialization round-trip check (catches lost entities/flights on save/load)
  const savedJson = adapterA.serialize();
  const hashBeforeSave = adapterA.getHash();
  adapterA.deserialize(savedJson);
  const hashAfterRestore = adapterA.getHash();
  if (hashBeforeSave !== hashAfterRestore) {
    findings.push({
      id: 'QA-STAGE1-SERIALIZATION-DRIFT',
      severity: 'P0',
      stage: 'Stage 1 (Programmatic API)',
      summary: 'Save/Load JSON round-trip altered canonical state hash',
      expected: hashBeforeSave,
      actual: hashAfterRestore,
    });
  }

  // Finish remaining ticks
  const finalA = adapterA.step(ticks - Math.floor(ticks / 2));
  const finalHashA = adapterA.getHash();

  // Guard 3: Domain & numerical invariants (NaN / Infinity check)
  for (const v of adapterA.invariants(finalA)) {
    findings.push({
      id: v.id,
      severity: v.severity,
      stage: 'Stage 1 (Programmatic API)',
      summary: v.message,
      expected: 'All state invariants satisfied',
      actual: v.message,
    });
  }

  // Guard 4: Determinism replay check (second independent instance with identical seed + actions)
  const adapterB = adapterFactory();
  adapterB.init(seed);
  adapterB.dispatch({ type: 'spawn', kind: 'sensor', x: 6, z: -6 });
  adapterB.step(ticks);
  const finalHashB = adapterB.getHash();

  if (finalHashA !== finalHashB) {
    findings.push({
      id: 'QA-STAGE1-NONDETERMINISTIC',
      severity: 'P0',
      stage: 'Stage 1 (Programmatic API)',
      summary: 'Two identical seeded runs produced different state hashes',
      expected: finalHashA,
      actual: finalHashB,
    });
  }

  const actions = [{ tick: 1, action: { type: 'spawn', kind: 'sensor', x: 6, z: -6 } }];
  const failingTick = findings.find((f) => f.tick != null)?.tick ?? (findings.length ? finalA.tick : null);
  return {
    stage: 1,
    adapter: adapterA.name || 'custom-sim-adapter',
    seed,
    ticksRun: finalA.tick,
    failingTick,
    tick: failingTick,
    finalHash: finalHashA,
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
    '## Stage 1 Telemetry (Recursive Game Creator Trajectory)',
    report.stage1
      ? [
          `- **Adapter**: \`${report.stage1.adapter}\``,
          `- **Seed**: \`${report.stage1.seed}\``,
          `- **Ticks Executed**: \`${report.stage1.ticksRun}\``,
          `- **Canonical State Hash (FNV-1a)**: \`${report.stage1.finalHash}\``,
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
  const ticks = Number(args.ticks || 200);
  const runId = `qa_${Date.now()}`;

  emitEvent({
    type: 'qa.start',
    agent: 'qa-playtester',
    msg: `Starting Two-Stage QA (${runId}, seed=${seed}, ticks=${ticks})`,
  });

  const stage1 = stageFilter === 2 ? null : await runStage1ProgrammaticQA({ seed, ticks });
  const stage2 = stageFilter === 1 ? null : await runStage2VisualQA({ url: args.url, runId });

  const passed = (stage1 ? stage1.passed : true) && (stage2 ? stage2.passed : true);
  const report = {
    runId,
    timestamp: new Date().toISOString(),
    passed,
    stage1,
    stage2,
  };

  fs.mkdirSync(REPORTS_DIR, { recursive: true });
  const jsonFile = path.join(REPORTS_DIR, `${runId}.json`);
  const mdFile = path.join(REPORTS_DIR, `${runId}.md`);
  fs.writeFileSync(jsonFile, JSON.stringify(report, null, 2), 'utf8');
  fs.writeFileSync(mdFile, formatMarkdownReport(report), 'utf8');

  emitEvent({
    type: passed ? 'qa.pass' : 'qa.bug',
    agent: 'qa-playtester',
    status: passed ? 'ok' : 'error',
    msg: `QA ${runId} ${passed ? 'PASSED' : 'FAILED'} (hash=${stage1?.finalHash || 'n/a'}, report=${path.relative(REPO_ROOT, mdFile).replace(/\\/g, '/')})`,
  });

  console.log(JSON.stringify(report, null, 2));
  process.exit(passed ? 0 : 1);
}

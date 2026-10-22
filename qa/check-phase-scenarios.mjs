#!/usr/bin/env node
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { REPO_ROOT } from '../harness/event.mjs';

async function main() {
  const phaseArg = process.argv.indexOf('--phase');
  if (phaseArg === -1 || !process.argv[phaseArg + 1]) {
    console.error('Usage: node qa/check-phase-scenarios.mjs --phase <n>');
    process.exit(1);
  }
  const phase = process.argv[phaseArg + 1];
  const scenarioDir = path.join(REPO_ROOT, 'qa', 'scenarios', `phase-${phase}`);

  if (!fs.existsSync(scenarioDir)) {
    console.log(`No scenarios found for phase ${phase}, passing.`);
    process.exit(0);
  }

  const files = fs.readdirSync(scenarioDir).filter(f => f.endsWith('.mjs'));
  if (!files.length) {
    console.log(`No scenarios found in ${scenarioDir}, passing.`);
    process.exit(0);
  }

  let failed = false;
  const timeoutMs = Number(process.env.STUDIO_SCENARIO_TIMEOUT_MS || 60000);
  for (const file of files) {
    const scenarioPath = path.join(scenarioDir, file);
    try {
      const { default: runScenario } = await import(pathToFileURL(scenarioPath).toString());
      const result = await Promise.race([
        runScenario(),
        new Promise((_, reject) => setTimeout(() => reject(new Error(`timed out after ${timeoutMs} ms`)), timeoutMs))
      ]);
      if (!result.ok) {
        console.error(`FAIL: ${file} - ${result.why}`);
        failed = true;
      } else {
        console.log(`PASS: ${file}`);
      }
    } catch (e) {
      console.error(`ERROR running ${file}: ${e.message}`);
      failed = true;
    }
  }

  if (failed) {
    console.error(`\nPhase ${phase} scenario checks failed.`);
    process.exit(1);
  }

  console.log(`\nPhase ${phase} scenario checks passed.`);
  process.exit(0);
}

main();

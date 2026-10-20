#!/usr/bin/env node
/**
 * scripts/fun-check.mjs — cheap fun proxies from real scenario runs. A person still decides if it is fun.
 *
 *   node scripts/fun-check.mjs [--cartridge name] [--write]
 *
 * Fails when the slice cannot be won, or when doing nothing wins as fast as playing (choices do not matter).
 * --write saves the report to studio/fun/latest.md.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { cartridgeFromArgv, loadCartridge, runScenario } from '../harness/cartridge.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cart = await loadCartridge(cartridgeFromArgv());
const slice = cart.scenarios['start-to-win'];
if (!slice) {
  console.error(`[fun] FAIL ${cart.name} has no scenarios['start-to-win'] in qa.mjs`);
  process.exit(1);
}
const seeds = [1, 7, 42, 1337, 2024, 9001];
const played = seeds.map((seed) => runScenario(cart, 'start-to-win', { seed }));
const idleSpec = cart.scenarios.idle || { seed: slice.seed, maxTicks: slice.maxTicks };
const idle = seeds.map((seed) => runScenario(cart, idleSpec, { seed }));

const wins = played.filter((r) => r.outcome === 'won');
const idleWins = idle.filter((r) => r.outcome === 'won');
const avg = (xs) => (xs.length ? Math.round(xs.reduce((a, b) => a + b, 0) / xs.length) : null);
const playTicks = avg(wins.map((r) => r.ticksRun));
const idleTicks = avg(idleWins.map((r) => r.ticksRun));
const longestGap = Math.max(
  ...played.map((r) => {
    const ticks = [0, ...new Set(r.actions.map((a) => a.tick)), r.ticksRun];
    return Math.max(...ticks.slice(1).map((t, i) => t - ticks[i]));
  })
);
const choicesMatter = idleWins.length < wins.length || (idleTicks !== null && playTicks !== null && idleTicks >= playTicks * 1.25);

// Through the players in studio/personas/: each known lens reads the same runs from that player's side.
const best = wins.length ? Math.min(...wins.map((r) => r.ticksRun)) : null;
const kinds = new Set(played.flatMap((r) => r.actions.map((a) => a.action?.type || a.action?.kind || 'action')));
const idleLost = idle.filter((r) => r.outcome === 'lost');
const LENSES = {
  'first-timer': () => (playTicks === null ? 'never reaches a first win.' : `first win after about ${playTicks} ticks; the longest stretch with nothing to do is ${longestGap} ticks${playTicks && longestGap > playTicks * 0.25 ? ', long enough to feel stuck' : ''}.`),
  'calm-player': () => (idleLost.length ? `doing nothing loses on ${idleLost.length}/${seeds.length} seeds${avg(idleLost.map((r) => r.ticksRun)) ? ` after about ${avg(idleLost.map((r) => r.ticksRun))} ticks` : ''}: check that the pressure feels fair, not rushed.` : 'never punished for waiting.'),
  'min-maxer': () => (best === null ? 'nothing to optimise yet.' : `best run ${best} ticks against an average of ${playTicks}${best >= playTicks * 0.95 ? ': little room to play better than average' : ''}${choicesMatter ? '' : '; idling wins, so choices feel pointless'}.`),
  explorer: () => `${kinds.size} kind(s) of action in the slice${kinds.size <= 2 ? ': little to discover yet' : ''}.`,
};
const personaDir = path.join(root, 'studio', 'personas');
const personas = fs.existsSync(personaDir) ? fs.readdirSync(personaDir).filter((f) => f.endsWith('.md') && f !== 'README.md').map((f) => {
  const t = fs.readFileSync(path.join(personaDir, f), 'utf8');
  return { name: (t.match(/^# (.+)$/m) || [, f])[1], lens: (t.match(/^lens:\s*(\S+)/m) || [])[1] };
}) : [];

const report = [
  `# Fun proxy report: ${cart.name}`,
  '',
  `- slice wins: ${wins.length}/${seeds.length} seeds, average ${playTicks ?? '–'} ticks`,
  `- doing nothing wins: ${idleWins.length}/${seeds.length} seeds${idleTicks ? `, average ${idleTicks} ticks` : ''}`,
  `- choices matter: ${choicesMatter ? 'yes' : 'NO — idling does as well as playing'}`,
  `- longest stretch with no player action: ${longestGap} ticks`,
  `- actions per 100 ticks: ${avg(played.map((r) => (100 * r.actions.length) / Math.max(1, r.ticksRun)))}`,
  '- human-review: required',
  ...(personas.length ? ['', '## Through the personas (studio/personas/)', ...personas.map((p) => `- ${p.name}: ${LENSES[p.lens] ? LENSES[p.lens]() : 'no script lens; judge by hand.'}`)] : []),
  '',
  'Proxies only. A person signs the slice in studio/fun/review-YYYY-MM-DD.md.',
  '',
].join('\n');
console.log(report);
if (process.argv.includes('--write')) fs.writeFileSync(path.join(root, 'studio', 'fun', 'latest.md'), report);
if (wins.length === 0) {
  console.error('[fun] FAIL the slice is never won');
  process.exit(1);
}
if (!choicesMatter) {
  console.error('[fun] FAIL doing nothing wins as fast as playing');
  process.exit(1);
}
console.log('[fun] PASS');

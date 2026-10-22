#!/usr/bin/env node
/**
 * qa/vision-check.mjs — F15 vision check.
 *
 * Compares screenshots from a task's proof against the game's art reference using a vision model.
 *
 *   node qa/vision-check.mjs <task> [--on] [--min <score>]
 *   node qa/vision-check.mjs --shot <file> [--on] [--min <score>]
 *
 * Opt-in: does nothing unless STUDIO_VISION=1 or --on is set.
 * Reads the screenshot from a task's proof file (studio/proof/<task>.json) or --shot <file>.
 * Reads the art reference from the bible (artReference.file) or studio/art/references.json.
 * Calls an OpenAI-compatible vision model to get a score and reasons.
 * Advisory by default (always exit 0); --min <score> makes it exit 1 below that score or when it can't check.
 * Without a task it checks the newest studio/proof/<task>.json (that's how the optional gate runs it).
 * A fake score can be injected with STUDIO_VISION_FAKE=<score> for testing.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { REPO_ROOT, emitEvent } from '../harness/event.mjs';
import { readProof } from '../harness/proof.mjs';

const REPORT_DIR = path.join(REPO_ROOT, 'qa', 'reports');

function parseArgs() {
  const argv = process.argv.slice(2);
  const task = argv.find((a) => /^T-\d+$/.test(a));
  const on = argv.includes('--on') || process.env.STUDIO_VISION === '1';
  const opt = (k) => {
    const i = argv.indexOf(`--${k}`);
    return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[i + 1] : '';
  };
  return { task, shot: opt('shot'), on, minScore: Number(opt('min') || 0) };
}

function findShots(taskArg, shotArg) {
  let task = taskArg;
  if (shotArg) {
    const p = path.resolve(REPO_ROOT, shotArg);
    if (!fs.existsSync(p)) return { error: `Screenshot not found: ${shotArg}` };
    return { shots: [{ file: path.relative(REPO_ROOT, p) }] };
  }
  if (!task) {
    // As a gate: the newest proof file.
    const dir = path.join(REPO_ROOT, 'studio', 'proof');
    const files = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => /^T-\d+\.json$/.test(f)).map((f) => [f, fs.statSync(path.join(dir, f)).mtimeMs]).sort((a, b) => b[1] - a[1]) : [];
    if (files.length) task = files[0][0].replace(/\.json$/, '');
  }
  if (task) {
    const proof = readProof(task);
    if (!proof.shots.length) return { error: `No screenshots found in proof for ${task}` };
    return { shots: proof.shots, task };
  }
  return { error: 'No task ID or --shot <file> provided.' };
}

function findReferences() {
  const refs = [];
  try {
    const bible = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'bible', 'bible.json'), 'utf8'));
    if (bible.artReference?.file) refs.push({ file: bible.artReference.file, source: 'bible.json' });
  } catch {}
  try {
    const artRefs = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'studio', 'art', 'references.json'), 'utf8'));
    for (const r of artRefs.references || []) if (r.kind === 'look' && r.image !== false && r.file) refs.push({ file: r.file, label: r.label, source: 'references.json' });
  } catch {}
  if (!refs.length) return { error: 'No art reference found in studio/bible/bible.json or studio/art/references.json' };
  return { refs };
}

function toBase64(file) {
  try {
    const fullPath = path.resolve(REPO_ROOT, file);
    if (!fs.existsSync(fullPath)) return { error: `File not found: ${file}` };
    const data = fs.readFileSync(fullPath);
    const mime = { '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.webp': 'image/webp' }[path.extname(file).toLowerCase()];
    if (!mime) return { error: `Unsupported image type: ${file}` };
    return { url: `data:${mime};base64,${data.toString('base64')}` };
  } catch (e) {
    return { error: `Could not read file ${file}: ${e.message}` };
  }
}

async function callVisionModel(shotB64, refB64, { url, model, key }) {
  const prompt = 'You are a visual QA inspector for a video game. Compare the screenshot against the art reference. The screenshot must match the style, mood, and key elements of the reference. Score from 0 to 100 how well it matches. 100 is a perfect match. Below 70 is a poor match. Provide your reasoning as two lists of strings: "matches" for what matches, and "differs" for what differs. Output only a single JSON object with keys "score", "matches", and "differs".';
  const body = {
    model,
    messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: shotB64 }, { type: 'image_url', image_url: refB64 }] }],
    max_tokens: 1024,
    response_format: { type: 'json_object' },
  };
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  const json = await res.json();
  const content = JSON.parse(json.choices[0].message.content);
  return { ...content, tokensIn: json.usage?.prompt_tokens || 0, tokensOut: json.usage?.completion_tokens || 0 };
}

async function main() {
  let { task, shot, on, minScore } = parseArgs();
  if (!on) {
    console.log('[vision] off (run with --on or STUDIO_VISION=1)');
    return;
  }

  // Advisory unless --min is given: missing inputs or an unset model are reported, not failed.
  const blocking = minScore > 0;
  const stop = (msg) => {
    console.log(`[vision] ${blocking ? 'FAIL' : 'SKIP'} ${msg}`);
    process.exit(blocking ? 1 : 0);
  };
  const found = findShots(task, shot);
  if (found.error) stop(found.error);
  const { shots } = found;
  task = found.task || task;
  const { refs, error: refsError } = findReferences();
  if (refsError) stop(refsError);
  if (!process.env.STUDIO_VISION_FAKE && !(process.env.STUDIO_VISION_URL && process.env.STUDIO_VISION_MODEL)) stop('no vision model set: STUDIO_VISION_URL (OpenAI-compatible chat endpoint), STUDIO_VISION_MODEL and STUDIO_VISION_KEY in .env');

  const results = [];
  let totalScore = 0;
  let checks = 0;
  let overallPassed = true;

  for (const s of shots) {
    for (const r of refs) {
      console.log(`[vision] Checking ${s.file} against ${r.file}...`);
      checks++;
      let result;

      if (process.env.STUDIO_VISION_FAKE) {
        const score = Number(process.env.STUDIO_VISION_FAKE);
        result = { score, matches: ['fake match'], differs: ['fake difference'], tokensIn: 0, tokensOut: 0 };
        console.log(`[vision] FAKE score: ${score}`);
      } else {
        const shotB64 = toBase64(s.file);
        if (shotB64.error) {
          console.error(`[vision] FAIL: ${shotB64.error}`);
          overallPassed = false;
          continue;
        }
        const refB64 = toBase64(r.file);
        if (refB64.error) {
          console.error(`[vision] FAIL: ${refB64.error}`);
          overallPassed = false;
          continue;
        }
        try {
          result = await callVisionModel(shotB64, refB64, {
            url: process.env.STUDIO_VISION_URL,
            model: process.env.STUDIO_VISION_MODEL,
            key: process.env.STUDIO_VISION_KEY,
          });
          emitEvent({ type: 'qa.vision', agent: process.env.STUDIO_LOCK_OWNER || 'vision-check', task, model: process.env.STUDIO_VISION_MODEL, status: 'info', tokensIn: result.tokensIn, tokensOut: result.tokensOut, msg: `Vision check of ${s.file} against ${r.file}: score ${result.score}`, meta: { provider: 'vision' } });
        } catch (e) {
          console.error(`[vision] FAIL: API call failed: ${e.message}`);
          overallPassed = false;
          continue;
        }
      }

      console.log(`  Score: ${result.score}`);
      if (result.matches?.length) console.log('  Matches:\n' + result.matches.map((m) => `    - ${m}`).join('\n'));
      if (result.differs?.length) console.log('  Differs:\n' + result.differs.map((d) => `    - ${d}`).join('\n'));
      totalScore += result.score;
      results.push({ shot: s.file, ref: r.file, ...result });

      if (minScore > 0 && result.score < minScore) {
        console.log(`[vision] FAIL: score ${result.score} < ${minScore}`);
        overallPassed = false;
      } else if (minScore > 0) {
        console.log(`[vision] PASS: score ${result.score} >= ${minScore}`);
      }
    }
  }

  if (checks === 0) {
    console.error('[vision] FAIL: No checks were performed.');
    process.exit(1);
  }

  const avgScore = totalScore / checks;
  console.log(`\n[vision] Average score: ${avgScore.toFixed(2)} over ${checks} checks.`);

  const report = { at: new Date().toISOString(), task, shot, minScore, avgScore, results };
  fs.mkdirSync(REPORT_DIR, { recursive: true });
  const reportFile = path.join(REPORT_DIR, `vision-${task || 'adhoc'}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`[vision] Report written to ${path.relative(REPO_ROOT, reportFile)}`);

  if (!overallPassed && blocking) process.exit(1);
  if (!overallPassed) console.log('[vision] advisory: some checks could not run or scored low (pass --min <score> to make it block)');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}

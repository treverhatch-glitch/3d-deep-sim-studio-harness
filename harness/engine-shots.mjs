#!/usr/bin/env node
/**
 * harness/engine-shots.mjs — 2.79 (e): before/after pictures for an engine land.
 *
 * An engine config (studio/game.json engines.<x>) may declare "shots": "<folder of PNGs the engine's play-mode tests
 * write>" (relative to the land command's folder, or absolute). When a land run is green:
 *   - the new shots are copied to studio/proof/<task>/engine-after/ and the previous green land's shots (kept in
 *     .studio/engine-shots/<engine>/last/) to studio/proof/<task>/engine-before/;
 *   - a side-by-side page, qa/reports/engine-compare/<task>.html (before | after per file name), is written;
 *   - .studio/engine-shots/<engine>/last/ becomes the new shots (the next land's "before");
 *   - one Studio Status line with the page path is queued through the Communicator (harness/communicator.mjs queueNotice).
 * No shots folder, or no PNG in it: nothing happens.
 */
import fs from 'node:fs';
import path from 'node:path';

const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const url = (rel) => rel.split('/').map(encodeURIComponent).join('/');

/** Every .png under dir, as forward-slash paths relative to it, sorted. [] when dir is missing. */
export function listShots(dir) {
  const out = [];
  const walk = (d, pre) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents) {
      if (e.isDirectory()) walk(path.join(d, e.name), `${pre}${e.name}/`);
      else if (e.isFile() && /\.png$/i.test(e.name)) out.push(`${pre}${e.name}`);
    }
  };
  if (dir) walk(dir, '');
  return out.sort();
}

const copyShots = (from, to, names) => {
  fs.rmSync(to, { recursive: true, force: true });
  for (const n of names) { fs.mkdirSync(path.dirname(path.join(to, n)), { recursive: true }); fs.copyFileSync(path.join(from, n), path.join(to, n)); }
};

/** The side-by-side page: one row per file name, before | after. */
export function comparePage({ task, engine, before, after }) {
  const names = [...new Set([...before, ...after])].sort();
  const cell = (has, dir, n) => (has ? `<a href="${url(`${dir}/${n}`)}"><img src="${url(`${dir}/${n}`)}" alt="${esc(n)}" style="max-width:100%"></a>` : '<em>(none)</em>');
  const rel = `../../../studio/proof/${task}`;
  const rows = names.map((n) => `<tr><th colspan="2" style="text-align:left">${esc(n)}</th></tr>\n<tr><td style="width:50%;vertical-align:top">${cell(before.includes(n), `${rel}/engine-before`, n)}</td><td style="width:50%;vertical-align:top">${cell(after.includes(n), `${rel}/engine-after`, n)}</td></tr>`).join('\n');
  return `<!doctype html>\n<meta charset="utf-8">\n<title>${esc(task)} ${esc(engine)} before | after</title>\n<h1>${esc(task)}: ${esc(engine)} before | after</h1>\n<table style="width:100%;border-collapse:collapse" border="1">\n<tr><th>before (the previous green land)</th><th>after (this land)</th></tr>\n${rows}\n</table>\n`;
}

/**
 * After a green land of `tasks`: the shots folder `shotsDir` -> proof folders, the page, the kept "last" and one notice.
 * { pages: [rel paths], files, before, after } or null (no shots: nothing happens). deps.notice({ key, text, root }).
 */
export async function recordEngineShots({ root, engine, tasks, shotsDir, deps = {} }) {
  if (!shotsDir || !tasks?.length) return null;
  const after = listShots(shotsDir);
  if (!after.length) return null;
  const lastDir = path.join(root, '.studio', 'engine-shots', engine, 'last');
  const before = listShots(lastDir);
  const pages = [];
  for (const task of tasks) {
    if (!/^[A-Za-z0-9._-]+$/.test(task)) continue;
    const proof = path.join(root, 'studio', 'proof', task);
    copyShots(shotsDir, path.join(proof, 'engine-after'), after);
    copyShots(lastDir, path.join(proof, 'engine-before'), before);
    const page = path.join(root, 'qa', 'reports', 'engine-compare', `${task}.html`);
    fs.mkdirSync(path.dirname(page), { recursive: true });
    fs.writeFileSync(page, comparePage({ task, engine, before, after }));
    pages.push(path.relative(root, page).split(path.sep).join('/'));
  }
  // The new "last": copied beside it first, so a failure never leaves the folder half replaced.
  const tmp = `${lastDir}.new-${process.pid}`;
  copyShots(shotsDir, tmp, after);
  fs.rmSync(lastDir, { recursive: true, force: true });
  fs.renameSync(tmp, lastDir);
  if (pages.length) {
    const text = `${engine} land (${tasks.join(', ')}): ${after.length} shot(s), ${before.length ? `compared with the previous land's ${before.length}` : 'no earlier shots to compare'}: ${pages.join(', ')}`;
    try { await (deps.notice || defaultNotice)({ key: `engine-shots:${engine}:${tasks.join(',')}:${Date.now()}`, text, root }); } catch {}
  }
  return { pages, before, after };
}

function defaultNotice(a) { return import('./communicator.mjs').then((m) => m.queueNotice({ ...a, kind: 'engine-shots' })).catch(() => {}); }

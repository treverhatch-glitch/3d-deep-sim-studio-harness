/**
 * harness/divisions.mjs — the studio's departments: which exist, which are on, which roles they hire.
 * studio/divisions.json (written by npm run division or the War Room) overrides the defaults below.
 * Kept apart from the HUD so the launcher can open a division without an import cycle.
 */
import fs from 'node:fs';
import path from 'node:path';
import { REPO_ROOT, emitEvent } from './event.mjs';

const readJson = (rel, fallback = null) => {
  try {
    return JSON.parse(fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8'));
  } catch {
    return fallback;
  }
};

// Core divisions and Art are on; the rest ship switched off. studio/divisions.json overrides this list.
export const DEFAULT_DIVISIONS = [
  { id: 'production', name: 'Producer', roles: ['producer'], core: true },
  { id: 'engineering', name: 'Engineering', roles: ['builder'], core: true },
  { id: 'qa', name: 'QA Lab', roles: ['qa-playtester'], core: true },
  { id: 'design', name: 'Design & Balance', roles: ['rnd', 'designer-calibrator', 'planner'], core: true },
  { id: 'review', name: 'Review', roles: ['reviewer'], core: true },
  { id: 'sound', name: 'Sound Studio', roles: ['sound-designer', 'composer'] },
  { id: 'art', name: 'Art', roles: ['art', 'artist', 'art-director'], active: true },
  { id: '3d', name: '3D', roles: ['asset-3d'] },
  { id: 'localization', name: 'Localization', roles: ['localizer'] },
  { id: 'ui', name: 'UI & Accessibility', roles: ['ui-designer'] },
  { id: 'narrative', name: 'Narrative', roles: ['writer'] },
  { id: 'release', name: 'Release & Store', roles: ['release-manager'] },
  { id: 'devlog', name: 'Devlog', roles: ['devlogger'] },
  { id: 'engine', name: 'Engine Transfer', roles: ['engine-porter'] },
  { id: 'hacks', name: 'Dev Hacker Lab', roles: ['dev-hacker'] },
];

export function listDivisions() {
  const cfg = readJson('studio/divisions.json');
  const saved = Array.isArray(cfg?.divisions) ? cfg.divisions : [];
  // A saved file keeps its on/off choices; divisions added in later versions (and their roles) still appear.
  const list = [...saved.map((d) => ({ ...(DEFAULT_DIVISIONS.find((x) => x.id === d.id) || {}), ...d })), ...DEFAULT_DIVISIONS.filter((x) => !saved.some((d) => d.id === x.id))];
  return list.map((d) => ({ ...d, roles: d.roles || DEFAULT_DIVISIONS.find((x) => x.id === d.id)?.roles || [], active: Boolean(d.core || d.active) }));
}

/** Switch a division on or off from the War Room: writes studio/divisions.json with every division listed. */
export function setDivision(id, on, by = 'war-room-human') {
  const list = listDivisions().map(({ autoOn, ...d }) => ({ ...d }));
  const d = list.find((x) => x.id === id);
  if (!d) return { ok: false, message: `No division ${id}` };
  if (d.core && !on) return { ok: false, message: `${d.name} is a core division and stays on.` };
  d.active = Boolean(on);
  fs.writeFileSync(path.join(REPO_ROOT, 'studio', 'divisions.json'), `${JSON.stringify({ divisions: list.map((x) => ({ id: x.id, name: x.name, ...(x.core ? { core: true } : { active: x.active }), ...(x.roles ? { roles: x.roles } : {}) })) }, null, 2)}\n`);
  emitEvent({ type: 'division.set', agent: by, to: 'producer', msg: `${by} switched ${d.name} ${on ? 'on' : 'off'}` });
  return { ok: true, division: d };
}


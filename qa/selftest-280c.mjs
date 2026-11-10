/**
 * qa/selftest-280c.mjs — 2.80 (c): the fixes the trim can't deliver (part c).
 *
 * N1 (P0): a stale .studio/machine.json (the supervisor off > 15 min) made machineProfile() null, the game check fell back
 * to 2 test workers and blew the gate timeout: a train of 3 good lanes ran 35 min and landed nothing. The profile is now
 * scanned inline when the stored one is missing or stale.
 */
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export async function selftest280C({ dir, report, tmpRoot }) {
  const u = (rel) => pathToFileURL(path.join(dir, rel)).href;
  const guard = async (name, fn) => {
    try { const [ok, detail] = await fn(); report(name, Boolean(ok), ok ? '' : String(detail || '').slice(0, 2500)); }
    catch (e) { report(name, false, String(e?.stack || e).slice(0, 2500)); }
  };
  let n = 0;
  const scratch = (tag) => { const d = path.join(tmpRoot || dir, `st-280c-${tag}-${process.pid}-${++n}`); fs.mkdirSync(path.join(d, '.studio'), { recursive: true }); return d; };

  // ---- N1: a missing or stale machine scan is taken again inline ----
  {
    const hb = await import(u('harness/heavy-budget.mjs'));
    await guard('2.80 (c) N1: machineProfile() scans the machine when .studio/machine.json is 3 h old or missing (and writes it for the next caller), so a game check gets its RAM-sized workers, not "no machine scan: 2"; STUDIO_MACHINE_SCAN=off, STUDIO_TEST_MACHINE=none and an injected machine: null still give null (fails on 2.79.2: a stale or missing scan gave null and 2 workers)', () => {
      const env = { STUDIO_MACHINE_SCAN: '', STUDIO_TEST_MACHINE: '', STUDIO_MACHINE_MAX_AGE_MIN: '' };
      const stale = scratch('stale');
      const file = path.join(stale, '.studio', 'machine.json');
      const oldAt = new Date(Date.now() - 3 * 3600000).toISOString();
      fs.writeFileSync(file, JSON.stringify({ at: oldAt, os: 'linux', cores: { logical: 8 }, ram: { totalGb: 32, freeGb: 20 }, cpu: { busy: 0.1 } }));
      const t0 = Date.now();
      const p = hb.machineProfile(stale, { env });
      const ms = Date.now() - t0;
      const written = JSON.parse(fs.readFileSync(file, 'utf8'));
      const missing = scratch('missing');
      const pm = hb.machineProfile(missing, { env });
      const again = hb.machineProfile(missing, { env });
      const tw = hb.testWorkers({ profile: p, env: { ...env, STUDIO_TEST_WORKERS: '' }, root: stale });
      const offs = [hb.machineProfile(stale, { env: { ...env, STUDIO_MACHINE_SCAN: 'off' } }), hb.machineProfile(stale, { env: { ...env, STUDIO_TEST_MACHINE: 'none' } }), hb.machineProfile(stale, { env, machine: null })];
      const ok = p && Date.parse(p.at) >= t0 - 1000 && written.at !== oldAt && pm && fs.existsSync(path.join(missing, '.studio', 'machine.json')) && again?.at === pm.at
        && !/no machine scan/.test(tw.why) && offs.every((x) => x === null) && ms < 20000;
      return [ok, JSON.stringify({ at: p?.at, written: written.at, pm: pm?.at, again: again?.at, tw, offs, ms })];
    });
  }

}

/**
 * qa/fun-probes.mjs — the real-input fun check (2.30b, J1) and the sim-to-screen wiring check (J4).
 * Called by qa/browser-play.mjs on the live page, with real keys and clicks.
 *
 * Probes a cartridge turns on in qa.mjs (export const browser = { probes: ['move', 'sprint', 'jump', 'aim', 'camera'] }):
 *   move    hold forward, then right: the player moves along the camera's forward and right (camera-relative WASD)
 *   sprint  the same hold with sprint covers at least 1.2x the ground
 *   jump    the player rises within 0.6 s of the jump key
 *   aim     with an enemy under the crosshair, one shot hits that enemy
 *   camera  the camera is never inside geometry during the whole play
 * They read window.__view(): player { x, y, z }, camera { forward: [x, z], inside }, crosshair { target },
 * hits { last, count }. A probe whose fields are missing fails as PROBE-UNWIRED: the feature isn't on screen.
 * Keys: browser.keys = { forward: 'w', right: 'd', sprint: 'Shift', jump: 'Space' }; browser.aim(view) may
 * return { move: [x, y] } to put an enemy under the crosshair.
 *
 * J4: cartridges list what the sim can do (export const simFeatures = ['sprint', 'jump', 'crane']). Each must
 * be a probe above or a browser.features[name] = { key | click, expect(viewBefore, viewAfter) }; one that
 * isn't bound or doesn't show fails as SIM-ONLY: "a sim feature is not done until the build shows it".
 */
export const PROBES = ['move', 'sprint', 'jump', 'aim', 'camera'];
const DEFAULT_KEYS = { forward: 'w', back: 's', left: 'a', right: 'd', sprint: 'Shift', jump: 'Space' };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (page) => page.evaluate(() => (typeof window.__view === 'function' ? window.__view() : null));
const unit = (v) => {
  const l = Math.hypot(v[0], v[1]);
  return l > 1e-6 ? [v[0] / l, v[1] / l] : null;
};

async function hold(page, keys, ms) {
  for (const k of keys) await page.keyboard.down(k);
  await sleep(ms);
  for (const k of [...keys].reverse()) await page.keyboard.up(k);
  await sleep(120);
}
async function travel(page, keys, ms) {
  const a = await view(page);
  await hold(page, keys, ms);
  const b = await view(page);
  return { a, b, d: [b.player.x - a.player.x, b.player.z - a.player.z] };
}

/** Run the probes. `played` says whether the camera was ever inside geometry during the play. */
export async function runProbes(page, b = {}, { cameraInside = false } = {}) {
  const want = (b.probes || []).filter((p) => PROBES.includes(p));
  const keys = { ...DEFAULT_KEYS, ...(b.keys || {}) };
  const out = [];
  const ok = (name, pass, why) => out.push({ name, ok: Boolean(pass), why: pass ? null : why });
  const unwired = (name, fields) => out.push({ name, ok: false, unwired: true, why: `window.__view() has no ${fields}: the build doesn't show it` });
  for (const name of want) {
    try {
      const v = await view(page);
      if (!v) {
        unwired(name, 'value at all');
        continue;
      }
      if (name === 'camera') {
        if (!v.camera || typeof v.camera.inside !== 'boolean') unwired(name, 'camera.inside');
        else ok(name, !cameraInside && !v.camera.inside, 'the camera went inside geometry during play');
        continue;
      }
      if (['move', 'sprint', 'jump'].includes(name) && (!v.player || !Number.isFinite(v.player.x) || !Number.isFinite(v.player.z))) {
        unwired(name, 'player { x, y, z }');
        continue;
      }
      if (name === 'move') {
        const fwd = unit(v.camera?.forward || []);
        if (!fwd) {
          unwired(name, 'camera.forward [x, z]');
          continue;
        }
        const f = await travel(page, [keys.forward], 400);
        const r = await travel(page, [keys.right], 400);
        const df = unit(f.d);
        const dr = unit(r.d);
        const right = [-fwd[1], fwd[0]];
        const cf = df ? df[0] * fwd[0] + df[1] * fwd[1] : 0;
        // Right is perpendicular to forward; either handedness counts, sideways is what matters.
        const cr = dr ? Math.abs(dr[0] * right[0] + dr[1] * right[1]) : 0;
        ok(name, cf > 0.7 && cr > 0.7, !df ? `${keys.forward} didn't move the player` : !dr ? `${keys.right} didn't move the player` : `movement isn't camera-relative: forward matched ${cf.toFixed(2)}, right ${cr.toFixed(2)} (needs 0.7)`);
      } else if (name === 'sprint') {
        const walk = await travel(page, [keys.forward], 400);
        const run = await travel(page, [keys.sprint, keys.forward], 400);
        const w = Math.hypot(...walk.d);
        const s = Math.hypot(...run.d);
        ok(name, w > 0 && s >= w * 1.2, w <= 0 ? 'walking moved nothing, so sprint can\'t be compared' : `sprint covered ${s.toFixed(2)} against ${w.toFixed(2)} walking (needs 1.2x)`);
      } else if (name === 'jump') {
        if (!Number.isFinite(v.player.y)) {
          unwired(name, 'player.y');
          continue;
        }
        await page.keyboard.press(keys.jump);
        let top = v.player.y;
        const until = Date.now() + 600;
        while (Date.now() < until) {
          top = Math.max(top, (await view(page)).player.y);
          await sleep(40);
        }
        ok(name, top > v.player.y + 0.1, `${keys.jump} didn't lift the player (y ${v.player.y} → ${top})`);
      } else if (name === 'aim') {
        if (!v.crosshair || !('target' in v.crosshair) || !v.hits) {
          unwired(name, 'crosshair.target and hits { last, count }');
          continue;
        }
        let cur = v;
        const until = Date.now() + 5000;
        while (!cur.crosshair.target && Date.now() < until) {
          const a = typeof b.aim === 'function' ? b.aim(cur) : null;
          if (a?.move) await page.mouse.move(a.move[0], a.move[1]);
          await sleep(100);
          cur = await view(page);
        }
        if (!cur.crosshair.target) {
          ok(name, false, 'no enemy came under the crosshair in 5 s (give browser.aim(view) a way to aim)');
          continue;
        }
        const target = cur.crosshair.target;
        const before = cur.hits.count || 0;
        const box = await page.locator('canvas').first().boundingBox().catch(() => null);
        await page.mouse.click(box ? box.x + box.width / 2 : 640, box ? box.y + box.height / 2 : 360);
        let after = cur;
        const end = Date.now() + 500;
        while (Date.now() < end && !((after.hits.count || 0) > before)) {
          await sleep(40);
          after = await view(page);
        }
        ok(name, (after.hits.count || 0) > before && after.hits.last === target, (after.hits.count || 0) > before ? `the shot hit ${after.hits.last}, not ${target} under the crosshair` : `a shot at ${target} under the crosshair hit nothing`);
      }
    } catch (err) {
      ok(name, false, `the probe broke: ${String(err?.message || err).split('\n')[0]}`);
    }
  }
  return out;
}

/** J4: every sim feature is bound to input and shows on screen. */
export async function checkSimFeatures(page, simFeatures = [], b = {}, probes = []) {
  const out = [];
  for (const name of simFeatures) {
    const p = probes.find((x) => x.name === name);
    if (p) {
      out.push({ name, ok: p.ok, via: 'probe', why: p.why });
      continue;
    }
    const f = b.features?.[name];
    if (!f || !(f.key || f.click) || typeof f.expect !== 'function') {
      out.push({ name, ok: false, why: `the sim has "${name}" but the build binds no input to it (browser.features.${name} = { key, expect })` });
      continue;
    }
    const before = await view(page);
    if (f.key) await page.keyboard.press(f.key);
    else await page.click(f.click, { timeout: 3000 }).catch(() => {});
    await sleep(Number(f.waitMs ?? 400));
    const after = await view(page);
    let shown = false;
    try {
      shown = Boolean(f.expect(before, after));
    } catch {}
    out.push({ name, ok: shown, via: 'feature', why: shown ? null : `${f.key || f.click} for "${name}" changed nothing on screen` });
  }
  return out;
}

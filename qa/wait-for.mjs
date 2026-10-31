/**
 * qa/wait-for.mjs — wait for a state instead of reading it once (P-044).
 *
 * The browser checks act on the War Room (press Stop, add a task) and then look at the page. The page
 * refreshes on its own timer, so a check that looks once can run before the refresh that shows the
 * result (main's CI: "Stop ends it" failed with the agent's record already saying ended). waitFor()
 * asks again until the state holds or the time is up, and on time-out says what it saw last.
 *
 *   const r = await waitFor(async () => ({ ok: /done/.test(text), seen: text }), { timeout: waitBudget() });
 *   r.ok, r.ms, r.seen, r.message (only when it timed out)
 */

/**
 * How long a check may wait, in ms: `base` on Linux and macOS, twice that on Windows (slower runners).
 * HUD_WAIT_MS sets the time for every check that uses the default (no scaling).
 */
export function waitBudget(base = 15000, { env = process.env, platform = process.platform } = {}) {
  const set = Number(env.HUD_WAIT_MS);
  if (Number.isFinite(set) && set > 0) return set;
  return platform === 'win32' ? base * 2 : base;
}

const clip = (s, n = 1500) => {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim();
  return t ? (t.length > n ? `${t.slice(0, n)}…` : t) : '(nothing)';
};

/**
 * Ask `probe` until it says ok (and, with holdMs, keeps saying ok for that long), or the timeout passes.
 * probe() returns a boolean or { ok, seen }; `seen` is what the page showed, for the failure message.
 * A probe that throws counts as "not yet" and its error becomes what was seen.
 * Returns { ok, ms, polls, seen } and, on time-out, a `message` naming the wait and the last thing seen.
 */
export async function waitFor(probe, { timeout = waitBudget(), interval = 250, holdMs = 0, now = Date.now, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  const start = now();
  let last = { ok: false, seen: '' };
  let heldSince = null;
  let polls = 0;
  for (;;) {
    polls += 1;
    try {
      const r = await probe();
      last = r !== null && typeof r === 'object' ? { ok: Boolean(r.ok), seen: r.seen ?? '' } : { ok: Boolean(r), seen: '' };
    } catch (e) {
      last = { ok: false, seen: `(the look failed: ${String(e?.message || e).split('\n')[0]})` };
    }
    const t = now();
    if (last.ok) {
      if (heldSince === null) heldSince = t;
      if (t - heldSince >= holdMs) return { ok: true, ms: t - start, polls, seen: last.seen };
    } else heldSince = null;
    // A state that turned true before the deadline may finish its hold after it; anything else stops here.
    if (t - start >= timeout && (heldSince === null || heldSince - start >= timeout)) {
      const what = holdMs ? `did not hold for ${(holdMs / 1000).toFixed(1)} s within ${(timeout / 1000).toFixed(1)} s` : `not true after ${(timeout / 1000).toFixed(1)} s`;
      return { ok: false, ms: t - start, polls, seen: last.seen, message: `waited, ${what} (${polls} looks); the page showed: ${clip(last.seen)}` };
    }
    await sleep(Math.max(1, Math.min(interval, heldSince !== null ? holdMs - (t - heldSince) : timeout - (t - start))));
  }
}

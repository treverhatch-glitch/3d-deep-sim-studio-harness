/**
 * harness/studio-passes.mjs — 2.80 (b1): the studio's timed passes, run by the supervisor's loop.
 *
 * Until 2.79.2 the War Room hub ran these on its own timers. The hub goes in 2.80, so the supervisor runs them:
 *   - "watch", every STUDIO_WATCH_INTERVAL s (300; 0 turns both groups off): the watch pass (harness/watch.mjs), the
 *     retro, the learn pass, the run report and the Director's daily ping (each *IfDue keeps its own due date);
 *   - "gamedev", every STUDIO_GAMEDEV_INTERVAL s (180; 0 turns it off): the watchdog pass (harness/watchdog.mjs).
 * A group first runs one full interval after the supervisor started (short runs never run them), never in a dry run.
 * Each pass has its own try/catch: one that throws is logged and the others still run.
 * The flow pass is not here: the supervisor's own loop runs it (fill: false, it is the launcher).
 */

/**
 * One check of the timed passes. `since` is when the supervisor started (ms); `last` holds the groups' last runs
 * ({ watch, gamedev } in ms; updated in place); `deps` injects the passes, the log and `step` (the supervisor's bounded
 * step: (label, fn) => Promise). Returns { ran: [group], last }.
 */
export async function timedPasses({ now = Date.now(), since = now, last = {}, env = process.env, dryRun = false, deps = {} } = {}) {
  const ran = [];
  if (dryRun) return { ran, last };
  const watchEvery = Number(env.STUDIO_WATCH_INTERVAL ?? 300);
  if (!(watchEvery > 0)) return { ran, last };
  const gamedevEvery = Number(env.STUDIO_GAMEDEV_INTERVAL ?? 180);
  const log = deps.log || console.log;
  const warn = deps.warn || console.error;
  const step = deps.step || ((label, fn) => fn());
  const due = (group, every) => every > 0 && now - (last[group] ?? since) >= every * 1000;
  const one = async (tag, fn) => {
    try { await fn(); } catch (err) { warn(`[${tag}] ${err?.message || err}`); }
  };
  if (due('watch', watchEvery)) {
    last.watch = now;
    ran.push('watch');
    const pick = async (name, mod) => deps[name] || (await import(mod))[name];
    await step('timed-watch', async () => {
      await one('watch', async () => {
        const r = (await pick('watchPass', './watch.mjs'))();
        if (r?.findings?.length) log(`[watch] ${r.findings.map((f) => f.msg).join(' | ')}`);
      });
      await one('retro', async () => {
        const retro = (await pick('retroIfDue', './retro.mjs'))();
        if (retro) log(`[retro] wrote ${retro.file}: ${retro.suggestions.length} suggestion(s)`);
      });
      await one('learn', async () => {
        const learned = (await pick('learnIfDue', './learn.mjs'))();
        if (learned) log(`[learn] rewrote ${learned.file}${learned.backup ? `; backed up to ${learned.backup}` : ''}`);
      });
      await one('run-report', async () => {
        const report = (await pick('runReportIfDue', './run-report.mjs'))();
        if (report?.ok) log(`[run-report] updated ${report.dest}`);
      });
      await one('director', async () => {
        const dir = (await pick('dailyPingIfDue', './director.mjs'))();
        if (dir) log(`[director] daily ping: ${dir.task}${dir.start?.started ? ' (Director started)' : ''}`);
      });
    });
  }
  if (due('gamedev', gamedevEvery)) {
    last.gamedev = now;
    ran.push('gamedev');
    await step('timed-gamedev', () => one('gamedev', async () => {
      const r = await (deps.watchdogPass || (await import('./watchdog.mjs')).watchdogPass)();
      if (r?.on && r.actions?.length) log(`[gamedev] ${r.actions.map((a) => a.msg).join(' | ')}`);
    }));
  }
  return { ran, last };
}

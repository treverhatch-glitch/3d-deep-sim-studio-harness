/**
 * harness/blender-job.mjs — 2.70.0 (t): the harness's own Blender jobs (the asset round trip, preview renders) out of
 * the single machine:heavy slot.
 *
 * The asset round trip took machine:heavy, the slot a 30-minute full verify holds, so a seconds-long .glb import/export
 * waited up to an hour. Now:
 *   - its claim kind follows the program it runs (blenderKind): Blender -> asset-roundtrip (or blender-preview for a
 *     preview render), which heavy-budget.mjs puts in the GPU area when the machine scan shows a GPU (beside a verify);
 *     a Unity batchmode command -> unity (the one-editor cap). No GPU in the scan: the 2.69 claim (a slot).
 *   - at most one Blender job of the harness's own at a time (heavy-budget.mjs cap group "blender", 1;
 *     STUDIO_HEAVY_MAX_BLENDER raises it). A Blender someone opened by hand is never counted, closed or taken over:
 *     nothing here lists or touches other processes.
 *   - a Blender command gets `-t <n>` (render threads) unless it names its own: STUDIO_BLENDER_THREADS, else from the
 *     machine scan (logical cores / 3, 1..8), never 0 (Blender's 0 means every core). Placed before the first
 *     -P/--python/-f/-a/-- argument so it applies to what follows (UNVERIFIED against a real Blender here: tests use a stub).
 * No harness imports at load (asset-gate.mjs imports this inside a function).
 */
import os from 'node:os';
import path from 'node:path';

const progOf = (cmd) => {
  const m = String(cmd || '').trim().match(/^"([^"]+)"|^'([^']+)'|^(\S+)/);
  return m ? m[1] || m[2] || m[3] : '';
};
const base = (p) => path.basename(String(p).replace(/\\/g, '/')).toLowerCase();
/** The command runs Blender (blender, blender.exe, Blender.app's binary). */
export const isBlenderCommand = (cmd) => /^blender(\.exe)?$/.test(base(progOf(cmd)));
/** The command runs a Unity editor (Unity, Unity.exe). */
export const isUnityCommand = (cmd) => /^unity(\.exe)?$/.test(base(progOf(cmd)));

/** The heavy-budget kind for a configured asset command: unity for a Unity editor, else `blenderKindName`. */
export function blenderKind(cmd, blenderKindName = 'asset-roundtrip') {
  return isUnityCommand(cmd) ? 'unity' : blenderKindName;
}

/**
 * Render threads for a Blender job: { n, why }. STUDIO_BLENDER_THREADS (a whole number > 0) wins; 0 or junk is ignored
 * (0 would mean every core) and said; else logical cores / 3 from the scan (or this machine), between 1 and 8.
 */
export function blenderThreads({ env = process.env, profile = null } = {}) {
  const raw = env.STUDIO_BLENDER_THREADS;
  const v = Math.floor(Number(raw));
  if (raw !== undefined && raw !== '' && Number.isFinite(v) && v > 0) return { n: v, why: 'STUDIO_BLENDER_THREADS' };
  const cores = Number(profile?.cores?.logical) > 0 ? Number(profile.cores.logical) : (os.availableParallelism ? os.availableParallelism() : os.cpus().length) || 1;
  const n = Math.max(1, Math.min(8, Math.floor(cores / 3)));
  const bad = raw !== undefined && raw !== '' ? `STUDIO_BLENDER_THREADS=${raw} ignored (never 0: Blender's 0 is every core); ` : '';
  return { n, why: `${bad}${cores} logical cores / 3, 1..8${profile ? '' : ' (no machine scan: this machine)'}` };
}

/** The command with `-t <n>` added (a Blender command that sets no -t/--threads of its own); others unchanged. */
export function withBlenderThreads(cmd, n) {
  if (!isBlenderCommand(cmd) || !(n > 0)) return cmd;
  const s = String(cmd);
  if (/\s(-t|--threads)(\s|=|$)/.test(s)) return s;
  const m = s.match(/\s(-P|--python|--python-expr|-f|--render-frame|-a|--render-anim|--)(\s|$)/);
  if (m) return `${s.slice(0, m.index)} -t ${n}${s.slice(m.index)}`;
  return `${s} -t ${n}`;
}

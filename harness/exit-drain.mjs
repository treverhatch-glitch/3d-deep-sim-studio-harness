/**
 * harness/exit-drain.mjs — 2.77.1 (M4): end a CLI without process.exit().
 *
 * On Windows, process.exit() while a handle is still closing (fetch's keep-alive socket, a timer) aborts node with
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING), file src\win\async.c, line 76" (the libuv exit race): the
 * work was done, the exit looked like a crash. So set process.exitCode and let the event loop drain. Anything that
 * keeps the loop open (an undici socket kept alive) is closed first (the global dispatcher), and an unref'd timer is
 * the last resort so a stuck handle can't hang the command: it only fires if the loop is still alive after graceMs.
 */
export async function closeFetchHandles() {
  try { await globalThis[Symbol.for('undici.globalDispatcher.1')]?.close?.(); } catch { /* nothing open */ }
}

export function exitWhenDrained(code, { graceMs = 5000, exit = (c) => process.exit(c), proc = process } = {}) {
  proc.exitCode = code;
  closeFetchHandles().catch(() => {});
  const t = setTimeout(() => exit(code), graceMs);
  t.unref?.();
  return t;
}

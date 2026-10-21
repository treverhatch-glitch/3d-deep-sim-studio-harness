#!/usr/bin/env node
// Starts a virtual display (Xvfb), a window manager, x11vnc and noVNC so agents' windows (Blender, a
// browser) can be watched in the War Room's noVNC panel. Linux and WSL2 only: Windows and macOS have a
// real display, so there is nothing to start there.
// Settings: DISPLAY_NUM (:99), SCREEN_RES (1280x720x24), VNC_PORT (5999), NOVNC_PORT (6080), NOVNC_WEB_DIR.
import fs from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

if (process.platform !== 'linux') {
  console.log(`start-agent-display: not needed on ${process.platform}; agents use your real display. On a Linux server or WSL2, run this there.`);
  process.exit(0);
}
const env = process.env;
const DISPLAY = env.DISPLAY_NUM || ':99';
const RES = env.SCREEN_RES || '1280x720x24';
const VNC = env.VNC_PORT || '5999';
const NOVNC = env.NOVNC_PORT || '6080';
const WEB = env.NOVNC_WEB_DIR || '/usr/share/novnc';
const has = (bin) => spawnSync('which', [bin]).status === 0;
const running = (pattern) => spawnSync('pgrep', ['-f', pattern]).status === 0;
const start = (bin, args, log) => {
  const out = fs.openSync(log, 'a');
  spawn(bin, args, { detached: true, stdio: ['ignore', out, out], env: { ...env, DISPLAY } }).unref();
};
const pause = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);

if (!has('Xvfb')) {
  console.log('Xvfb not found. On Ubuntu, Debian or WSL2:\n  sudo apt-get update && sudo apt-get install -y xvfb x11vnc novnc websockify fluxbox');
  process.exit(1);
}
if (running(`Xvfb ${DISPLAY}`)) console.log(`[1/4] Xvfb already running on ${DISPLAY}.`);
else {
  console.log(`[1/4] Starting Xvfb on ${DISPLAY} (${RES})...`);
  start('Xvfb', [DISPLAY, '-screen', '0', RES, '-ac', '+extension', 'GLX', '+render', '-noreset'], '/tmp/xvfb.log');
  pause(600);
}
if (has('fluxbox') && !running('fluxbox')) {
  console.log('[2/4] Starting the fluxbox window manager...');
  start('fluxbox', [], '/tmp/fluxbox.log');
} else console.log('[2/4] Window manager ready.');
if (!has('x11vnc')) console.log('[3/4] x11vnc not installed; skipping the VNC stream.');
else if (running(`x11vnc.*${DISPLAY}`)) console.log(`[3/4] x11vnc already running on port ${VNC}.`);
else {
  console.log(`[3/4] Starting x11vnc on port ${VNC}...`);
  start('x11vnc', ['-display', DISPLAY, '-rfbport', VNC, '-forever', '-shared', '-nopw', '-listen', '127.0.0.1'], '/tmp/x11vnc.log');
  pause(500);
}
if (!has('websockify')) console.log('[4/4] websockify not installed; skipping noVNC.');
else if (running(`websockify.*${NOVNC}`)) console.log(`[4/4] websockify already listening on :${NOVNC}.`);
else {
  console.log(`[4/4] Starting noVNC on :${NOVNC}...`);
  start('websockify', [...(fs.existsSync(WEB) ? [`--web=${WEB}`] : []), NOVNC, `127.0.0.1:${VNC}`], '/tmp/novnc.log');
}
console.log(`\nReady. export DISPLAY=${DISPLAY}\n  noVNC: http://localhost:${NOVNC}/vnc.html?autoconnect=true&resize=scale`);

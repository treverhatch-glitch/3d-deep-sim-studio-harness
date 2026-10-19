#!/usr/bin/env bash
# ============================================================================
# scripts/start-agent-display.sh — Live Virtual Screen for "Agent Eyes"
#
# Launches an X11 virtual framebuffer (`Xvfb :99`), attaches `x11vnc`, and
# serves an HTML5 WebSocket VNC stream via `websockify` / `noVNC` on `:6080`.
#
# Any Playwright browser (`DISPLAY=:99`) or Blender viewport (`DISPLAY=:99 blender`)
# launched by an agent renders directly into the Mission Control War Room's
# "1. noVNC :6080" viewport at 0% LLM token cost.
# ============================================================================
set -euo pipefail

DISPLAY_NUM="${DISPLAY_NUM:-:99}"
SCREEN_RES="${SCREEN_RES:-1280x720x24}"
VNC_PORT="${VNC_PORT:-5999}"
NOVNC_PORT="${NOVNC_PORT:-6080}"
NOVNC_WEB_DIR="${NOVNC_WEB_DIR:-/usr/share/novnc}"

echo "===================================================================="
echo " 3D DEEP-SIM STUDIO — STARTING AGENT EYES VIRTUAL DISPLAY (${DISPLAY_NUM})"
echo "===================================================================="

if ! command -v Xvfb >/dev/null 2>&1; then
  echo "[start-agent-display] Xvfb not found. Install on Ubuntu/Debian/WSL2:"
  echo "  sudo apt-get update && sudo apt-get install -y xvfb x11vnc novnc websockify fluxbox"
  exit 1
fi

# 1. Start Xvfb virtual framebuffer
if ! pgrep -f "Xvfb ${DISPLAY_NUM}" >/dev/null 2>&1; then
  echo "[1/4] Launching Xvfb on ${DISPLAY_NUM} (${SCREEN_RES})..."
  Xvfb "${DISPLAY_NUM}" -screen 0 "${SCREEN_RES}" -ac +extension GLX +render -noreset >/tmp/xvfb.log 2>&1 &
  sleep 0.6
else
  echo "[1/4] Xvfb already running on ${DISPLAY_NUM}."
fi

export DISPLAY="${DISPLAY_NUM}"

# 2. Optional lightweight window manager (fluxbox) so Blender/Playwright windows tile cleanly
if command -v fluxbox >/dev/null 2>&1 && ! pgrep -f "fluxbox" >/dev/null 2>&1; then
  echo "[2/4] Starting fluxbox window manager on ${DISPLAY_NUM}..."
  fluxbox >/tmp/fluxbox.log 2>&1 &
else
  echo "[2/4] Window manager ready."
fi

# 3. Start x11vnc bound to localhost
if ! pgrep -f "x11vnc.*${DISPLAY_NUM}" >/dev/null 2>&1; then
  echo "[3/4] Starting x11vnc on port ${VNC_PORT}..."
  x11vnc -display "${DISPLAY_NUM}" -rfbport "${VNC_PORT}" -forever -shared -nopw -listen 127.0.0.1 >/tmp/x11vnc.log 2>&1 &
  sleep 0.5
else
  echo "[3/4] x11vnc already running on port ${VNC_PORT}."
fi

# 4. Start websockify / noVNC on :6080
if ! pgrep -f "websockify.*${NOVNC_PORT}" >/dev/null 2>&1; then
  echo "[4/4] Starting websockify / noVNC on ws://127.0.0.1:${NOVNC_PORT}/websockify..."
  if [ -d "${NOVNC_WEB_DIR}" ]; then
    websockify --web="${NOVNC_WEB_DIR}" "${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/novnc.log 2>&1 &
  else
    websockify "${NOVNC_PORT}" "127.0.0.1:${VNC_PORT}" >/tmp/novnc.log 2>&1 &
  fi
  sleep 0.5
else
  echo "[4/4] websockify already listening on :${NOVNC_PORT}."
fi

echo "===================================================================="
echo " Agent Eyes Live Stream Ready:"
echo "   export DISPLAY=${DISPLAY_NUM}"
echo "   noVNC HTML5 URL : http://localhost:${NOVNC_PORT}/vnc.html?autoconnect=true&resize=scale"
echo "   WebSocket URL   : ws://localhost:${NOVNC_PORT}/websockify"
echo "===================================================================="

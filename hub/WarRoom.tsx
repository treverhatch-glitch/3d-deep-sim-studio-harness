/**
 * hub/WarRoom.tsx — 3D Deep-Sim AI Studio Mission Control War Room
 *
 * Orchestrates all 7 architectural modules at 0% LLM token cost:
 *   1. Palantir / SpaceX Dragon / Cyberpunk Mission Control Aesthetic (#06080E,
 *      backdrop-filter: blur(12px), 1px #00F0FF / #0EA5E9 borders, CRT scanline toggle,
 *      resizable 4-Quadrant Desktop/Ultrawide grid + <768px Mobile Command Feed).
 *   2. Dynamic, Uncapped Agent & Failover Node Graph (`AgentGraph.tsx` via `@xyflow/react`).
 *   3. "Agent Eyes" Real-Time Viewport Multiplexer (`AgentEyesViewport.tsx`: noVNC, WebRTC,
 *      Playwright CDP Screencast + UISentinel boxes + `window.__sim`, and HMR Iframe).
 *   4. Built-In Cyberpunk Terminal Dock & Command Deck (`TerminalDock.tsx` via `xterm.js`).
 *   5. Subscription Quota & Token-Saver Telemetry Bar (`UsageTelemetry.tsx` reading `.studio/usage.json`).
 *   6. "What's Next" Pipeline & External Context Status (`NextQueue.tsx`).
 *   7. Live WebSocket (`/ws`) + SSE (`/api/stream`) passive file/event streaming.
 */

import React, { useCallback, useEffect, useRef, useState } from 'react';
import AgentGraph, { type StudioRoleNodeData } from './AgentGraph';
import AgentEyesViewport, { type FrameStreamPayload, type ViewportConfig } from './AgentEyesViewport';
import TerminalDock, { type StudioEventRecord } from './TerminalDock';
import UsageTelemetry, { type UsagePayload } from './UsageTelemetry';
import NextQueue, { type ContextHealthItem, type QueueTaskItem } from './NextQueue';

export interface StudioSnapshot {
  generatedAt: string;
  llmTokensUsedForStatus: number;
  producerPreset: string;
  rolesCount: number;
  roles: StudioRoleNodeData[];
  queue: {
    inProgress: QueueTaskItem[];
    backlog: QueueTaskItem[];
    done: QueueTaskItem[];
  };
  contextHealth: ContextHealthItem[];
  usage: UsagePayload;
  warRoomConfig: {
    theme?: {
      crtScanlines?: boolean;
    };
    viewport?: ViewportConfig;
    terminal?: {
      readOnlyShell?: boolean;
    };
    layout?: {
      leftColumnWidthPct?: number;
      topRowHeightPct?: number;
    };
  };
  telemetry: {
    totalEvents: number;
    tokensIn: number;
    tokensOut: number;
    tokensSaved: number;
    estimatedTokensSaved: number;
    rtkCompressionPct: number;
    estimatedDollarsPreserved: number;
    failovers: number;
    errors: number;
  };
  recentEvents: StudioEventRecord[];
}

export const WarRoom: React.FC = () => {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [frameData, setFrameData] = useState<FrameStreamPayload | null>(null);
  const [shellChunks, setShellChunks] = useState<string[]>([]);
  const [crtScanlines, setCrtScanlines] = useState<boolean>(true);
  const [isMobile, setIsMobile] = useState<boolean>(
    typeof window !== 'undefined'
      ? window.innerWidth < 768 || new URLSearchParams(window.location.search).get('view') === 'mobile'
      : false
  );

  // Resizable 4-Quadrant Grid Splitters (Ultrawide 16:9 / 21:9 / 32:9 friendly)
  const [leftColPct, setLeftColPct] = useState<number>(52);
  const [topRowPct, setTopRowPct] = useState<number>(56);
  const [activeDrawerSlug, setActiveDrawerSlug] = useState<string | null>(null);
  const draggingRef = useRef<'col' | 'row' | null>(null);
  const wsRef = useRef<WebSocket | null>(null);

  useEffect(() => {
    const onResize = () => {
      const mobileParam = new URLSearchParams(window.location.search).get('view') === 'mobile';
      setIsMobile(window.innerWidth < 768 || mobileParam);
    };
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, []);

  // Load initial snapshot & frame + connect WebSocket and SSE fallback
  useEffect(() => {
    fetch('/api/state')
      .then((r) => r.json())
      .then((snap: StudioSnapshot) => {
        setSnapshot(snap);
        if (typeof snap.warRoomConfig?.theme?.crtScanlines === 'boolean') {
          setCrtScanlines(snap.warRoomConfig.theme.crtScanlines);
        }
        if (snap.warRoomConfig?.layout?.leftColumnWidthPct) {
          setLeftColPct(snap.warRoomConfig.layout.leftColumnWidthPct);
        }
        if (snap.warRoomConfig?.layout?.topRowHeightPct) {
          setTopRowPct(snap.warRoomConfig.layout.topRowHeightPct);
        }
      })
      .catch(() => {});

    fetch('/api/frame')
      .then((r) => r.json())
      .then((f: FrameStreamPayload) => setFrameData(f))
      .catch(() => {});

    const proto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const ws = new WebSocket(`${proto}//${window.location.host}/ws`);
    wsRef.current = ws;

    ws.onmessage = (evt) => {
      try {
        const payload = JSON.parse(evt.data);
        if (payload.type === 'init') {
          if (payload.data) setSnapshot(payload.data);
          if (payload.frame) setFrameData(payload.frame);
          if (payload.banner) setShellChunks((prev) => [...prev, payload.banner]);
        } else if (payload.type === 'state' && payload.data) {
          setSnapshot(payload.data);
        } else if (payload.type === 'frame' && payload.data) {
          setFrameData(payload.data);
        } else if (payload.type === 'terminal.output' && payload.text) {
          setShellChunks((prev) => [...prev.slice(-150), payload.text]);
        }
      } catch {
        // ignore parse errors
      }
    };

    const sse = new EventSource('/api/stream');
    sse.onmessage = (e) => {
      try {
        setSnapshot(JSON.parse(e.data));
      } catch {
        // ignore
      }
    };

    return () => {
      ws.close();
      sse.close();
    };
  }, []);

  // Resizable Grid Drag Handlers
  useEffect(() => {
    const onMouseMove = (e: MouseEvent) => {
      if (!draggingRef.current) return;
      if (draggingRef.current === 'col') {
        const pct = Math.min(72, Math.max(28, Math.round((e.clientX / window.innerWidth) * 100)));
        setLeftColPct(pct);
      } else if (draggingRef.current === 'row') {
        const pct = Math.min(75, Math.max(30, Math.round((e.clientY / window.innerHeight) * 100)));
        setTopRowPct(pct);
      }
    };
    const onMouseUp = () => {
      draggingRef.current = null;
    };
    window.addEventListener('mousemove', onMouseMove);
    window.addEventListener('mouseup', onMouseUp);
    return () => {
      window.removeEventListener('mousemove', onMouseMove);
      window.removeEventListener('mouseup', onMouseUp);
    };
  }, []);

  const persistWarRoomConfig = useCallback((patch: Record<string, unknown>) => {
    fetch('/api/config', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch),
    })
      .then((r) => r.json())
      .then(() => {})
      .catch(() => {});
  }, []);

  const handleUpdateViewportConfig = useCallback(
    (patch: Partial<ViewportConfig>) => {
      setSnapshot((prev) => {
        if (!prev) return prev;
        const nextViewport = { ...(prev.warRoomConfig?.viewport || {}), ...patch } as ViewportConfig;
        persistWarRoomConfig({ viewport: nextViewport });
        return {
          ...prev,
          warRoomConfig: {
            ...prev.warRoomConfig,
            viewport: nextViewport,
          },
        };
      });
    },
    [persistWarRoomConfig]
  );

  const handleRunMacro = useCallback((macro: string, extra: Record<string, unknown> = {}) => {
    fetch('/api/macro', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ macro, ...extra }),
    })
      .then((r) => r.json())
      .then((res) => {
        if (res.snapshot) setSnapshot(res.snapshot);
      })
      .catch(() => {});
  }, []);

  const handleSendShellCommand = useCallback((command: string) => {
    if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
      wsRef.current.send(JSON.stringify({ type: 'shell.exec', command }));
    }
  }, []);

  const handleSaveUsage = useCallback(async (nextUsage: UsagePayload) => {
    const res = await fetch('/api/usage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(nextUsage),
    });
    const data = await res.json();
    if (data.usage) {
      setSnapshot((prev) => (prev ? { ...prev, usage: data.usage } : prev));
    }
  }, []);

  const handleTaskAction = useCallback(
    (body: Record<string, unknown>) => {
      fetch('/api/tasks', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      })
        .then((r) => r.json())
        .then((res) => {
          if (res.snapshot) setSnapshot(res.snapshot);
        })
        .catch(() => {});
    },
    []
  );

  if (!snapshot) {
    return (
      <div
        style={{
          background: '#06080E',
          color: '#00F0FF',
          height: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        INITIALIZING MISSION CONTROL WAR ROOM (0% LLM TOKEN TELEMETRY)...
      </div>
    );
  }

  const viewportConfig: ViewportConfig = {
    activeSource: snapshot.warRoomConfig?.viewport?.activeSource || 'cdp',
    novncUrl:
      snapshot.warRoomConfig?.viewport?.novncUrl ||
      'http://localhost:6080/vnc.html?autoconnect=true&resize=scale',
    novncWsUrl: snapshot.warRoomConfig?.viewport?.novncWsUrl || 'ws://localhost:6080/websockify',
    webrtcUrl: snapshot.warRoomConfig?.viewport?.webrtcUrl || 'http://localhost:8889/agent-stream',
    hmrUrl: snapshot.warRoomConfig?.viewport?.hmrUrl || 'http://localhost:5173/?playtest=1',
    showUisentinelOverlay: snapshot.warRoomConfig?.viewport?.showUisentinelOverlay ?? true,
    showSimTelemetryOverlay: snapshot.warRoomConfig?.viewport?.showSimTelemetryOverlay ?? true,
    manualControlEnabled: snapshot.warRoomConfig?.viewport?.manualControlEnabled ?? false,
    targetFps: snapshot.warRoomConfig?.viewport?.targetFps ?? 30,
  };

  const readOnlyShell = snapshot.warRoomConfig?.terminal?.readOnlyShell ?? true;
  const roleSlugs = snapshot.roles.map((r) => r.slug);

  const quadrantPanelStyle: React.CSSProperties = {
    background: 'rgba(10, 15, 28, 0.78)',
    backdropFilter: 'blur(12px)',
    border: '1px solid rgba(0, 240, 255, 0.35)',
    borderRadius: 8,
    overflow: 'hidden',
    display: 'flex',
    flexDirection: 'column',
    position: 'relative',
  };

  return (
    <div
      style={{
        background: '#06080E',
        color: '#e2e8f0',
        minHeight: '100vh',
        height: isMobile ? 'auto' : '100vh',
        display: 'flex',
        flexDirection: 'column',
        fontFamily: "'JetBrains Mono', monospace",
        position: 'relative',
        overflow: isMobile ? 'auto' : 'hidden',
      }}
    >
      {/* Subtle CRT Scanline Overlay */}
      {crtScanlines && (
        <div
          style={{
            position: 'fixed',
            inset: 0,
            pointerEvents: 'none',
            zIndex: 90,
            background:
              'repeating-linear-gradient(to bottom, rgba(255,255,255,0), rgba(255,255,255,0) 2px, rgba(0, 240, 255, 0.025) 3px)',
          }}
        />
      )}

      {/* Top Tactical Command Header */}
      <header
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '8px 14px',
          background: 'rgba(6, 8, 14, 0.95)',
          borderBottom: '1px solid #00F0FF',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
          <span
            style={{
              width: 9,
              height: 9,
              borderRadius: '50%',
              background: '#00F0FF',
              boxShadow: '0 0 10px #00F0FF',
            }}
          />
          <strong style={{ fontSize: 13, color: '#00F0FF', letterSpacing: 1 }}>
            3D DEEP-SIM STUDIO // MISSION CONTROL WAR ROOM
          </strong>
          <span
            style={{
              fontSize: 10,
              padding: '2px 7px',
              borderRadius: 4,
              background: 'rgba(16, 185, 129, 0.16)',
              border: '1px solid #10b981',
              color: '#34d399',
            }}
          >
            0% LLM TOKEN TELEMETRY
          </span>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <button
            onClick={() => {
              const next = !crtScanlines;
              setCrtScanlines(next);
              persistWarRoomConfig({ theme: { crtScanlines: next } });
            }}
            style={{
              background: crtScanlines ? 'rgba(0, 240, 255, 0.18)' : 'rgba(15, 23, 42, 0.85)',
              border: '1px solid #0EA5E9',
              color: '#00F0FF',
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {crtScanlines ? 'CRT Scanlines: ON' : 'CRT Scanlines: OFF'}
          </button>
          <button
            onClick={() => setIsMobile((m) => !m)}
            style={{
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid #334155',
              color: '#cbd5e1',
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {isMobile ? 'Switch to 4-Quadrant Desktop' : 'Switch to Mobile Command Feed'}
          </button>
        </div>
      </header>

      {/* Module 5: Subscription Quota & Token-Saver Telemetry Bar */}
      <UsageTelemetry
        usage={snapshot.usage}
        estimatedTokensSaved={snapshot.telemetry.estimatedTokensSaved}
        onSaveUsage={handleSaveUsage}
      />

      {/* Live Agent Runtime Strip (Start Time -> Duration) — Click any agent to open Detail Drawer */}
      <div
        style={{
          display: 'flex',
          gap: 6,
          padding: '5px 12px',
          background: 'rgba(6, 8, 14, 0.92)',
          borderBottom: '1px solid rgba(14, 165, 233, 0.25)',
          overflowX: 'auto',
          fontSize: 10,
          alignItems: 'center',
        }}
      >
        <span style={{ color: '#00F0FF', fontWeight: 700 }}>LIVE RUNTIMES:</span>
        {snapshot.roles.map((r) => {
          const startStr = r.startedAt ? String(r.startedAt).slice(11, 19) : '00:00:00';
          const durStr = r.durationMs ? `${(Number(r.durationMs) / 1000).toFixed(1)}s` : '0.0s';
          return (
            <button
              key={r.slug}
              onClick={() => setActiveDrawerSlug(r.slug)}
              style={{
                background: 'rgba(15, 23, 42, 0.9)',
                border: '1px solid rgba(0, 240, 255, 0.35)',
                color: '#e2e8f0',
                borderRadius: 4,
                padding: '2px 8px',
                fontSize: 10,
                fontFamily: 'inherit',
                cursor: 'pointer',
                whiteSpace: 'nowrap',
              }}
            >
              <strong style={{ color: '#00F0FF' }}>{r.slug}</strong> [{r.status}] {startStr} → {durStr}
            </button>
          );
        })}
      </div>

      {/* Clickable Agent Detail Drawer in WarRoom.tsx */}
      {activeDrawerSlug && (() => {
        const role = snapshot.roles.find((x) => x.slug === activeDrawerSlug);
        if (!role) return null;
        const startStr = role.startedAt ? String(role.startedAt).slice(11, 19) : '00:00:00';
        const durStr = role.durationMs ? `${(Number(role.durationMs) / 1000).toFixed(1)}s` : '0.0s';
        return (
          <aside
            aria-label="War Room Agent Detail Drawer"
            style={{
              position: 'fixed',
              top: 0,
              right: 0,
              bottom: 0,
              width: 'min(420px, 92vw)',
              background: 'rgba(6, 8, 14, 0.97)',
              backdropFilter: 'blur(16px)',
              borderLeft: '1px solid #00F0FF',
              zIndex: 85,
              padding: 14,
              display: 'flex',
              flexDirection: 'column',
              gap: 10,
              overflowY: 'auto',
            }}
          >
            <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
              <strong style={{ color: '#00F0FF', fontSize: 13 }}>
                AGENT DETAIL // {role.slug.toUpperCase()}
              </strong>
              <button
                onClick={() => setActiveDrawerSlug(null)}
                style={{
                  background: 'transparent',
                  border: '1px solid #334155',
                  color: '#e2e8f0',
                  borderRadius: 4,
                  padding: '3px 8px',
                  cursor: 'pointer',
                }}
              >
                ✕ Close
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#cbd5e1', display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }}>
              <div>Status: <strong style={{ color: '#00F0FF' }}>{role.status}</strong></div>
              <div>Runtime: <strong style={{ color: '#38bdf8' }}>{startStr} → {durStr}</strong></div>
              <div>Current File: <strong>{role.targetFile || 'studio/NEXT.md'}</strong></div>
              <div>Model: <strong>{role.activeProvider}</strong></div>
            </div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#0EA5E9' }}>EVENT HISTORY</div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(role.recentEvents || []).map((evt, idx) => (
                <div
                  key={`${evt.ts}-${idx}`}
                  style={{
                    background: '#0a0f1c',
                    borderLeft: '2px solid #00F0FF',
                    padding: 6,
                    borderRadius: 4,
                    fontSize: 10,
                  }}
                >
                  <div style={{ color: '#64748b' }}>[{evt.ts?.slice(11, 19)}] <strong>{evt.type}</strong></div>
                  <div style={{ color: '#e2e8f0', marginTop: 2 }}>{evt.msg}</div>
                </div>
              ))}
            </div>
          </aside>
        );
      })()}

      {/* Main Workspace: 4-Quadrant Resizable Grid (Desktop/Ultrawide) OR Stacked Mobile Command Feed (<768px) */}
      {isMobile ? (
        <main style={{ display: 'flex', flexDirection: 'column', gap: 10, padding: 10 }}>
          <div style={{ ...quadrantPanelStyle, height: 360 }}>
            <AgentEyesViewport
              config={viewportConfig}
              frameData={frameData}
              onUpdateConfig={handleUpdateViewportConfig}
            />
          </div>
          <div style={{ ...quadrantPanelStyle, height: 380 }}>
            <AgentGraph
              roles={snapshot.roles}
              producerPreset={snapshot.producerPreset}
              onSwitchPreset={(presetId) => handleRunMacro('switch-producer', { presetId })}
              onSimulateFailover={() => handleRunMacro('simulate-failover')}
            />
          </div>
          <div style={{ ...quadrantPanelStyle, minHeight: 340 }}>
            <NextQueue
              queue={snapshot.queue}
              contextHealth={snapshot.contextHealth}
              roles={roleSlugs}
              onStartTask={(id) => handleTaskAction({ action: 'start', id })}
              onCompleteTask={(id) => handleTaskAction({ action: 'done', id })}
              onAddTask={(t) => handleTaskAction({ action: 'add', ...t })}
            />
          </div>
          <div style={{ ...quadrantPanelStyle, height: 340 }}>
            <TerminalDock
              events={snapshot.recentEvents}
              roles={roleSlugs}
              readOnlyShell={readOnlyShell}
              onToggleReadOnly={(next) => persistWarRoomConfig({ terminal: { readOnlyShell: next } })}
              onRunMacro={(macro) => handleRunMacro(macro)}
              onSendShellCommand={handleSendShellCommand}
              shellStreamChunks={shellChunks}
            />
          </div>
        </main>
      ) : (
        <main
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: `${leftColPct}% 6px calc(${100 - leftColPct}% - 6px)`,
            gridTemplateRows: `${topRowPct}% 6px calc(${100 - topRowPct}% - 6px)`,
            padding: 8,
            minHeight: 0,
          }}
        >
          {/* Q1 (Top-Left): Uncapped Agent & Failover Node Graph */}
          <div style={quadrantPanelStyle}>
            <AgentGraph
              roles={snapshot.roles}
              producerPreset={snapshot.producerPreset}
              onSwitchPreset={(presetId) => handleRunMacro('switch-producer', { presetId })}
              onSimulateFailover={() => handleRunMacro('simulate-failover')}
            />
          </div>

          {/* Vertical Column Splitter */}
          <div
            onMouseDown={() => {
              draggingRef.current = 'col';
            }}
            title="Drag to resize left/right quadrants"
            style={{
              gridRow: '1 / 4',
              gridColumn: 2,
              cursor: 'col-resize',
              background: 'rgba(0, 240, 255, 0.12)',
              borderRadius: 3,
            }}
          />

          {/* Q2 (Top-Right): "Agent Eyes" Real-Time Viewport Multiplexer */}
          <div style={{ ...quadrantPanelStyle, gridColumn: 3, gridRow: 1 }}>
            <AgentEyesViewport
              config={viewportConfig}
              frameData={frameData}
              onUpdateConfig={handleUpdateViewportConfig}
            />
          </div>

          {/* Horizontal Row Splitter */}
          <div
            onMouseDown={() => {
              draggingRef.current = 'row';
            }}
            title="Drag to resize top/bottom quadrants"
            style={{
              gridColumn: '1 / 4',
              gridRow: 2,
              cursor: 'row-resize',
              background: 'rgba(0, 240, 255, 0.12)',
              borderRadius: 3,
            }}
          />

          {/* Q3 (Bottom-Left): "What's Next" Pipeline & External Context Status */}
          <div style={{ ...quadrantPanelStyle, gridColumn: 1, gridRow: 3 }}>
            <NextQueue
              queue={snapshot.queue}
              contextHealth={snapshot.contextHealth}
              roles={roleSlugs}
              onStartTask={(id) => handleTaskAction({ action: 'start', id })}
              onCompleteTask={(id) => handleTaskAction({ action: 'done', id })}
              onAddTask={(t) => handleTaskAction({ action: 'add', ...t })}
            />
          </div>

          {/* Q4 (Bottom-Right): Built-In Cyberpunk Terminal Dock & Command Deck */}
          <div style={{ ...quadrantPanelStyle, gridColumn: 3, gridRow: 3 }}>
            <TerminalDock
              events={snapshot.recentEvents}
              roles={roleSlugs}
              readOnlyShell={readOnlyShell}
              onToggleReadOnly={(next) => persistWarRoomConfig({ terminal: { readOnlyShell: next } })}
              onRunMacro={(macro) => handleRunMacro(macro)}
              onSendShellCommand={handleSendShellCommand}
              shellStreamChunks={shellChunks}
            />
          </div>
        </main>
      )}
    </div>
  );
};

export default WarRoom;

/**
 * hub/AgentEyesViewport.tsx — "Agent Eyes" Real-Time Viewport Multiplexer
 *
 * Supports 4 live viewport sources configured via a persistent Source Gear Menu
 * (`localStorage` + `.studio/war-room.config.json`):
 *   1. `novnc`  — noVNC / Xvfb Live Desktop Stream (`ws://localhost:6080/websockify`)
 *   2. `webrtc` — WebRTC Low-Latency Video Stream (`<video>` receiver)
 *   3. `cdp`    — Playwright CDP / High-Frequency Frame Stream (`/api/frame` + WS push)
 *                 with interactive `uisentinel` bounding-box overlay and `?playtest=1`
 *                 (`window.__sim`) deterministic state telemetry.
 *   4. `hmr`    — Live Game HMR Iframe (`http://localhost:5173?playtest=1`) with
 *                 "Take Manual Control" pointer-lock toggle.
 */

import React, { useEffect, useRef, useState } from 'react';

export type ViewportSourceMode = 'novnc' | 'webrtc' | 'cdp' | 'hmr';

export interface UISentinelBox {
  id: string;
  selector: string;
  x: number;
  y: number;
  width: number;
  height: number;
  status: 'pass' | 'warn' | 'error';
  label: string;
}

export interface FrameStreamPayload {
  updatedAt: string;
  frameDataUrl: string | null;
  latestScreenshotUrl?: string | null;
  fps: number;
  latencyMs: number;
  viewport: { width: number; height: number };
  simTelemetry: {
    tick: number;
    seed: number;
    hash: string;
    entities: number;
    credits: number;
    paused: boolean;
    api: string;
  };
  uisentinelBoxes: UISentinelBox[];
}

export interface ViewportConfig {
  activeSource: ViewportSourceMode;
  novncUrl: string;
  novncWsUrl: string;
  webrtcUrl: string;
  hmrUrl: string;
  showUisentinelOverlay: boolean;
  showSimTelemetryOverlay: boolean;
  manualControlEnabled: boolean;
  targetFps: number;
}

export interface AgentEyesViewportProps {
  config: ViewportConfig;
  frameData: FrameStreamPayload | null;
  onUpdateConfig: (patch: Partial<ViewportConfig>) => void;
}

export const AgentEyesViewport: React.FC<AgentEyesViewportProps> = ({
  config,
  frameData,
  onUpdateConfig,
}) => {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const videoRef = useRef<HTMLVideoElement | null>(null);
  const [gearOpen, setGearOpen] = useState(false);
  const [isFullscreen, setIsFullscreen] = useState(false);

  const toggleFullscreen = () => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen?.().catch(() => {});
      setIsFullscreen(true);
    } else {
      document.exitFullscreen?.().catch(() => {});
      setIsFullscreen(false);
    }
  };

  useEffect(() => {
    const onFsChange = () => setIsFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener('fullscreenchange', onFsChange);
    return () => document.removeEventListener('fullscreenchange', onFsChange);
  }, []);

  const setSource = (activeSource: ViewportSourceMode) => {
    try {
      localStorage.setItem('warRoom.viewport.activeSource', activeSource);
    } catch {
      // ignore storage errors
    }
    onUpdateConfig({ activeSource });
  };

  const fps = frameData?.fps ?? config.targetFps ?? 30;
  const latencyMs = frameData?.latencyMs ?? 0;
  // Never invent numbers: show placeholders until a real frame or playtest result arrives.
  const sim = frameData?.simTelemetry || {
    tick: 0,
    seed: 0,
    hash: 'no playtest yet',
    entities: 0,
    credits: 0,
    paused: true,
    api: 'run a playtest to fill this',
  };

  return (
    <div
      ref={containerRef}
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: '#06080E',
        position: 'relative',
        overflow: 'hidden',
      }}
    >
      {/* Tactical HUD Top Frame */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '6px 10px',
          background: 'rgba(10, 15, 28, 0.9)',
          borderBottom: '1px solid rgba(0, 240, 255, 0.3)',
          fontSize: 11,
          gap: 8,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span style={{ color: '#00F0FF', fontWeight: 700, letterSpacing: 0.7 }}>
            👁 AGENT EYES MULTIPLEXER
          </span>
          <span
            style={{
              padding: '2px 6px',
              borderRadius: 4,
              background: 'rgba(16, 185, 129, 0.16)',
              border: '1px solid #10b981',
              color: '#34d399',
              fontSize: 10,
            }}
          >
            {fps} FPS // {latencyMs}ms
          </span>
        </div>

        {/* 4-Source Multiplexer Selector */}
        <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
          {(
            [
              { id: 'novnc', label: '1. noVNC :6080' },
              { id: 'webrtc', label: '2. WebRTC' },
              { id: 'cdp', label: '3. Playwright CDP' },
              { id: 'hmr', label: '4. HMR ?playtest=1' },
            ] as Array<{ id: ViewportSourceMode; label: string }>
          ).map((src) => {
            const active = config.activeSource === src.id;
            return (
              <button
                key={src.id}
                onClick={() => setSource(src.id)}
                style={{
                  background: active ? 'rgba(0, 240, 255, 0.2)' : 'rgba(15, 23, 42, 0.85)',
                  border: `1px solid ${active ? '#00F0FF' : '#334155'}`,
                  color: active ? '#00F0FF' : '#94a3b8',
                  borderRadius: 4,
                  padding: '3px 7px',
                  fontSize: 10,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                {src.label}
              </button>
            );
          })}

          <button
            onClick={() => setGearOpen((v) => !v)}
            title="Source Gear Menu (Saves to localStorage + .studio/war-room.config.json)"
            style={{
              background: gearOpen ? 'rgba(0, 240, 255, 0.25)' : 'rgba(15, 23, 42, 0.85)',
              border: '1px solid #0EA5E9',
              color: '#38bdf8',
              borderRadius: 4,
              padding: '3px 7px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            ⚙ Gear
          </button>

          <button
            onClick={toggleFullscreen}
            title="Toggle Fullscreen Viewport"
            style={{
              background: 'rgba(15, 23, 42, 0.85)',
              border: '1px solid #334155',
              color: '#e2e8f0',
              borderRadius: 4,
              padding: '3px 7px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            {isFullscreen ? '⤓ Exit FS' : '⤢ Fullscreen'}
          </button>
        </div>
      </div>

      {/* Persistent Source Gear Menu Popover */}
      {gearOpen && (
        <div
          style={{
            position: 'absolute',
            top: 38,
            right: 10,
            zIndex: 40,
            width: 340,
            background: 'rgba(6, 8, 14, 0.96)',
            backdropFilter: 'blur(14px)',
            border: '1px solid #00F0FF',
            borderRadius: 8,
            padding: 12,
            boxShadow: '0 14px 34px rgba(0, 0, 0, 0.8)',
            display: 'flex',
            flexDirection: 'column',
            gap: 8,
            fontSize: 11,
          }}
        >
          <div style={{ fontWeight: 700, color: '#00F0FF' }}>
            VIEWPORT SOURCE CONFIGURATION (.studio/war-room.config.json)
          </div>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ color: '#94a3b8', fontSize: 10 }}>noVNC / websockify URL:</span>
            <input
              value={config.novncUrl}
              onChange={(e) => onUpdateConfig({ novncUrl: e.target.value })}
              style={{
                background: '#020409',
                border: '1px solid #334155',
                color: '#e2e8f0',
                padding: '4px 6px',
                borderRadius: 4,
                fontFamily: 'inherit',
                fontSize: 10,
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ color: '#94a3b8', fontSize: 10 }}>WebRTC Stream Endpoint:</span>
            <input
              value={config.webrtcUrl}
              onChange={(e) => onUpdateConfig({ webrtcUrl: e.target.value })}
              style={{
                background: '#020409',
                border: '1px solid #334155',
                color: '#e2e8f0',
                padding: '4px 6px',
                borderRadius: 4,
                fontFamily: 'inherit',
                fontSize: 10,
              }}
            />
          </label>
          <label style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <span style={{ color: '#94a3b8', fontSize: 10 }}>Game HMR Dev URL (?playtest=1):</span>
            <input
              value={config.hmrUrl}
              onChange={(e) => onUpdateConfig({ hmrUrl: e.target.value })}
              style={{
                background: '#020409',
                border: '1px solid #334155',
                color: '#e2e8f0',
                padding: '4px 6px',
                borderRadius: 4,
                fontFamily: 'inherit',
                fontSize: 10,
              }}
            />
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.showUisentinelOverlay}
              onChange={(e) => onUpdateConfig({ showUisentinelOverlay: e.target.checked })}
            />
            <span>Show UISentinel Bounding-Box Overlay</span>
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 6, cursor: 'pointer' }}>
            <input
              type="checkbox"
              checked={config.showSimTelemetryOverlay}
              onChange={(e) => onUpdateConfig({ showSimTelemetryOverlay: e.target.checked })}
            />
            <span>Show `?playtest=1` (`window.__sim`) HUD Telemetry</span>
          </label>
        </div>
      )}

      {/* Primary Multiplexed Viewport Stage */}
      <div style={{ flex: 1, position: 'relative', background: '#03050a', overflow: 'hidden' }}>
        {/* 1. noVNC Live Desktop Stream */}
        {config.activeSource === 'novnc' && (
          <iframe
            title="noVNC Xvfb Live Agent Desktop Stream"
            src={config.novncUrl}
            style={{ width: '100%', height: '100%', border: 'none' }}
          />
        )}

        {/* 2. WebRTC Low-Latency Stream */}
        {config.activeSource === 'webrtc' && (
          <div
            style={{
              width: '100%',
              height: '100%',
              display: 'flex',
              flexDirection: 'column',
              alignItems: 'center',
              justifyContent: 'center',
              gap: 8,
            }}
          >
            <video
              ref={videoRef}
              autoPlay
              playsInline
              muted
              controls
              style={{ width: '100%', height: '100%', objectFit: 'contain' }}
            />
            <div
              style={{
                position: 'absolute',
                bottom: 12,
                left: 12,
                background: 'rgba(6, 8, 14, 0.85)',
                border: '1px solid #0EA5E9',
                borderRadius: 6,
                padding: '6px 10px',
                fontSize: 10,
                color: '#bae6fd',
              }}
            >
              WebRTC Receiver Ready: <code>{config.webrtcUrl}</code> (Sub-100ms WHEP/WebRTC)
            </div>
          </div>
        )}

        {/* 3. Playwright CDP Screencast / Frame Stream + UISentinel Bounding Boxes */}
        {config.activeSource === 'cdp' && (
          <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            {frameData?.frameDataUrl || frameData?.latestScreenshotUrl ? (
              <img
                src={frameData.frameDataUrl || frameData.latestScreenshotUrl || ''}
                alt="Playwright CDP Screencast Frame"
                style={{ width: '100%', height: '100%', objectFit: 'contain' }}
              />
            ) : (
              /* Synthesized 3D InstancedMesh Telemetry Canvas Preview when no PNG is on disk yet */
              <div
                style={{
                  width: '100%',
                  height: '100%',
                  background:
                    'radial-gradient(circle at 50% 42%, rgba(0, 240, 255, 0.12), rgba(6, 8, 14, 0.98) 72%)',
                  display: 'flex',
                  flexDirection: 'column',
                  alignItems: 'center',
                  justifyContent: 'center',
                  color: '#94a3b8',
                  fontSize: 11,
                  gap: 6,
                }}
              >
                <div style={{ color: '#00F0FF', fontWeight: 700 }}>
                  PLAYWRIGHT CDP SCREENCAST & UISENTINEL LAYOUT GUARD ACTIVE
                </div>
                <div>
                  Listening for high-frequency frames on <code>POST /api/frame</code> &amp;{' '}
                  <code>qa/playtest.mjs</code>
                </div>
              </div>
            )}

            {/* Interactive UISentinel Bounding-Box Overlay */}
            {config.showUisentinelOverlay &&
              (frameData?.uisentinelBoxes || []).map((box) => {
                const color =
                  box.status === 'error' ? '#ef4444' : box.status === 'warn' ? '#f59e0b' : '#10b981';
                return (
                  <div
                    key={box.id}
                    style={{
                      position: 'absolute',
                      left: `${Math.min(82, Math.max(3, (box.x / 1280) * 100))}%`,
                      top: `${Math.min(78, Math.max(6, (box.y / 720) * 100))}%`,
                      width: `${Math.min(65, Math.max(18, (box.width / 1280) * 100))}%`,
                      height: `${Math.min(60, Math.max(10, (box.height / 720) * 100))}%`,
                      border: `1px dashed ${color}`,
                      background: `${color}12`,
                      borderRadius: 4,
                      pointerEvents: 'none',
                      padding: 4,
                    }}
                  >
                    <span
                      style={{
                        fontSize: 9,
                        background: 'rgba(6, 8, 14, 0.9)',
                        color,
                        padding: '1px 5px',
                        borderRadius: 3,
                        border: `1px solid ${color}`,
                      }}
                    >
                      {box.label}
                    </span>
                  </div>
                );
              })}
          </div>
        )}

        {/* 4. Live Game HMR Iframe with Take Manual Control Toggle */}
        {config.activeSource === 'hmr' && (
          <div style={{ width: '100%', height: '100%', position: 'relative' }}>
            <iframe
              title="Live Game HMR ?playtest=1 Viewport"
              src={config.hmrUrl}
              style={{
                width: '100%',
                height: '100%',
                border: 'none',
                pointerEvents: config.manualControlEnabled ? 'auto' : 'none',
              }}
            />
            <button
              onClick={() => onUpdateConfig({ manualControlEnabled: !config.manualControlEnabled })}
              style={{
                position: 'absolute',
                top: 10,
                right: 10,
                background: config.manualControlEnabled
                  ? 'rgba(16, 185, 129, 0.25)'
                  : 'rgba(245, 158, 11, 0.22)',
                border: `1px solid ${config.manualControlEnabled ? '#10b981' : '#f59e0b'}`,
                color: config.manualControlEnabled ? '#34d399' : '#fbbf24',
                borderRadius: 5,
                padding: '4px 9px',
                fontSize: 10,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {config.manualControlEnabled ? '🎮 Manual Control: ON' : '🔒 Observer Mode (Take Control)'}
            </button>
          </div>
        )}

        {/* ?playtest=1 (window.__sim) Deterministic State HUD Overlay */}
        {config.showSimTelemetryOverlay && (
          <div
            style={{
              position: 'absolute',
              bottom: 10,
              right: 10,
              background: 'rgba(6, 8, 14, 0.88)',
              backdropFilter: 'blur(10px)',
              border: '1px solid rgba(0, 240, 255, 0.45)',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 10,
              color: '#e2e8f0',
              display: 'flex',
              gap: 12,
              alignItems: 'center',
              pointerEvents: 'none',
            }}
          >
            <span style={{ color: '#00F0FF', fontWeight: 700 }}>{sim.api}</span>
            <span>
              TICK: <strong>{sim.tick}</strong>
            </span>
            <span>
              SEED: <strong>{sim.seed}</strong>
            </span>
            <span>
              HASH: <strong style={{ color: '#34d399' }}>{sim.hash}</strong>
            </span>
            <span>
              ENTITIES: <strong>{sim.entities}</strong>
            </span>
          </div>
        )}
      </div>
    </div>
  );
};

export default AgentEyesViewport;

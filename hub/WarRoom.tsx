import React, { useEffect, useMemo, useState } from 'react';

/**
 * hub/WarRoom.tsx — 4-Quadrant Sci-Fi Mission Control HUD & Mobile Command Feed
 *
 * Passively renders `.studio/events.jsonl` (and `/tmp/agent-events.jsonl`),
 * `studio/NEXT.md`, `studio/roles/*.md`, and `freecc:auto` multi-model failover
 * state over a local SSE stream (`/api/stream`) at 0% LLM token cost.
 *
 * Modes:
 *  - DESKTOP 4-QUADRANT WAR ROOM (for YouTube devlogs & second monitors):
 *      Q1: Live Multi-Agent & Provider Node-Graph Canvas (@xyflow/react style SVG)
 *      Q2: freecc:auto Failover Router Matrix & Token-Saver Telemetry (rtk/qmd/serena)
 *      Q3: Live `studio/NEXT.md` Queue & One-Click Task Control
 *      Q4: Real-Time `.studio/events.jsonl` Stream & Two-Stage QA Bug Ledger
 *  - MOBILE COMMAND FEED (for Tailscale / Cloudflare Tunnel phone check-ins)
 */

export interface TaskItem {
  id: string;
  priority: string;
  role: string;
  title: string;
  status: 'in_progress' | 'backlog' | 'done';
}

export interface StudioEvent {
  id: string;
  ts: string;
  type: string;
  agent: string;
  provider?: string | null;
  model?: string | null;
  task?: string | null;
  status?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensSaved?: number;
  latencyMs?: number | null;
  msg: string;
}

export interface RouterRow {
  order: number;
  providerId: string;
  label: string;
  tier: string;
  model: string;
  configured: boolean;
  channels: Array<{
    channelKey: string;
    keyEnv: string;
    status: 'ready' | 'cooldown';
    cooldownRemainingSec: number;
    lastReason?: string | null;
  }>;
}

export interface StudioSnapshot {
  generatedAt: string;
  llmTokensUsedForStatus: number;
  producerPreset: string;
  rolesCount: number;
  roles: Array<{
    id: string;
    title: string;
    tier: string;
    department: string;
    swarm: string;
    modelChain: string[];
  }>;
  queue: {
    inProgress: TaskItem[];
    backlog: TaskItem[];
    done: TaskItem[];
  };
  router: RouterRow[];
  telemetry: {
    totalEvents: number;
    tokensIn: number;
    tokensOut: number;
    tokensSaved: number;
    estimatedTokensSaved: number;
    failovers: number;
    errors: number;
  };
  recentEvents: StudioEvent[];
}

export function WarRoom() {
  const [snapshot, setSnapshot] = useState<StudioSnapshot | null>(null);
  const [connected, setConnected] = useState<boolean>(false);
  const [viewMode, setViewMode] = useState<'warroom' | 'mobile'>(() => {
    if (typeof window !== 'undefined') {
      const params = new URLSearchParams(window.location.search);
      if (params.get('view') === 'mobile' || window.innerWidth < 860) return 'mobile';
    }
    return 'warroom';
  });
  const [newTaskTitle, setNewTaskTitle] = useState('');
  const [newTaskRole, setNewTaskRole] = useState('builder');

  useEffect(() => {
    let es: EventSource | null = null;
    try {
      es = new EventSource('/api/stream');
      es.onopen = () => setConnected(true);
      es.onmessage = (e) => {
        try {
          setSnapshot(JSON.parse(e.data));
          setConnected(true);
        } catch {
          // ignore malformed frame
        }
      };
      es.onerror = () => setConnected(false);
    } catch {
      setConnected(false);
    }
    return () => {
      if (es) es.close();
    };
  }, []);

  const activeAgentId = useMemo(() => {
    if (!snapshot) return 'producer';
    if (snapshot.queue.inProgress[0]) return snapshot.queue.inProgress[0].role;
    if (snapshot.recentEvents[0]) return snapshot.recentEvents[0].agent;
    return 'producer';
  }, [snapshot]);

  const activeProviderId = useMemo(() => {
    if (!snapshot) return 'vertex-gemini-pro';
    for (const evt of snapshot.recentEvents) {
      if (evt.provider) return evt.provider;
    }
    const ready = snapshot.router.find((r) => r.configured && r.channels.some((c) => c.status === 'ready'));
    return ready ? ready.providerId : 'vertex-gemini-pro';
  }, [snapshot]);

  async function triggerTaskAction(action: 'start' | 'done' | 'add', payload: Record<string, unknown>) {
    await fetch('/api/task', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action, ...payload }),
    });
  }

  async function emitSimulationPulse(type: string, agent: string, provider: string, msg: string) {
    await fetch('/api/event', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        type,
        agent,
        provider,
        tokensIn: 620,
        tokensOut: 190,
        tokensSaved: 4800,
        latencyMs: 410,
        msg,
      }),
    });
  }

  if (!snapshot) {
    return (
      <div style={{ background: '#050811', color: '#38bdf8', minHeight: '100vh', padding: 32, fontFamily: 'monospace' }}>
        INITIALIZING ZERO-TOKEN WORKFLOW UI HUB...
      </div>
    );
  }

  const activeTask = snapshot.queue.inProgress[0] || null;

  return (
    <div
      style={{
        background: 'radial-gradient(circle at 50% 0%, #0d1b2a 0%, #050811 75%)',
        color: '#e2e8f0',
        minHeight: '100vh',
        fontFamily: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace",
        display: 'flex',
        flexDirection: 'column',
      }}
    >
      {/* Top Sci-Fi Mission Control Telemetry Bar */}
      <header
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          alignItems: 'center',
          justifyContent: 'space-between',
          gap: 12,
          padding: '12px 20px',
          borderBottom: '1px solid rgba(56, 189, 248, 0.28)',
          background: 'rgba(8, 15, 30, 0.9)',
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
          <span
            style={{
              width: 11,
              height: 11,
              borderRadius: '50%',
              background: connected ? '#10b981' : '#f59e0b',
              boxShadow: connected ? '0 0 12px #10b981' : '0 0 12px #f59e0b',
              display: 'inline-block',
            }}
          />
          <div>
            <div style={{ fontSize: 15, fontWeight: 700, letterSpacing: 1.4, color: '#38bdf8' }}>
              3D DEEP-SIM AI STUDIO // MISSION CONTROL WAR ROOM
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              PRODUCER PRESET: <strong style={{ color: '#f8fafc' }}>{snapshot.producerPreset.toUpperCase()}</strong> · ROLES:{' '}
              <strong style={{ color: '#f8fafc' }}>{snapshot.rolesCount}</strong> (UNLIMITED) · PASSIVE LLM COST:{' '}
              <strong style={{ color: '#10b981' }}>0.0% TOKENS</strong>
            </div>
          </div>
        </div>

        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <div
            style={{
              padding: '5px 10px',
              borderRadius: 6,
              background: 'rgba(16, 185, 129, 0.14)',
              border: '1px solid rgba(16, 185, 129, 0.4)',
              fontSize: 12,
              color: '#34d399',
            }}
          >
            TOKENS SAVED (RTK/QMD/PASSIVE): ~{snapshot.telemetry.estimatedTokensSaved.toLocaleString()}
          </div>

          <button
            onClick={() =>
              emitSimulationPulse(
                'route.failover',
                activeAgentId,
                'nvidia-glm-flash',
                'Simulated 429 on primary -> instant freecc:auto failover to NVIDIA GLM 5.3 Flash (0 downtime)'
              )
            }
            style={{
              background: 'rgba(245, 158, 11, 0.16)',
              color: '#fbbf24',
              border: '1px solid rgba(245, 158, 11, 0.45)',
              borderRadius: 6,
              padding: '6px 10px',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            ⚡ TEST FAILOVER PULSE
          </button>

          <button
            onClick={() => setViewMode(viewMode === 'warroom' ? 'mobile' : 'warroom')}
            style={{
              background: 'rgba(56, 189, 248, 0.16)',
              color: '#38bdf8',
              border: '1px solid rgba(56, 189, 248, 0.45)',
              borderRadius: 6,
              padding: '6px 12px',
              fontSize: 11,
              cursor: 'pointer',
              fontFamily: 'inherit',
            }}
          >
            {viewMode === 'warroom' ? '📱 SWITCH TO MOBILE FEED' : '🖥️ SWITCH TO 4Q WAR ROOM'}
          </button>
        </div>
      </header>

      {/* Mobile Command Feed Mode (Phone via Tailscale / Cloudflare Tunnel) */}
      {viewMode === 'mobile' ? (
        <main style={{ padding: 16, maxWidth: 560, margin: '0 auto', width: '100%', display: 'flex', flexDirection: 'column', gap: 14 }}>
          <section style={cardStyle}>
            <div style={cardHeaderStyle}>📱 MOBILE COMMAND FEED (ZERO-TOKEN PASSIVE)</div>
            <div style={{ fontSize: 13, marginBottom: 8 }}>
              Active Role: <strong style={{ color: '#38bdf8' }}>{activeAgentId.toUpperCase()}</strong> via{' '}
              <strong style={{ color: '#a78bfa' }}>{activeProviderId}</strong>
            </div>
            {activeTask ? (
              <div style={{ background: 'rgba(56,189,248,0.1)', padding: 10, borderRadius: 6, border: '1px solid rgba(56,189,248,0.3)' }}>
                <div style={{ fontSize: 12, color: '#38bdf8', fontWeight: 700 }}>
                  IN PROGRESS: {activeTask.id} [{activeTask.priority}]
                </div>
                <div style={{ fontSize: 13, marginTop: 4 }}>{activeTask.title}</div>
                <button
                  onClick={() => triggerTaskAction('done', { id: activeTask.id })}
                  style={{ ...actionBtnStyle, marginTop: 8, background: '#059669' }}
                >
                  ✓ Mark {activeTask.id} Done
                </button>
              </div>
            ) : (
              <div style={{ fontSize: 12, color: '#94a3b8' }}>No task currently in progress.</div>
            )}
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>📋 NEXT UP IN STUDIO/NEXT.MD</div>
            {snapshot.queue.backlog.slice(0, 4).map((t) => (
              <div
                key={t.id}
                style={{
                  display: 'flex',
                  justifyContent: 'space-between',
                  alignItems: 'center',
                  padding: '8px 0',
                  borderBottom: '1px solid rgba(148,163,184,0.12)',
                  fontSize: 12,
                }}
              >
                <div>
                  <strong>{t.id}</strong> [{t.priority}] ({t.role}) — {t.title}
                </div>
                <button onClick={() => triggerTaskAction('start', { id: t.id })} style={actionBtnStyle}>
                  Start
                </button>
              </div>
            ))}
          </section>

          <section style={cardStyle}>
            <div style={cardHeaderStyle}>⚡ LIVE EVENT FEED (.studio/events.jsonl)</div>
            {snapshot.recentEvents.slice(0, 10).map((evt) => (
              <div key={evt.id} style={{ fontSize: 11, padding: '6px 0', borderBottom: '1px solid rgba(148,163,184,0.1)' }}>
                <span style={{ color: '#64748b' }}>[{evt.ts.slice(11, 19)}]</span>{' '}
                <strong style={{ color: '#38bdf8' }}>{evt.agent}</strong> · {evt.type}: {evt.msg}
              </div>
            ))}
          </section>
        </main>
      ) : (
        /* Desktop 4-Quadrant War Room Mode */
        <main
          style={{
            flex: 1,
            display: 'grid',
            gridTemplateColumns: 'repeat(2, minmax(0, 1fr))',
            gridTemplateRows: 'repeat(2, minmax(320px, 1fr))',
            gap: 14,
            padding: 14,
          }}
        >
          {/* QUADRANT 1: Live Multi-Agent & Provider Node-Graph Canvas */}
          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <span>Q1 // LIVE STUDIO ORCHESTRATION NODE GRAPH (@xyflow/react STYLE)</span>
              <span style={{ color: '#38bdf8' }}>ACTIVE: {activeAgentId.toUpperCase()}</span>
            </div>
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', minHeight: 240 }}>
              <svg viewBox="0 0 760 280" style={{ width: '100%', height: '100%', maxHeight: 270 }}>
                <defs>
                  <linearGradient id="wireActive" x1="0%" y1="0%" x2="100%" y2="0%">
                    <stop offset="0%" stopColor="#38bdf8" />
                    <stop offset="100%" stopColor="#10b981" />
                  </linearGradient>
                </defs>

                {/* Producer Node (Left) */}
                <g transform="translate(20, 105)">
                  <rect
                    width="155"
                    height="68"
                    rx="8"
                    fill="rgba(15, 23, 42, 0.95)"
                    stroke="#38bdf8"
                    strokeWidth="2"
                  />
                  <text x="14" y="25" fill="#38bdf8" fontSize="11" fontWeight="bold">
                    EXEC PRODUCER
                  </text>
                  <text x="14" y="43" fill="#f8fafc" fontSize="11">
                    Preset: {snapshot.producerPreset}
                  </text>
                  <text x="14" y="58" fill="#94a3b8" fontSize="9">
                    VISION_LOCK + NEXT.md
                  </text>
                </g>

                {/* Specialist Role Nodes (Center Column) */}
                {snapshot.roles.slice(0, 5).map((role, idx) => {
                  const y = 12 + idx * 54;
                  const isActive = role.id === activeAgentId;
                  return (
                    <g key={role.id}>
                      <line
                        x1="175"
                        y1="139"
                        x2="285"
                        y2={y + 22}
                        stroke={isActive ? 'url(#wireActive)' : 'rgba(148,163,184,0.25)'}
                        strokeWidth={isActive ? '2.5' : '1.2'}
                        strokeDasharray={isActive ? '5,3' : undefined}
                      />
                      <g transform={`translate(285, ${y})`}>
                        <rect
                          width="175"
                          height="44"
                          rx="6"
                          fill={isActive ? 'rgba(16, 185, 129, 0.16)' : 'rgba(15, 23, 42, 0.9)'}
                          stroke={isActive ? '#10b981' : 'rgba(148, 163, 184, 0.35)'}
                          strokeWidth={isActive ? '2' : '1'}
                        />
                        <text x="10" y="18" fill={isActive ? '#34d399' : '#e2e8f0'} fontSize="11" fontWeight="bold">
                          {role.id.toUpperCase()}
                        </text>
                        <text x="10" y="34" fill="#94a3b8" fontSize="9">
                          dept:{role.department} | {role.tier}
                        </text>
                      </g>
                    </g>
                  );
                })}

                {/* Provider Failover Nodes (Right Column) */}
                {snapshot.router.slice(0, 5).map((prov, idx) => {
                  const y = 12 + idx * 54;
                  const isSelected = prov.providerId === activeProviderId;
                  const activeIdx = Math.max(
                    0,
                    snapshot.roles.slice(0, 5).findIndex((r) => r.id === activeAgentId)
                  );
                  const sourceY = 12 + activeIdx * 54 + 22;
                  return (
                    <g key={prov.providerId}>
                      <line
                        x1="460"
                        y1={sourceY}
                        x2="560"
                        y2={y + 22}
                        stroke={isSelected ? '#a78bfa' : 'rgba(148,163,184,0.18)'}
                        strokeWidth={isSelected ? '2.4' : '1'}
                      />
                      <g transform={`translate(560, ${y})`}>
                        <rect
                          width="185"
                          height="44"
                          rx="6"
                          fill={isSelected ? 'rgba(167, 139, 250, 0.16)' : 'rgba(15, 23, 42, 0.9)'}
                          stroke={isSelected ? '#a78bfa' : 'rgba(148, 163, 184, 0.3)'}
                          strokeWidth={isSelected ? '2' : '1'}
                        />
                        <text x="10" y="18" fill={isSelected ? '#c4b5fd' : '#cbd5e1'} fontSize="10" fontWeight="bold">
                          #{prov.order} {prov.providerId}
                        </text>
                        <text x="10" y="34" fill="#94a3b8" fontSize="9">
                          {prov.model.slice(0, 26)} [{prov.tier}]
                        </text>
                      </g>
                    </g>
                  );
                })}
              </svg>
            </div>
          </section>

          {/* QUADRANT 2: Multi-Model Failover Router (freecc:auto) & Usage Saver Telemetry */}
          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <span>Q2 // FREECC:AUTO MULTI-MODEL FAILOVER & QUOTA SAVER</span>
              <span style={{ color: '#a78bfa' }}>FAILOVERS: {snapshot.telemetry.failovers}</span>
            </div>
            <div style={{ overflowY: 'auto', flex: 1 }}>
              <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 11 }}>
                <thead>
                  <tr style={{ color: '#94a3b8', textAlign: 'left', borderBottom: '1px solid rgba(148,163,184,0.2)' }}>
                    <th style={{ padding: '6px 4px' }}>#</th>
                    <th style={{ padding: '6px 4px' }}>Provider Channel</th>
                    <th style={{ padding: '6px 4px' }}>Model</th>
                    <th style={{ padding: '6px 4px' }}>Tier</th>
                    <th style={{ padding: '6px 4px' }}>Status</th>
                  </tr>
                </thead>
                <tbody>
                  {snapshot.router.map((r) => {
                    const cooling = r.channels.find((c) => c.status === 'cooldown');
                    const statusLabel = !r.configured
                      ? 'NO KEY (SKIP)'
                      : cooling
                        ? `COOLDOWN (${cooling.cooldownRemainingSec}s)`
                        : `READY (${r.channels.length} key)`;
                    const statusColor = !r.configured ? '#64748b' : cooling ? '#f59e0b' : '#10b981';
                    return (
                      <tr key={r.providerId} style={{ borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
                        <td style={{ padding: '6px 4px', color: '#64748b' }}>{r.order}</td>
                        <td style={{ padding: '6px 4px', fontWeight: 600 }}>{r.providerId}</td>
                        <td style={{ padding: '6px 4px', color: '#94a3b8' }}>{r.model}</td>
                        <td style={{ padding: '6px 4px', color: '#38bdf8' }}>{r.tier.toUpperCase()}</td>
                        <td style={{ padding: '6px 4px', color: statusColor, fontWeight: 700 }}>{statusLabel}</td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </section>

          {/* QUADRANT 3: Live studio/NEXT.md Task Queue & One-Click Dispatch */}
          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <span>Q3 // STUDIO/NEXT.MD QUEUE & CHECKPOINT CONTROL</span>
              <span style={{ color: '#10b981' }}>
                {snapshot.queue.inProgress.length} ACTIVE / {snapshot.queue.backlog.length} QUEUED
              </span>
            </div>

            <div style={{ display: 'flex', gap: 6, marginBottom: 10 }}>
              <input
                value={newTaskTitle}
                onChange={(e) => setNewTaskTitle(e.target.value)}
                placeholder="Add new task to studio/NEXT.md..."
                style={{
                  flex: 1,
                  background: '#091020',
                  color: '#f8fafc',
                  border: '1px solid rgba(56,189,248,0.3)',
                  borderRadius: 5,
                  padding: '5px 8px',
                  fontSize: 11,
                  fontFamily: 'inherit',
                }}
              />
              <select
                value={newTaskRole}
                onChange={(e) => setNewTaskRole(e.target.value)}
                style={{
                  background: '#091020',
                  color: '#38bdf8',
                  border: '1px solid rgba(56,189,248,0.3)',
                  borderRadius: 5,
                  padding: '5px 6px',
                  fontSize: 11,
                  fontFamily: 'inherit',
                }}
              >
                {snapshot.roles.map((r) => (
                  <option key={r.id} value={r.id}>
                    {r.id}
                  </option>
                ))}
              </select>
              <button
                onClick={() => {
                  if (!newTaskTitle.trim()) return;
                  triggerTaskAction('add', { title: newTaskTitle.trim(), role: newTaskRole, priority: 'P1' });
                  setNewTaskTitle('');
                }}
                style={actionBtnStyle}
              >
                + Queue
              </button>
            </div>

            <div style={{ overflowY: 'auto', flex: 1, display: 'flex', flexDirection: 'column', gap: 6 }}>
              {snapshot.queue.inProgress.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '7px 10px',
                    background: 'rgba(16, 185, 129, 0.13)',
                    border: '1px solid rgba(16, 185, 129, 0.4)',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                >
                  <div>
                    <strong style={{ color: '#34d399' }}>▶ {t.id}</strong> [{t.priority}] (<code>{t.role}</code>) — {t.title}
                  </div>
                  <button
                    onClick={() => triggerTaskAction('done', { id: t.id })}
                    style={{ ...actionBtnStyle, background: '#059669' }}
                  >
                    ✓ Done
                  </button>
                </div>
              ))}

              {snapshot.queue.backlog.map((t) => (
                <div
                  key={t.id}
                  style={{
                    display: 'flex',
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 10px',
                    background: 'rgba(15, 23, 42, 0.65)',
                    border: '1px solid rgba(148, 163, 184, 0.18)',
                    borderRadius: 6,
                    fontSize: 11,
                  }}
                >
                  <div>
                    <strong style={{ color: '#38bdf8' }}>{t.id}</strong> [{t.priority}] (<code>{t.role}</code>) — {t.title}
                  </div>
                  <button onClick={() => triggerTaskAction('start', { id: t.id })} style={actionBtnStyle}>
                    Start
                  </button>
                </div>
              ))}
            </div>
          </section>

          {/* QUADRANT 4: Real-Time .studio/events.jsonl Telemetry & QA Verdict Ledger */}
          <section style={cardStyle}>
            <div style={cardHeaderStyle}>
              <span>Q4 // PASSIVE EVENT LEDGER (.studio/events.jsonl) & QA GATE</span>
              <span style={{ color: snapshot.telemetry.errors > 0 ? '#f87171' : '#34d399' }}>
                EVENTS: {snapshot.telemetry.totalEvents} | ERRORS: {snapshot.telemetry.errors}
              </span>
            </div>
            <div
              style={{
                overflowY: 'auto',
                flex: 1,
                background: 'rgba(3, 7, 18, 0.75)',
                borderRadius: 6,
                padding: 10,
                fontSize: 11,
                lineHeight: 1.55,
              }}
            >
              {snapshot.recentEvents.map((e) => (
                <div key={e.id} style={{ borderBottom: '1px solid rgba(148,163,184,0.08)', padding: '3px 0' }}>
                  <span style={{ color: '#64748b' }}>[{e.ts.slice(11, 19)}]</span>{' '}
                  <span style={{ color: '#38bdf8', fontWeight: 700 }}>({e.agent})</span>{' '}
                  <span style={{ color: e.type.includes('failover') ? '#fbbf24' : '#a78bfa' }}>{e.type}</span>
                  {e.provider ? <span style={{ color: '#34d399' }}> @{e.provider}</span> : null}: {e.msg}
                </div>
              ))}
            </div>
          </section>
        </main>
      )}
    </div>
  );
}

const cardStyle: React.CSSProperties = {
  background: 'rgba(10, 18, 36, 0.88)',
  border: '1px solid rgba(56, 189, 248, 0.25)',
  borderRadius: 10,
  padding: 14,
  display: 'flex',
  flexDirection: 'column',
  boxShadow: '0 8px 28px rgba(0, 0, 0, 0.45)',
};

const cardHeaderStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  fontSize: 11,
  fontWeight: 700,
  letterSpacing: 1.1,
  color: '#94a3b8',
  paddingBottom: 8,
  marginBottom: 10,
  borderBottom: '1px solid rgba(56, 189, 248, 0.18)',
};

const actionBtnStyle: React.CSSProperties = {
  background: '#0284c7',
  color: '#f8fafc',
  border: 'none',
  borderRadius: 4,
  padding: '4px 9px',
  fontSize: 11,
  cursor: 'pointer',
  fontFamily: 'inherit',
};

export default WarRoom;

import React, { useEffect, useMemo, useState } from 'react';
import ReactFlow, { Background, Controls, MiniMap, type Edge, type Node } from 'reactflow';
import 'reactflow/dist/style.css';

/**
 * hub/WarRoom.tsx — 4-Quadrant React Flow Mission Control HUD & Mobile Command Feed
 *
 * Passively renders:
 *  - `.studio/events.jsonl` (written by `scripts/append-event.sh` & `harness/event.mjs`)
 *  - `.studio/usage.json` (Subscription & Free-Tier Quota Usage Panel)
 *  - `studio/NEXT.md` (Live Task Queue)
 *  - Live Agent View (`noVNC` stream / Latest QA Screenshot / Playtest Preview)
 *
 * Uses 0% LLM tokens.
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
  worker?: string | null;
  model?: string | null;
  task?: string | null;
  status?: string;
  tokensIn?: number;
  tokensOut?: number;
  tokensSaved?: number;
  latencyMs?: number | null;
  msg: string;
}

export interface SubscriptionEntry {
  id: string;
  name: string;
  tier: string;
  used: number;
  limit: number;
  unit: string;
  resetAt: string;
  status: string;
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
  router: Array<{
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
    }>;
  }>;
  usage?: {
    updatedAt: string;
    tokenSavers?: {
      rtkCompressionPct?: number;
      qmdRagActive?: boolean;
      serenaLspActive?: boolean;
      avoidedCheckInTokens?: number;
    };
    subscriptions?: SubscriptionEntry[];
  };
  liveView?: {
    latestScreenshot?: string | null;
    novncUrl?: string;
    playtestUrl?: string;
  };
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
  const [liveFeedMode, setLiveFeedMode] = useState<'queue' | 'screenshot' | 'novnc' | 'preview'>('queue');
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
      if (evt.provider || evt.worker) return (evt.provider || evt.worker) as string;
    }
    const ready = snapshot.router.find((r) => r.configured && r.channels.some((c) => c.status === 'ready'));
    return ready ? ready.providerId : 'vertex-gemini-pro';
  }, [snapshot]);

  const { nodes, edges } = useMemo(() => {
    if (!snapshot) return { nodes: [] as Node[], edges: [] as Edge[] };

    const rfNodes: Node[] = [
      {
        id: 'exec-producer',
        position: { x: 15, y: 110 },
        data: { label: `EXEC PRODUCER\nPreset: ${snapshot.producerPreset}` },
        style: {
          background: '#0f172a',
          color: '#38bdf8',
          border: '2px solid #38bdf8',
          borderRadius: 8,
          fontFamily: 'monospace',
          fontSize: 11,
          padding: 8,
          width: 155,
        },
      },
    ];

    const rfEdges: Edge[] = [];

    snapshot.roles.slice(0, 5).forEach((role, idx) => {
      const nodeId = `role-${role.id}`;
      const isActive = role.id === activeAgentId;
      rfNodes.push({
        id: nodeId,
        position: { x: 230, y: 10 + idx * 58 },
        data: { label: `${role.id.toUpperCase()}\n${role.department} | ${role.tier}` },
        style: {
          background: isActive ? '#064e3b' : '#0f172a',
          color: isActive ? '#34d399' : '#e2e8f0',
          border: isActive ? '2px solid #10b981' : '1px solid #334155',
          borderRadius: 6,
          fontFamily: 'monospace',
          fontSize: 10,
          padding: 6,
          width: 165,
        },
      });
      rfEdges.push({
        id: `e-prod-${role.id}`,
        source: 'exec-producer',
        target: nodeId,
        animated: isActive,
        style: { stroke: isActive ? '#10b981' : '#334155', strokeWidth: isActive ? 2 : 1 },
      });
    });

    snapshot.router.slice(0, 5).forEach((prov, idx) => {
      const provNodeId = `prov-${prov.providerId}`;
      const isSelected = prov.providerId === activeProviderId;
      rfNodes.push({
        id: provNodeId,
        position: { x: 460, y: 10 + idx * 58 },
        data: { label: `#${prov.order} ${prov.providerId}\n${prov.model.slice(0, 22)}` },
        style: {
          background: isSelected ? '#2e1065' : '#0f172a',
          color: isSelected ? '#c4b5fd' : '#cbd5e1',
          border: isSelected ? '2px solid #a78bfa' : '1px solid #334155',
          borderRadius: 6,
          fontFamily: 'monospace',
          fontSize: 10,
          padding: 6,
          width: 175,
        },
      });
      rfEdges.push({
        id: `e-role-prov-${prov.providerId}`,
        source: `role-${activeAgentId}`,
        target: provNodeId,
        animated: isSelected,
        style: { stroke: isSelected ? '#a78bfa' : '#1e293b', strokeWidth: isSelected ? 2 : 1 },
      });
    });

    return { nodes: rfNodes, edges: rfEdges };
  }, [snapshot, activeAgentId, activeProviderId]);

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

  const subscriptions = snapshot.usage?.subscriptions || [];

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
              3D DEEP-SIM AI STUDIO // REACT FLOW WAR ROOM
            </div>
            <div style={{ fontSize: 11, color: '#94a3b8' }}>
              PRODUCER: <strong style={{ color: '#f8fafc' }}>{snapshot.producerPreset.toUpperCase()}</strong> · ROLES:{' '}
              <strong style={{ color: '#f8fafc' }}>{snapshot.rolesCount}</strong> · PASSIVE LLM COST:{' '}
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
            {viewMode === 'warroom' ? '📱 MOBILE FEED' : '🖥️ 4Q WAR ROOM'}
          </button>
        </div>
      </header>

      <main
        style={{
          flex: 1,
          display: 'grid',
          gridTemplateColumns: viewMode === 'mobile' ? '1fr' : 'repeat(2, minmax(0, 1fr))',
          gridTemplateRows: viewMode === 'mobile' ? 'auto' : 'repeat(2, minmax(340px, 1fr))',
          gap: 14,
          padding: 14,
          maxWidth: viewMode === 'mobile' ? 560 : undefined,
          margin: viewMode === 'mobile' ? '0 auto' : undefined,
          width: '100%',
        }}
      >
        {/* Q1: React Flow Node-Graph Canvas */}
        <section style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span>Q1 // REACT FLOW ORCHESTRATION GRAPH (.studio/events.jsonl)</span>
            <span style={{ color: '#38bdf8' }}>ACTIVE: {activeAgentId.toUpperCase()}</span>
          </div>
          <div style={{ flex: 1, minHeight: 270, borderRadius: 8, overflow: 'hidden', background: '#05080f' }}>
            <ReactFlow nodes={nodes} edges={edges} fitView>
              <Background color="#1e293b" gap={18} />
              <Controls />
              <MiniMap nodeColor="#38bdf8" maskColor="rgba(5,8,15,0.7)" />
            </ReactFlow>
          </div>
        </section>

        {/* Q2: Subscription Usage Panel (.studio/usage.json) & freecc:auto Failover Matrix */}
        <section style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span>Q2 // SUBSCRIPTION USAGE (.studio/usage.json) & FAILOVER ROUTER</span>
            <span style={{ color: '#a78bfa' }}>FAILOVERS: {snapshot.telemetry.failovers}</span>
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 10 }}>
            {subscriptions.map((sub) => {
              const pct = Math.min(100, Math.round((sub.used / Math.max(1, sub.limit)) * 100));
              return (
                <div key={sub.id} style={{ fontSize: 11 }}>
                  <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: 3 }}>
                    <strong>{sub.name}</strong>
                    <span style={{ color: '#94a3b8' }}>
                      {sub.used} / {sub.limit} {sub.unit} ({pct}%)
                    </span>
                  </div>
                  <div style={{ height: 6, background: '#1e293b', borderRadius: 4, overflow: 'hidden' }}>
                    <div
                      style={{
                        width: `${pct}%`,
                        height: '100%',
                        background: pct > 85 ? '#f59e0b' : '#10b981',
                      }}
                    />
                  </div>
                </div>
              );
            })}
          </div>
          <div style={{ overflowY: 'auto', flex: 1 }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontSize: 10 }}>
              <thead>
                <tr style={{ color: '#94a3b8', textAlign: 'left', borderBottom: '1px solid rgba(148,163,184,0.2)' }}>
                  <th style={{ padding: '4px' }}>#</th>
                  <th style={{ padding: '4px' }}>Channel</th>
                  <th style={{ padding: '4px' }}>Model</th>
                  <th style={{ padding: '4px' }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {snapshot.router.map((r) => {
                  const cooling = r.channels.find((c) => c.status === 'cooldown');
                  const statusLabel = !r.configured
                    ? 'NO KEY'
                    : cooling
                      ? `COOLDOWN (${cooling.cooldownRemainingSec}s)`
                      : 'READY';
                  const statusColor = !r.configured ? '#64748b' : cooling ? '#f59e0b' : '#10b981';
                  return (
                    <tr key={r.providerId} style={{ borderBottom: '1px solid rgba(148,163,184,0.08)' }}>
                      <td style={{ padding: '4px', color: '#64748b' }}>{r.order}</td>
                      <td style={{ padding: '4px', fontWeight: 600 }}>{r.providerId}</td>
                      <td style={{ padding: '4px', color: '#94a3b8' }}>{r.model}</td>
                      <td style={{ padding: '4px', color: statusColor, fontWeight: 700 }}>{statusLabel}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        {/* Q3: Live Agent Viewport (Queue / Screenshot / noVNC / Playtest Preview) */}
        <section style={cardStyle}>
          <div style={cardHeaderStyle}>
            <span>Q3 // STUDIO/NEXT.MD QUEUE & LIVE AGENT VIEWPORT</span>
            <div style={{ display: 'flex', gap: 4 }}>
              {(['queue', 'screenshot', 'novnc', 'preview'] as const).map((m) => (
                <button
                  key={m}
                  onClick={() => setLiveFeedMode(m)}
                  style={{
                    ...actionBtnStyle,
                    background: liveFeedMode === m ? '#0284c7' : '#1e293b',
                    padding: '3px 7px',
                    fontSize: 10,
                  }}
                >
                  {m.toUpperCase()}
                </button>
              ))}
            </div>
          </div>

          {liveFeedMode === 'screenshot' ? (
            <div style={{ flex: 1, display: 'flex', alignItems: 'center', justifyContent: 'center', background: '#05080f', borderRadius: 6, padding: 8 }}>
              {snapshot.liveView?.latestScreenshot ? (
                <img
                  src={snapshot.liveView.latestScreenshot}
                  alt="Latest Stage-2 QA Screenshot"
                  style={{ maxWidth: '100%', maxHeight: 240, borderRadius: 6 }}
                />
              ) : (
                <div style={{ fontSize: 11, color: '#94a3b8' }}>
                  No Stage-2 screenshot in <code>qa/reports/</code> yet. Run <code>node qa/playtest.mjs</code>.
                </div>
              )}
            </div>
          ) : liveFeedMode === 'novnc' ? (
            <iframe
              src={snapshot.liveView?.novncUrl || 'http://127.0.0.1:6080/vnc.html'}
              title="Live Agent noVNC Stream"
              style={{ flex: 1, width: '100%', border: '1px solid #334155', borderRadius: 6, background: '#05080f' }}
            />
          ) : liveFeedMode === 'preview' ? (
            <iframe
              src={snapshot.liveView?.playtestUrl || 'http://127.0.0.1:5173/?playtest=1'}
              title="Live Playtest Preview"
              style={{ flex: 1, width: '100%', border: '1px solid #334155', borderRadius: 6, background: '#05080f' }}
            />
          ) : (
            <>
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
            </>
          )}
        </section>

        {/* Q4: Real-Time .studio/events.jsonl Stream */}
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
                {e.provider || e.worker ? <span style={{ color: '#34d399' }}> @{e.provider || e.worker}</span> : null}: {e.msg}
              </div>
            ))}
          </div>
        </section>
      </main>
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

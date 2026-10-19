/**
 * hub/AgentGraph.tsx — Dynamic, Uncapped Agent & Failover Node Graph (@xyflow/react)
 *
 * - Reads active roles dynamically from `studio/roles/*.md` and provider chains from
 *   `harness/models.config.mjs` (never hardcodes a fixed cap on agents).
 * - Renders the active Head Producer node at the top (with a live preset switcher for
 *   Grok Bot, Claude Opus, Gemini Argon, Cursor Ultra, or Local Swarm) connected via
 *   animated SVG data-packet wires to all active Worker Agent nodes.
 * - Animates HTTP 429/5xx failover (`freecc:auto` pattern): exhausted provider badge turns
 *   amber with a live 30s cooldown countdown while the backup provider lights up green.
 * - Clicking any node opens the slide-out Agent Inspector Drawer showing full event history,
 *   files modified, git diff preview (`/api/diff`), and cumulative `tokensSavedByRtk`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
  ReactFlow,
  Background,
  Controls,
  Handle,
  Position,
  MarkerType,
  type Node,
  type Edge,
  type NodeProps,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';

export interface ProviderChainItem {
  provider: string;
  model: string;
  coolingDown: boolean;
  cooldownRemainingMs: number;
}

export interface StudioRoleNodeData {
  slug: string;
  title: string;
  department: string;
  status: 'IDLE' | 'CODING' | 'RUNNING_VITEST' | 'PLAYTESTING' | 'FAILOVER_COOLDOWN' | string;
  activeProvider: string;
  activeModel: string;
  coolingProvider?: string | null;
  cooldownRemainingMs?: number;
  taskId?: string | null;
  targetFile?: string | null;
  lastEventAt?: string | null;
  lastMessage?: string;
  tokensSavedByRtk: number;
  filesModified: string[];
  providerChain: ProviderChainItem[];
  recentEvents: Array<{
    ts: string;
    type: string;
    agent: string;
    status?: string;
    task?: string;
    target?: string;
    tokensSaved?: number;
    msg: string;
  }>;
  isHeadProducer?: boolean;
  producerPreset?: string;
  onSelectPreset?: (presetId: string) => void;
  onInspectRole?: (slug: string) => void;
  [key: string]: unknown;
}

const PRESET_OPTIONS = [
  { id: 'grok-bot', label: 'Grok Bot (xAI Thin Producer)' },
  { id: 'claude-opus', label: 'Claude Opus 4.6 (Anthropic)' },
  { id: 'gemini-argon', label: 'Gemini Argon / 2.5 Pro (Vertex)' },
  { id: 'cursor-ultra', label: 'Cursor Ultra (Agent IDE)' },
  { id: 'local-swarm', label: 'Local Swarm (Ollama + NIM)' },
];

const STATUS_STYLE: Record<string, { border: string; glow: string; badgeBg: string; text: string }> = {
  IDLE: {
    border: '#1e293b',
    glow: 'none',
    badgeBg: 'rgba(30, 41, 59, 0.85)',
    text: '#94a3b8',
  },
  CODING: {
    border: '#00F0FF',
    glow: '0 0 18px rgba(0, 240, 255, 0.35)',
    badgeBg: 'rgba(0, 240, 255, 0.16)',
    text: '#00F0FF',
  },
  RUNNING_VITEST: {
    border: '#a855f7',
    glow: '0 0 18px rgba(168, 85, 247, 0.35)',
    badgeBg: 'rgba(168, 85, 247, 0.18)',
    text: '#d8b4fe',
  },
  PLAYTESTING: {
    border: '#10b981',
    glow: '0 0 18px rgba(16, 185, 129, 0.35)',
    badgeBg: 'rgba(16, 185, 129, 0.18)',
    text: '#34d399',
  },
  FAILOVER_COOLDOWN: {
    border: '#f59e0b',
    glow: '0 0 22px rgba(245, 158, 11, 0.45)',
    badgeBg: 'rgba(245, 158, 11, 0.22)',
    text: '#fbbf24',
  },
};

function TacticalAgentNode({ data }: NodeProps<Node<StudioRoleNodeData>>) {
  const [elapsedSec, setElapsedSec] = useState<number>(0);
  const [cooldownSec, setCooldownSec] = useState<number>(
    Math.ceil(Number(data.cooldownRemainingMs || 0) / 1000)
  );

  useEffect(() => {
    setCooldownSec(Math.ceil(Number(data.cooldownRemainingMs || 0) / 1000));
  }, [data.cooldownRemainingMs]);

  useEffect(() => {
    const timer = setInterval(() => {
      if (data.lastEventAt) {
        const diff = Math.max(0, Math.floor((Date.now() - new Date(data.lastEventAt).getTime()) / 1000));
        setElapsedSec(diff);
      }
      setCooldownSec((prev) => (prev > 0 ? prev - 1 : 0));
    }, 1000);
    return () => clearInterval(timer);
  }, [data.lastEventAt]);

  const effectiveStatus = cooldownSec > 0 ? 'FAILOVER_COOLDOWN' : data.status || 'IDLE';
  const stylePreset = STATUS_STYLE[effectiveStatus] || STATUS_STYLE.IDLE;

  return (
    <div
      onClick={() => data.onInspectRole && data.onInspectRole(data.slug)}
      style={{
        width: data.isHeadProducer ? 320 : 255,
        background: 'rgba(10, 15, 28, 0.88)',
        backdropFilter: 'blur(12px)',
        border: `1px solid ${stylePreset.border}`,
        boxShadow: stylePreset.glow,
        borderRadius: 8,
        padding: '10px 12px',
        color: '#e2e8f0',
        fontFamily: "'JetBrains Mono', monospace",
        cursor: 'pointer',
        position: 'relative',
      }}
    >
      {!data.isHeadProducer && (
        <Handle
          type="target"
          position={Position.Top}
          style={{ background: '#00F0FF', width: 8, height: 8, border: 'none' }}
        />
      )}

      {/* Header Row: Role + Status Badge */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 6 }}>
        <span
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: data.isHeadProducer ? '#00F0FF' : '#f8fafc',
            textTransform: 'uppercase',
            letterSpacing: 0.6,
          }}
        >
          {data.isHeadProducer ? '★ HEAD PRODUCER' : data.slug}
        </span>
        <span
          style={{
            fontSize: 9,
            padding: '2px 6px',
            borderRadius: 4,
            background: stylePreset.badgeBg,
            color: stylePreset.text,
            border: `1px solid ${stylePreset.border}`,
            fontWeight: 700,
          }}
        >
          {effectiveStatus}
        </span>
      </div>

      {/* Head Producer Live Preset Switcher */}
      {data.isHeadProducer && (
        <div
          style={{ marginTop: 6 }}
          onClick={(e) => e.stopPropagation()}
        >
          <select
            aria-label="Head Producer Preset Switcher"
            value={data.producerPreset || 'grok-bot'}
            onChange={(e) => data.onSelectPreset && data.onSelectPreset(e.target.value)}
            style={{
              width: '100%',
              background: '#06080E',
              color: '#00F0FF',
              border: '1px solid rgba(0, 240, 255, 0.45)',
              borderRadius: 4,
              padding: '3px 6px',
              fontSize: 10,
              fontFamily: 'inherit',
            }}
          >
            {PRESET_OPTIONS.map((opt) => (
              <option key={opt.id} value={opt.id}>
                {opt.label}
              </option>
            ))}
          </select>
        </div>
      )}

      {/* Provider Failover Chain Badges */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginTop: 7 }}>
        {(data.providerChain || []).slice(0, 3).map((entry) => {
          const isCooling = entry.coolingDown || (entry.provider === data.coolingProvider && cooldownSec > 0);
          const isActive = !isCooling && entry.provider === data.activeProvider;
          return (
            <span
              key={entry.provider}
              style={{
                fontSize: 9,
                padding: '2px 5px',
                borderRadius: 3,
                background: isCooling
                  ? 'rgba(245, 158, 11, 0.22)'
                  : isActive
                  ? 'rgba(16, 185, 129, 0.22)'
                  : 'rgba(15, 23, 42, 0.9)',
                border: `1px solid ${
                  isCooling ? '#f59e0b' : isActive ? '#10b981' : 'rgba(148, 163, 184, 0.25)'
                }`,
                color: isCooling ? '#fbbf24' : isActive ? '#34d399' : '#64748b',
              }}
            >
              {entry.provider}
              {isCooling ? ` (${cooldownSec || 30}s)` : isActive ? ' ●' : ''}
            </span>
          );
        })}
      </div>

      {/* Task ID + Target File + Runtime Timer */}
      <div
        style={{
          marginTop: 7,
          paddingTop: 6,
          borderTop: '1px solid rgba(14, 165, 233, 0.2)',
          fontSize: 10,
          color: '#94a3b8',
          display: 'flex',
          flexDirection: 'column',
          gap: 2,
        }}
      >
        <div style={{ display: 'flex', justifyContent: 'space-between' }}>
          <span>
            Task: <strong style={{ color: '#e2e8f0' }}>{data.taskId || 'STANDBY'}</strong>
          </span>
          <span style={{ color: '#38bdf8' }}>T+{elapsedSec}s</span>
        </div>
        <div
          style={{
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
            color: '#64748b',
          }}
          title={data.targetFile || 'studio/NEXT.md'}
        >
          target: <span style={{ color: '#cbd5e1' }}>{data.targetFile || 'studio/NEXT.md'}</span>
        </div>
      </div>

      {data.isHeadProducer && (
        <Handle
          type="source"
          position={Position.Bottom}
          style={{ background: '#00F0FF', width: 8, height: 8, border: 'none' }}
        />
      )}
    </div>
  );
}

const nodeTypes = { tacticalRole: TacticalAgentNode };

export interface AgentGraphProps {
  roles: StudioRoleNodeData[];
  producerPreset: string;
  onSwitchPreset: (presetId: string) => void;
  onSimulateFailover: () => void;
}

export const AgentGraph: React.FC<AgentGraphProps> = ({
  roles,
  producerPreset,
  onSwitchPreset,
  onSimulateFailover,
}) => {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const [gitDiff, setGitDiff] = useState<string>('');
  const [loadingDiff, setLoadingDiff] = useState<boolean>(false);

  const selectedRole = useMemo(
    () => roles.find((r) => r.slug === selectedSlug) || null,
    [roles, selectedSlug]
  );

  useEffect(() => {
    if (!selectedRole) return;
    setLoadingDiff(true);
    const fileParam = selectedRole.targetFile ? `?file=${encodeURIComponent(selectedRole.targetFile)}` : '';
    fetch(`/api/diff${fileParam}`)
      .then((r) => r.json())
      .then((res) => {
        setGitDiff(res.diff || 'No diff output.');
        setLoadingDiff(false);
      })
      .catch(() => {
        setGitDiff('Unable to load git diff preview.');
        setLoadingDiff(false);
      });
  }, [selectedRole]);

  const { nodes, edges } = useMemo(() => {
    const producer =
      roles.find((r) => r.slug === 'producer') ||
      roles[0] || {
        slug: 'producer',
        title: 'Executive Producer',
        department: 'direction',
        status: 'CODING',
        activeProvider: 'xai-grok',
        activeModel: 'grok-4-latest',
        tokensSavedByRtk: 42000,
        filesModified: ['studio/NEXT.md'],
        providerChain: [],
        recentEvents: [],
      };

    const workers = roles.filter((r) => r.slug !== producer.slug);
    const spacingX = 275;
    const totalWidth = Math.max(1, workers.length - 1) * spacingX;
    const startX = 360 - totalWidth / 2;

    const builtNodes: Node<StudioRoleNodeData>[] = [
      {
        id: producer.slug,
        type: 'tacticalRole',
        position: { x: 295, y: 18 },
        data: {
          ...producer,
          isHeadProducer: true,
          producerPreset,
          onSelectPreset: onSwitchPreset,
          onInspectRole: setSelectedSlug,
        },
      },
      ...workers.map((w, idx) => ({
        id: w.slug,
        type: 'tacticalRole',
        position: {
          x: startX + idx * spacingX,
          y: 195 + (idx % 2) * 28,
        },
        data: {
          ...w,
          isHeadProducer: false,
          onInspectRole: setSelectedSlug,
        },
      })),
    ];

    const builtEdges: Edge[] = workers.map((w) => {
      const isCooling = w.status === 'FAILOVER_COOLDOWN' || (w.cooldownRemainingMs || 0) > 0;
      const isActive = w.status !== 'IDLE';
      const stroke = isCooling ? '#f59e0b' : isActive ? '#00F0FF' : '#0EA5E9';
      return {
        id: `wire-${producer.slug}-${w.slug}`,
        source: producer.slug,
        target: w.slug,
        animated: true,
        style: { stroke, strokeWidth: isActive ? 2.2 : 1.4 },
        markerEnd: { type: MarkerType.ArrowClosed, color: stroke },
      };
    });

    return { nodes: builtNodes, edges: builtEdges };
  }, [roles, producerPreset, onSwitchPreset]);

  return (
    <div style={{ width: '100%', height: '100%', position: 'relative' }}>
      {/* Top Tactical Overlay Controls */}
      <div
        style={{
          position: 'absolute',
          top: 8,
          left: 10,
          right: 10,
          zIndex: 10,
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          pointerEvents: 'none',
        }}
      >
        <div
          style={{
            pointerEvents: 'auto',
            background: 'rgba(6, 8, 14, 0.85)',
            border: '1px solid rgba(0, 240, 255, 0.35)',
            borderRadius: 6,
            padding: '4px 8px',
            fontSize: 11,
            color: '#00F0FF',
          }}
        >
          UNCAPPED SWARM TOPOLOGY ({roles.length} ROLES ACTIVE)
        </div>
        <button
          onClick={onSimulateFailover}
          style={{
            pointerEvents: 'auto',
            background: 'rgba(245, 158, 11, 0.16)',
            border: '1px solid #f59e0b',
            color: '#fbbf24',
            borderRadius: 5,
            padding: '4px 8px',
            fontSize: 10,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
          title="Simulate HTTP 429 Failover (30s Cooldown -> Backup Provider)"
        >
          ⚡ Test 429 Failover (30s)
        </button>
      </div>

      <ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView>
        <Background color="#0f172a" gap={20} />
        <Controls />
      </ReactFlow>

      {/* Slide-out Agent Inspector Drawer */}
      {selectedRole && (
        <aside
          aria-label="Agent Inspector Drawer"
          style={{
            position: 'absolute',
            top: 0,
            right: 0,
            bottom: 0,
            width: 'min(420px, 92%)',
            background: 'rgba(6, 8, 14, 0.96)',
            backdropFilter: 'blur(16px)',
            borderLeft: '1px solid #00F0FF',
            boxShadow: '-12px 0 32px rgba(0, 0, 0, 0.75)',
            zIndex: 30,
            padding: 14,
            display: 'flex',
            flexDirection: 'column',
            gap: 10,
            overflowY: 'auto',
          }}
        >
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <div>
              <div style={{ fontSize: 13, fontWeight: 700, color: '#00F0FF' }}>
                AGENT INSPECTOR // {selectedRole.slug.toUpperCase()}
              </div>
              <div style={{ fontSize: 11, color: '#94a3b8' }}>
                {selectedRole.title} ({selectedRole.department})
              </div>
            </div>
            <button
              onClick={() => setSelectedSlug(null)}
              style={{
                background: 'transparent',
                border: '1px solid #334155',
                color: '#e2e8f0',
                borderRadius: 4,
                padding: '3px 8px',
                cursor: 'pointer',
                fontFamily: 'inherit',
              }}
            >
              ✕ Close
            </button>
          </div>

          <div
            style={{
              display: 'grid',
              gridTemplateColumns: '1fr 1fr',
              gap: 8,
              background: 'rgba(15, 23, 42, 0.75)',
              padding: 8,
              borderRadius: 6,
              border: '1px solid rgba(14, 165, 233, 0.25)',
              fontSize: 11,
            }}
          >
            <div>
              <div style={{ color: '#64748b', fontSize: 10 }}>RTK Tokens Saved</div>
              <div style={{ color: '#34d399', fontWeight: 700 }}>
                {Number(selectedRole.tokensSavedByRtk || 0).toLocaleString()} tok
              </div>
            </div>
            <div>
              <div style={{ color: '#64748b', fontSize: 10 }}>Active Model</div>
              <div style={{ color: '#38bdf8', fontWeight: 700 }}>
                {selectedRole.activeProvider} / {selectedRole.activeModel}
              </div>
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#0EA5E9', marginBottom: 4 }}>
              FILES MODIFIED ({selectedRole.filesModified?.length || 0})
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {(selectedRole.filesModified?.length ? selectedRole.filesModified : ['studio/NEXT.md']).map(
                (file) => (
                  <span
                    key={file}
                    style={{
                      fontSize: 10,
                      padding: '2px 6px',
                      background: 'rgba(14, 165, 233, 0.14)',
                      border: '1px solid rgba(14, 165, 233, 0.35)',
                      borderRadius: 4,
                      color: '#bae6fd',
                    }}
                  >
                    {file}
                  </span>
                )
              )}
            </div>
          </div>

          <div>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#0EA5E9', marginBottom: 4 }}>
              GIT DIFF PREVIEW
            </div>
            <pre
              style={{
                margin: 0,
                padding: 8,
                background: '#020409',
                border: '1px solid #1e293b',
                borderRadius: 6,
                fontSize: 10,
                color: '#cbd5e1',
                maxHeight: 160,
                overflow: 'auto',
                whiteSpace: 'pre-wrap',
              }}
            >
              {loadingDiff ? 'Loading git diff...' : gitDiff}
            </pre>
          </div>

          <div style={{ flex: 1 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: '#0EA5E9', marginBottom: 4 }}>
              RECENT ROLE EVENTS
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {(selectedRole.recentEvents || []).map((evt, i) => (
                <div
                  key={`${evt.ts}-${i}`}
                  style={{
                    padding: 6,
                    background: 'rgba(15, 23, 42, 0.65)',
                    borderLeft: '2px solid #00F0FF',
                    borderRadius: 4,
                    fontSize: 10,
                  }}
                >
                  <div style={{ color: '#64748b' }}>
                    [{evt.ts?.slice(11, 19)}] <strong style={{ color: '#e2e8f0' }}>{evt.type}</strong>
                  </div>
                  <div style={{ color: '#cbd5e1', marginTop: 2 }}>{evt.msg}</div>
                </div>
              ))}
            </div>
          </div>
        </aside>
      )}
    </div>
  );
};

export default AgentGraph;

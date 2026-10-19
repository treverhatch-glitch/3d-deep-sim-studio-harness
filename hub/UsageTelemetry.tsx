/**
 * hub/UsageTelemetry.tsx — Subscription Quota & Token-Saver Telemetry Bar
 *
 * - Reads `.studio/usage.json` (served and hot-reloaded via `/api/usage`) and `.studio/events.jsonl`.
 * - Displays color-coded progress bars, remaining credits/percentages, and reset timers for
 *   Grok/xAI, Cursor Ultra, Claude, Google Vertex ($300 credit), NVIDIA NIM (Free Tier), and Groq.
 * - Includes the "RTK + QMD + Serena Efficiency Meter" showing total input tokens saved today,
 *   compression percentage (`84% Bash Saved via RTK`), and estimated dollar value preserved.
 * - Includes an interactive `<dialog closedby="any">` modal (with Safari light-dismiss fallback
 *   and CSS scroll-chaining containment) to add/edit provider quotas and write back to `.studio/usage.json`.
 */

import React, { useEffect, useRef, useState } from 'react';

export interface SubscriptionQuotaItem {
  id: string;
  name: string;
  tier: string;
  used: number;
  limit: number;
  unit: string;
  resetAt: string;
  status: string;
}

export interface UsagePayload {
  updatedAt: string;
  zeroTokenHubActive: boolean;
  tokenSavers: {
    rtkCompressionPct: number;
    qmdRagActive: boolean;
    serenaLspActive: boolean;
    avoidedCheckInTokens: number;
    tokensSavedToday?: number;
    estimatedDollarsPreserved?: number;
  };
  subscriptions: SubscriptionQuotaItem[];
}

export interface UsageTelemetryProps {
  usage: UsagePayload;
  estimatedTokensSaved: number;
  onSaveUsage: (nextUsage: UsagePayload) => Promise<void>;
}

export const UsageTelemetry: React.FC<UsageTelemetryProps> = ({
  usage,
  estimatedTokensSaved,
  onSaveUsage,
}) => {
  const dialogRef = useRef<HTMLDialogElement | null>(null);
  const [draftSubs, setDraftSubs] = useState<SubscriptionQuotaItem[]>(usage.subscriptions || []);
  const [rtkPct, setRtkPct] = useState<number>(usage.tokenSavers?.rtkCompressionPct ?? 84);

  useEffect(() => {
    setDraftSubs(usage.subscriptions || []);
    setRtkPct(usage.tokenSavers?.rtkCompressionPct ?? 84);
  }, [usage]);

  // Fallback for browsers without native <dialog closedby="any"> support
  useEffect(() => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    if (!('closedBy' in HTMLDialogElement.prototype)) {
      const handleBackdropClick = (event: MouseEvent) => {
        if (event.target !== dialog) return;
        const rect = dialog.getBoundingClientRect();
        const isDialogContent =
          rect.top <= event.clientY &&
          event.clientY <= rect.top + rect.height &&
          rect.left <= event.clientX &&
          event.clientX <= rect.left + rect.width;
        if (!isDialogContent) {
          dialog.close();
        }
      };
      dialog.addEventListener('click', handleBackdropClick);
      return () => dialog.removeEventListener('click', handleBackdropClick);
    }
  }, []);

  const openModal = () => {
    dialogRef.current?.showModal();
  };

  const closeModal = () => {
    dialogRef.current?.close();
  };

  const handleSave = async (e: React.FormEvent) => {
    e.preventDefault();
    await onSaveUsage({
      ...usage,
      tokenSavers: {
        ...usage.tokenSavers,
        rtkCompressionPct: Number(rtkPct),
      },
      subscriptions: draftSubs,
    });
    closeModal();
  };

  const addDraftProvider = () => {
    setDraftSubs((prev) => [
      ...prev,
      {
        id: `provider-${Date.now()}`,
        name: 'New Model Provider',
        tier: 'Custom BYOK / Free Tier',
        used: 0,
        limit: 1000,
        unit: 'req/day',
        resetAt: 'Daily UTC',
        status: 'healthy',
      },
    ]);
  };

  const tokensSavedToday = Math.max(
    estimatedTokensSaved,
    Number(usage.tokenSavers?.tokensSavedToday || 0),
    Number(usage.tokenSavers?.avoidedCheckInTokens || 0)
  );
  const dollarsPreserved =
    usage.tokenSavers?.estimatedDollarsPreserved ?? Number(((tokensSavedToday / 1_000_000) * 15).toFixed(2));

  return (
    <section
      style={{
        background: 'rgba(10, 15, 28, 0.88)',
        backdropFilter: 'blur(12px)',
        borderBottom: '1px solid rgba(0, 240, 255, 0.3)',
        padding: '8px 12px',
        display: 'flex',
        flexDirection: 'column',
        gap: 8,
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Top Row: RTK + QMD + Serena Efficiency Meter + Edit Quotas Button */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          flexWrap: 'wrap',
          gap: 8,
        }}
      >
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, flexWrap: 'wrap' }}>
          <span
            style={{
              fontSize: 11,
              fontWeight: 700,
              color: '#00F0FF',
              letterSpacing: 0.6,
            }}
          >
            ⚡ RTK + QMD + SERENA EFFICIENCY METER
          </span>
          <span
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 4,
              background: 'rgba(16, 185, 129, 0.18)',
              border: '1px solid #10b981',
              color: '#34d399',
              fontWeight: 700,
            }}
          >
            {usage.tokenSavers?.rtkCompressionPct ?? 84}% Bash Saved via RTK
          </span>
          <span style={{ fontSize: 11, color: '#e2e8f0' }}>
            Tokens Saved Today: <strong style={{ color: '#38bdf8' }}>{tokensSavedToday.toLocaleString()}</strong>
          </span>
          <span style={{ fontSize: 11, color: '#e2e8f0' }}>
            Value Preserved: <strong style={{ color: '#34d399' }}>${dollarsPreserved}</strong>
          </span>
        </div>

        <button
          onClick={openModal}
          style={{
            background: 'rgba(0, 240, 255, 0.14)',
            border: '1px solid #00F0FF',
            color: '#00F0FF',
            borderRadius: 4,
            padding: '3px 9px',
            fontSize: 10,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          ✎ Edit Quotas (.studio/usage.json)
        </button>
      </div>

      {/* 6-Provider Subscription Quota Grid */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(195px, 1fr))',
          gap: 8,
        }}
      >
        {(usage.subscriptions || []).map((sub) => {
          const pct = Math.min(100, Math.round((Number(sub.used) / Math.max(1, Number(sub.limit))) * 100));
          const remainPct = Math.max(0, 100 - pct);
          const barColor = pct >= 85 ? '#ef4444' : pct >= 65 ? '#f59e0b' : '#00F0FF';

          return (
            <div
              key={sub.id}
              style={{
                background: 'rgba(6, 8, 14, 0.85)',
                border: '1px solid rgba(14, 165, 233, 0.28)',
                borderRadius: 6,
                padding: '6px 8px',
                fontSize: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', gap: 4 }}>
                <strong
                  style={{
                    color: '#f8fafc',
                    whiteSpace: 'nowrap',
                    overflow: 'hidden',
                    textOverflow: 'ellipsis',
                  }}
                  title={sub.name}
                >
                  {sub.name}
                </strong>
                <span style={{ color: barColor, fontWeight: 700 }}>{remainPct}% left</span>
              </div>
              <div
                style={{
                  height: 5,
                  background: '#0f172a',
                  borderRadius: 3,
                  overflow: 'hidden',
                  margin: '5px 0',
                }}
              >
                <div
                  style={{
                    width: `${pct}%`,
                    height: '100%',
                    background: barColor,
                    transition: 'width 0.25s ease',
                  }}
                />
              </div>
              <div style={{ display: 'flex', justifyContent: 'space-between', color: '#94a3b8', fontSize: 9 }}>
                <span>
                  {sub.used} / {sub.limit} {sub.unit}
                </span>
                <span>↻ {sub.resetAt}</span>
              </div>
            </div>
          );
        })}
      </div>

      {/* Modal Dialog to Edit/Add Quotas in .studio/usage.json */}
      <dialog
        ref={dialogRef}
        // @ts-expect-error HTMLDialogElement closedby attribute
        closedby="any"
        aria-labelledby="quotaModalTitle"
        style={{
          background: '#06080E',
          color: '#e2e8f0',
          border: '1px solid #00F0FF',
          borderRadius: 8,
          padding: 16,
          width: 'min(680px, 94vw)',
          maxHeight: '84vh',
          overscrollBehavior: 'contain',
          fontFamily: "'JetBrains Mono', monospace",
        }}
      >
        <form onSubmit={handleSave} style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <h3 id="quotaModalTitle" style={{ margin: 0, fontSize: 13, color: '#00F0FF' }}>
              CONFIGURE SUBSCRIPTION QUOTAS (.studio/usage.json)
            </h3>
            <button
              type="button"
              onClick={closeModal}
              style={{
                background: 'transparent',
                border: '1px solid #334155',
                color: '#94a3b8',
                borderRadius: 4,
                padding: '2px 8px',
                cursor: 'pointer',
              }}
            >
              ✕
            </button>
          </div>

          <div style={{ display: 'flex', flexDirection: 'column', gap: 8, maxHeight: '52vh', overflowY: 'auto' }}>
            {draftSubs.map((sub, idx) => (
              <div
                key={sub.id}
                style={{
                  display: 'grid',
                  gridTemplateColumns: '2fr 1fr 1fr 1.2fr',
                  gap: 6,
                  background: '#0a0f1c',
                  padding: 8,
                  borderRadius: 6,
                  border: '1px solid #1e293b',
                  fontSize: 10,
                }}
              >
                <input
                  value={sub.name}
                  onChange={(e) => {
                    const next = [...draftSubs];
                    next[idx] = { ...sub, name: e.target.value };
                    setDraftSubs(next);
                  }}
                  placeholder="Provider Name"
                  style={{ background: '#020409', border: '1px solid #334155', color: '#e2e8f0', padding: 4 }}
                />
                <input
                  type="number"
                  step="any"
                  value={sub.used}
                  onChange={(e) => {
                    const next = [...draftSubs];
                    next[idx] = { ...sub, used: Number(e.target.value) };
                    setDraftSubs(next);
                  }}
                  placeholder="Used"
                  style={{ background: '#020409', border: '1px solid #334155', color: '#e2e8f0', padding: 4 }}
                />
                <input
                  type="number"
                  step="any"
                  value={sub.limit}
                  onChange={(e) => {
                    const next = [...draftSubs];
                    next[idx] = { ...sub, limit: Number(e.target.value) };
                    setDraftSubs(next);
                  }}
                  placeholder="Limit"
                  style={{ background: '#020409', border: '1px solid #334155', color: '#e2e8f0', padding: 4 }}
                />
                <input
                  value={sub.resetAt}
                  onChange={(e) => {
                    const next = [...draftSubs];
                    next[idx] = { ...sub, resetAt: e.target.value };
                    setDraftSubs(next);
                  }}
                  placeholder="Reset Timer"
                  style={{ background: '#020409', border: '1px solid #334155', color: '#e2e8f0', padding: 4 }}
                />
              </div>
            ))}
          </div>

          <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 6 }}>
            <button
              type="button"
              onClick={addDraftProvider}
              style={{
                background: 'rgba(14, 165, 233, 0.16)',
                border: '1px solid #0EA5E9',
                color: '#38bdf8',
                borderRadius: 4,
                padding: '5px 10px',
                fontSize: 10,
                cursor: 'pointer',
              }}
            >
              + Add Provider Quota
            </button>
            <div style={{ display: 'flex', gap: 8 }}>
              <button
                type="button"
                onClick={closeModal}
                style={{
                  background: 'transparent',
                  border: '1px solid #334155',
                  color: '#94a3b8',
                  borderRadius: 4,
                  padding: '5px 12px',
                  fontSize: 10,
                  cursor: 'pointer',
                }}
              >
                Cancel
              </button>
              <button
                type="submit"
                style={{
                  background: 'rgba(0, 240, 255, 0.22)',
                  border: '1px solid #00F0FF',
                  color: '#00F0FF',
                  borderRadius: 4,
                  padding: '5px 12px',
                  fontSize: 10,
                  fontWeight: 700,
                  cursor: 'pointer',
                }}
              >
                Save to .studio/usage.json
              </button>
            </div>
          </div>
        </form>
      </dialog>
    </section>
  );
};

export default UsageTelemetry;

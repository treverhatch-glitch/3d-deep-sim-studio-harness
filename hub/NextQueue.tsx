/**
 * hub/NextQueue.tsx — "What's Next" Pipeline & External Context Health Status
 *
 * - Live Kanban & Queue panel wired to `studio/NEXT.md`, `studio/CURRENT_TASK.md`,
 *   and `studio/done/`.
 * - Includes the "Context Health Indicator" showing the last update timestamp of
 *   `studio/CURRENT_TASK.md`, `studio/VISION_LOCK.md`, and `studio/llms.txt` so the
 *   developer knows external memory is synced before context compaction.
 */

import React, { useState } from 'react';

export interface QueueTaskItem {
  id: string;
  priority: string;
  role: string;
  title: string;
}

export interface ContextHealthItem {
  id: string;
  label: string;
  relPath: string;
  exists: boolean;
  updatedAt: string | null;
  ageSec: number | null;
  status: 'synced' | 'warm' | 'stale' | 'missing';
}

export interface NextQueueProps {
  queue: {
    inProgress: QueueTaskItem[];
    backlog: QueueTaskItem[];
    done: QueueTaskItem[];
  };
  contextHealth: ContextHealthItem[];
  roles: string[];
  onStartTask: (id: string) => void;
  onCompleteTask: (id: string) => void;
  onAddTask: (task: { title: string; role: string; priority: string }) => void;
}

export const NextQueue: React.FC<NextQueueProps> = ({
  queue,
  contextHealth,
  roles,
  onStartTask,
  onCompleteTask,
  onAddTask,
}) => {
  const [newTitle, setNewTitle] = useState('');
  const [newRole, setNewRole] = useState('builder');
  const [newPriority, setNewPriority] = useState('P1');

  const handleAdd = (e: React.FormEvent) => {
    e.preventDefault();
    if (!newTitle.trim()) return;
    onAddTask({ title: newTitle.trim(), role: newRole, priority: newPriority });
    setNewTitle('');
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(6, 8, 14, 0.92)',
        padding: 10,
        gap: 10,
        overflowY: 'auto',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Context Health Indicator Bar */}
      <div
        style={{
          background: 'rgba(10, 15, 28, 0.9)',
          border: '1px solid rgba(0, 240, 255, 0.3)',
          borderRadius: 6,
          padding: 8,
        }}
      >
        <div
          style={{
            fontSize: 11,
            fontWeight: 700,
            color: '#00F0FF',
            marginBottom: 6,
            display: 'flex',
            justifyContent: 'space-between',
          }}
        >
          <span>🧠 EXTERNAL CONTEXT HEALTH INDICATOR</span>
          <span style={{ color: '#34d399', fontSize: 10 }}>PRE-COMPACT SAFE</span>
        </div>
        <div
          style={{
            display: 'grid',
            gridTemplateColumns: 'repeat(auto-fit, minmax(150px, 1fr))',
            gap: 6,
          }}
        >
          {(contextHealth || []).map((item) => {
            const badgeColor =
              item.status === 'synced'
                ? '#10b981'
                : item.status === 'warm'
                ? '#38bdf8'
                : item.status === 'stale'
                ? '#f59e0b'
                : '#ef4444';
            return (
              <div
                key={item.id}
                style={{
                  background: '#05070d',
                  border: `1px solid ${badgeColor}55`,
                  borderRadius: 4,
                  padding: '4px 6px',
                  fontSize: 9,
                }}
              >
                <div style={{ color: '#e2e8f0', fontWeight: 700 }}>{item.label}</div>
                <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 2, color: '#94a3b8' }}>
                  <span style={{ color: badgeColor, textTransform: 'uppercase' }}>{item.status}</span>
                  <span>{item.updatedAt ? item.updatedAt.slice(11, 19) : 'missing'}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Quick Enqueue Form */}
      <form
        onSubmit={handleAdd}
        style={{
          display: 'flex',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <select
          value={newPriority}
          onChange={(e) => setNewPriority(e.target.value)}
          style={{
            background: '#020409',
            border: '1px solid #334155',
            color: '#00F0FF',
            borderRadius: 4,
            padding: '4px 6px',
            fontSize: 10,
            fontFamily: 'inherit',
          }}
        >
          <option value="P0">P0</option>
          <option value="P1">P1</option>
          <option value="P2">P2</option>
        </select>
        <select
          value={newRole}
          onChange={(e) => setNewRole(e.target.value)}
          style={{
            background: '#020409',
            border: '1px solid #334155',
            color: '#cbd5e1',
            borderRadius: 4,
            padding: '4px 6px',
            fontSize: 10,
            fontFamily: 'inherit',
          }}
        >
          {(roles.length ? roles : ['producer', 'designer-calibrator', 'builder', 'qa-playtester', 'reviewer']).map(
            (r) => (
              <option key={r} value={r}>
                {r}
              </option>
            )
          )}
        </select>
        <input
          value={newTitle}
          onChange={(e) => setNewTitle(e.target.value)}
          placeholder="Add task to studio/NEXT.md..."
          style={{
            flex: 1,
            minWidth: 160,
            background: '#020409',
            border: '1px solid #334155',
            color: '#e2e8f0',
            borderRadius: 4,
            padding: '4px 8px',
            fontSize: 10,
            fontFamily: 'inherit',
          }}
        />
        <button
          type="submit"
          style={{
            background: 'rgba(0, 240, 255, 0.18)',
            border: '1px solid #00F0FF',
            color: '#00F0FF',
            borderRadius: 4,
            padding: '4px 10px',
            fontSize: 10,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
        >
          + Enqueue
        </button>
      </form>

      {/* 3-Column Kanban Pipeline (IN_PROGRESS / BACKLOG / DONE) */}
      <div
        style={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(210px, 1fr))',
          gap: 8,
          flex: 1,
        }}
      >
        {/* IN PROGRESS */}
        <div
          style={{
            background: 'rgba(10, 15, 28, 0.75)',
            border: '1px solid rgba(0, 240, 255, 0.35)',
            borderRadius: 6,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: '#00F0FF' }}>
            IN_PROGRESS ({queue.inProgress?.length || 0})
          </div>
          {(queue.inProgress || []).map((t) => (
            <div
              key={t.id}
              style={{
                background: '#05070d',
                borderLeft: '3px solid #00F0FF',
                borderRadius: 4,
                padding: 7,
                fontSize: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong style={{ color: '#00F0FF' }}>
                  {t.id} [{t.priority}]
                </strong>
                <span style={{ color: '#38bdf8' }}>{t.role}</span>
              </div>
              <div style={{ color: '#cbd5e1', margin: '4px 0' }}>{t.title}</div>
              <button
                onClick={() => onCompleteTask(t.id)}
                style={{
                  background: 'rgba(16, 185, 129, 0.18)',
                  border: '1px solid #10b981',
                  color: '#34d399',
                  borderRadius: 3,
                  padding: '2px 6px',
                  fontSize: 9,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                ✓ Complete Task
              </button>
            </div>
          ))}
        </div>

        {/* BACKLOG */}
        <div
          style={{
            background: 'rgba(10, 15, 28, 0.75)',
            border: '1px solid rgba(14, 165, 233, 0.25)',
            borderRadius: 6,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: '#38bdf8' }}>
            BACKLOG ({queue.backlog?.length || 0})
          </div>
          {(queue.backlog || []).map((t) => (
            <div
              key={t.id}
              style={{
                background: '#05070d',
                borderLeft: '3px solid #38bdf8',
                borderRadius: 4,
                padding: 7,
                fontSize: 10,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong style={{ color: '#e2e8f0' }}>
                  {t.id} [{t.priority}]
                </strong>
                <span style={{ color: '#94a3b8' }}>{t.role}</span>
              </div>
              <div style={{ color: '#cbd5e1', margin: '4px 0' }}>{t.title}</div>
              <button
                onClick={() => onStartTask(t.id)}
                style={{
                  background: 'rgba(0, 240, 255, 0.16)',
                  border: '1px solid #00F0FF',
                  color: '#00F0FF',
                  borderRadius: 3,
                  padding: '2px 6px',
                  fontSize: 9,
                  fontFamily: 'inherit',
                  cursor: 'pointer',
                }}
              >
                ▶ Start Task
              </button>
            </div>
          ))}
        </div>

        {/* DONE ARCHIVE */}
        <div
          style={{
            background: 'rgba(10, 15, 28, 0.75)',
            border: '1px solid rgba(16, 185, 129, 0.25)',
            borderRadius: 6,
            padding: 8,
            display: 'flex',
            flexDirection: 'column',
            gap: 6,
          }}
        >
          <div style={{ fontSize: 10, fontWeight: 700, color: '#34d399' }}>
            DONE / ARCHIVED ({queue.done?.length || 0})
          </div>
          {(queue.done || []).slice(0, 6).map((t) => (
            <div
              key={t.id}
              style={{
                background: '#05070d',
                borderLeft: '3px solid #10b981',
                borderRadius: 4,
                padding: 7,
                fontSize: 10,
                opacity: 0.85,
              }}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between' }}>
                <strong style={{ color: '#34d399' }}>{t.id}</strong>
                <span style={{ color: '#64748b' }}>{t.role}</span>
              </div>
              <div style={{ color: '#94a3b8', marginTop: 2 }}>{t.title}</div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

export default NextQueue;

/**
 * hub/TerminalDock.tsx — Built-In Cyberpunk Terminal Dock & Command Deck (xterm.js)
 *
 * Uses `@xterm/xterm` + `@xterm/addon-fit` connected via WebSocket to `hub/server.js`:
 *   - Tab 1 (Live Agent Event & Bash Stream): Color-coded real-time stream of
 *     `.studio/events.jsonl` with instant regex and role filtering.
 *   - Tab 2 (Interactive Studio Shell): Live local shell bridge with a safe
 *     Read-Only lock toggle for public tunnels + 1-click tactical macro buttons:
 *       [▶ Pull Next Task], [🧪 Run ?playtest=1], [⚡ RTK Gain Stats],
 *       [💾 Pre-Compact Checkpoint], and [🔄 Switch Head Producer].
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Terminal } from '@xterm/xterm';
import { FitAddon } from '@xterm/addon-fit';
import '@xterm/xterm/css/xterm.css';

export interface StudioEventRecord {
  ts: string;
  type: string;
  agent: string;
  provider?: string;
  model?: string;
  status?: string;
  task?: string;
  target?: string;
  tokensSaved?: number;
  msg: string;
}

export interface TerminalDockProps {
  events: StudioEventRecord[];
  roles: string[];
  readOnlyShell: boolean;
  onToggleReadOnly: (next: boolean) => void;
  onRunMacro: (macro: string) => void;
  onSendShellCommand: (command: string) => void;
  shellStreamChunks: string[];
}

export const TerminalDock: React.FC<TerminalDockProps> = ({
  events,
  roles,
  readOnlyShell,
  onToggleReadOnly,
  onRunMacro,
  onSendShellCommand,
  shellStreamChunks,
}) => {
  const [activeTab, setActiveTab] = useState<'events' | 'shell'>('events');
  const [roleFilter, setRoleFilter] = useState<string>('ALL');
  const [regexFilter, setRegexFilter] = useState<string>('');
  const [shellInput, setShellInput] = useState<string>('');

  const xtermHostRef = useRef<HTMLDivElement | null>(null);
  const termInstanceRef = useRef<Terminal | null>(null);
  const fitAddonRef = useRef<FitAddon | null>(null);
  const lastChunkIdxRef = useRef<number>(0);

  const filteredEvents = useMemo(() => {
    let list = events;
    if (roleFilter !== 'ALL') {
      list = list.filter((e) => e.agent === roleFilter);
    }
    if (regexFilter.trim()) {
      try {
        const rx = new RegExp(regexFilter.trim(), 'i');
        list = list.filter(
          (e) =>
            rx.test(e.msg || '') ||
            rx.test(e.type || '') ||
            rx.test(e.agent || '') ||
            rx.test(e.target || '')
        );
      } catch {
        const lower = regexFilter.toLowerCase();
        list = list.filter((e) => JSON.stringify(e).toLowerCase().includes(lower));
      }
    }
    return list;
  }, [events, roleFilter, regexFilter]);

  // Initialize xterm.js instance
  useEffect(() => {
    if (!xtermHostRef.current) return;
    const term = new Terminal({
      cursorBlink: true,
      fontFamily: "'JetBrains Mono', monospace",
      fontSize: 11,
      theme: {
        background: '#05070d',
        foreground: '#e2e8f0',
        cursor: '#00F0FF',
        selectionBackground: 'rgba(0, 240, 255, 0.25)',
      },
      convertEol: true,
    });
    const fitAddon = new FitAddon();
    term.loadAddon(fitAddon);
    term.open(xtermHostRef.current);
    fitAddon.fit();

    termInstanceRef.current = term;
    fitAddonRef.current = fitAddon;

    const onResize = () => {
      try {
        fitAddon.fit();
      } catch {
        // ignore resize before layout
      }
    };
    window.addEventListener('resize', onResize);
    return () => {
      window.removeEventListener('resize', onResize);
      term.dispose();
    };
  }, []);

  // Re-render Tab 1 (filtered events) or Tab 2 (shell output) into xterm.js
  useEffect(() => {
    const term = termInstanceRef.current;
    if (!term) return;

    if (activeTab === 'events') {
      term.clear();
      term.writeln(
        '\x1b[38;2;0;240;255m=== TAB 1: LIVE AGENT EVENT & BASH STREAM (.studio/events.jsonl) ===\x1b[0m'
      );
      for (const evt of filteredEvents.slice().reverse()) {
        const ts = (evt.ts || '').slice(11, 19);
        const roleTag = `\x1b[36m[${evt.agent || 'agent'}]\x1b[0m`;
        const typeTag = `\x1b[35m${evt.type || 'event'}\x1b[0m`;
        const savedTag = evt.tokensSaved ? ` \x1b[32m(+${evt.tokensSaved} RTK saved)\x1b[0m` : '';
        term.writeln(`\x1b[90m${ts}\x1b[0m ${roleTag} ${typeTag}: ${evt.msg}${savedTag}`);
      }
    } else {
      term.clear();
      term.writeln(
        '\x1b[38;2;0;240;255m=== TAB 2: INTERACTIVE STUDIO SHELL & MACRO COMMAND DECK ===\x1b[0m'
      );
      for (const chunk of shellStreamChunks) {
        term.write(chunk);
      }
      lastChunkIdxRef.current = shellStreamChunks.length;
    }
  }, [activeTab, filteredEvents, shellStreamChunks]);

  const handleShellSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    if (!shellInput.trim()) return;
    onSendShellCommand(shellInput.trim());
    setShellInput('');
  };

  return (
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        background: 'rgba(6, 8, 14, 0.92)',
        fontFamily: "'JetBrains Mono', monospace",
      }}
    >
      {/* Top 1-Click Tactical Macro Deck */}
      <div
        style={{
          display: 'flex',
          flexWrap: 'wrap',
          gap: 5,
          padding: '6px 8px',
          background: 'rgba(10, 15, 28, 0.95)',
          borderBottom: '1px solid rgba(0, 240, 255, 0.25)',
          alignItems: 'center',
          justifyContent: 'space-between',
        }}
      >
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
          {[
            { id: 'pull-next', label: '▶ Pull Next Task', color: '#00F0FF' },
            { id: 'run-playtest', label: '🧪 Run ?playtest=1', color: '#10b981' },
            { id: 'rtk-gain', label: '⚡ RTK Gain Stats', color: '#38bdf8' },
            { id: 'pre-compact', label: '💾 Pre-Compact Checkpoint', color: '#f59e0b' },
            { id: 'switch-producer', label: '🔄 Switch Head Producer', color: '#a855f7' },
          ].map((btn) => (
            <button
              key={btn.id}
              onClick={() => onRunMacro(btn.id)}
              style={{
                background: 'rgba(15, 23, 42, 0.9)',
                border: `1px solid ${btn.color}`,
                color: btn.color,
                borderRadius: 4,
                padding: '3px 7px',
                fontSize: 10,
                fontFamily: 'inherit',
                cursor: 'pointer',
              }}
            >
              {btn.label}
            </button>
          ))}
        </div>

        {/* Safe Read-Only Toggle for Public Tunnels */}
        <button
          onClick={() => onToggleReadOnly(!readOnlyShell)}
          style={{
            background: readOnlyShell ? 'rgba(16, 185, 129, 0.16)' : 'rgba(239, 68, 68, 0.2)',
            border: `1px solid ${readOnlyShell ? '#10b981' : '#ef4444'}`,
            color: readOnlyShell ? '#34d399' : '#fca5a5',
            borderRadius: 4,
            padding: '3px 7px',
            fontSize: 10,
            fontFamily: 'inherit',
            cursor: 'pointer',
          }}
          title="Safe Read-Only Shell Lock for Cloudflare / Tailscale Public Tunnels"
        >
          {readOnlyShell ? '🔒 Tunnel Read-Only: ON' : '🔓 Live PTY Shell: UNLOCKED'}
        </button>
      </div>

      {/* Tab Bar + Instant Regex / Role Filters */}
      <div
        style={{
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          padding: '5px 8px',
          background: '#06080E',
          borderBottom: '1px solid #1e293b',
          gap: 6,
          flexWrap: 'wrap',
        }}
      >
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            onClick={() => setActiveTab('events')}
            style={{
              background: activeTab === 'events' ? 'rgba(0, 240, 255, 0.18)' : 'transparent',
              border: `1px solid ${activeTab === 'events' ? '#00F0FF' : '#334155'}`,
              color: activeTab === 'events' ? '#00F0FF' : '#94a3b8',
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Tab 1: Live Agent Event Stream ({filteredEvents.length})
          </button>
          <button
            onClick={() => setActiveTab('shell')}
            style={{
              background: activeTab === 'shell' ? 'rgba(0, 240, 255, 0.18)' : 'transparent',
              border: `1px solid ${activeTab === 'shell' ? '#00F0FF' : '#334155'}`,
              color: activeTab === 'shell' ? '#00F0FF' : '#94a3b8',
              borderRadius: 4,
              padding: '3px 8px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: 'pointer',
            }}
          >
            Tab 2: Interactive Studio Shell
          </button>
        </div>

        {activeTab === 'events' && (
          <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
            <select
              aria-label="Filter events by role"
              value={roleFilter}
              onChange={(e) => setRoleFilter(e.target.value)}
              style={{
                background: '#020409',
                border: '1px solid #334155',
                color: '#cbd5e1',
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: 10,
                fontFamily: 'inherit',
              }}
            >
              <option value="ALL">All Roles</option>
              {roles.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </select>
            <input
              aria-label="Regex filter for events"
              placeholder="Regex filter (e.g. failover|vitest)"
              value={regexFilter}
              onChange={(e) => setRegexFilter(e.target.value)}
              style={{
                background: '#020409',
                border: '1px solid #334155',
                color: '#e2e8f0',
                borderRadius: 4,
                padding: '2px 6px',
                fontSize: 10,
                fontFamily: 'inherit',
                width: 185,
              }}
            />
          </div>
        )}
      </div>

      {/* Embedded xterm.js Canvas */}
      <div
        ref={xtermHostRef}
        style={{
          flex: 1,
          width: '100%',
          minHeight: 140,
          padding: 4,
          background: '#05070d',
          overflow: 'hidden',
        }}
      />

      {/* Interactive Command Input Row (Tab 2) */}
      {activeTab === 'shell' && (
        <form
          onSubmit={handleShellSubmit}
          style={{
            display: 'flex',
            gap: 6,
            padding: '6px 8px',
            borderTop: '1px solid #1e293b',
            background: '#06080E',
          }}
        >
          <span style={{ color: '#00F0FF', fontSize: 11, alignSelf: 'center' }}>studio$</span>
          <input
            value={shellInput}
            onChange={(e) => setShellInput(e.target.value)}
            disabled={readOnlyShell}
            placeholder={
              readOnlyShell
                ? 'Shell locked in Read-Only mode (toggle button above to unlock)'
                : 'Enter command (e.g. rtk git status, node harness/status.mjs)...'
            }
            style={{
              flex: 1,
              background: '#020409',
              border: '1px solid #334155',
              color: '#e2e8f0',
              borderRadius: 4,
              padding: '4px 8px',
              fontSize: 11,
              fontFamily: 'inherit',
            }}
          />
          <button
            type="submit"
            disabled={readOnlyShell}
            style={{
              background: readOnlyShell ? '#1e293b' : 'rgba(0, 240, 255, 0.2)',
              border: '1px solid #00F0FF',
              color: '#00F0FF',
              borderRadius: 4,
              padding: '4px 10px',
              fontSize: 10,
              fontFamily: 'inherit',
              cursor: readOnlyShell ? 'not-allowed' : 'pointer',
            }}
          >
            Run
          </button>
        </form>
      )}
    </div>
  );
};

export default TerminalDock;

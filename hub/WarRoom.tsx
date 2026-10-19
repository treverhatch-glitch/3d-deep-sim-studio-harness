// Default visual HUB — React Flow War Room
// Zero-token. Reads .studio/events.jsonl
// For a quick no-build alternative, the old HTML feed is still in index.html

import React, { useEffect, useState } from "react";
import ReactFlow, { Background, Controls, MiniMap } from "reactflow";
import "reactflow/dist/style.css";

type Event = {
  ts: string;
  agent: string;
  worker: string;
  status: string;
  file?: string;
  bugId?: string;
};

export default function WarRoom() {
  const [events, setEvents] = useState<Event[]>([]);

  useEffect(() => {
    const load = async () => {
      try {
        const res = await fetch("/events");
        const text = await res.text();
        const lines = text.trim().split("\n").filter(Boolean);
        const parsed = lines.slice(-30).map((l) => JSON.parse(l));
        setEvents(parsed.reverse());
      } catch {
        // ignore
      }
    };
    load();
    const id = setInterval(load, 2000);
    return () => clearInterval(id);
  }, []);

  const nodes = events.map((e, i) => ({
    id: String(i),
    position: { x: 50, y: i * 90 },
    data: { label: `${e.status}\n${e.worker}` },
    style: {
      background: "#0a1628",
      color: "#00e5ff",
      border: "1px solid #00e5ff",
      borderRadius: 6,
      fontFamily: "monospace",
      fontSize: 12,
      padding: 8,
    },
  }));

  return (
    <div style={{ width: "100vw", height: "100vh", background: "#05080f" }}>
      <ReactFlow nodes={nodes} edges={[]} fitView>
        <Background />
        <Controls />
        <MiniMap />
      </ReactFlow>
    </div>
  );
}

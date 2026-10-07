"use client";

import { useMemo, useState } from "react";
import { forceCollide, forceSimulation, forceX, forceY, type SimulationNodeDatum } from "d3-force";
import { inrMinor, timeOf } from "@/lib/client/format";
import type { TraceSnapshot } from "@/lib/modules/tracing/job";

// Directed, victim-rooted case graph. Columns are hop depth from the victim;
// d3-force only spreads accounts vertically within a column (deterministic:
// d3-force seeds its own PRNG). Colours encode ROLE and STATE, never truth.

interface N extends SimulationNodeDatum {
  id: string;
  vpa: string;
  role: string;
  hop: number;
}

export type NodeStatus = "suspected" | "frozen" | "none";

const COL = 150;
const ROW = 46;

function fill(role: string, status: NodeStatus): string {
  if (role === "VICTIM") return "#4cc9f0";
  if (status === "frozen") return "#4cc9f0";
  if (status === "suspected") return "#ff4d5e";
  if (role === "MERCHANT" || role === "SINK") return "#2c3036";
  return "#6b7280";
}

export function CaseGraph({
  snapshot,
  statusOf,
  highlightPath,
}: {
  snapshot: TraceSnapshot;
  statusOf: (id: string) => NodeStatus;
  highlightPath?: string[] | null;
}) {
  const [hover, setHover] = useState<string | null>(null);

  const layout = useMemo(() => {
    const nodes: N[] = snapshot.nodes.map((n) => ({ id: n.id, vpa: n.vpa, role: n.role, hop: n.minHop, x: n.minHop * COL, y: 0 }));
    const perHop = new Map<number, number>();
    for (const n of nodes) {
      const k = perHop.get(n.hop) ?? 0;
      perHop.set(n.hop, k + 1);
      n.y = (k - 0) * ROW;
    }
    const sim = forceSimulation<N>(nodes)
      .force("x", forceX<N>((d) => d.hop * COL).strength(1))
      .force("y", forceY<N>(0).strength(0.04))
      .force("collide", forceCollide<N>(20))
      .stop();
    for (let i = 0; i < 220; i++) sim.tick();
    for (const n of nodes) n.x = n.hop * COL; // keep columns exact
    const xs = nodes.map((n) => n.x ?? 0);
    const ys = nodes.map((n) => n.y ?? 0);
    const minX = Math.min(...xs, 0) - 80;
    const minY = Math.min(...ys, 0) - 40;
    const w = Math.max(...xs, 0) - minX + 180;
    const h = Math.max(...ys, 0) - minY + 50;
    return { nodes: new Map(nodes.map((n) => [n.id, n])), box: `${minX} ${minY} ${w} ${h}`, w, h };
  }, [snapshot]);

  const cycleTxns = useMemo(() => new Set(snapshot.cycles.flatMap((c) => c.txnIds)), [snapshot]);
  const pathTxns = useMemo(() => new Set(highlightPath ?? []), [highlightPath]);
  const hoverInfo = hover ? snapshot.nodes.find((n) => n.id === hover) : null;

  return (
    <div className="relative">
      <svg viewBox={layout.box} className="h-[460px] w-full" role="img" aria-label={`Money-flow graph: ${snapshot.nodes.length} accounts and ${snapshot.edges.length} transfers traced from the victim. The table below lists the same paths.`}>
        <defs>
          {["base", "seed", "cycle", "path"].map((k) => (
            <marker key={k} id={`arrow-${k}`} viewBox="0 0 10 10" refX="17" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse">
              <path d="M0,0 L10,5 L0,10 z" fill={k === "cycle" ? "#ffb224" : k === "seed" ? "#ff4d5e" : k === "path" ? "#00e5a0" : "rgba(255,255,255,0.35)"} />
            </marker>
          ))}
        </defs>
        {[...new Set([...layout.nodes.values()].map((n) => n.hop))].map((hop) => (
          <text key={hop} x={hop * COL} y={Number(layout.box.split(" ")[1]) + 16} textAnchor="middle" className="fill-[#8a8f98] font-mono text-[10px]">
            {hop === 0 ? "victim" : `hop ${hop}`}
          </text>
        ))}
        {snapshot.edges.map((e) => {
          const a = layout.nodes.get(e.fromId);
          const b = layout.nodes.get(e.toId);
          if (!a || !b) return null;
          const kind = pathTxns.has(e.txnId) ? "path" : e.isSeed ? "seed" : cycleTxns.has(e.txnId) ? "cycle" : "base";
          const dim = hover && e.fromId !== hover && e.toId !== hover;
          const back = (b.x ?? 0) <= (a.x ?? 0);
          const mx = ((a.x ?? 0) + (b.x ?? 0)) / 2;
          const my = ((a.y ?? 0) + (b.y ?? 0)) / 2 + (back ? 38 : 0);
          return (
            <g key={e.txnId} opacity={dim ? 0.15 : 1}>
              <path
                d={back ? `M${a.x},${a.y} Q${mx},${my} ${b.x},${b.y}` : `M${a.x},${a.y} L${b.x},${b.y}`}
                fill="none"
                stroke={kind === "cycle" ? "#ffb224" : kind === "seed" ? "#ff4d5e" : kind === "path" ? "#00e5a0" : "rgba(255,255,255,0.22)"}
                strokeWidth={kind === "base" ? 1 : 2}
                markerEnd={`url(#arrow-${kind})`}
              >
                <title>{`${inrMinor(e.amountMinor)} at ${timeOf(e.ts)} (${e.txnId})`}</title>
              </path>
              {(hover === e.fromId || hover === e.toId || kind !== "base") && (
                <text x={mx} y={((a.y ?? 0) + (b.y ?? 0)) / 2 - 4 + (back ? 30 : 0)} textAnchor="middle" className="fill-[#edeef0] font-mono text-[9px]">
                  {inrMinor(e.amountMinor)} · {timeOf(e.ts)}
                </text>
              )}
            </g>
          );
        })}
        {[...layout.nodes.values()].map((n) => {
          const st = statusOf(n.id);
          const square = n.role === "MERCHANT" || n.role === "SINK";
          return (
            <g
              key={n.id}
              transform={`translate(${n.x},${n.y})`}
              tabIndex={0}
              role="button"
              aria-label={`${n.vpa}: ${n.role.toLowerCase()}${st !== "none" ? `, ${st}` : ""}, hop ${n.hop}`}
              onMouseEnter={() => setHover(n.id)}
              onMouseLeave={() => setHover(null)}
              onFocus={() => setHover(n.id)}
              onBlur={() => setHover(null)}
              className="cursor-pointer outline-none"
            >
              {square ? <rect x={-9} y={-9} width={18} height={18} rx={3} fill={fill(n.role, st)} stroke="rgba(255,255,255,0.3)" /> : <circle r={n.role === "VICTIM" ? 12 : 9} fill={fill(n.role, st)} />}
              {(st === "frozen" || n.role === "VICTIM") && <circle r={15} fill="none" stroke="#4cc9f0" strokeDasharray={n.role === "VICTIM" ? "3 2" : undefined} />}
              {hover === n.id && <circle r={19} fill="none" stroke="#00e5a0" />}
              <text x={14} y={4} className="fill-[#edeef0] font-mono text-[9px]">
                {n.vpa.length > 22 ? `${n.vpa.slice(0, 20)}…` : n.vpa}
              </text>
            </g>
          );
        })}
      </svg>
      <div className="flex flex-wrap gap-3 px-1 font-mono text-[10px] text-muted">
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-frost" />victim (protected: dashed ring)</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-[#6b7280]" />traced account</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full bg-danger" />suspected mule (analysis)</span>
        <span><span className="mr-1 inline-block h-2 w-2 rounded-full border border-frost bg-frost" />frozen (simulated)</span>
        <span><span className="mr-1 inline-block h-2 w-2 bg-[#2c3036]" />merchant / cash-out</span>
        <span className="text-danger">— disputed payment</span>
        <span className="text-amber">— cycle edge</span>
      </div>
      {hoverInfo && (
        <p className="mt-1 px-1 font-mono text-[11px] text-ink" aria-live="polite">
          {hoverInfo.vpa} · {hoverInfo.role.toLowerCase()} · hop {hoverInfo.minHop} · first reached {timeOf(hoverInfo.firstReachTs)}
          {hoverInfo.stopReason ? ` · not expanded: ${hoverInfo.stopReason.replace(/_/g, " ")}` : ""}
        </p>
      )}
    </div>
  );
}

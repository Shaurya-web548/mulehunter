"use client";

import { useEffect, useRef } from "react";
import {
  forceCenter,
  forceCollide,
  forceLink,
  forceManyBody,
  forceSimulation,
  forceX,
  forceY,
  type Simulation,
  type SimulationNodeDatum,
} from "d3-force";
import type { GraphEdge, GraphNode } from "@/lib/engine/types";

// Canvas-rendered force-directed transaction graph. Nodes/links are
// reconciled against each snapshot so positions persist tick-to-tick;
// ring members pulse red, frozen accounts turn ice-blue.

interface SimNode extends SimulationNodeDatum {
  id: string;
  vpa: string;
  score: number;
  frozen: boolean;
  kind: string;
  ringId?: string;
}

interface SimLink {
  source: string | SimNode;
  target: string | SimNode;
  flagged: boolean;
  amount: number;
}

function nodeColor(n: SimNode): string {
  if (n.frozen) return "#4cc9f0";
  if (n.score >= 55) return "#ff4d5e";
  if (n.score >= 30) return "#ffb224";
  if (n.kind === "merchant") return "#2c3036";
  return "#3a3f45";
}

export function ForceGraph({ nodes, edges }: { nodes: GraphNode[]; edges: GraphEdge[] }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const wrapRef = useRef<HTMLDivElement>(null);
  const simRef = useRef<Simulation<SimNode, SimLink> | null>(null);
  const nodesRef = useRef<SimNode[]>([]);
  const linksRef = useRef<SimLink[]>([]);
  const hoverRef = useRef<SimNode | null>(null);
  const tooltipRef = useRef<HTMLDivElement>(null);

  // one-time simulation + render loop
  useEffect(() => {
    const canvas = canvasRef.current!;
    const wrap = wrapRef.current!;
    const ctx = canvas.getContext("2d")!;

    const sim = forceSimulation<SimNode>([])
      .force("charge", forceManyBody().strength(-42).distanceMax(220))
      .force(
        "link",
        forceLink<SimNode, SimLink>([])
          .id((d) => d.id)
          .distance(46)
          .strength(0.25),
      )
      .force("center", forceCenter(0, 0).strength(0.06))
      .force("x", forceX(0).strength(0.045))
      .force("y", forceY(0).strength(0.045))
      .force("collide", forceCollide(10))
      .alphaDecay(0.03)
      .velocityDecay(0.32);
    simRef.current = sim;

    let w = 0,
      h = 0,
      dpr = 1;
    const resize = () => {
      dpr = Math.min(2, window.devicePixelRatio || 1);
      w = wrap.clientWidth;
      h = wrap.clientHeight;
      canvas.width = w * dpr;
      canvas.height = h * dpr;
      canvas.style.width = `${w}px`;
      canvas.style.height = `${h}px`;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(wrap);

    let raf = 0;
    const draw = () => {
      raf = requestAnimationFrame(draw);
      const t = performance.now() / 1000;
      ctx.setTransform(dpr, 0, 0, dpr, (w / 2) * dpr, (h / 2) * dpr);
      ctx.clearRect(-w / 2, -h / 2, w, h);

      // edges
      for (const l of linksRef.current) {
        const s = l.source as SimNode;
        const tg = l.target as SimNode;
        if (typeof s === "string" || typeof tg === "string") continue;
        if (s.x == null || tg.x == null) continue;
        ctx.beginPath();
        ctx.moveTo(s.x!, s.y!);
        ctx.lineTo(tg.x!, tg.y!);
        if (l.flagged) {
          ctx.strokeStyle = "rgba(255,77,94,0.55)";
          ctx.lineWidth = 1.4;
        } else {
          ctx.strokeStyle = "rgba(255,255,255,0.07)";
          ctx.lineWidth = 0.8;
        }
        ctx.stroke();
      }

      // nodes
      for (const n of nodesRef.current) {
        if (n.x == null || n.y == null) continue;
        const inRing = !!n.ringId && !n.frozen;
        const base = n.score >= 55 ? 6.5 : n.score >= 30 ? 5.5 : 4;
        const r = inRing ? base + Math.sin(t * 5 + n.x) * 1.4 : base;

        if (inRing || n.frozen) {
          ctx.shadowColor = n.frozen ? "rgba(76,201,240,0.9)" : "rgba(255,77,94,0.9)";
          ctx.shadowBlur = 14;
        } else {
          ctx.shadowBlur = 0;
        }
        ctx.beginPath();
        ctx.arc(n.x, n.y, Math.max(2.5, r), 0, Math.PI * 2);
        ctx.fillStyle = nodeColor(n);
        ctx.fill();
        ctx.shadowBlur = 0;

        if (n.frozen) {
          ctx.beginPath();
          ctx.arc(n.x, n.y, r + 3.5, 0, Math.PI * 2);
          ctx.strokeStyle = "rgba(76,201,240,0.6)";
          ctx.lineWidth = 1;
          ctx.stroke();
        }

        if (n.score >= 55 || n.frozen) {
          ctx.font = "9px ui-monospace, monospace";
          ctx.fillStyle = n.frozen ? "rgba(76,201,240,0.85)" : "rgba(255,255,255,0.65)";
          ctx.fillText(n.vpa, n.x + 9, n.y + 3);
        }
      }
    };
    raf = requestAnimationFrame(draw);

    const onMove = (e: MouseEvent) => {
      const rect = canvas.getBoundingClientRect();
      const mx = e.clientX - rect.left - w / 2;
      const my = e.clientY - rect.top - h / 2;
      let best: SimNode | null = null;
      let bestD = 14 * 14;
      for (const n of nodesRef.current) {
        if (n.x == null || n.y == null) continue;
        const d = (n.x - mx) ** 2 + (n.y - my) ** 2;
        if (d < bestD) {
          bestD = d;
          best = n;
        }
      }
      hoverRef.current = best;
      const tip = tooltipRef.current!;
      if (best) {
        tip.style.opacity = "1";
        tip.style.transform = `translate(${e.clientX - rect.left + 14}px, ${e.clientY - rect.top + 14}px)`;
        tip.textContent = `${best.vpa} · score ${best.score}${best.frozen ? " · FROZEN" : best.ringId ? " · IN RING" : ""}`;
      } else {
        tip.style.opacity = "0";
      }
    };
    canvas.addEventListener("mousemove", onMove);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      canvas.removeEventListener("mousemove", onMove);
      sim.stop();
    };
  }, []);

  // reconcile snapshot into the running simulation
  useEffect(() => {
    const sim = simRef.current;
    if (!sim) return;
    const prev = new Map(nodesRef.current.map((n) => [n.id, n]));
    const next: SimNode[] = nodes.map((gn) => {
      const old = prev.get(gn.id);
      if (old) {
        old.score = gn.score;
        old.frozen = gn.frozen;
        old.ringId = gn.ringId;
        return old;
      }
      const angle = Math.random() * Math.PI * 2;
      const rad = 120 + Math.random() * 160;
      return {
        ...gn,
        x: Math.cos(angle) * rad,
        y: Math.sin(angle) * rad,
      };
    });
    nodesRef.current = next;

    const ids = new Set(next.map((n) => n.id));
    linksRef.current = edges
      .filter((e) => ids.has(e.from) && ids.has(e.to))
      .map((e) => ({ source: e.from, target: e.to, flagged: e.flagged, amount: e.amount }));

    sim.nodes(next);
    (sim.force("link") as ReturnType<typeof forceLink<SimNode, SimLink>>).links(linksRef.current);
    sim.alpha(0.35).restart();
  }, [nodes, edges]);

  return (
    <div ref={wrapRef} className="relative h-full w-full overflow-hidden">
      <canvas ref={canvasRef} className="block h-full w-full" />
      <div
        ref={tooltipRef}
        className="pointer-events-none absolute left-0 top-0 rounded-lg border border-line bg-panel px-2.5 py-1.5 font-mono text-[11px] text-ink opacity-0 transition-opacity"
      />
    </div>
  );
}

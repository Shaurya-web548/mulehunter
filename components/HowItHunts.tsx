"use client";

import { useLayoutEffect, useRef, useState } from "react";
import { gsap } from "gsap";
import { ScrollTrigger } from "gsap/ScrollTrigger";

// Pinned, scrubbed GSAP section: as you scroll, the same transaction graph
// goes through the four stages of a takedown — ingest → score → isolate →
// freeze. Opacity/transform tweens only; falls back to a static list under
// prefers-reduced-motion.

const STEPS = [
  {
    k: "01",
    title: "Ingest the stream",
    body: "Hundreds of UPI transactions per second flow into a 90-second sliding-window graph. Every edge is money moving between two VPAs.",
  },
  {
    k: "02",
    title: "Score every account",
    body: "Velocity, fan-out, fan-in, pass-through ratio, structuring, account age — six signals fused into a live suspicion score per account.",
  },
  {
    k: "03",
    title: "Isolate the ring",
    body: "Suspicion propagates across hops; union-find community detection carves the suspicious subgraph into rings and classifies their shape.",
  },
  {
    k: "04",
    title: "Freeze & report",
    body: "One click freezes every account in the ring — outbound transfers die instantly — and an investigator-ready report is drafted automatically.",
  },
];

// mule-flow node coordinates for the diagram
const FLOW = {
  victim: [40, 200],
  root: [130, 200],
  l1: [
    [220, 110],
    [220, 200],
    [220, 290],
  ],
  l2: [
    [300, 70],
    [300, 150],
    [300, 240],
    [300, 320],
  ],
  cash: [
    [370, 120],
    [370, 270],
  ],
} as const;

const BASE_NODES: [number, number][] = [
  [70, 60], [150, 90], [90, 320], [170, 350], [250, 30], [60, 140],
  [340, 30], [120, 260], [200, 330], [350, 350],
];

export function HowItHunts() {
  const wrap = useRef<HTMLDivElement>(null);
  const [active, setActive] = useState(0);
  const [reduced, setReduced] = useState(false);

  useLayoutEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      setReduced(true);
      return;
    }
    gsap.registerPlugin(ScrollTrigger);
    const ctx = gsap.context(() => {
      const tl = gsap.timeline({
        scrollTrigger: {
          trigger: wrap.current,
          start: "top top",
          end: "+=2600",
          pin: true,
          scrub: 0.6,
          onUpdate: (st) => setActive(Math.min(3, Math.floor(st.progress * 4.02))),
        },
        defaults: { ease: "none" },
      });
      tl.fromTo("#hh-flow", { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 }, 0.1)
        .fromTo("#hh-scores", { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 }, 1.1)
        .fromTo(
          "#hh-scores",
          { scale: 0.92, transformOrigin: "50% 50%" },
          { scale: 1, duration: 1 },
          1.1,
        )
        .fromTo("#hh-ring", { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 }, 2.2)
        .fromTo("#hh-base", { autoAlpha: 1 }, { autoAlpha: 0.25, duration: 1 }, 2.2)
        .fromTo("#hh-freeze", { autoAlpha: 0 }, { autoAlpha: 1, duration: 1 }, 3.3)
        .fromTo("#hh-ring", { autoAlpha: 1 }, { autoAlpha: 0.35, duration: 1 }, 3.3);
    }, wrap);
    return () => ctx.revert();
  }, []);

  const dot = (x: number, y: number, fill: string, r = 7, extra?: string) => (
    <circle key={`${x}-${y}-${fill}`} cx={x} cy={y} r={r} fill={fill} className={extra} />
  );

  const edge = (a: readonly number[], b: readonly number[], stroke: string, w = 1.5) => (
    <line key={`${a}-${b}-${stroke}`} x1={a[0]} y1={a[1]} x2={b[0]} y2={b[1]} stroke={stroke} strokeWidth={w} />
  );

  return (
    <section id="engine" ref={wrap} className="relative min-h-screen">
      <div className="mx-auto flex min-h-screen w-full max-w-6xl flex-col justify-center px-6 py-20">
        <p className="mb-3 font-mono text-xs uppercase tracking-[0.3em] text-accent">
          The engine
        </p>
        <h2 className="mb-12 max-w-2xl font-(family-name:--font-display) text-4xl font-semibold tracking-tight sm:text-5xl">
          Anatomy of a takedown
        </h2>

        <div className="grid items-center gap-12 lg:grid-cols-2">
          {/* Steps */}
          <ol className="space-y-7">
            {STEPS.map((step, i) => {
              const on = reduced || i === active;
              return (
                <li
                  key={step.k}
                  className="flex gap-5 transition-opacity duration-300"
                  style={{ opacity: on ? 1 : 0.32 }}
                >
                  <span
                    className={`font-mono text-sm ${on ? "text-accent" : "text-muted"} pt-1`}
                  >
                    {step.k}
                  </span>
                  <div>
                    <h3 className="font-(family-name:--font-display) text-xl font-semibold">
                      {step.title}
                    </h3>
                    <p className="mt-1.5 max-w-md text-sm leading-relaxed text-muted">
                      {step.body}
                    </p>
                  </div>
                </li>
              );
            })}
          </ol>

          {/* Diagram */}
          <div className="glass relative mx-auto w-full max-w-md rounded-3xl p-6">
            <svg viewBox="0 0 410 400" className="w-full" role="img" aria-label="Fraud ring detection stages diagram">
              {/* legit mesh */}
              <g id="hh-base" style={reduced ? {} : undefined}>
                {edge(BASE_NODES[0], BASE_NODES[1], "rgba(255,255,255,0.10)")}
                {edge(BASE_NODES[1], BASE_NODES[5], "rgba(255,255,255,0.10)")}
                {edge(BASE_NODES[2], BASE_NODES[3], "rgba(255,255,255,0.10)")}
                {edge(BASE_NODES[3], BASE_NODES[8], "rgba(255,255,255,0.10)")}
                {edge(BASE_NODES[4], BASE_NODES[6], "rgba(255,255,255,0.10)")}
                {edge(BASE_NODES[7], BASE_NODES[2], "rgba(255,255,255,0.10)")}
                {BASE_NODES.map(([x, y]) => dot(x, y, "#3a3f45", 5))}
              </g>

              {/* the mule flow appears */}
              <g id="hh-flow" style={reduced ? {} : { opacity: 0 }}>
                {edge(FLOW.victim, FLOW.root, "rgba(255,255,255,0.35)", 2)}
                {FLOW.l1.map((p) => edge(FLOW.root, p, "rgba(255,255,255,0.28)", 1.6))}
                {FLOW.l1.map((p, i) =>
                  FLOW.l2
                    .slice(i, i + 2)
                    .map((q) => edge(p, q, "rgba(255,255,255,0.22)", 1.3)),
                )}
                {FLOW.l2.map((p, i) => edge(p, FLOW.cash[i % 2], "rgba(255,255,255,0.22)", 1.3))}
                {dot(FLOW.victim[0], FLOW.victim[1], "#8a8f98", 8)}
                {dot(FLOW.root[0], FLOW.root[1], "#565b63")}
                {FLOW.l1.map(([x, y]) => dot(x, y, "#565b63"))}
                {FLOW.l2.map(([x, y]) => dot(x, y, "#565b63", 6))}
                {FLOW.cash.map(([x, y]) => dot(x, y, "#565b63", 8))}
                <text x={FLOW.victim[0] - 8} y={FLOW.victim[1] + 24} fill="#8a8f98" fontSize="11">
                  victim
                </text>
              </g>

              {/* scores light up */}
              <g id="hh-scores" style={reduced ? {} : { opacity: 0 }}>
                {dot(FLOW.root[0], FLOW.root[1], "#ffb224")}
                {FLOW.l1.map(([x, y]) => dot(x, y, "#ffb224"))}
                {FLOW.l2.map(([x, y]) => dot(x, y, "#ffb224", 6))}
              </g>

              {/* ring isolated */}
              <g id="hh-ring" style={reduced ? {} : { opacity: 0 }}>
                <rect
                  x={108}
                  y={40}
                  width={292}
                  height={320}
                  rx={26}
                  fill="rgba(255,77,94,0.06)"
                  stroke="rgba(255,77,94,0.45)"
                  strokeDasharray="6 6"
                />
                {edge(FLOW.victim, FLOW.root, "rgba(255,77,94,0.6)", 2)}
                {FLOW.l1.map((p) => edge(FLOW.root, p, "rgba(255,77,94,0.55)", 1.8))}
                {FLOW.l2.map((p, i) => edge(p, FLOW.cash[i % 2], "rgba(255,77,94,0.5)", 1.5))}
                {dot(FLOW.root[0], FLOW.root[1], "#ff4d5e")}
                {FLOW.l1.map(([x, y]) => dot(x, y, "#ff4d5e"))}
                {FLOW.l2.map(([x, y]) => dot(x, y, "#ff4d5e", 6))}
                {FLOW.cash.map(([x, y]) => dot(x, y, "#ff4d5e", 8))}
                <text x={126} y={64} fill="#ff4d5e" fontSize="11" fontFamily="monospace">
                  RING · fan-out layering · 10 accts
                </text>
              </g>

              {/* frozen */}
              <g id="hh-freeze" style={reduced ? {} : { opacity: 0 }}>
                {dot(FLOW.root[0], FLOW.root[1], "#4cc9f0")}
                {FLOW.l1.map(([x, y]) => dot(x, y, "#4cc9f0"))}
                {FLOW.l2.map(([x, y]) => dot(x, y, "#4cc9f0", 6))}
                {FLOW.cash.map(([x, y]) => dot(x, y, "#4cc9f0", 8))}
                <rect x={122} y={330} width={186} height={34} rx={8} fill="rgba(76,201,240,0.12)" stroke="rgba(76,201,240,0.5)" />
                <text x={138} y={352} fill="#4cc9f0" fontSize="12" fontFamily="monospace">
                  ❄ FROZEN — ₹3.4L intercepted
                </text>
              </g>
            </svg>
          </div>
        </div>
      </div>
    </section>
  );
}

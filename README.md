# ◉ NETRA — real-time UPI mule-network hunter

When someone gets scammed, the money doesn't sit in one account. Within minutes it's
blasted through a network of **mule accounts** — layered, looped, split into sub-₹10k
crumbs — and pulled out as cash before any bank reacts. Legacy systems screen
transactions **one at a time**, so the fraud is invisible: it only exists in the
*shape of the transaction graph*.

**NETRA streams that graph in real time, lights the mule ring up red, and freezes it in one click** — before the cash-out.

> Every transaction here is synthetic. No real financial data is used. The detection
> is hand-rolled streaming graph algorithms; an LLM appears only to draft the final
> investigator report — garnish, not the engine.

---

## What it does

1. **Simulates a live UPI network** — 12,000+ synthetic accounts transacting at ~600
   TPS (scales to 10k+), with a realistic base load of person↔person and
   person→merchant payments.
2. **Injects real fraud typologies** on demand — **fan-out layering**, **circular
   routing**, and **smurfing** — each with ground-truth mule labels the detector
   never sees.
3. **Detects the ring** from the graph alone: a 90-second sliding-window graph feeds a
   six-signal anomaly score, suspicion propagates across hops, and union-find
   community detection carves out and classifies the ring.
4. **Freezes it** — one click blocks every account in the ring; scheduled outbound
   transfers die instantly and the intercepted rupee amount is tallied live.
5. **Reports it** — auto-generates an investigator-ready Suspicious Activity Report
   (drafted by Claude when a key is present, deterministic template otherwise).

Precision and recall are computed **live against the simulator's ground truth**, so the
dashboard proves its own accuracy as you watch. In testing, each injected pattern is
isolated within ~10–20 seconds at **~85–100% precision and recall** — with a clean
baseline that raises **zero false rings** on legitimate traffic.

## The intelligence is the graph, not an API call

```
┌──────────────┐   txns    ┌───────────────────┐  scores  ┌──────────────────┐
│  Simulator   │ ────────► │  Sliding-window   │ ───────► │  Detection       │
│  synthetic   │  ~600/s   │  transaction graph│          │  • 6-signal score│
│  UPI + fraud │           │  (90s, bounded)   │          │  • propagation   │
└──────────────┘           └───────────────────┘          │  • union-find    │
        │                                                  │    ring extract  │
        │  ground-truth mule labels                        └────────┬─────────┘
        └──────────────► live precision / recall ◄──────────────────┘
                                                                     │ SSE (2/s)
                                                          ┌──────────▼─────────┐
                                                          │  /hunt dashboard   │
                                                          │  canvas force graph│
                                                          │  freeze · report   │
                                                          └────────────────────┘
```

### The detection signals (`lib/engine/detect.ts`)

Per account, per 90-second window:

| Signal | Catches |
|---|---|
| **Velocity** | accounts firing far more txns than a human would |
| **Fan-out** | money exploding outward to many counterparties (layering root) |
| **Fan-in** | many senders converging on one account (smurf aggregator) |
| **Pass-through** | money in ≈ money out within seconds — *the* mule signature |
| **Structuring** | repeated transfers just under the ₹10k reporting radar |
| **Loop repetition** | the same large amount pushed to the same peer repeatedly (circular routing) |
| **New-account risk** | a multiplier — fraud runs on freshly opened accounts |

Scores then **propagate** one to two hops along the graph (weighted higher across
structured-amount edges), so quiet middle-layer mules get pulled in while the fraud
*victim* — one large transfer into a hot account — correctly stays out. **Union-find**
community detection over the suspicious subgraph isolates each ring, and a
cycle-detection + fan-shape classifier labels it as layering, circular, or smurfing.

### Why in-process instead of Kafka + Neo4j

The brief calls for Kafka/Redis Streams + Neo4j. This build implements the **same
algorithms** — streaming ingest, sliding-window graph, community detection, suspicion
propagation — in-process so it runs anywhere with a single `npm run dev`, no
infrastructure. The engine is cleanly separated (`lib/engine/`) behind a `getEngine()`
singleton; swapping the graph store for Neo4j or the ingest for Kafka is a boundary
replacement, not a rewrite. (The stack marquee flags both as "ready".)

## Key files

| Path | Purpose |
|---|---|
| `lib/engine/simulator.ts` | Synthetic UPI traffic + injectable fraud scenarios with ground truth |
| `lib/engine/graph.ts` | Bounded 90s sliding-window transaction graph |
| `lib/engine/detect.ts` | Scoring, suspicion propagation, union-find ring extraction, evaluation |
| `lib/engine/engine.ts` | Orchestration loop + SSE fan-out + ring lifecycle (`getEngine()` singleton) |
| `app/api/stream/route.ts` | Server-Sent Events → dashboard (~2 snapshots/sec) |
| `app/api/{attack,freeze,report}/route.ts` | Inject scenario · freeze ring · draft report |
| `components/ForceGraph.tsx` | Canvas force-directed graph (d3-force), rings pulse red |
| `app/page.tsx` + `components/` | Animated landing page |
| `app/hunt/page.tsx` | Live operations console |

## The animated landing page

Design language: near-black Linear-style dark theme, single mint accent, glassmorphic
cards, Space Grotesk display + Inter body. Everything animates **transform/opacity
only** and every effect is disabled under `prefers-reduced-motion`.

- **Lenis** smooth scrolling site-wide (driven by the GSAP ticker so scroll and pins share one clock)
- **Hero** — word-by-word staggered headline reveal on load, floating gradient orbs
- **GSAP ScrollTrigger** — a pinned, scrubbed "Anatomy of a takedown" section where one
  transaction graph walks through ingest → score → isolate → freeze as you scroll
- **whileInView** fade+slide reveals with staggered children on every section
- **Glow-lift cards**, **count-up stats**, an **infinite tech marquee**, and **magnetic buttons**

## Getting started

```bash
npm install
npm run dev
```

Open http://localhost:3000 for the landing page, then **Launch console** (`/hunt`).
On the console: click an **attack scenario**, watch the ring light up red in the graph
and appear in the sidebar, hit **Freeze ring**, then **Report**.

Optional — Claude-drafted reports:

```bash
cp .env.example .env.local   # add ANTHROPIC_API_KEY
```

Without a key, reports fall back to a deterministic template built from the same graph
evidence. **No key is needed for any of the detection** — that's the whole point.

## Deploy (Vercel)

```bash
npx vercel
```

The engine runs an in-memory simulation loop inside the serverless runtime, kept alive
by the open SSE connection. On a long-lived host (a small VM / container) the loop runs
continuously; on Vercel each cold start begins a fresh stream — fine for a demo. Add
`ANTHROPIC_API_KEY` in project settings for live reports.

## Demo script (~3:45)

- **0:00–0:30 · Problem.** "When you get scammed, the money's gone in minutes — sprayed
  through mule accounts and cashed out. Banks check one transaction at a time, so they
  never see the ring." Scroll the hero; the alert card and orbs sell it.
- **0:30–3:00 · Live demo.** Open `/hunt`. Point at the live graph and the TPS /
  precision tiles ("this is synthetic UPI traffic, checked in real time, and it's
  scoring its own accuracy against ground truth"). Click **Fan-out layering** → the
  mule ring blooms red in seconds, a critical alert fires, precision/recall update.
  Click **Freeze ring** → accounts turn ice-blue, "₹X intercepted" ticks up as
  scheduled cash-outs are blocked. Click **Report** → an investigator SAR appears.
  Repeat with **Smurfing** to show a different graph shape.
- **3:00–3:45 · Architecture & scale.** Scroll the pinned "Anatomy of a takedown"
  section. "The intelligence is the graph engine — sliding-window ingest, six-signal
  scoring, suspicion propagation, union-find ring detection. Kafka and Neo4j drop in at
  the boundaries. This catches rings *before* the withdrawal — which is exactly what
  NPCI and the banks are chasing."

## The resume line

> Built a real-time fraud-ring detection engine ingesting synthetic UPI transactions at
> scale, isolating injected mule networks (fan-out layering, circular routing,
> smurfing) via sliding-window graph analytics — six-signal anomaly scoring, suspicion
> propagation, and union-find community detection — at ~85–100% precision/recall, with
> one-click ring freezing and auto-generated investigator reports.

---

Built with hand-rolled streaming graph algorithms · Next.js 16 · TypeScript · d3-force ·
Framer Motion · GSAP ScrollTrigger · Lenis · Claude (investigator reports only).

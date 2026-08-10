import { Simulator, type Scenario } from "./simulator";
import { TxnGraph } from "./graph";
import { ALERT_THRESHOLD, evaluate, extractRings, propagate, scoreAccount } from "./detect";
import type { Alert, FeedItem, GraphEdge, GraphNode, Pattern, Ring, ScoreBreakdown, Snapshot, Txn } from "./types";

// The engine runs one simulation + detection loop per server process and
// fans snapshots out to any number of SSE subscribers. It lives on
// globalThis so Next.js dev-mode HMR doesn't spawn duplicate loops.

const TICK_MS = 250;
const SNAPSHOT_MS = 500;
const DETECT_MS = 500;
const MAX_GRAPH_NODES = 320;

let uidc = 0;
const uid = (p: string) => `${p}_${(++uidc).toString(36)}${Date.now().toString(36).slice(-4)}`;

export class Engine {
  sim: Simulator;
  graph = new TxnGraph();
  rings = new Map<string, Ring>(); // key -> ring
  alerts: Alert[] = [];
  feed: FeedItem[] = [];
  scores = new Map<string, ScoreBreakdown>();
  processed = 0;
  intercepted = 0;
  precision = 1;
  recall = 1;
  flagged = 0;
  private tpsWindow: number[] = [];
  private alerted = new Set<string>();
  private subscribers = new Set<(snap: Snapshot) => void>();
  private lastDetect = 0;
  private lastSnapshot = 0;
  private timer: ReturnType<typeof setInterval>;

  constructor() {
    this.sim = new Simulator(Date.now());
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      this.tick(now, now - last);
      last = now;
    }, TICK_MS);
    // Never keep the process alive just for the demo loop
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  private tick(now: number, dt: number) {
    const txns = this.sim.pump(now, dt, (dropped) => {
      this.intercepted += dropped.amount;
      const ring = [...this.rings.values()].find((r) => r.accounts.includes(dropped.from));
      if (ring) ring.intercepted += dropped.amount;
    });

    for (const t of txns) this.graph.add(t);
    this.processed += txns.length;
    this.tpsWindow.push(txns.length);
    if (this.tpsWindow.length > 8) this.tpsWindow.shift();

    this.updateFeed(txns);
    this.graph.prune(now);

    if (now - this.lastDetect >= DETECT_MS) {
      this.lastDetect = now;
      this.detect(now);
    }
    if (now - this.lastSnapshot >= SNAPSHOT_MS && this.subscribers.size) {
      this.lastSnapshot = now;
      const snap = this.snapshot(now);
      for (const fn of this.subscribers) fn(snap);
    }
  }

  private detect(now: number) {
    const base = new Map<string, ScoreBreakdown>();
    for (const w of this.graph.active()) {
      const acc = this.sim.accounts.get(w.id);
      if (acc?.kind === "merchant" || acc?.kind === "sink") continue;
      const s = scoreAccount(w, acc, now);
      if (s.score > 0) base.set(w.id, s);
    }
    this.scores = propagate(base, this.graph);

    // per-account alerts (first crossing only)
    for (const [id, s] of this.scores) {
      if (s.score >= ALERT_THRESHOLD && !this.alerted.has(id)) {
        this.alerted.add(id);
        const vpa = this.sim.accounts.get(id)?.vpa ?? id;
        this.pushAlert("warn", `Anomaly: ${vpa}`, s.reasons.slice(0, 3).join(" · "));
      }
    }

    // ring lifecycle
    for (const cand of extractRings(this.scores, this.graph)) {
      const existing = this.rings.get(cand.key);
      if (existing) {
        if (existing.status === "active") {
          existing.accounts = cand.members;
          existing.score = cand.score;
          existing.totalFlow = cand.totalFlow;
          existing.pattern = cand.pattern === "unknown" ? existing.pattern : cand.pattern;
        }
      } else {
        const ring: Ring = {
          id: uid("ring"),
          pattern: cand.pattern,
          accounts: cand.members,
          score: cand.score,
          detectedAt: now,
          status: "active",
          totalFlow: cand.totalFlow,
          intercepted: 0,
        };
        this.rings.set(cand.key, ring);
        this.pushAlert(
          "critical",
          `Mule ring detected — ${label(ring.pattern)}`,
          `${ring.accounts.length} accounts, ₹${inr(ring.totalFlow)} moved in 90s. Confidence ${ring.score}%.`,
          ring.id,
        );
      }
    }

    // live evaluation against simulator ground truth (recent scenarios only)
    const trueMules = new Set<string>();
    for (const scn of this.sim.scenarios) {
      if (now - scn.startedAt < 150_000) for (const id of scn.muleIds) trueMules.add(id);
    }
    const rings = [...this.rings.values()];
    const ev = evaluate(rings, this.scores, trueMules);
    this.flagged = ev.flagged;
    if (trueMules.size > 0) {
      this.precision = ev.precision;
      this.recall = ev.recall;
    }
  }

  private updateFeed(txns: Txn[]) {
    const flaggedTxns = txns.filter(
      (t) => (this.scores.get(t.from)?.score ?? 0) >= 55 || (this.scores.get(t.to)?.score ?? 0) >= 55,
    );
    const sampleLegit = txns.filter((t) => !t.scenarioId).slice(0, 3);
    for (const t of [...flaggedTxns.slice(0, 6), ...sampleLegit]) {
      this.feed.push({
        ts: t.ts,
        fromVpa: this.sim.accounts.get(t.from)?.vpa ?? t.from,
        toVpa: this.sim.accounts.get(t.to)?.vpa ?? t.to,
        amount: t.amount,
        flagged: flaggedTxns.includes(t),
      });
    }
    if (this.feed.length > 26) this.feed = this.feed.slice(-26);
  }

  private pushAlert(severity: Alert["severity"], title: string, detail: string, ringId?: string) {
    this.alerts.push({ id: uid("al"), ts: Date.now(), severity, title, detail, ringId });
    if (this.alerts.length > 40) this.alerts = this.alerts.slice(-40);
  }

  launch(pattern: Pattern): Scenario {
    const scn = this.sim.launch(pattern, Date.now());
    this.pushAlert(
      "info",
      "Attack scenario injected",
      `${label(pattern)} — ₹${inr(scn.amount)} entering the network. Watch the graph.`,
    );
    return scn;
  }

  freeze(ringId: string): Ring | null {
    const ring = [...this.rings.values()].find((r) => r.id === ringId);
    if (!ring || ring.status === "frozen") return ring ?? null;
    ring.status = "frozen";
    for (const id of ring.accounts) {
      const acc = this.sim.accounts.get(id);
      if (acc) acc.frozen = true;
    }
    this.pushAlert(
      "info",
      "Ring frozen",
      `${ring.accounts.length} accounts blocked. Outbound transfers are now being intercepted.`,
      ring.id,
    );
    return ring;
  }

  ringById(ringId: string): Ring | undefined {
    return [...this.rings.values()].find((r) => r.id === ringId);
  }

  subscribe(fn: (snap: Snapshot) => void): () => void {
    this.subscribers.add(fn);
    fn(this.snapshot(Date.now()));
    return () => this.subscribers.delete(fn);
  }

  snapshot(now: number): Snapshot {
    // hot subgraph: every ring/suspect node + a sample of recent activity
    const include = new Set<string>();
    for (const r of this.rings.values()) for (const id of r.accounts) include.add(id);
    for (const [id, s] of this.scores) if (s.score >= 30) include.add(id);

    const recent = this.graph
      .active()
      .sort((a, b) => b.lastTouched - a.lastTouched);
    for (const w of recent) {
      if (include.size >= MAX_GRAPH_NODES) break;
      include.add(w.id);
    }

    const ringOf = new Map<string, string>();
    for (const r of this.rings.values()) for (const id of r.accounts) ringOf.set(id, r.id);

    const nodes: GraphNode[] = [];
    for (const id of include) {
      const acc = this.sim.accounts.get(id);
      if (!acc || acc.kind === "sink") continue;
      nodes.push({
        id,
        vpa: acc.vpa,
        score: this.scores.get(id)?.score ?? 0,
        frozen: acc.frozen,
        kind: acc.kind,
        ringId: ringOf.get(id),
      });
    }

    const nodeSet = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = [];
    for (const e of this.graph.edges.values()) {
      if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
      const flagged =
        (this.scores.get(e.from)?.score ?? 0) >= 55 && (this.scores.get(e.to)?.score ?? 0) >= 55;
      edges.push({ from: e.from, to: e.to, amount: Math.round(e.amount), count: e.count, lastTs: e.lastTs, flagged });
    }

    const rings = [...this.rings.values()].sort((a, b) => b.detectedAt - a.detectedAt);
    const tps = Math.round(this.tpsWindow.reduce((a, b) => a + b, 0) / ((this.tpsWindow.length * TICK_MS) / 1000) || 0);

    return {
      t: now,
      metrics: {
        tps,
        processed: this.processed,
        accounts: this.sim.accounts.size,
        windowTxns: [...this.graph.edges.values()].reduce((a, e) => a + e.count, 0),
        flagged: this.flagged,
        activeRings: rings.filter((r) => r.status === "active").length,
        frozenRings: rings.filter((r) => r.status === "frozen").length,
        precision: this.precision,
        recall: this.recall,
        intercepted: Math.round(this.intercepted),
      },
      nodes,
      edges,
      rings: rings.slice(0, 8),
      alerts: this.alerts.slice(-14).reverse(),
      feed: [...this.feed].reverse(),
    };
  }
}

export function label(p: Pattern | "unknown"): string {
  return p === "fanout_layering"
    ? "fan-out layering"
    : p === "circular_routing"
      ? "circular routing"
      : p === "smurfing"
        ? "smurfing"
        : "unclassified";
}

export function inr(n: number): string {
  if (n >= 10_000_000) return `${(n / 10_000_000).toFixed(2)} Cr`;
  if (n >= 100_000) return `${(n / 100_000).toFixed(2)} L`;
  return Math.round(n).toLocaleString("en-IN");
}

declare global {
  var __muleEngine: Engine | undefined;
}

export function getEngine(): Engine {
  if (!globalThis.__muleEngine) globalThis.__muleEngine = new Engine();
  return globalThis.__muleEngine;
}

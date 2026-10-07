import { Simulator, type PaymentRequest, type Scenario } from "./simulator.ts";
import { TxnGraph } from "./graph.ts";
import { ALERT_THRESHOLD, evaluate, extractRings, propagate, scoreAccount } from "./detect.ts";
import type { Alert, FeedItem, GraphEdge, GraphNode, Pattern, Ring, ScoreBreakdown, Snapshot, Txn } from "./types.ts";
import type { Store } from "../persistence/store.ts";
import { SimTruthRepository } from "../persistence/repos/truth.ts";
import type { OutboxEvent } from "../persistence/repos/runtime.ts";
import { admitBatch, type AdmittedPayment } from "../modules/payments/admission.ts";
import { pruneHistory, retentionMs } from "../modules/payments/retention.ts";
import { applyLegacyRingHolds } from "../modules/protection/holds.ts";
import { minorToLegacyRupees } from "../contracts/legacy.ts";

// The engine runs one simulation + detection loop per server process and
// fans snapshots out to any number of SSE subscribers. Every payment the
// simulator proposes goes through the durable admission gate in one
// serialized transaction per tick; only ACCEPTED payments reach the live
// 90 s graph. The process singleton lives in lib/runtime.ts.

const TICK_MS = 250;
const SNAPSHOT_MS = 500;
const DETECT_MS = 500;
const OUTBOX_MS = 250;
const PRUNE_MS = 60_000;
const MAX_GRAPH_NODES = 320;

let uidc = 0;
const uid = (p: string) => `${p}_${(++uidc).toString(36)}${Date.now().toString(36).slice(-4)}`;

export interface EngineOptions {
  runId: string;
  baseTps: number;
  /** false in tests: drive with `tick()` manually */
  autoStart?: boolean;
  nPeople?: number;
  nMerchants?: number;
  now?: number;
}

export class Engine {
  readonly store: Store;
  readonly runId: string;
  sim: Simulator;
  graph = new TxnGraph();
  rings = new Map<string, Ring>();
  alerts: Alert[] = [];
  feed: FeedItem[] = [];
  scores = new Map<string, ScoreBreakdown>();
  processed = 0;
  blockedAttempts = 0;
  blockedAttemptedMinor = 0;
  rejectedOther = 0;
  precision = 1;
  recall = 1;
  flagged = 0;
  /** debit-blocked accounts (any ACTIVE hold) — display cache, refreshed from the DB */
  held = new Set<string>();
  private truth: SimTruthRepository;
  private tpsWindow: number[] = [];
  private alerted = new Set<string>();
  private everFlagged = new Set<string>();
  private trueMules = new Set<string>();
  /** highest suspicion score ever seen per account — evidence for reports */
  peakScores = new Map<string, { score: number; reasons: string[] }>();
  private subscribers = new Set<(snap: Snapshot) => void>();
  private caseSubscribers = new Set<(ev: OutboxEvent) => void>();
  private outboxCursor: number;
  private lastDetect = 0;
  private lastSnapshot = 0;
  private lastOutbox = 0;
  private lastPrune = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(store: Store, opts: EngineOptions) {
    this.store = store;
    this.runId = opts.runId;
    this.truth = new SimTruthRepository(store.db);
    const now = opts.now ?? Date.now();
    this.sim = new Simulator(store, this.truth, {
      runId: opts.runId,
      now,
      baseTps: opts.baseTps,
      nPeople: opts.nPeople,
      nMerchants: opts.nMerchants,
    });
    this.trueMules = this.truth.muleIds();
    this.held = new Set(store.holds.activeAccountIds());
    this.outboxCursor = store.outbox.head();
    if (opts.autoStart !== false) this.start();
  }

  start() {
    if (this.timer) return;
    let last = Date.now();
    this.timer = setInterval(() => {
      const now = Date.now();
      try {
        this.tick(now, now - last);
      } catch (err) {
        // one failed tick (e.g. a locked DB) must not kill the loop; the
        // batch rolled back, so nothing half-applied
        console.error("[engine] tick failed", err);
      }
      last = now;
    }, TICK_MS);
    // Never keep the process alive just for the demo loop
    if (typeof this.timer === "object" && "unref" in this.timer) this.timer.unref();
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  /** One simulation step. Public so tests can drive time deterministically. */
  tick(now: number, dt: number) {
    const requests = this.sim.pump(now, dt);
    const results = admitBatch(
      this.store,
      requests.map((r) => ({ ...r, runId: this.runId })),
    );
    const accepted = this.applyResults(requests, results);

    for (const t of accepted) this.graph.add(t);
    this.processed += accepted.length;
    this.tpsWindow.push(accepted.length);
    if (this.tpsWindow.length > 8) this.tpsWindow.shift();

    this.updateFeed(accepted);
    this.graph.prune(now);

    if (now - this.lastDetect >= DETECT_MS) {
      this.lastDetect = now;
      this.held = new Set(this.store.holds.activeAccountIds());
      this.detect(now);
    }
    if (now - this.lastOutbox >= OUTBOX_MS) {
      this.lastOutbox = now;
      this.relayOutbox();
    }
    if (now - this.lastPrune >= PRUNE_MS) {
      this.lastPrune = now;
      pruneHistory(this.store, this.runId, now - retentionMs());
    }
    if (now - this.lastSnapshot >= SNAPSHOT_MS && this.subscribers.size) {
      this.lastSnapshot = now;
      const snap = this.snapshot(now);
      for (const fn of this.subscribers) fn(snap);
    }
  }

  /** Tally gate verdicts; return the accepted payments as live-graph txns. */
  private applyResults(requests: PaymentRequest[], results: AdmittedPayment[]): Txn[] {
    const accepted: Txn[] = [];
    results.forEach((res, i) => {
      const req = requests[i];
      if (res.status === "ACCEPTED" && !res.replayed) {
        accepted.push({
          id: req.txnId,
          ts: req.ts,
          from: req.fromId,
          to: req.toId,
          amount: minorToLegacyRupees(req.amountMinor),
          amountMinor: req.amountMinor,
          scenarioId: req.scenarioId,
        });
        return;
      }
      if (res.status !== "REJECTED" || res.replayed) return;
      if (res.rejectReason !== "HOLD") {
        this.rejectedOther++;
        return;
      }
      this.blockedAttempts++;
      this.blockedAttemptedMinor += req.amountMinor;
      for (const ring of this.rings.values()) {
        if (ring.status === "frozen" && ring.accounts.includes(req.fromId)) {
          ring.intercepted += minorToLegacyRupees(req.amountMinor);
          ring.blockedAttempts = (ring.blockedAttempts ?? 0) + 1;
        }
      }
    });
    return accepted;
  }

  /** Push committed case/hold notifications to SSE subscribers, in order. */
  private relayOutbox() {
    if (!this.caseSubscribers.size) {
      this.outboxCursor = this.store.outbox.head();
      return;
    }
    const events = this.store.outbox.after(this.outboxCursor);
    for (const ev of events) {
      this.outboxCursor = ev.id;
      for (const fn of this.caseSubscribers) fn(ev);
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
    const eligible = (id: string) => this.sim.accounts.get(id)?.kind === "person";
    this.scores = propagate(base, this.graph, eligible);
    for (const [id, s] of this.scores) {
      if (s.score > (this.peakScores.get(id)?.score ?? 0)) this.peakScores.set(id, s);
    }

    for (const [id, s] of this.scores) {
      if (s.score >= ALERT_THRESHOLD && !this.alerted.has(id)) {
        this.alerted.add(id);
        const vpa = this.sim.accounts.get(id)?.vpa ?? id;
        this.pushAlert("warn", `Anomaly: ${vpa}`, s.reasons.slice(0, 3).join(" · "));
      }
    }

    // ring lifecycle — candidates are matched to existing rings by member
    // overlap so a growing ring keeps its identity tick over tick
    for (const cand of extractRings(this.scores, this.graph)) {
      const candSet = new Set(cand.members);
      let existing: Ring | null = null;
      let bestOverlap = 0;
      for (const r of this.rings.values()) {
        const inter = r.accounts.filter((id) => candSet.has(id)).length;
        const overlap = inter / Math.min(r.accounts.length, candSet.size);
        if (overlap > bestOverlap) {
          bestOverlap = overlap;
          existing = r;
        }
      }
      if (existing && bestOverlap >= 0.3) {
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
          blockedAttempts: 0,
        };
        this.rings.set(ring.id, ring);
        this.pushAlert(
          "critical",
          `Suspected mule ring — ${label(ring.pattern)}`,
          `${ring.accounts.length} accounts, ₹${inr(ring.totalFlow)} moved in 90s. Ring risk score ${ring.score}/100.`,
          ring.id,
        );
      }
    }

    // cumulative evaluation against simulator ground truth (engine-only):
    // "did we flag the mules at any point before cash-out"
    for (const scn of this.sim.scenarios) for (const id of scn.muleIds) this.trueMules.add(id);
    const rings = [...this.rings.values()];
    const ev = evaluate(rings, this.scores, this.trueMules);
    this.flagged = ev.flagged;
    for (const r of rings) for (const id of r.accounts) this.everFlagged.add(id);
    for (const [id, s] of this.scores) if (s.score >= ALERT_THRESHOLD) this.everFlagged.add(id);
    const activeTruth = new Set<string>();
    for (const scn of this.sim.scenarios) for (const id of scn.muleIds) activeTruth.add(id);
    if (activeTruth.size > 0 && this.everFlagged.size > 0) {
      let hits = 0;
      for (const id of this.everFlagged) if (this.trueMules.has(id)) hits++;
      let caught = 0;
      for (const id of activeTruth) if (this.everFlagged.has(id)) caught++;
      this.precision = hits / this.everFlagged.size;
      this.recall = caught / activeTruth.size;
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

  pushAlert(severity: Alert["severity"], title: string, detail: string, ringId?: string) {
    this.alerts.push({ id: uid("al"), ts: Date.now(), severity, title, detail, ringId });
    if (this.alerts.length > 40) this.alerts = this.alerts.slice(-40);
  }

  launch(pattern: Pattern): Scenario {
    const scn = this.sim.launch(pattern, Date.now());
    this.pushAlert(
      "info",
      "Attack scenario injected",
      `${label(pattern)} — ₹${inr(minorToLegacyRupees(scn.amountMinor))} entering the network. Watch the graph.`,
    );
    return scn;
  }

  /**
   * Legacy ring freeze: routed through the hold service, so it becomes durable
   * LEGACY_RING holds that the admission gate enforces for every payment path.
   */
  freeze(ringId: string, actorId = "legacy_console"): Ring | null {
    const ring = this.ringById(ringId);
    if (!ring || ring.status === "frozen") return ring ?? null;
    applyLegacyRingHolds(this.store, {
      ringId: ring.id,
      accountIds: ring.accounts,
      ringScore: ring.score,
      pattern: label(ring.pattern),
      actorId,
      now: Date.now(),
    });
    ring.status = "frozen";
    for (const id of ring.accounts) this.held.add(id);
    this.pushAlert(
      "info",
      "Ring debit-frozen (simulated)",
      `${ring.accounts.length} accounts under hold. Further outgoing attempts are rejected at the admission gate.`,
      ring.id,
    );
    return ring;
  }

  ringById(ringId: string): Ring | undefined {
    return this.rings.get(ringId);
  }

  subscribe(fn: (snap: Snapshot) => void): () => void {
    this.subscribers.add(fn);
    fn(this.snapshot(Date.now()));
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** Committed case/hold notifications (outbox relay). */
  subscribeCases(fn: (ev: OutboxEvent) => void): () => void {
    this.caseSubscribers.add(fn);
    return () => {
      this.caseSubscribers.delete(fn);
    };
  }

  snapshot(now: number): Snapshot {
    // hot subgraph: every ring/suspect node + a sample of recent activity
    const include = new Set<string>();
    for (const r of this.rings.values()) for (const id of r.accounts) include.add(id);
    for (const [id, s] of this.scores) if (s.score >= 30) include.add(id);

    const recent = this.graph.active().sort((a, b) => b.lastTouched - a.lastTouched);
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
        frozen: this.held.has(id),
        kind: acc.kind,
        ringId: ringOf.get(id),
      });
    }

    const nodeSet = new Set(nodes.map((n) => n.id));
    const edges: GraphEdge[] = [];
    for (const e of this.graph.edges.values()) {
      if (!nodeSet.has(e.from) || !nodeSet.has(e.to)) continue;
      const flagged = (this.scores.get(e.from)?.score ?? 0) >= 55 && (this.scores.get(e.to)?.score ?? 0) >= 55;
      edges.push({ from: e.from, to: e.to, amount: Math.round(e.amount), count: e.count, lastTs: e.lastTs, flagged });
    }

    const rings = [...this.rings.values()].sort((a, b) => b.detectedAt - a.detectedAt);
    const tps = Math.round(this.tpsWindow.reduce((a, b) => a + b, 0) / ((this.tpsWindow.length * TICK_MS) / 1000) || 0);
    const blockedRupees = Math.round(minorToLegacyRupees(this.blockedAttemptedMinor));

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
        intercepted: blockedRupees,
        blockedAttempts: this.blockedAttempts,
        blockedAttemptedAmount: blockedRupees,
        rejectedOther: this.rejectedOther,
        heldAccounts: this.held.size,
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

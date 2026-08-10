import type { Account, Pattern, Ring, ScoreBreakdown } from "./types";
import { TxnGraph, distinct, sum, type AccountWindow } from "./graph";

// Detection layer — the actual intelligence of the system.
//
//  1. Per-account anomaly scoring over the sliding window
//     (velocity, fan-out, fan-in, pass-through ratio, structuring,
//      new-account risk)
//  2. Suspicion propagation: high-risk scores bleed to counterparties,
//     so quiet middle-layer mules get pulled into the net
//  3. Ring extraction: union-find community detection over the suspicious
//     subgraph, then shape classification (cycle → circular routing,
//     dominant fan-out → layering, many-to-one → smurfing)

const SUSPECT_THRESHOLD = 55; // account joins the suspicious subgraph
const ALERT_THRESHOLD = 70; // account raises its own alert + propagates
const MIN_RING_SIZE = 3;

export function scoreAccount(w: AccountWindow, acc: Account | undefined, now: number): ScoreBreakdown {
  const reasons: string[] = [];
  let score = 0;

  const txnCount = w.inflow.length + w.outflow.length;
  const inAmt = sum(w.inflow);
  const outAmt = sum(w.outflow);
  const fanOut = distinct(w.outflow);
  const fanIn = distinct(w.inflow);

  // Velocity: everyday accounts do a handful of txns/minute at most
  if (txnCount >= 8) {
    score += Math.min(25, (txnCount - 6) * 2.5);
    reasons.push(`${txnCount} txns in 90s window`);
  }

  // Fan-out: money exploding outward to many counterparties
  if (fanOut >= 4 && outAmt > 30_000) {
    score += Math.min(30, fanOut * 5);
    reasons.push(`fan-out to ${fanOut} accounts (₹${Math.round(outAmt).toLocaleString("en-IN")})`);
  }

  // Fan-in: many senders converging (smurfing aggregator shape)
  if (fanIn >= 6) {
    score += Math.min(30, fanIn * 3.5);
    reasons.push(`fan-in from ${fanIn} senders`);
  }

  // Pass-through: money in ≈ money out, fast — the signature of a mule
  if (inAmt > 20_000 && outAmt > 0.8 * inAmt && outAmt < 1.1 * inAmt) {
    const firstIn = w.inflow[0]?.ts ?? now;
    const lastOut = w.outflow[w.outflow.length - 1]?.ts ?? now;
    const holdMs = lastOut - firstIn;
    if (holdMs < 45_000) {
      score += 35;
      reasons.push(`pass-through ${(outAmt / Math.max(inAmt, 1) * 100).toFixed(0)}% in ${Math.max(1, Math.round(holdMs / 1000))}s`);
    }
  }

  // Structuring: repeated just-under-₹10k transfers
  const structured = [...w.inflow, ...w.outflow].filter((x) => x.amount >= 8800 && x.amount < 10_000).length;
  if (structured >= 3) {
    score += Math.min(25, structured * 4);
    reasons.push(`${structured} txns just under ₹10k`);
  }

  // New-account multiplier: fraud runs on freshly opened accounts
  if (acc && score > 0) {
    const ageDays = (now - acc.createdAt) / 86400_000;
    if (ageDays < 7) {
      score *= 1.35;
      reasons.push(`account ${ageDays < 1 ? "<1 day" : `${Math.round(ageDays)} days`} old`);
    }
  }

  return { score: Math.min(100, Math.round(score)), reasons };
}

/** One decay pass: accounts scoring ≥ ALERT_THRESHOLD bleed suspicion to counterparties */
export function propagate(base: Map<string, ScoreBreakdown>, graph: TxnGraph): Map<string, ScoreBreakdown> {
  const eff = new Map(base);
  for (const [id, s] of base) {
    if (s.score < ALERT_THRESHOLD) continue;
    const w = graph.accounts.get(id);
    if (!w) continue;
    const peers = new Set([...w.inflow.map((x) => x.peer), ...w.outflow.map((x) => x.peer)]);
    for (const peer of peers) {
      const bonus = s.score * 0.35;
      const cur = eff.get(peer) ?? { score: 0, reasons: [] };
      if (cur.score < 100) {
        eff.set(peer, {
          score: Math.min(100, Math.round(cur.score + bonus)),
          reasons: cur.reasons.includes("linked to flagged account")
            ? cur.reasons
            : [...cur.reasons, "linked to flagged account"],
        });
      }
    }
  }
  return eff;
}

// ---------- ring extraction (community detection over suspicious subgraph) ----------

class UnionFind {
  parent = new Map<string, string>();
  find(x: string): string {
    if (!this.parent.has(x)) this.parent.set(x, x);
    let r = x;
    while (this.parent.get(r) !== r) r = this.parent.get(r)!;
    // path compression
    let c = x;
    while (this.parent.get(c) !== r) {
      const next = this.parent.get(c)!;
      this.parent.set(c, r);
      c = next;
    }
    return r;
  }
  union(a: string, b: string) {
    this.parent.set(this.find(a), this.find(b));
  }
}

function hasCycle(members: Set<string>, graph: TxnGraph): boolean {
  // DFS over the directed suspicious subgraph
  const adj = new Map<string, string[]>();
  for (const e of graph.edges.values()) {
    if (members.has(e.from) && members.has(e.to)) {
      (adj.get(e.from) ?? adj.set(e.from, []).get(e.from)!).push(e.to);
    }
  }
  const WHITE = 0, GREY = 1, BLACK = 2;
  const color = new Map<string, number>();
  const dfs = (u: string): boolean => {
    color.set(u, GREY);
    for (const v of adj.get(u) ?? []) {
      const c = color.get(v) ?? WHITE;
      if (c === GREY) return true;
      if (c === WHITE && dfs(v)) return true;
    }
    color.set(u, BLACK);
    return false;
  };
  for (const m of members) if ((color.get(m) ?? WHITE) === WHITE && dfs(m)) return true;
  return false;
}

function classify(members: Set<string>, graph: TxnGraph): Pattern | "unknown" {
  if (members.size >= 4 && hasCycle(members, graph)) return "circular_routing";
  let maxFanOut = 0;
  let maxFanIn = 0;
  for (const id of members) {
    const w = graph.accounts.get(id);
    if (!w) continue;
    maxFanOut = Math.max(maxFanOut, distinct(w.outflow.filter((x) => members.has(x.peer))));
    maxFanIn = Math.max(maxFanIn, distinct(w.inflow.filter((x) => members.has(x.peer))));
  }
  if (maxFanIn >= 8) return "smurfing";
  if (maxFanOut >= 4) return "fanout_layering";
  return "unknown";
}

export interface RingCandidate {
  members: string[];
  pattern: Pattern | "unknown";
  score: number;
  totalFlow: number;
  key: string;
}

export function extractRings(eff: Map<string, ScoreBreakdown>, graph: TxnGraph): RingCandidate[] {
  const suspects = new Set(
    [...eff.entries()].filter(([, s]) => s.score >= SUSPECT_THRESHOLD).map(([id]) => id),
  );
  if (suspects.size < MIN_RING_SIZE) return [];

  const uf = new UnionFind();
  for (const e of graph.edges.values()) {
    if (suspects.has(e.from) && suspects.has(e.to)) uf.union(e.from, e.to);
  }

  const comps = new Map<string, Set<string>>();
  for (const id of suspects) {
    const root = uf.find(id);
    if (!comps.has(root)) comps.set(root, new Set());
    comps.get(root)!.add(id);
  }

  const out: RingCandidate[] = [];
  for (const members of comps.values()) {
    if (members.size < MIN_RING_SIZE) continue;
    let flow = 0;
    for (const e of graph.edges.values()) {
      if (members.has(e.from) && members.has(e.to)) flow += e.amount;
    }
    const avg =
      [...members].reduce((a, id) => a + (eff.get(id)?.score ?? 0), 0) / members.size;
    const sorted = [...members].sort();
    out.push({
      members: sorted,
      pattern: classify(members, graph),
      score: Math.round(avg),
      totalFlow: Math.round(flow),
      // stable identity: rings keep their id as they grow tick over tick
      key: sorted.slice(0, 3).join("|"),
    });
  }
  return out;
}

export function evaluate(
  rings: Ring[],
  eff: Map<string, ScoreBreakdown>,
  trueMules: Set<string>,
): { precision: number; recall: number; flagged: number } {
  const flagged = new Set<string>();
  for (const r of rings) for (const id of r.accounts) flagged.add(id);
  for (const [id, s] of eff) if (s.score >= ALERT_THRESHOLD) flagged.add(id);

  if (flagged.size === 0) return { precision: 1, recall: trueMules.size === 0 ? 1 : 0, flagged: 0 };
  let hit = 0;
  for (const id of flagged) if (trueMules.has(id)) hit++;
  const caught = [...trueMules].filter((id) => flagged.has(id)).length;
  return {
    precision: hit / flagged.size,
    recall: trueMules.size === 0 ? 1 : caught / trueMules.size,
    flagged: flagged.size,
  };
}

export { SUSPECT_THRESHOLD, ALERT_THRESHOLD };

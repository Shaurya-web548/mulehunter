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

  // Velocity: everyday accounts touch a handful of txns per window
  if (txnCount >= 10) {
    score += Math.min(25, (txnCount - 8) * 2.5);
    reasons.push(`${txnCount} txns in 90s window`);
  }

  // Fan-out: money exploding outward to many counterparties
  if (fanOut >= 5 && outAmt > 40_000) {
    score += Math.min(30, fanOut * 5);
    reasons.push(`fan-out to ${fanOut} accounts (₹${Math.round(outAmt).toLocaleString("en-IN")})`);
  }

  // Fan-in: many senders converging with real money (smurfing aggregator)
  if (fanIn >= 8 && inAmt > 40_000) {
    score += Math.min(30, fanIn * 3.5);
    reasons.push(`fan-in from ${fanIn} senders`);
  }

  // Pass-through: money in ≈ money out, fast — THE signature of a mule.
  // Weighted so a clean pass-through on a fresh account clears the suspect
  // bar on its own.
  if (inAmt > 15_000 && outAmt > 0.8 * inAmt && outAmt < 1.1 * inAmt) {
    const firstIn = w.inflow[0]?.ts ?? now;
    const lastOut = w.outflow[w.outflow.length - 1]?.ts ?? now;
    const holdMs = lastOut - firstIn;
    if (holdMs < 45_000) {
      score += 45;
      reasons.push(`pass-through ${(outAmt / Math.max(inAmt, 1) * 100).toFixed(0)}% in ${Math.max(1, Math.round(holdMs / 1000))}s`);
    }
  }

  // Loop signature: repeatedly pushing large amounts to the same counterparty
  // (circular routing sends ~the same money around the ring several times)
  const outByPeer = new Map<string, number>();
  for (const x of w.outflow) {
    if (x.amount > 10_000) outByPeer.set(x.peer, (outByPeer.get(x.peer) ?? 0) + 1);
  }
  let maxRepeat = 0;
  for (const c of outByPeer.values()) maxRepeat = Math.max(maxRepeat, c);
  if (maxRepeat >= 2) {
    score += Math.min(20, maxRepeat * 8);
    reasons.push(`${maxRepeat} repeated high-value transfers to the same account`);
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

/**
 * Suspicion propagation with decay: accounts whose *effective* score clears
 * ALERT_THRESHOLD bleed 0.35× of it to their counterparties. Two rounds, so
 * suspicion crosses multi-hop layering chains. The bonus is a max (not a
 * sum), so repeated rounds can't inflate a neighbor's score.
 */
export function propagate(
  base: Map<string, ScoreBreakdown>,
  graph: TxnGraph,
  eligible: (id: string) => boolean,
): Map<string, ScoreBreakdown> {
  const bonus = new Map<string, number>();
  const total = (id: string) => (base.get(id)?.score ?? 0) + (bonus.get(id) ?? 0);

  for (let round = 0; round < 2; round++) {
    const sources = new Set([...base.keys(), ...bonus.keys()]);
    for (const id of sources) {
      const t = total(id);
      if (t < ALERT_THRESHOLD) continue;
      const w = graph.accounts.get(id);
      if (!w) continue;
      // structured-amount edges (just under ₹10k) carry more suspicion:
      // that's how smurf senders get pulled into the ring, while a fraud
      // victim (one large transfer to a hot account) correctly stays out
      const structuredPeers = new Set<string>();
      const peers = new Set<string>();
      for (const x of [...w.inflow, ...w.outflow]) {
        peers.add(x.peer);
        if (x.amount >= 8800 && x.amount < 10_000) structuredPeers.add(x.peer);
      }
      for (const peer of peers) {
        if (!eligible(peer)) continue;
        const b = t * (structuredPeers.has(peer) ? 0.65 : 0.35);
        if (b > (bonus.get(peer) ?? 0)) bonus.set(peer, b);
      }
    }
  }

  const eff = new Map<string, ScoreBreakdown>();
  for (const id of new Set([...base.keys(), ...bonus.keys()])) {
    const b = base.get(id);
    const extra = bonus.get(id) ?? 0;
    eff.set(id, {
      score: Math.min(100, Math.round((b?.score ?? 0) + extra)),
      reasons: extra > 0 ? [...(b?.reasons ?? []), "linked to flagged account"] : (b?.reasons ?? []),
    });
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
  // Order matters: a layering ring's cash-out accounts also show fan-in,
  // so check the dominant fan-out (the blast radius) first. True smurfing
  // has a much higher fan-in (20+ senders on one aggregator).
  if (maxFanIn >= 12) return "smurfing";
  if (maxFanOut >= 4) return "fanout_layering";
  if (maxFanIn >= 8) return "smurfing";
  return "unknown";
}

export interface RingCandidate {
  members: string[];
  pattern: Pattern | "unknown";
  score: number;
  totalFlow: number;
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
    // a ring needs a strong core, not just a cloud of marginal scores
    if (![...members].some((id) => (eff.get(id)?.score ?? 0) >= ALERT_THRESHOLD)) continue;
    let flow = 0;
    for (const e of graph.edges.values()) {
      if (members.has(e.from) && members.has(e.to)) flow += e.amount;
    }
    const avg =
      [...members].reduce((a, id) => a + (eff.get(id)?.score ?? 0), 0) / members.size;
    out.push({
      members: [...members].sort(),
      pattern: classify(members, graph),
      score: Math.round(avg),
      totalFlow: Math.round(flow),
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

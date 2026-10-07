/**
 * Pure downstream trace over accepted ledger history (no I/O, no clock of its
 * own — the caller injects both), so it is reproducible and unit-testable.
 *
 * Semantics (REACHABILITY, not amount attribution):
 *   Starting from the selected disputed payments, follow every ACCEPTED
 *   payment made by a receiving account strictly after it received money
 *   (ledger order: timestamp, then ledger sequence for equal timestamps) and
 *   within `maxHopDelayMs` of that receipt. Accounts reached are "accounts
 *   that received downstream transfers after the disputed payment" — not
 *   proof that the victim's money reached them, and not evidence of
 *   wrongdoing by itself.
 *
 * Algorithm: earliest-arrival temporal traversal. Each account is expanded
 * from its earliest arrival; a later arrival is re-expanded only if it came
 * over FEWER hops (so the hop budget cannot hide a shorter route). An edge
 * that reaches an already-visited account is still recorded — that is how
 * circular routing stays visible (no global "visited ⇒ drop edge" rule).
 * Edges are deduplicated by transaction id and keep every seed that reaches
 * them. Merchants, cash-out sinks and the victim are terminal (recorded, not
 * expanded). Every budget that is hit is reported.
 */

export type NodeKind = "person" | "merchant" | "sink";

export interface LedgerEdge {
  txnId: string;
  fromId: string;
  toId: string;
  amountMinor: number;
  ts: number;
  seq: number;
}

export interface TraceConfig {
  maxHops: number;
  maxNodes: number;
  maxEdges: number;
  maxPaths: number;
  /** outgoing payments read per expanded account */
  maxOutPerNode: number;
  runtimeBudgetMs: number;
  /** only follow payments made within this long after the account received funds */
  maxHopDelayMs: number;
  /** ignore onward payments smaller than this (declared, recorded filter) */
  minEdgeAmountMinor: number;
}

export const DEFAULT_TRACE_CONFIG: TraceConfig = {
  maxHops: 5,
  maxNodes: 500,
  maxEdges: 2000,
  maxPaths: 200,
  maxOutPerNode: 200,
  runtimeBudgetMs: 3000,
  maxHopDelayMs: 2 * 60 * 60 * 1000,
  minEdgeAmountMinor: 100_000, // ₹1,000
};

export const TRACE_ALGORITHM_VERSION = "trace/earliest-arrival/v1";

export interface TraceInput {
  seeds: LedgerEdge[];
  victimId: string;
  kindOf: (accountId: string) => NodeKind;
  /**
   * outgoing accepted payments of `accountId` strictly after (afterTs,
   * afterSeq), up to untilTs, of at least minAmountMinor, ledger-ordered.
   * The amount filter must be applied BEFORE the limit (in SQL), otherwise
   * many small payments could fill the page and hide large ones.
   */
  outgoing: (accountId: string, afterTs: number, afterSeq: number, untilTs: number, limit: number, minAmountMinor: number) => LedgerEdge[];
  config: TraceConfig;
  /** injected monotonic clock (ms) for the runtime budget */
  clock: () => number;
}

export type NodeRole = "VICTIM" | "TRACED" | "MERCHANT" | "SINK";

export interface TraceNode {
  id: string;
  role: NodeRole;
  minHop: number;
  firstReachTs: number;
  firstReachSeq: number;
  expanded: boolean;
  /** why the account's onward payments were not followed, if they were not */
  stopReason: null | "terminal_merchant" | "terminal_sink" | "victim" | "hop_limit" | "node_limit" | "edge_limit" | "runtime_limit";
}

export interface TraceEdgeOut extends LedgerEdge {
  hop: number; // hop number of this edge (seed = 1)
  seedTxnIds: string[];
  isSeed: boolean;
}

export interface TracePathOut {
  id: string;
  nodeIds: string[];
  txnIds: string[];
  /** path ended by revisiting an account already on it (chronological cycle) */
  closesCycle: boolean;
}

export interface TraceCycle {
  nodeIds: string[]; // closed: first === last
  txnIds: string[];
}

export interface TraceTruncation {
  hops: boolean;
  nodes: boolean;
  edges: boolean;
  paths: boolean;
  fanOut: boolean;
  runtime: boolean;
}

export interface TraceResult {
  nodes: TraceNode[];
  edges: TraceEdgeOut[];
  paths: TracePathOut[];
  cycles: TraceCycle[];
  truncated: boolean;
  truncation: TraceTruncation;
  observedDownstreamFlowMinor: number;
  disputedTotalMinor: number;
}

interface State {
  node: string;
  ts: number;
  seq: number;
  hop: number;
  seed: string;
}

const before = (a: { ts: number; seq: number }, b: { ts: number; seq: number }) => a.ts < b.ts || (a.ts === b.ts && a.seq < b.seq);

/** Small binary min-heap on (ts, seq, hop). */
class Heap {
  private a: State[] = [];
  get size() {
    return this.a.length;
  }
  private less(x: State, y: State) {
    return before(x, y) || (x.ts === y.ts && x.seq === y.seq && x.hop < y.hop);
  }
  push(s: State) {
    const a = this.a;
    a.push(s);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (!this.less(a[i], a[p])) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): State | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && this.less(a[l], a[m])) m = l;
        if (r < a.length && this.less(a[r], a[m])) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

function roleOf(id: string, victimId: string, kind: NodeKind): NodeRole {
  if (id === victimId) return "VICTIM";
  if (kind === "merchant") return "MERCHANT";
  if (kind === "sink") return "SINK";
  return "TRACED";
}

export function traceDownstream(input: TraceInput): TraceResult {
  const { config: cfg, victimId } = input;
  const started = input.clock();
  const trunc: TraceTruncation = { hops: false, nodes: false, edges: false, paths: false, fanOut: false, runtime: false };
  const nodes = new Map<string, TraceNode>();
  const edges = new Map<string, TraceEdgeOut>();
  /**
   * Per account: fewest hops it has been expanded at, and how far (in time)
   * its outgoing payments have already been read at that hop count. A later
   * arrival over no fewer hops only reads the EXTENSION of the window
   * (readUntil, arrival + maxHopDelayMs]; an arrival over fewer hops re-reads
   * its whole window. Nothing inside any arrival's window is ever skipped.
   */
  const expanded = new Map<string, { hop: number; readUntil: number }>();
  const heap = new Heap();

  const touchNode = (id: string, hop: number, ts: number, seq: number): TraceNode | null => {
    const existing = nodes.get(id);
    if (existing) {
      if (hop < existing.minHop) existing.minHop = hop;
      if (before({ ts, seq }, { ts: existing.firstReachTs, seq: existing.firstReachSeq })) {
        existing.firstReachTs = ts;
        existing.firstReachSeq = seq;
      }
      return existing;
    }
    if (nodes.size >= cfg.maxNodes) {
      trunc.nodes = true;
      return null;
    }
    const kind = id === victimId ? "person" : input.kindOf(id);
    const n: TraceNode = { id, role: roleOf(id, victimId, kind), minHop: hop, firstReachTs: ts, firstReachSeq: seq, expanded: false, stopReason: null };
    if (n.role === "MERCHANT") n.stopReason = "terminal_merchant";
    if (n.role === "SINK") n.stopReason = "terminal_sink";
    if (n.role === "VICTIM") n.stopReason = "victim";
    nodes.set(id, n);
    return n;
  };

  /** Record an edge; returns false if a budget prevented it. */
  const addEdge = (e: LedgerEdge, hop: number, seed: string, isSeed: boolean): boolean => {
    const prior = edges.get(e.txnId);
    if (prior) {
      if (!prior.seedTxnIds.includes(seed)) prior.seedTxnIds.push(seed);
      if (hop < prior.hop) prior.hop = hop;
      return true;
    }
    if (edges.size >= cfg.maxEdges) {
      trunc.edges = true;
      return false;
    }
    // both endpoints must fit in the node budget, or the edge is dropped
    if (!nodes.has(e.toId) && nodes.size >= cfg.maxNodes) {
      trunc.nodes = true;
      return false;
    }
    touchNode(e.toId, hop, e.ts, e.seq);
    edges.set(e.txnId, { ...e, hop, seedTxnIds: [seed], isSeed });
    return true;
  };

  // victim node first (hop 0), then seeds (hop 1)
  const seeds = [...input.seeds].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  if (seeds.length) touchNode(victimId, 0, seeds[0].ts, seeds[0].seq - 1);
  for (const s of seeds) {
    if (addEdge(s, 1, s.txnId, true)) heap.push({ node: s.toId, ts: s.ts, seq: s.seq, hop: 1, seed: s.txnId });
  }

  while (heap.size) {
    if (input.clock() - started > cfg.runtimeBudgetMs) {
      trunc.runtime = true;
      for (const n of nodes.values()) if (!n.expanded && !n.stopReason) n.stopReason = "runtime_limit";
      break;
    }
    const st = heap.pop()!;
    const node = nodes.get(st.node);
    if (!node || node.role !== "TRACED") continue; // terminal accounts: recorded, not expanded

    const until = st.ts + cfg.maxHopDelayMs;
    const prior = expanded.get(st.node);
    let afterTs = st.ts;
    let afterSeq = st.seq;
    if (prior && prior.hop <= st.hop) {
      // same-or-more hops: only the part of this arrival's window not yet read
      if (until <= prior.readUntil) continue;
      if (prior.readUntil > st.ts) {
        afterTs = prior.readUntil;
        afterSeq = Number.MAX_SAFE_INTEGER; // strictly after readUntil
      }
      prior.readUntil = until;
    } else {
      expanded.set(st.node, { hop: st.hop, readUntil: Math.max(until, prior?.readUntil ?? 0) });
    }

    const outs = input
      .outgoing(st.node, afterTs, afterSeq, until, cfg.maxOutPerNode + 1, cfg.minEdgeAmountMinor)
      .filter((e) => e.amountMinor >= cfg.minEdgeAmountMinor);
    if (st.hop >= cfg.maxHops) {
      if (outs.length) {
        trunc.hops = true;
        if (!node.expanded) node.stopReason = "hop_limit";
      }
      continue;
    }
    if (outs.length > cfg.maxOutPerNode) {
      trunc.fanOut = true;
      outs.length = cfg.maxOutPerNode;
    }
    node.expanded = true;
    node.stopReason = null;
    for (const e of outs) {
      if (!addEdge(e, st.hop + 1, st.seed, false)) {
        node.stopReason = trunc.edges ? "edge_limit" : "node_limit";
        continue;
      }
      heap.push({ node: e.toId, ts: e.ts, seq: e.seq, hop: st.hop + 1, seed: st.seed });
    }
  }

  const edgeList = [...edges.values()].sort((a, b) => a.ts - b.ts || a.seq - b.seq);
  assignProvenance(edgeList);
  const { paths, cycles } = enumeratePaths(edgeList, seeds, nodes, cfg, trunc);
  const truncated = Object.values(trunc).some(Boolean);
  let flow = 0;
  let disputed = 0;
  for (const e of edgeList) {
    if (e.isSeed) disputed += e.amountMinor;
    else flow += e.amountMinor;
  }
  return {
    nodes: [...nodes.values()].sort((a, b) => a.minHop - b.minHop || a.firstReachTs - b.firstReachTs || a.id.localeCompare(b.id)),
    edges: edgeList,
    paths,
    cycles,
    truncated,
    truncation: trunc,
    observedDownstreamFlowMinor: flow,
    disputedTotalMinor: disputed,
  };
}

/**
 * Time-respecting seed provenance: an onward payment carries every seed that
 * had reached its sender (through traced edges) earlier in ledger order. The
 * traversal expands each account once per non-dominated arrival, so this
 * post-pass is what gives overlapping seeds full provenance.
 */
function assignProvenance(ordered: TraceEdgeOut[]): void {
  const reached = new Map<string, Set<string>>();
  for (const e of ordered) {
    const prov = e.isSeed ? new Set([e.txnId]) : new Set(reached.get(e.fromId) ?? e.seedTxnIds);
    e.seedTxnIds = [...prov].sort();
    const at = reached.get(e.toId) ?? new Set<string>();
    for (const s of prov) at.add(s);
    reached.set(e.toId, at);
  }
}

/**
 * Bounded, time-respecting path enumeration over the traced edge set. A path
 * that revisits an account on itself closes a chronological cycle and stops
 * there. Output is capped at maxPaths (flagged), so dense graphs cannot blow
 * up exponentially.
 */
function enumeratePaths(
  edges: TraceEdgeOut[],
  seeds: LedgerEdge[],
  nodes: Map<string, TraceNode>,
  cfg: TraceConfig,
  trunc: TraceTruncation,
): { paths: TracePathOut[]; cycles: TraceCycle[] } {
  const out = new Map<string, TraceEdgeOut[]>();
  for (const e of edges) {
    if (e.isSeed) continue;
    const list = out.get(e.fromId) ?? [];
    list.push(e);
    out.set(e.fromId, list);
  }
  const paths: TracePathOut[] = [];
  const cycles = new Map<string, TraceCycle>();
  const maxSteps = cfg.maxPaths * 50;
  let steps = 0;

  const walk = (nodePath: string[], txnPath: string[], last: { ts: number; seq: number }): void => {
    if (paths.length >= cfg.maxPaths || ++steps > maxSteps) {
      trunc.paths = true;
      return;
    }
    const here = nodePath[nodePath.length - 1];
    const next = (out.get(here) ?? []).filter((e) => before(last, e));
    const role = nodes.get(here)?.role;
    if (!next.length || role !== "TRACED" || txnPath.length >= cfg.maxHops) {
      paths.push({ id: `p${paths.length + 1}`, nodeIds: nodePath, txnIds: txnPath, closesCycle: false });
      return;
    }
    for (const e of next) {
      if (paths.length >= cfg.maxPaths) {
        trunc.paths = true;
        return;
      }
      const at = nodePath.indexOf(e.toId);
      if (at >= 0) {
        const cycNodes = [...nodePath.slice(at), e.toId];
        const cycTxns = [...txnPath.slice(at), e.txnId];
        const key = [...cycTxns].sort().join("|");
        if (!cycles.has(key)) cycles.set(key, { nodeIds: cycNodes, txnIds: cycTxns });
        paths.push({ id: `p${paths.length + 1}`, nodeIds: [...nodePath, e.toId], txnIds: [...txnPath, e.txnId], closesCycle: true });
        continue;
      }
      walk([...nodePath, e.toId], [...txnPath, e.txnId], e);
    }
  };

  for (const s of seeds) {
    if (paths.length >= cfg.maxPaths) {
      trunc.paths = true;
      break;
    }
    walk([s.fromId, s.toId], [s.txnId], s);
  }
  return { paths, cycles: [...cycles.values()] };
}

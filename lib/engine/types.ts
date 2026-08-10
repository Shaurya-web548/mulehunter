export type AccountKind = "person" | "merchant" | "sink";
export type Pattern = "fanout_layering" | "circular_routing" | "smurfing";

export interface Account {
  id: string;
  vpa: string;
  name: string;
  createdAt: number; // simulated account-opening time (ms epoch)
  kind: AccountKind;
  /** Ground truth — visible to the simulator/evaluator, never to the detector */
  isMule: boolean;
  scenarioId?: string;
  frozen: boolean;
}

export interface Txn {
  id: string;
  ts: number;
  from: string;
  to: string;
  amount: number;
  /** Ground truth tag for evaluation only */
  scenarioId?: string;
}

export interface Ring {
  id: string;
  pattern: Pattern | "unknown";
  accounts: string[];
  score: number;
  detectedAt: number;
  status: "active" | "frozen";
  totalFlow: number;
  intercepted: number;
}

export interface Alert {
  id: string;
  ts: number;
  severity: "info" | "warn" | "critical";
  title: string;
  detail: string;
  ringId?: string;
}

export interface Metrics {
  tps: number;
  processed: number;
  accounts: number;
  windowTxns: number;
  flagged: number;
  activeRings: number;
  frozenRings: number;
  precision: number; // ring members that are true mules / ring members
  recall: number; // true mules caught / true mules active
  intercepted: number; // ₹ stopped by freezes
}

export interface GraphNode {
  id: string;
  vpa: string;
  score: number;
  frozen: boolean;
  kind: AccountKind;
  ringId?: string;
}

export interface GraphEdge {
  from: string;
  to: string;
  amount: number;
  count: number;
  lastTs: number;
  flagged: boolean;
}

export interface FeedItem {
  ts: number;
  fromVpa: string;
  toVpa: string;
  amount: number;
  flagged: boolean;
}

export interface Snapshot {
  t: number;
  metrics: Metrics;
  nodes: GraphNode[];
  edges: GraphEdge[];
  rings: Ring[];
  alerts: Alert[];
  feed: FeedItem[];
}

export interface ScoreBreakdown {
  score: number;
  reasons: string[];
}

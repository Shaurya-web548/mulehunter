export type AccountKind = "person" | "merchant" | "sink";
export type Pattern = "fanout_layering" | "circular_routing" | "smurfing";

/**
 * Live-console view of an account. Ground truth (mule labels) is not part of
 * it — it lives in `sim_truth` — and debit-blocking is derived from durable
 * hold records, not from a boolean on the account.
 */
export interface Account {
  id: string;
  vpa: string;
  name: string;
  createdAt: number; // simulated account-opening time (ms epoch)
  kind: AccountKind;
}

/** Accepted transaction as the 90 s live graph sees it (legacy rupee view). */
export interface Txn {
  id: string;
  ts: number;
  from: string;
  to: string;
  /** rupees — derived once from amountMinor by lib/contracts/legacy.ts */
  amount: number;
  amountMinor: number;
  /** Ground truth tag for live evaluation/feed only — never persisted */
  scenarioId?: string;
}

export interface Ring {
  id: string;
  pattern: Pattern | "unknown";
  accounts: string[];
  /** heuristic ring risk score 0–100 (mean member score) — not a probability */
  score: number;
  detectedAt: number;
  status: "active" | "frozen";
  totalFlow: number;
  /**
   * Legacy field name. Rupee sum of debit attempts from ring members that the
   * admission gate REJECTED because of a hold. Attempted amount, not money
   * recovered.
   */
  intercepted: number;
  blockedAttempts?: number;
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
  /** @deprecated alias of blockedAttemptedAmount (rupees) kept for old clients */
  intercepted: number;
  /** unique debit attempts rejected by the gate because of an active hold (this process) */
  blockedAttempts: number;
  /** rupee sum of those attempts — attempted, not recovered */
  blockedAttemptedAmount: number;
  rejectedOther: number;
  heldAccounts: number;
}

export interface GraphNode {
  id: string;
  vpa: string;
  score: number;
  frozen: boolean; // derived: any ACTIVE hold on the account
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

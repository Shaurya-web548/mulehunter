/**
 * Domain contracts for the V2 case-driven Mule Network Hunter upgrade.
 *
 * Money is stored as integer INR paise (minor units) everywhere in the
 * durable domain. The only place conversion happens is the versioned legacy
 * boundary in `money.ts` — never reinterpret a stale rupee value as paise.
 */

// ---------------------------------------------------------------------------
// Accounts and holds
// ---------------------------------------------------------------------------

export type AccountKind = "person" | "merchant" | "sink";

export type HoldType = "VICTIM_PROTECTION" | "MULE_DEBIT_FREEZE";

export type HoldStatus = "ACTIVE" | "RELEASED";

/**
 * A reasoned, independently releasable debit hold. An account is debit-blocked
 * while ANY applicable hold is ACTIVE. Releasing one hold must never remove
 * another case's hold.
 */
export type HoldSource = "CASE" | "LEGACY_RING";

export interface AccountHold {
  id: string;
  accountId: string;
  /** null only for LEGACY_RING holds created by the old /hunt ring freeze. */
  caseId: string | null;
  source?: HoldSource;
  /** ring id for LEGACY_RING holds */
  sourceRef?: string | null;
  /** enforcement action that created a MULE_DEBIT_FREEZE hold */
  actionId?: string | null;
  type: HoldType;
  status: HoldStatus;
  reason: string;
  actorId: string;
  createdAt: number; // ms epoch
  releasedAt: number | null;
  releasedReason: string | null;
  releasedActorId: string | null;
}

export interface Account {
  id: string;
  vpa: string;
  name: string;
  kind: AccountKind;
  createdAt: number; // ms epoch, simulated account opening
  /** Current ledger balance in paise. Funded at seeding; conserved. */
  balanceMinor: number;
  /** Opening (funding) balance; Σ balance = Σ opening balance in a run. */
  openingBalanceMinor?: number;
  /** Simulation run (ledger lineage) the account belongs to. */
  runId?: string;
  /** simulator metadata: takes part in random background traffic */
  basePool?: boolean;
  // Simulator ground truth is deliberately NOT part of this contract: it lives
  // in `sim_truth`, readable only by the simulator/evaluator (lib/engine).
}
// ---------------------------------------------------------------------------
// Payments: attempts and accepted transactions
// ---------------------------------------------------------------------------

export type AttemptStatus = "ACCEPTED" | "REJECTED";

export type RejectReason = "HOLD" | "INSUFFICIENT_FUNDS" | "INVALID" | "SELF_TRANSFER";

export interface PaymentAttempt {
  /** Stable, deduplicated attempt id (client-supplied or generated). */
  attemptId: string;
  status: AttemptStatus;
  runId: string | null;
  fromId: string;
  toId: string;
  amountMinor: number;
  ts: number; // ms epoch, execution time
  rejectReason: RejectReason | null;
  holdId: string | null;
  balanceAfterMinor: number | null;
}

/** An accepted, committed transfer with a ledger sequence for total order. */
export interface AcceptedTransaction {
  txnId: string; // run-scoped transaction id
  runId: string | null;
  fromId: string;
  toId: string;
  amountMinor: number;
  ts: number; // ms epoch
  seq: number; // monotonic per-run ledger order (tie-breaker for equal ts)
  attemptId: string;
}
// ---------------------------------------------------------------------------
// Cases
// ---------------------------------------------------------------------------

export type CaseStage =
  | "REPORTED"
  | "VALIDATED"
  | "TRACING"
  | "ANALYZED"
  | "UNDER_REVIEW"
  | "CLOSED";

/** Investigation stage + outcome-flavoured review states. */
export type CaseStatus = CaseStage | "NEEDS_EVIDENCE";

export interface Case {
  id: string;
  reporterId: string;
  victimAccountId: string;
  incidentStartTs: number;
  incidentEndTs: number;
  declaredLossMinor: number;
  narrative: string;
  stage: CaseStage;
  status: CaseStatus;
  revision: number;
  createdAt: number;
  updatedAt: number;
}

export interface DisputedTransaction {
  caseId: string;
  txnId: string; // accepted_transactions.txn_id
  seq: number;
  amountMinor: number;
  ts: number;
}

// ---------------------------------------------------------------------------
// Tracing
// ---------------------------------------------------------------------------

export interface TraceLimits {
  maxHops: number;
  maxNodes: number;
  maxEdges: number;
  maxPaths: number;
  runtimeBudgetMs: number;
  maxOutPerNode?: number;
  maxHopDelayMs?: number;
  minEdgeAmountMinor?: number;
}

export interface TraceRun {
  id: string;
  caseId: string;
  revision: number;
  status: "RUNNING" | "DONE" | "FAILED";
  seedCount: number;
  nodeCount: number;
  edgeCount: number;
  truncated: boolean;
  limits: TraceLimits;
  /** history window start (first disputed payment) */
  cutoffFrom: number;
  /** fixed wall-clock cutoff of this revision */
  cutoffTo: number;
  startedAt: number;
  finishedAt: number | null;
  error: string | null;
  runId?: string;
  /** fixed ledger-sequence cutoff: replaying this revision reads exactly the same rows */
  cutoffSeq?: number;
  /** part of the window had been pruned before the trace ran */
  historyIncomplete?: boolean;
}

export interface TraceEdge {
  /** Path-specific identity: which branch/path this edge belongs to. */
  pathId: string;
  fromId: string;
  toId: string;
  txnId: string;
  ts: number;
  seq: number;
  amountMinor: number;
  hop: number; // depth of the destination node from a seed
}

export interface TracePath {
  id: string;
  nodes: string[]; // ordered node ids from the seed
  edges: TraceEdge[]; // ordered edges
  truncated: boolean;
}

// ---------------------------------------------------------------------------
// Analysis
// ---------------------------------------------------------------------------

export type Motif = "FAN_OUT" | "FAN_IN" | "CIRCULAR" | "VELOCITY" | "STRUCTURING" | "CASH_OUT";

/** One evidence-backed pattern finding of an analysis revision. */
export interface Finding {
  id: string;
  caseId: string;
  /** analysis revision */
  revision: number;
  motif: Motif;
  accountIds: string[];
  /** concrete supporting transactions */
  txnIds: string[];
  /** points this finding contributes to the heuristic risk score */
  points: number;
  features: Record<string, number | string>;
  explanation: string;
  detectorVersion: string;
  configVersion: string;
  createdAt: number;
}

export interface AnalysisRun {
  caseId: string;
  revision: number;
  traceRevision: number;
  detectorVersion: string;
  configVersion: string;
  config: Record<string, number>;
  summary: { candidates: number; suspected: number; eligible: number; findings: number };
  createdAt: number;
  actorId: string;
}

// ---------------------------------------------------------------------------
// Enforcement
// ---------------------------------------------------------------------------

export type EnforcementActionStatus = "REQUESTED" | "APPLIED" | "FAILED";

/** MANUAL = operator-selected accounts; AUTO_DEMO = explicitly enabled demo policy. */
export type EnforcementPolicy = "MANUAL" | "AUTO_DEMO";

export interface EnforcementAction {
  id: string;
  actionKey: string; // idempotency key, unique per case
  caseId: string;
  accountIds: string[];
  holdIds: string[];
  actorId: string;
  reason: string;
  status: EnforcementActionStatus;
  createdAt: number;
  appliedAt: number | null;
  payloadHash?: string;
  policy?: EnforcementPolicy;
  /** analysis revision whose eligibility the server checked */
  analysisRevision?: number;
}

// ---------------------------------------------------------------------------
// Outcome accounting
// ---------------------------------------------------------------------------

export interface CaseOutcome {
  caseId: string;
  status: CaseStatus;
  victimProtected: boolean;
  activeHoldCount: number;
  muleHoldCount: number;
  uniqueBlockedAttemptCount: number;
  blockedAttemptAmountMinor: number;
  latestBlockedAt: number | null;
  heldBalanceMinor: number;
  heldBalanceAccounts: string[];
  reportedLossMinor: number;
  disputedPaymentTotalMinor: number;
  observedDownstreamFlowMinor: number;
  recoveredOrRefundedMinor: number; // 0 unless an explicit refund operation exists
  caseAttributableHeldMinor: number | null; // null unless an attribution model is implemented
}

// ---------------------------------------------------------------------------
// Audit
// ---------------------------------------------------------------------------

export interface AuditEvent {
  id: string;
  caseId: string | null;
  actorId: string;
  action: string;
  detail: string;
  createdAt: number;
}

// ---------------------------------------------------------------------------
// Result / error envelopes
// ---------------------------------------------------------------------------

export interface ApiError {
  code: string;
  message: string;
}

/** Typed application error carrying an HTTP status and a stable error code. */
export class DomainError extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status = 400) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export interface ScoreContribution {
  feature: string;
  points: number;
  note: string;
}

/** Per-account candidate risk score with feature contributions. */
export interface CandidateScore {
  accountId: string;
  /** heuristic 0..100 risk score — NOT a probability or calibrated confidence */
  riskScore: number;
  contributions: ScoreContribution[];
  /** algorithmic label: score ≥ threshold AND ≥ 1 behavioural finding */
  suspectedMule: boolean;
  role: "VICTIM" | "TRACED" | "MERCHANT" | "SINK";
  /** may be put under a mule debit freeze from this analysis revision */
  eligible: boolean;
  exclusion: string | null;
  features: Record<string, number | string>;
  findingIds: string[];
}
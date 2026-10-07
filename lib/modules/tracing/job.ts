/**
 * Trace job — runs the pure trace over durable accepted history and stores an
 * immutable, content-hashed revision.
 *
 *  - The cutoff is fixed per revision (wall clock AND ledger sequence), so
 *    re-reading a revision is reproducible even while traffic continues.
 *  - Only ACCEPTED transactions are read; rejected attempts never become
 *    money-flow edges.
 *  - If retention pruned part of the window, the revision is marked
 *    `historyIncomplete` instead of pretending it is complete.
 *  - The job is synchronous inside the request but bounded by the runtime
 *    budget. A revision left RUNNING by a crash is marked FAILED at startup
 *    and can be retried; idempotency keys make retries safe.
 */
import crypto from "node:crypto";
import { DomainError, type TraceRun } from "../../contracts/types.ts";
import { canonicalJson, stmt, uid } from "../../persistence/repos/shared.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import { recordCaseEvent } from "../audit/events.ts";
import { historyWatermark } from "../payments/retention.ts";
import { DEFAULT_TRACE_CONFIG, TRACE_ALGORITHM_VERSION, traceDownstream, type NodeKind, type TraceConfig, type TraceResult } from "./trace.ts";

export const TRACE_SNAPSHOT_VERSION = "trace-snapshot/v1";
/** Default look-ahead after the last disputed payment (demo value, configurable). */
export const DEFAULT_TRACE_WINDOW_MS = 24 * 60 * 60 * 1000;

export interface TraceSnapshotNode {
  id: string;
  vpa: string;
  kind: NodeKind;
  role: "VICTIM" | "TRACED" | "MERCHANT" | "SINK";
  minHop: number;
  firstReachTs: number;
  expanded: boolean;
  stopReason: string | null;
}

export interface TraceSnapshot {
  version: string;
  algorithm: string;
  caseId: string;
  revision: number;
  runId: string;
  victimId: string;
  windowFrom: number;
  cutoffTs: number;
  cutoffSeq: number;
  config: TraceConfig;
  seedTxnIds: string[];
  nodes: TraceSnapshotNode[];
  edges: TraceResult["edges"];
  paths: TraceResult["paths"];
  cycles: TraceResult["cycles"];
  truncated: boolean;
  truncation: TraceResult["truncation"];
  historyIncomplete: boolean;
  historyWatermark: number;
  disputedTotalMinor: number;
  observedDownstreamFlowMinor: number;
  semantics: string;
}

export function recoverInterruptedTraces(store: Store, now: number): number {
  const r = stmt(
    store.db,
    "UPDATE case_trace_runs SET status = 'FAILED', error = 'interrupted by process restart — retry the trace', finished_at = ? WHERE status = 'RUNNING'",
  ).run(now);
  return Number(r.changes);
}

function validateConfig(partial: Partial<TraceConfig> | undefined): TraceConfig {
  const cfg = { ...DEFAULT_TRACE_CONFIG, ...(partial ?? {}) };
  const bounds: [keyof TraceConfig, number, number][] = [
    ["maxHops", 1, 8],
    ["maxNodes", 10, 2000],
    ["maxEdges", 10, 5000],
    ["maxPaths", 1, 1000],
    ["maxOutPerNode", 10, 1000],
    ["runtimeBudgetMs", 100, 10_000],
    ["maxHopDelayMs", 1000, 7 * 24 * 3600_000],
    ["minEdgeAmountMinor", 0, 100_000_000],
  ];
  for (const [k, lo, hi] of bounds) {
    const v = cfg[k];
    if (!Number.isInteger(v) || v < lo || v > hi) throw new DomainError("INVALID_TRACE_CONFIG", `${k} must be an integer in [${lo}, ${hi}]`, 400);
  }
  return cfg;
}

export interface StartTraceArgs {
  caseId: string;
  actorId: string;
  now: number;
  idempotencyKey?: string | null;
  config?: Partial<TraceConfig>;
  windowMs?: number;
}

export interface TraceJobResult {
  run: TraceRun;
  snapshot: TraceSnapshot | null;
  replayed: boolean;
}

export function loadSnapshot(store: Store, caseId: string, revision: number): TraceSnapshot | null {
  const s = store.tracing.getSnapshot(caseId, revision);
  return s ? (JSON.parse(s.json) as TraceSnapshot) : null;
}

export function runTrace(store: Store, args: StartTraceArgs): TraceJobResult {
  const cfg = validateConfig(args.config);
  const key = args.idempotencyKey?.trim() || null;

  // Phase 1 — claim a revision (committed RUNNING row + audit).
  const claim = serialTx(store, () => {
    const c = store.cases.get(args.caseId);
    if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${args.caseId} does not exist`, 404);
    if (c.stage === "CLOSED") throw new DomainError("CASE_CLOSED", "a closed case cannot be traced", 409);
    if (key) {
      const prior = store.tracing.byIdempotencyKey(c.id, key);
      if (prior) return { replay: prior };
    }
    const running = store.tracing.latestForCase(c.id);
    if (running?.status === "RUNNING") throw new DomainError("TRACE_IN_PROGRESS", `trace revision ${running.revision} is still running`, 409);

    const disputed = store.cases.disputed(c.id);
    if (!disputed.length) throw new DomainError("NO_SEEDS", "the case has no disputed payments to trace from", 422);
    const victim = store.accounts.get(c.victimAccountId);
    const runId = victim?.runId ?? "";
    const windowFrom = Math.min(...disputed.map((d) => d.ts));
    const windowTo = Math.min(args.now, Math.max(...disputed.map((d) => d.ts)) + (args.windowMs ?? DEFAULT_TRACE_WINDOW_MS));
    const run: TraceRun = {
      id: uid("trace"),
      caseId: c.id,
      revision: store.tracing.nextRevision(c.id),
      status: "RUNNING",
      seedCount: disputed.length,
      nodeCount: 0,
      edgeCount: 0,
      truncated: false,
      limits: cfg,
      cutoffFrom: windowFrom,
      cutoffTo: windowTo,
      startedAt: args.now,
      finishedAt: null,
      error: null,
      runId,
      cutoffSeq: store.accounts.headSeq(runId),
      historyIncomplete: historyWatermark(store, runId) > windowFrom,
    };
    store.tracing.insertRun(run, key);
    if (c.stage === "VALIDATED" || c.stage === "REPORTED") store.cases.setStage(c.id, "TRACING", c.status === "NEEDS_EVIDENCE" ? "NEEDS_EVIDENCE" : "TRACING");
    recordCaseEvent(store, { caseId: c.id, actorId: args.actorId, action: "TRACE_STARTED", detail: { revision: run.revision, cutoffSeq: run.cutoffSeq, config: cfg }, at: args.now });
    return { run, disputed, victimId: c.victimAccountId };
  });

  if ("replay" in claim && claim.replay) {
    return { run: claim.replay, snapshot: loadSnapshot(store, args.caseId, claim.replay.revision), replayed: true };
  }
  const { run, disputed, victimId } = claim as Exclude<typeof claim, { replay: TraceRun }>;

  // Phase 2 — pure traversal over the fixed cutoff (reads only).
  let result: TraceResult;
  try {
    const seeds = disputed.map((d) => {
      const t = store.accounts.getAccepted(d.txnId, run.runId ?? "");
      // the case copied the seed facts at intake, so a pruned seed row is still traceable
      return { txnId: d.txnId, fromId: t?.fromId ?? victimId, toId: t?.toId ?? "", amountMinor: d.amountMinor, ts: d.ts, seq: d.seq };
    });
    const missingSeed = seeds.find((s) => !s.toId);
    if (missingSeed) throw new DomainError("SEED_HISTORY_MISSING", `seed ${missingSeed.txnId} is no longer in retained history`, 422);
    const kinds = new Map<string, NodeKind>();
    const t0 = performance.now();
    result = traceDownstream({
      seeds,
      victimId,
      kindOf: (id) => {
        let k = kinds.get(id);
        if (!k) {
          k = (store.accounts.get(id)?.kind ?? "person") as NodeKind;
          kinds.set(id, k);
        }
        return k;
      },
      outgoing: (acc, afterTs, afterSeq, untilTs, limit, minAmountMinor) =>
        store.accounts.listAccepted(acc, afterTs, afterSeq, Math.min(untilTs, run.cutoffTo), { runId: run.runId, cutoffSeq: run.cutoffSeq, limit, minAmountMinor }),
      config: cfg,
      clock: () => performance.now() - t0,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : "trace failed";
    serialTx(store, () => {
      store.tracing.finishRun(run.id, "FAILED", 0, 0, false, Date.now(), message, run.historyIncomplete);
      recordCaseEvent(store, { caseId: run.caseId, actorId: args.actorId, action: "TRACE_FAILED", detail: { revision: run.revision, error: message }, at: Date.now() });
    });
    throw err instanceof DomainError ? err : new DomainError("TRACE_FAILED", message, 500);
  }

  // Phase 3 — persist the immutable revision.
  const snapshot: TraceSnapshot = {
    version: TRACE_SNAPSHOT_VERSION,
    algorithm: TRACE_ALGORITHM_VERSION,
    caseId: run.caseId,
    revision: run.revision,
    runId: run.runId ?? "",
    victimId,
    windowFrom: run.cutoffFrom,
    cutoffTs: run.cutoffTo,
    cutoffSeq: run.cutoffSeq ?? 0,
    config: cfg,
    seedTxnIds: disputed.map((d) => d.txnId),
    nodes: result.nodes.map((n) => {
      const a = store.accounts.get(n.id);
      return {
        id: n.id,
        vpa: a?.vpa ?? n.id,
        kind: (a?.kind ?? "person") as NodeKind,
        role: n.role,
        minHop: n.minHop,
        firstReachTs: n.firstReachTs,
        expanded: n.expanded,
        stopReason: n.stopReason,
      };
    }),
    edges: result.edges,
    paths: result.paths,
    cycles: result.cycles,
    truncated: result.truncated,
    truncation: result.truncation,
    historyIncomplete: !!run.historyIncomplete,
    historyWatermark: historyWatermark(store, run.runId ?? ""),
    disputedTotalMinor: result.disputedTotalMinor,
    observedDownstreamFlowMinor: result.observedDownstreamFlowMinor,
    semantics:
      "Reachability: accounts that received accepted downstream transfers after the disputed payment(s), in ledger order. " +
      "Not amount attribution and not evidence of wrongdoing on its own.",
  };
  const json = canonicalJson(snapshot);
  const hash = crypto.createHash("sha256").update(json).digest("hex");
  const finishedAt = Math.max(args.now, Date.now());
  serialTx(store, () => {
    store.tracing.putSnapshot(run.caseId, run.revision, json, hash);
    store.tracing.insertEdges(
      run.caseId,
      run.revision,
      result.edges.map((e) => ({ pathId: e.seedTxnIds.join(","), fromId: e.fromId, toId: e.toId, txnId: e.txnId, ts: e.ts, seq: e.seq, amountMinor: e.amountMinor, hop: e.hop })),
    );
    store.tracing.finishRun(run.id, "DONE", result.nodes.length, result.edges.length, result.truncated, finishedAt, null, snapshot.historyIncomplete);
    recordCaseEvent(store, {
      caseId: run.caseId,
      actorId: args.actorId,
      action: "TRACE_COMPLETED",
      detail: { revision: run.revision, nodes: result.nodes.length, edges: result.edges.length, truncated: result.truncated, historyIncomplete: snapshot.historyIncomplete, contentHash: hash },
      at: finishedAt,
    });
  });
  return { run: store.tracing.getRun(run.id)!, snapshot, replayed: false };
}

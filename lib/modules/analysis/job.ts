/**
 * Analysis job — analyzes one immutable trace revision and stores an
 * immutable analysis revision: findings (with supporting transaction ids),
 * per-account candidates (risk score, contributions, eligibility), detector
 * version, config + config hash, and the trace revision it was derived from.
 *
 * Inputs are detector-safe: ledger rows and account metadata only. Simulator
 * ground truth is not reachable from `Store`.
 */
import crypto from "node:crypto";
import { DomainError, type AnalysisRun, type CandidateScore, type Finding } from "../../contracts/types.ts";
import { canonicalJson, uid } from "../../persistence/repos/shared.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import { recordCaseEvent } from "../audit/events.ts";
import { loadSnapshot, type TraceSnapshot } from "../tracing/job.ts";
import { analyzeCase, DEFAULT_ANALYSIS_CONFIG, DETECTOR_VERSION, type AccountContext, type AnalysisConfig } from "./score.ts";

const CONTEXT_LIMIT = 500;

export function configVersion(cfg: AnalysisConfig): string {
  return `cfg-${crypto.createHash("sha256").update(canonicalJson(cfg)).digest("hex").slice(0, 12)}`;
}

/** Bounded ledger context for each traced account, within the trace's fixed cutoff. */
export function buildContext(store: Store, snap: TraceSnapshot, caseId: string, cfg: AnalysisConfig): AccountContext[] {
  const from = snap.windowFrom - cfg.fanWindowMs;
  const tracedIn = new Map<string, string[]>();
  for (const e of snap.edges) tracedIn.set(e.toId, [...(tracedIn.get(e.toId) ?? []), e.txnId]);
  const sinkIds = new Set(snap.nodes.filter((n) => n.role === "SINK").map((n) => n.id));
  return snap.nodes.map((n) => {
    const acc = store.accounts.get(n.id);
    for (const e of store.accounts.listOutgoing(snap.runId, n.id, from, snap.cutoffTs, snap.cutoffSeq, 1)) {
      const k = store.accounts.get(e.toId)?.kind;
      if (k === "sink") sinkIds.add(e.toId);
    }
    const scorable = n.role === "TRACED";
    const inflows = scorable ? store.accounts.listIncoming(snap.runId, n.id, from, snap.cutoffTs, snap.cutoffSeq, CONTEXT_LIMIT) : [];
    const outflows = scorable ? store.accounts.listOutgoing(snap.runId, n.id, from, snap.cutoffTs, snap.cutoffSeq, CONTEXT_LIMIT) : [];
    for (const o of outflows) if (store.accounts.get(o.toId)?.kind === "sink") sinkIds.add(o.toId);
    return {
      id: n.id,
      kind: n.kind,
      createdAt: acc?.createdAt ?? 0,
      role: n.role,
      inflows: inflows.map((t) => ({ txnId: t.txnId, fromId: t.fromId, toId: t.toId, amountMinor: t.amountMinor, ts: t.ts, seq: t.seq })),
      outflows: outflows.map((t) => ({ txnId: t.txnId, fromId: t.fromId, toId: t.toId, amountMinor: t.amountMinor, ts: t.ts, seq: t.seq })),
      tracedInTxnIds: tracedIn.get(n.id) ?? [],
      victimInOtherCases: store.cases.victimCaseIds(n.id).filter((id) => id !== caseId),
      sinkIds,
    };
  });
}

export interface AnalysisResult {
  run: AnalysisRun;
  findings: Finding[];
  candidates: CandidateScore[];
  replayed: boolean;
}

export function runAnalysis(
  store: Store,
  args: { caseId: string; actorId: string; now: number; traceRevision?: number; idempotencyKey?: string | null; config?: Partial<AnalysisConfig> },
): AnalysisResult {
  const key = args.idempotencyKey?.trim() || null;
  const cfg: AnalysisConfig = { ...DEFAULT_ANALYSIS_CONFIG, ...(args.config ?? {}) };
  for (const [k, v] of Object.entries(cfg)) {
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) throw new DomainError("INVALID_ANALYSIS_CONFIG", `${k} must be a non-negative number`, 400);
  }

  return serialTx(store, () => {
    const c = store.cases.get(args.caseId);
    if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${args.caseId} does not exist`, 404);
    if (key) {
      const prior = store.analysis.runByKey(c.id, key);
      if (prior) {
        return {
          run: prior,
          findings: store.analysis.listFindings(c.id, prior.revision),
          candidates: store.analysis.listCandidates(c.id, prior.revision),
          replayed: true,
        };
      }
    }
    const trace = args.traceRevision ? store.tracing.byRevision(c.id, args.traceRevision) : store.tracing.latestDone(c.id);
    if (!trace) throw new DomainError("NO_TRACE", "run a trace before analysis", 409);
    if (trace.status !== "DONE") throw new DomainError("TRACE_NOT_DONE", `trace revision ${trace.revision} is ${trace.status}`, 409);
    const snap = loadSnapshot(store, c.id, trace.revision);
    if (!snap) throw new DomainError("TRACE_SNAPSHOT_MISSING", `trace revision ${trace.revision} has no snapshot`, 500);

    const out = analyzeCase({ accounts: buildContext(store, snap, c.id, cfg), cycles: snap.cycles, now: args.now, config: cfg });
    const revision = store.analysis.nextRevision(c.id);
    const cv = configVersion(cfg);
    const idOf = new Map<string, string>();
    const findings: Finding[] = out.findings.map((f) => {
      const id = uid("fnd");
      idOf.set(f.key, id);
      return {
        id,
        caseId: c.id,
        revision,
        motif: f.motif,
        accountIds: f.accountIds,
        txnIds: f.txnIds,
        points: f.points,
        features: f.features,
        explanation: f.explanation,
        detectorVersion: DETECTOR_VERSION,
        configVersion: cv,
        createdAt: args.now,
      };
    });
    const candidates: CandidateScore[] = out.candidates.map((d) => ({
      accountId: d.accountId,
      riskScore: d.riskScore,
      contributions: d.contributions,
      suspectedMule: d.suspectedMule,
      role: d.role,
      eligible: d.eligible,
      exclusion: d.exclusion,
      features: d.features,
      findingIds: d.findingKeys.map((k) => idOf.get(k)!).filter(Boolean),
    }));
    const summary = {
      candidates: candidates.filter((x) => x.role === "TRACED").length,
      suspected: candidates.filter((x) => x.suspectedMule).length,
      eligible: candidates.filter((x) => x.eligible).length,
      findings: findings.length,
    };
    const run: AnalysisRun = {
      caseId: c.id,
      revision,
      traceRevision: trace.revision,
      detectorVersion: DETECTOR_VERSION,
      configVersion: cv,
      config: cfg as unknown as Record<string, number>,
      summary,
      createdAt: args.now,
      actorId: args.actorId,
    };
    store.analysis.insertRun(run, key);
    store.analysis.insert(c.id, revision, findings, candidates);
    if (c.stage !== "CLOSED") {
      if (summary.suspected > 0) store.cases.setStage(c.id, "UNDER_REVIEW", "UNDER_REVIEW");
      else store.cases.setStage(c.id, "ANALYZED", "NEEDS_EVIDENCE");
    }
    recordCaseEvent(store, {
      caseId: c.id,
      actorId: args.actorId,
      action: "ANALYSIS_COMPLETED",
      detail: { revision, traceRevision: trace.revision, detectorVersion: DETECTOR_VERSION, configVersion: cv, ...summary },
      at: args.now,
    });
    return { run, findings, candidates, replayed: false };
  });
}

/**
 * Case read model for the API/UI. The workflow stepper is derived from
 * persisted state only (holds, trace runs, analysis revisions, actions,
 * blocked attempts) — never from timers or client assumptions.
 */
import { DomainError, type Case } from "../../contracts/types.ts";
import type { Store } from "../../persistence/store.ts";
import { computeOutcome } from "../outcomes/outcome.ts";
import { autoDemoEnabled } from "../enforcement/freeze.ts";

export type StepState = "done" | "active" | "pending" | "failed" | "skipped" | "stale" | "attention";

export interface Step {
  key: "reported" | "protected" | "traced" | "analyzed" | "reviewed" | "enforced" | "outcome";
  label: string;
  state: StepState;
  detail: string;
  at: number | null;
}

export function caseSteps(store: Store, c: Case): Step[] {
  const holds = store.holds.listForCase(c.id);
  const victimHolds = holds.filter((h) => h.type === "VICTIM_PROTECTION");
  const activeVictim = victimHolds.find((h) => h.status === "ACTIVE");
  const trace = store.tracing.latestForCase(c.id);
  const analysis = store.analysis.latestRun(c.id);
  const actions = store.enforcement.listForCase(c.id);
  const outcome = computeOutcome(store, c.id);

  const protectedStep: Step = activeVictim
    ? { key: "protected", label: "Victim protected", state: "done", detail: "future victim debits blocked; credits allowed", at: activeVictim.createdAt }
    : victimHolds.length
      ? { key: "protected", label: "Victim protected", state: "attention", detail: "victim protection was released", at: victimHolds[0].releasedAt }
      : { key: "protected", label: "Victim protected", state: "skipped", detail: "no victim protection hold", at: null };

  const traced: Step = !trace
    ? { key: "traced", label: "Transactions traced", state: "pending", detail: "not traced yet", at: null }
    : trace.status === "RUNNING"
      ? { key: "traced", label: "Transactions traced", state: "active", detail: `revision ${trace.revision} running`, at: trace.startedAt }
      : trace.status === "FAILED"
        ? { key: "traced", label: "Transactions traced", state: "failed", detail: trace.error ?? "trace failed", at: trace.finishedAt }
        : {
            key: "traced",
            label: "Transactions traced",
            state: trace.truncated || trace.historyIncomplete ? "attention" : "done",
            detail: `revision ${trace.revision}: ${trace.nodeCount} accounts, ${trace.edgeCount} transfers${trace.truncated ? " — truncated" : ""}${trace.historyIncomplete ? " — history incomplete" : ""}`,
            at: trace.finishedAt,
          };

  const latestDone = store.tracing.latestDone(c.id);
  const analyzed: Step = !analysis
    ? { key: "analyzed", label: "Patterns analyzed", state: "pending", detail: "not analyzed yet", at: null }
    : latestDone && analysis.traceRevision < latestDone.revision
      ? { key: "analyzed", label: "Patterns analyzed", state: "stale", detail: `analysis r${analysis.revision} uses trace r${analysis.traceRevision}; trace r${latestDone.revision} is newer`, at: analysis.createdAt }
      : { key: "analyzed", label: "Patterns analyzed", state: "done", detail: `r${analysis.revision}: ${analysis.summary.suspected} suspected, ${analysis.summary.eligible} eligible`, at: analysis.createdAt };

  const reviewed: Step = !analysis
    ? { key: "reviewed", label: "Suspects reviewed", state: "pending", detail: "awaiting analysis", at: null }
    : c.status === "NEEDS_EVIDENCE"
      ? { key: "reviewed", label: "Suspects reviewed", state: "attention", detail: "needs evidence — no account met the suspected-mule criteria", at: analysis.createdAt }
      : actions.length
        ? { key: "reviewed", label: "Suspects reviewed", state: "done", detail: "operator decision recorded", at: actions[0].createdAt }
        : { key: "reviewed", label: "Suspects reviewed", state: "active", detail: "awaiting operator review", at: null };

  const enforced: Step = actions.length
    ? { key: "enforced", label: "Mule accounts frozen", state: outcome.containment === "HOLDS_ACTIVE" ? "done" : "attention", detail: `${outcome.muleHolds.active} active, ${outcome.muleHolds.released} released (simulated)`, at: actions[0].appliedAt }
    : { key: "enforced", label: "Mule accounts frozen", state: c.status === "NEEDS_EVIDENCE" ? "skipped" : "pending", detail: "no freeze applied", at: null };

  const outcomeStep: Step = outcome.blocked.fromMuleHolds.count
    ? { key: "outcome", label: "Debits rejected", state: "done", detail: `${outcome.blocked.fromMuleHolds.count} mule debit attempt(s) rejected`, at: outcome.blocked.latestAt }
    : { key: "outcome", label: "Debits rejected", state: actions.length ? "active" : "pending", detail: actions.length ? "holds active; no attempt observed yet" : "no mule hold yet", at: null };

  return [
    { key: "reported", label: "Fraud reported", state: "done", detail: `stage ${c.stage}`, at: c.createdAt },
    protectedStep,
    traced,
    analyzed,
    reviewed,
    enforced,
    outcomeStep,
  ];
}

export function caseView(store: Store, caseId: string) {
  const c = store.cases.get(caseId);
  if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  const account = (id: string) => {
    const a = store.accounts.get(id);
    return { id, vpa: a?.vpa ?? id, kind: a?.kind ?? "person" };
  };
  const holds = store.holds.listForCase(caseId).map((h) => ({ ...h, account: account(h.accountId), otherActiveHolds: store.holds.listActiveForAccount(h.accountId).filter((x) => x.id !== h.id).length }));
  return {
    case: c,
    victim: { ...account(c.victimAccountId), balanceMinor: store.accounts.get(c.victimAccountId)?.balanceMinor ?? null },
    disputed: store.cases.disputed(caseId).map((d) => {
      const t = store.accounts.acceptedByTxnId(d.txnId)[0];
      return { ...d, to: t ? account(t.toId) : null };
    }),
    holds,
    traces: store.tracing.listForCase(caseId),
    analysis: store.analysis.latestRun(caseId),
    actions: store.enforcement.listForCase(caseId),
    steps: caseSteps(store, c),
    audit: store.audit.list(caseId, 200),
    reports: store.reports.list(caseId),
    policy: { autoDemoEnabled: autoDemoEnabled() },
  };
}

/**
 * Case outcome accounting — factual, qualified, deduplicated.
 *
 * Definitions (docs/WORKFLOW_V2_CASE_DRIVEN.md §"Outcome accounting"):
 *  - reportedLoss: what the reporter declared (not validated)
 *  - disputedPaymentTotal: sum of the unique accepted seed payments
 *  - observedDownstreamFlow: unique traced onward edge volume — can count the
 *    same money at several hops; never a loss or recovery figure
 *  - blocked attempts: unique attempt ids REJECTED by the gate for a hold,
 *    from an account while one of THIS case's holds on it was active.
 *    Attempted amount, not money recovered; retries with new ids add up and
 *    can exceed what the account ever held.
 *  - heldBalance: current ledger balance of accounts under this case's active
 *    mule holds — may include funds unrelated to the case
 *  - caseAttributableHeld: the victim's money in those frozen accounts under
 *    the disclosed PROPORTIONAL attribution model (lib/modules/attribution)
 *  - recovered/refunded: sum of actual recovery transfers to the victim
 */
import { DomainError, type AccountHold } from "../../contracts/types.ts";
import { stmt } from "../../persistence/repos/shared.ts";
import { minorToInr } from "../../contracts/money.ts";
import type { Store } from "../../persistence/store.ts";
import { loadSnapshot } from "../tracing/job.ts";
import { computeAttribution, type CaseAttribution } from "../attribution/job.ts";

export interface BlockedAttemptRecord {
  attemptId: string;
  fromId: string;
  fromVpa: string;
  toId: string;
  amountMinor: number;
  ts: number;
  /** hold the gate cited (the oldest active hold — may belong to another case) */
  gateHoldId: string;
  /** this case's hold(s) that were active on the account at that moment */
  caseHoldIds: string[];
  holdType: "VICTIM_PROTECTION" | "MULE_DEBIT_FREEZE";
}

export type Containment = "NO_MULE_HOLDS" | "HOLDS_ACTIVE" | "PARTIALLY_RELEASED" | "ALL_RELEASED";

export interface CaseOutcomeView {
  caseId: string;
  asOf: number;
  reportedLossMinor: number;
  disputedPaymentTotalMinor: number;
  observedDownstreamFlowMinor: number | null;
  observedFlowTraceRevision: number | null;
  victim: { accountId: string; protected: boolean; protectedSince: number | null; balanceMinor: number | null };
  muleHolds: { active: number; released: number; accounts: string[]; firstFrozenAt: number | null };
  containment: Containment;
  blocked: {
    uniqueAttemptCount: number;
    attemptedAmountMinor: number;
    latestAt: number | null;
    fromMuleHolds: { count: number; amountMinor: number };
    fromVictimProtection: { count: number; amountMinor: number };
    records: BlockedAttemptRecord[];
  };
  heldBalanceMinor: number;
  /** victim's attributed money in accounts frozen by this case (PROPORTIONAL model) */
  caseAttributableHeldMinor: number;
  /** actual recovery transfers returned to the victim */
  recoveredOrRefundedMinor: number;
  attribution: Pick<CaseAttribution, "policy" | "totals" | "truncated" | "historyIncomplete">;
  qualifications: string[];
  labels: string[];
}

const RECORD_LIMIT = 200;

export function computeOutcome(store: Store, caseId: string, now = Date.now()): CaseOutcomeView {
  const c = store.cases.get(caseId);
  if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  const disputed = store.cases.disputed(caseId);
  const holds = store.holds.listForCase(caseId);
  const trace = store.tracing.latestDone(caseId);
  const snap = trace ? loadSnapshot(store, caseId, trace.revision) : null;

  const holdsByAccount = new Map<string, AccountHold[]>();
  for (const h of holds) holdsByAccount.set(h.accountId, [...(holdsByAccount.get(h.accountId) ?? []), h]);

  // unique attempts, attributed to this case only while its hold was active
  const seen = new Map<string, BlockedAttemptRecord>();
  for (const [accountId, hs] of holdsByAccount) {
    const since = Math.min(...hs.map((h) => h.createdAt));
    const rows = stmt(
      store.db,
      `SELECT attempt_id, from_id, to_id, amount_minor, ts, hold_id FROM payment_attempts
       WHERE status = 'REJECTED' AND reject_reason = 'HOLD' AND from_id = ? AND ts >= ? ORDER BY ts, attempt_id`,
    ).all(accountId, since);
    for (const r of rows) {
      const ts = Number(r.ts);
      const active = hs.filter((h) => h.createdAt <= ts && (h.releasedAt === null || ts < h.releasedAt));
      if (!active.length) continue;
      const id = String(r.attempt_id);
      if (seen.has(id)) continue;
      seen.set(id, {
        attemptId: id,
        fromId: accountId,
        fromVpa: store.accounts.get(accountId)?.vpa ?? accountId,
        toId: String(r.to_id),
        amountMinor: Number(r.amount_minor),
        ts,
        gateHoldId: String(r.hold_id),
        caseHoldIds: active.map((h) => h.id),
        holdType: active.some((h) => h.type === "MULE_DEBIT_FREEZE") ? "MULE_DEBIT_FREEZE" : "VICTIM_PROTECTION",
      });
    }
  }
  const records = [...seen.values()].sort((a, b) => b.ts - a.ts || a.attemptId.localeCompare(b.attemptId));
  const sum = (xs: BlockedAttemptRecord[]) => xs.reduce((s, x) => s + x.amountMinor, 0);
  const mule = records.filter((r) => r.holdType === "MULE_DEBIT_FREEZE");
  const vict = records.filter((r) => r.holdType === "VICTIM_PROTECTION");

  const victimHolds = holds.filter((h) => h.type === "VICTIM_PROTECTION");
  const activeVictim = victimHolds.filter((h) => h.status === "ACTIVE");
  const muleHolds = holds.filter((h) => h.type === "MULE_DEBIT_FREEZE");
  const activeMule = muleHolds.filter((h) => h.status === "ACTIVE");
  const heldAccounts = [...new Set(activeMule.map((h) => h.accountId))];
  const heldBalanceMinor = heldAccounts.reduce((s, id) => s + (store.accounts.get(id)?.balanceMinor ?? 0), 0);

  const attribution = computeAttribution(store, caseId, now);
  const recovered = store.recoveries.totalForCase(caseId);

  const containment: Containment = !muleHolds.length
    ? "NO_MULE_HOLDS"
    : activeMule.length === muleHolds.length
      ? "HOLDS_ACTIVE"
      : activeMule.length
        ? "PARTIALLY_RELEASED"
        : "ALL_RELEASED";

  const labels: string[] = [];
  if (activeVictim.length) labels.push("Victim account protected (future debits blocked)");
  if (containment === "HOLDS_ACTIVE") labels.push(`Contained: ${heldAccounts.length} suspected-mule account(s) under active debit freeze`);
  if (containment === "PARTIALLY_RELEASED") labels.push("Partially contained: some mule holds were released");
  if (mule.length) labels.push(`Blocked attempt observed: ${mule.length} outgoing mule debit(s) rejected`);
  if (!muleHolds.length && c.status === "NEEDS_EVIDENCE") labels.push("Needs evidence: no account met the suspected-mule criteria");
  if (recovered > 0) labels.push(`Recovered to victim: ${minorToInr(recovered)} of ${minorToInr(disputed.reduce((s, d) => s + d.amountMinor, 0))}`);
  if (attribution.totals.recoverableNowMinor > 0) labels.push(`Recoverable now from frozen accounts: ${minorToInr(attribution.totals.recoverableNowMinor)}`);

  const qualifications = [
    "Blocked attempted amount is the sum of rejected attempts, not money recovered; repeated attempts can exceed available funds.",
    "Held balance is the current balance of frozen accounts and may include funds unrelated to this case.",
    "Observed downstream flow counts traced edge volumes; the same money can appear at several hops.",
    "Victim money per account uses the PROPORTIONAL (pro-rata) model: each payment out of an account carries the victim's share of that account's balance at that moment; the account holder's own money is never counted.",
    "Recovered is the sum of actual transfers back to the victim from accounts this case froze; they are ledger transactions visible in the audit trail.",
  ];
  if (attribution.truncated) qualifications.push("Attribution hit a budget: part of the victim's money is untracked.");
  if (attribution.historyIncomplete) qualifications.push("Attribution history is incomplete (pruned or missing seed rows).");
  if (snap?.historyIncomplete) qualifications.push("Trace history is incomplete: part of the window had been pruned.");
  if (snap?.truncated) qualifications.push("Trace was truncated by a budget; downstream coverage is partial.");

  return {
    caseId,
    asOf: now,
    reportedLossMinor: c.declaredLossMinor,
    disputedPaymentTotalMinor: disputed.reduce((s, d) => s + d.amountMinor, 0),
    observedDownstreamFlowMinor: snap ? snap.observedDownstreamFlowMinor : null,
    observedFlowTraceRevision: snap ? snap.revision : null,
    victim: {
      accountId: c.victimAccountId,
      protected: activeVictim.length > 0,
      protectedSince: activeVictim.length ? Math.min(...activeVictim.map((h) => h.createdAt)) : null,
      balanceMinor: store.accounts.get(c.victimAccountId)?.balanceMinor ?? null,
    },
    muleHolds: {
      active: activeMule.length,
      released: muleHolds.length - activeMule.length,
      accounts: heldAccounts,
      firstFrozenAt: muleHolds.length ? Math.min(...muleHolds.map((h) => h.createdAt)) : null,
    },
    containment,
    blocked: {
      uniqueAttemptCount: records.length,
      attemptedAmountMinor: sum(records),
      latestAt: records[0]?.ts ?? null,
      fromMuleHolds: { count: mule.length, amountMinor: sum(mule) },
      fromVictimProtection: { count: vict.length, amountMinor: sum(vict) },
      records: records.slice(0, RECORD_LIMIT),
    },
    heldBalanceMinor,
    caseAttributableHeldMinor: attribution.totals.heldInFrozenMinor,
    recoveredOrRefundedMinor: recovered,
    attribution: { policy: attribution.policy, totals: attribution.totals, truncated: attribution.truncated, historyIncomplete: attribution.historyIncomplete },
    qualifications,
    labels,
  };
}

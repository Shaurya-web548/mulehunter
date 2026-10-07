/**
 * Runs victim-fund attribution for a case against the durable ledger "as of
 * now" (the computation is synchronous, so the ledger head cannot move while
 * it runs) and joins it with the case's holds and past recoveries.
 */
import { DomainError } from "../../contracts/types.ts";
import type { Store } from "../../persistence/store.ts";
import { historyWatermark } from "../payments/retention.ts";
import { attributeVictimFunds, DEFAULT_ATTRIBUTION_CONFIG, ATTRIBUTION_POLICY, type AccountKind, type AttributionResult } from "./attribute.ts";

export interface AttributedAccountView {
  accountId: string;
  vpa: string;
  kind: AccountKind;
  /** victim's money in the account now */
  heldMinor: number;
  balanceMinor: number;
  /** share of the account balance that is the victim's money, 0–100 */
  sharePct: number;
  frozenByCase: boolean;
  holdId: string | null;
  /** what a recovery could return right now: min(held, balance) if frozen by this case */
  recoverableNowMinor: number;
  recoveredMinor: number;
  truncated: boolean;
}

export interface CaseAttribution {
  caseId: string;
  policy: string;
  asOf: number;
  ledgerHeadSeq: number;
  disputedMinor: number;
  totals: {
    recoverableNowMinor: number;
    heldInFrozenMinor: number;
    atRiskUnfrozenMinor: number;
    cashedOutMinor: number;
    spentAtMerchantsMinor: number;
    returnedToVictimMinor: number;
    recoveredMinor: number;
    dustMinor: number;
    untrackedMinor: number;
  };
  accounts: AttributedAccountView[];
  flows: (AttributionResult["flows"][number] & { fromVpa: string; toVpa: string })[];
  truncated: boolean;
  historyIncomplete: boolean;
  method: string;
}

export function computeAttribution(store: Store, caseId: string, now = Date.now()): CaseAttribution {
  const c = store.cases.get(caseId);
  if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  const victim = store.accounts.get(c.victimAccountId);
  const runId = victim?.runId ?? "";
  const head = store.accounts.headSeq(runId);
  const disputed = store.cases.disputed(caseId);
  const seeds = disputed.map((d) => {
    const t = store.accounts.getAccepted(d.txnId, runId);
    return { txnId: d.txnId, fromId: t?.fromId ?? c.victimAccountId, toId: t?.toId ?? "", amountMinor: d.amountMinor, seq: d.seq, ts: d.ts };
  });
  const missing = seeds.some((s) => !s.toId);
  const result = attributeVictimFunds({
    seeds: seeds.filter((s) => s.toId),
    victimId: c.victimAccountId,
    kindOf: (id) => (store.accounts.get(id)?.kind ?? "person") as AccountKind,
    balanceBefore: (id, seq) => {
      const bal = store.accounts.get(id)?.balanceMinor ?? 0;
      const f = store.accounts.netFlowFromSeq(runId, id, seq, Number.MAX_SAFE_INTEGER);
      return bal - f.inMinor + f.outMinor;
    },
    events: (id, afterSeq, limit) => store.accounts.eventsAfterSeq(runId, id, afterSeq, head, limit),
    recoveries: store.recoveries.allTxnCases(),
    caseId,
    config: DEFAULT_ATTRIBUTION_CONFIG,
    clock: () => Date.now() - now,
  });

  const holds = store.holds.listForCase(caseId).filter((h) => h.type === "MULE_DEBIT_FREEZE" && h.status === "ACTIVE");
  const holdOf = new Map(holds.map((h) => [h.accountId, h.id]));
  const recoveredBy = new Map<string, number>();
  for (const r of store.recoveries.listForCase(caseId)) recoveredBy.set(r.accountId, (recoveredBy.get(r.accountId) ?? 0) + r.amountMinor);
  const vpa = (id: string) => store.accounts.get(id)?.vpa ?? id;

  const accounts: AttributedAccountView[] = result.accounts.map((a) => {
    const frozen = holdOf.has(a.accountId);
    return {
      accountId: a.accountId,
      vpa: vpa(a.accountId),
      kind: a.kind,
      heldMinor: a.heldMinor,
      balanceMinor: a.balanceMinor,
      sharePct: a.balanceMinor > 0 ? Math.round((a.heldMinor / a.balanceMinor) * 1000) / 10 : 0,
      frozenByCase: frozen,
      holdId: holdOf.get(a.accountId) ?? null,
      recoverableNowMinor: frozen ? Math.min(a.heldMinor, a.balanceMinor) : 0,
      recoveredMinor: recoveredBy.get(a.accountId) ?? 0,
      truncated: a.truncated,
    };
  });
  // accounts fully recovered/emptied drop out of the attribution; keep them visible
  for (const [id, amt] of recoveredBy) {
    if (!accounts.some((a) => a.accountId === id)) {
      accounts.push({
        accountId: id,
        vpa: vpa(id),
        kind: (store.accounts.get(id)?.kind ?? "person") as AccountKind,
        heldMinor: 0,
        balanceMinor: store.accounts.get(id)?.balanceMinor ?? 0,
        sharePct: 0,
        frozenByCase: holdOf.has(id),
        holdId: holdOf.get(id) ?? null,
        recoverableNowMinor: 0,
        recoveredMinor: amt,
        truncated: false,
      });
    }
  }
  const heldInFrozen = accounts.filter((a) => a.frozenByCase).reduce((s, a) => s + a.heldMinor, 0);
  const firstSeedTs = Math.min(...disputed.map((d) => d.ts));
  return {
    caseId,
    policy: ATTRIBUTION_POLICY,
    asOf: now,
    ledgerHeadSeq: head,
    disputedMinor: result.disputedMinor,
    totals: {
      recoverableNowMinor: accounts.reduce((s, a) => s + a.recoverableNowMinor, 0),
      heldInFrozenMinor: heldInFrozen,
      atRiskUnfrozenMinor: result.heldMinor - heldInFrozen,
      cashedOutMinor: result.cashedOutMinor,
      spentAtMerchantsMinor: result.spentAtMerchantsMinor,
      returnedToVictimMinor: result.returnedToVictimMinor,
      recoveredMinor: result.recoveredMinor,
      dustMinor: result.dustMinor,
      untrackedMinor: result.untrackedMinor + (missing ? seeds.filter((s) => !s.toId).reduce((s, x) => s + x.amountMinor, 0) : 0),
    },
    accounts,
    flows: result.flows.map((f) => ({ ...f, fromVpa: vpa(f.fromId), toVpa: vpa(f.toId) })),
    truncated: result.truncated,
    historyIncomplete: missing || historyWatermark(store, runId) > firstSeedTs,
    method:
      "Proportional (pro-rata) tracing in ledger order: each payment out of an account carries the victim's share of that account's balance at that moment. " +
      "Pre-existing and unrelated inflows are treated as the account holder's own money. Every paisa of the disputed amount is assigned to exactly one bucket.",
  };
}

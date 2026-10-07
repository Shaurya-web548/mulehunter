/**
 * Victim fund recovery — returns the victim's attributed money from accounts
 * this case has frozen, as real ledger transfers through the admission gate.
 *
 * Rules:
 *  - Only accounts under an ACTIVE MULE_DEBIT_FREEZE of THIS case.
 *  - Per account: min(victim's attributed money there now, its balance) —
 *    never the account holder's own money, never more than it holds.
 *  - Only to the case victim. The gate re-verifies victim + freeze itself.
 *  - One transaction: all transfers commit or none. Idempotent by action key
 *    (+ payload hash); a retry replays, a different payload with the same key
 *    is a 409.
 *  - Attribution is recomputed inside the transaction, so the amounts reflect
 *    the ledger at the moment of transfer (including earlier recoveries).
 */
import { DomainError } from "../../contracts/types.ts";
import { minorToInr } from "../../contracts/money.ts";
import { hashPayload, uid } from "../../persistence/repos/shared.ts";
import type { RecoveryAction, RecoveryTransfer } from "../../persistence/repos/recovery.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import { recordCaseEvent } from "../audit/events.ts";
import { computeAttribution } from "../attribution/job.ts";

export const RECOVERY_POLICY = "ATTRIBUTED_FROM_FROZEN/v1";

export interface RecoveryRequest {
  caseId: string;
  /** optional subset of frozen accounts; default = all frozen accounts holding victim money */
  accountIds?: string[];
  reason: string;
  actionKey: string;
  actorId: string;
  now: number;
}

export interface RecoveryResult {
  action: RecoveryAction;
  transfers: RecoveryTransfer[];
  replayed: boolean;
}

export function recoverFunds(store: Store, req: RecoveryRequest): RecoveryResult {
  if (typeof req.actionKey !== "string" || req.actionKey.trim().length < 8 || req.actionKey.length > 128) {
    throw new DomainError("ACTION_KEY_REQUIRED", "actionKey (8–128 chars) is required for idempotency", 400);
  }
  if (typeof req.reason !== "string" || req.reason.trim().length < 8) {
    throw new DomainError("REASON_REQUIRED", "a reason of at least 8 characters is required", 400);
  }
  if (req.accountIds !== undefined && (!Array.isArray(req.accountIds) || req.accountIds.length > 100 || !req.accountIds.every((x) => typeof x === "string"))) {
    throw new DomainError("BAD_REQUEST", "accountIds must be an array of at most 100 account ids", 400);
  }
  const subset = req.accountIds ? [...new Set(req.accountIds)].sort() : null;
  const payloadHash = hashPayload({ caseId: req.caseId, accountIds: subset, reason: req.reason.trim() });

  return serialTx(store, () => {
    const c = store.cases.get(req.caseId);
    if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${req.caseId} does not exist`, 404);

    const prior = store.recoveries.actionByKey(c.id, req.actionKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "this actionKey was already used for a different recovery", 409);
      return { action: prior, transfers: store.recoveries.transfersForAction(prior.id), replayed: true };
    }

    const attribution = computeAttribution(store, c.id, req.now);
    if (attribution.truncated) {
      throw new DomainError("ATTRIBUTION_INCOMPLETE", "attribution hit a budget; recovery amounts would be uncertain — narrow the case or retry", 409);
    }
    const targets = attribution.accounts.filter((a) => a.frozenByCase && a.recoverableNowMinor > 0 && (!subset || subset.includes(a.accountId)));
    if (subset) {
      const notFrozen = subset.filter((id) => !attribution.accounts.some((a) => a.accountId === id && a.frozenByCase));
      if (notFrozen.length) throw new DomainError("NOT_FROZEN", `recovery is only possible from accounts this case has frozen: ${notFrozen.join(", ")}`, 422);
    }
    if (!targets.length) throw new DomainError("NOTHING_TO_RECOVER", "no frozen account currently holds attributable victim money", 422);

    const action: RecoveryAction = {
      id: uid("rcv"),
      caseId: c.id,
      actionKey: req.actionKey,
      payloadHash,
      actorId: req.actorId,
      reason: req.reason.trim(),
      policy: RECOVERY_POLICY,
      totalMinor: 0,
      createdAt: req.now,
    };
    store.recoveries.insertAction(action);

    const runId = store.accounts.get(c.victimAccountId)?.runId ?? "";
    const transfers: RecoveryTransfer[] = [];
    for (const t of targets) {
      const attemptId = `recovery:${action.id}:${t.accountId}`;
      const txnId = uid("tx");
      const res = store.accounts.admit({
        attemptId,
        runId,
        fromId: t.accountId,
        toId: c.victimAccountId,
        amountMinor: t.recoverableNowMinor,
        ts: req.now,
        txnId,
        recoveryForCase: c.id,
      });
      if (res.status !== "ACCEPTED") {
        // roll the whole recovery back: nothing partial is ever committed
        throw new DomainError("RECOVERY_REJECTED", `transfer from ${t.vpa} was rejected by the gate (${res.rejectReason})`, 409);
      }
      const rec: RecoveryTransfer = {
        id: uid("rtx"),
        actionId: action.id,
        caseId: c.id,
        accountId: t.accountId,
        victimAccountId: c.victimAccountId,
        amountMinor: t.recoverableNowMinor,
        attributedBeforeMinor: t.heldMinor,
        balanceBeforeMinor: t.balanceMinor,
        attemptId,
        txnId,
        createdAt: req.now,
      };
      store.recoveries.insertTransfer(rec);
      transfers.push(rec);
    }
    action.totalMinor = transfers.reduce((s, x) => s + x.amountMinor, 0);
    store.recoveries.setActionTotal(action.id, action.totalMinor);
    recordCaseEvent(store, {
      caseId: c.id,
      actorId: req.actorId,
      action: "FUNDS_RECOVERED",
      detail: {
        actionId: action.id,
        policy: RECOVERY_POLICY,
        attributionPolicy: attribution.policy,
        totalMinor: action.totalMinor,
        total: minorToInr(action.totalMinor),
        transfers: transfers.map((x) => ({ accountId: x.accountId, amountMinor: x.amountMinor, txnId: x.txnId })),
        reason: action.reason,
      },
      at: req.now,
    });
    return { action, transfers, replayed: false };
  });
}

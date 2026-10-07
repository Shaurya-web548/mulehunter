/**
 * Account protection — reasoned, independently releasable debit holds.
 *
 * An account is debit-blocked while ANY of its holds is ACTIVE (checked by the
 * admission gate at execution time). Releasing one hold never touches another
 * case's hold, and closing a case never releases holds implicitly.
 */
import { DomainError, type AccountHold, type HoldType } from "../../contracts/types.ts";
import { minorToInr } from "../../contracts/money.ts";
import { uid } from "../../persistence/repos/shared.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import { recordCaseEvent, recordSystemEvent } from "../audit/events.ts";

export const MIN_REASON_CHARS = 8;

function requireReason(reason: unknown): string {
  if (typeof reason !== "string" || reason.trim().length < MIN_REASON_CHARS) {
    throw new DomainError("REASON_REQUIRED", `a reason of at least ${MIN_REASON_CHARS} characters is required`, 400);
  }
  return reason.trim();
}

export interface CaseHoldInput {
  caseId: string;
  accountId: string;
  type: HoldType;
  reason: string;
  actorId: string;
  now: number;
  actionId?: string | null;
}

/**
 * Create a case hold inside the caller's transaction. Idempotent per
 * (case, account, type): an existing ACTIVE hold is returned unchanged.
 */
export function applyCaseHoldInTx(store: Store, h: CaseHoldInput): { hold: AccountHold; created: boolean } {
  const existing = store.holds.listForCase(h.caseId).find((x) => x.accountId === h.accountId && x.type === h.type && x.status === "ACTIVE");
  if (existing) return { hold: existing, created: false };
  if (!store.accounts.get(h.accountId)) throw new DomainError("UNKNOWN_ACCOUNT", `account ${h.accountId} does not exist`, 422);
  const hold: AccountHold = {
    id: uid("hold"),
    accountId: h.accountId,
    caseId: h.caseId,
    source: "CASE",
    sourceRef: null,
    actionId: h.actionId ?? null,
    type: h.type,
    status: "ACTIVE",
    reason: requireReason(h.reason),
    actorId: h.actorId,
    createdAt: h.now,
    releasedAt: null,
    releasedReason: null,
    releasedActorId: null,
  };
  store.holds.insert(hold);
  return { hold, created: true };
}

/** Protect a case victim after intake (when protection was not chosen at filing). */
export function protectVictim(store: Store, args: { caseId: string; reason: string; actorId: string; now: number }): AccountHold {
  return serialTx(store, () => {
    const c = store.cases.get(args.caseId);
    if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${args.caseId} does not exist`, 404);
    const bal = store.accounts.get(c.victimAccountId)?.balanceMinor ?? 0;
    const { hold, created } = applyCaseHoldInTx(store, {
      caseId: c.id,
      accountId: c.victimAccountId,
      type: "VICTIM_PROTECTION",
      reason: args.reason,
      actorId: args.actorId,
      now: args.now,
    });
    if (created) {
      recordCaseEvent(store, {
        caseId: c.id,
        actorId: args.actorId,
        action: "VICTIM_HOLD_CREATED",
        detail: { holdId: hold.id, accountId: hold.accountId, balanceAtHold: minorToInr(bal), note: "future victim debits blocked; credits allowed; earlier transfers not undone" },
        at: args.now,
      });
    }
    return hold;
  });
}

export interface ReleaseResult {
  hold: AccountHold;
  /** other ACTIVE holds that still debit-block the same account */
  stillBlockedBy: AccountHold[];
}

/** Release exactly one hold, with an authorized actor and reason. */
export function releaseHold(store: Store, args: { holdId: string; reason: string; actorId: string; now: number }): ReleaseResult {
  const reason = requireReason(args.reason);
  return serialTx(store, () => {
    const hold = store.holds.get(args.holdId);
    if (!hold) throw new DomainError("HOLD_NOT_FOUND", `hold ${args.holdId} does not exist`, 404);
    if (hold.status !== "ACTIVE") throw new DomainError("HOLD_NOT_ACTIVE", `hold ${args.holdId} is already released`, 409);
    store.holds.release(hold.id, args.now, reason, args.actorId);
    const released = store.holds.get(hold.id)!;
    const stillBlockedBy = store.holds.listActiveForAccount(hold.accountId);
    const detail = {
      holdId: hold.id,
      accountId: hold.accountId,
      type: hold.type,
      reason,
      stillBlockedByHoldIds: stillBlockedBy.map((h) => h.id),
    };
    if (hold.caseId) recordCaseEvent(store, { caseId: hold.caseId, actorId: args.actorId, action: "HOLD_RELEASED", detail, at: args.now });
    else recordSystemEvent(store, { actorId: args.actorId, action: "LEGACY_HOLD_RELEASED", detail, at: args.now, topic: "hold", resourceId: hold.id });
    return { hold: released, stillBlockedBy };
  });
}

/**
 * Legacy `/api/freeze` (ring freeze from the live console) → reasoned
 * LEGACY_RING debit holds, created atomically. Idempotent per ring.
 */
export function applyLegacyRingHolds(
  store: Store,
  args: { ringId: string; accountIds: string[]; ringScore: number; pattern: string; actorId: string; now: number },
): AccountHold[] {
  return serialTx(store, () => {
    const existing = store.holds.activeLegacy(args.ringId);
    const have = new Set(existing.map((h) => h.accountId));
    const created: AccountHold[] = [];
    for (const accountId of args.accountIds) {
      if (have.has(accountId) || !store.accounts.get(accountId)) continue;
      const hold: AccountHold = {
        id: uid("hold"),
        accountId,
        caseId: null,
        source: "LEGACY_RING",
        sourceRef: args.ringId,
        actionId: null,
        type: "MULE_DEBIT_FREEZE",
        status: "ACTIVE",
        reason: `Live-console ring freeze: ${args.pattern} ring ${args.ringId}, ring risk score ${args.ringScore}/100 (live 90s window heuristics)`,
        actorId: args.actorId,
        createdAt: args.now,
        releasedAt: null,
        releasedReason: null,
        releasedActorId: null,
      };
      store.holds.insert(hold);
      created.push(hold);
    }
    recordSystemEvent(store, {
      actorId: args.actorId,
      action: "LEGACY_RING_FROZEN",
      detail: { ringId: args.ringId, holdIds: created.map((h) => h.id), accounts: args.accountIds.length },
      at: args.now,
      topic: "hold",
      resourceId: args.ringId,
    });
    return [...existing, ...created];
  });
}

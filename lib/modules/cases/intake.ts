/**
 * U3 — complaint intake and victim protection.
 *
 * One BEGIN IMMEDIATE transaction:
 *   1. validate the complaint against the retained ledger (every disputed
 *      payment must be an ACCEPTED payment SENT BY the victim),
 *   2. create the case, its disputed-payment facts and (by default) a
 *      VICTIM_PROTECTION debit hold,
 *   3. write the audit trail and the UI outbox rows.
 * Either all of it commits or none of it does. Intake never moves money.
 *
 * The victim is not a mule: intake never scores, classifies or freezes the
 * victim as one; the hold only blocks FUTURE victim debits (credits allowed,
 * earlier transfers are not undone).
 */
import type { AccountHold, AuditEvent, Case, DisputedTransaction } from "../../contracts/types.ts";
import { DomainError } from "../../contracts/types.ts";
import { minorToInr, sumMinor, MAX_SAFE_MINOR } from "../../contracts/money.ts";
import { hashPayload, uid } from "../../persistence/repos/shared.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import { recordCaseEvent } from "../audit/events.ts";
import { applyCaseHoldInTx } from "../protection/holds.ts";

/** Defaults applied when the caller omits a field. */
export const INTAKE_DEFAULTS = {
  actorId: "op_intake",
  reporterId: "self_reported",
  protectVictim: true,
  minNarrativeChars: 8,
  maxNarrativeChars: 4000,
  maxDisputed: 50,
} as const;

export interface ComplaintInput {
  victimAccountId: string;
  incidentStartTs: number;
  incidentEndTs: number;
  disputedTxnIds: string[];
  narrative: string;
  declaredLossMinor?: number;
  reporterId?: string;
  protectVictim?: boolean;
  /** Explicit replay key. Omit to let an identical resubmission dedupe itself. */
  idempotencyKey?: string | null;
  actorId?: string;
  /** Injectable clock — intake never reads the clock twice for one decision. */
  now?: number;
}

export interface IntakeResult {
  case: Case;
  victimHold: AccountHold | null;
  disputed: DisputedTransaction[];
  /** true when this was a replay of an already recorded complaint. */
  replayed: boolean;
  /** Non-fatal observations recorded with the case (e.g. similar complaints). */
  warnings: string[];
}

/** A complaint after validation: no undefined fields, no duplicate ids. */
export interface ComplaintDraft {
  victimAccountId: string;
  incidentStartTs: number;
  incidentEndTs: number;
  disputedTxnIds: string[];
  narrative: string;
  declaredLossMinor: number;
  reporterId: string;
  protectVictim: boolean;
  idempotencyKey: string | null;
  actorId: string;
}

function asTrimmedString(value: unknown, field: string, max = 200): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new DomainError("INVALID_COMPLAINT", `${field} is required`, 400);
  }
  const v = value.trim();
  if (v.length > max) throw new DomainError("INVALID_COMPLAINT", `${field} is longer than ${max} characters`, 400);
  return v;
}

function asInteger(value: unknown, field: string, min: number): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < min) {
    throw new DomainError("INVALID_COMPLAINT", `${field} must be an integer >= ${min}`, 400);
  }
  return value;
}

/**
 * Pure validation. Returns the exact values that will be persisted, so the
 * payload hash is computed over what is actually stored rather than over the
 * caller's raw JSON.
 */
export function normalizeComplaint(input: ComplaintInput): ComplaintDraft {
  if (!input || typeof input !== "object") {
    throw new DomainError("INVALID_COMPLAINT", "a complaint body is required", 400);
  }

  const victimAccountId = asTrimmedString(input.victimAccountId, "victimAccountId");
  const incidentStartTs = asInteger(input.incidentStartTs, "incidentStartTs", 0);
  const incidentEndTs = asInteger(input.incidentEndTs, "incidentEndTs", 0);
  if (incidentEndTs < incidentStartTs) {
    throw new DomainError("INVALID_COMPLAINT", "incidentEndTs must not be before incidentStartTs", 400);
  }

  if (!Array.isArray(input.disputedTxnIds) || input.disputedTxnIds.length === 0) {
    throw new DomainError("NO_DISPUTED_TRANSACTIONS", "select at least one disputed transaction", 400);
  }
  if (input.disputedTxnIds.length > INTAKE_DEFAULTS.maxDisputed) {
    throw new DomainError("INVALID_COMPLAINT", `at most ${INTAKE_DEFAULTS.maxDisputed} disputed transactions per complaint`, 400);
  }
  const disputedTxnIds: string[] = [];
  const seen = new Set<string>();
  for (const raw of input.disputedTxnIds) {
    const id = asTrimmedString(raw, "disputedTxnIds[]");
    if (seen.has(id)) continue; // case_disputed_transactions is keyed (case_id, txn_id)
    seen.add(id);
    disputedTxnIds.push(id);
  }

  const narrative = asTrimmedString(input.narrative, "narrative", INTAKE_DEFAULTS.maxNarrativeChars);
  if (narrative.length < INTAKE_DEFAULTS.minNarrativeChars) {
    throw new DomainError(
      "INVALID_COMPLAINT",
      `narrative must be at least ${INTAKE_DEFAULTS.minNarrativeChars} characters`,
      400,
    );
  }

  const declaredLossMinor = input.declaredLossMinor === undefined ? 0 : asInteger(input.declaredLossMinor, "declaredLossMinor", 0);
  if (declaredLossMinor > MAX_SAFE_MINOR) throw new DomainError("INVALID_COMPLAINT", "declaredLossMinor is out of range", 400);

  if (input.protectVictim !== undefined && typeof input.protectVictim !== "boolean") {
    throw new DomainError("INVALID_COMPLAINT", "protectVictim must be a boolean", 400);
  }

  const key =
    input.idempotencyKey === undefined || input.idempotencyKey === null ? null : asTrimmedString(input.idempotencyKey, "idempotencyKey");

  return {
    victimAccountId,
    incidentStartTs,
    incidentEndTs,
    disputedTxnIds,
    narrative,
    declaredLossMinor,
    reporterId: input.reporterId ? asTrimmedString(input.reporterId, "reporterId") : INTAKE_DEFAULTS.reporterId,
    protectVictim: input.protectVictim ?? INTAKE_DEFAULTS.protectVictim,
    idempotencyKey: key,
    actorId: input.actorId ? asTrimmedString(input.actorId, "actorId") : INTAKE_DEFAULTS.actorId,
  };
}

export interface CaseDetail {
  case: Case;
  disputed: DisputedTransaction[];
  holds: AccountHold[];
  audit: AuditEvent[];
}

/** Read a case with its disputed transactions, holds and audit trail. */
export function getCaseDetail(store: Store, caseId: string): CaseDetail | null {
  const record = store.cases.get(caseId);
  if (!record) return null;
  return {
    case: record,
    disputed: store.cases.disputed(caseId),
    holds: store.holds.listForCase(caseId),
    audit: store.audit.list(caseId),
  };
}

/**
 * Resolve the disputed ids against the retained ledger. Every id must be an
 * accepted payment whose sender is the victim, in the victim's run. The
 * incident window is advisory: a payment outside it is kept but flagged.
 */
export function resolveDisputed(store: Store, caseId: string, draft: ComplaintDraft, victimRunId: string, warnings: string[]): DisputedTransaction[] {
  const resolved: DisputedTransaction[] = [];
  for (const txnId of draft.disputedTxnIds) {
    const candidates = store.accounts.acceptedByTxnId(txnId).filter((c) => (c.runId ?? "") === victimRunId || victimRunId === "");
    if (candidates.length === 0) {
      throw new DomainError("UNKNOWN_DISPUTED_TRANSACTION", `disputed transaction ${txnId} is not an accepted payment in the retained ledger`, 422);
    }
    const chosen = candidates.find((c) => c.fromId === draft.victimAccountId);
    if (!chosen) {
      throw new DomainError(
        candidates.length && !draft.disputedTxnIds.some((id) => store.accounts.acceptedByTxnId(id).some((c) => c.fromId === draft.victimAccountId))
          ? "VICTIM_NOT_SENDER"
          : "DISPUTED_TXN_NOT_OWNED",
        `transaction ${txnId} was not sent by account ${draft.victimAccountId}`,
        422,
      );
    }
    if (chosen.ts < draft.incidentStartTs || chosen.ts > draft.incidentEndTs) {
      warnings.push(`txn_outside_window: ${txnId} at ${new Date(chosen.ts).toISOString()} is outside the reported incident window`);
    }
    resolved.push({ caseId, txnId: chosen.txnId, seq: chosen.seq, amountMinor: chosen.amountMinor, ts: chosen.ts });
  }
  return resolved;
}

/**
 * File a complaint: validate, then create the case and (optionally) its
 * victim protection hold atomically. Replaying the same complaint returns the
 * same case; reusing a key for a different complaint is a 409.
 */
export function createCaseFromComplaint(store: Store, input: ComplaintInput): IntakeResult {
  const now = input.now ?? Date.now();
  const draft = normalizeComplaint(input);
  const payloadHash = complaintPayloadHash(draft);
  // An identical resubmission (double-click, network retry) dedupes onto one
  // case. A DIFFERENT complaint about the same victim/payments is never
  // merged — it becomes its own case and is flagged for review.
  const idempotencyKey = draft.idempotencyKey ?? `auto:${payloadHash}`;

  return serialTx(store, () => {
    const prior = store.cases.idempotency(idempotencyKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) {
        throw new DomainError("IDEMPOTENCY_CONFLICT", `idempotency key ${idempotencyKey} was already used for a different complaint`, 409);
      }
      const existing = store.cases.get(prior.caseId);
      if (!existing) throw new DomainError("CASE_MISSING", `case ${prior.caseId} for idempotency key ${idempotencyKey} is gone`, 500);
      return {
        case: existing,
        victimHold: store.holds.listForCase(existing.id).find((h) => h.type === "VICTIM_PROTECTION") ?? null,
        disputed: store.cases.disputed(existing.id),
        replayed: true,
        warnings: [],
      };
    }

    const victim = store.accounts.get(draft.victimAccountId);
    if (!victim) throw new DomainError("UNKNOWN_VICTIM", `account ${draft.victimAccountId} does not exist`, 422);
    if (victim.kind === "sink") throw new DomainError("INVALID_VICTIM", "a cash-out sink cannot be a complaint victim", 422);

    const caseId = uid("case");
    const warnings: string[] = [];
    const disputed = resolveDisputed(store, caseId, draft, victim.runId ?? "", warnings);
    const disputedTotal = sumMinor(disputed.map((d) => d.amountMinor));

    // Similar-complaint review flags (never an automatic merge).
    const similar = new Set<string>();
    for (const c of store.cases.casesDisputing(disputed.map((d) => d.txnId))) similar.add(c.caseId);
    for (const c of store.cases.byVictim(draft.victimAccountId)) if (c.status !== "CLOSED") similar.add(c.id);
    if (similar.size) warnings.push(`similar_open_complaints: ${[...similar].join(", ")}`);

    const record: Case = {
      id: caseId,
      reporterId: draft.reporterId,
      victimAccountId: draft.victimAccountId,
      incidentStartTs: draft.incidentStartTs,
      incidentEndTs: draft.incidentEndTs,
      declaredLossMinor: draft.declaredLossMinor,
      narrative: draft.narrative,
      // Validated against the ledger before it is stored, so a case is never
      // persisted in a pre-validation state.
      stage: "VALIDATED",
      status: "VALIDATED",
      revision: 0,
      createdAt: now,
      updatedAt: now,
    };
    store.cases.insert(record, disputed);
    store.cases.putIdempotency(idempotencyKey, payloadHash, caseId, now);
    recordCaseEvent(store, {
      caseId,
      actorId: draft.actorId,
      action: "CASE_CREATED",
      detail: {
        victimAccountId: draft.victimAccountId,
        disputedTxnIds: disputed.map((d) => d.txnId),
        disputedPaymentTotalMinor: disputedTotal,
        declaredLossMinor: draft.declaredLossMinor,
        protectVictim: draft.protectVictim,
        warnings,
      },
      at: now,
    });
    if (similar.size) {
      recordCaseEvent(store, {
        caseId,
        actorId: draft.actorId,
        action: "SIMILAR_COMPLAINT_FLAGGED",
        detail: { relatedCaseIds: [...similar], note: "flagged for review; cases are not merged" },
        at: now,
      });
    }

    let victimHold: AccountHold | null = null;
    if (draft.protectVictim) {
      victimHold = applyCaseHoldInTx(store, {
        caseId,
        accountId: draft.victimAccountId,
        type: "VICTIM_PROTECTION",
        reason:
          `Victim protection for case ${caseId}: ${disputed.length} disputed payment(s) totalling ` +
          `${minorToInr(disputedTotal)}. Blocks future victim debits only.`,
        actorId: draft.actorId,
        now,
      }).hold;
      recordCaseEvent(store, {
        caseId,
        actorId: draft.actorId,
        action: "VICTIM_HOLD_CREATED",
        detail: { holdId: victimHold.id, accountId: victimHold.accountId, note: "future victim debits blocked; credits allowed; earlier transfers not undone" },
        at: now,
      });
    } else {
      recordCaseEvent(store, { caseId, actorId: draft.actorId, action: "VICTIM_HOLD_SKIPPED", detail: "reporter chose not to protect the victim account", at: now });
    }

    return { case: store.cases.get(caseId)!, victimHold, disputed, replayed: false, warnings };
  });
}

export function complaintPayloadHash(draft: ComplaintDraft): string {
  return hashPayload({
    victimAccountId: draft.victimAccountId,
    incidentStartTs: draft.incidentStartTs,
    incidentEndTs: draft.incidentEndTs,
    disputedTxnIds: [...draft.disputedTxnIds].sort(),
    narrative: draft.narrative,
    declaredLossMinor: draft.declaredLossMinor,
    reporterId: draft.reporterId,
    protectVictim: draft.protectVictim,
  });
}

/**
 * Intake helper: the victim's accepted outgoing payments in a window, for
 * explicit selection when the reporter does not know transaction ids. Never
 * auto-selects — the caller must choose.
 */
export function listDisputeCandidates(store: Store, accountId: string, fromTs: number, toTs: number, limit = 50) {
  if (!store.accounts.get(accountId)) throw new DomainError("UNKNOWN_VICTIM", `account ${accountId} does not exist`, 404);
  const disputedBy = new Map<string, string[]>();
  const rows = store.accounts.victimCandidates(accountId, fromTs, toTs, limit);
  for (const d of store.cases.casesDisputing(rows.map((r) => r.txnId))) {
    disputedBy.set(d.txnId, [...(disputedBy.get(d.txnId) ?? []), d.caseId]);
  }
  return rows.map((r) => {
    const to = store.accounts.get(r.toId);
    return {
      txnId: r.txnId,
      toId: r.toId,
      toVpa: to?.vpa ?? r.toId,
      toKind: to?.kind ?? "person",
      amountMinor: r.amountMinor,
      ts: r.ts,
      seq: r.seq,
      alreadyDisputedBy: disputedBy.get(r.txnId) ?? [],
    };
  });
}

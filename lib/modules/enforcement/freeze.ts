/**
 * Enforcement — simulated MULE_DEBIT_FREEZE holds on evidence-backed accounts.
 *
 * The server, not the client, decides eligibility: every requested account
 * must be `eligible` in the CURRENT analysis revision named by the request
 * (a stale revision is a 409). The case victim, merchants/sinks, accounts
 * without behavioural evidence and cross-case role conflicts are never
 * eligible. A batch is one transaction: all holds apply or none do. Retrying
 * with the same action key replays the first result; reusing a key for a
 * different request is a 409.
 */
import { DomainError, type AccountHold, type EnforcementAction, type EnforcementPolicy } from "../../contracts/types.ts";
import { hashPayload, uid } from "../../persistence/repos/shared.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import { recordCaseEvent } from "../audit/events.ts";
import { applyCaseHoldInTx } from "../protection/holds.ts";
import { exclusionNote, type Exclusion } from "../analysis/score.ts";

export const MAX_BATCH = 100;

/** Demo auto-enforcement is OFF unless explicitly enabled on the server. */
export function autoDemoEnabled(): boolean {
  return process.env.MNH_DEMO_AUTO_ENFORCE === "1";
}

export interface FreezeRequest {
  caseId: string;
  analysisRevision: number;
  policy: EnforcementPolicy;
  /** required for MANUAL; ignored for AUTO_DEMO (server selects all eligible) */
  accountIds?: string[];
  reason: string;
  actionKey: string;
  actorId: string;
  now: number;
  /** injected for tests; defaults to autoDemoEnabled() */
  autoEnabled?: boolean;
}

export interface FreezeResult {
  action: EnforcementAction;
  holds: AccountHold[];
  replayed: boolean;
}

export function freezeCandidates(store: Store, req: FreezeRequest): FreezeResult {
  if (typeof req.actionKey !== "string" || req.actionKey.trim().length < 8 || req.actionKey.length > 128) {
    throw new DomainError("ACTION_KEY_REQUIRED", "actionKey (8–128 chars) is required for idempotency", 400);
  }
  if (typeof req.reason !== "string" || req.reason.trim().length < 8) {
    throw new DomainError("REASON_REQUIRED", "a reason of at least 8 characters is required", 400);
  }
  if (req.policy !== "MANUAL" && req.policy !== "AUTO_DEMO") throw new DomainError("INVALID_POLICY", "policy must be MANUAL or AUTO_DEMO", 400);
  if (!Number.isInteger(req.analysisRevision) || req.analysisRevision < 1) {
    throw new DomainError("INVALID_REVISION", "analysisRevision must be a positive integer", 400);
  }
  const requested = [...new Set(req.accountIds ?? [])].sort();
  if (req.policy === "MANUAL" && (requested.length === 0 || requested.length > MAX_BATCH)) {
    throw new DomainError("NO_ACCOUNTS_SELECTED", `select between 1 and ${MAX_BATCH} accounts`, 400);
  }
  const payloadHash = hashPayload({ caseId: req.caseId, analysisRevision: req.analysisRevision, policy: req.policy, accountIds: requested, reason: req.reason.trim() });

  return serialTx(store, () => {
    const c = store.cases.get(req.caseId);
    if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${req.caseId} does not exist`, 404);

    const prior = store.enforcement.getByKey(c.id, req.actionKey);
    if (prior) {
      if (prior.payloadHash !== payloadHash) throw new DomainError("IDEMPOTENCY_CONFLICT", "this actionKey was already used for a different request", 409);
      return { action: prior, holds: prior.holdIds.map((id) => store.holds.get(id)!).filter(Boolean), replayed: true };
    }
    if (c.stage === "CLOSED") throw new DomainError("CASE_CLOSED", "a closed case cannot take new enforcement actions", 409);

    const latest = store.analysis.latestRun(c.id);
    if (!latest) throw new DomainError("NO_ANALYSIS", "analyze the case before freezing accounts", 409);
    if (latest.revision !== req.analysisRevision) {
      throw new DomainError("STALE_ANALYSIS", `analysis revision ${req.analysisRevision} is stale; the current revision is ${latest.revision}`, 409);
    }
    const candidates = new Map(store.analysis.listCandidates(c.id, latest.revision).map((x) => [x.accountId, x]));

    let targets: string[];
    if (req.policy === "AUTO_DEMO") {
      if (!(req.autoEnabled ?? autoDemoEnabled())) {
        throw new DomainError("AUTO_POLICY_DISABLED", "demo auto-enforcement is disabled (set MNH_DEMO_AUTO_ENFORCE=1 on the server)", 403);
      }
      targets = [...candidates.values()].filter((x) => x.eligible).map((x) => x.accountId).sort();
      if (!targets.length) throw new DomainError("NO_ELIGIBLE_ACCOUNTS", "no account is eligible in this analysis revision", 422);
    } else {
      const refused = requested
        .map((id) => {
          const cand = candidates.get(id);
          if (id === c.victimAccountId) return `${id}: ${exclusionNote("CASE_VICTIM")}`;
          if (!cand) return `${id}: not part of this analysis revision`;
          if (!cand.eligible) return `${id}: ${exclusionNote(cand.exclusion as Exclusion) || "not eligible"}`;
          return null;
        })
        .filter((x): x is string => x !== null);
      if (refused.length) throw new DomainError("NOT_ELIGIBLE", `not eligible for a mule freeze — ${refused.join("; ")}`, 422);
      targets = requested;
    }

    const actionId = uid("act");
    const holds: AccountHold[] = [];
    for (const accountId of targets) {
      const cand = candidates.get(accountId)!;
      const { hold } = applyCaseHoldInTx(store, {
        caseId: c.id,
        accountId,
        type: "MULE_DEBIT_FREEZE",
        reason: `${req.reason.trim()} — analysis r${latest.revision} (${latest.detectorVersion}, ${latest.configVersion}), risk score ${cand.riskScore}/100: ${cand.contributions
          .filter((x) => x.points > 0)
          .map((x) => x.feature)
          .join(", ")}`,
        actorId: req.actorId,
        now: req.now,
        actionId,
      });
      holds.push(hold);
    }
    const action: EnforcementAction = {
      id: actionId,
      actionKey: req.actionKey,
      caseId: c.id,
      accountIds: targets,
      holdIds: holds.map((h) => h.id),
      actorId: req.actorId,
      reason: req.reason.trim(),
      status: "APPLIED",
      createdAt: req.now,
      appliedAt: req.now,
      payloadHash,
      policy: req.policy,
      analysisRevision: latest.revision,
    };
    store.enforcement.insert(action);
    recordCaseEvent(store, {
      caseId: c.id,
      actorId: req.actorId,
      action: "MULE_HOLDS_APPLIED",
      detail: { actionId, policy: req.policy, analysisRevision: latest.revision, accountIds: targets, holdIds: action.holdIds, note: "simulated debit freeze; incoming credits still allowed" },
      at: req.now,
    });
    return { action, holds, replayed: false };
  });
}

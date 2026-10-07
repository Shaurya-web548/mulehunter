/**
 * Append-only domain audit + UI outbox.
 *
 * Every case mutation calls `recordCaseEvent` INSIDE the same transaction as
 * the change: the audit row, the case version bump and the outbox row commit
 * (or roll back) together, so the UI is never told about uncommitted state.
 */
import type { Store } from "../../persistence/store.ts";

export type CaseEventAction =
  | "CASE_CREATED"
  | "VICTIM_HOLD_CREATED"
  | "VICTIM_HOLD_SKIPPED"
  | "TRACE_STARTED"
  | "TRACE_COMPLETED"
  | "TRACE_FAILED"
  | "ANALYSIS_COMPLETED"
  | "MULE_HOLDS_APPLIED"
  | "HOLD_RELEASED"
  | "CASE_STAGE_CHANGED"
  | "REPORT_EXPORTED"
  | "SIMILAR_COMPLAINT_FLAGGED"
  | "FUNDS_RECOVERED";

export interface CaseEventInput {
  caseId: string;
  actorId: string;
  action: CaseEventAction;
  detail: string | Record<string, unknown>;
  at: number;
}

/** Audit + version bump + outbox, in the caller's transaction. Returns the new case version. */
export function recordCaseEvent(store: Store, e: CaseEventInput): number {
  const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
  store.audit.insert({ caseId: e.caseId, actorId: e.actorId, action: e.action, detail, createdAt: e.at });
  const version = store.cases.touch(e.caseId, e.at);
  store.outbox.append("case", e.caseId, version, { action: e.action }, e.at);
  return version;
}

/** Audit for events outside any case (legacy ring freezes, manual payments). */
export function recordSystemEvent(store: Store, e: Omit<CaseEventInput, "caseId" | "action"> & { action: string; topic?: string; resourceId?: string }): void {
  const detail = typeof e.detail === "string" ? e.detail : JSON.stringify(e.detail);
  store.audit.insert({ caseId: null, actorId: e.actorId, action: e.action, detail, createdAt: e.at });
  if (e.topic) store.outbox.append(e.topic, e.resourceId ?? "", 0, { action: e.action }, e.at);
}

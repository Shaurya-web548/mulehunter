import type { AuditEvent, EnforcementAction, EnforcementActionStatus, EnforcementPolicy } from "../../contracts/types.ts";
import { stmt, type DBSync } from "./shared.ts";

export class EnforcementRepository {
  private db: DBSync;

  constructor(db: DBSync) {
    this.db = db;
  }

  getByKey(caseId: string, actionKey: string): EnforcementAction | null {
    const r = stmt(this.db, "SELECT * FROM enforcement_actions WHERE case_id = ? AND action_key = ?").get(caseId, actionKey);
    return r ? this.row(r) : null;
  }

  get(id: string): EnforcementAction | null {
    const r = stmt(this.db, "SELECT * FROM enforcement_actions WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  listForCase(caseId: string): EnforcementAction[] {
    return stmt(this.db, "SELECT * FROM enforcement_actions WHERE case_id = ? ORDER BY created_at, id")
      .all(caseId)
      .map((r) => this.row(r));
  }

  insert(a: EnforcementAction): void {
    stmt(
      this.db,
      `INSERT INTO enforcement_actions
       (id, action_key, case_id, account_ids_json, hold_ids_json, actor_id, reason, status, created_at, applied_at,
        payload_hash, policy, analysis_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      a.id,
      a.actionKey,
      a.caseId,
      JSON.stringify(a.accountIds),
      JSON.stringify(a.holdIds),
      a.actorId,
      a.reason,
      a.status,
      a.createdAt,
      a.appliedAt,
      a.payloadHash ?? "",
      a.policy ?? "MANUAL",
      a.analysisRevision ?? 0,
    );
  }

  private row(r: Record<string, unknown>): EnforcementAction {
    return {
      id: String(r.id),
      actionKey: String(r.action_key),
      caseId: String(r.case_id),
      accountIds: JSON.parse(String(r.account_ids_json)),
      holdIds: JSON.parse(String(r.hold_ids_json)),
      actorId: String(r.actor_id),
      reason: String(r.reason),
      status: r.status as EnforcementActionStatus,
      createdAt: Number(r.created_at),
      appliedAt: r.applied_at == null ? null : Number(r.applied_at),
      payloadHash: String(r.payload_hash ?? ""),
      policy: String(r.policy ?? "MANUAL") as EnforcementPolicy,
      analysisRevision: Number(r.analysis_revision ?? 0),
    };
  }
}

export class AuditRepository {
  private db: DBSync;

  constructor(db: DBSync) {
    this.db = db;
  }

  /** Append-only. The id is assigned by SQLite (AUTOINCREMENT). */
  insert(e: Omit<AuditEvent, "id">): void {
    stmt(this.db, "INSERT INTO audit_events (case_id, actor_id, action, detail, created_at) VALUES (?, ?, ?, ?, ?)").run(
      e.caseId,
      e.actorId,
      e.action,
      e.detail,
      e.createdAt,
    );
  }

  /** Newest first. */
  list(caseId: string | null, limit = 200): AuditEvent[] {
    const rows = caseId
      ? stmt(this.db, "SELECT * FROM audit_events WHERE case_id = ? ORDER BY created_at DESC, id DESC LIMIT ?").all(caseId, limit)
      : stmt(this.db, "SELECT * FROM audit_events ORDER BY created_at DESC, id DESC LIMIT ?").all(limit);
    return rows.map((r) => ({
      id: String(r.id),
      caseId: r.case_id == null ? null : String(r.case_id),
      actorId: String(r.actor_id),
      action: String(r.action),
      detail: String(r.detail),
      createdAt: Number(r.created_at),
    }));
  }
}

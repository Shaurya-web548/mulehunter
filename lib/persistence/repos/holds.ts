import type { AccountHold, HoldSource, HoldType } from "../../contracts/types.ts";
import { stmt, type DBSync } from "./shared.ts";

export class HoldRepository {
  private db: DBSync;

  constructor(db: DBSync) {
    this.db = db;
  }

  insert(h: AccountHold): void {
    stmt(
      this.db,
      `INSERT INTO account_holds
       (id, account_id, case_id, source, source_ref, action_id, type, status, reason, actor_id,
        created_at, released_at, released_reason, released_actor_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      h.id,
      h.accountId,
      h.caseId,
      h.source ?? (h.caseId ? "CASE" : "LEGACY_RING"),
      h.sourceRef ?? null,
      h.actionId ?? null,
      h.type,
      h.status,
      h.reason,
      h.actorId,
      h.createdAt,
      h.releasedAt,
      h.releasedReason,
      h.releasedActorId,
    );
  }

  get(id: string): AccountHold | null {
    const r = stmt(this.db, "SELECT * FROM account_holds WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  listActiveForAccount(accountId: string): AccountHold[] {
    return stmt(this.db, "SELECT * FROM account_holds WHERE account_id = ? AND status = 'ACTIVE' ORDER BY created_at, id")
      .all(accountId)
      .map((r) => this.row(r));
  }

  listForCase(caseId: string): AccountHold[] {
    return stmt(this.db, "SELECT * FROM account_holds WHERE case_id = ? ORDER BY created_at, id")
      .all(caseId)
      .map((r) => this.row(r));
  }

  /** Holds of any case/source on these accounts (active and released). */
  listForAccounts(accountIds: string[]): AccountHold[] {
    const out: AccountHold[] = [];
    for (const id of accountIds) {
      out.push(
        ...stmt(this.db, "SELECT * FROM account_holds WHERE account_id = ? ORDER BY created_at, id")
          .all(id)
          .map((r) => this.row(r)),
      );
    }
    return out;
  }

  listMany(accountIds: string[]): AccountHold[] {
    const out: AccountHold[] = [];
    for (const id of accountIds) out.push(...this.listActiveForAccount(id));
    return out;
  }

  /** Every currently debit-blocked account id (for live-graph display only). */
  activeAccountIds(): string[] {
    return stmt(this.db, "SELECT DISTINCT account_id FROM account_holds WHERE status = 'ACTIVE'")
      .all()
      .map((r) => String(r.account_id));
  }

  activeLegacy(ringId: string): AccountHold[] {
    return stmt(this.db, "SELECT * FROM account_holds WHERE source = 'LEGACY_RING' AND source_ref = ? AND status = 'ACTIVE'")
      .all(ringId)
      .map((r) => this.row(r));
  }

  /** Release exactly this hold. Returns false when it was not active. */
  release(id: string, releasedAt: number, reason: string, actorId: string): boolean {
    const res = stmt(
      this.db,
      `UPDATE account_holds SET status='RELEASED', released_at=?, released_reason=?, released_actor_id=?
       WHERE id=? AND status='ACTIVE'`,
    ).run(releasedAt, reason, actorId, id);
    return Number(res.changes) === 1;
  }

  private row(r: Record<string, unknown>): AccountHold {
    return {
      id: String(r.id),
      accountId: String(r.account_id),
      caseId: r.case_id == null ? null : String(r.case_id),
      source: String(r.source ?? "CASE") as HoldSource,
      sourceRef: r.source_ref == null ? null : String(r.source_ref),
      actionId: r.action_id == null ? null : String(r.action_id),
      type: r.type as HoldType,
      status: r.status as AccountHold["status"],
      reason: String(r.reason),
      actorId: String(r.actor_id),
      createdAt: Number(r.created_at),
      releasedAt: r.released_at == null ? null : Number(r.released_at),
      releasedReason: r.released_reason == null ? null : String(r.released_reason),
      releasedActorId: r.released_actor_id == null ? null : String(r.released_actor_id),
    };
  }
}

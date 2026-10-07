import type { Case, CaseStage, CaseStatus, DisputedTransaction } from "../../contracts/types.ts";
import { stmt, type DBSync } from "./shared.ts";

export interface CaseListFilter {
  status?: CaseStatus;
  victimAccountId?: string;
  /** keyset cursor: `${updatedAt}:${id}` of the last row of the previous page */
  cursor?: string | null;
  limit: number;
}

export class CaseRepository {
  private db: DBSync;

  constructor(db: DBSync) {
    this.db = db;
  }

  insert(c: Case, disputed: DisputedTransaction[]): void {
    stmt(
      this.db,
      `INSERT INTO cases
       (id, reporter_id, victim_account_id, incident_start_ts, incident_end_ts,
        declared_loss_minor, narrative, stage, status, revision, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(c.id, c.reporterId, c.victimAccountId, c.incidentStartTs, c.incidentEndTs, c.declaredLossMinor, c.narrative, c.stage, c.status, c.revision, c.createdAt, c.updatedAt);
    for (const d of disputed) {
      stmt(this.db, "INSERT INTO case_disputed_transactions (case_id, txn_id, seq, amount_minor, ts) VALUES (?, ?, ?, ?, ?)").run(
        d.caseId,
        d.txnId,
        d.seq,
        d.amountMinor,
        d.ts,
      );
    }
  }

  get(id: string): Case | null {
    const r = stmt(this.db, "SELECT * FROM cases WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  list(limit = 100): Case[] {
    return stmt(this.db, "SELECT * FROM cases ORDER BY updated_at DESC, id DESC LIMIT ?")
      .all(limit)
      .map((r) => this.row(r));
  }

  /** Keyset-paginated, filtered listing (newest activity first). */
  page(f: CaseListFilter): { items: Case[]; nextCursor: string | null } {
    let cUpdated = Number.MAX_SAFE_INTEGER;
    let cId = "￿";
    if (f.cursor) {
      const i = f.cursor.indexOf(":");
      cUpdated = Number(f.cursor.slice(0, i));
      cId = f.cursor.slice(i + 1);
    }
    const rows = stmt(
      this.db,
      `SELECT * FROM cases
       WHERE (? IS NULL OR status = ?) AND (? IS NULL OR victim_account_id = ?)
         AND (updated_at < ? OR (updated_at = ? AND id < ?))
       ORDER BY updated_at DESC, id DESC LIMIT ?`,
    )
      .all(f.status ?? null, f.status ?? null, f.victimAccountId ?? null, f.victimAccountId ?? null, cUpdated, cUpdated, cId, f.limit + 1)
      .map((r) => this.row(r));
    const items = rows.slice(0, f.limit);
    const last = items[items.length - 1];
    return { items, nextCursor: rows.length > f.limit && last ? `${last.updatedAt}:${last.id}` : null };
  }

  /** Other cases that name this victim (for "similar complaint" review flags). */
  byVictim(victimAccountId: string): Case[] {
    return stmt(this.db, "SELECT * FROM cases WHERE victim_account_id = ? ORDER BY created_at")
      .all(victimAccountId)
      .map((r) => this.row(r));
  }

  updateStage(id: string, stage: CaseStage, status: CaseStatus, revision: number, now: number): void {
    stmt(this.db, "UPDATE cases SET stage = ?, status = ?, revision = ?, updated_at = ? WHERE id = ?").run(stage, status, revision, now, id);
  }

  /** Bump the case version (every committed change); returns the new version. */
  touch(id: string, now: number): number {
    stmt(this.db, "UPDATE cases SET revision = revision + 1, updated_at = ? WHERE id = ?").run(now, id);
    const r = stmt(this.db, "SELECT revision FROM cases WHERE id = ?").get(id);
    return Number(r?.revision ?? 0);
  }

  setStage(id: string, stage: CaseStage, status: CaseStatus): void {
    stmt(this.db, "UPDATE cases SET stage = ?, status = ? WHERE id = ?").run(stage, status, id);
  }

  disputed(caseId: string): DisputedTransaction[] {
    return stmt(this.db, "SELECT * FROM case_disputed_transactions WHERE case_id = ? ORDER BY ts, seq")
      .all(caseId)
      .map((r) => ({
        caseId: String(r.case_id),
        txnId: String(r.txn_id),
        seq: Number(r.seq),
        amountMinor: Number(r.amount_minor),
        ts: Number(r.ts),
      }));
  }

  /** Cases that already dispute any of these ledger transactions. */
  casesDisputing(txnIds: string[]): { caseId: string; txnId: string }[] {
    const out: { caseId: string; txnId: string }[] = [];
    for (const t of txnIds) {
      for (const r of stmt(this.db, "SELECT case_id FROM case_disputed_transactions WHERE txn_id = ?").all(t)) {
        out.push({ caseId: String(r.case_id), txnId: t });
      }
    }
    return out;
  }

  idempotency(exactKey: string): { caseId: string; payloadHash: string } | null {
    const r = stmt(this.db, "SELECT case_id, payload_hash FROM case_idempotency WHERE idempotency_key = ?").get(exactKey);
    return r ? { caseId: String(r.case_id), payloadHash: String(r.payload_hash) } : null;
  }

  putIdempotency(key: string, payloadHash: string, caseId: string, now: number): void {
    stmt(this.db, "INSERT INTO case_idempotency (idempotency_key, payload_hash, case_id, created_at) VALUES (?, ?, ?, ?)").run(key, payloadHash, caseId, now);
  }

  allActiveVictimHolds(victimAccountId: string): { holdId: string; caseId: string }[] {
    return stmt(
      this.db,
      `SELECT h.id AS hold_id, h.case_id AS case_id
       FROM account_holds h WHERE h.account_id = ? AND h.status='ACTIVE' AND h.type='VICTIM_PROTECTION'`,
    )
      .all(victimAccountId)
      .map((r) => ({ holdId: String(r.hold_id), caseId: String(r.case_id) }));
  }

  /** Accounts that are the victim of some case (cross-case role conflicts). */
  victimCaseIds(accountId: string): string[] {
    return stmt(this.db, "SELECT id FROM cases WHERE victim_account_id = ?")
      .all(accountId)
      .map((r) => String(r.id));
  }

  private row(r: Record<string, unknown>): Case {
    return {
      id: String(r.id),
      reporterId: String(r.reporter_id),
      victimAccountId: String(r.victim_account_id),
      incidentStartTs: Number(r.incident_start_ts),
      incidentEndTs: Number(r.incident_end_ts),
      declaredLossMinor: Number(r.declared_loss_minor),
      narrative: String(r.narrative),
      stage: r.stage as CaseStage,
      status: r.status as CaseStatus,
      revision: Number(r.revision),
      createdAt: Number(r.created_at),
      updatedAt: Number(r.updated_at),
    };
  }
}

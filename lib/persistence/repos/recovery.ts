import { stmt, type DBSync } from "./shared.ts";

export interface RecoveryAction {
  id: string;
  caseId: string;
  actionKey: string;
  payloadHash: string;
  actorId: string;
  reason: string;
  policy: string;
  totalMinor: number;
  createdAt: number;
}

export interface RecoveryTransfer {
  id: string;
  actionId: string;
  caseId: string;
  accountId: string;
  victimAccountId: string;
  amountMinor: number;
  attributedBeforeMinor: number;
  balanceBeforeMinor: number;
  attemptId: string;
  txnId: string;
  createdAt: number;
}

export class RecoveryRepository {
  private db: DBSync;
  constructor(db: DBSync) {
    this.db = db;
  }

  actionByKey(caseId: string, key: string): RecoveryAction | null {
    const r = stmt(this.db, "SELECT * FROM case_recovery_actions WHERE case_id = ? AND action_key = ?").get(caseId, key);
    return r ? this.actionRow(r) : null;
  }

  insertAction(a: RecoveryAction): void {
    stmt(
      this.db,
      `INSERT INTO case_recovery_actions (id, case_id, action_key, payload_hash, actor_id, reason, policy, total_minor, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(a.id, a.caseId, a.actionKey, a.payloadHash, a.actorId, a.reason, a.policy, a.totalMinor, a.createdAt);
  }

  setActionTotal(id: string, totalMinor: number): void {
    stmt(this.db, "UPDATE case_recovery_actions SET total_minor = ? WHERE id = ?").run(totalMinor, id);
  }

  insertTransfer(t: RecoveryTransfer): void {
    stmt(
      this.db,
      `INSERT INTO case_recoveries
       (id, action_id, case_id, account_id, victim_account_id, amount_minor, attributed_before_minor, balance_before_minor, attempt_id, txn_id, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(t.id, t.actionId, t.caseId, t.accountId, t.victimAccountId, t.amountMinor, t.attributedBeforeMinor, t.balanceBeforeMinor, t.attemptId, t.txnId, t.createdAt);
  }

  listForCase(caseId: string): RecoveryTransfer[] {
    return stmt(this.db, "SELECT * FROM case_recoveries WHERE case_id = ? ORDER BY created_at, id")
      .all(caseId)
      .map((r) => this.transferRow(r));
  }

  transfersForAction(actionId: string): RecoveryTransfer[] {
    return stmt(this.db, "SELECT * FROM case_recoveries WHERE action_id = ? ORDER BY id")
      .all(actionId)
      .map((r) => this.transferRow(r));
  }

  actionsForCase(caseId: string): RecoveryAction[] {
    return stmt(this.db, "SELECT * FROM case_recovery_actions WHERE case_id = ? ORDER BY created_at, id")
      .all(caseId)
      .map((r) => this.actionRow(r));
  }

  /** Every recovery transfer ever made: txn id → case id (attribution needs all of them). */
  allTxnCases(): Map<string, string> {
    return new Map(stmt(this.db, "SELECT txn_id, case_id FROM case_recoveries").all().map((r) => [String(r.txn_id), String(r.case_id)]));
  }

  totalForCase(caseId: string): number {
    const r = stmt(this.db, "SELECT COALESCE(SUM(amount_minor),0) AS s FROM case_recoveries WHERE case_id = ?").get(caseId);
    return Number(r?.s ?? 0);
  }

  private actionRow(r: Record<string, unknown>): RecoveryAction {
    return {
      id: String(r.id),
      caseId: String(r.case_id),
      actionKey: String(r.action_key),
      payloadHash: String(r.payload_hash),
      actorId: String(r.actor_id),
      reason: String(r.reason),
      policy: String(r.policy),
      totalMinor: Number(r.total_minor),
      createdAt: Number(r.created_at),
    };
  }

  private transferRow(r: Record<string, unknown>): RecoveryTransfer {
    return {
      id: String(r.id),
      actionId: String(r.action_id),
      caseId: String(r.case_id),
      accountId: String(r.account_id),
      victimAccountId: String(r.victim_account_id),
      amountMinor: Number(r.amount_minor),
      attributedBeforeMinor: Number(r.attributed_before_minor),
      balanceBeforeMinor: Number(r.balance_before_minor),
      attemptId: String(r.attempt_id),
      txnId: String(r.txn_id),
      createdAt: Number(r.created_at),
    };
  }
}

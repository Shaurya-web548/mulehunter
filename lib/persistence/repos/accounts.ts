import type { Account, AcceptedTransaction, RejectReason } from "../../contracts/types.ts";
import { DomainError } from "../../contracts/types.ts";
import { stmt, withSerializedWrite, type DBSync } from "./shared.ts";
import { decideAdmission } from "./ledger.ts";

/** A single admission request — the only way simulated money moves. */
export interface AdmitRequest {
  /** Stable attempt id. Repeating the same id is an idempotent replay. */
  attemptId: string;
  runId: string | null;
  fromId: string;
  toId: string;
  amountMinor: number;
  ts: number; // ms epoch, simulated execution time
  txnId: string; // accepted-transaction id used when the attempt is accepted
  /**
   * Victim fund recovery for this case. The ONLY way a debit may leave a
   * held account: the gate itself verifies that `toId` is the case victim and
   * that `fromId` is under an ACTIVE MULE_DEBIT_FREEZE hold of the same case;
   * otherwise the attempt is rejected as INVALID. Balance is still checked.
   */
  recoveryForCase?: string;
}

/**
 * Durable outcome of one admission decision. `replayed` distinguishes a fresh
 * decision from an idempotent replay of an attempt that was already recorded.
 */
export interface AttemptResult {
  attemptId: string;
  status: "ACCEPTED" | "REJECTED";
  rejectReason: RejectReason | null;
  holdId: string | null;
  txnId: string | null;
  balanceAfterMinor: number | null;
  replayed: boolean;
}

export interface BlockedAttempt {
  attemptId: string;
  fromId: string;
  toId: string;
  amountMinor: number;
  ts: number;
  holdId: string;
}

type Row = Record<string, unknown>;

function toAccount(r: Row): Account {
  return {
    id: String(r.id),
    vpa: String(r.vpa),
    name: String(r.name),
    kind: r.kind as Account["kind"],
    createdAt: Number(r.created_at),
    balanceMinor: Number(r.balance_minor),
    openingBalanceMinor: Number(r.opening_balance_minor ?? 0),
    runId: String(r.run_id ?? ""),
    basePool: !!r.base_pool,
  };
}

export function toAccepted(r: Row): AcceptedTransaction {
  return {
    txnId: String(r.txn_id),
    runId: r.run_id ? String(r.run_id) : null,
    fromId: String(r.from_id),
    toId: String(r.to_id),
    amountMinor: Number(r.amount_minor),
    ts: Number(r.ts),
    seq: Number(r.seq),
    attemptId: String(r.attempt_id),
  };
}

const ACCOUNT_COLS = "id, vpa, name, kind, created_at, balance_minor, opening_balance_minor, run_id, base_pool";

export class AccountRepository {
  private db: DBSync;
  /** Per-run next ledger sequence, cached; the process is the only writer. */
  private seqCache = new Map<string, number>();

  constructor(db: DBSync) {
    this.db = db;
  }

  /**
   * Create an account with its opening balance (the only way money enters a
   * run), or update descriptive fields. An existing balance is never
   * overwritten by upsert — balances only change through `admit()`.
   */
  upsert(a: Account): void {
    const opening = a.openingBalanceMinor ?? a.balanceMinor;
    stmt(
      this.db,
      `INSERT INTO accounts (id, vpa, name, kind, created_at, balance_minor, opening_balance_minor, run_id, base_pool)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET vpa=excluded.vpa, name=excluded.name, kind=excluded.kind`,
    ).run(a.id, a.vpa, a.name, a.kind, a.createdAt, a.balanceMinor, opening, a.runId ?? "", a.basePool ? 1 : 0);
  }

  get(id: string): Account | null {
    const r = stmt(this.db, `SELECT ${ACCOUNT_COLS} FROM accounts WHERE id = ?`).get(id);
    return r ? toAccount(r) : null;
  }

  getMany(ids: string[]): Account[] {
    const out: Account[] = [];
    for (const id of ids) {
      const a = this.get(id);
      if (a) out.push(a);
    }
    return out;
  }

  listByRun(runId: string): Account[] {
    return stmt(this.db, `SELECT ${ACCOUNT_COLS} FROM accounts WHERE run_id = ? ORDER BY rowid`)
      .all(runId)
      .map(toAccount);
  }

  /** Case-insensitive VPA/ID lookup for intake (bounded). */
  search(runId: string, q: string, limit = 20): Account[] {
    const like = `%${q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
    return stmt(
      this.db,
      `SELECT ${ACCOUNT_COLS} FROM accounts
       WHERE run_id = ? AND (id = ? OR vpa LIKE ? ESCAPE '\\') ORDER BY (id = ?) DESC, vpa LIMIT ?`,
    )
      .all(runId, q, like, q, limit)
      .map(toAccount);
  }

  /** Σ balance and Σ opening balance for a run — equal when money is conserved. */
  conservation(runId: string): { balanceMinor: number; openingMinor: number } {
    const r = stmt(
      this.db,
      "SELECT COALESCE(SUM(balance_minor),0) AS b, COALESCE(SUM(opening_balance_minor),0) AS o FROM accounts WHERE run_id = ?",
    ).get(runId) as Row;
    return { balanceMinor: Number(r.b), openingMinor: Number(r.o) };
  }

  activeHoldIds(accountId: string): string[] {
    return stmt(this.db, "SELECT id FROM account_holds WHERE account_id = ? AND status = 'ACTIVE' ORDER BY created_at, id")
      .all(accountId)
      .map((r) => String(r.id));
  }

  nextSeq(runId: string | null): number {
    const key = runId ?? "";
    let next = this.seqCache.get(key);
    if (next === undefined) {
      const r = stmt(this.db, "SELECT COALESCE(MAX(seq), 0) AS s FROM accepted_transactions WHERE run_id = ?").get(key) as Row;
      next = Number(r.s) + 1;
    }
    return next;
  }

  /** Highest committed ledger sequence of a run (trace cutoff). */
  headSeq(runId: string): number {
    const r = stmt(this.db, "SELECT COALESCE(MAX(seq), 0) AS s FROM accepted_transactions WHERE run_id = ?").get(runId) as Row;
    return Number(r.s);
  }

  attemptExists(attemptId: string): boolean {
    return !!stmt(this.db, "SELECT 1 FROM payment_attempts WHERE attempt_id = ?").get(attemptId);
  }

  /** The oldest active hold on an account, or null when the account is unheld. */
  firstActiveHoldId(accountId: string): string | null {
    const r = stmt(
      this.db,
      "SELECT id FROM account_holds WHERE account_id = ? AND status = 'ACTIVE' ORDER BY created_at, id LIMIT 1",
    ).get(accountId);
    return r ? String(r.id) : null;
  }

  /** Read a previously recorded attempt (idempotent-replay support). */
  getAttempt(attemptId: string): AttemptResult | null {
    const r = stmt(this.db, "SELECT * FROM payment_attempts WHERE attempt_id = ?").get(attemptId);
    if (!r) return null;
    const status = r.status as AttemptResult["status"];
    const txnId = status === "ACCEPTED" && r.txn_id != null ? String(r.txn_id) : null;
    return {
      attemptId: String(r.attempt_id),
      status,
      rejectReason: (r.reject_reason as RejectReason | null) ?? null,
      holdId: r.hold_id == null ? null : String(r.hold_id),
      txnId,
      balanceAfterMinor: r.balance_after_minor == null ? null : Number(r.balance_after_minor),
      replayed: true,
    };
  }

  /**
   * Central payment admission — the single gate every simulated debit passes.
   * Runs as (or inside) one BEGIN IMMEDIATE transaction, so the hold check,
   * balance check and the debit/credit commit atomically: a payment that
   * commits first stays accepted, a hold that commits first rejects the
   * debit. A repeat of an attemptId replays the first outcome and never moves
   * money twice.
   */
  admit(req: AdmitRequest): AttemptResult {
    return withSerializedWrite(this.db, () => this.admitInTx(req));
  }

  private admitInTx(req: AdmitRequest): AttemptResult {
    const prior = this.getAttempt(req.attemptId);
    if (prior) {
      // an attempt id names ONE payment: reusing it for a different payment
      // is a client error, not a replay
      const row = stmt(this.db, "SELECT from_id, to_id, amount_minor FROM payment_attempts WHERE attempt_id = ?").get(req.attemptId);
      if (row && (String(row.from_id) !== req.fromId || String(row.to_id) !== req.toId || Number(row.amount_minor) !== req.amountMinor)) {
        throw new DomainError("ATTEMPT_ID_CONFLICT", `attempt ${req.attemptId} was already used for a different payment`, 409);
      }
      return prior;
    }

    const from = this.get(req.fromId);
    const to = this.get(req.toId);
    let holdId = this.firstActiveHoldId(req.fromId);
    // both accounts must be in the same run, and that run must be the one the
    // payment is recorded under (traces are run-scoped)
    let sameRun =
      !from || !to || ((from.runId ?? "") === (to.runId ?? "") && (!from.runId || from.runId === (req.runId ?? "")));
    if (req.recoveryForCase !== undefined) {
      // authorised recovery: victim of that case ← account frozen by that case
      const c = stmt(this.db, "SELECT victim_account_id FROM cases WHERE id = ?").get(req.recoveryForCase);
      const frozenByCase = stmt(
        this.db,
        "SELECT 1 FROM account_holds WHERE account_id = ? AND case_id = ? AND type = 'MULE_DEBIT_FREEZE' AND status = 'ACTIVE' LIMIT 1",
      ).get(req.fromId, req.recoveryForCase);
      if (c && String(c.victim_account_id) === req.toId && frozenByCase) holdId = null;
      else sameRun = false; // not a valid recovery → rejected as INVALID
    }
    const verdict = sameRun
      ? decideAdmission({ from, to, amountMinor: req.amountMinor, activeHoldId: holdId })
      : { status: "REJECTED" as const, rejectReason: "INVALID" as const, holdId: null };
    const runKey = req.runId ?? "";

    if (verdict.status === "REJECTED" || !from) {
      const balanceAfter = from ? from.balanceMinor : null;
      stmt(
        this.db,
        `INSERT INTO payment_attempts
         (attempt_id, run_id, from_id, to_id, amount_minor, ts, status, reject_reason, hold_id, balance_after_minor)
         VALUES (?, ?, ?, ?, ?, ?, 'REJECTED', ?, ?, ?)`,
      ).run(req.attemptId, runKey, req.fromId, req.toId, req.amountMinor, req.ts, verdict.rejectReason, verdict.holdId, balanceAfter);
      return {
        attemptId: req.attemptId,
        status: "REJECTED",
        rejectReason: verdict.rejectReason ?? "INVALID",
        holdId: verdict.holdId,
        txnId: null,
        balanceAfterMinor: balanceAfter,
        replayed: false,
      };
    }

    const seq = this.nextSeq(req.runId);
    const balanceAfter = from.balanceMinor - req.amountMinor;
    stmt(
      this.db,
      `INSERT INTO payment_attempts
       (attempt_id, run_id, from_id, to_id, amount_minor, ts, status, reject_reason, hold_id, balance_after_minor, txn_id)
       VALUES (?, ?, ?, ?, ?, ?, 'ACCEPTED', NULL, NULL, ?, ?)`,
    ).run(req.attemptId, runKey, req.fromId, req.toId, req.amountMinor, req.ts, balanceAfter, req.txnId);
    stmt(this.db, "UPDATE accounts SET balance_minor = balance_minor - ? WHERE id = ?").run(req.amountMinor, req.fromId);
    stmt(this.db, "UPDATE accounts SET balance_minor = balance_minor + ? WHERE id = ?").run(req.amountMinor, req.toId);
    stmt(
      this.db,
      `INSERT INTO accepted_transactions (txn_id, run_id, from_id, to_id, amount_minor, ts, seq, attempt_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(req.txnId, runKey, req.fromId, req.toId, req.amountMinor, req.ts, seq, req.attemptId);
    // Only advance the cached sequence once every write above succeeded; a
    // rollback of the outer transaction is handled by `invalidateSeq`.
    this.seqCache.set(runKey, seq + 1);
    return {
      attemptId: req.attemptId,
      status: "ACCEPTED",
      rejectReason: null,
      holdId: null,
      txnId: req.txnId,
      balanceAfterMinor: balanceAfter,
      replayed: false,
    };
  }

  /** Drop cached sequences (call after an outer transaction rolled back). */
  invalidateSeq(): void {
    this.seqCache.clear();
  }

  /**
   * Rejected attempts whose rejection was caused by an active hold.
   * Attempt rows are unique by attempt_id, so retries never inflate the count.
   */
  blockedAttemptsByHold(accountIds: string[]): BlockedAttempt[] {
    const out: BlockedAttempt[] = [];
    for (const id of accountIds) {
      const rows = stmt(
        this.db,
        `SELECT attempt_id, from_id, to_id, amount_minor, ts, hold_id FROM payment_attempts
         WHERE status = 'REJECTED' AND reject_reason = 'HOLD' AND from_id = ? AND hold_id IS NOT NULL
         ORDER BY ts, attempt_id`,
      ).all(id);
      for (const r of rows) {
        out.push({
          attemptId: String(r.attempt_id),
          fromId: String(r.from_id),
          toId: String(r.to_id),
          amountMinor: Number(r.amount_minor),
          ts: Number(r.ts),
          holdId: String(r.hold_id),
        });
      }
    }
    return out;
  }

  getAccepted(txnId: string, runId: string | null): AcceptedTransaction | null {
    const r = stmt(this.db, "SELECT * FROM accepted_transactions WHERE txn_id = ? AND run_id = ?").get(txnId, runId ?? "");
    return r ? toAccepted(r) : null;
  }

  /**
   * Every accepted transaction carrying this txn id, across runs. Ledger ids are
   * run-scoped, so complaint intake looks disputed ids up this way instead of
   * guessing a run.
   */
  acceptedByTxnId(txnId: string): AcceptedTransaction[] {
    return stmt(this.db, "SELECT * FROM accepted_transactions WHERE txn_id = ? ORDER BY run_id, seq")
      .all(txnId)
      .map(toAccepted);
  }

  /**
   * Outgoing accepted transfers of an account strictly after (afterTs,
   * afterSeq) in ledger order and at or before the cutoff. When `runId` is
   * given the read is run-scoped and also bounded by `cutoffSeq`.
   */
  listAccepted(
    fromId: string,
    afterTs: number,
    afterSeq: number,
    cutoffTo: number,
    opts: { runId?: string; cutoffSeq?: number; limit?: number; minAmountMinor?: number } = {},
  ): AcceptedTransaction[] {
    const limit = opts.limit ?? 5000;
    if (opts.runId !== undefined) {
      return stmt(
        this.db,
        `SELECT * FROM accepted_transactions INDEXED BY idx_accepted_from_seq
         WHERE run_id = ? AND from_id = ? AND ((ts > ?) OR (ts = ? AND seq > ?)) AND ts <= ? AND seq <= ? AND amount_minor >= ?
         ORDER BY ts, seq LIMIT ?`,
      )
        .all(opts.runId, fromId, afterTs, afterTs, afterSeq, cutoffTo, opts.cutoffSeq ?? Number.MAX_SAFE_INTEGER, opts.minAmountMinor ?? 0, limit)
        .map(toAccepted);
    }
    return stmt(
      this.db,
      `SELECT * FROM accepted_transactions
       WHERE from_id = ? AND ((ts > ?) OR (ts = ? AND seq > ?)) AND ts <= ?
       ORDER BY ts, seq LIMIT ?`,
    )
      .all(fromId, afterTs, afterTs, afterSeq, cutoffTo, limit)
      .map(toAccepted);
  }

  /** Incoming accepted transfers of an account in [fromTs, toTs] (run-scoped). */
  listIncoming(runId: string, toId: string, fromTs: number, toTs: number, cutoffSeq: number, limit = 2000): AcceptedTransaction[] {
    return stmt(
      this.db,
      `SELECT * FROM accepted_transactions INDEXED BY idx_accepted_to_seq
       WHERE run_id = ? AND to_id = ? AND ts >= ? AND ts <= ? AND seq <= ?
       ORDER BY ts, seq LIMIT ?`,
    )
      .all(runId, toId, fromTs, toTs, cutoffSeq, limit)
      .map(toAccepted);
  }

  /** Outgoing accepted transfers of an account in [fromTs, toTs] (run-scoped). */
  listOutgoing(runId: string, fromId: string, fromTs: number, toTs: number, cutoffSeq: number, limit = 2000): AcceptedTransaction[] {
    return stmt(
      this.db,
      `SELECT * FROM accepted_transactions INDEXED BY idx_accepted_from_seq
       WHERE run_id = ? AND from_id = ? AND ts >= ? AND ts <= ? AND seq <= ?
       ORDER BY ts, seq LIMIT ?`,
    )
      .all(runId, fromId, fromTs, toTs, cutoffSeq, limit)
      .map(toAccepted);
  }

  /**
   * Money in/out of an account from ledger sequence `fromSeq` (inclusive) up
   * to `uptoSeq` — used to reconstruct the exact balance at any earlier point:
   * balanceBefore(seq) = balanceAt(uptoSeq) − in + out.
   */
  netFlowFromSeq(runId: string, accountId: string, fromSeq: number, uptoSeq: number): { inMinor: number; outMinor: number } {
    const i = stmt(
      this.db,
      "SELECT COALESCE(SUM(amount_minor),0) AS s FROM accepted_transactions INDEXED BY idx_accepted_to_seq WHERE run_id = ? AND to_id = ? AND seq >= ? AND seq <= ?",
    ).get(runId, accountId, fromSeq, uptoSeq);
    const o = stmt(
      this.db,
      "SELECT COALESCE(SUM(amount_minor),0) AS s FROM accepted_transactions INDEXED BY idx_accepted_from_seq WHERE run_id = ? AND from_id = ? AND seq >= ? AND seq <= ?",
    ).get(runId, accountId, fromSeq, uptoSeq);
    return { inMinor: Number(i?.s ?? 0), outMinor: Number(o?.s ?? 0) };
  }

  /** All accepted transfers into or out of an account after `afterSeq` (≤ uptoSeq), in ledger order. */
  eventsAfterSeq(runId: string, accountId: string, afterSeq: number, uptoSeq: number, limit: number): AcceptedTransaction[] {
    const outs = stmt(
      this.db,
      "SELECT * FROM accepted_transactions INDEXED BY idx_accepted_from_seq WHERE run_id = ? AND from_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
    ).all(runId, accountId, afterSeq, uptoSeq, limit);
    const ins = stmt(
      this.db,
      "SELECT * FROM accepted_transactions INDEXED BY idx_accepted_to_seq WHERE run_id = ? AND to_id = ? AND seq > ? AND seq <= ? ORDER BY seq LIMIT ?",
    ).all(runId, accountId, afterSeq, uptoSeq, limit);
    return [...outs, ...ins]
      .map(toAccepted)
      .sort((a, b) => a.seq - b.seq)
      .slice(0, limit);
  }

  /** A victim's accepted outgoing payments in a window — intake candidates. */
  victimCandidates(accountId: string, fromTs: number, toTs: number, limit = 50): AcceptedTransaction[] {
    const runId = this.get(accountId)?.runId ?? "";
    return stmt(
      this.db,
      `SELECT * FROM accepted_transactions INDEXED BY idx_accepted_from_seq WHERE run_id = ? AND from_id = ? AND ts >= ? AND ts <= ?
       ORDER BY ts DESC, seq DESC LIMIT ?`,
    )
      .all(runId, accountId, fromTs, toTs, limit)
      .map(toAccepted);
  }

  outgoingEdgesOnce(id: string, cutoffTo: number): AcceptedTransaction[] {
    return this.listAccepted(id, 0, -1, cutoffTo);
  }
}

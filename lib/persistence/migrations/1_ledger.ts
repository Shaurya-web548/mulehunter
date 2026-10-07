/**
 * Schema part 1 — ledger and accepted transactions.
 * Amounts are INTEGER minor units (paise).
 */
export const MIGRATION_1_LEDGER = `
  CREATE TABLE IF NOT EXISTS accounts (
    id TEXT PRIMARY KEY,
    vpa TEXT NOT NULL,
    name TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('person','merchant','sink')),
    created_at INTEGER NOT NULL,
    balance_minor INTEGER NOT NULL DEFAULT 0,
    is_mule INTEGER NOT NULL DEFAULT 0,
    scenario_id TEXT
  );

  CREATE TABLE IF NOT EXISTS payment_attempts (
    attempt_id TEXT PRIMARY KEY,
    run_id TEXT,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    amount_minor INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('ACCEPTED','REJECTED')),
    reject_reason TEXT,
    hold_id TEXT,
    balance_after_minor INTEGER
  );
  -- NOTE: from_id/to_id intentionally have no FK to accounts(). A rejected
  -- attempt may reference an unknown/unregistered account, and that rejection
  -- must still be recorded for the audit trail. Accepted money movement IS
  -- FK-protected through accepted_transactions below.
  CREATE INDEX IF NOT EXISTS idx_attempts_from ON payment_attempts(from_id, ts);
  CREATE INDEX IF NOT EXISTS idx_attempts_to   ON payment_attempts(to_id, ts);

  CREATE TABLE IF NOT EXISTS accepted_transactions (
    txn_id TEXT NOT NULL,
    run_id TEXT NOT NULL DEFAULT '',
    from_id TEXT NOT NULL REFERENCES accounts(id),
    to_id TEXT NOT NULL REFERENCES accounts(id),
    amount_minor INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    attempt_id TEXT NOT NULL REFERENCES payment_attempts(attempt_id),
    PRIMARY KEY (run_id, txn_id)
  );
  CREATE INDEX IF NOT EXISTS idx_accepted_from ON accepted_transactions(from_id, ts);
  CREATE INDEX IF NOT EXISTS idx_accepted_to   ON accepted_transactions(to_id, ts);
  -- Ledger total order is per run: seq is monotonic within a run and breaks
  -- ties between equal timestamps. Indexing (ts, seq) globally would collide
  -- across runs, so the uniqueness constraint is run-scoped.
  CREATE UNIQUE INDEX IF NOT EXISTS idx_accepted_order ON accepted_transactions(run_id, seq);
  CREATE INDEX IF NOT EXISTS idx_accepted_time ON accepted_transactions(run_id, ts);
`;
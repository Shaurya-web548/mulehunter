/** Schema part 2 — cases, idempotency, disputed transactions, holds. */
export const MIGRATION_2_CASES = `
  CREATE TABLE IF NOT EXISTS cases (
    id TEXT PRIMARY KEY,
    reporter_id TEXT NOT NULL,
    victim_account_id TEXT NOT NULL REFERENCES accounts(id),
    incident_start_ts INTEGER NOT NULL,
    incident_end_ts INTEGER NOT NULL,
    declared_loss_minor INTEGER NOT NULL,
    narrative TEXT NOT NULL,
    stage TEXT NOT NULL CHECK (stage IN ('REPORTED','VALIDATED','TRACING','ANALYZED','UNDER_REVIEW','CLOSED')),
    status TEXT NOT NULL,
    revision INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_cases_status ON cases(status, updated_at);
  CREATE INDEX IF NOT EXISTS idx_cases_victim ON cases(victim_account_id);

  CREATE TABLE IF NOT EXISTS case_idempotency (
    idempotency_key TEXT PRIMARY KEY,
    payload_hash TEXT NOT NULL,
    case_id TEXT NOT NULL REFERENCES cases(id),
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS case_disputed_transactions (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    txn_id TEXT NOT NULL,
    seq INTEGER NOT NULL,
    amount_minor INTEGER NOT NULL,
    ts INTEGER NOT NULL,
    PRIMARY KEY (case_id, txn_id)
  );

  CREATE TABLE IF NOT EXISTS account_holds (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    case_id TEXT NOT NULL REFERENCES cases(id),
    type TEXT NOT NULL CHECK (type IN ('VICTIM_PROTECTION','MULE_DEBIT_FREEZE')),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    released_at INTEGER,
    released_reason TEXT,
    released_actor_id TEXT
  );
  CREATE INDEX IF NOT EXISTS idx_holds_active ON account_holds(account_id, status);
`;
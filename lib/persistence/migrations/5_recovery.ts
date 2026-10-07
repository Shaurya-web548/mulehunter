/**
 * Schema part 5 — victim fund recovery.
 *
 * A recovery action returns the victim's ATTRIBUTED money from accounts that
 * this case has frozen (MULE_DEBIT_FREEZE) back to the victim through the
 * normal admission gate as a real ledger transfer. Each transfer is recorded
 * with the attribution figures it was based on.
 */
export const MIGRATION_5_RECOVERY = `
  CREATE TABLE case_recovery_actions (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id),
    action_key TEXT NOT NULL,
    payload_hash TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    policy TEXT NOT NULL,
    total_minor INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    UNIQUE (case_id, action_key)
  );

  CREATE TABLE case_recoveries (
    id TEXT PRIMARY KEY,
    action_id TEXT NOT NULL REFERENCES case_recovery_actions(id),
    case_id TEXT NOT NULL REFERENCES cases(id),
    account_id TEXT NOT NULL REFERENCES accounts(id),
    victim_account_id TEXT NOT NULL REFERENCES accounts(id),
    amount_minor INTEGER NOT NULL CHECK (amount_minor > 0),
    attributed_before_minor INTEGER NOT NULL,
    balance_before_minor INTEGER NOT NULL,
    attempt_id TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX idx_recoveries_case ON case_recoveries(case_id, created_at);
  CREATE UNIQUE INDEX idx_recoveries_txn ON case_recoveries(txn_id);
`;

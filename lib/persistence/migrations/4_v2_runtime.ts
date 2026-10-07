/**
 * Schema part 4 — V2 runtime.
 *
 *  - Simulator ground truth moves out of `accounts` into `sim_truth`, so no
 *    detector/case query can read it by accident.
 *  - Accounts gain an opening balance (conservation check) and their run.
 *  - Holds gain a source so legacy ring freezes are reasoned holds too; a
 *    legacy hold has no case.
 *  - Runs, ledger metadata (prune watermark), immutable trace snapshots,
 *    analysis revisions, report snapshots and a cursor-based UI outbox.
 */
export const MIGRATION_4_V2_RUNTIME = `
  CREATE TABLE sim_runs (
    id TEXT PRIMARY KEY,
    seed INTEGER NOT NULL,
    created_at INTEGER NOT NULL,
    active INTEGER NOT NULL DEFAULT 1
  );

  CREATE TABLE sim_truth (
    account_id TEXT PRIMARY KEY REFERENCES accounts(id),
    is_mule INTEGER NOT NULL DEFAULT 0,
    scenario_id TEXT
  );
  INSERT INTO sim_truth (account_id, is_mule, scenario_id)
    SELECT id, is_mule, scenario_id FROM accounts WHERE is_mule = 1 OR scenario_id IS NOT NULL;
  ALTER TABLE accounts DROP COLUMN is_mule;
  ALTER TABLE accounts DROP COLUMN scenario_id;
  ALTER TABLE accounts ADD COLUMN run_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE accounts ADD COLUMN opening_balance_minor INTEGER NOT NULL DEFAULT 0;
  UPDATE accounts SET opening_balance_minor = balance_minor;
  -- simulator metadata (not truth): only background-population accounts take
  -- part in random base-load traffic; scenario/demo accounts never do
  ALTER TABLE accounts ADD COLUMN base_pool INTEGER NOT NULL DEFAULT 0;
  CREATE INDEX idx_accounts_run ON accounts(run_id, kind);

  CREATE TABLE account_holds_v2 (
    id TEXT PRIMARY KEY,
    account_id TEXT NOT NULL REFERENCES accounts(id),
    case_id TEXT REFERENCES cases(id),
    source TEXT NOT NULL DEFAULT 'CASE' CHECK (source IN ('CASE','LEGACY_RING')),
    source_ref TEXT,
    action_id TEXT,
    type TEXT NOT NULL CHECK (type IN ('VICTIM_PROTECTION','MULE_DEBIT_FREEZE')),
    status TEXT NOT NULL CHECK (status IN ('ACTIVE','RELEASED')),
    reason TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    released_at INTEGER,
    released_reason TEXT,
    released_actor_id TEXT,
    CHECK ((source = 'CASE' AND case_id IS NOT NULL) OR (source = 'LEGACY_RING' AND case_id IS NULL))
  );
  INSERT INTO account_holds_v2
    (id, account_id, case_id, source, source_ref, action_id, type, status, reason, actor_id,
     created_at, released_at, released_reason, released_actor_id)
    SELECT id, account_id, case_id, 'CASE', NULL, NULL, type, status, reason, actor_id,
           created_at, released_at, released_reason, released_actor_id
    FROM account_holds;
  DROP TABLE account_holds;
  ALTER TABLE account_holds_v2 RENAME TO account_holds;
  CREATE INDEX idx_holds_active ON account_holds(account_id, status);
  CREATE INDEX idx_holds_case ON account_holds(case_id);
  CREATE UNIQUE INDEX idx_holds_one_active_per_case
    ON account_holds(case_id, account_id, type) WHERE status = 'ACTIVE' AND case_id IS NOT NULL;
  CREATE UNIQUE INDEX idx_holds_one_active_per_legacy
    ON account_holds(source_ref, account_id) WHERE status = 'ACTIVE' AND source = 'LEGACY_RING';

  -- Index diet: every accepted payment touches these B-trees, so keep only
  -- what tracing, outcomes and retention actually query.
  DROP INDEX IF EXISTS idx_attempts_from;
  DROP INDEX IF EXISTS idx_attempts_to;
  DROP INDEX IF EXISTS idx_accepted_from;
  DROP INDEX IF EXISTS idx_accepted_to;
  ALTER TABLE payment_attempts ADD COLUMN txn_id TEXT;
  UPDATE payment_attempts SET txn_id =
    (SELECT t.txn_id FROM accepted_transactions t WHERE t.attempt_id = payment_attempts.attempt_id)
    WHERE status = 'ACCEPTED';
  CREATE INDEX idx_attempts_rejected ON payment_attempts(from_id, ts) WHERE status = 'REJECTED';
  CREATE INDEX idx_attempts_ts ON payment_attempts(ts);
  CREATE INDEX idx_accepted_from_run ON accepted_transactions(run_id, from_id, ts, seq);
  CREATE INDEX idx_accepted_to_run ON accepted_transactions(run_id, to_id, ts, seq);
  CREATE INDEX idx_accepted_txn ON accepted_transactions(txn_id);

  CREATE TABLE ledger_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );

  ALTER TABLE case_trace_runs ADD COLUMN run_id TEXT NOT NULL DEFAULT '';
  ALTER TABLE case_trace_runs ADD COLUMN cutoff_seq INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE case_trace_runs ADD COLUMN idempotency_key TEXT;
  ALTER TABLE case_trace_runs ADD COLUMN history_incomplete INTEGER NOT NULL DEFAULT 0;
  CREATE UNIQUE INDEX idx_trace_idem ON case_trace_runs(case_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  CREATE TABLE case_trace_snapshots (
    case_id TEXT NOT NULL REFERENCES cases(id),
    revision INTEGER NOT NULL,
    snapshot_json TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    PRIMARY KEY (case_id, revision)
  );

  CREATE TABLE case_analysis_runs (
    case_id TEXT NOT NULL REFERENCES cases(id),
    revision INTEGER NOT NULL,
    trace_revision INTEGER NOT NULL,
    detector_version TEXT NOT NULL,
    config_version TEXT NOT NULL,
    config_json TEXT NOT NULL,
    idempotency_key TEXT,
    summary_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    actor_id TEXT NOT NULL,
    PRIMARY KEY (case_id, revision)
  );
  CREATE UNIQUE INDEX idx_analysis_idem ON case_analysis_runs(case_id, idempotency_key) WHERE idempotency_key IS NOT NULL;

  ALTER TABLE case_findings ADD COLUMN features_json TEXT NOT NULL DEFAULT '{}';
  CREATE INDEX idx_findings_case ON case_findings(case_id, revision);
  ALTER TABLE case_candidates ADD COLUMN role TEXT NOT NULL DEFAULT 'TRACED';
  ALTER TABLE case_candidates ADD COLUMN eligible INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE case_candidates ADD COLUMN exclusion TEXT;
  ALTER TABLE case_candidates ADD COLUMN features_json TEXT NOT NULL DEFAULT '{}';
  ALTER TABLE case_candidates ADD COLUMN finding_ids_json TEXT NOT NULL DEFAULT '[]';

  ALTER TABLE enforcement_actions ADD COLUMN payload_hash TEXT NOT NULL DEFAULT '';
  ALTER TABLE enforcement_actions ADD COLUMN policy TEXT NOT NULL DEFAULT 'MANUAL';
  ALTER TABLE enforcement_actions ADD COLUMN analysis_revision INTEGER NOT NULL DEFAULT 0;

  CREATE TABLE case_reports (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id),
    report_version TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    body TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    actor_id TEXT NOT NULL
  );
  CREATE INDEX idx_reports_case ON case_reports(case_id, created_at);

  DROP TABLE ui_outbox;
  CREATE TABLE ui_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    topic TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    payload TEXT NOT NULL,
    committed_at INTEGER NOT NULL
  );
  CREATE INDEX idx_outbox_resource ON ui_outbox(resource_id, id);
`;

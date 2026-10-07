/** Schema part 3 — tracing, analysis, enforcement, audit, UI outbox. */
export const MIGRATION_3_TRACE_ANALYSIS = `
  CREATE TABLE IF NOT EXISTS case_trace_runs (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('RUNNING','DONE','FAILED')),
    seed_count INTEGER NOT NULL,
    node_count INTEGER NOT NULL,
    edge_count INTEGER NOT NULL,
    truncated INTEGER NOT NULL DEFAULT 0,
    limits_json TEXT NOT NULL,
    cutoff_from INTEGER NOT NULL,
    cutoff_to INTEGER NOT NULL,
    started_at INTEGER NOT NULL,
    finished_at INTEGER,
    error TEXT,
    UNIQUE (case_id, revision)
  );

  CREATE TABLE IF NOT EXISTS case_trace_edges (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    path_id TEXT NOT NULL,
    from_id TEXT NOT NULL,
    to_id TEXT NOT NULL,
    txn_id TEXT NOT NULL,
    ts INTEGER NOT NULL,
    seq INTEGER NOT NULL,
    amount_minor INTEGER NOT NULL,
    hop INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_trace_edges ON case_trace_edges(case_id, revision);

  CREATE TABLE IF NOT EXISTS case_findings (
    id TEXT PRIMARY KEY,
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    motif TEXT NOT NULL,
    account_ids_json TEXT NOT NULL,
    txn_ids_json TEXT NOT NULL,
    score_minor INTEGER NOT NULL,
    explanation TEXT NOT NULL,
    detector_version TEXT NOT NULL,
    config_version TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS case_candidates (
    case_id TEXT NOT NULL REFERENCES cases(id) ON DELETE CASCADE,
    revision INTEGER NOT NULL,
    account_id TEXT NOT NULL,
    score_minor INTEGER NOT NULL,
    contributions_json TEXT NOT NULL,
    suspect_mule INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (case_id, revision, account_id)
  );

  CREATE TABLE IF NOT EXISTS enforcement_actions (
    id TEXT PRIMARY KEY,
    action_key TEXT NOT NULL,
    case_id TEXT NOT NULL REFERENCES cases(id),
    account_ids_json TEXT NOT NULL,
    hold_ids_json TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    reason TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('REQUESTED','APPLIED','FAILED')),
    created_at INTEGER NOT NULL,
    applied_at INTEGER,
    UNIQUE (case_id, action_key)
  );

  CREATE TABLE IF NOT EXISTS audit_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    case_id TEXT REFERENCES cases(id),
    actor_id TEXT NOT NULL,
    action TEXT NOT NULL,
    detail TEXT NOT NULL,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS idx_audit_case ON audit_events(case_id, created_at);

  CREATE TABLE IF NOT EXISTS ui_outbox (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    cursor_id INTEGER NOT NULL UNIQUE,
    resource_type TEXT NOT NULL,
    resource_id TEXT NOT NULL,
    run_id TEXT,
    payload TEXT NOT NULL,
    committed_at INTEGER NOT NULL
  );
`;
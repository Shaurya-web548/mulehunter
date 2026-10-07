/**
 * Schema part 6 — per-account ledger indexes keyed by sequence.
 *
 * Measured on a 400k-row dev ledger: per-account reads filtered by a
 * sequence range were planned on idx_accepted_order (run_id, seq) and scanned
 * every payment after the seed (~120 ms per call), which pushed attribution
 * past its runtime budget. These replace the (…, ts, seq) account indexes
 * one-for-one (same write cost per payment); per-account queries name them
 * with INDEXED BY so the planner cannot regress.
 */
export const MIGRATION_6_ACCOUNT_SEQ_INDEXES = `
  DROP INDEX IF EXISTS idx_accepted_from_run;
  DROP INDEX IF EXISTS idx_accepted_to_run;
  CREATE INDEX idx_accepted_from_seq ON accepted_transactions(run_id, from_id, seq);
  CREATE INDEX idx_accepted_to_seq ON accepted_transactions(run_id, to_id, seq);
`;

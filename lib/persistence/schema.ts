import { MIGRATION_1_LEDGER } from "./migrations/1_ledger.ts";
import { MIGRATION_2_CASES } from "./migrations/2_cases.ts";
import { MIGRATION_3_TRACE_ANALYSIS } from "./migrations/3_trace_analysis.ts";
import { MIGRATION_4_V2_RUNTIME } from "./migrations/4_v2_runtime.ts";
import { MIGRATION_5_RECOVERY } from "./migrations/5_recovery.ts";
import { MIGRATION_6_ACCOUNT_SEQ_INDEXES } from "./migrations/6_account_seq_indexes.ts";

/**
 * Ordered migration list. Each entry runs inside its own transaction by
 * `runMigrations`, which records it in `schema_migrations`.
 */
export const MIGRATIONS: { version: number; name: string; up: string }[] = [
  { version: 1, name: "initial-ledger", up: MIGRATION_1_LEDGER },
  { version: 2, name: "cases-and-holds", up: MIGRATION_2_CASES },
  { version: 3, name: "trace-analysis-enforcement-audit", up: MIGRATION_3_TRACE_ANALYSIS },
  { version: 4, name: "v2-runtime-truth-isolation-hold-sources", up: MIGRATION_4_V2_RUNTIME },
  { version: 5, name: "victim-fund-recovery", up: MIGRATION_5_RECOVERY },
  { version: 6, name: "account-seq-indexes", up: MIGRATION_6_ACCOUNT_SEQ_INDEXES },
];

export const MIGRATION_HEAD = MIGRATIONS[MIGRATIONS.length - 1].version;
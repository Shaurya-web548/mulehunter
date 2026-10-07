import type { DatabaseSync } from "node:sqlite";
import { AccountRepository } from "./repos/accounts.ts";
import { HoldRepository } from "./repos/holds.ts";
import { CaseRepository } from "./repos/cases.ts";
import { TracingRepository } from "./repos/tracing.ts";
import { AnalysisRepository } from "./repos/analysis.ts";
import { EnforcementRepository, AuditRepository } from "./repos/enforcement.ts";
import { MetaRepository, OutboxRepository, ReportRepository, RunRepository } from "./repos/runtime.ts";
import { RecoveryRepository } from "./repos/recovery.ts";
import { withWriteTransaction, withSerializedWrite } from "./repos/shared.ts";

export { withWriteTransaction, withSerializedWrite };

/**
 * Repository bundle over one migrated connection. Simulator ground truth is
 * intentionally absent (see repos/truth.ts).
 */
export interface Store {
  db: DatabaseSync;
  accounts: AccountRepository;
  holds: HoldRepository;
  cases: CaseRepository;
  tracing: TracingRepository;
  analysis: AnalysisRepository;
  enforcement: EnforcementRepository;
  audit: AuditRepository;
  runs: RunRepository;
  meta: MetaRepository;
  outbox: OutboxRepository;
  reports: ReportRepository;
  recoveries: RecoveryRepository;
}

export function createStore(db: DatabaseSync): Store {
  return {
    db,
    accounts: new AccountRepository(db),
    holds: new HoldRepository(db),
    cases: new CaseRepository(db),
    tracing: new TracingRepository(db),
    analysis: new AnalysisRepository(db),
    enforcement: new EnforcementRepository(db),
    audit: new AuditRepository(db),
    runs: new RunRepository(db),
    meta: new MetaRepository(db),
    outbox: new OutboxRepository(db),
    reports: new ReportRepository(db),
    recoveries: new RecoveryRepository(db),
  };
}

/** One write transaction on a store (nested calls become savepoints). */
export function tx<T>(store: Store, fn: () => T): T {
  return withWriteTransaction(store.db, fn);
}

/**
 * One serialized (BEGIN IMMEDIATE) write transaction. If it rolls back, the
 * cached ledger sequence is invalidated so the next admission re-reads it.
 */
export function serialTx<T>(store: Store, fn: () => T): T {
  try {
    return withSerializedWrite(store.db, fn);
  } catch (err) {
    store.accounts.invalidateSeq();
    throw err;
  }
}

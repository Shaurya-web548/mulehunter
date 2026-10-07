import { stmt, type DBSync } from "./shared.ts";

/**
 * Simulator ground truth. Deliberately NOT part of `Store`: only the simulator
 * and the live evaluator (lib/engine) construct this repository. Case intake,
 * tracing, analysis, enforcement, reports and every client API work from
 * `Store` and therefore cannot read mule labels.
 */
export class SimTruthRepository {
  private db: DBSync;
  constructor(db: DBSync) {
    this.db = db;
  }

  label(accountId: string, scenarioId: string | null, isMule: boolean): void {
    stmt(
      this.db,
      `INSERT INTO sim_truth (account_id, is_mule, scenario_id) VALUES (?, ?, ?)
       ON CONFLICT(account_id) DO UPDATE SET is_mule = excluded.is_mule, scenario_id = excluded.scenario_id`,
    ).run(accountId, isMule ? 1 : 0, scenarioId);
  }

  muleIds(): Set<string> {
    return new Set(stmt(this.db, "SELECT account_id FROM sim_truth WHERE is_mule = 1").all().map((r) => String(r.account_id)));
  }
}

/**
 * Accepted-history retention.
 *
 * The live graph forgets after 90 s; complaint tracing reads this durable
 * history instead. It is bounded by `MNH_HISTORY_RETENTION_MIN` so a demo that
 * runs for hours does not grow without limit. Pruning records a watermark:
 * any trace whose window starts before it is flagged `historyIncomplete`.
 *
 * Rejected attempts are never pruned (they are outcome evidence and small).
 * Rows referenced by a case are safe to prune because the case copied the
 * disputed payment facts and every trace revision is an immutable snapshot.
 */
import type { Store } from "../../persistence/store.ts";
import { withSerializedWrite } from "../../persistence/repos/shared.ts";

export const DEFAULT_RETENTION_MIN = 120;

const watermarkKey = (runId: string) => `history_pruned_before:${runId}`;

export function retentionMs(): number {
  const n = Number(process.env.MNH_HISTORY_RETENTION_MIN ?? DEFAULT_RETENTION_MIN);
  return (Number.isFinite(n) && n > 0 ? n : DEFAULT_RETENTION_MIN) * 60_000;
}

/** Earliest timestamp for which accepted history is complete (0 = never pruned). */
export function historyWatermark(store: Store, runId: string): number {
  return store.meta.getNumber(watermarkKey(runId), 0);
}

/**
 * Delete accepted history older than `beforeTs` in bounded batches. Returns
 * the number of accepted rows removed. Safe to call repeatedly.
 */
export function pruneHistory(store: Store, runId: string, beforeTs: number, batch = 20_000): number {
  const db = store.db;
  return withSerializedWrite(db, () => {
    const victims = db
      .prepare("SELECT rowid AS rid, attempt_id FROM accepted_transactions WHERE run_id = ? AND ts < ? LIMIT ?")
      .all(runId, beforeTs, batch);
    if (victims.length === 0) return 0;
    const delTxn = db.prepare("DELETE FROM accepted_transactions WHERE rowid = ?");
    // Client-supplied attempt ids (manual:*) are kept as tombstones so a late
    // retry after pruning still replays instead of moving money again.
    // Simulator attempt ids are random and never retried after execution.
    const delAttempt = db.prepare("DELETE FROM payment_attempts WHERE attempt_id = ? AND status = 'ACCEPTED' AND attempt_id NOT LIKE 'manual:%'");
    // child (accepted txn) first, then its parent attempt row — FK-safe
    for (const v of victims) delTxn.run(Number(v.rid));
    for (const v of victims) delAttempt.run(String(v.attempt_id));
    // Advance the watermark only when every row older than beforeTs is gone;
    // otherwise the next batch continues and the old watermark still holds.
    const left = db.prepare("SELECT 1 FROM accepted_transactions WHERE run_id = ? AND ts < ? LIMIT 1").get(runId, beforeTs);
    if (!left) store.meta.set(watermarkKey(runId), String(Math.max(historyWatermark(store, runId), beforeTs)));
    return victims.length;
  });
}

import type { TraceEdge, TraceRun } from "../../contracts/types.ts";
import { stmt, type DBSync } from "./shared.ts";

export class TracingRepository {
  private db: DBSync;

  constructor(db: DBSync) {
    this.db = db;
  }

  insertRun(t: TraceRun, idempotencyKey: string | null = null): void {
    stmt(
      this.db,
      `INSERT INTO case_trace_runs
       (id, case_id, revision, status, seed_count, node_count, edge_count, truncated,
        limits_json, cutoff_from, cutoff_to, started_at, finished_at, error,
        run_id, cutoff_seq, idempotency_key, history_incomplete)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      t.id,
      t.caseId,
      t.revision,
      t.status,
      t.seedCount,
      t.nodeCount,
      t.edgeCount,
      t.truncated ? 1 : 0,
      JSON.stringify(t.limits),
      t.cutoffFrom,
      t.cutoffTo,
      t.startedAt,
      t.finishedAt,
      t.error,
      t.runId ?? "",
      t.cutoffSeq ?? 0,
      idempotencyKey,
      t.historyIncomplete ? 1 : 0,
    );
  }

  finishRun(
    id: string,
    status: TraceRun["status"],
    nodes: number,
    edges: number,
    truncated: boolean,
    finishedAt: number | null,
    error: string | null,
    historyIncomplete = false,
  ): void {
    stmt(
      this.db,
      `UPDATE case_trace_runs SET status=?, node_count=?, edge_count=?, truncated=?, finished_at=?, error=?, history_incomplete=? WHERE id=?`,
    ).run(status, nodes, edges, truncated ? 1 : 0, finishedAt, error, historyIncomplete ? 1 : 0, id);
  }

  latestForCase(caseId: string): TraceRun | null {
    const r = stmt(this.db, "SELECT * FROM case_trace_runs WHERE case_id = ? ORDER BY revision DESC LIMIT 1").get(caseId);
    return r ? this.rowRun(r) : null;
  }

  /** Latest trace revision that completed (analysis input). */
  latestDone(caseId: string): TraceRun | null {
    const r = stmt(this.db, "SELECT * FROM case_trace_runs WHERE case_id = ? AND status = 'DONE' ORDER BY revision DESC LIMIT 1").get(caseId);
    return r ? this.rowRun(r) : null;
  }

  listForCase(caseId: string): TraceRun[] {
    return stmt(this.db, "SELECT * FROM case_trace_runs WHERE case_id = ? ORDER BY revision DESC")
      .all(caseId)
      .map((r) => this.rowRun(r));
  }

  getRun(id: string): TraceRun | null {
    const r = stmt(this.db, "SELECT * FROM case_trace_runs WHERE id = ?").get(id);
    return r ? this.rowRun(r) : null;
  }

  byRevision(caseId: string, revision: number): TraceRun | null {
    const r = stmt(this.db, "SELECT * FROM case_trace_runs WHERE case_id = ? AND revision = ?").get(caseId, revision);
    return r ? this.rowRun(r) : null;
  }

  byIdempotencyKey(caseId: string, key: string): TraceRun | null {
    const r = stmt(this.db, "SELECT * FROM case_trace_runs WHERE case_id = ? AND idempotency_key = ?").get(caseId, key);
    return r ? this.rowRun(r) : null;
  }

  nextRevision(caseId: string): number {
    const r = stmt(this.db, "SELECT COALESCE(MAX(revision), 0) AS v FROM case_trace_runs WHERE case_id = ?").get(caseId);
    return Number(r?.v ?? 0) + 1;
  }

  insertEdges(caseId: string, revision: number, edges: TraceEdge[]): void {
    const st = stmt(
      this.db,
      `INSERT INTO case_trace_edges (case_id, revision, path_id, from_id, to_id, txn_id, ts, seq, amount_minor, hop)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const e of edges) st.run(caseId, revision, e.pathId, e.fromId, e.toId, e.txnId, e.ts, e.seq, e.amountMinor, e.hop);
  }

  listEdges(caseId: string, revision: number): TraceEdge[] {
    return stmt(this.db, "SELECT * FROM case_trace_edges WHERE case_id = ? AND revision = ? ORDER BY hop, ts, seq")
      .all(caseId, revision)
      .map((r) => ({
        pathId: String(r.path_id),
        fromId: String(r.from_id),
        toId: String(r.to_id),
        txnId: String(r.txn_id),
        ts: Number(r.ts),
        seq: Number(r.seq),
        amountMinor: Number(r.amount_minor),
        hop: Number(r.hop),
      }));
  }

  putSnapshot(caseId: string, revision: number, json: string, contentHash: string): void {
    stmt(this.db, "INSERT INTO case_trace_snapshots (case_id, revision, snapshot_json, content_hash) VALUES (?, ?, ?, ?)").run(
      caseId,
      revision,
      json,
      contentHash,
    );
  }

  getSnapshot(caseId: string, revision: number): { json: string; contentHash: string } | null {
    const r = stmt(this.db, "SELECT snapshot_json, content_hash FROM case_trace_snapshots WHERE case_id = ? AND revision = ?").get(caseId, revision);
    return r ? { json: String(r.snapshot_json), contentHash: String(r.content_hash) } : null;
  }

  private rowRun(r: Record<string, unknown>): TraceRun {
    return {
      id: String(r.id),
      caseId: String(r.case_id),
      revision: Number(r.revision),
      status: r.status as TraceRun["status"],
      seedCount: Number(r.seed_count),
      nodeCount: Number(r.node_count),
      edgeCount: Number(r.edge_count),
      truncated: !!r.truncated,
      limits: JSON.parse(String(r.limits_json)),
      cutoffFrom: Number(r.cutoff_from),
      cutoffTo: Number(r.cutoff_to),
      startedAt: Number(r.started_at),
      finishedAt: r.finished_at == null ? null : Number(r.finished_at),
      error: r.error == null ? null : String(r.error),
      runId: String(r.run_id ?? ""),
      cutoffSeq: Number(r.cutoff_seq ?? 0),
      historyIncomplete: !!r.history_incomplete,
    };
  }
}

import { stmt, type DBSync } from "./shared.ts";

/** Simulation runs: one active ledger lineage that survives restarts. */
export class RunRepository {
  private db: DBSync;
  constructor(db: DBSync) {
    this.db = db;
  }

  active(): { id: string; seed: number; createdAt: number } | null {
    const r = stmt(this.db, "SELECT id, seed, created_at FROM sim_runs WHERE active = 1 ORDER BY created_at DESC LIMIT 1").get();
    return r ? { id: String(r.id), seed: Number(r.seed), createdAt: Number(r.created_at) } : null;
  }

  create(id: string, seed: number, createdAt: number): void {
    stmt(this.db, "UPDATE sim_runs SET active = 0 WHERE active = 1").run();
    stmt(this.db, "INSERT INTO sim_runs (id, seed, created_at, active) VALUES (?, ?, ?, 1)").run(id, seed, createdAt);
  }
}

/** Small key/value table for ledger metadata (e.g. the history prune watermark). */
export class MetaRepository {
  private db: DBSync;
  constructor(db: DBSync) {
    this.db = db;
  }

  get(key: string): string | null {
    const r = stmt(this.db, "SELECT value FROM ledger_meta WHERE key = ?").get(key);
    return r ? String(r.value) : null;
  }

  set(key: string, value: string): void {
    stmt(this.db, "INSERT INTO ledger_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(key, value);
  }

  getNumber(key: string, fallback: number): number {
    const v = this.get(key);
    const n = v === null ? NaN : Number(v);
    return Number.isFinite(n) ? n : fallback;
  }
}

export interface OutboxEvent {
  id: number;
  topic: string;
  resourceId: string;
  version: number;
  payload: unknown;
  committedAt: number;
}

/**
 * Durable UI notification outbox. Rows are written in the same transaction as
 * the domain change they describe, so an SSE client can never be told about a
 * change that did not commit, and a reconnecting client can replay by cursor.
 */
export class OutboxRepository {
  private db: DBSync;
  constructor(db: DBSync) {
    this.db = db;
  }

  append(topic: string, resourceId: string, version: number, payload: unknown, committedAt: number): number {
    const r = stmt(
      this.db,
      "INSERT INTO ui_outbox (topic, resource_id, version, payload, committed_at) VALUES (?, ?, ?, ?, ?)",
    ).run(topic, resourceId, version, JSON.stringify(payload), committedAt);
    return Number(r.lastInsertRowid);
  }

  after(cursor: number, limit = 200): OutboxEvent[] {
    return stmt(this.db, "SELECT * FROM ui_outbox WHERE id > ? ORDER BY id LIMIT ?")
      .all(cursor, limit)
      .map((r) => ({
        id: Number(r.id),
        topic: String(r.topic),
        resourceId: String(r.resource_id),
        version: Number(r.version),
        payload: JSON.parse(String(r.payload)),
        committedAt: Number(r.committed_at),
      }));
  }

  head(): number {
    const r = stmt(this.db, "SELECT COALESCE(MAX(id), 0) AS m FROM ui_outbox").get();
    return Number(r?.m ?? 0);
  }
}

export interface StoredReport {
  id: string;
  caseId: string;
  reportVersion: string;
  contentHash: string;
  body: string;
  createdAt: number;
  actorId: string;
}

/** Immutable exported report snapshots. */
export class ReportRepository {
  private db: DBSync;
  constructor(db: DBSync) {
    this.db = db;
  }

  insert(r: StoredReport): void {
    stmt(
      this.db,
      "INSERT INTO case_reports (id, case_id, report_version, content_hash, body, created_at, actor_id) VALUES (?, ?, ?, ?, ?, ?, ?)",
    ).run(r.id, r.caseId, r.reportVersion, r.contentHash, r.body, r.createdAt, r.actorId);
  }

  byHash(caseId: string, contentHash: string): StoredReport | null {
    const r = stmt(this.db, "SELECT * FROM case_reports WHERE case_id = ? AND content_hash = ? LIMIT 1").get(caseId, contentHash);
    return r ? this.row(r) : null;
  }

  get(id: string): StoredReport | null {
    const r = stmt(this.db, "SELECT * FROM case_reports WHERE id = ?").get(id);
    return r ? this.row(r) : null;
  }

  list(caseId: string): Omit<StoredReport, "body">[] {
    return stmt(this.db, "SELECT id, case_id, report_version, content_hash, created_at, actor_id FROM case_reports WHERE case_id = ? ORDER BY created_at DESC")
      .all(caseId)
      .map((r) => ({
        id: String(r.id),
        caseId: String(r.case_id),
        reportVersion: String(r.report_version),
        contentHash: String(r.content_hash),
        createdAt: Number(r.created_at),
        actorId: String(r.actor_id),
      }));
  }

  private row(r: Record<string, unknown>): StoredReport {
    return {
      id: String(r.id),
      caseId: String(r.case_id),
      reportVersion: String(r.report_version),
      contentHash: String(r.content_hash),
      body: String(r.body),
      createdAt: Number(r.created_at),
      actorId: String(r.actor_id),
    };
  }
}

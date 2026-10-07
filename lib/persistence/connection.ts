import { DatabaseSync } from "node:sqlite";
import fs from "node:fs";
import path from "node:path";

/**
 * Application DB handles. Kept small and explicit so callers never guess.
 */
export const DB_DEFAULT_PATH = "data/mulehunter.db";

export interface PersistenceConfig {
  /** Path to the SQLite file, or ":memory:" for tests. */
  path: string;
}

/**
 * Open (and create) the SQLite database, apply WAL + FK pragmas, and run any
 * pending migrations. Uses the Node 24 built-in `node:sqlite` module — no
 * native third-party dependency.
 */
export function openDatabase(cfg: PersistenceConfig): DatabaseSync {
  if (cfg.path !== ":memory:") {
    fs.mkdirSync(path.dirname(cfg.path), { recursive: true });
  }
  const db = new DatabaseSync(cfg.path);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec("PRAGMA foreign_keys = ON");
  db.exec("PRAGMA busy_timeout = 5000");
  return db;
}

/**
 * Record a migration as applied (insert into schema_migrations), running it
 * inside a transaction so a failed DDL does not half-apply.
 */
export function runMigrations(db: DatabaseSync, migrations: { version: number; name: string; up: string }[]): number {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at INTEGER NOT NULL
  )`);

  const applied = new Set(
    db.prepare("SELECT version FROM schema_migrations").all().map((r) => Number(r.version)),
  );

  let ran = 0;
  for (const m of migrations.sort((a, b) => a.version - b.version)) {
    if (applied.has(m.version)) continue;
    db.exec("BEGIN");
    try {
      db.exec(m.up);
      db.prepare("INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)").run(m.version, m.name, Date.now());
      db.exec("COMMIT");
      ran++;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  }
  return ran;
}

/** The highest applied migration version (0 if none). */
export function migrationHead(db: DatabaseSync): number {
  const row = db.prepare("SELECT COALESCE(MAX(version), 0) AS v FROM schema_migrations").get();
  return Number((row as { v: number }).v);
}
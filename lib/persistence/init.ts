import { openDatabase, runMigrations, migrationHead } from "./connection.ts";
import { MIGRATIONS, MIGRATION_HEAD } from "./schema.ts";
import { createStore, type Store } from "./store.ts";

export interface InitResult {
  store: Store;
  migrationsApplied: number;
  head: number;
  dbPath: string;
}

/** Open the database, apply pending migrations and build the repository store. */
export function initDb(dbPath: string | null = null): InitResult {
  const resolved = dbPath ?? process.env.MNH_DB_PATH ?? "data/mulehunter.db";
  const db = openDatabase({ path: resolved });
  const migrationsApplied = runMigrations(db, MIGRATIONS);
  const head = migrationHead(db);
  const store = createStore(db);
  return { store, migrationsApplied, head, dbPath: resolved };
}

export const EXPECTED_HEAD = MIGRATION_HEAD;

declare global {
  var __mnhDb: InitResult | undefined;
}

/**
 * Process-wide connection. Kept on globalThis because Next.js may evaluate a
 * module once per route bundle (and again on dev HMR); two connections in one
 * process would still be correct under SQLite locking, but one connection keeps
 * the "one writer, synchronous transactions" reasoning exact.
 */
export function getDb(): InitResult {
  if (!globalThis.__mnhDb) globalThis.__mnhDb = initDb();
  const init = globalThis.__mnhDb;
  // Dev hot reload keeps the cached connection across code changes: apply any
  // new migrations and attach repositories added since the store was built.
  // Existing repository instances are kept — the engine shares them, and the
  // payment gate's ledger-sequence cache must stay a single instance.
  if (init.head !== EXPECTED_HEAD) {
    runMigrations(init.store.db, MIGRATIONS);
    init.head = migrationHead(init.store.db);
  }
  const fresh = createStore(init.store.db) as unknown as Record<string, unknown>;
  const current = init.store as unknown as Record<string, unknown>;
  for (const key of Object.keys(fresh)) if (!(key in current)) current[key] = fresh[key];
  return init;
}

export function resetDb(dbPath: string | null = null): InitResult {
  globalThis.__mnhDb = initDb(dbPath);
  return globalThis.__mnhDb;
}

export function healthy(): { ready: boolean; head: number; expected: number; dbPath: string | null } {
  const init = globalThis.__mnhDb;
  if (!init) return { ready: false, head: 0, expected: EXPECTED_HEAD, dbPath: null };
  return { ready: init.head === EXPECTED_HEAD, head: init.head, expected: EXPECTED_HEAD, dbPath: init.dbPath };
}

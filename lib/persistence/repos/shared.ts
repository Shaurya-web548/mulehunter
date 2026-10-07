import type { DatabaseSync } from "node:sqlite";
import crypto from "node:crypto";

/**
 * Shared persistence helpers: id generation, hashing, statement cache and the
 * write-transaction boundary.
 *
 * node:sqlite is synchronous and the process holds one connection, so a write
 * transaction is a `BEGIN IMMEDIATE`/`COMMIT` pair around a synchronous
 * callback. No `await` can occur inside, so two transactions never interleave:
 * whichever commits first is the one the next transaction observes.
 */

export type DBSync = DatabaseSync;
type Statement = ReturnType<DatabaseSync["prepare"]>;

const statementCache = new WeakMap<DatabaseSync, Map<string, Statement>>();

/**
 * Prepared-statement cache per connection. The admission gate runs hundreds of
 * times per engine tick, so re-compiling SQL on every call is the dominant cost.
 */
export function stmt(db: DatabaseSync, sql: string): Statement {
  let cache = statementCache.get(db);
  if (!cache) {
    cache = new Map();
    statementCache.set(db, cache);
  }
  let s = cache.get(sql);
  if (!s) {
    s = db.prepare(sql);
    cache.set(sql, s);
  }
  return s;
}

export function uid(prefix: string): string {
  return `${prefix}_${crypto.randomBytes(8).toString("hex")}`;
}

export function shortId(prefix: string): string {
  return `${prefix}_${Date.now().toString(36)}${crypto.randomBytes(3).toString("hex")}`;
}

/** Stable JSON: object keys sorted recursively so equal payloads hash equally. */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  const obj = value as Record<string, unknown>;
  const keys = Object.keys(obj).filter((k) => obj[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(obj[k])}`).join(",")}}`;
}

export function hashPayload(obj: unknown): string {
  return crypto.createHash("sha256").update(canonicalJson(obj)).digest("hex");
}

const depth = new WeakMap<DatabaseSync, number>();

function run<T>(db: DBSync, begin: string, fn: () => T): T {
  const d = depth.get(db) ?? 0;
  const savepoint = `sp_${d}`;
  db.exec(d === 0 ? begin : `SAVEPOINT ${savepoint}`);
  depth.set(db, d + 1);
  try {
    const result = fn();
    depth.set(db, d);
    db.exec(d === 0 ? "COMMIT" : `RELEASE ${savepoint}`);
    return result;
  } catch (err) {
    depth.set(db, d);
    if (d === 0) db.exec("ROLLBACK");
    else db.exec(`ROLLBACK TO ${savepoint}; RELEASE ${savepoint}`);
    throw err;
  }
}

/**
 * Run `fn` inside a synchronous write transaction. Commits on success and
 * rolls back on any throw. Nested calls become savepoints, so a service can
 * compose repository calls that are themselves transactional.
 */
export function withWriteTransaction<T>(db: DBSync, fn: () => T): T {
  return run(db, "BEGIN", fn);
}

/**
 * Serialize payment admission + hold creation through the same transaction
 * boundary. BEGIN IMMEDIATE takes the write lock up front. A payment that
 * commits first stays accepted; a hold that commits first rejects the debit.
 */
export function withSerializedWrite<T>(db: DBSync, fn: () => T): T {
  return run(db, "BEGIN IMMEDIATE", fn);
}

export function inTransaction(db: DBSync): boolean {
  return (depth.get(db) ?? 0) > 0;
}

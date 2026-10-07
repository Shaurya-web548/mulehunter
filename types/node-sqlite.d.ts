/**
 * Local declarations for Node's built-in `node:sqlite` module (Node >= 22.5).
 * Kept to the surface this project uses; see the Node docs for the full API:
 * https://nodejs.org/api/sqlite.html
 */

declare module "node:sqlite" {
  type SQLiteValue = string | number | bigint | null | Uint8Array;

  interface SQLiteResult {
    changes: number;
    lastInsertRowid: number | bigint;
  }

  interface Row {
    [column: string]: SQLiteValue;
  }

  interface StatementSync {
    run(...params: (string | number | bigint | null)[]): SQLiteResult;
    run(params: Record<string, string | number | bigint | null>): SQLiteResult;
    all(...params: (string | number | bigint | null)[]): Row[];
    all(params: Record<string, string | number | bigint | null>): Row[];
    get(...params: (string | number | bigint | null)[]): Row | null;
    get(params: Record<string, string | number | bigint | null>): Row | null;
  }

  class DatabaseSync {
    constructor(path: string, options?: { readOnly?: boolean; create?: boolean });
    prepare(sql: string): StatementSync;
    exec(sql: string): void;
    close(): void;
  }

  export { DatabaseSync };
}
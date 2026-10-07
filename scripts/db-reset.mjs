/**
 * Delete the local demo database (and its WAL sidecars) so migrations re-apply
 * from empty. This never touches anything outside ./data.
 *
 * Usage: npm run db:reset
 */
import fs from "node:fs";
import path from "node:path";

const target = process.env.MNH_DB_PATH ?? "data/mulehunter.db";
for (const suffix of ["", "-wal", "-shm"]) {
  const p = `${target}${suffix}`;
  if (fs.existsSync(p)) {
    fs.rmSync(p, { force: true });
    console.log(`removed ${path.relative(process.cwd(), p)}`);
  }
}
console.log("database reset complete");

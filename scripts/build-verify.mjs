/**
 * Production build into an isolated dist dir (.next-verify) so a running
 * `next dev` (which uses .next) is never disturbed. Cross-platform.
 *
 * Usage: npm run build:verify
 */
import { spawnSync } from "node:child_process";

const r = spawnSync("npx", ["next", "build"], {
  stdio: "inherit",
  shell: process.platform === "win32",
  env: { ...process.env, NEXT_DIST_DIR: ".next-verify" },
});
process.exit(r.status ?? 1);

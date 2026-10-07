import fs from "node:fs";
import path from "node:path";
import { defineConfig } from "@playwright/test";

// Browser journey against a PRODUCTION build in an isolated dist dir
// (`npm run build:verify`), with a fresh throwaway SQLite database.
const PORT = Number(process.env.E2E_PORT ?? 3107);
const dbPath = path.resolve(".next-verify", "e2e.db");
// reset the throwaway DB once, in the main process only (workers re-evaluate this file)
if (!process.env.TEST_WORKER_INDEX) for (const suffix of ["", "-wal", "-shm"]) fs.rmSync(dbPath + suffix, { force: true });

export const E2E_OPERATOR_CODE = "e2e-operator-code";

export default defineConfig({
  testDir: "tests/e2e",
  testMatch: /.*\.spec\.ts/,
  timeout: 240_000,
  expect: { timeout: 20_000 },
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    baseURL: `http://localhost:${PORT}`,
    trace: "retain-on-failure",
  },
  webServer: {
    command: `npx next start -p ${PORT}`,
    url: `http://localhost:${PORT}/api/config`,
    timeout: 120_000,
    reuseExistingServer: false,
    env: {
      NEXT_DIST_DIR: ".next-verify",
      MNH_DB_PATH: dbPath,
      MNH_OPERATOR_CODE: E2E_OPERATOR_CODE,
      MNH_DEMO_AUTO_ENFORCE: "1",
      MNH_BASE_TPS: "120",
    },
  },
});

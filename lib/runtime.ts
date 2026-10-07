/**
 * Process runtime: one SQLite connection + one simulation engine per Node
 * process, both on globalThis so Next.js dev HMR and per-route bundles share
 * them. Server-only (node:sqlite) — never import from a client component.
 *
 * Deployment limit: this is a single-process demo. Multiple Node processes or
 * serverless instances would each run their own simulator against one SQLite
 * file; that is not supported (see docs/case-workflow.md).
 */
import crypto from "node:crypto";
import { getDb } from "./persistence/init.ts";
import type { Store } from "./persistence/store.ts";
import { Engine } from "./engine/engine.ts";
import { recoverInterruptedTraces } from "./modules/tracing/job.ts";

export const DEFAULT_BASE_TPS = 250;

export function baseTps(): number {
  const n = Number(process.env.MNH_BASE_TPS ?? DEFAULT_BASE_TPS);
  return Number.isFinite(n) && n >= 0 && n <= 5000 ? n : DEFAULT_BASE_TPS;
}

/** Resume the active simulation run or start a new one. */
export function ensureRun(store: Store, now = Date.now()): string {
  const active = store.runs.active();
  if (active) return active.id;
  const id = `run_${crypto.randomBytes(5).toString("hex")}`;
  store.runs.create(id, crypto.randomInt(0, 2 ** 31), now);
  return id;
}

declare global {
  var __muleEngine: Engine | undefined;
}

export function getStore(): Store {
  return getDb().store;
}

export function getEngine(): Engine {
  if (!globalThis.__muleEngine) {
    const store = getStore();
    const runId = ensureRun(store);
    // A trace job cannot survive a process restart; mark it for retry.
    recoverInterruptedTraces(store, Date.now());
    globalThis.__muleEngine = new Engine(store, { runId, baseTps: baseTps() });
  }
  return globalThis.__muleEngine;
}

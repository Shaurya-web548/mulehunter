/**
 * U2 evidence — funded ledger, single admission gate, independent holds.
 *
 * Real node:sqlite files, real migrations, the real Engine/Simulator driven
 * tick by tick. Nothing mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initDb } from "../../lib/persistence/init.ts";
import type { Store } from "../../lib/persistence/store.ts";
import { Engine } from "../../lib/engine/engine.ts";
import { ensureRun } from "../../lib/runtime.ts";
import { admitPayment } from "../../lib/modules/payments/admission.ts";
import { applyCaseHoldInTx, applyLegacyRingHolds, releaseHold } from "../../lib/modules/protection/holds.ts";
import { historyWatermark, pruneHistory } from "../../lib/modules/payments/retention.ts";
import { serialTx } from "../../lib/persistence/store.ts";

function tmpDb(): { file: string; cleanup: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnh-u2-"));
  return { file: path.join(dir, "u2.db"), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function smallEngine(store: Store, now: number): Engine {
  const runId = ensureRun(store, now);
  return new Engine(store, { runId, baseTps: 40, autoStart: false, nPeople: 150, nMerchants: 8, now });
}

function count(store: Store, sql: string, ...args: (string | number)[]): number {
  return Number((store.db.prepare(sql).get(...args) as { c: number }).c);
}

function mkCase(store: Store, id: string, victim: string, now: number) {
  store.cases.insert(
    { id, reporterId: "r", victimAccountId: victim, incidentStartTs: now - 1, incidentEndTs: now, declaredLossMinor: 0, narrative: "test case", stage: "VALIDATED", status: "VALIDATED", revision: 1, createdAt: now, updatedAt: now },
    [],
  );
}

test("every simulated payment passes the gate and money is conserved", () => {
  const { file, cleanup } = tmpDb();
  try {
    const { store } = initDb(file);
    const t0 = Date.now();
    const engine = smallEngine(store, t0);
    engine.launch("fanout_layering");
    engine.launch("smurfing");
    let now = t0;
    for (let i = 0; i < 160; i++) {
      now += 250;
      engine.tick(now, 250);
    }
    const c = store.accounts.conservation(engine.runId);
    assert.equal(c.balanceMinor, c.openingMinor, "Σ balance must equal Σ opening balance");
    // the live graph saw exactly the accepted ledger rows
    const accepted = count(store, "SELECT COUNT(*) AS c FROM accepted_transactions WHERE run_id = ?", engine.runId);
    assert.equal(accepted, engine.processed);
    assert.ok(accepted > 1000);
    // no account ever went negative
    assert.equal(count(store, "SELECT COUNT(*) AS c FROM accounts WHERE balance_minor < 0"), 0);
    store.db.close();
  } finally {
    cleanup();
  }
});

test("a queued payout is checked at execution time: hold committed first → rejected", () => {
  const { file, cleanup } = tmpDb();
  try {
    const { store } = initDb(file);
    const t0 = Date.now();
    const engine = smallEngine(store, t0);
    engine.sim.baseTps = 0;
    const mule = engine.sim.open(t0, "person", 5_000_000).id;
    const other = engine.sim.open(t0, "person", 0).id;

    // scheduled BEFORE any hold exists
    const early = engine.sim.schedule(t0 + 100, mule, other, 100_000);
    const late = engine.sim.schedule(t0 + 1000, mule, other, 200_000);
    engine.tick(t0 + 250, 250); // executes `early`
    assert.equal(store.accounts.getAttempt(early)?.status, "ACCEPTED");

    mkCase(store, "case_q", other, t0);
    serialTx(store, () =>
      applyCaseHoldInTx(store, { caseId: "case_q", accountId: mule, type: "MULE_DEBIT_FREEZE", reason: "suspected mule under review", actorId: "op", now: t0 + 500 }),
    );
    engine.tick(t0 + 1000, 750); // executes `late` after the hold committed

    const lateRes = store.accounts.getAttempt(late)!;
    assert.equal(lateRes.status, "REJECTED");
    assert.equal(lateRes.rejectReason, "HOLD");
    assert.ok(lateRes.holdId);
    // the earlier committed payment stays accepted; balance reflects only it
    assert.equal(store.accounts.getAttempt(early)?.status, "ACCEPTED");
    assert.equal(store.accounts.get(mule)!.balanceMinor, 4_900_000);
    assert.equal(engine.blockedAttempts, 1);
    store.db.close();
  } finally {
    cleanup();
  }
});

test("a debit hold still allows incoming credits", () => {
  const { file, cleanup } = tmpDb();
  try {
    const { store } = initDb(file);
    const t0 = Date.now();
    const engine = smallEngine(store, t0);
    const victim = engine.sim.open(t0, "person", 1_000_000).id;
    const payer = engine.sim.open(t0, "person", 1_000_000).id;
    mkCase(store, "case_c", victim, t0);
    serialTx(store, () =>
      applyCaseHoldInTx(store, { caseId: "case_c", accountId: victim, type: "VICTIM_PROTECTION", reason: "victim protection", actorId: "op", now: t0 }),
    );
    const credit = admitPayment(store, { runId: engine.runId, fromId: payer, toId: victim, amountMinor: 50_000, ts: t0 + 1, channel: "MANUAL" });
    const debit = admitPayment(store, { runId: engine.runId, fromId: victim, toId: payer, amountMinor: 50_000, ts: t0 + 2, channel: "MANUAL" });
    assert.equal(credit.status, "ACCEPTED");
    assert.equal(debit.status, "REJECTED");
    assert.equal(debit.rejectReason, "HOLD");
    assert.equal(store.accounts.get(victim)!.balanceMinor, 1_050_000);
    store.db.close();
  } finally {
    cleanup();
  }
});

test("legacy ring freeze becomes reasoned holds; releasing one of two holds keeps the account blocked", () => {
  const { file, cleanup } = tmpDb();
  try {
    const { store } = initDb(file);
    const t0 = Date.now();
    const engine = smallEngine(store, t0);
    const mule = engine.sim.open(t0, "person", 1_000_000).id;
    const dst = engine.sim.open(t0, "person", 0).id;

    const legacy = applyLegacyRingHolds(store, { ringId: "ring_x", accountIds: [mule], ringScore: 81, pattern: "fan-out layering", actorId: "console", now: t0 });
    assert.equal(legacy.length, 1);
    assert.equal(legacy[0].source, "LEGACY_RING");
    assert.equal(legacy[0].caseId, null);
    assert.match(legacy[0].reason, /ring risk score 81\/100/);
    // idempotent per ring
    assert.equal(applyLegacyRingHolds(store, { ringId: "ring_x", accountIds: [mule], ringScore: 81, pattern: "x", actorId: "console", now: t0 }).length, 1);

    mkCase(store, "case_m", dst, t0);
    const caseHold = serialTx(store, () =>
      applyCaseHoldInTx(store, { caseId: "case_m", accountId: mule, type: "MULE_DEBIT_FREEZE", reason: "case evidence: fan-out", actorId: "op", now: t0 + 1 }),
    ).hold;

    const rel = releaseHold(store, { holdId: legacy[0].id, reason: "ring reviewed and cleared", actorId: "op", now: t0 + 2 });
    assert.deepEqual(rel.stillBlockedBy.map((h) => h.id), [caseHold.id]);
    const stillBlocked = admitPayment(store, { runId: engine.runId, fromId: mule, toId: dst, amountMinor: 100, ts: t0 + 3, channel: "MANUAL" });
    assert.equal(stillBlocked.rejectReason, "HOLD");
    assert.equal(stillBlocked.holdId, caseHold.id);

    assert.throws(() => releaseHold(store, { holdId: legacy[0].id, reason: "second release attempt", actorId: "op", now: t0 + 4 }), /already released/);
    assert.throws(() => releaseHold(store, { holdId: caseHold.id, reason: "", actorId: "op", now: t0 + 4 }), /reason/);

    releaseHold(store, { holdId: caseHold.id, reason: "case closed after review", actorId: "op", now: t0 + 5 });
    const ok = admitPayment(store, { runId: engine.runId, fromId: mule, toId: dst, amountMinor: 100, ts: t0 + 6, channel: "MANUAL" });
    assert.equal(ok.status, "ACCEPTED");
    store.db.close();
  } finally {
    cleanup();
  }
});

test("the live console freeze goes through the hold service and survives restart", () => {
  const { file, cleanup } = tmpDb();
  try {
    const first = initDb(file);
    const t0 = Date.now();
    const engine = smallEngine(first.store, t0);
    const a = engine.sim.open(t0, "person", 700_000).id;
    const b = engine.sim.open(t0, "person", 0).id;
    engine.rings.set("ring_live", { id: "ring_live", pattern: "fanout_layering", accounts: [a], score: 77, detectedAt: t0, status: "active", totalFlow: 0, intercepted: 0 });
    engine.freeze("ring_live");
    assert.equal(engine.snapshot(t0).metrics.heldAccounts >= 1, true);
    const balanceBefore = first.store.accounts.get(a)!.balanceMinor;
    const runId = engine.runId;
    first.store.db.close();

    // new process: same run, same accounts, balances and holds
    const second = initDb(file);
    assert.equal(second.migrationsApplied, 0);
    const resumed = new Engine(second.store, { runId: ensureRun(second.store), baseTps: 0, autoStart: false });
    assert.equal(resumed.runId, runId);
    assert.ok(resumed.sim.accounts.has(a));
    assert.equal(second.store.accounts.get(a)!.balanceMinor, balanceBefore);
    assert.ok(resumed.held.has(a));
    const r = admitPayment(second.store, { runId, fromId: a, toId: b, amountMinor: 1_000, ts: t0 + 10, channel: "MANUAL" });
    assert.equal(r.rejectReason, "HOLD");
    second.store.db.close();
  } finally {
    cleanup();
  }
});

test("retention prunes old accepted history and records a watermark", () => {
  const { file, cleanup } = tmpDb();
  try {
    const { store } = initDb(file);
    const t0 = Date.now();
    const engine = smallEngine(store, t0);
    const a = engine.sim.open(t0, "person", 1_000_000).id;
    const b = engine.sim.open(t0, "person", 0).id;
    const old = admitPayment(store, { runId: engine.runId, fromId: a, toId: b, amountMinor: 100, ts: t0 - 10_000, channel: "MANUAL" });
    const fresh = admitPayment(store, { runId: engine.runId, fromId: a, toId: b, amountMinor: 100, ts: t0, channel: "MANUAL" });
    assert.equal(historyWatermark(store, engine.runId), 0);
    assert.equal(pruneHistory(store, engine.runId, t0 - 5_000), 1);
    assert.equal(historyWatermark(store, engine.runId), t0 - 5_000);
    assert.equal(store.accounts.getAccepted(old.input.txnId, engine.runId), null);
    assert.ok(store.accounts.getAccepted(fresh.input.txnId, engine.runId));
    // balances are untouched by pruning
    assert.equal(store.accounts.get(b)!.balanceMinor, 200);
    store.db.close();
  } finally {
    cleanup();
  }
});

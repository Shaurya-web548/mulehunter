/**
 * U1 persistence evidence — the durable foundation for the complaint-driven
 * workflow. Every test runs against the real `node:sqlite` driver with real
 * migrations; nothing is mocked.
 *
 * Run with `npm test` (node --test on Node >= 24 — no transpiler, so the
 * codebase stays "erasable syntax only").
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initDb } from "../../lib/persistence/init.ts";
import { serialTx, type Store } from "../../lib/persistence/store.ts";
import { decideAdmission } from "../../lib/persistence/repos/ledger.ts";
import { rupeesToMinor, minorToInr, sumMinor } from "../../lib/contracts/money.ts";
import type { Account, AccountHold, Case } from "../../lib/contracts/types.ts";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function mkAccount(id: string, balanceMinor: number, kind: Account["kind"] = "person"): Account {
  return { id, vpa: `${id}@sim`, name: id.toUpperCase(), kind, createdAt: 0, balanceMinor };
}

function seed(store: Store, rows: [string, number][]): void {
  for (const [id, balanceMinor] of rows) store.accounts.upsert(mkAccount(id, balanceMinor));
}

function mkCase(id: string, victimAccountId: string, now: number): Case {
  return {
    id,
    reporterId: "op_1",
    victimAccountId,
    incidentStartTs: now - 1000,
    incidentEndTs: now,
    declaredLossMinor: 0,
    narrative: "unit-test complaint",
    stage: "VALIDATED",
    status: "VALIDATED",
    revision: 1,
    createdAt: now,
    updatedAt: now,
  };
}

function mkHold(id: string, accountId: string, caseId: string, type: AccountHold["type"], now: number): AccountHold {
  return {
    id,
    accountId,
    caseId,
    type,
    status: "ACTIVE",
    reason: "unit-test hold",
    actorId: "op_1",
    createdAt: now,
    releasedAt: null,
    releasedReason: null,
    releasedActorId: null,
  };
}

function count(store: Store, table: string, where = "1 = 1"): number {
  const r = store.db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get() as unknown as { c: number };
  return Number(r.c);
}

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

test("migrations apply from empty and report the expected head", () => {
  const r = initDb(":memory:");
  assert.equal(r.migrationsApplied, 6);
  assert.equal(r.head, 6);
});

test("ledger ordering is run-scoped so parallel runs cannot collide", () => {
  const { store } = initDb(":memory:");
  seed(store, [["a", 10000], ["b", 0], ["c", 10000]]);
  // Same timestamp and the same starting seq in two different runs must not
  // collide: uniqueness is (run_id, seq), not (ts, seq).
  const r1 = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_r1", runId: "run_1", fromId: "a", toId: "b", amountMinor: 100, ts: 5000, txnId: "tx_r1" }),
  );
  const r2 = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_r2", runId: "run_2", fromId: "c", toId: "b", amountMinor: 100, ts: 5000, txnId: "tx_r2" }),
  );
  assert.equal(r1.status, "ACCEPTED");
  assert.equal(r2.status, "ACCEPTED");
  assert.equal(store.accounts.getAccepted("tx_r1", "run_1")!.seq, 1);
  assert.equal(store.accounts.getAccepted("tx_r2", "run_2")!.seq, 1);
});

test("legacy rupee conversion is explicit and refuses sub-paise ambiguity", () => {
  assert.equal(rupeesToMinor(95), 9500);
  assert.equal(rupeesToMinor(0.5), 50);
  assert.equal(rupeesToMinor(10.05), 1005);
  assert.equal(rupeesToMinor(10.05, "floor"), 1005);
  // Sub-paise input is refused rather than silently rounded away.
  assert.throws(() => rupeesToMinor(10.005), /more than 2 decimal places/);
  assert.throws(() => rupeesToMinor(0.001), /more than 2 decimal places/);
  assert.equal(minorToInr(9950), "₹99.50");
  assert.equal(sumMinor([100, 250, 25]), 375);
});

test("admission rules are a pure decision with no side effects", () => {
  const from = mkAccount("a", 10000);
  const to = mkAccount("b", 0);

  assert.equal(decideAdmission({ from, to, amountMinor: 100, activeHoldId: null }).status, "ACCEPTED");
  assert.equal(decideAdmission({ from, to, amountMinor: 100, activeHoldId: "hold_1" }).rejectReason, "HOLD");
  assert.equal(decideAdmission({ from, to, amountMinor: 100_000, activeHoldId: null }).rejectReason, "INSUFFICIENT_FUNDS");
  assert.equal(decideAdmission({ from, to: from, amountMinor: 100, activeHoldId: null }).rejectReason, "SELF_TRANSFER");
  assert.equal(decideAdmission({ from, to, amountMinor: 0, activeHoldId: null }).rejectReason, "INVALID");
  assert.equal(decideAdmission({ from: null, to, amountMinor: 100, activeHoldId: null }).rejectReason, "INVALID");
  // A hold outranks the balance check: a held account is never silently debited.
  assert.equal(decideAdmission({ from: mkAccount("p", 10), to, amountMinor: 100, activeHoldId: "hold_1" }).rejectReason, "HOLD");
});

// ---------------------------------------------------------------------------
// Ledger round-trip, idempotency and rejection recording
// ---------------------------------------------------------------------------

test("an accepted transfer conserves money and lands in the ledger exactly once", () => {
  const { store } = initDb(":memory:");
  seed(store, [["a", 100000], ["b", 50000]]);
  const before = sumMinor([store.accounts.get("a")!.balanceMinor, store.accounts.get("b")!.balanceMinor]);

  const res = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_1", runId: "run_1", fromId: "a", toId: "b", amountMinor: 5000, ts: 1000, txnId: "tx_1" }),
  );

  assert.equal(res.status, "ACCEPTED");
  assert.equal(res.replayed, false);
  assert.equal(res.balanceAfterMinor, 95000);
  const a = store.accounts.get("a")!;
  const b = store.accounts.get("b")!;
  assert.equal(a.balanceMinor, 95000);
  assert.equal(b.balanceMinor, 55000);
  assert.equal(sumMinor([a.balanceMinor, b.balanceMinor]), before);

  const txn = store.accounts.getAccepted("tx_1", "run_1")!;
  assert.equal(txn.amountMinor, 5000);
  assert.equal(txn.seq, 1);
  assert.equal(txn.attemptId, "att_1");
  assert.equal(count(store, "payment_attempts"), 1);
  assert.equal(count(store, "accepted_transactions"), 1);
});

test("repeating an attempt id replays the first outcome and never moves money twice", () => {
  const { store } = initDb(":memory:");
  seed(store, [["a", 10000], ["b", 0]]);
  const req = { attemptId: "att_dup", runId: "run_1", fromId: "a", toId: "b", amountMinor: 2500, ts: 100, txnId: "tx_dup" };

  const first = serialTx(store, () => store.accounts.admit(req));
  const second = serialTx(store, () => store.accounts.admit(req));

  assert.equal(first.replayed, false);
  assert.equal(second.replayed, true);
  assert.equal(second.status, "ACCEPTED");
  assert.equal(second.txnId, "tx_dup");
  assert.equal(second.balanceAfterMinor, 7500);
  assert.equal(store.accounts.get("a")!.balanceMinor, 7500);
  assert.equal(store.accounts.get("b")!.balanceMinor, 2500);
  assert.equal(count(store, "payment_attempts"), 1);
  assert.equal(count(store, "accepted_transactions"), 1);
});

test("a rejected attempt is recorded with its reason and moves no money", () => {
  const { store } = initDb(":memory:");
  seed(store, [["poor", 100], ["dst", 0]]);
  const res = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_poor", runId: "run_1", fromId: "poor", toId: "dst", amountMinor: 999, ts: 10, txnId: "tx_poor" }),
  );
  assert.equal(res.status, "REJECTED");
  assert.equal(res.rejectReason, "INSUFFICIENT_FUNDS");
  assert.equal(res.txnId, null);
  assert.equal(store.accounts.get("poor")!.balanceMinor, 100);
  assert.equal(count(store, "payment_attempts", "status = 'REJECTED'"), 1);
  assert.equal(count(store, "accepted_transactions"), 0);

  // An attempt naming an unknown account is refused but still recorded, so the
  // audit trail keeps every observed attempt (including injected/malformed ones).
  const ghost = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_ghost", runId: "run_1", fromId: "nobody", toId: "dst", amountMinor: 10, ts: 11, txnId: "tx_ghost" }),
  );
  assert.equal(ghost.rejectReason, "INVALID");
  assert.equal(count(store, "payment_attempts"), 2);
});

test("trace reads return ledger order for equal timestamps and honour the cutoff", () => {
  const { store } = initDb(":memory:");
  seed(store, [["victim", 100000], ["a", 0], ["b", 0]]);
  const first = serialTx(store, () =>
    store.accounts.admit({ attemptId: "t_a", runId: "run_1", fromId: "victim", toId: "a", amountMinor: 1000, ts: 5000, txnId: "tx_a" }),
  );
  const second = serialTx(store, () =>
    store.accounts.admit({ attemptId: "t_b", runId: "run_1", fromId: "victim", toId: "b", amountMinor: 2000, ts: 5000, txnId: "tx_b" }),
  );
  assert.equal(first.status, "ACCEPTED");
  assert.equal(second.status, "ACCEPTED");

  const edges = store.accounts.listAccepted("victim", 0, -1, 10_000);
  assert.deepEqual(
    edges.map((e) => e.txnId),
    ["tx_a", "tx_b"],
  );
  assert.ok(edges[0].seq < edges[1].seq, "seq must break equal-timestamp ties");

  // The historical cutoff is part of the trace contract, not a UI detail.
  assert.equal(store.accounts.listAccepted("victim", 0, -1, 4999).length, 0);
  // Rejected attempts never appear as money-flow edges.
  assert.equal(store.accounts.listAccepted("poor", 0, -1, 10_000).length, 0);
});

// ---------------------------------------------------------------------------
// Holds — the enforcement primitive of the complaint workflow
// ---------------------------------------------------------------------------

test("a held account cannot debit, and each hold releases independently", () => {
  const { store } = initDb(":memory:");
  seed(store, [["victim", 100000], ["mule1", 5000], ["safe", 0]]);
  store.cases.insert(mkCase("case_1", "victim", 1000), []);
  store.cases.insert(mkCase("case_2", "victim", 1000), []);
  store.holds.insert(mkHold("hold_1", "mule1", "case_1", "MULE_DEBIT_FREEZE", 1000));
  store.holds.insert(mkHold("hold_2", "mule1", "case_2", "MULE_DEBIT_FREEZE", 2000));

  assert.equal(store.holds.listActiveForAccount("mule1").length, 2);
  assert.equal(store.accounts.firstActiveHoldId("mule1"), "hold_1");

  const blocked = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_blocked", runId: "run_1", fromId: "mule1", toId: "safe", amountMinor: 1000, ts: 3000, txnId: "tx_blocked" }),
  );
  assert.equal(blocked.status, "REJECTED");
  assert.equal(blocked.rejectReason, "HOLD");
  assert.equal(blocked.holdId, "hold_1");
  assert.equal(store.accounts.get("mule1")!.balanceMinor, 5000);

  // Releasing one case's hold must never remove another case's protection.
  store.holds.release("hold_1", 4000, "first case closed", "op_1");
  assert.equal(store.holds.get("hold_1")!.status, "RELEASED");
  assert.equal(store.accounts.firstActiveHoldId("mule1"), "hold_2");

  const stillBlocked = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_still_blocked", runId: "run_1", fromId: "mule1", toId: "safe", amountMinor: 1000, ts: 5000, txnId: "tx_still_blocked" }),
  );
  assert.equal(stillBlocked.rejectReason, "HOLD");
  assert.equal(stillBlocked.holdId, "hold_2");

  store.holds.release("hold_2", 6000, "cleared by operator", "op_1");
  const accepted = serialTx(store, () =>
    store.accounts.admit({ attemptId: "att_after_release", runId: "run_1", fromId: "mule1", toId: "safe", amountMinor: 1000, ts: 7000, txnId: "tx_after_release" }),
  );
  assert.equal(accepted.status, "ACCEPTED");

  // Blocked attempts are counted once per attempt id — retries never inflate.
  const blockedList = store.accounts.blockedAttemptsByHold(["mule1"]);
  assert.deepEqual(
    blockedList.map((b) => b.attemptId),
    ["att_blocked", "att_still_blocked"],
  );
  assert.equal(sumMinor(blockedList.map((b) => b.amountMinor)), 2000);
});

// ---------------------------------------------------------------------------
// Restart durability
// ---------------------------------------------------------------------------

test("cases, holds, balances and attempts survive a process restart", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnh-db-"));
  const file = path.join(dir, "restart.db");
  try {
    const first = initDb(file);
    assert.equal(first.migrationsApplied, 6);
    seed(first.store, [["victim", 50000], ["m1", 0]]);
    first.store.cases.insert(mkCase("case_r", "victim", 1000), []);
    first.store.holds.insert(mkHold("hold_r", "victim", "case_r", "VICTIM_PROTECTION", 1000));
    const r = serialTx(first.store, () =>
      first.store.accounts.admit({ attemptId: "att_r", runId: "run_r", fromId: "victim", toId: "m1", amountMinor: 100, ts: 100, txnId: "tx_r" }),
    );
    assert.equal(r.rejectReason, "HOLD");
    first.store.db.close();

    // Second process: migrations are already applied, state is still there.
    const second = initDb(file);
    assert.equal(second.migrationsApplied, 0);
    assert.equal(second.head, 6);
    assert.equal(second.store.accounts.firstActiveHoldId("victim"), "hold_r");
    assert.equal(second.store.holds.listForCase("case_r").length, 1);
    assert.equal(second.store.accounts.get("victim")!.balanceMinor, 50000);

    // The rejected attempt is still an idempotent replay, not a second charge.
    const replay = serialTx(second.store, () =>
      second.store.accounts.admit({ attemptId: "att_r", runId: "run_r", fromId: "victim", toId: "m1", amountMinor: 100, ts: 100, txnId: "tx_r" }),
    );
    assert.equal(replay.replayed, true);
    assert.equal(replay.rejectReason, "HOLD");
    assert.equal(count(second.store, "payment_attempts"), 1);
    second.store.db.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});



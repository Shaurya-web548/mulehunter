/**
 * U3 evidence — complaint intake and victim protection.
 *
 * Every test runs against the real `node:sqlite` driver: real migrations, real
 * transactions, real foreign keys. Nothing here is mocked.
 */
import test from "node:test";
import assert from "node:assert/strict";

import { initDb } from "../../lib/persistence/init.ts";
import { serialTx, type Store } from "../../lib/persistence/store.ts";
import {
  complaintPayloadHash,
  createCaseFromComplaint,
  getCaseDetail,
  normalizeComplaint,
  type ComplaintInput,
} from "../../lib/modules/cases/intake.ts";
import { DomainError } from "../../lib/contracts/types.ts";
import type { Account } from "../../lib/contracts/types.ts";

const NOW = 1_700_000_000_000;

function mkAccount(id: string, balanceMinor: number): Account {
  return { id, vpa: `${id}@sim`, name: id.toUpperCase(), kind: "person", createdAt: 0, balanceMinor };
}

function count(store: Store, table: string): number {
  const r = store.db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as unknown as { c: number };
  return Number(r.c);
}

/**
 * victim pays m1 (the disputed payment), m1 pays m2 (the onward hop a trace must
 * find later). Returns the two ledger txn ids.
 */
function fixture(): { store: Store; victimTxn: string; onwardTxn: string } {
  const { store } = initDb(":memory:");
  for (const [id, balance] of [["victim", 500_000], ["m1", 0], ["m2", 0], ["other", 100_000]] as [string, number][]) {
    store.accounts.upsert(mkAccount(id, balance));
  }
  serialTx(store, () =>
    store.accounts.admit({
      attemptId: "att_1", runId: "run_demo", fromId: "victim", toId: "m1",
      amountMinor: 250_000, ts: NOW - 60_000, txnId: "tx_1",
    }),
  );
  serialTx(store, () =>
    store.accounts.admit({
      attemptId: "att_2", runId: "run_demo", fromId: "m1", toId: "m2",
      amountMinor: 200_000, ts: NOW - 30_000, txnId: "tx_2",
    }),
  );
  return { store, victimTxn: "tx_1", onwardTxn: "tx_2" };
}

function complaint(f: { victimTxn: string }, overrides: Partial<ComplaintInput> = {}): ComplaintInput {
  return {
    victimAccountId: "victim",
    incidentStartTs: NOW - 10 * 60_000,
    incidentEndTs: NOW,
    disputedTxnIds: [f.victimTxn],
    narrative: "Fraudulent UPI debit I did not authorise.",
    declaredLossMinor: 250_000,
    actorId: "op_7",
    now: NOW,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Idempotency and atomicity
// ---------------------------------------------------------------------------

test("a retried complaint replays the first case instead of filing a second", () => {
  const f = fixture();
  const first = createCaseFromComplaint(f.store, complaint(f));
  assert.equal(first.replayed, false);
  assert.equal(first.case.stage, "VALIDATED");
  // every committed change (case created, victim hold) bumps the case version
  assert.equal(first.case.revision, f.store.cases.get(first.case.id)!.revision);
  assert.ok(first.case.revision >= 2);
  assert.equal(first.case.victimAccountId, "victim");
  assert.equal(first.victimHold?.type, "VICTIM_PROTECTION");
  assert.equal(first.victimHold?.status, "ACTIVE");
  assert.equal(first.victimHold?.caseId, first.case.id);
  assert.equal(count(f.store, "cases"), 1);
  assert.equal(count(f.store, "account_holds"), 1);

  // Same complaint again, no explicit key: it must not double-file.
  const replay = createCaseFromComplaint(f.store, complaint(f));
  assert.equal(replay.replayed, true);
  assert.equal(replay.case.id, first.case.id);
  assert.equal(replay.victimHold?.id, first.victimHold?.id);
  assert.equal(count(f.store, "cases"), 1);
  assert.equal(count(f.store, "account_holds"), 1);

  // An explicit key makes a deliberate second case possible, and it gets its own
  // hold rather than sharing the first one.
  const second = createCaseFromComplaint(f.store, complaint(f, { idempotencyKey: "complaint-2" }));
  assert.equal(second.replayed, false);
  assert.notEqual(second.case.id, first.case.id);
  assert.notEqual(second.victimHold?.id, first.victimHold?.id);
  assert.equal(count(f.store, "cases"), 2);
  assert.equal(count(f.store, "account_holds"), 2);
});

test("a complaint that cannot be validated writes nothing at all", () => {
  const f = fixture();

  const rejected: [Partial<ComplaintInput>, string][] = [
    [{ disputedTxnIds: ["tx_does_not_exist"] }, "UNKNOWN_DISPUTED_TRANSACTION"],
    // tx_1 exists, but m2 was not its sender — a case can only be filed by (or
    // for) an account the ledger shows paying.
    [{ victimAccountId: "m2" }, "VICTIM_NOT_SENDER"],
    [{ victimAccountId: "ghost" }, "UNKNOWN_VICTIM"],
    [{ narrative: "short" }, "INVALID_COMPLAINT"],
    [{ incidentEndTs: NOW - 999_999 }, "INVALID_COMPLAINT"],
    [{ disputedTxnIds: [] }, "NO_DISPUTED_TRANSACTIONS"],
    [{ declaredLossMinor: 12.5 }, "INVALID_COMPLAINT"],
  ];

  for (const [override, code] of rejected) {
    assert.throws(
      () => createCaseFromComplaint(f.store, complaint(f, override)),
      (err: unknown) => err instanceof DomainError && err.code === code,
      `expected ${code} for ${JSON.stringify(override)}`,
    );
    // The serialized write transaction rolled back completely.
    assert.equal(count(f.store, "cases"), 0, `no case should survive ${code}`);
    assert.equal(count(f.store, "account_holds"), 0, `no hold should survive ${code}`);
    assert.equal(count(f.store, "case_disputed_transactions"), 0, `no disputed row should survive ${code}`);
    assert.equal(count(f.store, "audit_events"), 0, `no audit row should survive ${code}`);
    assert.equal(count(f.store, "case_idempotency"), 0, `no idempotency row should survive ${code}`);
    assert.equal(f.store.accounts.get("victim")!.balanceMinor, 250_000, "no money may move");
  }
});

test("an explicit idempotency key cannot be reused for a different complaint", () => {
  const f = fixture();
  const first = createCaseFromComplaint(f.store, complaint(f, { idempotencyKey: "op-key-1" }));
  const replayed = createCaseFromComplaint(f.store, complaint(f, { idempotencyKey: "op-key-1" }));
  assert.equal(replayed.replayed, true);
  assert.equal(replayed.case.id, first.case.id);

  assert.throws(
    () => createCaseFromComplaint(f.store, complaint(f, { idempotencyKey: "op-key-1", declaredLossMinor: 1 })),
    (err: unknown) => err instanceof DomainError && err.code === "IDEMPOTENCY_CONFLICT" && err.status === 409,
  );
  // The conflict changed nothing.
  assert.equal(count(f.store, "cases"), 1);
  assert.equal(f.store.cases.get(first.case.id)!.declaredLossMinor, 250_000);
});

// ---------------------------------------------------------------------------
// Victim protection semantics
// ---------------------------------------------------------------------------

test("a victim hold blocks the victim's own debits but not credits into the account", () => {
  const f = fixture();
  const filed = createCaseFromComplaint(f.store, complaint(f));
  const holdId = filed.victimHold!.id;

  const blocked = serialTx(f.store, () =>
    f.store.accounts.admit({
      attemptId: "att_3", runId: "run_demo", fromId: "victim", toId: "m2",
      amountMinor: 1_000, ts: NOW, txnId: "tx_3",
    }),
  );
  assert.equal(blocked.status, "REJECTED");
  assert.equal(blocked.rejectReason, "HOLD");
  assert.equal(blocked.holdId, holdId);
  assert.equal(blocked.replayed, false);
  assert.equal(f.store.accounts.get("victim")!.balanceMinor, 250_000, "a rejected debit moves nothing");

  // A victim hold is a debit restriction, not a freeze: money may still arrive.
  const credit = serialTx(f.store, () =>
    f.store.accounts.admit({
      attemptId: "att_4", runId: "run_demo", fromId: "other", toId: "victim",
      amountMinor: 50_000, ts: NOW + 1_000, txnId: "tx_4",
    }),
  );
  assert.equal(credit.status, "ACCEPTED");
  assert.equal(f.store.accounts.get("victim")!.balanceMinor, 300_000);

  // The rejection is attributed to this case's hold, which is what an outcome
  // panel counts — not to the account in general.
  const blockedByHold = f.store.accounts.blockedAttemptsByHold(["victim"]);
  assert.deepEqual(blockedByHold.map((b) => b.holdId), [holdId]);
  assert.equal(blockedByHold[0].amountMinor, 1_000);

  // Releasing the hold is an explicit, reasoned act.
  f.store.holds.release(holdId, NOW + 2_000, "victim re-verified with the branch", "op_7");
  const allowed = serialTx(f.store, () =>
    f.store.accounts.admit({
      attemptId: "att_5", runId: "run_demo", fromId: "victim", toId: "m2",
      amountMinor: 1_000, ts: NOW + 3_000, txnId: "tx_5",
    }),
  );
  assert.equal(allowed.status, "ACCEPTED");
  assert.equal(f.store.accounts.get("victim")!.balanceMinor, 299_000);
  assert.equal(
    f.store.cases.get(filed.case.id)!.stage,
    "VALIDATED",
    "protecting the victim does not advance the investigation by itself",
  );
});

test("intake normalizes the complaint before it is hashed or stored", () => {
  const draft = normalizeComplaint({
    victimAccountId: "  victim  ",
    incidentStartTs: NOW - 1_000,
    incidentEndTs: NOW,
    disputedTxnIds: ["tx_1", "tx_1", " tx_2 "],
    narrative: "  Someone moved my money.  ",
  });
  assert.equal(draft.victimAccountId, "victim");
  assert.deepEqual(draft.disputedTxnIds, ["tx_1", "tx_2"], "duplicates collapse: (case_id, txn_id) is the key");
  assert.equal(draft.narrative, "Someone moved my money.");
  assert.equal(draft.declaredLossMinor, 0);
  assert.equal(draft.reporterId, "self_reported");
  assert.equal(draft.protectVictim, true);
  assert.equal(draft.idempotencyKey, null);

  // The hash is order-independent over the disputed set...
  assert.equal(
    complaintPayloadHash({ ...draft, disputedTxnIds: ["tx_1", "tx_2"] }),
    complaintPayloadHash({ ...draft, disputedTxnIds: ["tx_2", "tx_1"] }),
  );
  // ...but not independent of the money or of the victim.
  assert.notEqual(complaintPayloadHash(draft), complaintPayloadHash({ ...draft, declaredLossMinor: 1 }));
  assert.notEqual(complaintPayloadHash(draft), complaintPayloadHash({ ...draft, victimAccountId: "other" }));
});

test("the case keeps the ledger facts it was validated against, plus an audit trail", () => {
  const f = fixture();
  // A payment the victim did not send cannot be disputed by the victim: the
  // spec requires selected payments to belong to the victim.
  assert.throws(
    () => createCaseFromComplaint(f.store, complaint(f, { disputedTxnIds: [f.victimTxn, f.onwardTxn] })),
    (err: unknown) => err instanceof DomainError && err.code === "DISPUTED_TXN_NOT_OWNED" && err.status === 422,
  );
  assert.equal(count(f.store, "cases"), 0);

  const filed = createCaseFromComplaint(f.store, complaint(f));
  assert.equal(filed.disputed.length, 1);
  assert.equal(filed.victimHold!.reason.includes("₹2,500"), true, filed.victimHold!.reason);
  const disputed = f.store.cases.disputed(filed.case.id);
  assert.deepEqual(disputed.map((d) => [d.txnId, d.amountMinor, d.seq]), [["tx_1", 250_000, 1]]);

  const detail = getCaseDetail(f.store, filed.case.id)!;
  assert.equal(detail.case.id, filed.case.id);
  assert.equal(detail.holds.length, 1);
  assert.deepEqual(detail.audit.map((a) => a.action).sort(), ["CASE_CREATED", "VICTIM_HOLD_CREATED"]);
  const created = detail.audit.find((a) => a.action === "CASE_CREATED")!;
  assert.equal(created.actorId, "op_7");
  assert.equal(JSON.parse(created.detail).disputedPaymentTotalMinor, 250_000);
  // the audit rows and UI outbox rows committed together with the case
  assert.equal(count(f.store, "ui_outbox"), 2);
  assert.equal(getCaseDetail(f.store, "case_missing"), null);
});


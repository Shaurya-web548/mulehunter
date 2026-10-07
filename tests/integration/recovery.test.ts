/**
 * Victim fund recovery on real persistence with the real engine and the
 * deterministic demo scenario: block the mules → attribute the victim's money
 * → return it to the victim.
 */
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { initDb } from "../../lib/persistence/init.ts";
import { Engine } from "../../lib/engine/engine.ts";
import { ensureRun } from "../../lib/runtime.ts";
import { seedComplaintDemo } from "../../lib/modules/demo/scenario.ts";
import { createCaseFromComplaint, listDisputeCandidates } from "../../lib/modules/cases/intake.ts";
import { runTrace } from "../../lib/modules/tracing/job.ts";
import { runAnalysis } from "../../lib/modules/analysis/job.ts";
import { freezeCandidates } from "../../lib/modules/enforcement/freeze.ts";
import { computeAttribution } from "../../lib/modules/attribution/job.ts";
import { recoverFunds } from "../../lib/modules/recovery/recover.ts";
import { computeOutcome } from "../../lib/modules/outcomes/outcome.ts";
import { renderCaseReport } from "../../lib/modules/reports/report.ts";
import { DomainError } from "../../lib/contracts/types.ts";

const R = 100;
const code = (c: string) => (err: unknown) => err instanceof DomainError && err.code === c;

test("freeze the mules, then return the victim's attributed money — exactly, once, and only from frozen accounts", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnh-recovery-"));
  const { store } = initDb(path.join(dir, "r.db"));
  try {
    let now = Date.now();
    const engine = new Engine(store, { runId: ensureRun(store, now), baseTps: 30, autoStart: false, nPeople: 150, nMerchants: 8, now });
    const demo = seedComplaintDemo(engine, now, { cashOutDelaySec: 120 });
    const advance = (ms: number) => {
      const end = now + ms;
      while (now < end) {
        now += 250;
        engine.tick(now, 250);
      }
    };
    advance(12_000);
    const [V, A, B, C, D, E, F, G, H, I, J] = "VABCDEFGHIJ".split("").map((k) => demo.accounts[k]);
    const seed = listDisputeCandidates(store, V, now - 3600_000, now)[0];
    const c = createCaseFromComplaint(store, {
      victimAccountId: V,
      incidentStartTs: demo.seedAt - 60_000,
      incidentEndTs: now,
      disputedTxnIds: [seed.txnId],
      narrative: "KYC-desk impersonation; UPI collect approved.",
      declaredLossMinor: 2_40_000 * R,
      idempotencyKey: "recovery-case",
      now,
    }).case;

    // --- where is the victim's money before any freeze? (conserved, exact)
    const before = computeAttribution(store, c.id, now);
    const heldBy = (a: typeof before, id: string) => a.accounts.find((x) => x.accountId === id)?.heldMinor ?? 0;
    assert.equal(heldBy(before, A), 13_500 * R);
    assert.equal(heldBy(before, B), 1_000 * R);
    assert.equal(heldBy(before, C), 58_000 * R, "C keeps ₹2k and gets ₹56k back through the cycle");
    assert.equal(heldBy(before, E), 50_000 * R, "innocent E: ₹50k of its ₹70k balance is the victim's");
    assert.equal(before.accounts.find((x) => x.accountId === E)!.sharePct, 71.4);
    assert.equal(heldBy(before, G), 48_000 * R);
    assert.equal(heldBy(before, J), 52_000 * R);
    assert.equal(before.totals.cashedOutMinor, 9_000 * R, "B's two ATM withdrawals");
    assert.equal(before.totals.spentAtMerchantsMinor, 1_500 * R);
    const t = before.totals;
    assert.equal(t.heldInFrozenMinor + t.atRiskUnfrozenMinor + t.cashedOutMinor + t.spentAtMerchantsMinor + t.returnedToVictimMinor + t.recoveredMinor + t.dustMinor + t.untrackedMinor, 2_40_000 * R);
    assert.equal(t.recoverableNowMinor, 0, "nothing is recoverable until accounts are frozen");
    assert.throws(() => recoverFunds(store, { caseId: c.id, reason: "early recovery attempt", actionKey: "rec-early-1", actorId: "op", now }), code("NOTHING_TO_RECOVER"));

    // --- block the evidence-backed mules
    runTrace(store, { caseId: c.id, actorId: "op", now });
    const an = runAnalysis(store, { caseId: c.id, actorId: "op", now });
    freezeCandidates(store, { caseId: c.id, analysisRevision: an.run.revision, policy: "AUTO_DEMO", reason: "evidence reviewed r1", actionKey: "freeze-all-eligible", actorId: "op", now, autoEnabled: true });

    // queued cash-outs from the frozen mules are rejected — their money stays put
    advance(240_000);
    const frozenView = computeAttribution(store, c.id, now);
    assert.equal(frozenView.totals.recoverableNowMinor, (13_500 + 1_000 + 58_000 + 1_000 + 1_000) * R);
    // G was not frozen and cashed out; that money is gone and reported as such
    assert.equal(heldBy(frozenView, G), 3_000 * R);
    // B (₹9k before the freeze), unfrozen G (₹45k) and below-threshold D (₹3k) cashed out
    assert.equal(frozenView.totals.cashedOutMinor, (9_000 + 45_000 + 3_000) * R);

    // --- recovery: forged or non-frozen requests are refused
    assert.throws(() => recoverFunds(store, { caseId: c.id, accountIds: [E], reason: "try innocent account", actionKey: "rec-innocent", actorId: "op", now }), code("NOT_FROZEN"));
    const forged = store.accounts.admit({ attemptId: "forged-1", runId: engine.runId, fromId: A, toId: J, amountMinor: 100, ts: now, txnId: "forged-tx", recoveryForCase: c.id });
    assert.equal(forged.status, "REJECTED", "the gate only lets a recovery pay the case victim");

    const victimBefore = store.accounts.get(V)!.balanceMinor;
    const rec = recoverFunds(store, { caseId: c.id, reason: "Return attributed funds after freeze", actionKey: "rec-all-frozen", actorId: "op", now });
    assert.equal(rec.action.totalMinor, 74_500 * R);
    assert.equal(rec.transfers.length, 5);
    assert.equal(store.accounts.get(V)!.balanceMinor - victimBefore, 74_500 * R, "the victim's balance rose by exactly the recovered amount");
    for (const id of [A, B, C, H, I]) assert.equal(store.accounts.get(id)!.balanceMinor, 0, "frozen mules held only victim money");

    // idempotent replay; nothing left to recover afterwards; holds still block debits
    const replay = recoverFunds(store, { caseId: c.id, reason: "Return attributed funds after freeze", actionKey: "rec-all-frozen", actorId: "op", now });
    assert.equal(replay.replayed, true);
    assert.throws(() => recoverFunds(store, { caseId: c.id, reason: "second attempt", actionKey: "rec-second-1", actorId: "op", now }), code("NOTHING_TO_RECOVER"));
    assert.equal(store.accounts.admit({ attemptId: "after-rec", runId: engine.runId, fromId: C, toId: J, amountMinor: 1, ts: now, txnId: "after-rec-tx" }).rejectReason, "HOLD");

    // --- outcome, attribution and report agree
    const out = computeOutcome(store, c.id, now);
    assert.equal(out.recoveredOrRefundedMinor, 74_500 * R);
    assert.ok(out.labels.some((l) => l.startsWith("Recovered to victim")));
    const after = computeAttribution(store, c.id, now);
    assert.equal(after.totals.recoveredMinor, 74_500 * R);
    const ta = after.totals;
    assert.equal(ta.heldInFrozenMinor + ta.atRiskUnfrozenMinor + ta.cashedOutMinor + ta.spentAtMerchantsMinor + ta.returnedToVictimMinor + ta.recoveredMinor + ta.dustMinor + ta.untrackedMinor, 2_40_000 * R);
    assert.ok(renderCaseReport(store, c.id).markdown.includes("Recovered to victim"));
    // money is conserved across the whole run
    const cons = store.accounts.conservation(engine.runId);
    assert.equal(cons.balanceMinor, cons.openingMinor);
    void D;
    void F;
  } finally {
    store.db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

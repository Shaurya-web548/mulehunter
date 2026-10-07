/**
 * Complaint → containment journey on real persistence with the real engine.
 * Covers V2 acceptance scenarios 1–10 at the service layer.
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
import { seedComplaintDemo, type DemoScenario } from "../../lib/modules/demo/scenario.ts";
import { createCaseFromComplaint, listDisputeCandidates } from "../../lib/modules/cases/intake.ts";
import { runTrace, loadSnapshot } from "../../lib/modules/tracing/job.ts";
import { runAnalysis } from "../../lib/modules/analysis/job.ts";
import { freezeCandidates } from "../../lib/modules/enforcement/freeze.ts";
import { computeOutcome } from "../../lib/modules/outcomes/outcome.ts";
import { releaseHold } from "../../lib/modules/protection/holds.ts";
import { admitPayment } from "../../lib/modules/payments/admission.ts";
import { DomainError } from "../../lib/contracts/types.ts";
import { WINDOW_MS } from "../../lib/engine/graph.ts";

const R = 100;

interface World {
  store: Store;
  engine: Engine;
  demo: DemoScenario;
  now: number;
  file: string;
  dir: string;
}

function advance(w: World, ms: number) {
  const end = w.now + ms;
  while (w.now < end) {
    w.now += 250;
    w.engine.tick(w.now, 250);
  }
}

function setup(cashOutDelaySec = 300): World {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mnh-journey-"));
  const file = path.join(dir, "j.db");
  const { store } = initDb(file);
  const now = Date.now();
  const engine = new Engine(store, { runId: ensureRun(store, now), baseTps: 30, autoStart: false, nPeople: 150, nMerchants: 8, now });
  const demo = seedComplaintDemo(engine, now, { cashOutDelaySec });
  const w: World = { store, engine, demo, now, file, dir };
  advance(w, 12_000); // layering executes through the gate
  return w;
}

const ids = (w: World, keys: string) => keys.split("").map((k) => w.demo.accounts[k]);
const code = (c: string) => (err: unknown) => err instanceof DomainError && err.code === c;

function fileComplaint(w: World, key = "complaint-1") {
  const cands = listDisputeCandidates(w.store, w.demo.victimId, w.now - 3600_000, w.now);
  // intake only LISTS candidates; the reporter selects explicitly
  assert.equal(cands.length, 1);
  assert.equal(cands[0].amountMinor, 2_40_000 * R);
  return createCaseFromComplaint(w.store, {
    victimAccountId: w.demo.victimId,
    incidentStartTs: w.demo.seedAt - 60_000,
    incidentEndTs: w.now,
    disputedTxnIds: [cands[0].txnId],
    narrative: "Caller posing as bank KYC desk made me approve a UPI collect request.",
    declaredLossMinor: 2_50_000 * R,
    protectVictim: true,
    idempotencyKey: key,
    actorId: "operator:test",
    now: w.now,
  });
}

test("complaint → protect → trace (after the live window) → analyze → freeze → future debits rejected", () => {
  const w = setup();
  try {
    // --- history older than the live 90 s window --------------------------------
    advance(w, WINDOW_MS + 10_000);
    const [V, A, B, C, D, E, F, G, H, I, J, M] = ids(w, "VABCDEFGHIJM");
    assert.equal([...w.engine.graph.edges.values()].some((e) => e.from === V), false, "live graph has forgotten the seed");

    // --- report + protect ---------------------------------------------------------
    const filed = fileComplaint(w);
    assert.equal(filed.case.stage, "VALIDATED");
    assert.equal(filed.victimHold?.type, "VICTIM_PROTECTION");
    const victimDebit = admitPayment(w.store, { runId: w.engine.runId, fromId: V, toId: J, amountMinor: 1_000 * R, ts: w.now, channel: "MANUAL" });
    assert.equal(victimDebit.rejectReason, "HOLD", "future victim debit rejected");
    const credit = admitPayment(w.store, { runId: w.engine.runId, fromId: J, toId: V, amountMinor: 100 * R, ts: w.now, channel: "MANUAL" });
    assert.equal(credit.status, "ACCEPTED", "credits into the protected victim still land");

    // --- trace from retained history ----------------------------------------------
    const tr = runTrace(w.store, { caseId: filed.case.id, actorId: "operator:test", now: w.now, idempotencyKey: "trace-1" });
    const snap = tr.snapshot!;
    const nodeIds = new Set(snap.nodes.map((n) => n.id));
    for (const id of [A, B, C, D, E, F, G, H, I, J, M]) assert.ok(nodeIds.has(id), `traced ${id}`);
    assert.equal(snap.nodes.find((n) => n.id === M)!.role, "MERCHANT");
    assert.ok(snap.paths.some((p) => p.nodeIds.join(">") === [V, A, B, F, G].join(">")), "Victim → A → B → F → G chain");
    assert.ok(snap.cycles.some((c) => new Set(c.nodeIds).has(C) && new Set(c.nodeIds).has(H) && new Set(c.nodeIds).has(I)), "C→H→I→C cycle");
    assert.equal(snap.historyIncomplete, false);
    // idempotent retry returns the same revision
    const again = runTrace(w.store, { caseId: filed.case.id, actorId: "operator:test", now: w.now, idempotencyKey: "trace-1" });
    assert.equal(again.replayed, true);
    assert.equal(again.run.revision, tr.run.revision);

    // --- analysis -----------------------------------------------------------------
    const an = runAnalysis(w.store, { caseId: filed.case.id, actorId: "operator:test", now: w.now });
    const byId = new Map(an.candidates.map((c) => [c.accountId, c]));
    for (const id of [A, B, C, H, I]) assert.equal(byId.get(id)?.eligible, true, `eligible ${id}: ${JSON.stringify(byId.get(id))}`);
    for (const id of [D, F]) assert.equal(byId.get(id)?.exclusion, "BELOW_THRESHOLD", `below threshold ${id}`);
    for (const id of [E, J, G]) assert.equal(byId.get(id)?.exclusion, "NO_BEHAVIOURAL_EVIDENCE", `innocent/unevidenced ${id}`);
    assert.equal(byId.get(V)?.exclusion, "CASE_VICTIM");
    assert.equal(byId.get(V)?.suspectedMule, false, "the victim is never classified as a mule");
    assert.equal(byId.get(M)?.exclusion, "MERCHANT_OR_SINK");
    for (const f of an.findings) assert.ok(f.txnIds.length > 0, "every finding cites transactions");
    assert.ok(an.findings.some((f) => f.motif === "CIRCULAR"));
    assert.ok(an.findings.some((f) => f.motif === "FAN_OUT" && f.accountIds.includes(A)));
    assert.ok(an.findings.some((f) => f.motif === "VELOCITY"));
    assert.equal(w.store.cases.get(filed.case.id)!.stage, "UNDER_REVIEW");

    // --- enforcement: server-side eligibility --------------------------------------
    const base = { caseId: filed.case.id, analysisRevision: an.run.revision, policy: "MANUAL" as const, reason: "Reviewed trace evidence r1", actorId: "operator:test", now: w.now };
    assert.throws(() => freezeCandidates(w.store, { ...base, accountIds: [V], actionKey: "act-victim-1" }), code("NOT_ELIGIBLE"));
    assert.throws(() => freezeCandidates(w.store, { ...base, accountIds: [E], actionKey: "act-innocent-1" }), code("NOT_ELIGIBLE"));
    assert.throws(() => freezeCandidates(w.store, { ...base, policy: "AUTO_DEMO", actionKey: "act-auto-000", autoEnabled: false }), code("AUTO_POLICY_DISABLED"));
    const fr = freezeCandidates(w.store, { ...base, accountIds: [A, C], actionKey: "act-freeze-1" });
    assert.equal(fr.holds.length, 2);
    const replay = freezeCandidates(w.store, { ...base, accountIds: [C, A], actionKey: "act-freeze-1" });
    assert.equal(replay.replayed, true);
    assert.equal(replay.action.id, fr.action.id);
    assert.throws(() => freezeCandidates(w.store, { ...base, accountIds: [A, B], actionKey: "act-freeze-1" }), code("IDEMPOTENCY_CONFLICT"));
    // a rejected batch writes nothing
    assert.equal(w.store.holds.listForCase(filed.case.id).filter((h) => h.type === "MULE_DEBIT_FREEZE").length, 2);

    // --- queued cash-outs execute later: frozen ones are rejected -------------------
    advance(w, 300_000 + 120_000);
    const out = computeOutcome(w.store, filed.case.id, w.now);
    assert.equal(out.blocked.fromMuleHolds.count, 6, "A×2 + C×4 cash-outs rejected");
    assert.equal(out.blocked.fromMuleHolds.amountMinor, (2 * 10_000 + 4 * 14_000) * R);
    assert.equal(out.containment, "HOLDS_ACTIVE");
    assert.equal(out.recoveredOrRefundedMinor, 0, "nothing recovered until a recovery is executed");
    // A (₹13,500) and C (₹58,000) are frozen and hold only victim money (PROPORTIONAL model)
    assert.equal(out.caseAttributableHeldMinor, (13_500 + 58_000) * R);
    assert.equal(out.disputedPaymentTotalMinor, 2_40_000 * R);
    assert.equal(out.reportedLossMinor, 2_50_000 * R);
    const aBalance = w.store.accounts.get(A)!.balanceMinor;
    assert.equal(aBalance, 13_500 * R);
    const aAttempted = out.blocked.records.filter((r) => r.fromId === A).reduce((s, r) => s + r.amountMinor, 0);
    assert.ok(aAttempted > aBalance, "blocked attempted amount can exceed the held balance");
    assert.equal(out.heldBalanceMinor, aBalance + w.store.accounts.get(C)!.balanceMinor);
    // the unfrozen, unevidenced G cashed out — reported honestly, not hidden
    assert.equal(w.store.accounts.get(G)!.balanceMinor, 3_000 * R);
    // the innocent counterparty kept transacting
    assert.equal(w.store.accounts.get(E)!.balanceMinor, (20_000 + 50_000 - 2_000) * R);
    const cons = w.store.accounts.conservation(w.engine.runId);
    assert.equal(cons.balanceMinor, cons.openingMinor);

    // --- new analysis revision makes the old one stale -----------------------------
    const tr2 = runTrace(w.store, { caseId: filed.case.id, actorId: "operator:test", now: w.now });
    assert.equal(tr2.run.revision, 2);
    assert.ok(loadSnapshot(w.store, filed.case.id, 1), "revision 1 is immutable and still readable");
    const an2 = runAnalysis(w.store, { caseId: filed.case.id, actorId: "operator:test", now: w.now });
    assert.throws(() => freezeCandidates(w.store, { ...base, accountIds: [B], actionKey: "act-stale-01" }), code("STALE_ANALYSIS"));
    // G's cash-outs are now behavioural evidence in the new revision
    const g2 = an2.candidates.find((c) => c.accountId === G)!;
    assert.ok(g2.contributions.some((c) => c.feature === "VELOCITY"), JSON.stringify(g2));

    // --- no simulator truth in case outputs ----------------------------------------
    const blob = JSON.stringify({ snap, an, out, an2 });
    assert.ok(!/isMule|is_mule|scenarioId|scenario_id|demo_/.test(blob), "case outputs carry no ground truth");
    assert.equal("truth" in w.store, false);
  } finally {
    w.store.db.close();
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
});

test("two cases can hold one account; releasing one keeps it blocked; totals are not duplicated", () => {
  const w = setup(120);
  try {
    const [V, A] = ids(w, "VA");
    const c1 = fileComplaint(w, "complaint-a").case;
    runTrace(w.store, { caseId: c1.id, actorId: "op", now: w.now });
    const a1 = runAnalysis(w.store, { caseId: c1.id, actorId: "op", now: w.now });
    freezeCandidates(w.store, { caseId: c1.id, analysisRevision: a1.run.revision, policy: "MANUAL", accountIds: [A], reason: "case one evidence", actionKey: "c1-freeze-A", actorId: "op", now: w.now });

    // a separate (not merged) complaint about the same payment
    const c2res = createCaseFromComplaint(w.store, {
      victimAccountId: V,
      incidentStartTs: w.demo.seedAt - 60_000,
      incidentEndTs: w.now,
      disputedTxnIds: [w.store.cases.disputed(c1.id)[0].txnId],
      narrative: "Second report by the victim's family member.",
      idempotencyKey: "complaint-b",
      protectVictim: false,
      now: w.now,
    });
    assert.ok(c2res.warnings.some((x) => x.startsWith("similar_open_complaints")), "flagged, not merged");
    const c2 = c2res.case;
    runTrace(w.store, { caseId: c2.id, actorId: "op", now: w.now });
    const a2 = runAnalysis(w.store, { caseId: c2.id, actorId: "op", now: w.now });
    // the victim of case 1 is still excluded in case 2 (it is case 2's victim too)
    assert.equal(a2.candidates.find((c) => c.accountId === V)?.eligible, false);
    const f2 = freezeCandidates(w.store, { caseId: c2.id, analysisRevision: a2.run.revision, policy: "AUTO_DEMO", reason: "demo auto policy on eligible", actionKey: "c2-auto-all", actorId: "op", now: w.now, autoEnabled: true });
    assert.ok(f2.action.accountIds.includes(A));

    const h1 = w.store.holds.listForCase(c1.id).find((h) => h.accountId === A)!;
    const rel = releaseHold(w.store, { holdId: h1.id, reason: "case one reviewed", actorId: "op", now: w.now });
    assert.ok(rel.stillBlockedBy.some((h) => h.caseId === c2.id));

    advance(w, 180_000);
    const o1 = computeOutcome(w.store, c1.id, w.now);
    const o2 = computeOutcome(w.store, c2.id, w.now);
    // A's attempts happened after case 1 released its hold → only case 2 counts them
    const aIn1 = o1.blocked.records.filter((r) => r.fromId === A).length;
    const aIn2 = o2.blocked.records.filter((r) => r.fromId === A).length;
    assert.equal(aIn1, 0);
    assert.equal(aIn2, 2);
    assert.equal(o1.containment, "ALL_RELEASED");
    // each attempt row exists once globally
    const total = Number((w.store.db.prepare("SELECT COUNT(*) AS c FROM payment_attempts WHERE from_id = ? AND reject_reason = 'HOLD'").get(A) as { c: number }).c);
    assert.equal(total, 2);
  } finally {
    w.store.db.close();
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
});

test("restart: cases, holds, balances, trace/analysis evidence and outcomes survive", () => {
  const w = setup(60);
  try {
    const [A] = ids(w, "A");
    const c = fileComplaint(w, "complaint-r").case;
    const tr = runTrace(w.store, { caseId: c.id, actorId: "op", now: w.now });
    const an = runAnalysis(w.store, { caseId: c.id, actorId: "op", now: w.now });
    freezeCandidates(w.store, { caseId: c.id, analysisRevision: an.run.revision, policy: "MANUAL", accountIds: [A], reason: "freeze before restart", actionKey: "restart-freeze", actorId: "op", now: w.now });
    advance(w, 120_000);
    const before = computeOutcome(w.store, c.id, w.now);
    const hashBefore = w.store.tracing.getSnapshot(c.id, tr.run.revision)!.contentHash;
    const runId = w.engine.runId;
    w.store.db.close();

    const { store } = initDb(w.file);
    const engine = new Engine(store, { runId: ensureRun(store), baseTps: 0, autoStart: false });
    assert.equal(engine.runId, runId);
    assert.equal(store.cases.get(c.id)!.stage, "UNDER_REVIEW");
    assert.equal(store.tracing.getSnapshot(c.id, tr.run.revision)!.contentHash, hashBefore);
    assert.equal(store.analysis.latestRun(c.id)!.revision, an.run.revision);
    const after = computeOutcome(store, c.id, w.now);
    assert.deepEqual({ ...after, asOf: 0 }, { ...before, asOf: 0 });
    // a retried freeze after restart is a replay, not a second hold
    const replay = freezeCandidates(store, { caseId: c.id, analysisRevision: an.run.revision, policy: "MANUAL", accountIds: [A], reason: "freeze before restart", actionKey: "restart-freeze", actorId: "op", now: w.now });
    assert.equal(replay.replayed, true);
    assert.equal(store.holds.listForCase(c.id).filter((h) => h.type === "MULE_DEBIT_FREEZE").length, 1);
    // the hold still blocks after restart
    const blocked = admitPayment(store, { runId, fromId: A, toId: engine.sim.sinkId, amountMinor: 100, ts: w.now, channel: "MANUAL" });
    assert.equal(blocked.rejectReason, "HOLD");
    store.db.close();
  } finally {
    fs.rmSync(w.dir, { recursive: true, force: true });
  }
});

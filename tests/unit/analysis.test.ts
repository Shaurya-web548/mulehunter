/**
 * U5 evidence (pure) — explainable case scoring, exclusions and negative controls.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { analyzeCase, DEFAULT_ANALYSIS_CONFIG, type AccountContext } from "../../lib/modules/analysis/score.ts";
import type { LedgerEdge } from "../../lib/modules/tracing/trace.ts";

const R = 100;
const NOW = 1_800_000_000_000;
const OLD = NOW - 900 * 86_400_000;
const NEW = NOW - 2 * 86_400_000;
let s = 0;
const e = (id: string, from: string, to: string, rupees: number, ts: number): LedgerEdge => ({ txnId: id, fromId: from, toId: to, amountMinor: rupees * R, ts, seq: ++s });

function ctx(id: string, over: Partial<AccountContext>): AccountContext {
  return { id, kind: "person", createdAt: OLD, role: "TRACED", inflows: [], outflows: [], tracedInTxnIds: [], victimInOtherCases: [], sinkIds: new Set(["ATM"]), ...over };
}

const run = (accounts: AccountContext[], cycles: { nodeIds: string[]; txnIds: string[] }[] = []) =>
  analyzeCase({ accounts, cycles, now: NOW, config: DEFAULT_ANALYSIS_CONFIG });

test("velocity: rapid pass-through triggers; the same amounts at a normal pace do not (negative control)", () => {
  const fast = ctx("FAST", { createdAt: NEW, inflows: [e("in1", "V", "FAST", 50_000, NOW - 60_000)], outflows: [e("o1", "FAST", "X", 48_000, NOW - 50_000)], tracedInTxnIds: ["in1"] });
  const slow = ctx("SLOW", { createdAt: NEW, inflows: [e("in2", "V", "SLOW", 50_000, NOW - 3_600_000)], outflows: [e("o2", "SLOW", "X", 48_000, NOW - 1_800_000)], tracedInTxnIds: ["in2"] });
  const out = run([fast, slow]);
  const f = out.candidates.find((c) => c.accountId === "FAST")!;
  const sl = out.candidates.find((c) => c.accountId === "SLOW")!;
  assert.ok(f.contributions.some((c) => c.feature === "VELOCITY"));
  assert.ok(!sl.contributions.some((c) => c.feature === "VELOCITY"), "30 min dwell is not rapid");
  assert.equal(sl.riskScore, 0);
  assert.equal(sl.exclusion, "NO_BEHAVIOURAL_EVIDENCE");
  const vf = out.findings.find((x) => x.motif === "VELOCITY")!;
  assert.deepEqual(vf.txnIds, ["in1", "o1"], "finding cites the concrete transactions");
});

test("reachability alone scores zero and is never eligible", () => {
  const holder = ctx("HOLD", { inflows: [e("in", "A", "HOLD", 50_000, NOW - 60_000)], tracedInTxnIds: ["in"] });
  const c = run([holder]).candidates[0];
  assert.equal(c.riskScore, 0);
  assert.equal(c.suspectedMule, false);
  assert.equal(c.eligible, false);
  assert.ok(c.contributions.some((x) => x.feature === "REACHABILITY" && x.points === 0));
});

test("fan-out to many recipients soon after receipt is a finding; a new account adds a transparent bonus", () => {
  const outs = ["B", "C", "D", "E", "F"].map((to, i) => e(`f${i}`, "A", to, 40_000, NOW - 50_000 + i * 500));
  const a = ctx("A", { createdAt: NEW, inflows: [e("in", "V", "A", 2_10_000, NOW - 60_000)], outflows: outs, tracedInTxnIds: ["in"] });
  const c = run([a]).candidates[0];
  const feats = c.contributions.map((x) => x.feature);
  assert.ok(feats.includes("FAN_OUT"));
  assert.ok(feats.includes("NEW_ACCOUNT"));
  assert.equal(c.suspectedMule, true);
  assert.equal(c.eligible, true);
  assert.equal(c.riskScore, c.contributions.reduce((s2, x) => s2 + x.points, 0));
});

test("structuring: repeated just-under-₹10k transfers", () => {
  const ins = Array.from({ length: 5 }, (_, i) => e(`s${i}`, `S${i}`, "AGG", 9_500, NOW - 100_000 + i * 1000));
  const c = run([ctx("AGG", { inflows: ins, tracedInTxnIds: ["s0"] })]).candidates[0];
  assert.ok(c.contributions.some((x) => x.feature === "STRUCTURING"));
});

test("chronological cycle membership is a finding for every traced member", () => {
  const acc = ["C", "H", "I"].map((id) => ctx(id, { createdAt: NEW }));
  const out = run(acc, [{ nodeIds: ["C", "H", "I", "C"], txnIds: ["ch", "hi", "ic"] }]);
  const cyc = out.findings.filter((f) => f.motif === "CIRCULAR");
  assert.equal(cyc.length, 1);
  assert.deepEqual(cyc[0].accountIds.sort(), ["C", "H", "I"]);
  for (const c of out.candidates) assert.ok(c.contributions.some((x) => x.feature === "CIRCULAR"));
});

test("the case victim, merchants and sinks are excluded; a cross-case victim is a role conflict", () => {
  const busy = (id: string, role: AccountContext["role"], extra: Partial<AccountContext> = {}) => {
    const outs = ["B", "C", "D", "E", "F"].map((to, i) => e(`${id}f${i}`, id, to, 40_000, NOW - 50_000 + i * 500));
    return ctx(id, { role, createdAt: NEW, inflows: [e(`${id}in`, "V", id, 2_10_000, NOW - 60_000)], outflows: outs, tracedInTxnIds: [`${id}in`], ...extra });
  };
  const out = run([busy("VIC", "VICTIM"), busy("SHOP", "MERCHANT"), busy("OTHER", "TRACED", { victimInOtherCases: ["case_x"] })]);
  const by = new Map(out.candidates.map((c) => [c.accountId, c]));
  assert.equal(by.get("VIC")!.exclusion, "CASE_VICTIM");
  assert.equal(by.get("VIC")!.suspectedMule, false);
  assert.equal(by.get("VIC")!.riskScore, 0);
  assert.equal(by.get("SHOP")!.exclusion, "MERCHANT_OR_SINK");
  assert.equal(by.get("OTHER")!.exclusion, "ROLE_CONFLICT");
  assert.equal(by.get("OTHER")!.suspectedMule, true, "surfaced for review…");
  assert.equal(by.get("OTHER")!.eligible, false, "…but not eligible for automatic action");
});

test("analysis is deterministic for the same inputs", () => {
  const a = ctx("A", { createdAt: NEW, inflows: [e("x1", "V", "A", 50_000, NOW - 60_000)], outflows: [e("x2", "A", "B", 49_000, NOW - 55_000)], tracedInTxnIds: ["x1"] });
  assert.deepEqual(run([a]), run([a]));
});

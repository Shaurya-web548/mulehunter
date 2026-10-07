/**
 * U4 evidence (pure) — downstream trace semantics on seeded fixtures.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { DEFAULT_TRACE_CONFIG, traceDownstream, type LedgerEdge, type NodeKind, type TraceConfig } from "../../lib/modules/tracing/trace.ts";

const R = 100; // paise per rupee
let seq = 0;
function tx(id: string, fromId: string, toId: string, rupees: number, ts: number, s?: number): LedgerEdge {
  return { txnId: id, fromId, toId, amountMinor: rupees * R, ts, seq: s ?? ++seq };
}

function run(ledger: LedgerEdge[], seeds: string[], opts: { kinds?: Record<string, NodeKind>; cfg?: Partial<TraceConfig>; victim?: string } = {}) {
  const byId = new Map(ledger.map((e) => [e.txnId, e]));
  return traceDownstream({
    seeds: seeds.map((s) => byId.get(s)!),
    victimId: opts.victim ?? "V",
    kindOf: (id) => opts.kinds?.[id] ?? "person",
    outgoing: (acc, afterTs, afterSeq, untilTs, limit, minAmount) =>
      ledger
        .filter((e) => e.fromId === acc && (e.ts > afterTs || (e.ts === afterTs && e.seq > afterSeq)) && e.ts <= untilTs && e.amountMinor >= minAmount)
        .sort((a, b) => a.ts - b.ts || a.seq - b.seq)
        .slice(0, limit),
    config: { ...DEFAULT_TRACE_CONFIG, ...opts.cfg },
    clock: () => 0,
  });
}

test("linear chain Victim → A → B → C → D is traced hop by hop", () => {
  const L = [tx("s", "V", "A", 50_000, 1000), tx("ab", "A", "B", 49_000, 2000), tx("bc", "B", "C", 48_000, 3000), tx("cd", "C", "D", 47_000, 4000)];
  const r = run(L, ["s"]);
  assert.deepEqual(r.nodes.map((n) => [n.id, n.minHop]), [["V", 0], ["A", 1], ["B", 2], ["C", 3], ["D", 4]]);
  assert.deepEqual(r.paths.map((p) => p.nodeIds.join(">")), ["V>A>B>C>D"]);
  assert.equal(r.disputedTotalMinor, 50_000 * R);
  // observed downstream flow counts each hop's volume — it can exceed the
  // disputed amount and is NOT the victim's money
  assert.equal(r.observedDownstreamFlowMinor, (49_000 + 48_000 + 47_000) * R);
  assert.equal(r.truncated, false);
});

test("a payment made BEFORE the account received the money is not downstream", () => {
  const L = [tx("early", "A", "X", 5_000, 500), tx("s", "V", "A", 50_000, 1000), tx("late", "A", "B", 40_000, 1500)];
  const r = run(L, ["s"]);
  assert.ok(!r.edges.some((e) => e.txnId === "early"));
  assert.ok(r.edges.some((e) => e.txnId === "late"));
});

test("equal timestamps are ordered by ledger sequence", () => {
  // A pays B in the SAME millisecond it is paid, but earlier in the ledger:
  // that payment cannot carry the victim's transfer.
  const L = [tx("before", "A", "B", 10_000, 1000, 10), tx("s", "V", "A", 50_000, 1000, 11), tx("after", "A", "C", 10_000, 1000, 12)];
  const r = run(L, ["s"]);
  assert.deepEqual(r.edges.map((e) => e.txnId), ["s", "after"]);
});

test("fan-out: every qualifying branch is traced within budget", () => {
  const L = [tx("s", "V", "A", 60_000, 1000)];
  for (let i = 0; i < 6; i++) L.push(tx(`a${i}`, "A", `B${i}`, 9_000, 2000 + i));
  const r = run(L, ["s"]);
  assert.equal(r.nodes.filter((n) => n.minHop === 2).length, 6);
  assert.equal(r.paths.length, 6);
});

test("circular routing: A → B → C → A terminates and the cycle is reported", () => {
  const L = [
    tx("s", "V", "A", 80_000, 1000),
    tx("ab", "A", "B", 78_000, 2000),
    tx("bc", "B", "C", 76_000, 3000),
    tx("ca", "C", "A", 74_000, 4000),
    tx("ab2", "A", "B", 72_000, 5000),
    tx("bc2", "B", "C", 70_000, 6000),
    tx("ca2", "C", "A", 68_000, 7000),
  ];
  const r = run(L, ["s"], { cfg: { maxHops: 10 } });
  // the cycle-closing edges are kept even though A was already visited
  assert.ok(r.edges.some((e) => e.txnId === "ca"));
  assert.ok(r.edges.some((e) => e.txnId === "ca2"));
  assert.ok(r.cycles.length >= 1);
  assert.deepEqual(r.cycles[0].nodeIds, ["A", "B", "C", "A"]);
  assert.deepEqual(r.cycles[0].txnIds, ["ab", "bc", "ca"]);
  assert.equal(new Set(r.nodes.map((n) => n.id)).size, r.nodes.length, "nodes are unique");
});

test("a cycle back to the victim is recorded but the victim is never expanded", () => {
  const L = [tx("s", "V", "A", 10_000, 1000), tx("av", "A", "V", 9_000, 2000), tx("vx", "V", "X", 5_000, 3000)];
  const r = run(L, ["s"]);
  assert.ok(r.edges.some((e) => e.txnId === "av"));
  assert.ok(!r.edges.some((e) => e.txnId === "vx"), "the victim's own later payments are not traced");
  assert.equal(r.nodes.find((n) => n.id === "V")!.role, "VICTIM");
});

test("merchants and cash-out sinks are terminal; their settlements are not followed", () => {
  const L = [tx("s", "V", "A", 20_000, 1000), tx("am", "A", "M", 3_000, 2000), tx("mx", "M", "P", 3_000, 3000), tx("ak", "A", "K", 15_000, 2500)];
  const r = run(L, ["s"], { kinds: { M: "merchant", K: "sink" } });
  assert.equal(r.nodes.find((n) => n.id === "M")!.stopReason, "terminal_merchant");
  assert.equal(r.nodes.find((n) => n.id === "K")!.role, "SINK");
  assert.ok(!r.edges.some((e) => e.txnId === "mx"));
});

test("overlapping seeds deduplicate edges and keep provenance", () => {
  const L = [tx("s1", "V", "A", 10_000, 1000), tx("s2", "V", "B", 10_000, 1100), tx("ac", "A", "C", 9_000, 2000), tx("bc", "B", "C", 9_000, 2100), tx("cd", "C", "D", 17_000, 3000)];
  const r = run(L, ["s1", "s2"]);
  const cd = r.edges.filter((e) => e.txnId === "cd");
  assert.equal(cd.length, 1, "transaction appears once");
  assert.deepEqual([...cd[0].seedTxnIds].sort(), ["s1", "s2"]);
});

test("a later arrival over fewer hops is re-expanded so the hop budget cannot hide it", () => {
  // X is first reached at hop 3 (V→A→B→X) and later at hop 2 (V→C→X). With
  // maxHops=3, only the hop-2 arrival lets the trace follow X→Y.
  const L = [
    tx("s1", "V", "A", 10_000, 1000),
    tx("ab", "A", "B", 9_000, 1100),
    tx("bx", "B", "X", 8_000, 1200),
    tx("s2", "V", "C", 10_000, 1300),
    tx("cx", "C", "X", 9_000, 1400),
    tx("xy", "X", "Y", 15_000, 1500),
  ];
  const r = run(L, ["s1", "s2"], { cfg: { maxHops: 3 } });
  assert.ok(r.edges.some((e) => e.txnId === "xy"));
  assert.equal(r.nodes.find((n) => n.id === "X")!.minHop, 2);
});

test("a dense graph is bounded and every hit budget is reported", () => {
  const L = [tx("s", "V", "A0", 100_000, 1000)];
  let t = 2000;
  // 6 layers × fan-out 8 → far more than the budgets below
  let layer = ["A0"];
  for (let d = 1; d <= 6; d++) {
    const next: string[] = [];
    for (const from of layer) {
      for (let i = 0; i < 8; i++) {
        const to = `N${d}_${next.length}`;
        L.push(tx(`${from}-${to}`, from, to, 5_000, t++));
        next.push(to);
      }
    }
    layer = next;
  }
  const r = run(L, ["s"], { cfg: { maxNodes: 60, maxEdges: 80, maxPaths: 25, maxHops: 5 } });
  assert.ok(r.nodes.length <= 60);
  assert.ok(r.edges.length <= 80);
  assert.ok(r.paths.length <= 25);
  assert.equal(r.truncated, true);
  assert.equal(r.truncation.nodes || r.truncation.edges, true);
  assert.equal(r.truncation.paths, true);
});

test("the runtime budget stops the traversal and says so", () => {
  const L = [tx("s", "V", "A", 10_000, 1000), tx("ab", "A", "B", 9_000, 2000), tx("bc", "B", "C", 8_000, 3000)];
  let now = 0;
  const byId = new Map(L.map((e) => [e.txnId, e]));
  const r = traceDownstream({
    seeds: [byId.get("s")!],
    victimId: "V",
    kindOf: () => "person",
    outgoing: (acc, afterTs) => L.filter((e) => e.fromId === acc && e.ts > afterTs),
    config: { ...DEFAULT_TRACE_CONFIG, runtimeBudgetMs: 5 },
    clock: () => (now += 3),
  });
  assert.equal(r.truncation.runtime, true);
  assert.equal(r.truncated, true);
});

test("small everyday spends below the declared minimum are not followed", () => {
  const L = [tx("s", "V", "A", 50_000, 1000), tx("coffee", "A", "Q", 150, 1500), tx("big", "A", "B", 45_000, 1600)];
  const r = run(L, ["s"]);
  assert.ok(!r.edges.some((e) => e.txnId === "coffee"));
  assert.ok(r.edges.some((e) => e.txnId === "big"));
});

test("a later receipt extends the follow window (review finding: no silent gap)", () => {
  // X receives at t0 and again at t0+1h, then pays out at t0+2.5h. With a 2 h
  // window the payout is outside the first receipt's window but inside the
  // second's — it must be traced.
  const H = 3_600_000;
  const L = [tx("s", "V", "A", 50_000, 0), tx("ax1", "A", "X", 20_000, 1000), tx("ax2", "A", "X", 20_000, H), tx("xy", "X", "Y", 35_000, 2.5 * H)];
  const r = run(L, ["s"], { cfg: { maxHopDelayMs: 2 * H } });
  assert.ok(r.edges.some((e) => e.txnId === "xy"));
  // and nothing is read twice
  assert.equal(r.edges.filter((e) => e.txnId === "xy").length, 1);
});

test("many small payments cannot push a large onward payment past the per-account limit", () => {
  const L = [tx("s", "V", "A", 5_00_000, 1000)];
  for (let i = 0; i < 30; i++) L.push(tx(`small${i}`, "A", `S${i}`, 200, 1100 + i));
  L.push(tx("big", "A", "B", 4_00_000, 2000));
  const r = run(L, ["s"], { cfg: { maxOutPerNode: 10 } });
  assert.ok(r.edges.some((e) => e.txnId === "big"));
  assert.equal(r.truncation.fanOut, false);
});

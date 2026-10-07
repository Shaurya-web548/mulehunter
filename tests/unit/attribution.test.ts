/**
 * Victim-fund attribution (PROPORTIONAL) — pure unit tests on seeded ledgers.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { attributeVictimFunds, DEFAULT_ATTRIBUTION_CONFIG, type AccountKind, type LedgerTx } from "../../lib/modules/attribution/attribute.ts";

const R = 100;

/** In-memory ledger: opening balances + ordered transfers. */
function ledger(opening: Record<string, number>, txs: [string, string, string, number][], kinds: Record<string, AccountKind> = {}) {
  const list: LedgerTx[] = txs.map(([id, from, to, rupees], i) => ({ txnId: id, fromId: from, toId: to, amountMinor: rupees * R, seq: i + 1, ts: 1000 + i }));
  const finalBal = (id: string) => {
    let b = (opening[id] ?? 0) * R;
    for (const t of list) {
      if (t.fromId === id) b -= t.amountMinor;
      if (t.toId === id) b += t.amountMinor;
    }
    return b;
  };
  return {
    list,
    run(seedIds: string[], opts: { recoveries?: Map<string, string>; caseId?: string; cfg?: Partial<typeof DEFAULT_ATTRIBUTION_CONFIG> } = {}) {
      return attributeVictimFunds({
        seeds: list.filter((t) => seedIds.includes(t.txnId)),
        victimId: "V",
        kindOf: (id) => kinds[id] ?? "person",
        balanceBefore: (id, seq) => {
          let b = finalBal(id);
          for (const t of list) {
            if (t.seq < seq) continue;
            if (t.toId === id) b -= t.amountMinor;
            if (t.fromId === id) b += t.amountMinor;
          }
          return b;
        },
        events: (id, afterSeq, limit) => list.filter((t) => t.seq > afterSeq && (t.fromId === id || t.toId === id)).slice(0, limit),
        recoveries: opts.recoveries ?? new Map(),
        caseId: opts.caseId ?? "case_1",
        config: { ...DEFAULT_ATTRIBUTION_CONFIG, ...opts.cfg },
        clock: () => 0,
      });
    },
  };
}

const held = (r: ReturnType<ReturnType<typeof ledger>["run"]>, id: string) => r.accounts.find((a) => a.accountId === id)?.heldMinor ?? 0;
const conserved = (r: ReturnType<ReturnType<typeof ledger>["run"]>) =>
  r.heldMinor + r.cashedOutMinor + r.spentAtMerchantsMinor + r.returnedToVictimMinor + r.recoveredMinor + r.dustMinor + r.untrackedMinor;

test("linear chain: the victim's money is where it ends up, conserved exactly", () => {
  const L = ledger({ V: 5_00_000 }, [
    ["s", "V", "A", 2_40_000],
    ["ab", "A", "B", 2_00_000],
    ["bc", "B", "C", 1_50_000],
  ]);
  const r = L.run(["s"]);
  assert.equal(held(r, "A"), 40_000 * R);
  assert.equal(held(r, "B"), 50_000 * R);
  assert.equal(held(r, "C"), 1_50_000 * R);
  assert.equal(conserved(r), r.disputedMinor);
});

test("clean money in the account dilutes proportionally (pro-rata)", () => {
  // A already had ₹60k of its own; receives ₹40k from the victim (40 % victim
  // money) and pays out ₹50k → 40 % of it (₹20k) is the victim's.
  const L = ledger({ V: 1_00_000, A: 60_000 }, [
    ["s", "V", "A", 40_000],
    ["ax", "A", "X", 50_000],
  ]);
  const r = L.run(["s"]);
  assert.equal(held(r, "X"), 20_000 * R);
  assert.equal(held(r, "A"), 20_000 * R);
  assert.equal(r.accounts.find((a) => a.accountId === "A")!.balanceMinor, 50_000 * R);
  assert.equal(conserved(r), r.disputedMinor);
});

test("split, merge and cycle never double-count", () => {
  const L = ledger({ V: 3_00_000 }, [
    ["s", "V", "A", 1_00_000],
    ["ab", "A", "B", 50_000],
    ["ac", "A", "C", 50_000],
    ["bd", "B", "D", 50_000],
    ["cd", "C", "D", 50_000], // merge
    ["de", "D", "E", 90_000],
    ["ed", "E", "D", 90_000], // cycle back
    ["de2", "D", "E", 90_000],
  ]);
  const r = L.run(["s"]);
  assert.equal(conserved(r), r.disputedMinor);
  assert.equal(r.heldMinor, 1_00_000 * R, "all of it still sits in accounts");
  assert.equal(held(r, "E"), 90_000 * R);
  assert.equal(held(r, "D"), 10_000 * R);
});

test("cash-outs, merchant spends and money returned to the victim leave the held total", () => {
  const L = ledger(
    { V: 1_00_000 },
    [
      ["s", "V", "A", 1_00_000],
      ["atm", "A", "ATM", 30_000],
      ["shop", "A", "SHOP", 20_000],
      ["back", "A", "V", 10_000],
    ],
    { ATM: "sink", SHOP: "merchant" },
  );
  const r = L.run(["s"]);
  assert.equal(r.cashedOutMinor, 30_000 * R);
  assert.equal(r.spentAtMerchantsMinor, 20_000 * R);
  assert.equal(r.returnedToVictimMinor, 10_000 * R);
  assert.equal(held(r, "A"), 40_000 * R);
  assert.equal(conserved(r), r.disputedMinor);
});

test("payments made before the seed are irrelevant; later clean inflows dilute only later outflows", () => {
  const L = ledger({ V: 50_000, A: 10_000, P: 50_000 }, [
    ["pre", "A", "Q", 10_000], // A spends its own money first
    ["s", "V", "A", 50_000], // A now 100 % victim money
    ["pay", "P", "A", 50_000], // clean inflow → 50 %
    ["ax", "A", "X", 40_000], // 50 % of 40k = 20k victim share
  ]);
  const r = L.run(["s"]);
  assert.equal(held(r, "Q"), 0);
  assert.equal(held(r, "X"), 20_000 * R);
  assert.equal(held(r, "A"), 30_000 * R);
});

test("a recovery for this case removes victim money 1:1; another case's recovery takes that case's money first", () => {
  const L = ledger({ V: 1_00_000, V2: 1_00_000 }, [
    ["s1", "V", "M", 60_000],
    ["s2", "V2", "M", 40_000],
    ["rec1", "M", "V", 60_000], // recovery for case_1 (victim V)
  ]);
  const mine = L.run(["s1"], { recoveries: new Map([["rec1", "case_1"]]), caseId: "case_1" });
  assert.equal(mine.recoveredMinor, 60_000 * R);
  assert.equal(held(mine, "M"), 0);
  assert.equal(conserved(mine), mine.disputedMinor);
  // case 2's view: M held 40k of V2 money; case 1's recovery must not reduce it
  const L2 = ledger({ V: 1_00_000, V2: 1_00_000 }, [
    ["s1", "V", "M", 60_000],
    ["s2", "V2", "M", 40_000],
    ["rec1", "M", "V", 60_000],
  ]);
  const theirs = L2.run(["s2"], { recoveries: new Map([["rec1", "case_1"]]), caseId: "case_2" });
  assert.equal(held(theirs, "M"), 40_000 * R);
});

test("amounts below the dust threshold stop being tracked but stay accounted for", () => {
  const L = ledger({ V: 10_000, A: 9_99_000 }, [
    ["s", "V", "A", 1_000], // 0.1 % victim money
    ["ax", "A", "X", 500], // victim share ₹0.50 < ₹1 dust
  ]);
  const r = L.run(["s"]);
  assert.equal(r.dustMinor, 50);
  assert.equal(conserved(r), r.disputedMinor);
});

test("the account budget is reported and the remainder is counted as untracked", () => {
  const txs: [string, string, string, number][] = [["s", "V", "A0", 10_000]];
  for (let i = 0; i < 10; i++) txs.push([`t${i}`, `A${i}`, `A${i + 1}`, 10_000]);
  const r = ledger({ V: 10_000 }, txs).run(["s"], { cfg: { maxAccounts: 4 } });
  assert.equal(r.truncation.accounts, true);
  assert.equal(conserved(r), r.disputedMinor);
  assert.ok(r.untrackedMinor > 0);
});

/**
 * Deterministic complaint-demo fixture.
 *
 * Opens a fresh set of accounts and QUEUES every payment on the simulator's
 * scheduler, so each one is executed later by the engine through the normal
 * admission gate (holds and balances are checked at execution time). Nothing
 * here writes ledger rows directly. Amounts and offsets are fixed, so the
 * same trace/analysis outcome is reproduced every time.
 *
 * Money path (offsets in seconds after seeding, ₹):
 *   0.5   V → A 2,40,000                        ← the disputed payment
 *   3.0–4.6  A → B 60,000 · C 60,000 · D 55,000 · E 50,000 · M 1,500 (merchant)
 *   6.0   B → F 50,000;  6.5/7.0 B → ATM 4,500 ×2
 *   7.5   C → H 58,000;  9.0 H → I 57,000;  10.5 I → C 56,000   (cycle C→H→I→C)
 *   8.0   D → J 52,000
 *   10.0  F → G 48,000
 *   later (cashOutDelaySec +): A → ATM 10,000 ×2, C → ATM 14,000 ×4,
 *         D → ATM 3,000, G → ATM 15,000 ×3, E → merchant 2,000
 *
 * Intended analysis result (derived from evidence, not from labels):
 *   A, B, C, H, I — suspected mules (fan-out / velocity / cycle / cash-out)
 *   D, F          — velocity finding but below the suspect threshold
 *   G             — reachability only at complaint time (no behaviour yet)
 *   E, J          — innocent downstream counterparties (old accounts, hold funds)
 *   M             — merchant (terminal, not eligible)
 * Simulator truth labels (A,B,C,D,F,G,H,I) are written to `sim_truth` for
 * live evaluation only; no case API or analysis input can read them.
 */
import type { Engine } from "../../engine/engine.ts";
import { SimTruthRepository } from "../../persistence/repos/truth.ts";
import { serialTx } from "../../persistence/store.ts";

const R = 100; // paise per rupee
const DAY = 86_400_000;

export interface DemoScenario {
  scenarioId: string;
  victimId: string;
  victimVpa: string;
  seedAt: number;
  /** when the seed payment and the in-scenario layering are complete */
  layeringDoneAt: number;
  firstCashOutAt: number;
  accounts: Record<string, string>;
}

let demoSeq = 0;

export function seedComplaintDemo(engine: Engine, now: number, opts: { cashOutDelaySec?: number } = {}): DemoScenario {
  const sim = engine.sim;
  const store = engine.store;
  const truth = new SimTruthRepository(store.db);
  const n = `${(++demoSeq).toString(36)}${now.toString(36).slice(-4)}`;
  const delay = Math.max(30, Math.min(opts.cashOutDelaySec ?? 90, 1800)) * 1000;
  const scenarioId = `demo_${n}`;

  const acc: Record<string, string> = {};
  serialTx(store, () => {
    const open = (key: string, ageDays: number, openingRupees: number, vpa: string, kind: "person" | "merchant" = "person") => {
      acc[key] = sim.open(now - ageDays * DAY, kind, openingRupees * R, vpa.split("@")[0], vpa).id;
    };
    open("V", 2400, 6_00_000, `meera.iyer.${n}@oksbi`);
    open("A", 2, 0, `quickpay.${n}@ybl`);
    open("B", 1, 0, `rk.traders.${n}@paytm`);
    open("C", 3, 0, `sunil.k.${n}@ibl`);
    open("D", 2, 0, `deals4u.${n}@apl`);
    open("E", 1100, 20_000, `anil.mehta.${n}@okhdfcbank`);
    open("F", 200, 0, `f.rental.${n}@okaxis`);
    open("G", 1, 0, `cashpoint.${n}@ybl`);
    open("H", 2, 0, `h.loop.${n}@paytm`);
    open("I", 2, 0, `i.loop.${n}@ibl`);
    open("J", 700, 10_000, `jaya.nair.${n}@oksbi`);
    open("M", 3000, 50_000, `power.bill.${n}@okaxis`, "merchant");
    for (const k of ["A", "B", "C", "D", "F", "G", "H", "I"]) truth.label(acc[k], scenarioId, true);
  });

  const at = (sec: number) => Math.round(now + sec * 1000);
  const pay = (sec: number, from: string, to: string, rupees: number) => sim.schedule(at(sec), acc[from] ?? from, acc[to] ?? to, rupees * R, scenarioId);
  const sink = sim.sinkId;

  pay(0.5, "V", "A", 2_40_000);
  pay(3.0, "A", "B", 60_000);
  pay(3.4, "A", "C", 60_000);
  pay(3.8, "A", "D", 55_000);
  pay(4.2, "A", "E", 50_000);
  pay(4.6, "A", "M", 1_500);
  pay(6.0, "B", "F", 50_000);
  pay(6.5, "B", sink, 4_500);
  pay(7.0, "B", sink, 4_500);
  pay(7.5, "C", "H", 58_000);
  pay(8.0, "D", "J", 52_000);
  pay(9.0, "H", "I", 57_000);
  pay(10.0, "F", "G", 48_000);
  pay(10.5, "I", "C", 56_000);

  // queued future debits — executed (or rejected) by the gate at their time
  const d = delay / 1000;
  pay(d + 0, "A", sink, 10_000);
  pay(d + 30, "A", sink, 10_000); // A will only hold ₹13,500 → attempted > balance
  pay(d + 5, "C", sink, 14_000);
  pay(d + 35, "C", sink, 14_000);
  pay(d + 65, "C", sink, 14_000);
  pay(d + 95, "C", sink, 14_000);
  pay(d + 10, "D", sink, 3_000);
  pay(d + 15, "G", sink, 15_000);
  pay(d + 45, "G", sink, 15_000);
  pay(d + 75, "G", sink, 15_000);
  pay(d + 110, "E", "M", 2_000); // innocent everyday spend — never frozen

  const victim = store.accounts.get(acc.V)!;
  engine.pushAlert("info", "Complaint demo seeded", `Victim ${victim.vpa} will pay ₹2,40,000 in a moment; queued cash-outs start in ${Math.round(d)} s.`);
  return {
    scenarioId,
    victimId: acc.V,
    victimVpa: victim.vpa,
    seedAt: at(0.5),
    layeringDoneAt: at(10.5),
    firstCashOutAt: at(d),
    accounts: acc,
  };
}

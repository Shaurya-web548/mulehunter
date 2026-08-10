import type { Account, Pattern, Txn } from "./types";

// Synthetic UPI transaction generator. Produces a realistic base load of
// person↔person / person→merchant payments, plus injectable fraud scenarios:
//
//   fanout_layering — victim pays a scam account; the money is blasted down
//                     2 layers of mules and converges on cashout accounts
//   circular_routing — a closed loop of accounts cycles similar amounts to
//                      obscure the origin of funds
//   smurfing — many accounts send just-under-₹10k amounts to one aggregator
//
// Every scenario records its mule accounts as ground truth so detection
// quality (precision/recall) can be measured live. The detector never sees
// these labels.

const FIRST = ["rahul", "priya", "amit", "sneha", "vikram", "ananya", "rohan", "kavya", "arjun", "isha", "manish", "pooja", "sandeep", "neha", "kiran", "divya", "suresh", "meera", "aakash", "ritu"];
const LAST = ["sharma", "verma", "patel", "iyer", "reddy", "singh", "gupta", "nair", "das", "joshi", "kulkarni", "mehta", "bose", "rao", "malhotra"];
const BANKS = ["oksbi", "okhdfcbank", "okicici", "okaxis", "ybl", "paytm", "ibl", "apl"];
const MERCHANTS = ["swiggy", "zomato", "bigbasket", "jiomart", "irctc", "redbus", "bookmyshow", "flipkart", "meesho", "blinkit", "zepto", "phonepe.rech", "airtel.bill", "tataneu", "myntra"];

let seq = 0;
const uid = (p: string) => `${p}_${(++seq).toString(36)}${Math.random().toString(36).slice(2, 6)}`;

const rand = (a: number, b: number) => a + Math.random() * (b - a);
const randInt = (a: number, b: number) => Math.floor(rand(a, b + 1));
const pick = <T,>(arr: T[]): T => arr[Math.floor(Math.random() * arr.length)];

// Log-normal-ish everyday payment amount (₹20 – ₹6000, occasionally more)
function legitAmount(): number {
  const base = Math.exp(rand(3.2, 8.2));
  return Math.round(Math.min(base, 25000));
}

interface Scheduled {
  at: number;
  txn: Omit<Txn, "id" | "ts">;
}

export interface Scenario {
  id: string;
  pattern: Pattern;
  startedAt: number;
  muleIds: Set<string>;
  victimVpa: string;
  amount: number;
}

export class Simulator {
  accounts = new Map<string, Account>();
  scenarios: Scenario[] = [];
  private people: string[] = [];
  private merchants: string[] = [];
  private queue: Scheduled[] = [];
  readonly sinkId: string;
  baseTps = 600;

  // Population sized so base-load density stays realistic: at 600 TPS over
  // 12k accounts, a normal person touches ~3-4 txns per 90s window.
  constructor(now: number, nPeople = 12_000, nMerchants = 300) {
    for (let i = 0; i < nPeople; i++) {
      const acc = this.newAccount(now - rand(30, 2000) * 86400_000, "person", false);
      this.people.push(acc.id);
    }
    for (let i = 0; i < nMerchants; i++) {
      const name = MERCHANTS[i % MERCHANTS.length];
      const acc: Account = {
        id: uid("acc"),
        vpa: `${name}@${pick(BANKS)}`,
        name,
        createdAt: now - rand(200, 3000) * 86400_000,
        kind: "merchant",
        isMule: false,
        frozen: false,
      };
      this.accounts.set(acc.id, acc);
      this.merchants.push(acc.id);
    }
    const sink: Account = {
      id: uid("acc"),
      vpa: "cash@atm",
      name: "ATM / cash-out",
      createdAt: 0,
      kind: "sink",
      isMule: false,
      frozen: false,
    };
    this.accounts.set(sink.id, sink);
    this.sinkId = sink.id;
  }

  private newAccount(createdAt: number, kind: Account["kind"], isMule: boolean, scenarioId?: string): Account {
    const name = `${pick(FIRST)}.${pick(LAST)}`;
    const acc: Account = {
      id: uid("acc"),
      vpa: `${name}${randInt(1, 99)}@${pick(BANKS)}`,
      name,
      createdAt,
      kind,
      isMule,
      scenarioId,
      frozen: false,
    };
    this.accounts.set(acc.id, acc);
    return acc;
  }

  /** A mule account: usually freshly opened, sometimes an older rented account */
  private newMule(now: number, scenarioId: string): Account {
    const ageDays = Math.random() < 0.75 ? rand(0.2, 6) : rand(30, 400);
    return this.newAccount(now - ageDays * 86400_000, "person", true, scenarioId);
  }

  private schedule(at: number, from: string, to: string, amount: number, scenarioId?: string) {
    this.queue.push({ at, txn: { from, to, amount: Math.round(amount), scenarioId } });
  }

  launch(pattern: Pattern, now: number): Scenario {
    const id = uid("scn");
    const victim = pick(this.people);
    const muleIds = new Set<string>();
    let amount = 0;

    if (pattern === "fanout_layering") {
      amount = Math.round(rand(150_000, 480_000));
      const root = this.newMule(now, id);
      muleIds.add(root.id);
      this.schedule(now + 500, victim, root.id, amount, id);

      const l1 = Array.from({ length: randInt(5, 7) }, () => this.newMule(now, id));
      l1.forEach((m) => muleIds.add(m.id));
      let t = now + rand(2500, 4000);
      const shares = split(amount, l1.length);
      l1.forEach((m, i) => {
        this.schedule(t + i * rand(200, 600), root.id, m.id, shares[i], id);
      });

      const cashouts = Array.from({ length: randInt(2, 3) }, () => this.newMule(now, id));
      cashouts.forEach((m) => muleIds.add(m.id));
      l1.forEach((m, i) => {
        const l2s = Array.from({ length: randInt(2, 4) }, () => this.newMule(now, id));
        l2s.forEach((x) => muleIds.add(x.id));
        const sh = split(shares[i], l2s.length);
        let tt = t + rand(3000, 6000);
        l2s.forEach((x, j) => {
          this.schedule(tt + j * rand(150, 500), m.id, x.id, sh[j], id);
          // layer 2 forwards to a cashout account
          this.schedule(tt + rand(2500, 5000), x.id, pick(cashouts).id, sh[j] * rand(0.96, 1.0), id);
        });
      });
      // cashouts drain to ATM in chunks over a minute+ (ATM limits are real) —
      // freezing mid-drain intercepts everything still scheduled
      cashouts.forEach((c) => {
        let remaining = amount / cashouts.length;
        let tt = t + rand(9000, 12000);
        while (remaining > 4000) {
          const chunk = Math.min(remaining, rand(7000, 14000));
          this.schedule(tt, c.id, this.sinkId, chunk, id);
          remaining -= chunk;
          tt += rand(4000, 8000);
        }
      });
    }

    if (pattern === "circular_routing") {
      amount = Math.round(rand(80_000, 200_000));
      const loop = Array.from({ length: randInt(5, 7) }, () => this.newMule(now, id));
      loop.forEach((m) => muleIds.add(m.id));
      this.schedule(now + 500, victim, loop[0].id, amount, id);
      let t = now + 2500;
      const loops = 3;
      for (let r = 0; r < loops; r++) {
        for (let i = 0; i < loop.length; i++) {
          const from = loop[i].id;
          const to = loop[(i + 1) % loop.length].id;
          this.schedule(t, from, to, amount * rand(0.92, 0.99), id);
          t += rand(800, 1600);
        }
      }
      // exit to cash in chunks after the loops
      let remaining = amount * 0.9;
      let tt = t + 1000;
      while (remaining > 4000) {
        const chunk = Math.min(remaining, rand(8000, 15000));
        this.schedule(tt, loop[0].id, this.sinkId, chunk, id);
        remaining -= chunk;
        tt += rand(3500, 7000);
      }
    }

    if (pattern === "smurfing") {
      const senders = Array.from({ length: randInt(22, 32) }, () => this.newMule(now, id));
      const aggregator = this.newMule(now, id);
      const cashA = this.newMule(now, id);
      const cashB = this.newMule(now, id);
      [aggregator, cashA, cashB, ...senders].forEach((m) => muleIds.add(m.id));
      let t = now + 800;
      let total = 0;
      senders.forEach((s2) => {
        const amt = rand(9000, 9950); // just under the ₹10k reporting radar
        total += amt;
        this.schedule(t, s2.id, aggregator.id, amt, id);
        t += rand(250, 900);
      });
      amount = Math.round(total);
      this.schedule(t + 2000, aggregator.id, cashA.id, total * 0.55, id);
      this.schedule(t + 2600, aggregator.id, cashB.id, total * 0.43, id);
      for (const [cash, share] of [[cashA, 0.5], [cashB, 0.4]] as const) {
        let remaining = total * share;
        let tt = t + rand(6000, 8000);
        while (remaining > 4000) {
          const chunk = Math.min(remaining, rand(7000, 14000));
          this.schedule(tt, cash.id, this.sinkId, chunk, id);
          remaining -= chunk;
          tt += rand(4000, 8000);
        }
      }
    }

    const scenario: Scenario = {
      id,
      pattern,
      startedAt: now,
      muleIds,
      victimVpa: this.accounts.get(victim)!.vpa,
      amount,
    };
    this.scenarios.push(scenario);
    return scenario;
  }

  /**
   * Advance the clock: emit base-load txns plus any due scenario txns.
   * Outgoing txns from frozen accounts are dropped — the money the freeze
   * intercepted is credited to `onIntercept`.
   */
  pump(now: number, dtMs: number, onIntercept: (txn: Omit<Txn, "id" | "ts">) => void): Txn[] {
    const out: Txn[] = [];
    const n = Math.round((this.baseTps * dtMs) / 1000);
    for (let i = 0; i < n; i++) {
      const from = pick(this.people);
      const toMerchant = Math.random() < 0.62;
      const to = toMerchant ? pick(this.merchants) : pick(this.people);
      if (to === from) continue;
      out.push({ id: uid("tx"), ts: now - Math.random() * dtMs, from, to, amount: legitAmount() });
    }

    this.queue.sort((a, b) => a.at - b.at);
    while (this.queue.length && this.queue[0].at <= now) {
      const { txn } = this.queue.shift()!;
      if (this.accounts.get(txn.from)?.frozen) {
        onIntercept(txn);
        continue;
      }
      out.push({ id: uid("tx"), ts: now, ...txn });
    }
    return out;
  }
}

/** Split an amount into n uneven parts that sum to ~total */
function split(total: number, n: number): number[] {
  const weights = Array.from({ length: n }, () => rand(0.6, 1.4));
  const sum = weights.reduce((a, b) => a + b, 0);
  return weights.map((w) => Math.round((total * w) / sum));
}

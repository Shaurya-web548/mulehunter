/**
 * Victim-fund attribution — where is the victim's money NOW, per account?
 *
 * Policy PROPORTIONAL (pro-rata / "haircut"), a standard fund-tracing rule:
 *  - Each tracked account holds a balance of which some part is the victim's
 *    money ("tainted"). An account's pre-existing balance and every inflow
 *    not traceable to the victim are clean.
 *  - When a tracked account pays X, the victim's share of that payment is
 *    X × tainted / balance at that instant (ledger order), i.e. every
 *    outgoing rupee carries the same mix as the balance it left.
 *  - Clean inflows dilute; tainted inflows add taint.
 *
 * Every paisa of the disputed amount is conserved into exactly one bucket:
 *   held in an account · cashed out (ATM sink) · spent at a merchant ·
 *   returned to the victim · recovered for this case · dust (below the
 *   tracking threshold) · untracked (budget/history limits)
 * so nothing is double-counted across split, merge and cycle paths.
 *
 * Pure: the caller injects ledger reads. Events are processed in ledger
 * SEQUENCE order — the order in which balances actually changed.
 */

export const ATTRIBUTION_POLICY = "PROPORTIONAL/v1";

export type AccountKind = "person" | "merchant" | "sink";

export interface LedgerTx {
  txnId: string;
  fromId: string;
  toId: string;
  amountMinor: number;
  seq: number;
  ts: number;
}

export interface AttributionConfig {
  maxAccounts: number;
  maxEventsPerAccount: number;
  /** victim-share amounts below this are not tracked further (counted as dust) */
  dustMinor: number;
  runtimeBudgetMs: number;
}

export const DEFAULT_ATTRIBUTION_CONFIG: AttributionConfig = {
  maxAccounts: 500,
  maxEventsPerAccount: 5000,
  dustMinor: 100, // ₹1
  runtimeBudgetMs: 3000,
};

export interface AttributionInput {
  /** the disputed payments (victim → first recipient); each is fully the victim's money */
  seeds: LedgerTx[];
  victimId: string;
  kindOf: (accountId: string) => AccountKind;
  /** exact balance of the account immediately BEFORE ledger sequence `seq` */
  balanceBefore: (accountId: string, seq: number) => number;
  /** all accepted transfers into/out of the account with sequence > afterSeq, ordered by seq */
  events: (accountId: string, afterSeq: number, limit: number) => LedgerTx[];
  /** recovery transfers already made: txnId → case id they recovered for */
  recoveries: Map<string, string>;
  caseId: string;
  config: AttributionConfig;
  clock: () => number;
}

export interface AttributedAccount {
  accountId: string;
  kind: AccountKind;
  /** victim's money currently in this account (at the evaluation point) */
  heldMinor: number;
  /** account balance at the evaluation point */
  balanceMinor: number;
  receivedMinor: number;
  sentMinor: number;
  firstTaintedSeq: number;
  /** events not read because of the per-account budget */
  truncated: boolean;
}

export interface AttributionResult {
  policy: string;
  disputedMinor: number;
  accounts: AttributedAccount[];
  heldMinor: number;
  cashedOutMinor: number;
  spentAtMerchantsMinor: number;
  returnedToVictimMinor: number;
  recoveredMinor: number;
  dustMinor: number;
  untrackedMinor: number;
  /** victim-share flows between accounts, for display */
  flows: { txnId: string; fromId: string; toId: string; victimShareMinor: number; amountMinor: number; seq: number }[];
  truncated: boolean;
  truncation: { accounts: boolean; events: boolean; runtime: boolean };
}

interface State {
  bal: bigint;
  taint: bigint;
  received: bigint;
  sent: bigint;
  firstSeq: number;
  truncated: boolean;
}

/** Tiny binary min-heap of transactions by ledger sequence. */
class SeqHeap {
  private a: LedgerTx[] = [];
  get size() {
    return this.a.length;
  }
  push(x: LedgerTx) {
    const a = this.a;
    a.push(x);
    let i = a.length - 1;
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (a[p].seq <= a[i].seq) break;
      [a[i], a[p]] = [a[p], a[i]];
      i = p;
    }
  }
  pop(): LedgerTx | undefined {
    const a = this.a;
    if (!a.length) return undefined;
    const top = a[0];
    const last = a.pop()!;
    if (a.length) {
      a[0] = last;
      let i = 0;
      for (;;) {
        const l = 2 * i + 1;
        const r = l + 1;
        let m = i;
        if (l < a.length && a[l].seq < a[m].seq) m = l;
        if (r < a.length && a[r].seq < a[m].seq) m = r;
        if (m === i) break;
        [a[i], a[m]] = [a[m], a[i]];
        i = m;
      }
    }
    return top;
  }
}

export function attributeVictimFunds(input: AttributionInput): AttributionResult {
  const cfg = input.config;
  const t0 = input.clock();
  const state = new Map<string, State>();
  const kind = new Map<string, AccountKind>();
  const seen = new Set<string>();
  const heap = new SeqHeap();
  const flows: AttributionResult["flows"] = [];
  const trunc = { accounts: false, events: false, runtime: false };
  let cashedOut = 0n;
  let merchants = 0n;
  let returned = 0n;
  let recovered = 0n;
  let dust = 0n;
  let untracked = 0n;

  const kindOf = (id: string) => {
    let k = kind.get(id);
    if (!k) {
      k = input.kindOf(id);
      kind.set(id, k);
    }
    return k;
  };

  /** Start tracking an account that is about to receive victim money at `tx`. */
  const track = (id: string, tx: LedgerTx): State | null => {
    if (state.size >= cfg.maxAccounts) {
      trunc.accounts = true;
      return null;
    }
    const s: State = { bal: BigInt(input.balanceBefore(id, tx.seq)), taint: 0n, received: 0n, sent: 0n, firstSeq: tx.seq, truncated: false };
    state.set(id, s);
    const evs = input.events(id, tx.seq, cfg.maxEventsPerAccount + 1);
    if (evs.length > cfg.maxEventsPerAccount) {
      s.truncated = true;
      trunc.events = true;
      evs.length = cfg.maxEventsPerAccount;
    }
    for (const e of evs) if (!seen.has(e.txnId)) heap.push(e);
    return s;
  };

  /** Route a victim-share amount into its bucket or tracked account. */
  const deliver = (to: string, share: bigint, tx: LedgerTx) => {
    if (share <= 0n) return;
    if (to === input.victimId) {
      returned += share;
      return;
    }
    const k = kindOf(to);
    if (k === "sink") {
      cashedOut += share;
      return;
    }
    if (k === "merchant") {
      merchants += share;
      return;
    }
    let s = state.get(to);
    if (!s) {
      if (share < BigInt(cfg.dustMinor)) {
        dust += share;
        return;
      }
      s = track(to, tx) ?? undefined;
      if (!s) {
        untracked += share;
        return;
      }
    }
    s.taint += share;
    s.received += share;
  };

  // seeds: the disputed payments are entirely the victim's money
  const seeds = [...input.seeds].sort((a, b) => a.seq - b.seq);
  for (const sd of seeds) heap.push(sd);
  const seedIds = new Set(seeds.map((s) => s.txnId));

  while (heap.size) {
    if (input.clock() - t0 > cfg.runtimeBudgetMs) {
      trunc.runtime = true;
      break;
    }
    const tx = heap.pop()!;
    if (seen.has(tx.txnId)) continue;
    seen.add(tx.txnId);
    const amt = BigInt(tx.amountMinor);

    if (seedIds.has(tx.txnId)) {
      // balance of the recipient just before the seed, then + seed (all victim money)
      let s = state.get(tx.toId);
      if (!s && kindOf(tx.toId) === "person" && tx.toId !== input.victimId) s = track(tx.toId, tx) ?? undefined;
      if (s) {
        s.bal += amt;
        s.taint += amt;
        s.received += amt;
      } else deliver(tx.toId, amt, tx);
      continue;
    }

    const from = state.get(tx.fromId);
    const to = state.get(tx.toId);
    let share = 0n;
    if (from) {
      const recoveryCase = input.recoveries.get(tx.txnId);
      if (recoveryCase === input.caseId) {
        // a recovery for THIS case removes victim money 1:1
        share = amt < from.taint ? amt : from.taint;
      } else if (recoveryCase !== undefined) {
        // another case's recovery removes that case's (for us: clean) money first
        const clean = from.bal - from.taint;
        share = amt <= clean ? 0n : amt - clean;
      } else if (from.bal > 0n && from.taint > 0n) {
        share = (amt * from.taint) / from.bal; // floor; remainder stays in the account
      }
      if (share > from.taint) share = from.taint;
      from.taint -= share;
      from.bal -= amt;
      from.sent += share;
      if (from.bal < 0n) from.bal = 0n; // defensive: history outside the window
      if (from.taint > from.bal) {
        untracked += from.taint - from.bal;
        from.taint = from.bal;
      }
      if (share > 0n) {
        flows.push({ txnId: tx.txnId, fromId: tx.fromId, toId: tx.toId, victimShareMinor: Number(share), amountMinor: tx.amountMinor, seq: tx.seq });
        if (recoveryCase === input.caseId) {
          recovered += share;
          share = 0n;
        }
      }
    }
    if (to) {
      to.bal += amt; // clean part dilutes; the victim share is added below
      if (share > 0n) {
        to.taint += share;
        to.received += share;
      }
    } else if (share > 0n) {
      deliver(tx.toId, share, tx);
      const created = state.get(tx.toId);
      if (created) created.bal += amt; // balanceBefore excluded this payment
    }
  }

  // anything still queued when a budget stopped us is unaccounted for
  const accounts: AttributedAccount[] = [...state.entries()]
    .map(([id, s]) => ({
      accountId: id,
      kind: kindOf(id),
      heldMinor: Number(s.taint),
      balanceMinor: Number(s.bal),
      receivedMinor: Number(s.received),
      sentMinor: Number(s.sent),
      firstTaintedSeq: s.firstSeq,
      truncated: s.truncated,
    }))
    .sort((a, b) => b.heldMinor - a.heldMinor || a.firstTaintedSeq - b.firstTaintedSeq);

  const disputed = seeds.reduce((s, x) => s + BigInt(x.amountMinor), 0n);
  const held = accounts.reduce((s, a) => s + BigInt(a.heldMinor), 0n);
  // conservation: whatever is not in a bucket was lost to budget truncation
  const accounted = held + cashedOut + merchants + returned + recovered + dust + untracked;
  if (accounted < disputed) untracked += disputed - accounted;

  return {
    policy: ATTRIBUTION_POLICY,
    disputedMinor: Number(disputed),
    accounts,
    heldMinor: Number(held),
    cashedOutMinor: Number(cashedOut),
    spentAtMerchantsMinor: Number(merchants),
    returnedToVictimMinor: Number(returned),
    recoveredMinor: Number(recovered),
    dustMinor: Number(dust),
    untrackedMinor: Number(untracked),
    flows,
    truncated: trunc.accounts || trunc.events || trunc.runtime,
    truncation: trunc,
  };
}

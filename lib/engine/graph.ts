import type { Txn } from "./types.ts";

// Sliding-window transaction graph. Keeps ~90s of edges and per-account
// rolling stats — everything the detector needs, pruned continuously so
// memory stays bounded no matter how long the stream runs.

export const WINDOW_MS = 90_000;

export interface EdgeStat {
  from: string;
  to: string;
  amount: number;
  count: number;
  lastTs: number;
  stamps: { ts: number; amount: number }[];
}

export interface AccountWindow {
  id: string;
  inflow: { ts: number; amount: number; peer: string }[];
  outflow: { ts: number; amount: number; peer: string }[];
  lastTouched: number;
}

const edgeKey = (a: string, b: string) => `${a}>${b}`;

export class TxnGraph {
  edges = new Map<string, EdgeStat>();
  accounts = new Map<string, AccountWindow>();

  private win(id: string, ts: number): AccountWindow {
    let w = this.accounts.get(id);
    if (!w) {
      w = { id, inflow: [], outflow: [], lastTouched: ts };
      this.accounts.set(id, w);
    }
    w.lastTouched = Math.max(w.lastTouched, ts);
    return w;
  }

  add(txn: Txn) {
    const key = edgeKey(txn.from, txn.to);
    let e = this.edges.get(key);
    if (!e) {
      e = { from: txn.from, to: txn.to, amount: 0, count: 0, lastTs: 0, stamps: [] };
      this.edges.set(key, e);
    }
    e.amount += txn.amount;
    e.count += 1;
    e.lastTs = Math.max(e.lastTs, txn.ts);
    e.stamps.push({ ts: txn.ts, amount: txn.amount });

    this.win(txn.from, txn.ts).outflow.push({ ts: txn.ts, amount: txn.amount, peer: txn.to });
    this.win(txn.to, txn.ts).inflow.push({ ts: txn.ts, amount: txn.amount, peer: txn.from });
  }

  prune(now: number) {
    const cutoff = now - WINDOW_MS;
    for (const [key, e] of this.edges) {
      if (e.lastTs < cutoff) {
        this.edges.delete(key);
        continue;
      }
      while (e.stamps.length && e.stamps[0].ts < cutoff) {
        const s = e.stamps.shift()!;
        e.amount -= s.amount;
        e.count -= 1;
      }
      if (e.count <= 0) this.edges.delete(key);
    }
    for (const [id, w] of this.accounts) {
      w.inflow = w.inflow.filter((x) => x.ts >= cutoff);
      w.outflow = w.outflow.filter((x) => x.ts >= cutoff);
      if (!w.inflow.length && !w.outflow.length && w.lastTouched < cutoff) {
        this.accounts.delete(id);
      }
    }
  }

  /** Accounts with any activity in the window */
  active(): AccountWindow[] {
    return [...this.accounts.values()].filter((w) => w.inflow.length || w.outflow.length);
  }

  outEdges(id: string): EdgeStat[] {
    const out: EdgeStat[] = [];
    for (const e of this.edges.values()) if (e.from === id) out.push(e);
    return out;
  }
}

export function sum(xs: { amount: number }[]): number {
  let t = 0;
  for (const x of xs) t += x.amount;
  return t;
}

export function distinct(xs: { peer: string }[]): number {
  return new Set(xs.map((x) => x.peer)).size;
}

"use client";

import { useState } from "react";
import { dateTimeOf, inrMinor, timeOf } from "@/lib/client/format";
import { CaseGraph, type NodeStatus } from "./CaseGraph";
import type { TraceData } from "./types";

export function TracePanel({ trace, statusOf }: { trace: TraceData; statusOf: (id: string) => NodeStatus }) {
  const [path, setPath] = useState<string | null>(null);
  const [tab, setTab] = useState<"paths" | "transfers">("paths");
  const snap = trace.snapshot;
  if (!trace.run) return <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">Not traced yet. Run a trace to follow the disputed payment downstream through retained history.</p>;
  if (trace.run.status === "FAILED")
    return (
      <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm">
        Trace revision {trace.run.revision} failed: {trace.run.error}. Retry the trace — retries are idempotent.
      </p>
    );
  if (!snap) return <p className="p-4 text-sm text-muted">Trace revision {trace.run.revision} is {trace.run.status.toLowerCase()}…</p>;
  const vpa = new Map(snap.nodes.map((n) => [n.id, n.vpa]));
  const flags = Object.entries(snap.truncation).filter(([, v]) => v).map(([k]) => k);
  const selected = snap.paths.find((p) => p.id === path);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 font-mono text-[11px]">
        <span className="rounded bg-white/5 px-2 py-1">revision {snap.revision} of {trace.runs.length}</span>
        <span className="rounded bg-white/5 px-2 py-1">{snap.nodes.length} accounts · {snap.edges.length} transfers · {snap.paths.length} paths · {snap.cycles.length} cycles</span>
        <span className="rounded bg-white/5 px-2 py-1">cutoff {dateTimeOf(snap.cutoffTs)} (ledger seq ≤ {snap.cutoffSeq})</span>
        <span className="rounded bg-white/5 px-2 py-1">≤ {snap.config.maxHops} hops · onward ≥ {inrMinor(snap.config.minEdgeAmountMinor)} within {Math.round(snap.config.maxHopDelayMs / 60_000)} min</span>
        {snap.truncated ? <span className="rounded bg-amber/15 px-2 py-1 text-amber">TRUNCATED: {flags.join(", ")} — coverage is partial</span> : <span className="rounded bg-accent/10 px-2 py-1 text-accent">within all budgets</span>}
        {snap.historyIncomplete && <span className="rounded bg-amber/15 px-2 py-1 text-amber">HISTORY INCOMPLETE — part of the window was pruned before {dateTimeOf(snap.historyWatermark)}</span>}
      </div>
      <p className="text-xs text-muted">{snap.semantics} Observed downstream flow {inrMinor(snap.observedDownstreamFlowMinor)} counts traced edge volumes and can repeat the same money across hops.</p>
      <div className="glass rounded-2xl p-2">
        <CaseGraph snapshot={snap} statusOf={statusOf} highlightPath={selected?.txnIds ?? null} />
      </div>
      <div role="tablist" aria-label="Trace details" className="flex gap-1">
        {(["paths", "transfers"] as const).map((t) => (
          <button key={t} role="tab" aria-selected={tab === t} onClick={() => setTab(t)} className={`rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest ${tab === t ? "bg-white/10 text-ink" : "text-muted"}`}>
            {t === "paths" ? `Paths (${snap.paths.length})` : `Transfers (${snap.edges.length})`}
          </button>
        ))}
      </div>
      {tab === "paths" && (
        <div className="max-h-72 overflow-auto rounded-xl border border-line" role="tabpanel">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Money paths from the victim, in chronological order</caption>
            <thead className="sticky top-0 bg-panel font-mono text-[10px] uppercase tracking-widest text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">Path</th>
                <th scope="col" className="px-3 py-2">Hops</th>
                <th scope="col" className="px-3 py-2">Accounts</th>
              </tr>
            </thead>
            <tbody>
              {snap.paths.map((p) => (
                <tr key={p.id} className={`border-t border-line ${path === p.id ? "bg-accent/10" : ""}`}>
                  <td className="px-3 py-1.5">
                    <button onClick={() => setPath(path === p.id ? null : p.id)} aria-pressed={path === p.id} className="font-mono text-accent underline-offset-2 hover:underline">
                      {p.id}
                    </button>
                    {p.closesCycle && <span className="ml-1 text-amber">cycle</span>}
                  </td>
                  <td className="px-3 py-1.5 tabular-nums">{p.txnIds.length}</td>
                  <td className="px-3 py-1.5 font-mono">{p.nodeIds.map((id) => vpa.get(id) ?? id).join(" → ")}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {tab === "transfers" && (
        <div className="max-h-72 overflow-auto rounded-xl border border-line" role="tabpanel">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Traced accepted transfers</caption>
            <thead className="sticky top-0 bg-panel font-mono text-[10px] uppercase tracking-widest text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">Time</th>
                <th scope="col" className="px-3 py-2">Hop</th>
                <th scope="col" className="px-3 py-2">From</th>
                <th scope="col" className="px-3 py-2">To</th>
                <th scope="col" className="px-3 py-2">Amount</th>
                <th scope="col" className="px-3 py-2">Transaction</th>
              </tr>
            </thead>
            <tbody>
              {snap.edges.map((e) => (
                <tr key={e.txnId} className="border-t border-line">
                  <td className="px-3 py-1.5">{timeOf(e.ts)}</td>
                  <td className="px-3 py-1.5 tabular-nums">{e.hop}{e.isSeed && <span className="ml-1 text-danger">disputed</span>}</td>
                  <td className="px-3 py-1.5 font-mono">{vpa.get(e.fromId) ?? e.fromId}</td>
                  <td className="px-3 py-1.5 font-mono">{vpa.get(e.toId) ?? e.toId}</td>
                  <td className="px-3 py-1.5 tabular-nums">{inrMinor(e.amountMinor)}</td>
                  <td className="px-3 py-1.5 font-mono text-muted">{e.txnId}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

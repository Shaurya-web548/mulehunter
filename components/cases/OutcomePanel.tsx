"use client";

import { useState } from "react";
import { dateTimeOf, inrMinor, timeOf } from "@/lib/client/format";
import type { CaseViewData, OutcomeData } from "./types";

function Card({ label, value, note, tone }: { label: string; value: string; note: string; tone?: "frost" | "danger" | "accent" | "muted" }) {
  const c = tone === "frost" ? "text-frost" : tone === "danger" ? "text-danger" : tone === "accent" ? "text-accent" : tone === "muted" ? "text-muted" : "text-ink";
  return (
    <div className="glass rounded-xl px-4 py-3">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{label}</p>
      <p className={`font-(family-name:--font-display) text-lg font-bold tabular-nums ${c}`}>{value}</p>
      <p className="mt-0.5 text-[11px] leading-snug text-muted">{note}</p>
    </div>
  );
}

export function OutcomePanel({ outcome }: { outcome: OutcomeData }) {
  const b = outcome.blocked;
  return (
    <div className="space-y-3">
      {outcome.labels.length > 0 && (
        <ul className="flex flex-wrap gap-2" aria-label="Outcome status">
          {outcome.labels.map((l) => (
            <li key={l} className="rounded-full bg-frost/10 px-3 py-1 font-mono text-[11px] text-frost">
              {l}
            </li>
          ))}
        </ul>
      )}
      <div className="grid gap-2 sm:grid-cols-2 lg:grid-cols-4">
        <Card label="Reported loss" value={inrMinor(outcome.reportedLossMinor)} note="declared by the reporter, not validated" />
        <Card label="Disputed payment total" value={inrMinor(outcome.disputedPaymentTotalMinor)} note="unique accepted seed payments, validated against the ledger" />
        <Card label="Observed downstream flow" value={inrMinor(outcome.observedDownstreamFlowMinor)} note={outcome.observedFlowTraceRevision ? `trace r${outcome.observedFlowTraceRevision}; counts edge volume across hops — not loss or recovery` : "no completed trace"} tone="muted" />
        <Card label="Victim protection" value={outcome.victim.protected ? "Active" : "None"} note={outcome.victim.protected ? `since ${dateTimeOf(outcome.victim.protectedSince)}; credits still allowed` : "no active victim hold"} tone={outcome.victim.protected ? "frost" : "muted"} />
        <Card label="Mule accounts frozen" value={`${outcome.muleHolds.active}`} note={`${outcome.containment.replace(/_/g, " ").toLowerCase()}${outcome.muleHolds.released ? ` · ${outcome.muleHolds.released} released` : ""}`} tone={outcome.muleHolds.active ? "frost" : "muted"} />
        <Card label="Blocked debit attempts" value={`${b.uniqueAttemptCount}`} note={`${b.fromMuleHolds.count} from mule holds · ${b.fromVictimProtection.count} from victim protection · latest ${timeOf(b.latestAt)}`} tone={b.uniqueAttemptCount ? "danger" : "muted"} />
        <Card label="Blocked attempted amount" value={inrMinor(b.attemptedAmountMinor)} note="sum of unique rejected attempts — attempted, NOT recovered; can exceed the funds held" tone="danger" />
        <Card label="Held balance (frozen accounts)" value={inrMinor(outcome.heldBalanceMinor)} note="current ledger balance under active mule holds; may include unrelated funds" tone="frost" />
        <Card label="Victim money in frozen accounts" value={inrMinor(outcome.caseAttributableHeldMinor)} note="attributed with the proportional model; recoverable to the victim" tone="frost" />
        <Card label="Recovered to victim" value={inrMinor(outcome.recoveredOrRefundedMinor)} note="actual transfers back to the victim (simulated ledger)" tone={outcome.recoveredOrRefundedMinor ? "accent" : "muted"} />
      </div>
      <details className="rounded-xl border border-line p-3 text-xs text-muted">
        <summary className="cursor-pointer text-ink">How to read these numbers ({outcome.qualifications.length} notes)</summary>
        <ul className="mt-2 list-disc space-y-1 pl-5">
          {outcome.qualifications.map((q) => (
            <li key={q}>{q}</li>
          ))}
        </ul>
      </details>
      <div>
        <h3 className="mb-1 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Rejected payment attempts ({b.records.length})</h3>
        {b.records.length === 0 ? (
          <p className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-muted">No debit attempt has been rejected under this case&apos;s holds yet.</p>
        ) : (
          <div className="max-h-64 overflow-auto rounded-xl border border-line">
            <table className="w-full text-left text-xs">
              <caption className="sr-only">Rejected attempts</caption>
              <thead className="sticky top-0 bg-panel font-mono text-[10px] uppercase tracking-widest text-muted">
                <tr>
                  <th scope="col" className="px-3 py-2">Time</th>
                  <th scope="col" className="px-3 py-2">From</th>
                  <th scope="col" className="px-3 py-2">Attempted</th>
                  <th scope="col" className="px-3 py-2">Rejected by</th>
                  <th scope="col" className="px-3 py-2">Attempt id</th>
                </tr>
              </thead>
              <tbody>
                {b.records.map((r) => (
                  <tr key={r.attemptId} className="border-t border-line">
                    <td className="px-3 py-1.5">{timeOf(r.ts)}</td>
                    <td className="px-3 py-1.5 font-mono">{r.fromVpa}</td>
                    <td className="px-3 py-1.5 tabular-nums">{inrMinor(r.amountMinor)}</td>
                    <td className="px-3 py-1.5">{r.holdType === "MULE_DEBIT_FREEZE" ? "mule freeze" : "victim protection"}</td>
                    <td className="px-3 py-1.5 font-mono text-muted">{r.attemptId}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}

export function HoldsPanel({ holds, canAct, busy, onRelease }: { holds: CaseViewData["holds"]; canAct: boolean; busy: boolean; onRelease: (holdId: string, reason: string) => void }) {
  const [releasing, setReleasing] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  if (!holds.length) return <p className="text-xs text-muted">No holds for this case.</p>;
  return (
    <ul className="space-y-2">
      {holds.map((h) => (
        <li key={h.id} className={`rounded-xl border p-3 text-xs ${h.status === "ACTIVE" ? "border-frost/30 bg-frost/5" : "border-line"}`}>
          <div className="flex flex-wrap items-center gap-2">
            <span className={`font-mono text-[11px] font-bold ${h.type === "VICTIM_PROTECTION" ? "text-frost" : "text-danger"}`}>{h.type === "VICTIM_PROTECTION" ? "Victim protection" : "Mule debit freeze"}</span>
            <span className="font-mono">{h.account.vpa}</span>
            <span className={h.status === "ACTIVE" ? "text-accent" : "text-muted"}>{h.status.toLowerCase()}</span>
            <span className="text-muted">since {dateTimeOf(h.createdAt)} by {h.actorId}</span>
            {h.otherActiveHolds > 0 && <span className="text-amber">+{h.otherActiveHolds} other active hold(s) on this account</span>}
            {canAct && h.status === "ACTIVE" && (
              <button onClick={() => setReleasing(releasing === h.id ? null : h.id)} className="ml-auto rounded border border-line px-2 py-0.5 hover:border-accent/50">
                Release this hold…
              </button>
            )}
          </div>
          <p className="mt-1 text-muted">{h.reason}</p>
          {h.releasedAt && (
            <p className="mt-1 text-muted">
              Released {dateTimeOf(h.releasedAt)} by {h.releasedActorId}: {h.releasedReason}
            </p>
          )}
          {releasing === h.id && (
            <form
              className="mt-2 flex flex-wrap gap-2"
              onSubmit={(e) => {
                e.preventDefault();
                onRelease(h.id, reason);
                setReleasing(null);
                setReason("");
              }}
            >
              <label className="sr-only" htmlFor={`rel-${h.id}`}>
                Release reason
              </label>
              <input id={`rel-${h.id}`} value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} required placeholder="Reason (min 8 characters)" className="min-w-60 flex-1 rounded-lg border border-line bg-white/5 px-2 py-1 text-ink" />
              <button disabled={busy} className="rounded-lg border border-accent/50 px-3 py-1 text-accent disabled:opacity-40">
                Release only this hold
              </button>
            </form>
          )}
        </li>
      ))}
    </ul>
  );
}

export function AuditTimeline({ audit }: { audit: CaseViewData["audit"] }) {
  return (
    <ol className="space-y-1.5" aria-label="Audit trail">
      {audit.map((a) => (
        <li key={a.id} className="border-l-2 border-line pl-3 text-xs">
          <span className="font-mono text-[11px] text-ink">{a.action.replace(/_/g, " ").toLowerCase()}</span>
          <span className="text-muted"> · {dateTimeOf(a.createdAt)} · {a.actorId}</span>
        </li>
      ))}
    </ol>
  );
}

"use client";

import { useState } from "react";
import { inrMinor } from "@/lib/client/format";
import type { AnalysisData } from "./types";

const TABS = [
  { key: "accounts", label: "Accounts" },
  { key: "FAN_OUT", label: "Fan-out" },
  { key: "CIRCULAR", label: "Circular" },
  { key: "VELOCITY", label: "Velocity" },
  { key: "OTHER", label: "Fan-in · structuring · cash-out" },
] as const;

const EXCLUSION: Record<string, string> = {
  CASE_VICTIM: "case victim — never classified as a mule",
  MERCHANT_OR_SINK: "merchant / cash-out — not eligible",
  ROLE_CONFLICT: "victim in another case — review required",
  NO_BEHAVIOURAL_EVIDENCE: "reachability only — not evidence",
  BELOW_THRESHOLD: "below the suspect threshold",
};

export interface FreezeInput {
  accountIds: string[];
  reason: string;
  policy: "MANUAL" | "AUTO_DEMO";
}

export function AnalysisPanel({
  analysis,
  canAct,
  autoDemo,
  busy,
  onFreeze,
}: {
  analysis: AnalysisData;
  canAct: boolean;
  autoDemo: boolean;
  busy: boolean;
  onFreeze: (f: FreezeInput) => void;
}) {
  const [tab, setTab] = useState<(typeof TABS)[number]["key"]>("accounts");
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [reason, setReason] = useState("");
  const [open, setOpen] = useState<string | null>(null);
  if (!analysis.run) return <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">Not analyzed yet. Analysis reads the immutable trace revision and scores each traced account with explainable features.</p>;
  const run = analysis.run;
  const stale = analysis.latestRevision !== run.revision;
  const cands = analysis.candidates.filter((c) => c.role !== "SINK");
  const findings = tab === "accounts" ? [] : analysis.findings.filter((f) => (tab === "OTHER" ? ["FAN_IN", "STRUCTURING", "CASH_OUT"].includes(f.motif) : f.motif === tab));
  const selectable = cands.filter((c) => c.eligible && !c.caseHold);

  return (
    <div className="space-y-3">
      <div className="flex flex-wrap gap-2 font-mono text-[11px]">
        <span className="rounded bg-white/5 px-2 py-1">analysis r{run.revision} of trace r{run.traceRevision}</span>
        <span className="rounded bg-white/5 px-2 py-1">{run.detectorVersion} · {run.configVersion}</span>
        <span className="rounded bg-white/5 px-2 py-1">{run.summary.suspected} suspected · {run.summary.eligible} eligible · {run.summary.findings} findings</span>
        {stale && <span className="rounded bg-amber/15 px-2 py-1 text-amber">a newer analysis revision exists</span>}
      </div>
      <p className="text-xs text-muted">Risk scores are heuristic (0–100), not probabilities. “Suspected mule” is an algorithmic label that requires at least one behavioural finding; it does not establish guilt.</p>
      <div role="tablist" aria-label="Analysis" className="flex flex-wrap gap-1">
        {TABS.map((t) => (
          <button key={t.key} role="tab" aria-selected={tab === t.key} onClick={() => setTab(t.key)} className={`rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest ${tab === t.key ? "bg-white/10 text-ink" : "text-muted"}`}>
            {t.label}
          </button>
        ))}
      </div>

      {tab === "accounts" ? (
        <div className="overflow-x-auto rounded-xl border border-line" role="tabpanel">
          <table className="w-full text-left text-xs">
            <caption className="sr-only">Per-account risk scores</caption>
            <thead className="bg-white/3 font-mono text-[10px] uppercase tracking-widest text-muted">
              <tr>
                <th scope="col" className="px-3 py-2">Select</th>
                <th scope="col" className="px-3 py-2">Account</th>
                <th scope="col" className="px-3 py-2">Risk score</th>
                <th scope="col" className="px-3 py-2">Victim money here</th>
                <th scope="col" className="px-3 py-2">Assessment</th>
                <th scope="col" className="px-3 py-2">Why</th>
              </tr>
            </thead>
            <tbody>
              {cands.map((c) => (
                <tr key={c.accountId} className="border-t border-line align-top">
                  <td className="px-3 py-2">
                    {c.caseHold ? (
                      <span className="text-frost">frozen</span>
                    ) : c.eligible && canAct ? (
                      <input
                        type="checkbox"
                        aria-label={`Select ${c.vpa} for a simulated debit freeze`}
                        checked={picked.has(c.accountId)}
                        onChange={(e) =>
                          setPicked((s) => {
                            const n = new Set(s);
                            if (e.target.checked) n.add(c.accountId);
                            else n.delete(c.accountId);
                            return n;
                          })
                        }
                      />
                    ) : (
                      <span className="text-muted">—</span>
                    )}
                  </td>
                  <td className="px-3 py-2 font-mono">
                    {c.vpa}
                    <div className="text-[10px] text-muted">{c.role.toLowerCase()}</div>
                    {c.suspectedInOtherCases.length > 0 && <div className="text-[10px] text-amber">suspected in {c.suspectedInOtherCases.length} other case(s)</div>}
                  </td>
                  <td className="px-3 py-2">
                    <div className="flex items-center gap-2">
                      <span className="tabular-nums">{c.riskScore}</span>
                      <span className="h-1.5 w-16 rounded bg-white/10" aria-hidden>
                        <span className={`block h-1.5 rounded ${c.suspectedMule ? "bg-danger" : "bg-muted"}`} style={{ width: `${c.riskScore}%` }} />
                      </span>
                    </div>
                  </td>
                  <td className="px-3 py-2 tabular-nums">{c.victimMoneyMinor > 0 ? <span className={c.caseHold ? "text-frost" : "text-amber"}>{inrMinor(c.victimMoneyMinor)}</span> : <span className="text-muted">—</span>}</td>
                  <td className="px-3 py-2">
                    {c.suspectedMule ? <span className="font-semibold text-danger">suspected mule</span> : <span className="text-muted">not suspected</span>}
                    <div className="text-[10px] text-muted">{c.eligible ? "eligible for freeze" : (EXCLUSION[c.exclusion ?? ""] ?? "")}</div>
                  </td>
                  <td className="px-3 py-2">
                    <button onClick={() => setOpen(open === c.accountId ? null : c.accountId)} aria-expanded={open === c.accountId} className="text-accent underline-offset-2 hover:underline">
                      {c.contributions.filter((x) => x.points > 0).map((x) => `${x.feature} +${x.points}`).join(", ") || "explain"}
                    </button>
                    {open === c.accountId && (
                      <ul className="mt-1 space-y-0.5 text-[11px] text-muted">
                        {c.contributions.map((x, i) => (
                          <li key={i}>
                            <span className="font-mono text-ink">{x.feature}</span> {x.points > 0 ? `+${x.points}` : "0"} — {x.note}
                          </li>
                        ))}
                      </ul>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <ul className="space-y-2" role="tabpanel">
          {findings.length === 0 && <li className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-muted">No finding of this type in this revision.</li>}
          {findings.map((f) => (
            <li key={f.id} className="rounded-xl border border-line p-3 text-xs">
              <p className="font-mono text-[11px] text-ink">
                {f.motif} · +{f.points} · {f.accountVpas.join(", ")}
              </p>
              <p className="mt-1 text-muted">{f.explanation}</p>
              <p className="mt-1 break-all font-mono text-[10px] text-muted/80">evidence: {f.txnIds.join(", ")}</p>
            </li>
          ))}
        </ul>
      )}

      {canAct && !stale && (
        <div className="rounded-xl border border-danger/30 bg-danger/5 p-3">
          <p className="text-xs text-ink">
            <span className="font-semibold text-danger">Freeze selected accounts (simulated debit freeze).</span> Blocks further outgoing payments from each selected account at the admission gate; incoming credits still land; earlier transfers are not reversed. The server re-checks eligibility against analysis r{run.revision}.
          </p>
          <label className="mt-2 block text-xs text-muted">
            Reason (recorded on each hold and in the audit trail)
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 text-sm text-ink" placeholder="e.g. Reviewed fan-out and velocity evidence in r1" />
          </label>
          <div className="mt-2 flex flex-wrap gap-2">
            <button disabled={busy || picked.size === 0 || reason.trim().length < 8} onClick={() => onFreeze({ accountIds: [...picked], reason, policy: "MANUAL" })} className="rounded-lg bg-danger px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white disabled:opacity-40">
              Freeze {picked.size || ""} selected
            </button>
            {autoDemo && (
              <button disabled={busy || selectable.length === 0 || reason.trim().length < 8} onClick={() => onFreeze({ accountIds: [], reason, policy: "AUTO_DEMO" })} className="rounded-lg border border-danger/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-danger disabled:opacity-40">
                Demo auto-policy: freeze all {selectable.length} eligible
              </button>
            )}
          </div>
          {selectable.length === 0 && <p className="mt-2 text-xs text-muted">No unfrozen eligible account in this revision.</p>}
        </div>
      )}
    </div>
  );
}

"use client";

import { useState } from "react";
import { dateTimeOf, inrMinor } from "@/lib/client/format";
import type { CaseAttribution } from "@/lib/modules/attribution/job";
import type { RecoveryTransfer } from "@/lib/persistence/repos/recovery";

const BUCKETS: { key: keyof CaseAttribution["totals"]; label: string; color: string; note: string }[] = [
  { key: "recoveredMinor", label: "Recovered to victim", color: "#00e5a0", note: "returned by recovery transfers" },
  { key: "heldInFrozenMinor", label: "In frozen accounts", color: "#4cc9f0", note: "protected by a debit freeze — recoverable" },
  { key: "atRiskUnfrozenMinor", label: "In unfrozen accounts", color: "#ffb224", note: "can still move — freeze eligible mules; innocent recipients need a lien/legal process" },
  { key: "cashedOutMinor", label: "Cashed out", color: "#ff4d5e", note: "withdrawn at ATM/cash-out — gone" },
  { key: "spentAtMerchantsMinor", label: "Spent at merchants", color: "#8a8f98", note: "paid to merchants — chargeback route" },
  { key: "returnedToVictimMinor", label: "Returned by fraudsters", color: "#5eead4", note: "flowed back to the victim account" },
  { key: "untrackedMinor", label: "Untracked", color: "#3a3f45", note: "budget/history limits" },
  { key: "dustMinor", label: "Dust (< ₹1 shares)", color: "#2c3036", note: "too small to track" },
];

export function MoneyTrailPanel({
  attribution,
  transfers,
  canAct,
  busy,
  onRecover,
}: {
  attribution: CaseAttribution;
  transfers: RecoveryTransfer[];
  canAct: boolean;
  busy: boolean;
  onRecover: (reason: string) => void;
}) {
  const [reason, setReason] = useState("Return the victim's attributed funds from frozen mule accounts");
  const t = attribution.totals;
  const total = attribution.disputedMinor || 1;
  const vpa = new Map(attribution.accounts.map((a) => [a.accountId, a.vpa]));
  const rows = attribution.accounts.filter((a) => a.heldMinor > 0 || a.recoveredMinor > 0);

  return (
    <div className="space-y-3">
      <div className="grid gap-2 sm:grid-cols-3">
        <div className="glass rounded-xl px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Disputed (victim&apos;s money)</p>
          <p className="font-(family-name:--font-display) text-lg font-bold tabular-nums">{inrMinor(attribution.disputedMinor)}</p>
        </div>
        <div className="glass rounded-xl px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Recovered to victim</p>
          <p className="font-(family-name:--font-display) text-lg font-bold tabular-nums text-accent">{inrMinor(t.recoveredMinor)}</p>
          <p className="text-[11px] text-muted">{Math.round((t.recoveredMinor / total) * 1000) / 10}% of the disputed amount</p>
        </div>
        <div className="glass rounded-xl px-4 py-3">
          <p className="font-mono text-[10px] uppercase tracking-widest text-muted">Recoverable now</p>
          <p className="font-(family-name:--font-display) text-lg font-bold tabular-nums text-frost">{inrMinor(t.recoverableNowMinor)}</p>
          <p className="text-[11px] text-muted">victim money sitting in accounts this case has frozen</p>
        </div>
      </div>

      <div>
        <div className="flex h-4 w-full overflow-hidden rounded-full bg-white/5" role="img" aria-label="Where the victim's money is now">
          {BUCKETS.map((b) => {
            const v = t[b.key];
            return v > 0 ? <span key={b.key} style={{ width: `${(v / total) * 100}%`, background: b.color }} title={`${b.label}: ${inrMinor(v)}`} /> : null;
          })}
        </div>
        <ul className="mt-2 grid gap-x-4 gap-y-1 text-[11px] sm:grid-cols-2">
          {BUCKETS.map((b) => (
            <li key={b.key} className="flex items-start gap-2">
              <span className="mt-1 inline-block h-2 w-2 shrink-0 rounded-full" style={{ background: b.color }} aria-hidden />
              <span>
                <span className="text-ink">{b.label}</span> <span className="tabular-nums text-ink">{inrMinor(t[b.key])}</span> <span className="text-muted">— {b.note}</span>
              </span>
            </li>
          ))}
        </ul>
        {(attribution.truncated || attribution.historyIncomplete) && (
          <p className="mt-2 text-xs text-amber">{attribution.truncated ? "Attribution hit a budget — some money is untracked. " : ""}{attribution.historyIncomplete ? "Part of the history was pruned or missing." : ""}</p>
        )}
      </div>

      {canAct && (
        <div className="rounded-xl border border-accent/30 bg-accent/5 p-3">
          <p className="text-xs text-ink">
            <span className="font-semibold text-accent">Recover funds to the victim (simulated refund).</span> Transfers only the victim&apos;s attributed money — never the account holder&apos;s own funds — from accounts this case has frozen, back to the victim, as audited ledger transfers. Freeze more eligible accounts first to protect money that is still in unfrozen accounts.
          </p>
          <label className="mt-2 block text-xs text-muted">
            Reason (recorded in the audit trail)
            <input value={reason} onChange={(e) => setReason(e.target.value)} minLength={8} className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 text-sm text-ink" />
          </label>
          <button
            disabled={busy || t.recoverableNowMinor <= 0 || reason.trim().length < 8}
            onClick={() => onRecover(reason)}
            className="mt-2 rounded-lg bg-accent px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider text-void disabled:opacity-40"
          >
            Recover {inrMinor(t.recoverableNowMinor)} to victim
          </button>
          {t.recoverableNowMinor <= 0 && <p className="mt-1 text-[11px] text-muted">Nothing is recoverable right now — no frozen account holds victim money.</p>}
        </div>
      )}

      <div className="overflow-x-auto rounded-xl border border-line">
        <table className="w-full text-left text-xs">
          <caption className="sr-only">Accounts holding the victim&apos;s money</caption>
          <thead className="bg-white/3 font-mono text-[10px] uppercase tracking-widest text-muted">
            <tr>
              <th scope="col" className="px-3 py-2">Account</th>
              <th scope="col" className="px-3 py-2">Victim money now</th>
              <th scope="col" className="px-3 py-2">Account balance</th>
              <th scope="col" className="px-3 py-2">Victim share</th>
              <th scope="col" className="px-3 py-2">Status</th>
              <th scope="col" className="px-3 py-2">Recovered</th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 && (
              <tr>
                <td colSpan={6} className="px-3 py-4 text-center text-muted">
                  No account currently holds the victim&apos;s money.
                </td>
              </tr>
            )}
            {rows.map((a) => (
              <tr key={a.accountId} className="border-t border-line">
                <td className="px-3 py-1.5 font-mono">{a.vpa}</td>
                <td className="px-3 py-1.5 tabular-nums font-semibold text-ink">{inrMinor(a.heldMinor)}</td>
                <td className="px-3 py-1.5 tabular-nums">{inrMinor(a.balanceMinor)}</td>
                <td className="px-3 py-1.5 tabular-nums">{a.sharePct}%</td>
                <td className="px-3 py-1.5">{a.frozenByCase ? <span className="text-frost">frozen · recoverable {inrMinor(a.recoverableNowMinor)}</span> : <span className="text-amber">not frozen — at risk</span>}</td>
                <td className="px-3 py-1.5 tabular-nums text-accent">{a.recoveredMinor ? inrMinor(a.recoveredMinor) : "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {transfers.length > 0 && (
        <div>
          <h3 className="mb-1 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Recovery transfers ({transfers.length})</h3>
          <ul className="space-y-1 text-xs">
            {transfers.map((r) => (
              <li key={r.id} className="font-mono">
                {dateTimeOf(r.createdAt)} · {vpa.get(r.accountId) ?? r.accountId} → victim · <span className="text-accent">{inrMinor(r.amountMinor)}</span> <span className="text-muted">(attributed {inrMinor(r.attributedBeforeMinor)} of balance {inrMinor(r.balanceBeforeMinor)}) · {r.txnId}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
      <details className="text-xs text-muted">
        <summary className="cursor-pointer text-ink">How is this computed? ({attribution.policy})</summary>
        <p className="mt-1">{attribution.method}</p>
      </details>
    </div>
  );
}

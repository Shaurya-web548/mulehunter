/**
 * Deterministic, evidence-based case report (no external API, no LLM).
 *
 * Rendered only from persisted evidence: the case, its disputed payments, the
 * latest immutable trace and analysis revisions, holds, enforcement actions,
 * the outcome accounting (with its qualifications) and the audit trail. The
 * same committed state renders the same bytes. `exportReport` stores an
 * immutable, content-hashed snapshot.
 */
import crypto from "node:crypto";
import { DomainError } from "../../contracts/types.ts";
import { minorToInrFull } from "../../contracts/money.ts";
import { uid } from "../../persistence/repos/shared.ts";
import { serialTx, type Store } from "../../persistence/store.ts";
import type { StoredReport } from "../../persistence/repos/runtime.ts";
import { recordCaseEvent } from "../audit/events.ts";
import { loadSnapshot } from "../tracing/job.ts";
import { computeOutcome } from "../outcomes/outcome.ts";
import { computeAttribution } from "../attribution/job.ts";
import { exclusionNote, type Exclusion } from "../analysis/score.ts";

export const REPORT_VERSION = "case-report/v1";

const iso = (ms: number | null | undefined) => (ms ? new Date(ms).toISOString() : "—");
const inr = (m: number | null | undefined) => (m === null || m === undefined ? "unavailable" : minorToInrFull(m));

export interface RenderedReport {
  version: string;
  caseId: string;
  asOf: number;
  markdown: string;
  contentHash: string;
}

export function renderCaseReport(store: Store, caseId: string): RenderedReport {
  const c = store.cases.get(caseId);
  if (!c) throw new DomainError("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  const vpa = (id: string) => store.accounts.get(id)?.vpa ?? id;
  const disputed = store.cases.disputed(caseId);
  const holds = store.holds.listForCase(caseId);
  const trace = store.tracing.latestDone(caseId);
  const snap = trace ? loadSnapshot(store, caseId, trace.revision) : null;
  const analysis = store.analysis.latestRun(caseId);
  const candidates = analysis ? store.analysis.listCandidates(caseId, analysis.revision) : [];
  const findings = analysis ? store.analysis.listFindings(caseId, analysis.revision) : [];
  const actions = store.enforcement.listForCase(caseId);
  const audit = [...store.audit.list(caseId, 500)].reverse();
  const asOf = c.updatedAt;
  const outcome = computeOutcome(store, caseId, asOf);
  const attribution = computeAttribution(store, caseId, asOf);
  const recoveries = store.recoveries.listForCase(caseId);

  const L: string[] = [];
  L.push(`# NETRA case report — ${c.id}`, "");
  L.push(`Report version: ${REPORT_VERSION} · Case version: ${c.revision} · Evidence as of: ${iso(asOf)}`);
  L.push("All accounts, payments, holds and freezes are SIMULATED. No real bank or UPI system is connected.", "");

  L.push("## 1. Complaint");
  L.push(`- Victim account: ${vpa(c.victimAccountId)} (${c.victimAccountId})`);
  L.push(`- Reported by: ${c.reporterId} · Filed: ${iso(c.createdAt)}`);
  L.push(`- Incident window: ${iso(c.incidentStartTs)} → ${iso(c.incidentEndTs)}`);
  L.push(`- Stage / status: ${c.stage} / ${c.status}`);
  L.push(`- Narrative: ${c.narrative.replace(/\s+/g, " ")}`, "");

  L.push("## 2. Disputed payments (validated against the ledger)");
  for (const d of disputed) L.push(`- ${d.txnId} · ${inr(d.amountMinor)} · ${iso(d.ts)} · ledger seq ${d.seq}`);
  L.push(`- Reported loss (declared): ${inr(outcome.reportedLossMinor)} · Disputed payment total (validated): ${inr(outcome.disputedPaymentTotalMinor)}`, "");

  L.push("## 3. Protection and holds");
  if (!holds.length) L.push("- No holds recorded for this case.");
  for (const h of holds) {
    L.push(`- ${h.type} on ${vpa(h.accountId)} — ${h.status} since ${iso(h.createdAt)} by ${h.actorId}${h.releasedAt ? `; released ${iso(h.releasedAt)} by ${h.releasedActorId}: ${h.releasedReason}` : ""}`);
    L.push(`  reason: ${h.reason}`);
  }
  L.push("");

  L.push("## 4. Trace (reachability — not amount attribution)");
  if (!snap) L.push("- No completed trace.");
  else {
    L.push(`- Revision ${snap.revision} · ${snap.algorithm} · cutoff ${iso(snap.cutoffTs)} (ledger seq ≤ ${snap.cutoffSeq}) · window from ${iso(snap.windowFrom)}`);
    L.push(`- ${snap.nodes.length} accounts, ${snap.edges.length} transfers, ${snap.paths.length} paths, ${snap.cycles.length} chronological cycle(s)`);
    L.push(`- Limits: ${snap.config.maxHops} hops, ${snap.config.maxNodes} nodes, ${snap.config.maxEdges} edges, onward payments ≥ ${inr(snap.config.minEdgeAmountMinor)} within ${Math.round(snap.config.maxHopDelayMs / 60_000)} min of receipt`);
    L.push(`- Truncated: ${snap.truncated ? `YES (${Object.entries(snap.truncation).filter(([, v]) => v).map(([k]) => k).join(", ")})` : "no"} · History incomplete: ${snap.historyIncomplete ? "YES" : "no"}`);
    L.push(`- Observed downstream flow (edge volume, may repeat the same money): ${inr(snap.observedDownstreamFlowMinor)}`);
    L.push("- Sample paths:");
    for (const p of snap.paths.slice(0, 10)) L.push(`  - ${p.nodeIds.map(vpa).join(" → ")}${p.closesCycle ? " (closes a cycle)" : ""}`);
  }
  L.push("");

  L.push("## 5. Analysis (heuristic risk scores — not probabilities)");
  if (!analysis) L.push("- No analysis run.");
  else {
    L.push(`- Revision ${analysis.revision} of trace r${analysis.traceRevision} · ${analysis.detectorVersion} · ${analysis.configVersion}`);
    L.push(`- ${analysis.summary.suspected} suspected mule(s), ${analysis.summary.eligible} eligible for a freeze, ${analysis.summary.findings} finding(s)`);
    L.push("- Findings:");
    for (const f of findings) L.push(`  - ${f.motif} · ${f.accountIds.map(vpa).join(", ")} · +${f.points} · ${f.explanation} · evidence: ${f.txnIds.slice(0, 8).join(", ")}${f.txnIds.length > 8 ? " …" : ""}`);
    L.push("- Accounts:");
    for (const x of candidates.filter((k) => k.role !== "SINK").slice(0, 40)) {
      const why = x.contributions.filter((k) => k.points > 0).map((k) => `${k.feature}+${k.points}`).join(", ");
      L.push(`  - ${vpa(x.accountId)} · ${x.role} · risk ${x.riskScore}/100 · ${x.suspectedMule ? "SUSPECTED MULE" : "not suspected"} · ${x.eligible ? "eligible" : exclusionNote(x.exclusion as Exclusion)}${why ? ` · ${why}` : ""}`);
    }
  }
  L.push("");

  L.push("## 6. Enforcement actions (simulated debit freezes)");
  if (!actions.length) L.push("- None.");
  for (const a of actions) L.push(`- ${a.id} · ${a.policy} · analysis r${a.analysisRevision} · ${a.accountIds.map(vpa).join(", ")} · by ${a.actorId} at ${iso(a.appliedAt)} · "${a.reason}"`);
  L.push("");

  L.push("## 7. Money trail & recovery (where the victim's money is)");
  L.push(`- Attribution: ${attribution.policy} — ${attribution.method}`);
  const at = attribution.totals;
  L.push(`- Disputed ${inr(attribution.disputedMinor)} = recovered ${inr(at.recoveredMinor)} + in frozen accounts ${inr(at.heldInFrozenMinor)} + in unfrozen accounts ${inr(at.atRiskUnfrozenMinor)} + cashed out ${inr(at.cashedOutMinor)} + spent at merchants ${inr(at.spentAtMerchantsMinor)} + returned by fraudsters ${inr(at.returnedToVictimMinor)} + untracked ${inr(at.dustMinor + at.untrackedMinor)}`);
  if (attribution.truncated) L.push("- WARNING: attribution hit a budget; part of the money is untracked.");
  if (attribution.historyIncomplete) L.push("- WARNING: attribution history is incomplete.");
  L.push("- Accounts holding the victim's money now:");
  for (const a of attribution.accounts.filter((x) => x.heldMinor > 0 || x.recoveredMinor > 0).slice(0, 30)) {
    L.push(`  - ${a.vpa} · victim money ${inr(a.heldMinor)} of balance ${inr(a.balanceMinor)} (${a.sharePct}%) · ${a.frozenByCase ? "FROZEN" : "not frozen"}${a.recoveredMinor ? ` · recovered ${inr(a.recoveredMinor)}` : ""}`);
  }
  if (recoveries.length) {
    L.push(`- Recovered to victim: ${inr(outcome.recoveredOrRefundedMinor)} in ${recoveries.length} transfer(s):`);
    for (const r of recoveries) L.push(`  - ${iso(r.createdAt)} · ${vpa(r.accountId)} → victim · ${inr(r.amountMinor)} (attributed ${inr(r.attributedBeforeMinor)}, balance ${inr(r.balanceBeforeMinor)}) · ${r.txnId}`);
  } else {
    L.push(`- No recovery executed yet. Recoverable now from frozen accounts: ${inr(at.recoverableNowMinor)}.`);
  }
  L.push("");

  L.push("## 8. Outcome");
  L.push(`- Containment: ${outcome.containment} · Victim protected: ${outcome.victim.protected ? `yes, since ${iso(outcome.victim.protectedSince)}` : "no"}`);
  L.push(`- Unique blocked debit attempts: ${outcome.blocked.uniqueAttemptCount} (mule holds ${outcome.blocked.fromMuleHolds.count}, victim protection ${outcome.blocked.fromVictimProtection.count}) · latest ${iso(outcome.blocked.latestAt)}`);
  L.push(`- Blocked attempted amount: ${inr(outcome.blocked.attemptedAmountMinor)} (attempted, not recovered)`);
  L.push(`- Current held balance of frozen accounts: ${inr(outcome.heldBalanceMinor)}`);
  L.push(`- Victim money in frozen accounts: ${inr(outcome.caseAttributableHeldMinor)} · Recovered to victim: ${inr(outcome.recoveredOrRefundedMinor)}`);
  for (const q of outcome.qualifications) L.push(`- Note: ${q}`);
  L.push("");

  L.push("## 9. Audit trail");
  for (const e of audit) L.push(`- ${iso(e.createdAt)} · ${e.action} · ${e.actorId}`);
  L.push("");
  L.push("Recommended next steps (standard practice, for the investigating officer to decide): verify KYC of suspected accounts; file an STR with FIU-IND if warranted; for money in unfrozen accounts (including innocent recipients), coordinate a lien/chargeback with the beneficiary banks. Recoveries shown above are simulated ledger transfers.");

  const markdown = L.join("\n");
  return { version: REPORT_VERSION, caseId, asOf, markdown, contentHash: crypto.createHash("sha256").update(markdown).digest("hex") };
}

/** Store an immutable snapshot of the current report (idempotent on content). */
export function exportReport(store: Store, caseId: string, actorId: string, now: number): { report: StoredReport; created: boolean } {
  return serialTx(store, () => {
    const r = renderCaseReport(store, caseId);
    const existing = store.reports.byHash(caseId, r.contentHash);
    if (existing) return { report: existing, created: false };
    const report: StoredReport = { id: uid("rpt"), caseId, reportVersion: r.version, contentHash: r.contentHash, body: r.markdown, createdAt: now, actorId };
    store.reports.insert(report);
    recordCaseEvent(store, { caseId, actorId, action: "REPORT_EXPORTED", detail: { reportId: report.id, contentHash: r.contentHash }, at: now });
    return { report, created: true };
  });
}

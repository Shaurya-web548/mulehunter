"use client";

import Link from "next/link";
import { useParams } from "next/navigation";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { api, ApiFailure, newKey } from "@/lib/client/api";
import { dateTimeOf, inrMinor } from "@/lib/client/format";
import { SignIn, useSession } from "@/components/cases/Session";
import { Stepper } from "@/components/cases/Stepper";
import { TracePanel } from "@/components/cases/TracePanel";
import { AnalysisPanel, type FreezeInput } from "@/components/cases/AnalysisPanel";
import { AuditTimeline, HoldsPanel, OutcomePanel } from "@/components/cases/OutcomePanel";
import type { NodeStatus } from "@/components/cases/CaseGraph";
import type { AnalysisData, CaseViewData, OutcomeData, TraceData } from "@/components/cases/types";
import { MoneyTrailPanel } from "@/components/cases/MoneyTrailPanel";
import type { CaseAttribution } from "@/lib/modules/attribution/job";
import type { RecoveryTransfer } from "@/lib/persistence/repos/recovery";

type Live = "connecting" | "live" | "reconnecting";
const OUTCOME_POLL_MS = 4000;

export default function CaseWorkspace() {
  const { caseId } = useParams<{ caseId: string }>();
  const { session, loading: sessionLoading } = useSession();
  const [view, setView] = useState<CaseViewData | null>(null);
  const [trace, setTrace] = useState<TraceData | null>(null);
  const [analysis, setAnalysis] = useState<AnalysisData | null>(null);
  const [outcome, setOutcome] = useState<OutcomeData | null>(null);
  const [attribution, setAttribution] = useState<CaseAttribution | null>(null);
  const [transfers, setTransfers] = useState<RecoveryTransfer[]>([]);
  // idempotency key of an in-flight recovery (reused if the user retries)
  const recoverKey = useRef<string | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [live, setLive] = useState<Live>("connecting");
  const [reportText, setReportText] = useState<string | null>(null);
  // idempotency key of an in-flight freeze: reused if the user retries after a failure
  const freezeKey = useRef<string | null>(null);

  const refetch = useCallback(async () => {
    try {
      const [v, t, a, o, m, rc] = await Promise.all([
        api<CaseViewData>(`/api/cases/${caseId}`),
        api<TraceData>(`/api/cases/${caseId}/trace`),
        api<AnalysisData>(`/api/cases/${caseId}/analysis`),
        api<OutcomeData>(`/api/cases/${caseId}/outcome`),
        api<CaseAttribution>(`/api/cases/${caseId}/attribution`),
        api<{ transfers: RecoveryTransfer[] }>(`/api/cases/${caseId}/recoveries`),
      ]);
      setView(v);
      setTrace(t);
      setAnalysis(a);
      setOutcome(o);
      setAttribution(m);
      setTransfers(rc.transfers);
      setLoadError(null);
    } catch (e) {
      setLoadError(e instanceof ApiFailure ? e.message : "Could not load the case");
    }
  }, [caseId]);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const t = setTimeout(() => alive && void refetch(), 0);
    return () => {
      alive = false;
      clearTimeout(t);
    };
  }, [session, refetch]);

  // versioned case events + reconnect/resync
  useEffect(() => {
    if (!session) return;
    const es = new EventSource("/api/stream?only=cases");
    let lastVersion = 0;
    es.addEventListener("open", () => setLive("live"));
    es.addEventListener("error", () => setLive("reconnecting"));
    es.addEventListener("resync", () => void refetch());
    es.addEventListener("case", (ev) => {
      try {
        const d = JSON.parse((ev as MessageEvent).data) as { resourceId: string; version: number };
        if (d.resourceId === caseId && d.version > lastVersion) {
          lastVersion = d.version;
          void refetch();
        }
      } catch {
        /* ignore malformed event */
      }
    });
    return () => es.close();
  }, [session, caseId, refetch]);

  // blocked attempts are produced by payment executions, not case mutations
  const hasHolds = !!outcome && (outcome.muleHolds.active > 0 || outcome.victim.protected);
  useEffect(() => {
    if (!session || !hasHolds) return;
    const t = setInterval(() => {
      api<OutcomeData>(`/api/cases/${caseId}/outcome`)
        .then(setOutcome)
        .catch(() => {});
      api<CaseAttribution>(`/api/cases/${caseId}/attribution`)
        .then(setAttribution)
        .catch(() => {});
    }, OUTCOME_POLL_MS);
    return () => clearInterval(t);
  }, [session, caseId, hasHolds]);

  async function act(name: string, fn: () => Promise<string | void>) {
    setBusy(name);
    setActionError(null);
    setNotice(null);
    try {
      const msg = await fn();
      if (msg) setNotice(msg);
      await refetch();
    } catch (e) {
      setActionError(e instanceof ApiFailure ? `${e.message}${e.code === "NETWORK" ? " (nothing was confirmed — retry is safe)" : ""}` : "Action failed");
    } finally {
      setBusy(null);
    }
  }

  const statusOf = useMemo(() => {
    const frozen = new Set((view?.holds ?? []).filter((h) => h.status === "ACTIVE" && h.type === "MULE_DEBIT_FREEZE").map((h) => h.accountId));
    const suspected = new Set((analysis?.candidates ?? []).filter((c) => c.suspectedMule).map((c) => c.accountId));
    return (id: string): NodeStatus => (frozen.has(id) ? "frozen" : suspected.has(id) ? "suspected" : "none");
  }, [view, analysis]);

  if (sessionLoading) return <p className="p-8 font-mono text-sm text-muted">Checking session…</p>;
  if (!session)
    return (
      <main className="mx-auto max-w-md p-8">
        <SignIn />
      </main>
    );
  if (loadError && !view)
    return (
      <main className="mx-auto max-w-3xl p-8">
        <p role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm">
          {loadError}{" "}
          <button className="underline" onClick={() => void refetch()}>
            Retry
          </button>
        </p>
        <Link href="/cases" className="mt-3 inline-block text-xs text-accent">
          ← Cases
        </Link>
      </main>
    );
  if (!view || !trace || !analysis || !outcome || !attribution) return <p className="p-8 font-mono text-sm text-muted">Loading case {caseId}…</p>;

  const c = view.case;
  const canAct = session.role === "operator";
  const victimProtected = view.holds.some((h) => h.type === "VICTIM_PROTECTION" && h.status === "ACTIVE");
  const latestTrace = trace.runs[0];
  const traceDone = !!view.traces.find((t) => t.status === "DONE");

  return (
    <main className="mx-auto max-w-7xl space-y-5 p-6">
      <div className="flex flex-wrap items-start gap-3">
        <div>
          <Link href="/cases" className="text-xs text-accent">
            ← Cases
          </Link>
          <h1 className="font-(family-name:--font-display) text-2xl font-bold">Case {c.id}</h1>
          <p className="text-sm text-muted">
            Victim <span className="font-mono text-ink">{view.victim.vpa}</span> · filed {dateTimeOf(c.createdAt)} · disputed {inrMinor(view.disputed.reduce((s, d) => s + d.amountMinor, 0))} · stage <span className="font-mono">{c.stage}</span>
            {c.status !== c.stage && <span className="font-mono text-amber"> / {c.status}</span>} · version {c.revision}
          </p>
        </div>
        <span className={`ml-auto flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest ${live === "live" ? "text-accent" : "text-amber"}`} aria-live="polite">
          <span className={`live-dot h-2 w-2 rounded-full ${live === "live" ? "bg-accent" : "bg-amber"}`} />
          {live === "live" ? "updates live" : live === "reconnecting" ? "reconnecting — will resync" : "connecting"}
        </span>
      </div>

      <Stepper steps={view.steps} />

      {canAct ? (
        <div className="flex flex-wrap gap-2" aria-label="Case actions">
          {!victimProtected && (
            <button
              disabled={busy !== null}
              onClick={() => act("protect", async () => void (await api(`/api/cases/${c.id}/holds`, { method: "POST", body: { kind: "VICTIM_PROTECTION", reason: "Operator protected the victim account after intake" } })))}
              className="rounded-lg border border-frost/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-frost disabled:opacity-40"
            >
              {busy === "protect" ? "Protecting…" : "Protect victim account"}
            </button>
          )}
          <button
            disabled={busy !== null || c.stage === "CLOSED"}
            onClick={() =>
              act("trace", async () => {
                const r = await api<{ run: { revision: number; nodeCount: number; edgeCount: number } }>(`/api/cases/${c.id}/trace`, { method: "POST", body: { idempotencyKey: newKey("trace") } });
                return `Trace revision ${r.run.revision} committed: ${r.run.nodeCount} accounts, ${r.run.edgeCount} transfers.`;
              })
            }
            className="rounded-lg border border-line px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-accent/50 disabled:opacity-40"
          >
            {busy === "trace" ? "Tracing…" : latestTrace ? (latestTrace.status === "FAILED" ? "Retry trace" : "Re-trace (new revision)") : "Trace transactions"}
          </button>
          <button
            disabled={busy !== null || !traceDone}
            onClick={() =>
              act("analyze", async () => {
                const r = await api<{ run: { revision: number; summary: { suspected: number; eligible: number } } }>(`/api/cases/${c.id}/analysis`, { method: "POST", body: {} });
                return `Analysis revision ${r.run.revision}: ${r.run.summary.suspected} suspected, ${r.run.summary.eligible} eligible.`;
              })
            }
            className="rounded-lg border border-line px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-accent/50 disabled:opacity-40"
          >
            {busy === "analyze" ? "Analyzing…" : analysis.run ? "Re-analyze" : "Analyze patterns"}
          </button>
          <button
            disabled={busy !== null}
            onClick={() =>
              act("export", async () => {
                const r = await api<{ id: string; created: boolean }>(`/api/cases/${c.id}/report`, { method: "POST" });
                return r.created ? `Report snapshot ${r.id} stored.` : `Report unchanged since snapshot ${r.id}.`;
              })
            }
            className="rounded-lg border border-line px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-accent/50 disabled:opacity-40"
          >
            Store report snapshot
          </button>
          <a href={`/api/cases/${c.id}/report?format=md`} className="rounded-lg border border-line px-3 py-2 font-mono text-xs uppercase tracking-wider text-ink hover:border-accent/50">
            Download report (.md)
          </a>
        </div>
      ) : (
        <p className="text-xs text-muted">
          Read-only (viewer). Operators can protect, trace, analyze and freeze.{" "}
          <a href={`/api/cases/${c.id}/report?format=md`} className="text-accent underline">
            Download report
          </a>
        </p>
      )}
      {(actionError || notice) && (
        <p role={actionError ? "alert" : "status"} className={`rounded-lg border p-3 text-sm ${actionError ? "border-danger/40 bg-danger/10" : "border-accent/30 bg-accent/5"}`}>
          {actionError ?? notice}
        </p>
      )}
      {loadError && <p className="text-xs text-amber">Last refresh failed: {loadError}</p>}

      <section aria-labelledby="h-trace">
        <h2 id="h-trace" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Traced money flow</h2>
        <TracePanel trace={trace} statusOf={statusOf} />
      </section>

      <div className="grid gap-5 lg:grid-cols-[3fr_2fr]">
        <section aria-labelledby="h-analysis">
          <h2 id="h-analysis" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Pattern analysis &amp; suspected mules</h2>
          <AnalysisPanel
            key={analysis.run?.revision ?? 0}
            analysis={analysis}
            canAct={canAct}
            autoDemo={view.policy.autoDemoEnabled}
            busy={busy !== null}
            onFreeze={(f: FreezeInput) =>
              act("freeze", async () => {
                freezeKey.current ??= newKey("freeze");
                const r = await api<{ action: { accountIds: string[] }; replayed: boolean }>(`/api/cases/${c.id}/holds`, {
                  method: "POST",
                  body: { kind: "MULE_DEBIT_FREEZE", analysisRevision: analysis.run!.revision, policy: f.policy, accountIds: f.policy === "MANUAL" ? f.accountIds : undefined, reason: f.reason, actionKey: freezeKey.current },
                });
                freezeKey.current = null;
                return `${r.replayed ? "Already applied" : "Applied"}: simulated debit freeze on ${r.action.accountIds.length} account(s).`;
              })
            }
          />
        </section>
        <section aria-labelledby="h-holds" className="space-y-5">
          <div>
            <h2 id="h-holds" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Holds</h2>
            <HoldsPanel
              holds={view.holds}
              canAct={canAct}
              busy={busy !== null}
              onRelease={(holdId, reason) =>
                act("release", async () => {
                  const r = await api<{ stillBlockedBy: unknown[] }>(`/api/holds/${holdId}/release`, { method: "POST", body: { reason } });
                  return r.stillBlockedBy.length ? `Hold released. The account is still debit-blocked by ${r.stillBlockedBy.length} other hold(s).` : "Hold released. No other hold blocks this account.";
                })
              }
            />
          </div>
          <div>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Complaint</h2>
            <p className="text-xs text-muted">{c.narrative}</p>
            <ul className="mt-2 space-y-1 text-xs">
              {view.disputed.map((d) => (
                <li key={d.txnId} className="font-mono">
                  {inrMinor(d.amountMinor)} → {d.to?.vpa ?? "?"} · {dateTimeOf(d.ts)} · <span className="text-muted">{d.txnId}</span>
                </li>
              ))}
            </ul>
            <p className="mt-2 text-xs text-muted">Reported loss (declared): {inrMinor(c.declaredLossMinor)}</p>
          </div>
        </section>
      </div>

      <section aria-labelledby="h-money">
        <h2 id="h-money" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Money trail &amp; recovery — where the victim&apos;s money is now</h2>
        <MoneyTrailPanel
          attribution={attribution}
          transfers={transfers}
          canAct={canAct}
          busy={busy !== null}
          onRecover={(reason) =>
            act("recover", async () => {
              recoverKey.current ??= newKey("recover");
              const r = await api<{ action: { totalMinor: number }; transfers: unknown[]; replayed: boolean }>(`/api/cases/${c.id}/recoveries`, {
                method: "POST",
                body: { reason, actionKey: recoverKey.current },
              });
              recoverKey.current = null;
              return `${r.replayed ? "Already recovered" : "Recovered"} ${inrMinor(r.action.totalMinor)} to the victim in ${r.transfers.length} transfer(s).`;
            })
          }
        />
      </section>

      <section aria-labelledby="h-outcome">
        <h2 id="h-outcome" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Containment outcome</h2>
        <OutcomePanel outcome={outcome} />
      </section>

      <div className="grid gap-5 lg:grid-cols-2">
        <section aria-labelledby="h-audit">
          <h2 id="h-audit" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Audit trail</h2>
          <AuditTimeline audit={view.audit} />
        </section>
        <section aria-labelledby="h-report">
          <h2 id="h-report" className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Report</h2>
          <button
            onClick={async () => {
              try {
                const r = await api<{ markdown: string }>(`/api/cases/${c.id}/report`);
                setReportText(r.markdown);
              } catch (e) {
                setActionError(e instanceof ApiFailure ? e.message : "Could not render the report");
              }
            }}
            className="rounded-lg border border-line px-3 py-2 text-xs text-ink hover:border-accent/50"
          >
            Preview evidence report
          </button>
          {view.reports.length > 0 && <p className="mt-2 text-xs text-muted">{view.reports.length} stored snapshot(s); latest {dateTimeOf(view.reports[0].createdAt)}.</p>}
          {reportText && <pre className="mt-2 max-h-96 overflow-auto whitespace-pre-wrap rounded-xl border border-line p-3 font-mono text-[11px] text-ink/90">{reportText}</pre>}
        </section>
      </div>
    </main>
  );
}

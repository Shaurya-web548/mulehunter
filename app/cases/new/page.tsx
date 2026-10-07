"use client";

import { useRouter } from "next/navigation";
import { useEffect, useMemo, useState } from "react";
import { api, ApiFailure, newKey } from "@/lib/client/api";
import { dateTimeOf, inrMinor, timeOf } from "@/lib/client/format";
import { rupeesToMinor, MoneyError } from "@/lib/contracts/money";
import { SignIn, useSession } from "@/components/cases/Session";

interface AccountHit {
  id: string;
  vpa: string;
  name: string;
  kind: string;
}
interface Candidate {
  txnId: string;
  toVpa: string;
  toKind: string;
  amountMinor: number;
  ts: number;
  alreadyDisputedBy: string[];
}
interface Demo {
  victimId: string;
  victimVpa: string;
  seedAt: number;
  layeringDoneAt: number;
  firstCashOutAt: number;
}

const toLocalInput = (ms: number) => {
  const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60_000);
  return d.toISOString().slice(0, 16);
};

export default function NewCasePage() {
  const { session, loading } = useSession();
  const router = useRouter();
  const [now] = useState(() => Date.now());
  const [q, setQ] = useState("");
  const [hits, setHits] = useState<AccountHit[]>([]);
  const [victim, setVictim] = useState<AccountHit | null>(null);
  const [from, setFrom] = useState(() => toLocalInput(now - 2 * 3600_000));
  const [to, setTo] = useState(() => toLocalInput(now + 5 * 60_000));
  const [cands, setCands] = useState<Candidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [declared, setDeclared] = useState("");
  const [narrative, setNarrative] = useState("");
  const [protect, setProtect] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [demo, setDemo] = useState<Demo | null>(null);
  // one idempotency key per filled form: a retry after a network error replays
  const [formKey, setFormKey] = useState(() => newKey("complaint"));

  useEffect(() => {
    if (q.trim().length < 3 || victim?.vpa === q) return;
    const ctl = new AbortController();
    const t = setTimeout(() => {
      api<AccountHit[]>(`/api/accounts/search?q=${encodeURIComponent(q.trim())}`, { signal: ctl.signal })
        .then(setHits)
        .catch(() => setHits([]));
    }, 250);
    return () => {
      clearTimeout(t);
      ctl.abort();
    };
  }, [q, victim]);

  const selectedTotal = useMemo(() => (cands ?? []).filter((c) => selected.has(c.txnId)).reduce((s, c) => s + c.amountMinor, 0), [cands, selected]);

  async function loadPayments(acc: AccountHit | null = victim) {
    if (!acc) return;
    setBusy("payments");
    setError(null);
    try {
      const f = new Date(from).getTime();
      const t = new Date(to).getTime();
      const rows = await api<Candidate[]>(`/api/accounts/${encodeURIComponent(acc.id)}/payments?from=${f}&to=${t}`);
      setCands(rows);
      setSelected(new Set());
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Could not load payments");
    } finally {
      setBusy(null);
    }
  }

  async function seedDemo() {
    setBusy("demo");
    setError(null);
    try {
      const d = await api<Demo>("/api/demo/scenario", { method: "POST", body: { cashOutDelaySec: 120 } });
      setDemo(d);
      const acc = { id: d.victimId, vpa: d.victimVpa, name: "demo victim", kind: "person" };
      setVictim(acc);
      setQ(d.victimVpa);
      setHits([]);
      setNarrative("Caller posing as the bank's KYC desk asked me to approve a UPI collect request; ₹2,40,000 left my account.");
      setDeclared("240000");
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Could not seed the demo");
    } finally {
      setBusy(null);
    }
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    if (!victim) return setError("Select the victim account.");
    if (!selected.size) return setError("Select at least one disputed payment.");
    let declaredLossMinor: number | undefined;
    if (declared.trim()) {
      try {
        // the one place the form converts rupees → paise (refuses sub-paise input)
        declaredLossMinor = rupeesToMinor(Number(declared.replace(/,/g, "")));
      } catch (err) {
        return setError(err instanceof MoneyError ? `Declared loss: ${err.message}` : "Declared loss is not a valid amount");
      }
    }
    setBusy("submit");
    try {
      const r = await api<{ case: { id: string } }>("/api/cases", {
        method: "POST",
        body: {
          victimAccountId: victim.id,
          incidentStartTs: new Date(from).getTime(),
          incidentEndTs: new Date(to).getTime(),
          disputedTxnIds: [...selected],
          narrative,
          declaredLossMinor,
          protectVictim: protect,
          idempotencyKey: formKey,
        },
      });
      router.push(`/cases/${r.case.id}`);
    } catch (err) {
      setError(err instanceof ApiFailure ? `${err.message}${err.code === "NETWORK" ? " — you can retry safely." : ""}` : "Filing failed");
      if (err instanceof ApiFailure && err.code === "IDEMPOTENCY_CONFLICT") setFormKey(newKey("complaint"));
    } finally {
      setBusy(null);
    }
  }

  if (loading) return <p className="p-8 font-mono text-sm text-muted">Checking session…</p>;
  if (!session)
    return (
      <main className="mx-auto max-w-md p-8">
        <SignIn />
      </main>
    );
  if (session.role !== "operator")
    return (
      <main className="mx-auto max-w-lg p-8 text-sm text-muted">
        Filing a complaint requires operator permission. You are signed in as a viewer.
        <div className="mt-4">
          <SignIn compact />
        </div>
      </main>
    );

  return (
    <main className="mx-auto max-w-4xl p-6">
      <h1 className="font-(family-name:--font-display) text-2xl font-bold">Report fraud</h1>
      <p className="mb-5 text-sm text-muted">File a complaint against specific accepted payments. The case, the optional victim protection hold and the audit record are committed together — this page only shows “filed” after the server confirms it.</p>

      <section className="glass mb-5 rounded-2xl p-4">
        <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Demo helper</p>
        <p className="mt-1 text-sm text-muted">Seeds a fixed scenario (victim → layering → loop → queued cash-outs). Every payment executes through the admission gate.</p>
        <button type="button" onClick={seedDemo} disabled={busy !== null} className="mt-3 rounded-lg border border-accent/50 px-3 py-2 font-mono text-xs uppercase tracking-wider text-accent disabled:opacity-50">
          {busy === "demo" ? "Seeding…" : "Seed complaint demo scenario"}
        </button>
        {demo && (
          <p className="mt-2 text-xs text-ink" aria-live="polite">
            Seeded. Victim <span className="font-mono">{demo.victimVpa}</span> pays at {timeOf(demo.seedAt)}; layering completes by {timeOf(demo.layeringDoneAt)}; queued cash-outs start at {timeOf(demo.firstCashOutAt)}. Load payments after {timeOf(demo.layeringDoneAt)}.
          </p>
        )}
      </section>

      <form onSubmit={submit} className="space-y-5" aria-busy={busy === "submit"}>
        <section className="glass rounded-2xl p-4">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">1 · Victim account</h2>
          <label className="block text-xs text-muted">
            Search by VPA or account id
            <input
              value={q}
              onChange={(e) => {
                setQ(e.target.value);
                setVictim(null);
                setCands(null);
              }}
              placeholder="e.g. meera.iyer"
              className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 font-mono text-sm text-ink outline-none focus:border-accent/60"
            />
          </label>
          {!victim && hits.length > 0 && (
            <ul className="mt-2 divide-y divide-line rounded-lg border border-line" role="listbox" aria-label="Matching accounts">
              {hits.map((h) => (
                <li key={h.id}>
                  <button
                    type="button"
                    role="option"
                    aria-selected={false}
                    onClick={() => {
                      setVictim(h);
                      setQ(h.vpa);
                      setHits([]);
                    }}
                    className="w-full px-3 py-2 text-left font-mono text-xs hover:bg-white/5"
                  >
                    {h.vpa} <span className="text-muted">· {h.kind}</span>
                  </button>
                </li>
              ))}
            </ul>
          )}
          {victim && <p className="mt-2 text-xs text-accent">Selected: {victim.vpa}</p>}
        </section>

        <section className="glass rounded-2xl p-4">
          <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">2 · Incident window and disputed payments</h2>
          <div className="flex flex-wrap items-end gap-3">
            <label className="text-xs text-muted">
              From
              <input type="datetime-local" value={from} onChange={(e) => setFrom(e.target.value)} className="ml-2 rounded-lg border border-line bg-white/5 px-2 py-1.5 text-sm text-ink" />
            </label>
            <label className="text-xs text-muted">
              To
              <input type="datetime-local" value={to} onChange={(e) => setTo(e.target.value)} className="ml-2 rounded-lg border border-line bg-white/5 px-2 py-1.5 text-sm text-ink" />
            </label>
            <button type="button" disabled={!victim || busy !== null} onClick={() => loadPayments()} className="rounded-lg border border-line px-3 py-2 text-xs text-ink hover:border-accent/50 disabled:opacity-40">
              {busy === "payments" ? "Loading…" : "Load victim's payments"}
            </button>
          </div>
          {cands && cands.length === 0 && <p className="mt-3 text-sm text-muted">No accepted outgoing payments from this account in the window.</p>}
          {cands && cands.length > 0 && (
            <fieldset className="mt-3">
              <legend className="mb-1 text-xs text-muted">Select the payments you are disputing (nothing is selected automatically)</legend>
              <div className="overflow-x-auto rounded-lg border border-line">
                <table className="w-full text-left text-sm">
                  <thead className="bg-white/3 font-mono text-[10px] uppercase tracking-widest text-muted">
                    <tr>
                      <th scope="col" className="px-3 py-2">Dispute</th>
                      <th scope="col" className="px-3 py-2">Time</th>
                      <th scope="col" className="px-3 py-2">To</th>
                      <th scope="col" className="px-3 py-2">Amount</th>
                      <th scope="col" className="px-3 py-2">Transaction</th>
                    </tr>
                  </thead>
                  <tbody>
                    {cands.map((c) => (
                      <tr key={c.txnId} className="border-t border-line">
                        <td className="px-3 py-2">
                          <input
                            type="checkbox"
                            aria-label={`Dispute ${inrMinor(c.amountMinor)} to ${c.toVpa}`}
                            checked={selected.has(c.txnId)}
                            onChange={(e) =>
                              setSelected((s) => {
                                const n = new Set(s);
                                if (e.target.checked) n.add(c.txnId);
                                else n.delete(c.txnId);
                                return n;
                              })
                            }
                          />
                        </td>
                        <td className="px-3 py-2 text-xs">{dateTimeOf(c.ts)}</td>
                        <td className="px-3 py-2 font-mono text-xs">
                          {c.toVpa} {c.toKind === "merchant" && <span className="text-muted">(merchant)</span>}
                        </td>
                        <td className="px-3 py-2 tabular-nums">{inrMinor(c.amountMinor)}</td>
                        <td className="px-3 py-2 font-mono text-[11px] text-muted">
                          {c.txnId}
                          {c.alreadyDisputedBy.length > 0 && <span className="ml-1 text-amber">already in {c.alreadyDisputedBy.length} case(s)</span>}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
              <p className="mt-2 text-xs text-muted">Selected total (validated against the ledger on submit): {inrMinor(selectedTotal)}</p>
            </fieldset>
          )}
        </section>

        <section className="glass rounded-2xl p-4 space-y-3">
          <h2 className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted">3 · Complaint details</h2>
          <label className="block text-xs text-muted">
            Reported loss (₹, as declared by the reporter — optional)
            <input inputMode="decimal" value={declared} onChange={(e) => setDeclared(e.target.value)} placeholder="e.g. 240000" className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60" />
          </label>
          <label className="block text-xs text-muted">
            Narrative
            <textarea value={narrative} onChange={(e) => setNarrative(e.target.value)} required minLength={8} maxLength={4000} rows={3} className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60" />
          </label>
          <label className="flex items-start gap-2 rounded-lg border border-frost/30 bg-frost/5 p-3 text-sm">
            <input type="checkbox" checked={protect} onChange={(e) => setProtect(e.target.checked)} className="mt-1" />
            <span>
              <span className="font-semibold text-frost">Protect victim account</span> — place a simulated debit hold on the victim account. It blocks further outgoing payments from the victim, still allows incoming credits, and does not undo payments that already happened. The victim is not treated as a suspect.
            </span>
          </label>
        </section>

        {error && (
          <p role="alert" className="rounded-lg border border-danger/40 bg-danger/10 p-3 text-sm text-ink">
            {error}
          </p>
        )}
        <button disabled={busy !== null} className="rounded-lg bg-danger px-5 py-2.5 font-mono text-xs font-bold uppercase tracking-wider text-white disabled:opacity-50">
          {busy === "submit" ? "Filing…" : "File complaint"}
        </button>
      </form>
    </main>
  );
}

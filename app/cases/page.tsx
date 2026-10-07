"use client";

import Link from "next/link";
import { useCallback, useEffect, useState } from "react";
import { api, ApiFailure } from "@/lib/client/api";
import { dateTimeOf, inrMinor } from "@/lib/client/format";
import { SignIn, useSession } from "@/components/cases/Session";
import type { Case } from "@/lib/contracts/types";

interface Row extends Case {
  victimVpa: string;
  disputedTotalMinor: number;
  activeHolds: number;
}

const FILTERS = ["", "VALIDATED", "TRACING", "UNDER_REVIEW", "NEEDS_EVIDENCE", "CLOSED"];

export default function CasesPage() {
  const { session, loading: sessionLoading } = useSession();
  const [status, setStatus] = useState("");
  const [rows, setRows] = useState<Row[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string | null>(null);
  const [reloadTick, setReloadTick] = useState(0);

  useEffect(() => {
    if (!session) return;
    let alive = true;
    const qs = new URLSearchParams({ limit: "25", ...(status ? { status } : {}) });
    api<{ items: Row[]; nextCursor: string | null }>(`/api/cases?${qs}`)
      .then((d) => {
        if (!alive) return;
        setRows(d.items);
        setCursor(d.nextCursor);
        setState("ready");
      })
      .catch((e) => {
        if (!alive) return;
        setError(e instanceof ApiFailure ? e.message : "Could not load cases");
        setState("error");
      });
    return () => {
      alive = false;
    };
  }, [session, status, reloadTick]);

  const more = useCallback(async () => {
    if (!cursor) return;
    const qs = new URLSearchParams({ limit: "25", cursor, ...(status ? { status } : {}) });
    try {
      const d = await api<{ items: Row[]; nextCursor: string | null }>(`/api/cases?${qs}`);
      setRows((r) => [...r, ...d.items]);
      setCursor(d.nextCursor);
    } catch (e) {
      setError(e instanceof ApiFailure ? e.message : "Could not load more cases");
    }
  }, [cursor, status]);

  if (sessionLoading) return <p className="p-8 font-mono text-sm text-muted">Checking session…</p>;
  if (!session)
    return (
      <main className="mx-auto max-w-md p-8">
        <SignIn />
      </main>
    );

  return (
    <main className="mx-auto max-w-6xl p-6">
      <div className="mb-4 flex flex-wrap items-end gap-3">
        <div>
          <h1 className="font-(family-name:--font-display) text-2xl font-bold">Cases</h1>
          <p className="text-sm text-muted">Complaint-driven investigations. Every state shown here is read from the durable case record.</p>
        </div>
        <label className="ml-auto text-xs text-muted">
          Status
          <select
            value={status}
            onChange={(e) => {
              setState("loading");
              setStatus(e.target.value);
            }}
            className="ml-2 rounded-lg border border-line bg-panel px-2 py-1.5 text-sm text-ink"
          >
            {FILTERS.map((f) => (
              <option key={f} value={f}>
                {f || "All"}
              </option>
            ))}
          </select>
        </label>
        {session.role === "operator" && (
          <Link href="/cases/new" className="rounded-lg bg-danger px-4 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white">
            Report fraud
          </Link>
        )}
      </div>

      {state === "loading" && <p className="rounded-xl border border-dashed border-line p-6 text-center text-sm text-muted">Loading cases…</p>}
      {state === "error" && (
        <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-4 text-sm">
          {error}{" "}
          <button
            className="ml-2 underline"
            onClick={() => {
              setState("loading");
              setReloadTick((t) => t + 1);
            }}
          >
            Retry
          </button>
        </div>
      )}
      {state === "ready" && rows.length === 0 && (
        <p className="rounded-xl border border-dashed border-line p-8 text-center text-sm text-muted">
          No cases yet. {session.role === "operator" ? "Use Report fraud to file the first complaint." : "An operator can file one."}
        </p>
      )}
      {state === "ready" && rows.length > 0 && (
        <div className="overflow-x-auto rounded-2xl border border-line">
          <table className="w-full text-left text-sm">
            <caption className="sr-only">Cases</caption>
            <thead className="bg-white/3 font-mono text-[10px] uppercase tracking-widest text-muted">
              <tr>
                <th scope="col" className="px-4 py-2">Case</th>
                <th scope="col" className="px-4 py-2">Victim</th>
                <th scope="col" className="px-4 py-2">Disputed</th>
                <th scope="col" className="px-4 py-2">Stage / status</th>
                <th scope="col" className="px-4 py-2">Active holds</th>
                <th scope="col" className="px-4 py-2">Updated</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((c) => (
                <tr key={c.id} className="border-t border-line hover:bg-white/3">
                  <td className="px-4 py-2 font-mono text-xs">
                    <Link href={`/cases/${c.id}`} className="text-accent hover:underline">
                      {c.id}
                    </Link>
                  </td>
                  <td className="px-4 py-2 font-mono text-xs">{c.victimVpa}</td>
                  <td className="px-4 py-2 tabular-nums">{inrMinor(c.disputedTotalMinor)}</td>
                  <td className="px-4 py-2 font-mono text-[11px]">
                    {c.stage}
                    {c.status !== c.stage && <span className="text-amber"> · {c.status}</span>}
                  </td>
                  <td className="px-4 py-2 tabular-nums">{c.activeHolds}</td>
                  <td className="px-4 py-2 text-xs text-muted">{dateTimeOf(c.updatedAt)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {cursor && (
        <button onClick={more} className="mt-3 rounded-lg border border-line px-4 py-2 text-xs text-ink hover:border-accent/50">
          Load more
        </button>
      )}
    </main>
  );
}

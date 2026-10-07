"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { api, ApiFailure, type SessionInfo } from "@/lib/client/api";

interface SessionState {
  session: SessionInfo | null;
  loading: boolean;
  refresh: () => Promise<void>;
  signOut: () => Promise<void>;
}

const Ctx = createContext<SessionState>({ session: null, loading: true, refresh: async () => {}, signOut: async () => {} });

export function useSession() {
  return useContext(Ctx);
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const [session, setSession] = useState<SessionInfo | null>(null);
  const [loading, setLoading] = useState(true);

  const refresh = useCallback(async () => {
    try {
      setSession(await api<SessionInfo | null>("/api/session"));
    } catch {
      setSession(null);
    } finally {
      setLoading(false);
    }
  }, []);

  const signOut = useCallback(async () => {
    await api("/api/session", { method: "DELETE" }).catch(() => {});
    setSession(null);
  }, []);

  useEffect(() => {
    let alive = true;
    api<SessionInfo | null>("/api/session")
      .then((s) => alive && setSession(s))
      .catch(() => alive && setSession(null))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  return <Ctx.Provider value={{ session, loading, refresh, signOut }}>{children}</Ctx.Provider>;
}

/** Sign-in form. Operators need the operator code (server-side check). */
export function SignIn({ compact = false, onDone }: { compact?: boolean; onDone?: () => void }) {
  const { refresh } = useSession();
  const [role, setRole] = useState<"operator" | "viewer">("operator");
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await api("/api/session", { method: "POST", body: { role, name, code: role === "operator" ? code : undefined } });
      await refresh();
      onDone?.();
    } catch (err) {
      setError(err instanceof ApiFailure ? err.message : "Sign-in failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className={`glass rounded-2xl ${compact ? "p-4" : "p-6"} space-y-3`} aria-label="Sign in">
      <p className="font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Sign in to the investigator console</p>
      <fieldset className="flex gap-2">
        <legend className="sr-only">Role</legend>
        {(["operator", "viewer"] as const).map((r) => (
          <label key={r} className={`cursor-pointer rounded-lg border px-3 py-1.5 text-xs ${role === r ? "border-accent/60 text-accent" : "border-line text-muted"}`}>
            <input type="radio" name="role" value={r} checked={role === r} onChange={() => setRole(r)} className="sr-only" />
            {r === "operator" ? "Operator (can act)" : "Viewer (read-only)"}
          </label>
        ))}
      </fieldset>
      <label className="block text-xs text-muted">
        Your name
        <input value={name} onChange={(e) => setName(e.target.value)} required minLength={2} maxLength={40} className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60" />
      </label>
      {role === "operator" && (
        <label className="block text-xs text-muted">
          Operator code
          <input type="password" value={code} onChange={(e) => setCode(e.target.value)} required autoComplete="off" className="mt-1 w-full rounded-lg border border-line bg-white/5 px-3 py-2 text-sm text-ink outline-none focus:border-accent/60" />
          <span className="mt-1 block text-[11px] text-muted/80">Set by MNH_OPERATOR_CODE, or printed in the server console when unset.</span>
        </label>
      )}
      {error && (
        <p role="alert" className="text-xs text-danger">
          {error}
        </p>
      )}
      <button disabled={busy} className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-void disabled:opacity-50">
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}

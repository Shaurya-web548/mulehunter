"use client";

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { AnimatePresence, motion } from "framer-motion";
import type { Pattern, Ring, Snapshot } from "@/lib/engine/types";
import { inr, patternLabel } from "@/lib/format";
import { ForceGraph } from "@/components/ForceGraph";
import { EASE } from "@/components/anim";
import { SessionProvider, SignIn } from "@/components/cases/Session";

const ATTACKS: { pattern: Pattern; name: string; desc: string }[] = [
  { pattern: "fanout_layering", name: "Fan-out layering", desc: "Victim → root → 2 mule layers → cash-out" },
  { pattern: "circular_routing", name: "Circular routing", desc: "A closed loop cycles funds to hide origin" },
  { pattern: "smurfing", name: "Smurfing", desc: "25+ senders, all just under ₹10k, one aggregator" },
];

function Tile({ label, value, tone }: { label: string; value: string; tone?: "accent" | "danger" | "frost" }) {
  const color = tone === "danger" ? "text-danger" : tone === "frost" ? "text-frost" : tone === "accent" ? "text-accent" : "text-ink";
  return (
    <div className="glass rounded-xl px-4 py-2.5">
      <p className="font-mono text-[10px] uppercase tracking-widest text-muted">{label}</p>
      <p className={`font-(family-name:--font-display) text-lg font-bold tabular-nums ${color}`}>{value}</p>
    </div>
  );
}

function RingCard({
  ring,
  onFreeze,
  onReport,
  busy,
}: {
  ring: Ring;
  onFreeze: (id: string) => void;
  onReport: (ring: Ring) => void;
  busy: boolean;
}) {
  const frozen = ring.status === "frozen";
  return (
    <motion.div
      layout
      initial={{ opacity: 0, y: 16, scale: 0.97 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.45, ease: EASE }}
      className={`rounded-2xl border p-4 ${
        frozen ? "border-frost/30 bg-frost/5" : "border-danger/30 bg-danger/5"
      }`}
    >
      <div className="flex items-center justify-between gap-2">
        <p className={`font-mono text-xs font-bold uppercase tracking-wider ${frozen ? "text-frost" : "text-danger"}`}>
          {frozen ? "❄ frozen" : "● live ring"} · {patternLabel(ring.pattern)}
        </p>
        <span className="font-mono text-[11px] text-muted" title="heuristic ring risk score, not a probability">risk {ring.score}/100</span>
      </div>
      <p className="mt-2 text-sm text-ink">
        {ring.accounts.length} accounts · ₹{inr(ring.totalFlow)} moved in window
      </p>
      {frozen && (ring.blockedAttempts ?? 0) > 0 && (
        <p className="mt-1 text-sm font-semibold text-frost">
          {ring.blockedAttempts} debit attempt{ring.blockedAttempts === 1 ? "" : "s"} rejected · ₹{inr(ring.intercepted)} attempted
        </p>
      )}
      <div className="mt-3 flex gap-2">
        {!frozen && (
          <motion.button
            whileTap={{ scale: 0.94 }}
            disabled={busy}
            onClick={() => onFreeze(ring.id)}
            className="flex-1 rounded-lg bg-danger px-3 py-2 font-mono text-xs font-bold uppercase tracking-wider text-white transition-colors hover:bg-[#e03d4d] disabled:opacity-50"
          >
            Freeze ring (simulated)
          </motion.button>
        )}
        <motion.button
          whileTap={{ scale: 0.94 }}
          onClick={() => onReport(ring)}
          className="flex-1 rounded-lg border border-line bg-white/5 px-3 py-2 font-mono text-xs font-semibold uppercase tracking-wider text-ink transition-colors hover:border-accent/50 hover:text-accent"
        >
          Report
        </motion.button>
      </div>
    </motion.div>
  );
}

export default function HuntPage() {
  return (
    <SessionProvider>
      <Hunt />
    </SessionProvider>
  );
}

function Hunt() {
  const [snap, setSnap] = useState<Snapshot | null>(null);
  const [connected, setConnected] = useState(false);
  const [cooldown, setCooldown] = useState(false);
  const [freezing, setFreezing] = useState(false);
  const [freezeError, setFreezeError] = useState<string | null>(null);
  const [needSignIn, setNeedSignIn] = useState(false);
  const [report, setReport] = useState<{ ring: Ring; text?: string; source?: string } | null>(null);
  const esRef = useRef<EventSource | null>(null);

  useEffect(() => {
    const es = new EventSource("/api/stream");
    esRef.current = es;
    es.onopen = () => setConnected(true);
    es.onerror = () => setConnected(false);
    es.onmessage = (e) => setSnap(JSON.parse(e.data));
    return () => es.close();
  }, []);

  async function attack(pattern: Pattern) {
    setCooldown(true);
    setTimeout(() => setCooldown(false), 6000);
    await fetch("/api/attack", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ pattern }),
    }).catch(() => {});
  }

  // Freezing is an enforcement action: operator session + CSRF header,
  // durable holds on the server. Show the real result, never assume success.
  async function freeze(ringId: string) {
    setFreezing(true);
    setFreezeError(null);
    try {
      const res = await fetch("/api/freeze", {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-netra-csrf": "1" },
        body: JSON.stringify({ ringId }),
      });
      if (res.status === 401 || res.status === 403) {
        setNeedSignIn(true);
        setFreezeError("Freezing requires an operator sign-in.");
      } else if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        setFreezeError(body.message ?? `Freeze failed (${res.status})`);
      }
    } catch {
      setFreezeError("Network error — the ring was not frozen.");
    }
    setFreezing(false);
  }

  async function openReport(ring: Ring) {
    setReport({ ring });
    try {
      const res = await fetch("/api/report", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ ringId: ring.id }),
      });
      const body = await res.json();
      setReport({ ring, text: body.report, source: body.source });
    } catch {
      setReport({ ring, text: "Report generation failed.", source: "error" });
    }
  }

  const m = snap?.metrics;

  return (
    <div className="flex h-screen flex-col bg-void">
      {/* top bar */}
      <header className="flex items-center gap-3 border-b border-line px-4 py-3">
        <Link href="/" className="flex items-center gap-2 font-(family-name:--font-display) font-bold tracking-tight">
          <span className="flex h-6 w-6 items-center justify-center rounded bg-accent font-mono text-xs text-void">◉</span>
          NETRA
        </Link>
        <span className={`ml-2 flex items-center gap-1.5 font-mono text-[11px] uppercase tracking-widest ${connected ? "text-accent" : "text-danger"}`}>
          <span className={`live-dot h-2 w-2 rounded-full ${connected ? "bg-accent" : "bg-danger"}`} />
          {connected ? "engine live" : "connecting"}
        </span>
        <nav aria-label="Console" className="ml-3 flex gap-1">
          <Link href="/cases/new" className="rounded-lg px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-muted hover:text-ink">Report fraud</Link>
          <Link href="/cases" className="rounded-lg px-2.5 py-1 font-mono text-[11px] uppercase tracking-widest text-muted hover:text-ink">Cases</Link>
        </nav>
        <div className="ml-auto flex flex-wrap items-center gap-2">
          <Tile label="TPS" value={m ? String(m.tps) : "—"} tone="accent" />
          <Tile label="Processed" value={m ? m.processed.toLocaleString("en-IN") : "—"} />
          <Tile label="Precision" value={m ? `${Math.round(m.precision * 100)}%` : "—"} tone="accent" />
          <Tile label="Recall" value={m ? `${Math.round(m.recall * 100)}%` : "—"} tone="accent" />
          <Tile label="Blocked attempts" value={m ? `${m.blockedAttempts ?? 0} · ₹${inr(m.blockedAttemptedAmount ?? m.intercepted)}` : "—"} tone="frost" />
        </div>
      </header>

      <div className="flex min-h-0 flex-1">
        {/* graph */}
        <main className="relative min-w-0 flex-1">
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: "radial-gradient(rgba(255,255,255,0.05) 1px, transparent 1px)",
              backgroundSize: "26px 26px",
            }}
          />
          {snap ? (
            <ForceGraph nodes={snap.nodes} edges={snap.edges} />
          ) : (
            <div className="flex h-full items-center justify-center font-mono text-sm text-muted">
              connecting to stream…
            </div>
          )}
          {/* legend */}
          <div className="glass absolute bottom-4 left-4 flex items-center gap-4 rounded-xl px-4 py-2 font-mono text-[11px] text-muted">
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-[#3a3f45]" />normal</span>
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-amber" />suspicious</span>
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-danger" />ring</span>
            <span><span className="mr-1.5 inline-block h-2.5 w-2.5 rounded-full bg-frost" />held (any active hold)</span>
          </div>
        </main>

        {/* sidebar */}
        <aside className="flex w-95 shrink-0 flex-col gap-4 overflow-y-auto border-l border-line p-4">
          <section>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">
              Inject attack scenario
            </h2>
            <div className="space-y-2">
              {ATTACKS.map((a) => (
                <motion.button
                  key={a.pattern}
                  whileTap={{ scale: 0.97 }}
                  disabled={cooldown}
                  onClick={() => attack(a.pattern)}
                  className="lift-card danger glass w-full rounded-xl p-3 text-left disabled:opacity-40"
                >
                  <p className="text-sm font-semibold text-ink">⚡ {a.name}</p>
                  <p className="mt-0.5 text-xs text-muted">{a.desc}</p>
                </motion.button>
              ))}
            </div>
          </section>

          {freezeError && (
            <div role="alert" className="rounded-xl border border-danger/40 bg-danger/10 p-3 text-xs text-ink">
              {freezeError}
              {needSignIn && (
                <div className="mt-2">
                  <SignIn compact onDone={() => { setNeedSignIn(false); setFreezeError(null); }} />
                </div>
              )}
            </div>
          )}

          <section>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">
              Suspected rings {snap && snap.rings.length > 0 && `(${snap.rings.length})`}
            </h2>
            <div className="space-y-2">
              <AnimatePresence>
                {snap?.rings.length ? (
                  snap.rings.map((r) => (
                    <RingCard key={r.id} ring={r} onFreeze={freeze} onReport={openReport} busy={freezing} />
                  ))
                ) : (
                  <p className="rounded-xl border border-dashed border-line p-4 text-center text-xs text-muted">
                    No rings yet. Inject an attack and watch this panel.
                  </p>
                )}
              </AnimatePresence>
            </div>
          </section>

          <section>
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Alerts</h2>
            <div className="space-y-1.5">
              <AnimatePresence initial={false}>
                {snap?.alerts.map((a) => (
                  <motion.div
                    key={a.id}
                    layout
                    initial={{ opacity: 0, x: 24 }}
                    animate={{ opacity: 1, x: 0 }}
                    transition={{ duration: 0.35, ease: EASE }}
                    className={`rounded-lg border px-3 py-2 ${
                      a.severity === "critical"
                        ? "border-danger/40 bg-danger/10"
                        : a.severity === "warn"
                          ? "border-amber/30 bg-amber/5"
                          : "border-line bg-white/3"
                    }`}
                  >
                    <p className={`text-xs font-semibold ${
                      a.severity === "critical" ? "text-danger" : a.severity === "warn" ? "text-amber" : "text-ink"
                    }`}>
                      {a.title}
                    </p>
                    <p className="mt-0.5 text-[11px] leading-relaxed text-muted">{a.detail}</p>
                  </motion.div>
                ))}
              </AnimatePresence>
            </div>
          </section>

          <section className="min-h-40">
            <h2 className="mb-2 font-mono text-[11px] uppercase tracking-[0.25em] text-muted">Live stream</h2>
            <div className="space-y-1 font-mono text-[10.5px]">
              {snap?.feed.map((f, i) => (
                <p key={`${f.ts}-${i}`} className={`truncate ${f.flagged ? "text-danger" : "text-muted"}`}>
                  {f.flagged ? "⚑" : "·"} {f.fromVpa} → {f.toVpa} <span className="text-ink">₹{inr(f.amount)}</span>
                </p>
              ))}
            </div>
          </section>
        </aside>
      </div>

      {/* report modal */}
      <AnimatePresence>
        {report && (
          <motion.div
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-6"
            onClick={() => setReport(null)}
          >
            <motion.div
              initial={{ opacity: 0, y: 30, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={{ opacity: 0, y: 20, scale: 0.97 }}
              transition={{ duration: 0.35, ease: EASE }}
              className="glass-bright max-h-[80vh] w-full max-w-2xl overflow-y-auto rounded-2xl p-6"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="mb-4 flex items-center justify-between gap-3">
                <h3 className="font-(family-name:--font-display) text-lg font-bold">
                  Investigator report — {patternLabel(report.ring.pattern)}
                </h3>
                {report.source && (
                  <span className={`rounded-full px-3 py-1 font-mono text-[10px] uppercase tracking-widest ${
                    report.source === "claude" ? "bg-accent/15 text-accent" : "bg-white/10 text-muted"
                  }`}>
                    {report.source === "claude" ? "drafted by claude" : "template"}
                  </span>
                )}
              </div>
              {report.text ? (
                <>
                  <pre className="whitespace-pre-wrap font-mono text-xs leading-relaxed text-ink/90">
                    {report.text}
                  </pre>
                  <div className="mt-4 flex justify-end gap-2">
                    <button
                      onClick={() => navigator.clipboard.writeText(report.text!)}
                      className="rounded-lg border border-line px-4 py-2 text-xs font-semibold text-ink transition-colors hover:border-accent/50 hover:text-accent"
                    >
                      Copy
                    </button>
                    <button
                      onClick={() => setReport(null)}
                      className="rounded-lg bg-accent px-4 py-2 text-xs font-bold text-void"
                    >
                      Done
                    </button>
                  </div>
                </>
              ) : (
                <div className="flex items-center gap-3 py-6 text-sm text-muted">
                  <span className="h-4 w-4 animate-spin rounded-full border-2 border-line border-t-accent" />
                  Compiling evidence from the graph…
                </div>
              )}
            </motion.div>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}

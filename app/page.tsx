"use client";

import Link from "next/link";
import { motion, useReducedMotion } from "framer-motion";
import { LenisProvider } from "@/components/LenisProvider";
import { HowItHunts } from "@/components/HowItHunts";
import { CountUp, Magnetic, Reveal, Rise, WordReveal, EASE } from "@/components/anim";

const STACK = [
  "Streaming graph engine",
  "Union-find communities",
  "Suspicion propagation",
  "Server-Sent Events",
  "Next.js 16",
  "TypeScript",
  "d3-force",
  "Framer Motion",
  "GSAP ScrollTrigger",
  "Lenis",
  "Kafka-ready",
  "Neo4j-ready",
];

function Orbs() {
  const reduced = useReducedMotion();
  const float = (dx: number, dy: number, dur: number) =>
    reduced
      ? {}
      : {
          animate: { x: [0, dx, 0], y: [0, dy, 0], scale: [1, 1.12, 1] },
          transition: { duration: dur, repeat: Infinity, ease: "easeInOut" as const },
        };
  return (
    <div className="absolute inset-0 overflow-hidden" aria-hidden>
      <motion.div
        className="orb h-105 w-105 -left-30 -top-20"
        style={{ background: "radial-gradient(circle, rgba(0,229,160,0.32), transparent 65%)" }}
        {...float(70, 50, 17)}
      />
      <motion.div
        className="orb h-130 w-130 -right-40 top-10"
        style={{ background: "radial-gradient(circle, rgba(76,201,240,0.20), transparent 65%)" }}
        {...float(-60, 70, 21)}
      />
      <motion.div
        className="orb h-90 w-90 left-1/3 top-90"
        style={{ background: "radial-gradient(circle, rgba(255,77,94,0.16), transparent 65%)" }}
        {...float(50, -60, 19)}
      />
    </div>
  );
}

function HeroAlertCard() {
  const reduced = useReducedMotion();
  return (
    <motion.div
      initial={reduced ? false : { opacity: 0, y: 40, scale: 0.96 }}
      animate={{ opacity: 1, y: 0, scale: 1 }}
      transition={{ duration: 0.9, ease: EASE, delay: 1.15 }}
      className="glass-bright mx-auto mt-16 flex w-full max-w-lg items-center gap-4 rounded-2xl p-4 text-left"
    >
      <span className="relative flex h-3 w-3 shrink-0">
        <span className="live-dot absolute inline-flex h-full w-full rounded-full bg-danger" />
      </span>
      <div className="min-w-0">
        <p className="font-mono text-xs uppercase tracking-widest text-danger">
          critical · ring detected
        </p>
        <p className="truncate text-sm text-ink">
          Fan-out layering — 17 accounts, ₹3.86L moved in 90s. Confidence 91%.
        </p>
      </div>
      <span className="ml-auto shrink-0 rounded-lg border border-danger/40 bg-danger/10 px-3 py-1.5 font-mono text-xs font-semibold text-danger">
        FREEZE
      </span>
    </motion.div>
  );
}

function Marquee() {
  return (
    <div className="marquee-mask overflow-hidden border-y border-line py-5">
      <div className="marquee-track gap-4 pr-4">
        {[...STACK, ...STACK].map((item, i) => (
          <span
            key={i}
            className="glass shrink-0 rounded-full px-5 py-2 font-mono text-xs tracking-wide text-muted"
          >
            {item}
          </span>
        ))}
      </div>
    </div>
  );
}

const PROBLEMS = [
  {
    stat: "₹1,087 Cr",
    label: "of UPI fraud reported in India in FY24 alone (RBI) — the real number is far higher.",
  },
  {
    stat: "< 10 min",
    label: "for scam proceeds to be blasted through a mule network and withdrawn as cash.",
  },
  {
    stat: "1 txn at a time",
    label: "is how legacy systems check payments. The ring is invisible until you analyze the graph.",
  },
];

const STATS = [
  { to: 10000, suffix: "+", label: "transactions/sec ingest capacity" },
  { to: 2, prefix: "< ", suffix: "s", label: "from injection to ring detection" },
  { to: 90, suffix: "s", label: "sliding-window transaction graph" },
  { to: 3, suffix: "", label: "fraud patterns hunted: layering, loops, smurfing" },
];

export default function Landing() {
  return (
    <LenisProvider>
      <div className="relative">
        {/* nav */}
        <header className="fixed inset-x-0 top-0 z-50">
          <div className="mx-auto flex max-w-6xl items-center justify-between px-6 py-4">
            <Link href="/" className="flex items-center gap-2.5 font-(family-name:--font-display) text-lg font-bold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-md bg-accent font-mono text-sm text-void">
                ◉
              </span>
              NETRA
            </Link>
            <nav className="hidden items-center gap-8 text-sm text-muted sm:flex">
              <a href="#problem" className="transition-colors hover:text-ink">The problem</a>
              <a href="#engine" className="transition-colors hover:text-ink">Engine</a>
              <a href="#stats" className="transition-colors hover:text-ink">Numbers</a>
            </nav>
            <Magnetic>
              <Link
                href="/hunt"
                className="glass-bright rounded-full px-5 py-2 text-sm font-semibold text-accent transition-colors hover:text-ink"
              >
                Launch console →
              </Link>
            </Magnetic>
          </div>
        </header>

        {/* hero */}
        <section className="relative flex min-h-screen flex-col items-center justify-center px-6 pt-24 text-center">
          <Orbs />
          <motion.p
            initial={{ opacity: 0, y: 12 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.7, ease: EASE }}
            className="glass mb-8 rounded-full px-4 py-1.5 font-mono text-xs uppercase tracking-[0.25em] text-accent"
          >
            real-time upi fraud-ring detection
          </motion.p>
          <h1 className="relative max-w-4xl font-(family-name:--font-display) text-5xl font-bold leading-[1.05] tracking-tight sm:text-7xl">
            <WordReveal
              text="See the fraud ring before the money's gone."
              highlight={["ring", "money's"]}
              delay={0.15}
            />
          </h1>
          <motion.p
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 0.85 }}
            className="relative mt-6 max-w-2xl text-lg leading-relaxed text-muted"
          >
            Scam money doesn&apos;t sit still — it&apos;s blasted through mule accounts and
            cashed out in minutes. NETRA streams the transaction graph, lights the
            ring up red, and freezes it in one click.
          </motion.p>
          <motion.div
            initial={{ opacity: 0, y: 20 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.8, ease: EASE, delay: 1.0 }}
            className="relative mt-10 flex flex-wrap items-center justify-center gap-4"
          >
            <Magnetic>
              <Link
                href="/hunt"
                className="inline-block rounded-full bg-accent px-8 py-3.5 font-semibold text-void shadow-[0_0_40px_-8px_rgba(0,229,160,0.6)] transition-colors hover:bg-accent-dim"
              >
                Hunt a live attack →
              </Link>
            </Magnetic>
            <Magnetic>
              <a
                href="#engine"
                className="glass inline-block rounded-full px-8 py-3.5 font-semibold text-ink transition-colors hover:text-accent"
              >
                How it works
              </a>
            </Magnetic>
          </motion.div>
          <div className="relative w-full">
            <HeroAlertCard />
          </div>
        </section>

        <Marquee />

        {/* problem */}
        <section id="problem" className="mx-auto max-w-6xl px-6 py-28">
          <Reveal>
            <Rise>
              <p className="mb-3 font-mono text-xs uppercase tracking-[0.3em] text-danger">
                the problem
              </p>
            </Rise>
            <Rise>
              <h2 className="mb-14 max-w-2xl font-(family-name:--font-display) text-4xl font-semibold tracking-tight sm:text-5xl">
                Fraud isn&apos;t a transaction. It&apos;s a network.
              </h2>
            </Rise>
            <div className="grid gap-5 md:grid-cols-3">
              {PROBLEMS.map((p) => (
                <Rise key={p.stat}>
                  <div className="lift-card danger glass h-full rounded-3xl p-8">
                    <p className="font-(family-name:--font-display) text-4xl font-bold text-danger">
                      {p.stat}
                    </p>
                    <p className="mt-4 text-sm leading-relaxed text-muted">{p.label}</p>
                  </div>
                </Rise>
              ))}
            </div>
          </Reveal>
        </section>

        {/* pinned engine walkthrough */}
        <HowItHunts />

        {/* stats */}
        <section id="stats" className="mx-auto max-w-6xl px-6 py-28">
          <Reveal>
            <Rise>
              <p className="mb-3 font-mono text-xs uppercase tracking-[0.3em] text-accent">
                the numbers
              </p>
            </Rise>
            <Rise>
              <h2 className="mb-14 font-(family-name:--font-display) text-4xl font-semibold tracking-tight sm:text-5xl">
                Built to outrun the cash-out.
              </h2>
            </Rise>
            <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-4">
              {STATS.map((s2) => (
                <Rise key={s2.label}>
                  <div className="lift-card glass h-full rounded-3xl p-8">
                    <p className="font-(family-name:--font-display) text-4xl font-bold text-accent">
                      <CountUp to={s2.to} prefix={s2.prefix ?? ""} suffix={s2.suffix} />
                    </p>
                    <p className="mt-3 text-sm leading-relaxed text-muted">{s2.label}</p>
                  </div>
                </Rise>
              ))}
            </div>
          </Reveal>
        </section>

        {/* CTA */}
        <section className="relative overflow-hidden px-6 py-32">
          <Orbs />
          <Reveal className="relative mx-auto max-w-3xl text-center">
            <Rise>
              <h2 className="font-(family-name:--font-display) text-4xl font-bold tracking-tight sm:text-6xl">
                Watch a mule ring
                <br />
                <span className="text-danger">light up red.</span>
              </h2>
            </Rise>
            <Rise>
              <p className="mx-auto mt-6 max-w-xl text-muted">
                Inject a fan-out attack into a live stream of synthetic UPI traffic and
                watch the graph engine isolate the ring in seconds — then freeze it.
              </p>
            </Rise>
            <Rise>
              <div className="mt-10">
                <Magnetic>
                  <Link
                    href="/hunt"
                    className="inline-block rounded-full bg-accent px-10 py-4 text-lg font-semibold text-void shadow-[0_0_60px_-10px_rgba(0,229,160,0.7)] transition-colors hover:bg-accent-dim"
                  >
                    Launch the console →
                  </Link>
                </Magnetic>
              </div>
            </Rise>
          </Reveal>
        </section>

        <footer className="border-t border-line px-6 py-10 text-center">
          <p className="text-xs text-muted">
            NETRA — a hackathon build. All transactions are synthetic; no real financial
            data is used. Detection: hand-rolled streaming graph algorithms. Reports:
            Claude, as garnish.
          </p>
        </footer>
      </div>
    </LenisProvider>
  );
}

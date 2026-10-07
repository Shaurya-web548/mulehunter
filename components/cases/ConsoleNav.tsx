"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useSession } from "./Session";

const LINKS = [
  { href: "/hunt", label: "Live hunt" },
  { href: "/cases/new", label: "Report fraud" },
  { href: "/cases", label: "Cases" },
];

export function ConsoleNav() {
  const path = usePathname();
  const { session, signOut } = useSession();
  return (
    <header className="flex flex-wrap items-center gap-3 border-b border-line px-4 py-3">
      <Link href="/" className="flex items-center gap-2 font-(family-name:--font-display) font-bold tracking-tight">
        <span className="flex h-6 w-6 items-center justify-center rounded bg-accent font-mono text-xs text-void">◉</span>
        NETRA
      </Link>
      <nav aria-label="Console" className="ml-2 flex gap-1">
        {LINKS.map((l) => {
          const active = l.href === "/cases" ? path === "/cases" || (path.startsWith("/cases/") && path !== "/cases/new") : path === l.href;
          return (
            <Link
              key={l.href}
              href={l.href}
              aria-current={active ? "page" : undefined}
              className={`rounded-lg px-3 py-1.5 font-mono text-[11px] uppercase tracking-widest transition-colors ${active ? "bg-white/10 text-ink" : "text-muted hover:text-ink"}`}
            >
              {l.label}
            </Link>
          );
        })}
      </nav>
      <span className="ml-auto font-mono text-[10px] uppercase tracking-widest text-muted">Simulation — no real bank or UPI connection</span>
      {session && (
        <span className="flex items-center gap-2 font-mono text-[11px] text-muted">
          <span className={session.role === "operator" ? "text-accent" : "text-frost"}>{session.role}</span>
          {session.name}
          <button onClick={signOut} className="rounded border border-line px-2 py-0.5 hover:text-ink">
            Sign out
          </button>
        </span>
      )}
    </header>
  );
}

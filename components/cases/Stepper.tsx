"use client";

import { timeOf } from "@/lib/client/format";

export interface StepView {
  key: string;
  label: string;
  state: "done" | "active" | "pending" | "failed" | "skipped" | "stale" | "attention";
  detail: string;
  at: number | null;
}

const STYLE: Record<StepView["state"], { dot: string; text: string; word: string }> = {
  done: { dot: "bg-accent", text: "text-ink", word: "done" },
  active: { dot: "bg-amber live-dot", text: "text-amber", word: "in progress" },
  pending: { dot: "bg-white/15", text: "text-muted", word: "pending" },
  failed: { dot: "bg-danger", text: "text-danger", word: "failed" },
  skipped: { dot: "bg-white/25", text: "text-muted", word: "skipped" },
  stale: { dot: "bg-amber", text: "text-amber", word: "stale" },
  attention: { dot: "bg-amber", text: "text-amber", word: "needs attention" },
};

/** Workflow stepper — every state comes from the server's persisted case state. */
export function Stepper({ steps }: { steps: StepView[] }) {
  return (
    <ol className="grid gap-2 sm:grid-cols-7" aria-label="Case workflow">
      {steps.map((s, i) => {
        const st = STYLE[s.state];
        return (
          <li key={s.key} className="glass rounded-xl px-3 py-2">
            <div className="flex items-center gap-2">
              <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${st.dot}`} aria-hidden />
              <span className="font-mono text-[10px] text-muted">{i + 1}</span>
              <span className={`text-xs font-semibold ${st.text}`}>{s.label}</span>
            </div>
            <p className="mt-1 text-[11px] leading-snug text-muted">
              <span className="sr-only">Status: </span>
              <span className={st.text}>{st.word}</span>
              {s.at ? ` · ${timeOf(s.at)}` : ""}
            </p>
            <p className="mt-0.5 text-[11px] leading-snug text-muted">{s.detail}</p>
          </li>
        );
      })}
    </ol>
  );
}

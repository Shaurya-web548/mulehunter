import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { inr, label } from "@/lib/engine/engine";
import { assertSameOrigin } from "@/lib/auth/session";
import { DomainError } from "@/lib/contracts/types";
import { rateLimit } from "@/lib/http/api";
import { getEngine } from "@/lib/runtime";
import type { Ring } from "@/lib/engine/types";

export const maxDuration = 60;

// Legacy live-ring report for /hunt. The detection is all graph algorithms;
// Claude (optional) only turns already-computed evidence into prose. Falls
// back to a deterministic template with no API key, on refusal or on error.
//
// Personal details: by default account VPAs are replaced with pseudonyms
// (acct-1, acct-2, …) before anything is sent to the model; set
// MNH_LLM_SHARE_ACCOUNT_DETAILS=1 to send real VPAs. The template (no LLM)
// always shows real VPAs to the operator.

interface RingContext {
  ring: Ring;
  accounts: { vpa: string; score: number; ageDays: number; reasons: string[]; inflow: number; outflow: number }[];
}

function gatherContext(ring: Ring): RingContext {
  const engine = getEngine();
  const now = Date.now();
  const accounts = ring.accounts.map((id) => {
    const acc = engine.sim.accounts.get(id);
    const w = engine.graph.accounts.get(id);
    // peak score, not current — window activity may have expired by report time
    const s = engine.peakScores.get(id) ?? engine.scores.get(id);
    return {
      vpa: acc?.vpa ?? id,
      score: s?.score ?? 0,
      ageDays: acc ? Math.max(0, Math.round((now - acc.createdAt) / 86400_000)) : 0,
      reasons: s?.reasons ?? [],
      inflow: Math.round(w ? w.inflow.reduce((a, x) => a + x.amount, 0) : 0),
      outflow: Math.round(w ? w.outflow.reduce((a, x) => a + x.amount, 0) : 0),
    };
  });
  accounts.sort((a, b) => b.score - a.score);
  return { ring, accounts };
}

/** Replace VPAs with stable pseudonyms unless explicitly allowed. */
function forModel(ctx: RingContext): RingContext {
  if (process.env.MNH_LLM_SHARE_ACCOUNT_DETAILS === "1") return ctx;
  const accounts = ctx.accounts.map((a, i) => ({ ...a, vpa: `acct-${i + 1}` }));
  return { ring: { ...ctx.ring, accounts: accounts.map((a) => a.vpa) }, accounts };
}

function templateReport(ctx: RingContext): string {
  const { ring, accounts } = ctx;
  const lines = [
    `SUSPICIOUS ACTIVITY REPORT — ${new Date().toISOString()}`,
    ``,
    `Pattern: ${label(ring.pattern)}   Ring risk score: ${ring.score}/100 (heuristic, not a probability)   Status: ${ring.status.toUpperCase()}`,
    `Accounts involved: ${ring.accounts.length}   Funds moved (90s window): ₹${inr(ring.totalFlow)}`,
    ring.intercepted > 0
      ? `Blocked debit attempts after freeze: ${ring.blockedAttempts ?? 0} attempt(s), ₹${inr(ring.intercepted)} attempted (rejected by the simulated hold — not money recovered)`
      : ``,
    ``,
    `ACCOUNTS (by suspicion score):`,
    ...accounts.slice(0, 12).map(
      (a) =>
        `  • ${a.vpa} — score ${a.score}, age ${a.ageDays}d, in ₹${inr(a.inflow)} / out ₹${inr(a.outflow)}${
          a.reasons.length ? ` — ${a.reasons[0]}` : ""
        }`,
    ),
    ``,
    `RECOMMENDED ACTIONS (for the investigating officer to decide):`,
    `  1. Review each account's evidence; maintain simulated debit holds only where it supports them.`,
    `  2. File STR with FIU-IND where warranted.`,
    `  3. Identify the origin (victim) transaction via a complaint case (Report fraud) and coordinate chargeback per NPCI UDIR.`,
    `  4. Share cash-out account details with the acquiring bank's fraud desk.`,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req, false);
    rateLimit(req, "legacy:report", 10, 0.3);
  } catch (err) {
    if (err instanceof DomainError) return NextResponse.json({ error: err.code.toLowerCase(), message: err.message }, { status: err.status });
    throw err;
  }
  let ringId: string;
  try {
    ringId = (await req.json()).ringId;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const ring = getEngine().ringById(ringId);
  if (!ring) return NextResponse.json({ error: "not_found" }, { status: 404 });

  const ctx = gatherContext(ring);

  if (!process.env.ANTHROPIC_API_KEY) {
    return NextResponse.json({ report: templateReport(ctx), source: "template" });
  }

  try {
    const client = new Anthropic();
    const response = await client.beta.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-5-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      // server-side refusal fallback: a declined request is re-run on a
      // fallback model inside the same call instead of silently failing
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
      system:
        "You write concise investigator reports for a bank's fraud operations team. Plain text, no markdown headers deeper than caps lines. Be specific with numbers given; never invent account details. Scores are heuristic risk scores, not probabilities; blocked attempted amounts are not recovered money.",
      messages: [
        {
          role: "user",
          content: `A real-time graph engine flagged this suspected UPI mule ring. Write a suspicious-activity report (~250 words): summary, how the pattern works, key accounts, recommended actions per Indian banking practice (STR to FIU-IND, NPCI UDIR chargeback, KYC re-verification).\n\n${JSON.stringify(forModel(ctx), null, 2)}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text || response.stop_reason === "refusal") {
      return NextResponse.json({ report: templateReport(ctx), source: "template" });
    }
    return NextResponse.json({ report: text, source: "claude" });
  } catch (err) {
    console.error("[api/report] Claude call failed; using template", err instanceof Error ? err.message : err);
    return NextResponse.json({ report: templateReport(ctx), source: "template" });
  }
}

import Anthropic from "@anthropic-ai/sdk";
import { NextRequest, NextResponse } from "next/server";
import { getEngine, inr, label } from "@/lib/engine/engine";
import type { Ring } from "@/lib/engine/types";

export const maxDuration = 60;

// The one place an LLM appears — as garnish. The detection is all graph
// algorithms; Claude just turns a detected ring into an investigator-ready
// narrative. Falls back to a deterministic template with no API key.

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
    const s = engine.scores.get(id);
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

function templateReport(ctx: RingContext): string {
  const { ring, accounts } = ctx;
  const lines = [
    `SUSPICIOUS ACTIVITY REPORT — ${new Date().toISOString()}`,
    ``,
    `Pattern: ${label(ring.pattern)}   Confidence: ${ring.score}%   Status: ${ring.status.toUpperCase()}`,
    `Accounts involved: ${ring.accounts.length}   Funds moved (90s window): ₹${inr(ring.totalFlow)}`,
    ring.intercepted > 0 ? `Funds intercepted by freeze: ₹${inr(ring.intercepted)}` : ``,
    ``,
    `ACCOUNTS (by suspicion score):`,
    ...accounts.slice(0, 12).map(
      (a) =>
        `  • ${a.vpa} — score ${a.score}, age ${a.ageDays}d, in ₹${inr(a.inflow)} / out ₹${inr(a.outflow)}${
          a.reasons.length ? ` — ${a.reasons[0]}` : ""
        }`,
    ),
    ``,
    `RECOMMENDED ACTIONS:`,
    `  1. Maintain debit freeze on all listed accounts pending KYC re-verification.`,
    `  2. File STR with FIU-IND referencing the layering pattern above.`,
    `  3. Trace the origin (victim) transaction and initiate chargeback per NPCI UDIR.`,
    `  4. Share cash-out account details with the acquiring bank's fraud desk.`,
  ].filter(Boolean);
  return lines.join("\n");
}

export async function POST(req: NextRequest) {
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
    const response = await client.messages.create({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-5",
      max_tokens: 2000,
      output_config: { effort: "low" },
      system:
        "You write concise investigator reports for a bank's fraud operations team. Plain text, no markdown headers deeper than caps lines. Be specific with numbers given; never invent account details.",
      messages: [
        {
          role: "user",
          content: `A real-time graph engine detected this UPI mule ring. Write a suspicious-activity report (~250 words): summary, how the pattern works, key accounts, recommended actions per Indian banking practice (STR to FIU-IND, NPCI UDIR chargeback, KYC re-verification).\n\n${JSON.stringify(ctx, null, 2)}`,
        },
      ],
    });
    const text = response.content.find((b) => b.type === "text")?.text;
    if (!text || response.stop_reason === "refusal") {
      return NextResponse.json({ report: templateReport(ctx), source: "template" });
    }
    return NextResponse.json({ report: text, source: "claude" });
  } catch {
    return NextResponse.json({ report: templateReport(ctx), source: "template" });
  }
}

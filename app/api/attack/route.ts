import { NextRequest, NextResponse } from "next/server";
import { assertSameOrigin } from "@/lib/auth/session";
import { DomainError } from "@/lib/contracts/types";
import { rateLimit } from "@/lib/http/api";
import { getEngine } from "@/lib/runtime";
import type { Pattern } from "@/lib/engine/types";

const PATTERNS: Pattern[] = ["fanout_layering", "circular_routing", "smurfing"];

/**
 * Inject a simulated attack scenario (public demo control on /hunt). Its
 * payments are queued and executed through the admission gate like all other
 * traffic. Same-origin + rate limited; response shape unchanged.
 */
export async function POST(req: NextRequest) {
  try {
    assertSameOrigin(req, false);
    rateLimit(req, "legacy:attack", 6, 0.2);
  } catch (err) {
    if (err instanceof DomainError) return NextResponse.json({ error: err.code.toLowerCase(), message: err.message }, { status: err.status });
    throw err;
  }
  let pattern: Pattern;
  try {
    const body = await req.json();
    pattern = body.pattern;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  if (!PATTERNS.includes(pattern)) {
    return NextResponse.json({ error: "unknown_pattern" }, { status: 400 });
  }
  const scn = getEngine().launch(pattern);
  // `amount` (rupees) kept for old clients; `amountMinor` is authoritative
  return NextResponse.json({ ok: true, scenarioId: scn.id, amount: scn.amountMinor / 100, amountMinor: scn.amountMinor });
}

import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";
import type { Pattern } from "@/lib/engine/types";

const PATTERNS: Pattern[] = ["fanout_layering", "circular_routing", "smurfing"];

export async function POST(req: NextRequest) {
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
  return NextResponse.json({ ok: true, scenarioId: scn.id, amount: scn.amount });
}

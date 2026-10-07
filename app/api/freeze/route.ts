import { NextRequest, NextResponse } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { DomainError } from "@/lib/contracts/types";
import { rateLimit } from "@/lib/http/api";
import { getEngine } from "@/lib/runtime";

/**
 * Legacy live-console ring freeze. Kept for the /hunt console (response
 * shape unchanged: `{ ok, ring }` / `{ error }`), but it now requires an
 * operator session + CSRF header and creates durable LEGACY_RING holds via
 * the hold service, which the admission gate enforces for every payment path.
 */
export async function POST(req: NextRequest) {
  try {
    const session = requireRole(req, "operator");
    rateLimit(req, "legacy:freeze", 20, 1);
    let ringId: unknown;
    try {
      ringId = (await req.json()).ringId;
    } catch {
      return NextResponse.json({ error: "bad_request" }, { status: 400 });
    }
    if (typeof ringId !== "string" || !ringId) return NextResponse.json({ error: "bad_request" }, { status: 400 });
    const ring = getEngine().freeze(ringId, actorOf(session));
    if (!ring) return NextResponse.json({ error: "not_found" }, { status: 404 });
    return NextResponse.json({ ok: true, ring });
  } catch (err) {
    if (err instanceof DomainError) return NextResponse.json({ error: err.code.toLowerCase(), message: err.message }, { status: err.status });
    console.error("[api/freeze]", err);
    return NextResponse.json({ error: "internal_error" }, { status: 500 });
  }
}

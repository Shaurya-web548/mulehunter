import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { fail, handle, intParam, ok } from "@/lib/http/api";
import { getEngine } from "@/lib/runtime";

/** Victim lookup by VPA fragment or exact account id (bounded). */
export const GET = handle(async (req: NextRequest) => {
  requireRole(req, "viewer");
  const q = (req.nextUrl.searchParams.get("q") ?? "").trim();
  if (q.length < 3 || q.length > 80) return fail("BAD_REQUEST", "search needs 3–80 characters", 400);
  const engine = getEngine();
  const limit = intParam(req.nextUrl.searchParams.get("limit"), 10, 1, 25);
  const rows = engine.store.accounts.search(engine.runId, q, limit).filter((a) => a.kind !== "sink");
  return ok(rows.map((a) => ({ id: a.id, vpa: a.vpa, name: a.name, kind: a.kind, createdAt: a.createdAt })));
});

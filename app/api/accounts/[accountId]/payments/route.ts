import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { handle, intParam, ok } from "@/lib/http/api";
import { listDisputeCandidates } from "@/lib/modules/cases/intake";
import { getStore } from "@/lib/runtime";

/**
 * A victim's accepted outgoing payments in a window — shown for EXPLICIT
 * selection when the reporter does not know transaction ids. Nothing is
 * pre-selected or disputed automatically.
 */
export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ accountId: string }> }) => {
  requireRole(req, "viewer");
  const { accountId } = await ctx.params;
  const sp = req.nextUrl.searchParams;
  const now = Date.now();
  const to = intParam(sp.get("to"), now, 0, Number.MAX_SAFE_INTEGER);
  const from = intParam(sp.get("from"), to - 24 * 3600_000, 0, to);
  const limit = intParam(sp.get("limit"), 50, 1, 100);
  return ok(listDisputeCandidates(getStore(), accountId, from, to, limit));
});

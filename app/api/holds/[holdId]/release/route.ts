import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { handle, ok, rateLimit, readJson } from "@/lib/http/api";
import { releaseHold } from "@/lib/modules/protection/holds";
import { getStore } from "@/lib/runtime";

/** Release exactly this hold (operator + reason). Other holds on the account stay active. */
export const POST = handle(async (req: NextRequest, ctx: { params: Promise<{ holdId: string }> }) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "holds:release", 20, 1);
  const { holdId } = await ctx.params;
  const body = await readJson<{ reason?: string }>(req);
  const r = releaseHold(getStore(), { holdId, reason: String(body.reason ?? ""), actorId: actorOf(session), now: Date.now() });
  return ok(r);
});

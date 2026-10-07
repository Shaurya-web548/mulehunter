import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { handle, ok } from "@/lib/http/api";
import { computeOutcome } from "@/lib/modules/outcomes/outcome";
import { getStore } from "@/lib/runtime";

/** Factual, qualified outcome accounting (see lib/modules/outcomes/outcome.ts). */
export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  return ok(computeOutcome(getStore(), caseId));
});

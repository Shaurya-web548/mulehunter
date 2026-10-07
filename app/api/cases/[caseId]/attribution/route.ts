import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { handle, ok } from "@/lib/http/api";
import { computeAttribution } from "@/lib/modules/attribution/job";
import { getStore } from "@/lib/runtime";

/** Where the victim's money is now, per account (PROPORTIONAL model), plus recoverable amounts. */
export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  const a = computeAttribution(getStore(), caseId);
  // flows can be long; the UI needs the largest victim-share movements
  return ok({ ...a, flows: [...a.flows].sort((x, y) => y.victimShareMinor - x.victimShareMinor).slice(0, 200) });
});

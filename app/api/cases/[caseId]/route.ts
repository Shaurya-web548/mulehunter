import type { NextRequest } from "next/server";
import { requireRole } from "@/lib/auth/session";
import { handle, ok } from "@/lib/http/api";
import { caseView } from "@/lib/modules/cases/queries";
import { getStore } from "@/lib/runtime";

/** Case, disputed payments, holds, trace/analysis revisions, actions, stepper and audit. */
export const GET = handle(async (req: NextRequest, ctx: { params: Promise<{ caseId: string }> }) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  return ok(caseView(getStore(), caseId));
});

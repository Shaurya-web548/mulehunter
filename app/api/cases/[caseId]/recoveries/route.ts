import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, ok, rateLimit, readJson } from "@/lib/http/api";
import { recoverFunds } from "@/lib/modules/recovery/recover";
import { getStore } from "@/lib/runtime";

type Ctx = { params: Promise<{ caseId: string }> };

/**
 * Return the victim's attributed money from accounts this case has frozen
 * (operator). Body: { reason, actionKey, accountIds? }.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "cases:recover", 10, 0.5);
  const { caseId } = await ctx.params;
  const body = await readJson<{ reason?: string; actionKey?: string; accountIds?: unknown }>(req);
  if (body.accountIds !== undefined && !Array.isArray(body.accountIds)) return fail("BAD_REQUEST", "accountIds must be an array", 400);
  const r = recoverFunds(getStore(), {
    caseId,
    accountIds: body.accountIds as string[] | undefined,
    reason: String(body.reason ?? ""),
    actionKey: String(body.actionKey ?? ""),
    actorId: actorOf(session),
    now: Date.now(),
  });
  return ok(r, r.replayed ? 200 : 201);
});

/** Recovery actions and transfers of the case. */
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  const store = getStore();
  if (!store.cases.get(caseId)) return fail("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  return ok({ actions: store.recoveries.actionsForCase(caseId), transfers: store.recoveries.listForCase(caseId) });
});

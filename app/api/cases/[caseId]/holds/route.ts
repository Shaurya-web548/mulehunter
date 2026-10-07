import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, ok, rateLimit, readJson } from "@/lib/http/api";
import { protectVictim } from "@/lib/modules/protection/holds";
import { freezeCandidates } from "@/lib/modules/enforcement/freeze";
import type { EnforcementPolicy } from "@/lib/contracts/types";
import { getStore } from "@/lib/runtime";

type Ctx = { params: Promise<{ caseId: string }> };

/**
 * Operator actions creating holds:
 *   { kind: "VICTIM_PROTECTION", reason }
 *   { kind: "MULE_DEBIT_FREEZE", analysisRevision, policy: "MANUAL"|"AUTO_DEMO",
 *     accountIds?, reason, actionKey }
 * Eligibility is re-derived on the server from the named analysis revision.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "cases:holds", 20, 1);
  const { caseId } = await ctx.params;
  const body = await readJson<{ kind?: string; reason?: string; analysisRevision?: number; policy?: string; accountIds?: unknown; actionKey?: string }>(req);
  const store = getStore();
  const actorId = actorOf(session);
  if (body.kind === "VICTIM_PROTECTION") {
    const hold = protectVictim(store, { caseId, reason: String(body.reason ?? ""), actorId, now: Date.now() });
    return ok({ hold }, 201);
  }
  if (body.kind === "MULE_DEBIT_FREEZE") {
    if (body.accountIds !== undefined && (!Array.isArray(body.accountIds) || !body.accountIds.every((x) => typeof x === "string"))) {
      return fail("BAD_REQUEST", "accountIds must be an array of account ids", 400);
    }
    const r = freezeCandidates(store, {
      caseId,
      analysisRevision: Number(body.analysisRevision),
      policy: (body.policy ?? "MANUAL") as EnforcementPolicy,
      accountIds: body.accountIds as string[] | undefined,
      reason: String(body.reason ?? ""),
      actionKey: String(body.actionKey ?? ""),
      actorId,
      now: Date.now(),
    });
    return ok(r, r.replayed ? 200 : 201);
  }
  return fail("BAD_REQUEST", "kind must be VICTIM_PROTECTION or MULE_DEBIT_FREEZE", 400);
});

/**
 * POST /api/cases — file a complaint: validate against the ledger, then create
 *   the case, disputed-payment facts, the optional victim-protection hold,
 *   audit and outbox in ONE transaction. The response reflects committed state.
 * GET  /api/cases — keyset-paginated, filtered case list (viewer).
 *   Compat: `?id=` returns one case detail (the prior intake route's shape).
 */
import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, intParam, ok, rateLimit, readJson } from "@/lib/http/api";
import { createCaseFromComplaint, getCaseDetail, type ComplaintInput } from "@/lib/modules/cases/intake";
import type { CaseStatus } from "@/lib/contracts/types";
import { getStore } from "@/lib/runtime";

const STATUSES: CaseStatus[] = ["REPORTED", "VALIDATED", "TRACING", "ANALYZED", "UNDER_REVIEW", "CLOSED", "NEEDS_EVIDENCE"];

export const POST = handle(async (req: NextRequest) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "cases:create", 20, 1);
  const body = await readJson<Partial<ComplaintInput>>(req);
  const result = createCaseFromComplaint(getStore(), {
    victimAccountId: body.victimAccountId as string,
    incidentStartTs: body.incidentStartTs as number,
    incidentEndTs: body.incidentEndTs as number,
    disputedTxnIds: body.disputedTxnIds as string[],
    narrative: body.narrative as string,
    declaredLossMinor: body.declaredLossMinor,
    protectVictim: body.protectVictim,
    idempotencyKey: body.idempotencyKey ?? null,
    reporterId: body.reporterId,
    // actor comes from the server session, never from the body
    actorId: actorOf(session),
  });
  return ok(result, result.replayed ? 200 : 201);
});

export const GET = handle(async (req: NextRequest) => {
  requireRole(req, "viewer");
  const store = getStore();
  const sp = req.nextUrl.searchParams;
  const id = sp.get("id");
  if (id) {
    const detail = getCaseDetail(store, id);
    return detail ? ok(detail) : fail("CASE_NOT_FOUND", `case ${id} does not exist`, 404);
  }
  const status = sp.get("status");
  if (status && !STATUSES.includes(status as CaseStatus)) return fail("BAD_REQUEST", `status must be one of ${STATUSES.join(", ")}`, 400);
  const page = store.cases.page({
    status: (status as CaseStatus) || undefined,
    victimAccountId: sp.get("victim") || undefined,
    cursor: sp.get("cursor"),
    limit: intParam(sp.get("limit"), 25, 1, 100),
  });
  const items = page.items.map((c) => ({
    ...c,
    victimVpa: store.accounts.get(c.victimAccountId)?.vpa ?? c.victimAccountId,
    disputedTotalMinor: store.cases.disputed(c.id).reduce((s, d) => s + d.amountMinor, 0),
    activeHolds: store.holds.listForCase(c.id).filter((h) => h.status === "ACTIVE").length,
  }));
  return ok({ items, nextCursor: page.nextCursor });
});

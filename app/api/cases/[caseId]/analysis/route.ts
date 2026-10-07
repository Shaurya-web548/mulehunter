import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, intParam, ok, rateLimit, readJson } from "@/lib/http/api";
import { runAnalysis } from "@/lib/modules/analysis/job";
import { computeAttribution } from "@/lib/modules/attribution/job";
import { getStore } from "@/lib/runtime";

type Ctx = { params: Promise<{ caseId: string }> };

/** Analyze a specific immutable trace revision (default: latest completed). */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "cases:analysis", 10, 0.5);
  const { caseId } = await ctx.params;
  const body = await readJson<{ traceRevision?: number; idempotencyKey?: string }>(req);
  if (body.traceRevision !== undefined && (!Number.isInteger(body.traceRevision) || body.traceRevision < 1)) {
    return fail("BAD_REQUEST", "traceRevision must be a positive integer", 400);
  }
  const r = runAnalysis(getStore(), { caseId, actorId: actorOf(session), now: Date.now(), traceRevision: body.traceRevision, idempotencyKey: body.idempotencyKey ?? null });
  return ok({ run: r.run, replayed: r.replayed }, r.replayed ? 200 : 201);
});

/** Findings, candidates (risk scores, contributions, eligibility) and evidence of a revision. */
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  const store = getStore();
  if (!store.cases.get(caseId)) return fail("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  const latest = store.analysis.latestRun(caseId);
  if (!latest) return ok({ run: null, latestRevision: null, findings: [], candidates: [] });
  const rev = intParam(req.nextUrl.searchParams.get("revision"), latest.revision, 1, latest.revision);
  const run = store.analysis.run(caseId, rev);
  if (!run) return fail("REVISION_NOT_FOUND", `analysis revision ${rev} does not exist`, 404);
  const vpa = (id: string) => store.accounts.get(id)?.vpa ?? id;
  const holds = store.holds.listForCase(caseId);
  // what freezing each account protects: the victim's money in it right now
  const victimMoney = new Map(computeAttribution(store, caseId).accounts.map((a) => [a.accountId, a.heldMinor]));
  return ok({
    run,
    latestRevision: latest.revision,
    findings: store.analysis.listFindings(caseId, rev).map((f) => ({ ...f, accountVpas: f.accountIds.map(vpa) })),
    candidates: store.analysis.listCandidates(caseId, rev).map((c) => ({
      ...c,
      vpa: vpa(c.accountId),
      victimMoneyMinor: victimMoney.get(c.accountId) ?? 0,
      caseHold: holds.find((h) => h.accountId === c.accountId && h.type === "MULE_DEBIT_FREEZE" && h.status === "ACTIVE")?.id ?? null,
      suspectedInOtherCases: store.analysis.suspectedIn(c.accountId).filter((id) => id !== caseId),
    })),
  });
});

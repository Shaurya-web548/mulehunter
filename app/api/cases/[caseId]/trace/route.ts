import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, intParam, ok, rateLimit, readJson } from "@/lib/http/api";
import { loadSnapshot, runTrace } from "@/lib/modules/tracing/job";
import type { TraceConfig } from "@/lib/modules/tracing/trace";
import { getStore } from "@/lib/runtime";

type Ctx = { params: Promise<{ caseId: string }> };

/**
 * Start a bounded trace revision. Idempotent with `idempotencyKey`. The job
 * runs synchronously within its runtime budget; the response is the
 * committed revision (DONE) or an error after the FAILED state committed.
 */
export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "cases:trace", 10, 0.5);
  const { caseId } = await ctx.params;
  const body = await readJson<{ idempotencyKey?: string; config?: Partial<TraceConfig> }>(req);
  const r = runTrace(getStore(), { caseId, actorId: actorOf(session), now: Date.now(), idempotencyKey: body.idempotencyKey ?? null, config: body.config });
  return ok({ run: r.run, replayed: r.replayed }, r.replayed ? 200 : 201);
});

/** Trace status + immutable snapshot (graph, paths, cycles, limits, coverage) of a revision. */
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  const store = getStore();
  if (!store.cases.get(caseId)) return fail("CASE_NOT_FOUND", `case ${caseId} does not exist`, 404);
  const runs = store.tracing.listForCase(caseId);
  if (!runs.length) return ok({ runs: [], run: null, snapshot: null });
  const rev = intParam(req.nextUrl.searchParams.get("revision"), runs[0].revision, 1, runs[0].revision);
  const run = runs.find((r) => r.revision === rev);
  if (!run) return fail("REVISION_NOT_FOUND", `trace revision ${rev} does not exist`, 404);
  return ok({ runs, run, snapshot: run.status === "DONE" ? loadSnapshot(store, caseId, rev) : null });
});

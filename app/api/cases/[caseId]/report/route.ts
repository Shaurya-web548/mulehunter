import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, ok, rateLimit } from "@/lib/http/api";
import { exportReport, renderCaseReport } from "@/lib/modules/reports/report";
import { getStore } from "@/lib/runtime";

type Ctx = { params: Promise<{ caseId: string }> };

/**
 * GET  — deterministic report from persisted evidence.
 *   ?format=md (download) | json (default) · ?snapshot=<reportId> for a stored export
 * POST — store an immutable, content-hashed export snapshot (operator).
 */
export const GET = handle(async (req: NextRequest, ctx: Ctx) => {
  requireRole(req, "viewer");
  const { caseId } = await ctx.params;
  const store = getStore();
  const sp = req.nextUrl.searchParams;
  const snapshotId = sp.get("snapshot");
  let body: string;
  let meta: Record<string, unknown>;
  if (snapshotId) {
    const s = store.reports.get(snapshotId);
    if (!s || s.caseId !== caseId) return fail("REPORT_NOT_FOUND", `report ${snapshotId} does not exist for this case`, 404);
    body = s.body;
    meta = { id: s.id, version: s.reportVersion, contentHash: s.contentHash, createdAt: s.createdAt, stored: true };
  } else {
    const r = renderCaseReport(store, caseId);
    body = r.markdown;
    meta = { version: r.version, contentHash: r.contentHash, asOf: r.asOf, stored: false };
  }
  if (sp.get("format") === "md") {
    return new Response(body, {
      headers: {
        "Content-Type": "text/markdown; charset=utf-8",
        "Content-Disposition": `attachment; filename="${caseId}-report.md"`,
        "X-Content-Hash": String(meta.contentHash),
      },
    });
  }
  return ok({ ...meta, markdown: body });
});

export const POST = handle(async (req: NextRequest, ctx: Ctx) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "cases:report", 10, 0.5);
  const { caseId } = await ctx.params;
  const r = exportReport(getStore(), caseId, actorOf(session), Date.now());
  return ok({ id: r.report.id, contentHash: r.report.contentHash, createdAt: r.report.createdAt, created: r.created }, r.created ? 201 : 200);
});

import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { fail, handle, ok, rateLimit, readJson } from "@/lib/http/api";
import { admitPayment } from "@/lib/modules/payments/admission";
import { recordSystemEvent } from "@/lib/modules/audit/events";
import { getEngine } from "@/lib/runtime";

/**
 * Manual simulated payment (operator) — e.g. to show that a held account's
 * next debit is rejected. Uses the same admission gate as all other traffic.
 * `attemptId` makes retries idempotent.
 */
export const POST = handle(async (req: NextRequest) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "payments", 20, 1);
  const body = await readJson<{ fromId?: string; toId?: string; amountMinor?: number; attemptId?: string }>(req);
  if (typeof body.fromId !== "string" || typeof body.toId !== "string") return fail("BAD_REQUEST", "fromId and toId are required", 400);
  if (body.attemptId !== undefined && (typeof body.attemptId !== "string" || body.attemptId.length < 8 || body.attemptId.length > 80)) {
    return fail("BAD_REQUEST", "attemptId must be 8–80 characters", 400);
  }
  const engine = getEngine();
  const now = Date.now();
  const r = admitPayment(engine.store, {
    attemptId: body.attemptId ? `manual:${body.attemptId}` : undefined,
    runId: engine.runId,
    fromId: body.fromId,
    toId: body.toId,
    amountMinor: Number(body.amountMinor),
    ts: now,
    channel: "MANUAL",
  });
  if (!r.replayed) {
    recordSystemEvent(engine.store, { actorId: actorOf(session), action: "MANUAL_PAYMENT", detail: { attemptId: r.attemptId, status: r.status, rejectReason: r.rejectReason }, at: now });
  }
  return ok({ attemptId: r.attemptId, status: r.status, rejectReason: r.rejectReason, holdId: r.holdId, txnId: r.txnId, replayed: r.replayed });
});

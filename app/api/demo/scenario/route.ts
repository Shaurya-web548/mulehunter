import type { NextRequest } from "next/server";
import { actorOf, requireRole } from "@/lib/auth/session";
import { handle, ok, rateLimit, readJson } from "@/lib/http/api";
import { seedComplaintDemo } from "@/lib/modules/demo/scenario";
import { recordSystemEvent } from "@/lib/modules/audit/events";
import { getEngine } from "@/lib/runtime";

/**
 * Seed the deterministic complaint demo (operator). All payments are queued
 * and later executed through the admission gate. The response names only the
 * victim and timing — never which accounts the simulator labelled as mules.
 */
export const POST = handle(async (req: NextRequest) => {
  const session = requireRole(req, "operator");
  rateLimit(req, "demo:seed", 5, 0.1);
  const body = await readJson<{ cashOutDelaySec?: number }>(req);
  const engine = getEngine();
  const now = Date.now();
  const demo = seedComplaintDemo(engine, now, { cashOutDelaySec: typeof body.cashOutDelaySec === "number" ? body.cashOutDelaySec : undefined });
  recordSystemEvent(engine.store, { actorId: actorOf(session), action: "DEMO_SCENARIO_SEEDED", detail: { victimId: demo.victimId }, at: now });
  return ok({ victimId: demo.victimId, victimVpa: demo.victimVpa, seedAt: demo.seedAt, layeringDoneAt: demo.layeringDoneAt, firstCashOutAt: demo.firstCashOutAt }, 201);
});

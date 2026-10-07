import { actorOf, checkOperatorCode, clearSessionCookie, issueSession, sessionCookie, sessionFrom, assertSameOrigin } from "@/lib/auth/session";
import { fail, handle, ok, rateLimit, readJson } from "@/lib/http/api";

/** Current session (or null). */
export const GET = handle(async (req: Request) => {
  const s = sessionFrom(req);
  return ok(s ? { role: s.role, name: s.sub, actorId: actorOf(s), expiresAt: s.exp } : null);
});

/**
 * Sign in. `viewer` needs only a name; `operator` also needs the operator
 * code (MNH_OPERATOR_CODE, or the code printed in the server console).
 */
export const POST = handle(async (req: Request) => {
  assertSameOrigin(req);
  rateLimit(req, "session", 10, 0.2);
  const body = await readJson<{ role?: string; name?: string; code?: string }>(req);
  const role = body.role === "operator" ? "operator" : body.role === "viewer" ? "viewer" : null;
  if (!role) return fail("BAD_REQUEST", "role must be viewer or operator", 400);
  const name = typeof body.name === "string" ? body.name.trim().replace(/[^\w .@-]/g, "").slice(0, 40) : "";
  if (name.length < 2) return fail("BAD_REQUEST", "enter your name (2–40 characters)", 400);
  if (role === "operator" && !checkOperatorCode(body.code)) return fail("INVALID_CODE", "operator code is incorrect", 401);
  const { token, session } = issueSession(role, name);
  return ok({ role: session.role, name: session.sub, actorId: actorOf(session), expiresAt: session.exp }, 200, { "Set-Cookie": sessionCookie(token) });
});

export const DELETE = handle(async (req: Request) => {
  assertSameOrigin(req);
  return ok(null, 200, { "Set-Cookie": clearSessionCookie() });
});

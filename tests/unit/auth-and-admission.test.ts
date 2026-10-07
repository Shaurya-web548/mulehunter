/**
 * Server authorization primitives and admission hardening (review findings).
 */
import test from "node:test";
import assert from "node:assert/strict";

process.env.MNH_OPERATOR_CODE = "unit-test-operator-code";

const { issueSession, verifySession, requireRole, checkOperatorCode, SESSION_COOKIE, CSRF_HEADER } = await import("../../lib/auth/session.ts");
const { rateLimit } = await import("../../lib/http/api.ts");
const { initDb } = await import("../../lib/persistence/init.ts");
const { DomainError } = await import("../../lib/contracts/types.ts");

const code = (c: string) => (e: unknown) => e instanceof DomainError && e.code === c;

function req(method: string, token: string | null, headers: Record<string, string> = {}) {
  const h: Record<string, string> = { host: "localhost:3000", ...headers };
  if (token) h.cookie = `${SESSION_COOKIE}=${token}`;
  return new Request("http://localhost:3000/api/x", { method, headers: h });
}

test("sessions are signed: tampering or expiry invalidates them", () => {
  const { token } = issueSession("viewer", "ravi", 1_000);
  assert.equal(verifySession(token, 2_000)?.role, "viewer");
  const [payload, sig] = token.split(".");
  const forged = Buffer.from(JSON.stringify({ sub: "ravi", role: "operator", iat: 1_000, exp: 9e15 })).toString("base64url");
  assert.equal(verifySession(`${forged}.${sig}`, 2_000), null, "role escalation by editing the payload fails");
  assert.equal(verifySession(`${payload}.${sig}x`, 2_000), null);
  assert.equal(verifySession(token, 1_000 + 9 * 3600_000), null, "expired");
});

test("roles and CSRF are enforced on the server", () => {
  const viewer = issueSession("viewer", "v").token;
  const operator = issueSession("operator", "o").token;
  assert.throws(() => requireRole(req("GET", null), "viewer"), code("UNAUTHENTICATED"));
  assert.equal(requireRole(req("GET", viewer), "viewer").role, "viewer");
  assert.throws(() => requireRole(req("POST", viewer, { [CSRF_HEADER]: "1" }), "operator"), code("FORBIDDEN"));
  assert.throws(() => requireRole(req("POST", operator), "operator"), code("CSRF_REJECTED"), "missing CSRF header");
  assert.throws(() => requireRole(req("POST", operator, { [CSRF_HEADER]: "1", origin: "https://evil.example" }), "operator"), code("CSRF_REJECTED"));
  assert.equal(requireRole(req("POST", operator, { [CSRF_HEADER]: "1", origin: "http://localhost:3000" }), "operator").role, "operator");
});

test("operator sign-in locks after repeated wrong codes, regardless of client identity", () => {
  const t0 = 10_000_000;
  assert.equal(checkOperatorCode("unit-test-operator-code", t0), true);
  for (let i = 0; i < 10; i++) assert.equal(checkOperatorCode(`wrong-${i}`, t0 + i), false);
  assert.throws(() => checkOperatorCode("unit-test-operator-code", t0 + 20), code("SIGN_IN_LOCKED"), "even the right code is refused while locked");
  assert.equal(checkOperatorCode("unit-test-operator-code", t0 + 6 * 60_000), true, "lock expires");
});

test("rotating x-forwarded-for does not buy a fresh rate-limit bucket", () => {
  let limited = false;
  for (let i = 0; i < 10; i++) {
    try {
      rateLimit(req("POST", null, { "x-forwarded-for": `10.0.0.${i}` }), "unit-bucket", 3, 0);
    } catch (e) {
      if (e instanceof DomainError && e.code === "RATE_LIMITED") limited = true;
    }
  }
  assert.equal(limited, true);
});

test("an attempt id cannot be reused for a different payment; accounts must belong to the payment's run", () => {
  const { store } = initDb(":memory:");
  for (const [id, run] of [["a", "run_A"], ["b", "run_A"], ["old", "run_OLD"], ["old2", "run_OLD"]] as const) {
    store.accounts.upsert({ id, vpa: `${id}@x`, name: id, kind: "person", createdAt: 0, balanceMinor: 10_000, runId: run });
  }
  const first = store.accounts.admit({ attemptId: "manual:k1", runId: "run_A", fromId: "a", toId: "b", amountMinor: 100, ts: 1, txnId: "t1" });
  assert.equal(first.status, "ACCEPTED");
  assert.equal(store.accounts.admit({ attemptId: "manual:k1", runId: "run_A", fromId: "a", toId: "b", amountMinor: 100, ts: 2, txnId: "t2" }).replayed, true);
  assert.throws(() => store.accounts.admit({ attemptId: "manual:k1", runId: "run_A", fromId: "a", toId: "b", amountMinor: 999, ts: 3, txnId: "t3" }), code("ATTEMPT_ID_CONFLICT"));
  const wrongRun = store.accounts.admit({ attemptId: "manual:k2", runId: "run_A", fromId: "old", toId: "old2", amountMinor: 100, ts: 4, txnId: "t4" });
  assert.equal(wrongRun.status, "REJECTED");
  assert.equal(wrongRun.rejectReason, "INVALID");
  assert.equal(store.accounts.get("old")!.balanceMinor, 10_000);
});

test("one failing payment in a tick does not drop the rest of the tick", async () => {
  const { admitBatch } = await import("../../lib/modules/payments/admission.ts");
  const { store } = initDb(":memory:");
  for (const id of ["p", "q", "r"]) store.accounts.upsert({ id, vpa: `${id}@x`, name: id, kind: "person", createdAt: 0, balanceMinor: 10_000, runId: "run_T" });
  store.accounts.admit({ attemptId: "a0", runId: "run_T", fromId: "p", toId: "q", amountMinor: 100, ts: 1, txnId: "dup-txn" });
  const orig = console.error;
  console.error = () => {};
  const out = admitBatch(store, [
    { attemptId: "a1", txnId: "t1", runId: "run_T", fromId: "p", toId: "r", amountMinor: 100, ts: 2, channel: "SCHEDULED" },
    { attemptId: "a2", txnId: "dup-txn", runId: "run_T", fromId: "q", toId: "r", amountMinor: 100, ts: 3, channel: "SCHEDULED" }, // storage conflict
    { attemptId: "a3", txnId: "t3", runId: "run_T", fromId: "r", toId: "p", amountMinor: 100, ts: 4, channel: "SCHEDULED" },
  ]);
  console.error = orig;
  assert.deepEqual(out.map((o) => o.status), ["ACCEPTED", "REJECTED", "ACCEPTED"]);
  assert.equal(store.accounts.get("q")!.balanceMinor, 10_100, "the failed payment moved nothing");
  const c = store.accounts.conservation("run_T");
  assert.equal(c.balanceMinor, c.openingMinor);
});

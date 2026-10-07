/**
 * Server-side authorization for the investigator console.
 *
 * Model: a signed, HttpOnly, SameSite=Strict session cookie carrying a role.
 *   viewer   — read cases, traces, analysis, outcomes, reports
 *   operator — everything a viewer can, plus every mutation: complaint
 *              intake, victim protection, trace/analysis runs, mule holds,
 *              hold release, report export, demo fixtures
 *
 * The operator sign-in code comes from MNH_OPERATOR_CODE. If it is unset, a
 * random code is generated per process and printed once to the server
 * console — there is no built-in default credential. The signing secret comes
 * from MNH_SESSION_SECRET (random per process when unset, so sessions end on
 * restart).
 *
 * UI hiding is never the control: every route calls `requireRole`.
 */
import crypto from "node:crypto";
import { DomainError } from "../contracts/types.ts";

export type Role = "viewer" | "operator";

export interface Session {
  sub: string; // display name
  role: Role;
  iat: number;
  exp: number;
}

export const SESSION_COOKIE = "netra_session";
export const CSRF_HEADER = "x-netra-csrf";
const SESSION_TTL_MS = 8 * 60 * 60 * 1000;

declare global {
  var __mnhAuth: { secret: Buffer; operatorCode: string; generated: boolean } | undefined;
}

function authConfig() {
  if (!globalThis.__mnhAuth) {
    const secret = process.env.MNH_SESSION_SECRET ? Buffer.from(process.env.MNH_SESSION_SECRET) : crypto.randomBytes(32);
    const envCode = process.env.MNH_OPERATOR_CODE?.trim();
    const operatorCode = envCode || crypto.randomBytes(8).toString("hex");
    globalThis.__mnhAuth = { secret, operatorCode, generated: !envCode };
    if (!envCode) {
      // Deliberately printed so a local demo operator can sign in; set
      // MNH_OPERATOR_CODE to control it.
      console.warn(`[netra] MNH_OPERATOR_CODE is not set — generated operator sign-in code for this process: ${operatorCode}`);
    } else if (envCode.length < 12) {
      console.warn("[netra] MNH_OPERATOR_CODE is shorter than 12 characters; use a longer code outside local demos");
    }
  }
  return globalThis.__mnhAuth;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

function sign(payload: string): string {
  return crypto.createHmac("sha256", authConfig().secret).update(payload).digest("base64url");
}

export function issueSession(role: Role, name: string, now = Date.now()): { token: string; session: Session } {
  const session: Session = { sub: name, role, iat: now, exp: now + SESSION_TTL_MS };
  const payload = b64url(JSON.stringify(session));
  return { token: `${payload}.${sign(payload)}`, session };
}

export function verifySession(token: string | undefined | null, now = Date.now()): Session | null {
  if (!token) return null;
  const dot = token.lastIndexOf(".");
  if (dot <= 0) return null;
  const payload = token.slice(0, dot);
  const sig = Buffer.from(token.slice(dot + 1));
  const expected = Buffer.from(sign(payload));
  if (sig.length !== expected.length || !crypto.timingSafeEqual(sig, expected)) return null;
  try {
    const s = JSON.parse(Buffer.from(payload, "base64url").toString("utf8")) as Session;
    if ((s.role !== "viewer" && s.role !== "operator") || typeof s.exp !== "number" || s.exp < now) return null;
    return s;
  } catch {
    return null;
  }
}

declare global {
  var __mnhSignInFailures: number[] | undefined;
}

const FAILURE_WINDOW_MS = 5 * 60_000;
const MAX_FAILURES = 10;

/**
 * Constant-time check of an operator sign-in code, behind a process-wide
 * failure lockout: after MAX_FAILURES wrong codes within FAILURE_WINDOW_MS,
 * operator sign-in is refused for everyone until the window passes. This does
 * not depend on any client-supplied identity, so it cannot be bypassed by
 * rotating headers.
 */
export function checkOperatorCode(code: unknown, now = Date.now()): boolean {
  const failures = (globalThis.__mnhSignInFailures ??= []).filter((t) => now - t < FAILURE_WINDOW_MS);
  globalThis.__mnhSignInFailures = failures;
  if (failures.length >= MAX_FAILURES) {
    throw new DomainError("SIGN_IN_LOCKED", "too many wrong operator codes — try again in a few minutes", 429);
  }
  const ok =
    typeof code === "string" &&
    code.length > 0 &&
    code.length <= 200 &&
    crypto.timingSafeEqual(crypto.createHash("sha256").update(code).digest(), crypto.createHash("sha256").update(authConfig().operatorCode).digest());
  if (!ok) failures.push(now);
  return ok;
}

export function sessionCookie(token: string, maxAgeMs = SESSION_TTL_MS): string {
  const secure = process.env.NODE_ENV === "production" ? "; Secure" : "";
  return `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.floor(maxAgeMs / 1000)}${secure}`;
}

export function clearSessionCookie(): string {
  return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
}

function readCookie(req: Request, name: string): string | null {
  const raw = req.headers.get("cookie");
  if (!raw) return null;
  for (const part of raw.split(";")) {
    const i = part.indexOf("=");
    if (i > 0 && part.slice(0, i).trim() === name) return part.slice(i + 1).trim();
  }
  return null;
}

export function sessionFrom(req: Request): Session | null {
  return verifySession(readCookie(req, SESSION_COOKIE));
}

/** Actor id recorded in audit rows. */
export function actorOf(s: Session): string {
  return `${s.role}:${s.sub}`;
}

/**
 * CSRF defence for cookie-authenticated mutations: the request must carry the
 * custom header (not settable cross-site without a CORS preflight we never
 * grant) and, when the browser sends Origin, it must match the Host.
 */
export function assertSameOrigin(req: Request, requireHeader = true): void {
  const origin = req.headers.get("origin");
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host");
  if (origin && host) {
    let originHost = "";
    try {
      originHost = new URL(origin).host;
    } catch {
      /* invalid origin */
    }
    if (originHost !== host) throw new DomainError("CSRF_REJECTED", "cross-origin request refused", 403);
  }
  if (requireHeader && req.headers.get(CSRF_HEADER) !== "1") {
    throw new DomainError("CSRF_REJECTED", `missing ${CSRF_HEADER} header`, 403);
  }
}

/** Require a session with at least `role`. Mutations also enforce CSRF. */
export function requireRole(req: Request, role: Role): Session {
  const s = sessionFrom(req);
  if (!s) throw new DomainError("UNAUTHENTICATED", "sign in to continue", 401);
  if (role === "operator" && s.role !== "operator") {
    throw new DomainError("FORBIDDEN", "operator permission required for this action", 403);
  }
  if (req.method !== "GET" && req.method !== "HEAD") assertSameOrigin(req);
  return s;
}

export function operatorCodeIsGenerated(): boolean {
  return authConfig().generated;
}

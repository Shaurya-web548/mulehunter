/**
 * Route-handler plumbing: one JSON envelope, stable error codes, body size
 * limits and a small in-memory rate limiter.
 *
 *   success: { ok: true,  data }
 *   failure: { ok: false, error: { code, message } }
 */
import { DomainError } from "../contracts/types.ts";
import { MoneyError } from "../contracts/money.ts";

export function ok(data: unknown, status = 200, headers?: Record<string, string>): Response {
  return Response.json({ ok: true, data }, { status, headers });
}

export function fail(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status });
}

/** Map any thrown error to the envelope; never leak internals. */
export function toErrorResponse(err: unknown): Response {
  if (err instanceof DomainError) return fail(err.code, err.message, err.status);
  if (err instanceof MoneyError) return fail("INVALID_AMOUNT", err.message, 400);
  console.error("[api] unexpected error", err);
  return fail("INTERNAL_ERROR", "unexpected server error — the change was not applied", 500);
}

/** Wrap a handler so every error becomes an envelope. */
export function handle<A extends unknown[]>(fn: (...args: A) => Promise<Response> | Response) {
  return async (...args: A): Promise<Response> => {
    try {
      return await fn(...args);
    } catch (err) {
      return toErrorResponse(err);
    }
  };
}

const MAX_BODY_BYTES = 64 * 1024;

export async function readJson<T = Record<string, unknown>>(req: Request): Promise<T> {
  const text = await req.text();
  if (text.length > MAX_BODY_BYTES) throw new DomainError("PAYLOAD_TOO_LARGE", "request body is too large", 413);
  if (!text) return {} as T;
  try {
    const v = JSON.parse(text);
    if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not an object");
    return v as T;
  } catch {
    throw new DomainError("BAD_REQUEST", "body must be a JSON object", 400);
  }
}

declare global {
  var __mnhRate: Map<string, { tokens: number; at: number }> | undefined;
}

const MAX_BUCKETS = 10_000;

/**
 * Client key for rate limiting. `x-forwarded-for` is client-controlled, so it
 * is only trusted when MNH_TRUST_PROXY=1 (i.e. behind a proxy that sets it);
 * otherwise all callers share one bucket per route — correct for this
 * single-process demo, and not bypassable by rotating a header.
 */
function clientKey(req: Request): string {
  if (process.env.MNH_TRUST_PROXY !== "1") return "direct";
  return (req.headers.get("x-forwarded-for") ?? "").split(",")[0].trim() || "direct";
}

/**
 * Token bucket per client+bucket. In-memory, single-process — matches the
 * single-process deployment of this demo. Overflow evicts the oldest
 * buckets only (never resets everyone's budget).
 */
export function rateLimit(req: Request, bucket: string, capacity = 30, refillPerSec = 3): void {
  const map = (globalThis.__mnhRate ??= new Map());
  const key = `${bucket}:${clientKey(req)}`;
  const now = Date.now();
  const b = map.get(key) ?? { tokens: capacity, at: now };
  b.tokens = Math.min(capacity, b.tokens + ((now - b.at) / 1000) * refillPerSec);
  b.at = now;
  map.delete(key); // re-insert to keep Map order = least recently used first
  map.set(key, b);
  if (b.tokens < 1) throw new DomainError("RATE_LIMITED", "too many requests — slow down", 429);
  b.tokens -= 1;
  while (map.size > MAX_BUCKETS) map.delete(map.keys().next().value!);
}

export function intParam(v: string | null, def: number, min: number, max: number): number {
  if (v === null || v === "") return def;
  const n = Number(v);
  if (!Number.isInteger(n)) throw new DomainError("BAD_REQUEST", `expected an integer, got ${v}`, 400);
  return Math.min(max, Math.max(min, n));
}

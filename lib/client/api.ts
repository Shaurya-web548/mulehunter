/**
 * Browser-side API helper for the investigator console: sends the CSRF
 * header on mutations, parses the `{ ok, data | error }` envelope and turns
 * failures into ApiFailure with the server's stable code and message.
 * (Client-safe: no Node imports.)
 */
export class ApiFailure extends Error {
  code: string;
  status: number;
  constructor(code: string, message: string, status: number) {
    super(message);
    this.code = code;
    this.status = status;
  }
}

export async function api<T>(path: string, init: { method?: string; body?: unknown; signal?: AbortSignal } = {}): Promise<T> {
  const method = init.method ?? "GET";
  let res: Response;
  try {
    res = await fetch(path, {
      method,
      signal: init.signal,
      headers: method === "GET" ? undefined : { "Content-Type": "application/json", "x-netra-csrf": "1" },
      body: init.body === undefined ? undefined : JSON.stringify(init.body),
      cache: "no-store",
    });
  } catch (err) {
    if ((err as Error).name === "AbortError") throw err;
    throw new ApiFailure("NETWORK", "Network error — the server could not be reached. Nothing was changed.", 0);
  }
  let payload: { ok?: boolean; data?: T; error?: { code: string; message: string } } | null = null;
  try {
    payload = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok || !payload?.ok) {
    throw new ApiFailure(payload?.error?.code ?? `HTTP_${res.status}`, payload?.error?.message ?? `Request failed (${res.status})`, res.status);
  }
  return payload.data as T;
}

/** Random idempotency key for one user action (reused on retry of the same action). */
export function newKey(prefix: string): string {
  const rnd = typeof crypto !== "undefined" && "randomUUID" in crypto ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  return `${prefix}-${rnd}`;
}

export interface SessionInfo {
  role: "viewer" | "operator";
  name: string;
  actorId: string;
  expiresAt: number;
}

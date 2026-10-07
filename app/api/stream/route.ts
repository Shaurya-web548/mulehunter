import { getEngine } from "@/lib/runtime";
import { sessionFrom } from "@/lib/auth/session";
import type { OutboxEvent } from "@/lib/persistence/repos/runtime";

export const dynamic = "force-dynamic";

/**
 * Server-Sent Events.
 *
 * Default (legacy /hunt console): unnamed `data:` snapshot messages ~2/s,
 * unchanged. Signed-in clients additionally receive named `case` events,
 * each with `id:` = durable outbox cursor and a per-case `version`.
 *
 * `?only=cases` — case events only (the case workspace). On reconnect the
 * browser sends Last-Event-ID; committed events after that cursor are
 * replayed from the outbox before live relay resumes, then a `resync`
 * event tells the client to refetch authoritative state.
 */
export async function GET(req: Request) {
  const engine = getEngine();
  const url = new URL(req.url);
  const onlyCases = url.searchParams.get("only") === "cases";
  const session = sessionFrom(req);
  if (onlyCases && !session) return new Response("sign in to subscribe to case updates", { status: 401 });

  const lastId = Number(req.headers.get("last-event-id") ?? url.searchParams.get("since") ?? NaN);
  const encoder = new TextEncoder();
  const unsubs: (() => void)[] = [];
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const write = (chunk: string) => {
        try {
          controller.enqueue(encoder.encode(chunk));
        } catch {
          // controller already closed — subscriptions are torn down on abort
        }
      };
      const sendCase = (ev: OutboxEvent) =>
        write(`event: case\nid: ${ev.id}\ndata: ${JSON.stringify({ topic: ev.topic, resourceId: ev.resourceId, version: ev.version, ...(ev.payload as object) })}\n\n`);

      if (session) {
        let cursor = Number.isFinite(lastId) ? lastId : engine.store.outbox.head();
        // replay committed events missed while disconnected (bounded)
        for (const ev of engine.store.outbox.after(cursor, 500)) {
          sendCase(ev);
          cursor = ev.id;
        }
        write(`event: resync\nid: ${cursor}\ndata: ${JSON.stringify({ cursor })}\n\n`);
        unsubs.push(
          engine.subscribeCases((ev) => {
            if (ev.id > cursor) {
              cursor = ev.id;
              sendCase(ev);
            }
          }),
        );
      }
      if (!onlyCases) unsubs.push(engine.subscribe((snap) => write(`data: ${JSON.stringify(snap)}\n\n`)));
      heartbeat = setInterval(() => write(": hb\n\n"), 15_000);

      req.signal.addEventListener("abort", () => {
        for (const u of unsubs) u();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      for (const u of unsubs) u();
      if (heartbeat) clearInterval(heartbeat);
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache, no-transform",
      Connection: "keep-alive",
    },
  });
}

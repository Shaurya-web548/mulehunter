import { getEngine } from "@/lib/engine/engine";

export const dynamic = "force-dynamic";

// Server-Sent Events: one connection per dashboard, ~2 snapshots/second.
export async function GET(req: Request) {
  const engine = getEngine();
  const encoder = new TextEncoder();
  let unsub: (() => void) | null = null;
  let heartbeat: ReturnType<typeof setInterval> | null = null;

  const stream = new ReadableStream({
    start(controller) {
      const send = (data: unknown) => {
        try {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          // controller already closed — subscription is torn down on abort
        }
      };
      unsub = engine.subscribe(send);
      heartbeat = setInterval(() => {
        try {
          controller.enqueue(encoder.encode(": hb\n\n"));
        } catch {
          /* closed */
        }
      }, 15_000);

      req.signal.addEventListener("abort", () => {
        unsub?.();
        if (heartbeat) clearInterval(heartbeat);
        try {
          controller.close();
        } catch {
          /* already closed */
        }
      });
    },
    cancel() {
      unsub?.();
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

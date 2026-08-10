import { NextRequest, NextResponse } from "next/server";
import { getEngine } from "@/lib/engine/engine";

export async function POST(req: NextRequest) {
  let ringId: string;
  try {
    const body = await req.json();
    ringId = body.ringId;
  } catch {
    return NextResponse.json({ error: "bad_request" }, { status: 400 });
  }
  const ring = getEngine().freeze(ringId);
  if (!ring) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true, ring });
}

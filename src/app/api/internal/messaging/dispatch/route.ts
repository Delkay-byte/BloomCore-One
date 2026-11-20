import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import { runMessagingDispatch } from "@/lib/messaging/dispatch";

/**
 * Scheduled trigger for customer-message delivery.
 *
 * The outbox is durable, but nothing forced a pass when no new receipt arrived.
 * This route is that trigger: a scheduler calls it on a fixed interval with a
 * shared secret. It is disabled until the secret is set, refuses every request
 * without it, and does bounded work per call.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function POST(request: NextRequest): Promise<Response> {
  const secret = (process.env.MESSAGING_DISPATCH_TOKEN ?? "").trim();
  if (!secret) return new Response("Not configured", { status: 503 });

  const provided =
    request.headers.get("x-dispatch-token") ??
    (request.headers.get("authorization") ?? "").replace(/^Bearer\s+/i, "");
  if (!safeEqual(provided.trim(), secret)) {
    return new Response("Forbidden", { status: 403 });
  }

  const summary = await runMessagingDispatch();
  return NextResponse.json({ ok: true, ...summary });
}

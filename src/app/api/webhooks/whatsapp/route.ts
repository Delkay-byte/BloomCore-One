import { NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "crypto";
import {
  getWhatsAppConfig,
  sanitizeMessagingError,
  verifyWhatsAppSignature,
} from "@/lib/messaging/whatsapp";
import {
  recordCustomerMessageStatus,
  type CustomerMessageStatus,
} from "@/lib/messaging/outbox";

/**
 * Meta WhatsApp Cloud API webhook.
 *
 * GET is the subscription challenge. POST requires a valid
 * X-Hub-Signature-256 over the exact raw body; a successful API call at send
 * time is never treated as proof of delivery. Every status event is recorded
 * exactly once and the route always acknowledges quickly.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function GET(request: NextRequest): Promise<Response> {
  const config = getWhatsAppConfig();
  if (!config.verifyToken) return new Response("Not configured", { status: 503 });
  const mode = request.nextUrl.searchParams.get("hub.mode");
  const token = request.nextUrl.searchParams.get("hub.verify_token") ?? "";
  const challenge = request.nextUrl.searchParams.get("hub.challenge") ?? "";
  if (mode !== "subscribe" || !safeEqual(token, config.verifyToken)) {
    return new Response("Forbidden", { status: 403 });
  }
  return new Response(challenge, { status: 200 });
}

function mapStatus(value: unknown): CustomerMessageStatus | null {
  switch (value) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "read":
      return "read";
    case "failed":
      return "failed";
    default:
      return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const config = getWhatsAppConfig();
  if (!config.appSecret) return new Response("Not configured", { status: 503 });

  const raw = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  if (!verifyWhatsAppSignature(raw, signature, config.appSecret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }

  let handled = 0;
  const entries = (body as { entry?: unknown[] })?.entry;
  if (Array.isArray(entries)) {
    for (const entry of entries) {
      const changes = (entry as { changes?: unknown[] })?.changes;
      if (!Array.isArray(changes)) continue;
      for (const change of changes) {
        const statuses = (change as { value?: { statuses?: unknown[] } })?.value
          ?.statuses;
        if (!Array.isArray(statuses)) continue;
        for (const item of statuses) {
          const row = item as {
            id?: unknown;
            status?: unknown;
            timestamp?: unknown;
            errors?: Array<{ title?: string; message?: string }>;
          };
          const providerMessageId = typeof row.id === "string" ? row.id : "";
          const status = mapStatus(row.status);
          if (!providerMessageId || !status) continue;
          const occurredAt = Number(row.timestamp)
            ? new Date(Number(row.timestamp) * 1000)
            : new Date();
          const reason =
            status === "failed"
              ? sanitizeMessagingError(
                  row.errors?.[0]?.title ?? row.errors?.[0]?.message ?? "delivery_failed"
                )
              : null;
          const eventId = `${providerMessageId}:${status}:${row.timestamp ?? occurredAt.getTime()}`;
          await recordCustomerMessageStatus({
            eventId,
            providerMessageId,
            status,
            occurredAt,
            reason,
          });
          handled += 1;
        }
      }
    }
  }

  return NextResponse.json({ received: true, handled });
}

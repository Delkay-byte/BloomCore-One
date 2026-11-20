import { NextRequest, NextResponse } from "next/server";
import { createHmac, timingSafeEqual } from "crypto";
import {
  recordCustomerMessageStatus,
  type CustomerMessageStatus,
} from "@/lib/messaging/outbox";
import { sanitizeMessagingError } from "@/lib/messaging/whatsapp";

/**
 * SMS delivery-status webhook.
 *
 * No SMS provider has been contracted, so nothing calls this route today. It
 * exists because the delivery ledger must not be WhatsApp-only: when a provider
 * is approved, its status callbacks land here and are recorded exactly once,
 * with no change to the outbox or the ledger.
 *
 * The payload is normalised rather than provider-specific: a provider adapter
 * maps its own shape to `{ events: [...] }`, so this route's contract is our
 * status ledger, not one vendor's JSON. Requests are authenticated with an
 * HMAC-SHA256 of the exact raw body, compared in constant time, and the route is
 * unavailable until the secret is configured.
 */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export interface SmsStatusEvent {
  /** The provider's message id, as stored on the outbox row. */
  messageId: string;
  status: "sent" | "delivered" | "failed";
  occurredAt?: string;
  reason?: string | null;
  /** Optional provider event id; used for idempotency when present. */
  eventId?: string;
}

function safeEqual(left: string, right: string): boolean {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && timingSafeEqual(a, b);
}

function verifySmsSignature(raw: string, header: string | null, secret: string): boolean {
  if (!header) return false;
  const provided = header.startsWith("sha256=") ? header.slice(7) : header;
  const expected = createHmac("sha256", secret).update(raw, "utf8").digest("hex");
  return safeEqual(provided.trim().toLowerCase(), expected);
}

function mapStatus(value: unknown): CustomerMessageStatus | null {
  switch (value) {
    case "sent":
      return "sent";
    case "delivered":
      return "delivered";
    case "failed":
    case "undelivered":
    case "rejected":
      return "failed";
    default:
      return null;
  }
}

export async function POST(request: NextRequest): Promise<Response> {
  const secret = (process.env.SMS_STATUS_WEBHOOK_SECRET ?? "").trim();
  if (!secret) return new Response("Not configured", { status: 503 });

  const raw = await request.text();
  const signature = request.headers.get("x-sms-signature-256");
  if (!verifySmsSignature(raw, signature, secret)) {
    return new Response("Invalid signature", { status: 401 });
  }

  let body: { events?: unknown };
  try {
    body = JSON.parse(raw) as { events?: unknown };
  } catch {
    return new Response("Invalid payload", { status: 400 });
  }
  if (!Array.isArray(body.events)) {
    return new Response("Invalid payload", { status: 400 });
  }

  let handled = 0;
  for (const item of body.events) {
    const event = item as Partial<SmsStatusEvent>;
    const messageId = typeof event.messageId === "string" ? event.messageId : "";
    const status = mapStatus(event.status);
    if (!messageId || !status) continue;
    const occurredAt = event.occurredAt ? new Date(event.occurredAt) : new Date();
    const when = Number.isNaN(occurredAt.getTime()) ? new Date() : occurredAt;
    const reason =
      status === "failed" ? sanitizeMessagingError(event.reason ?? "delivery_failed") : null;
    await recordCustomerMessageStatus({
      eventId:
        typeof event.eventId === "string" && event.eventId
          ? event.eventId
          : `${messageId}:${status}:${when.getTime()}`,
      providerMessageId: messageId,
      status,
      occurredAt: when,
      reason,
    });
    handled += 1;
  }

  return NextResponse.json({ received: true, handled });
}

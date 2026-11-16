import { NextRequest, NextResponse } from "next/server";
import { handlePaystackWebhook } from "@/lib/payments/zeli-subscriptions";

/**
 * POST /api/payments/paystack/webhook
 *
 * The raw body is required for HMAC SHA-512 signature verification. Current
 * Paystack events carry `Paystack-Signature` (timestamped, keyed by the webhook
 * signing secret); older deliveries carry `x-paystack-signature` (keyed by the
 * secret key). Both are checked from the raw bytes, and the new header wins
 * when present. The handler only acknowledges after the event is
 * authenticated. Provider retries are safe because every event id and
 * subscription reference is unique.
 */
export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  if (rawBody.length > 256 * 1024) {
    return NextResponse.json({ error: "Payload too large" }, { status: 413 });
  }
  const result = await handlePaystackWebhook(
    rawBody,
    request.headers.get("x-paystack-signature"),
    request.headers.get("paystack-signature")
  );
  return NextResponse.json(
    { received: result.ok, decision: result.decision },
    { status: result.status }
  );
}

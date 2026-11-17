import { NextRequest, NextResponse } from "next/server";
import { handlePaystackWebhook } from "@/lib/payments/zeli-subscriptions";
import { paystackSignatureHeaderConfigured } from "@/lib/payments/paystack";

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
  const legacySignature = request.headers.get("x-paystack-signature");
  const newSignature = request.headers.get("paystack-signature");
  const result = await handlePaystackWebhook(
    rawBody,
    legacySignature,
    newSignature
  );
  if (!result.ok) {
    // Diagnostics only: header presence and the verification outcome. Signature
    // values and secrets are never logged.
    console.warn(
      JSON.stringify({
        kind: "paystack_webhook_rejected",
        decision: result.decision,
        status: result.status,
        hasLegacySignature: Boolean(legacySignature),
        hasPaystackSignature: Boolean(newSignature),
        signingSecretConfigured: paystackSignatureHeaderConfigured(),
        bytes: rawBody.length,
      })
    );
  }
  return NextResponse.json(
    { received: result.ok, decision: result.decision },
    { status: result.status }
  );
}

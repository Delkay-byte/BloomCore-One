import { NextRequest, NextResponse } from "next/server";
import { getApiTenantContext } from "@/lib/tenant";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import { consumeRateLimit, retryAfterSeconds } from "@/lib/security/rate-limit";
import { logSecurityEvent } from "@/lib/security/log";
import {
  submitZeliChargeOtp,
  SubscriptionError,
} from "@/lib/payments/zeli-subscriptions";

/**
 * POST /api/billing/payments/submit-otp
 *
 * Finishes an existing Paystack mobile-money charge by submitting the one-time
 * code Paystack sent to the owner's phone.
 *
 * This is a route handler, not a Server Action: Next.js development mode logs
 * Server Action arguments verbatim, and an OTP must never reach a terminal log.
 * The handler never logs the body and never returns the code.
 *
 * What this route deliberately does NOT do:
 *   * start a charge or create/replace a payment reference;
 *   * submit anything unless the ledger says this exact tenant's attempt is
 *     pending and waiting for an OTP;
 *   * activate access from the provider's `success` status alone — the payment
 *     is verified server-side and fulfilled through the same exactly-once path
 *     as the webhook.
 */
export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return crossOriginDenied();

  const ctx = await getApiTenantContext("admin");
  if (!ctx || ctx.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const limit = await consumeRateLimit(
    "billing.submit_otp",
    `${ctx.tenantId}:${ctx.userId}`,
    { limit: 8, windowMs: 10 * 60 * 1000 }
  );
  if (!limit.allowed) {
    return NextResponse.json(
      {
        ok: false,
        code: "rate_limited",
        error: "Too many verification attempts. Wait a few minutes, then check the payment status.",
      },
      { status: 429, headers: { "retry-after": retryAfterSeconds(limit) } }
    );
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }
  if (!body || typeof body !== "object") {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  const input = body as Record<string, unknown>;
  const reference = typeof input.reference === "string" ? input.reference.trim() : "";
  // Paystack OTP lengths vary by network. Normalise spaces and dashes only;
  // nothing is logged, stored or echoed back.
  const otp =
    typeof input.otp === "string" ? input.otp.replace(/[\s-]/g, "") : "";
  if (
    !reference ||
    reference.length > 120 ||
    !/^\d{4,10}$/.test(otp)
  ) {
    return NextResponse.json(
      {
        ok: false,
        code: "invalid_otp",
        error: "Enter the verification code Paystack sent to your phone.",
      },
      { status: 400 }
    );
  }

  try {
    const result = await submitZeliChargeOtp(ctx, reference, otp);
    return NextResponse.json({ ok: true, ...result });
  } catch (error) {
    if (error instanceof SubscriptionError) {
      const state =
        error.code === "charge_unresolved"
          ? "unresolved"
          : error.code === "otp_invalid"
            ? "open"
            : error.code === "already_active"
              ? "closed"
              : undefined;
      const status =
        error.code === "charge_unresolved"
          ? 409
          : error.code === "already_active" || error.code === "not_payable"
            ? 409
            : 400;
      return NextResponse.json(
        { ok: false, code: error.code, error: error.message, state, reference },
        { status }
      );
    }
    // Never include the error message: it can echo request data.
    logSecurityEvent({
      event: "payment.otp_submission_error",
      outcome: "error",
      actorType: "user",
      actorId: ctx.userId,
      tenantId: ctx.tenantId,
      route: "billing_submit_otp",
      reason: "unexpected_error",
    });
    return NextResponse.json({
      ok: false,
      code: "unexpected_error",
      error:
        "We could not confirm the verification code. Do not pay again. Use Check payment status so MaaCash can reconcile this payment.",
      state: "unresolved",
      reference,
    });
  }
}

import { NextRequest, NextResponse } from "next/server";
import { getApiTenantContext } from "@/lib/tenant";
import { isSameOriginRequest, crossOriginDenied } from "@/lib/security/same-origin";
import { consumeRateLimit, retryAfterSeconds } from "@/lib/security/rate-limit";
import { logSecurityEvent } from "@/lib/security/log";
import {
  payProvisionedSubscription,
  SubscriptionError,
} from "@/lib/payments/zeli-subscriptions";
import type { MobileMoneyProvider } from "@/lib/payments/paystack";
import { customerPaymentMessage } from "@/lib/payments/live-readiness";

/**
 * POST /api/billing/pay
 *
 * Starts a payment for an existing payable subscription.
 *
 * This lives on a route handler rather than a Server Action on purpose: Next.js
 * development mode logs Server Action arguments verbatim, which leaked a
 * customer's wallet number into a local terminal log. A route handler receives
 * the body without that automatic argument dump, and this handler never logs
 * the body itself.
 *
 * Security is unchanged and re-checked here:
 *   * same-origin/CSRF check before anything else;
 *   * administrator session resolved from cookies, never from the body;
 *   * the subscription is looked up with the tenant id, so a reference from
 *     another business is not payable;
 *   * rate limiting per tenant+user;
 *   * every provider call stays behind the charge-attempt ledger and the
 *     local-live guard.
 */
const PROVIDERS = new Set<MobileMoneyProvider>(["mtn", "atl", "vod"]);

export async function POST(request: NextRequest) {
  if (!isSameOriginRequest(request)) return crossOriginDenied();

  const ctx = await getApiTenantContext("admin");
  if (!ctx || ctx.role !== "admin") {
    return NextResponse.json({ ok: false, error: "Not authenticated." }, { status: 401 });
  }

  const limit = await consumeRateLimit(
    "billing.pay",
    `${ctx.tenantId}:${ctx.userId}`,
    { limit: 6, windowMs: 10 * 60 * 1000 }
  );
  if (!limit.allowed) {
    return NextResponse.json(
      { ok: false, error: "Too many payment attempts. Please wait a few minutes and try again." },
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
  const subscriptionId =
    typeof input.subscriptionId === "string" ? input.subscriptionId.trim() : "";
  const method = input.method === "mobile_money" || input.method === "hosted" ? input.method : null;
  if (!subscriptionId || subscriptionId.length > 64 || !method) {
    return NextResponse.json({ ok: false, error: "Invalid request." }, { status: 400 });
  }

  try {
    // `hosted` is the only path the current billing UI uses. `mobile_money` is
    // retained for the legacy direct-charge flow and its tests; the hosted
    // checkout never calls `/charge` and never collects a wallet number here.
    const result =
      method === "mobile_money"
        ? (() => {
            const phone = typeof input.phone === "string" ? input.phone.trim() : "";
            const provider = typeof input.provider === "string" ? input.provider : "";
            if (!phone || phone.length > 32 || !PROVIDERS.has(provider as MobileMoneyProvider)) {
              return Promise.reject(
                new SubscriptionError(
                  "Enter a valid Ghana mobile money number and choose a network.",
                  "invalid_input"
                )
              );
            }
            return payProvisionedSubscription(ctx, subscriptionId, {
              method: "mobile_money",
              phone,
              provider: provider as MobileMoneyProvider,
            });
          })()
        : payProvisionedSubscription(ctx, subscriptionId, {
            method: "hosted",
            channel:
              input.channel === "mobile_money" ||
              input.channel === "card" ||
              input.channel === "bank_transfer"
                ? input.channel
                : undefined,
          });

    const settled = await result;
    return NextResponse.json({ ok: true, ...settled });
  } catch (error) {
    if (error instanceof SubscriptionError) {
      const state =
        error.code === "charge_unresolved"
          ? "unresolved"
          : error.code === "charge_rejected"
            ? "rejected"
            : error.code === "attempt_closed" || error.code === "already_active"
              ? "closed"
              : undefined;
      return NextResponse.json({
        ok: false,
        error: customerPaymentMessage(error),
        state,
        code: error.code,
      });
    }
    logSecurityEvent({
      event: "payment.initiation_error",
      outcome: "error",
      actorType: "user",
      actorId: ctx.userId,
      tenantId: ctx.tenantId,
      route: "billing_pay",
      reason: "unexpected_error",
    });
    return NextResponse.json({
      ok: false,
      error: "The payment could not be started. No money was taken.",
    });
  }
}

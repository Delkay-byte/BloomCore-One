"use server";

import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { createAuditLog } from "@/lib/audit";
import { assertZeliAvailable } from "@/lib/zeli/availability";
import { randomBytes } from "crypto";
import {
  cancelZeliSubscription,
  createZeliCheckout,
  listPublicZeliPlans,
  paymentProviderStatus,
  SubscriptionError,
  verifyAndFulfil,
} from "@/lib/payments/zeli-subscriptions";

export interface BillingActionResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

export async function startZeliCheckout(
  planCode: string
): Promise<BillingActionResponse<{ authorizationUrl: string }>> {
  try {
    await assertZeliAvailable();
    const ctx = await requireTenantAdmin();
    const code = String(planCode ?? "").trim();
    if (!/^[a-z0-9][a-z0-9_-]{2,60}$/i.test(code)) {
      return { success: false, error: "Choose a valid package." };
    }
    const checkout = await createZeliCheckout(ctx, code);
    return { success: true, data: { authorizationUrl: checkout.authorizationUrl } };
  } catch (error) {
    if (error instanceof SubscriptionError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Checkout could not be started." };
  }
}

export async function cancelZeliSubscriptionAction(): Promise<BillingActionResponse> {
  try {
    const ctx = await requireTenantAdmin();
    await cancelZeliSubscription(ctx);
    return { success: true };
  } catch (error) {
    if (error instanceof SubscriptionError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "The subscription could not be cancelled." };
  }
}

/** Checkout return page: verify server-side, never trust the redirect alone. */
export async function confirmZeliCheckout(
  reference: string
): Promise<BillingActionResponse<{ decision: string }>> {
  try {
    const ctx = await requireTenantAdmin();
    if (!/^[A-Za-z0-9._=-]{6,120}$/.test(reference)) {
      return { success: false, error: "Invalid payment reference." };
    }
    const subscription = await db.zeliSubscription.findFirst({
      where: { providerReference: reference, tenantId: ctx.tenantId },
      select: { id: true },
    });
    if (!subscription) return { success: false, error: "Subscription not found." };
    const result = await verifyAndFulfil(reference, "callback");
    if (result.decision === "failed") {
      return {
        success: false,
        error:
          result.reason === "payment_mismatch"
            ? "The payment did not match the selected package."
            : "Payment could not be verified yet. If you were charged, contact support.",
      };
    }
    return { success: true, data: { decision: result.decision } };
  } catch (error) {
    if (error instanceof SubscriptionError) {
      return { success: false, error: error.message };
    }
    return { success: false, error: "Payment verification failed. No access was activated." };
  }
}

export async function getZeliBillingOptions(): Promise<
  BillingActionResponse<{
    plans: Awaited<ReturnType<typeof listPublicZeliPlans>>;
    payment: ReturnType<typeof paymentProviderStatus>;
  }>
> {
  try {
    await requireTenantAdmin();
    return {
      success: true,
      data: {
        plans: await listPublicZeliPlans(),
        payment: paymentProviderStatus(),
      },
    };
  } catch {
    return { success: false, error: "Not authorized." };
  }
}

export async function getZeliSubscriptionSummary(): Promise<
  BillingActionResponse<{
    planName: string;
    status: string;
    periodEnd: string | null;
    cancelAtPeriodEnd: boolean;
    reference: string;
  } | null>
> {
  try {
    const ctx = await requireTenantAdmin();
    const row = await db.zeliSubscription.findFirst({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "desc" },
      include: { plan: { select: { name: true } } },
    });
    if (!row) return { success: true, data: null };
    return {
      success: true,
      data: {
        planName: row.plan.name,
        status: row.status,
        periodEnd: row.periodEnd?.toISOString() ?? null,
        cancelAtPeriodEnd: row.cancelAtPeriodEnd,
        reference: row.providerReference,
      },
    };
  } catch {
    return { success: false, error: "Subscription status is not available." };
  }
}

/**
 * Owner-configured trial. Runs only when the published package carries a
 * non-zero trial policy and the business has never had a Zeli subscription or
 * entitlement. It is an explicit, audited grant, not a bypass of payment.
 */
export async function startZeliTrial(
  planCode: string
): Promise<BillingActionResponse<{ trialEndsAt: string }>> {
  try {
    await assertZeliAvailable();
    const ctx = await requireTenantAdmin();
    const plan = await db.zeliPlan.findUnique({ where: { code: planCode } });
    if (!plan || plan.status !== "active" || !plan.isPublic || plan.trialDays <= 0) {
      return { success: false, error: "No trial is available for this package." };
    }
    const [subscriptionCount, entitlement] = await Promise.all([
      db.zeliSubscription.count({ where: { tenantId: ctx.tenantId } }),
      db.zeliEntitlement.findUnique({
        where: { tenantId_featureKey: { tenantId: ctx.tenantId, featureKey: "zeli_analytics" } },
      }),
    ]);
    if (subscriptionCount > 0 || entitlement) {
      return { success: false, error: "A trial has already been used for this business." };
    }
    const start = new Date();
    const end = new Date(start.getTime() + plan.trialDays * 86_400_000);
    const reference = `TRIAL-${ctx.tenantId.slice(0, 8)}-${randomBytes(6).toString("hex")}`;
    await db.$transaction(async (tx) => {
      const subscription = await tx.zeliSubscription.create({
        data: {
          tenantId: ctx.tenantId,
          planId: plan.id,
          status: "active",
          provider: "trial",
          providerReference: reference,
          amount: 0,
          currency: plan.currency,
          periodStart: start,
          periodEnd: end,
          paidAt: start,
        },
      });
      await tx.zeliPaymentEvent.create({
        data: {
          provider: "trial",
          eventId: `trial:${reference}`,
          eventType: "trial.started",
          reference,
          subscriptionId: subscription.id,
          tenantId: ctx.tenantId,
          decision: "processed",
          reason: "Owner-configured trial",
          processedAt: start,
        },
      });
      const created = await tx.zeliEntitlement.create({
        data: {
          tenantId: ctx.tenantId,
          featureKey: "zeli_analytics",
          status: "active",
          source: "trial",
          reason: `Owner-configured trial (${plan.code})`,
          startsAt: start,
          expiresAt: end,
        },
      });
      await tx.zeliEntitlementEvent.create({
        data: {
          entitlementId: created.id,
          tenantId: ctx.tenantId,
          action: "trial_started",
          status: "active",
          reason: `Trial for ${plan.code}`,
          actorType: "system",
          expiresAt: end,
        },
      });
    });
    await createAuditLog({
      userId: ctx.userId,
      tenantId: ctx.tenantId,
      action: "zeli.trial_started",
      entityType: "zeli_subscription",
      entityId: reference,
      details: { planCode: plan.code, trialDays: plan.trialDays },
    });
    return { success: true, data: { trialEndsAt: end.toISOString() } };
  } catch {
    return { success: false, error: "The trial could not be started." };
  }
}

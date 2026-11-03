import { randomBytes, createHash } from "crypto";
import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant";
import {
  initializeTransaction,
  paystackConfigured,
  verifyTransaction,
  verifyWebhookSignature,
  type PaystackTransaction,
} from "./paystack";
import { getZeliEntitlement } from "@/lib/zeli/entitlements";

/**
 * Zeli subscription lifecycle.
 *
 * The provider webhook (or a server-side verify) is the authority. A browser
 * redirect never activates an entitlement. Every activation is idempotent on
 * the provider event id and the unique subscription reference.
 */

export class SubscriptionError extends Error {
  code: string;
  constructor(message: string, code = "subscription_error") {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
  }
}

function addInterval(start: Date, interval: string): Date {
  const end = new Date(start);
  if (interval === "year") end.setUTCFullYear(end.getUTCFullYear() + 1);
  else end.setUTCMonth(end.getUTCMonth() + 1);
  return end;
}

function amountSubunit(value: unknown): number {
  const amount = Number(value);
  if (!Number.isFinite(amount) || amount <= 0) {
    throw new SubscriptionError("The package price is not valid.", "invalid_price");
  }
  return Math.round(amount * 100);
}

function baseUrl(): string {
  const configured = process.env.NEXTAUTH_URL || process.env.APP_URL;
  if (!configured) {
    throw new SubscriptionError("Application URL is not configured.", "missing_app_url");
  }
  try {
    const url = new URL(configured);
    if (url.protocol !== "https:" && process.env.NODE_ENV === "production") {
      throw new Error("not https");
    }
    return url.origin;
  } catch {
    throw new SubscriptionError("Application URL is not valid.", "missing_app_url");
  }
}

export interface PublicZeliPlan {
  code: string;
  name: string;
  description: string | null;
  billingInterval: string;
  price: number;
  currency: string;
  features: string[];
  usageAllowance: number | null;
  trialDays: number;
}

export async function listPublicZeliPlans(): Promise<PublicZeliPlan[]> {
  const rows = await db.zeliPlan.findMany({
    where: { status: "active", isPublic: true },
    orderBy: [{ sortOrder: "asc" }, { price: "asc" }],
  });
  return rows.map((row) => ({
    code: row.code,
    name: row.name,
    description: row.description,
    billingInterval: row.billingInterval,
    price: Number(row.price),
    currency: row.currency,
    features: row.features ? (JSON.parse(row.features) as string[]) : [],
    usageAllowance: row.usageAllowance,
    trialDays: row.trialDays,
  }));
}

export function paymentProviderStatus(): {
  configured: boolean;
  provider: "paystack";
  message: string;
} {
  const configured = paystackConfigured();
  return {
    configured,
    provider: "paystack",
    message: configured
      ? "Secure checkout is available through Paystack."
      : "Subscription checkout is not configured yet. Ask the platform administrator to configure the payment provider and catalogue.",
  };
}

/** Start a checkout for a tenant administrator. Price comes from the database. */
export async function createZeliCheckout(
  ctx: TenantContext,
  planCode: string
): Promise<{ authorizationUrl: string; reference: string }> {
  if (ctx.role !== "admin") {
    throw new SubscriptionError("Only a business administrator can subscribe.", "forbidden");
  }
  if (!paystackConfigured()) {
    throw new SubscriptionError(
      "Subscription checkout is not configured yet.",
      "provider_not_configured"
    );
  }
  const plan = await db.zeliPlan.findUnique({ where: { code: planCode } });
  if (!plan || plan.status !== "active" || !plan.isPublic) {
    throw new SubscriptionError("This package is not available.", "plan_unavailable");
  }
  const existing = await getZeliEntitlement(ctx.tenantId);
  if (existing?.status === "suspended" || existing?.status === "revoked") {
    throw new SubscriptionError(
      "This business's access is under platform review. Contact BloomCore support.",
      "entitlement_locked"
    );
  }
  const activeSubscription = await db.zeliSubscription.findFirst({
    where: { tenantId: ctx.tenantId, status: "active", periodEnd: { gt: new Date() } },
    orderBy: { createdAt: "desc" },
  });
  if (activeSubscription) {
    throw new SubscriptionError("This business already has an active subscription.", "already_active");
  }
  const admin = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { email: true },
  });
  const tenant = await db.businessTenant.findUnique({
    where: { id: ctx.tenantId },
    select: { contactEmail: true, code: true },
  });
  const email = admin?.email || tenant?.contactEmail;
  if (!email) {
    throw new SubscriptionError("A billing contact email is required.", "missing_email");
  }

  const reference = `ZELI-${ctx.tenantId.slice(0, 8)}-${randomBytes(8).toString("hex")}`;
  const created = await db.zeliSubscription.create({
    data: {
      tenantId: ctx.tenantId,
      planId: plan.id,
      status: "pending",
      provider: "paystack",
      providerReference: reference,
      amount: plan.price,
      currency: plan.currency,
      periodStart: null,
      periodEnd: null,
    },
  });

  try {
    const initialized = await initializeTransaction({
      email,
      amountSubunit: amountSubunit(plan.price),
      currency: plan.currency,
      reference,
      callbackUrl: `${baseUrl()}/admin/zeli-analytics/checkout/callback?reference=${encodeURIComponent(reference)}`,
      metadata: {
        zeli_subscription_id: created.id,
        plan_code: plan.code,
      },
    });
    if (initialized.reference !== reference) {
      throw new SubscriptionError("Payment provider returned a different reference.", "reference_mismatch");
    }
    return { authorizationUrl: initialized.authorizationUrl, reference };
  } catch (error) {
    await db.zeliSubscription.update({
      where: { id: created.id },
      data: {
        status: "failed",
        failureReason: error instanceof Error ? error.message.slice(0, 200) : "initialization failed",
      },
    });
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError("Payment checkout could not be started. Please try again.", "initialization_failed");
  }
}

interface FulfilResult {
  decision: "processed" | "ignored" | "failed";
  subscriptionId: string | null;
  reason: string;
}

/**
 * Activate a paid subscription atomically. `eventId` is unique; replaying the
 * same provider event returns the existing event and never extends the period.
 */
export async function fulfilPaidSubscription(input: {
  reference: string;
  eventId: string;
  eventType: string;
  transaction: PaystackTransaction;
}): Promise<FulfilResult> {
  const subscription = await db.zeliSubscription.findUnique({
    where: { providerReference: input.reference },
    include: { plan: true },
  });
  if (!subscription) {
    return { decision: "failed", subscriptionId: null, reason: "unknown_reference" };
  }
  if (
    input.transaction.reference !== subscription.providerReference ||
    Number(input.transaction.amount) !== Math.round(Number(subscription.amount) * 100) ||
    input.transaction.currency.toUpperCase() !== subscription.currency.toUpperCase()
  ) {
    return { decision: "failed", subscriptionId: subscription.id, reason: "payment_mismatch" };
  }
  if (input.transaction.status !== "success") {
    return { decision: "ignored", subscriptionId: subscription.id, reason: "not_successful" };
  }

  try {
    const result = await db.$transaction(async (tx) => {
      if (await tx.zeliPaymentEvent.findUnique({ where: { eventId: input.eventId } })) {
        return { decision: "ignored" as const, reason: "duplicate_event" };
      }
      const fresh = await tx.zeliSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
        include: { plan: true },
      });
      if (
        fresh.status === "active" &&
        fresh.periodEnd &&
        fresh.periodEnd.getTime() > Date.now()
      ) {
        await tx.zeliPaymentEvent.create({
          data: {
            provider: "paystack",
            eventId: input.eventId,
            eventType: input.eventType,
            reference: input.reference,
            subscriptionId: fresh.id,
            tenantId: fresh.tenantId,
            decision: "ignored",
            reason: "subscription_already_active",
            processedAt: new Date(),
          },
        });
        return { decision: "ignored" as const, reason: "already_active" };
      }
      const periodStart = new Date();
      const periodEnd = addInterval(periodStart, fresh.plan.billingInterval);

      await tx.zeliSubscription.updateMany({
        where: {
          tenantId: fresh.tenantId,
          id: { not: fresh.id },
          status: "active",
        },
        data: { status: "expired" },
      });
      await tx.zeliSubscription.update({
        where: { id: fresh.id },
        data: {
          status: "active",
          periodStart,
          periodEnd,
          paidAt: input.transaction.paidAt ? new Date(input.transaction.paidAt) : periodStart,
          failureReason: null,
          providerCustomerCode: input.transaction.customerCode ?? fresh.providerCustomerCode,
        },
      });
      await tx.zeliPaymentEvent.create({
        data: {
          provider: "paystack",
          eventId: input.eventId,
          eventType: input.eventType,
          reference: input.reference,
          subscriptionId: fresh.id,
          tenantId: fresh.tenantId,
          decision: "processed",
          reason: "paid",
          processedAt: new Date(),
        },
      });

      const existing = await tx.zeliEntitlement.findUnique({
        where: {
          tenantId_featureKey: {
            tenantId: fresh.tenantId,
            featureKey: "zeli_analytics",
          },
        },
      });
      const keepManual =
        existing?.status === "active" &&
        existing.source === "manual" &&
        existing.expiresAt &&
        existing.expiresAt.getTime() > periodEnd.getTime();
      const entitlement = await tx.zeliEntitlement.upsert({
        where: {
          tenantId_featureKey: {
            tenantId: fresh.tenantId,
            featureKey: "zeli_analytics",
          },
        },
        create: {
          tenantId: fresh.tenantId,
          featureKey: "zeli_analytics",
          status: "active",
          source: "subscription",
          reason: `Paid subscription ${fresh.plan.code} (${fresh.providerReference})`,
          startsAt: periodStart,
          expiresAt: periodEnd,
        },
        update: {
          status: "active",
          source: keepManual ? "manual" : "subscription",
          reason: `Paid subscription ${fresh.plan.code} (${fresh.providerReference})`,
          expiresAt: keepManual ? existing!.expiresAt : periodEnd,
          suspendedAt: null,
          revokedAt: null,
          revokedById: null,
        },
      });
      await tx.zeliEntitlementEvent.create({
        data: {
          entitlementId: entitlement.id,
          tenantId: fresh.tenantId,
          action: "subscription_activated",
          status: "active",
          reason: `Paystack payment ${fresh.providerReference}`,
          actorType: "payment_provider",
          expiresAt: keepManual ? existing!.expiresAt : periodEnd,
        },
      });
      return { decision: "processed" as const, reason: "paid" };
    });
    return { ...result, subscriptionId: subscription.id };
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      (error as { code?: string }).code === "P2002"
    ) {
      return { decision: "ignored", subscriptionId: subscription.id, reason: "duplicate_event" };
    }
    return { decision: "failed", subscriptionId: subscription.id, reason: "transaction_failed" };
  }
}

/** Verify a callback/server reconciliation without trusting the redirect. */
export async function verifyAndFulfil(reference: string, source: string): Promise<FulfilResult> {
  const transaction = await verifyTransaction(reference);
  const eventId = `verify:${reference}:${transaction.paidAt ?? transaction.id ?? source}`;
  return fulfilPaidSubscription({
    reference,
    eventId,
    eventType: "charge.success.verified",
    transaction,
  });
}

interface PaystackWebhookBody {
  event?: string;
  data?: {
    id?: number;
    reference?: string;
    amount?: number;
    currency?: string;
    paid_at?: string | null;
    status?: string;
    customer?: { customer_code?: string; email?: string };
    subscription_code?: string;
    plan?: { plan_code?: string };
    metadata?: unknown;
  };
}

function webhookMetadata(value: unknown): Record<string, unknown> {
  if (typeof value === "string" && value.length <= 4096) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
    } catch {
      return {};
    }
  }
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

export async function handlePaystackWebhook(
  rawBody: string,
  signature: string | null
): Promise<{ ok: boolean; status: number; decision: string }> {
  if (!verifyWebhookSignature(rawBody, signature)) {
    return { ok: false, status: 401, decision: "invalid_signature" };
  }
  let body: PaystackWebhookBody;
  try {
    body = JSON.parse(rawBody) as PaystackWebhookBody;
  } catch {
    return { ok: false, status: 400, decision: "invalid_json" };
  }
  const eventType = String(body.event ?? "");
  const data = body.data ?? {};
  const reference = String(data.reference ?? "");
  const subscription = reference
    ? await db.zeliSubscription.findUnique({ where: { providerReference: reference } })
    : null;
  const rawEventId =
    data.id != null
      ? `paystack:${eventType}:${data.id}`
      : `paystack:${eventType}:${reference || createHash("sha256").update(rawBody).digest("hex")}`;

  if (!subscription) {
    await db.zeliPaymentEvent
      .create({
        data: {
          provider: "paystack",
          eventId: rawEventId,
          eventType: eventType || "unknown",
          reference: reference || null,
          decision: "ignored",
          reason: "unknown_reference",
          processedAt: new Date(),
        },
      })
      .catch(() => undefined);
    return { ok: true, status: 200, decision: "ignored" };
  }

  if (eventType === "charge.success") {
    const result = await fulfilPaidSubscription({
      reference,
      eventId: rawEventId,
      eventType,
      transaction: {
        status: String(data.status ?? "success"),
        reference,
        amount: Number(data.amount ?? 0),
        currency: String(data.currency ?? ""),
        paidAt: data.paid_at ?? null,
        customerCode: data.customer?.customer_code ?? null,
        metadata: webhookMetadata(data.metadata),
        id: typeof data.id === "number" ? data.id : null,
      },
    });
    return { ok: true, status: 200, decision: result.decision };
  }

  if (eventType === "charge.failed") {
    await db.zeliSubscription.updateMany({
      where: { id: subscription.id, status: { in: ["pending", "past_due"] } },
      data: { status: "failed", failureReason: "Payment failed at provider" },
    });
  } else if (eventType === "refund.processed") {
    await db.$transaction(async (tx) => {
      await tx.zeliSubscription.update({
        where: { id: subscription.id },
        data: { status: "refunded", refundedAt: new Date() },
      });
      await tx.zeliEntitlement.updateMany({
        where: { tenantId: subscription.tenantId, featureKey: "zeli_analytics" },
        data: {
          status: "suspended",
          suspendedAt: new Date(),
          reason: "Subscription refunded; access suspended pending review",
        },
      });
      await tx.zeliEntitlementEvent.create({
        data: {
          tenantId: subscription.tenantId,
          action: "refund_suspended",
          status: "suspended",
          reason: `Paystack refund for ${reference}`,
          actorType: "payment_provider",
        },
      });
    });
  } else if (eventType === "subscription.create") {
    await db.zeliSubscription.updateMany({
      where: { id: subscription.id },
      data: {
        providerSubscriptionCode: data.subscription_code ?? null,
        providerCustomerCode: data.customer?.customer_code ?? subscription.providerCustomerCode,
      },
    });
  } else if (eventType === "subscription.disable" || eventType === "subscription.not_renew") {
    await db.zeliSubscription.updateMany({
      where: { id: subscription.id },
      data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
    });
  } else if (eventType === "invoice.payment_failed") {
    await db.zeliSubscription.updateMany({
      where: { id: subscription.id },
      data: { status: "past_due", failureReason: "Renewal invoice failed" },
    });
  }

  await db.zeliPaymentEvent
    .create({
      data: {
        provider: "paystack",
        eventId: rawEventId,
        eventType: eventType || "unknown",
        reference: reference || null,
        subscriptionId: subscription.id,
        tenantId: subscription.tenantId,
        decision: "processed",
        reason: eventType,
        processedAt: new Date(),
      },
    })
    .catch(() => undefined);
  return { ok: true, status: 200, decision: "processed" };
}

/** Tenant admin cancellation: access remains until the paid period ends. */
export async function cancelZeliSubscription(ctx: TenantContext): Promise<void> {
  if (ctx.role !== "admin") throw new SubscriptionError("Not permitted.", "forbidden");
  const subscription = await db.zeliSubscription.findFirst({
    where: { tenantId: ctx.tenantId, status: "active" },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) throw new SubscriptionError("No active subscription.", "not_found");
  await db.zeliSubscription.update({
    where: { id: subscription.id },
    data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
  });
}

/** Platform reconciliation when a webhook was missed. */
export async function reconcileZeliSubscription(
  subscriptionId: string
): Promise<{ decision: string }> {
  const subscription = await db.zeliSubscription.findUnique({
    where: { id: subscriptionId },
  });
  if (!subscription) throw new SubscriptionError("Subscription not found.", "not_found");
  if (!paystackConfigured()) {
    throw new SubscriptionError("Payment provider is not configured.", "provider_not_configured");
  }
  const result = await verifyAndFulfil(subscription.providerReference, "reconcile");
  return { decision: result.decision };
}

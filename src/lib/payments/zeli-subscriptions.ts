import { randomBytes, createHash } from "crypto";
import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant";
import {
  initializeTransaction,
  paystackReadyForCheckout,
  paystackConfigured,
  refundTransaction,
  verifyTransaction,
  verifyWebhookSignature,
  type PaystackTransaction,
} from "./paystack";
import { getZeliEntitlement } from "@/lib/zeli/entitlements";
import { assertZeliAvailable } from "@/lib/zeli/availability";

/**
 * Zeli subscription lifecycle.
 *
 * The provider webhook (or a server-side verify) is the authority. A browser
 * redirect never activates an entitlement. Every activation is idempotent on a
 * canonical provider transaction event and every side effect is conditional on
 * the state read inside the same transaction.
 *
 * Renewal policy:
 *  - a payment while a period is live extends from that period's end;
 *  - a payment after expiry starts from the verified payment time;
 *  - a payment for a checkout that a newer checkout superseded is treated as a
 *    duplicate and refunded, never silently discarded and never double-granted.
 */

export class SubscriptionError extends Error {
  code: string;
  constructor(message: string, code = "subscription_error") {
    super(message);
    this.name = "SubscriptionError";
    this.code = code;
  }
}

const PENDING_CHECKOUT_TTL_MS = 30 * 60 * 1000;
const REFUND_RETRY_AFTER_MS = 15 * 60 * 1000;

function addInterval(start: Date, interval: string): Date {
  const end = new Date(start);
  if (interval === "year") {
    const year = end.getUTCFullYear() + 1;
    const month = end.getUTCMonth();
    const day = Math.min(end.getUTCDate(), daysInMonth(year, month));
    end.setUTCFullYear(year, month, day);
    return end;
  }
  const month = end.getUTCMonth() + 1;
  const year = end.getUTCFullYear() + Math.floor(month / 12);
  const targetMonth = ((month % 12) + 12) % 12;
  const day = Math.min(end.getUTCDate(), daysInMonth(year, targetMonth));
  end.setUTCFullYear(year, targetMonth, day);
  return end;
}

function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
}

function maxDate(...values: Array<Date | null | undefined>): Date {
  return values.reduce<Date>((latest, value) => {
    if (!value) return latest;
    return value.getTime() > latest.getTime() ? value : latest;
  }, new Date(0));
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

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
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
  const configured = paystackReadyForCheckout();
  let message = "Secure checkout is available through Paystack.";
  if (!paystackConfigured()) {
    message =
      "Subscription checkout is not configured yet. Ask the platform administrator to configure the payment provider and catalogue.";
  } else if (!configured) {
    message =
      "Subscription checkout is not available for live payments yet. Ask the platform administrator to configure the production payment key.";
  }
  return { configured, provider: "paystack", message };
}

/** Start a checkout for a tenant administrator. Price comes from the database. */
export async function createZeliCheckout(
  ctx: TenantContext,
  planCode: string
): Promise<{ authorizationUrl: string; reference: string }> {
  await assertZeliAvailable();
  if (ctx.role !== "admin") {
    throw new SubscriptionError("Only a business administrator can subscribe.", "forbidden");
  }
  if (!paystackReadyForCheckout()) {
    throw new SubscriptionError(
      paystackConfigured()
        ? "Subscription checkout is not available for live payments yet."
        : "Subscription checkout is not configured yet.",
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
  const pendingKey = `${ctx.tenantId}:${plan.id}`;
  const cutoff = new Date(Date.now() - PENDING_CHECKOUT_TTL_MS);

  let created;
  try {
    created = await db.$transaction(async (tx) => {
      // A stale checkout can never stay payable forever: replace it only when
      // it is old enough that the customer has abandoned it.
      await tx.zeliSubscription.updateMany({
        where: {
          tenantId: ctx.tenantId,
          status: "pending",
          OR: [{ updatedAt: { lt: cutoff } }, { createdAt: { lt: cutoff } }],
        },
        data: {
          status: "expired",
          pendingKey: null,
          failureReason: "Checkout expired before payment",
        },
      });
      return tx.zeliSubscription.create({
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
          pendingKey,
        },
      });
    });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SubscriptionError(
        "A checkout for this package is already in progress. Complete it or try again in a few minutes.",
        "checkout_in_progress"
      );
    }
    throw error;
  }

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
    await db.zeliSubscription.updateMany({
      where: { id: created.id, status: "pending" },
      data: {
        status: "failed",
        pendingKey: null,
        failureReason: error instanceof Error ? error.message.slice(0, 200) : "initialization failed",
      },
    });
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError("Payment checkout could not be started. Please try again.", "initialization_failed");
  }
}

export type FulfilDecision =
  | "processed"
  | "ignored"
  | "failed"
  | "refund_requested"
  | "exception";

export interface FulfilResult {
  decision: FulfilDecision;
  subscriptionId: string | null;
  reason: string;
}

/* ------------------------------------------------------------------------- *
 * Payment-event ledger
 * ------------------------------------------------------------------------- */

interface EventIdentity {
  eventId: string;
  eventType: string;
  reference: string | null;
  subscriptionId: string | null;
  tenantId: string | null;
}

async function claimPaymentEvent(
  identity: EventIdentity
): Promise<"claimed" | "duplicate" | "in_progress"> {
  try {
    await db.zeliPaymentEvent.create({
      data: {
        provider: "paystack",
        eventId: identity.eventId,
        eventType: identity.eventType,
        reference: identity.reference,
        subscriptionId: identity.subscriptionId,
        tenantId: identity.tenantId,
        decision: "received",
        reason: "processing",
      },
    });
    return "claimed";
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
    const existing = await db.zeliPaymentEvent.findUnique({ where: { eventId: identity.eventId } });
    if (!existing) return "in_progress";
    if (existing.decision === "processed" || existing.decision === "ignored") return "duplicate";
    if (existing.decision === "failed") {
      const retry = await db.zeliPaymentEvent.updateMany({
        where: { eventId: identity.eventId, decision: "failed" },
        data: { decision: "received", reason: "retry", processedAt: null },
      });
      return retry.count > 0 ? "claimed" : "in_progress";
    }
    // A crash between claim and completion leaves "received". Retry only when
    // the claim is old enough that no process can still be working on it.
    if (existing.createdAt.getTime() < Date.now() - 5 * 60 * 1000) {
      const retry = await db.zeliPaymentEvent.updateMany({
        where: { eventId: identity.eventId, decision: "received" },
        data: { createdAt: new Date(), reason: "retry_stale" },
      });
      return retry.count > 0 ? "claimed" : "in_progress";
    }
    return "in_progress";
  }
}

async function finishEvent(
  eventId: string,
  decision: "processed" | "ignored" | "failed",
  reason: string
): Promise<void> {
  await db.zeliPaymentEvent.updateMany({
    where: { eventId },
    data: { decision, reason, processedAt: new Date() },
  });
}

async function recordException(input: {
  dedupeKey: string;
  tenantId?: string | null;
  subscriptionId?: string | null;
  reference?: string | null;
  kind: string;
  detail: string;
  amount?: number | null;
  currency?: string | null;
}): Promise<void> {
  try {
    await db.zeliPaymentException.create({
      data: {
        dedupeKey: input.dedupeKey,
        tenantId: input.tenantId ?? null,
        subscriptionId: input.subscriptionId ?? null,
        reference: input.reference ?? null,
        kind: input.kind,
        detail: input.detail.slice(0, 500),
        amount: input.amount ?? null,
        currency: input.currency ?? null,
      },
    });
  } catch (error) {
    if (!isUniqueViolation(error)) throw error;
  }
}

/* ------------------------------------------------------------------------- *
 * Charge fulfilment
 * ------------------------------------------------------------------------- */

interface InternalChargeResult {
  kind: "processed" | "ignored" | "refund";
  reason: string;
}

/**
 * Activate or extend a paid subscription. The event id must already be the
 * canonical transaction identity so a callback verification and the matching
 * webhook cannot both extend the period.
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

  const claim = await claimPaymentEvent({
    eventId: input.eventId,
    eventType: input.eventType,
    reference: input.reference,
    subscriptionId: subscription.id,
    tenantId: subscription.tenantId,
  });
  if (claim === "duplicate") {
    return { decision: "ignored", subscriptionId: subscription.id, reason: "duplicate_event" };
  }
  if (claim === "in_progress") {
    return { decision: "ignored", subscriptionId: subscription.id, reason: "processing" };
  }

  if (
    input.transaction.reference !== subscription.providerReference ||
    Number(input.transaction.amount) !== Math.round(Number(subscription.amount) * 100) ||
    input.transaction.currency.toUpperCase() !== subscription.currency.toUpperCase()
  ) {
    await finishEvent(input.eventId, "failed", "payment_mismatch");
    await recordException({
      dedupeKey: `payment_mismatch:${subscription.id}:${input.eventId}`,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      reference: input.reference,
      kind: "payment_mismatch",
      detail:
        "A provider payment did not match the stored reference, amount or currency. No access was granted.",
      amount: input.transaction.amount,
      currency: input.transaction.currency,
    });
    return { decision: "failed", subscriptionId: subscription.id, reason: "payment_mismatch" };
  }

  if (input.transaction.status !== "success") {
    await finishEvent(input.eventId, "ignored", "not_successful");
    return { decision: "ignored", subscriptionId: subscription.id, reason: "not_successful" };
  }

  let outcome: InternalChargeResult;
  try {
    outcome = await db.$transaction(async (tx) => {
      const fresh = await tx.zeliSubscription.findUniqueOrThrow({
        where: { id: subscription.id },
        include: { plan: true },
      });

      if (fresh.status === "refunded" || fresh.refundStatus === "processed") {
        return { kind: "ignored" as const, reason: "subscription_refunded" };
      }
      if (fresh.paidAt) {
        return { kind: "ignored" as const, reason: "duplicate_reference" };
      }

      // A payment for a checkout that a newer checkout replaced is an
      // unintended duplicate, not a renewal. Never discard it: refund it and
      // leave paid access untouched.
      if (fresh.status === "expired" && !fresh.paidAt) {
        const newer = await tx.zeliSubscription.findFirst({
          where: {
            tenantId: fresh.tenantId,
            createdAt: { gt: fresh.createdAt },
            status: { in: ["active", "pending", "past_due"] },
          },
          select: { providerReference: true },
          orderBy: { createdAt: "desc" },
        });
        if (newer) {
          await tx.zeliSubscription.update({
            where: { id: fresh.id },
            data: { status: "expired", supersededByReference: newer.providerReference },
          });
          return { kind: "refund" as const, reason: "superseded_checkout" };
        }
      }

      const entitlement = await tx.zeliEntitlement.findUnique({
        where: {
          tenantId_featureKey: {
            tenantId: fresh.tenantId,
            featureKey: "zeli_analytics",
          },
        },
      });
      const latest = await tx.zeliSubscription.findFirst({
        where: {
          tenantId: fresh.tenantId,
          id: { not: fresh.id },
          status: { in: ["active", "cancelled"] },
          periodEnd: { gt: new Date() },
        },
        orderBy: { periodEnd: "desc" },
      });

      const paidAt = input.transaction.paidAt ? new Date(input.transaction.paidAt) : new Date();
      const now = new Date();
      const parsedPaidAt = Number.isNaN(paidAt.getTime()) ? now : paidAt;
      // A provider timestamp in the future would start a period that has not
      // begun. Clamp it to the server clock.
      const verifiedPaidAt = parsedPaidAt.getTime() > now.getTime() ? now : parsedPaidAt;
      const boundary = maxDate(verifiedPaidAt, latest?.periodEnd, entitlement?.expiresAt);
      const base = boundary.getTime() > 0 ? boundary : verifiedPaidAt;
      const periodEnd = addInterval(base, fresh.plan.billingInterval);
      const entitlementStart = entitlement?.startsAt ?? (base.getTime() > now.getTime() ? now : base);

      await tx.zeliSubscription.updateMany({
        where: {
          tenantId: fresh.tenantId,
          id: { not: fresh.id },
          status: { in: ["active", "cancelled"] },
        },
        data: { status: "superseded" },
      });
      await tx.zeliSubscription.update({
        where: { id: fresh.id },
        data: {
          status: "active",
          periodStart: base,
          periodEnd,
          paidAt: verifiedPaidAt,
          periodGranted: true,
          pendingKey: null,
          cancelAtPeriodEnd: false,
          cancelledAt: null,
          failureReason: null,
          supersededByReference: null,
          providerCustomerCode:
            input.transaction.customerCode ?? fresh.providerCustomerCode,
        },
      });

      const keepManual =
        entitlement?.status === "active" &&
        entitlement.source === "manual" &&
        entitlement.expiresAt &&
        entitlement.expiresAt.getTime() > periodEnd.getTime();
      const finalExpiry = keepManual ? entitlement!.expiresAt! : periodEnd;
      const created = await tx.zeliEntitlement.upsert({
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
          startsAt: entitlementStart,
          expiresAt: finalExpiry,
        },
        update: {
          status: "active",
          source: keepManual ? "manual" : "subscription",
          reason: `Paid subscription ${fresh.plan.code} (${fresh.providerReference})`,
          expiresAt: finalExpiry,
          suspendedAt: null,
          revokedAt: null,
          revokedById: null,
        },
      });
      await tx.zeliEntitlementEvent.create({
        data: {
          entitlementId: created.id,
          tenantId: fresh.tenantId,
          action: entitlement ? "subscription_renewed" : "subscription_activated",
          previousStatus: entitlement?.status ?? null,
          status: "active",
          reason: `Paystack payment ${fresh.providerReference}`,
          actorType: "payment_provider",
          expiresAt: finalExpiry,
        },
      });
      return { kind: "processed" as const, reason: "paid" };
    });
  } catch (error) {
    await finishEvent(input.eventId, "failed", "processing_failure");
    await recordException({
      dedupeKey: `processing_failure:${subscription.id}:${input.eventId}`,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      reference: input.reference,
      kind: "processing_failure",
      detail: "A verified payment could not be applied. It will be retried; no access was granted yet.",
    });
    if (process.env.NODE_ENV !== "test") {
      console.error("zeli_payment_processing_failed", {
        subscriptionId: subscription.id,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return { decision: "failed", subscriptionId: subscription.id, reason: "transaction_failed" };
  }

  if (outcome.kind === "refund") {
    const refund = await requestProviderRefund({
      subscriptionId: subscription.id,
      reason: "A payment settled for a checkout that a newer checkout had already replaced.",
      actorId: null,
      tenantId: subscription.tenantId,
    });
    await finishEvent(input.eventId, "processed", refund.reason);
    return {
      decision: refund.decision === "failed" ? "exception" : "refund_requested",
      subscriptionId: subscription.id,
      reason: refund.reason,
    };
  }

  await finishEvent(
    input.eventId,
    outcome.kind === "processed" ? "processed" : "ignored",
    outcome.reason
  );
  return { decision: outcome.kind, subscriptionId: subscription.id, reason: outcome.reason };
}

/* ------------------------------------------------------------------------- *
 * Refunds
 * ------------------------------------------------------------------------- */

interface RefundOutcome {
  decision: "refunded" | "refund_requested" | "already_processed" | "already_pending" | "failed";
  reason: string;
}

async function suspendEntitlementForRefund(
  tenantId: string,
  reference: string
): Promise<void> {
  await db.$transaction(async (tx) => {
    const entitlement = await tx.zeliEntitlement.findUnique({
      where: {
        tenantId_featureKey: { tenantId, featureKey: "zeli_analytics" },
      },
    });
    if (!entitlement || entitlement.status === "suspended") return;
    await tx.zeliEntitlement.update({
      where: { id: entitlement.id },
      data: {
        status: "suspended",
        suspendedAt: new Date(),
        reason: "Subscription refunded; access suspended pending review",
      },
    });
    await tx.zeliEntitlementEvent.create({
      data: {
        entitlementId: entitlement.id,
        tenantId,
        action: "refund_suspended",
        previousStatus: entitlement.status,
        status: "suspended",
        reason: `Paystack refund for ${reference}`,
        actorType: "payment_provider",
      },
    });
  });
}

async function requestProviderRefund(input: {
  subscriptionId: string;
  reason: string;
  actorId: string | null;
  tenantId: string | null;
}): Promise<RefundOutcome> {
  const subscription = await db.zeliSubscription.findUnique({
    where: { id: input.subscriptionId },
  });
  if (!subscription) return { decision: "failed", reason: "not_found" };
  if (input.tenantId && subscription.tenantId !== input.tenantId) {
    return { decision: "failed", reason: "not_found" };
  }
  if (subscription.refundStatus === "processed") {
    return { decision: "already_processed", reason: "refund_processed" };
  }
  if (
    subscription.refundStatus === "pending" &&
    subscription.updatedAt.getTime() > Date.now() - REFUND_RETRY_AFTER_MS
  ) {
    return { decision: "already_pending", reason: "refund_pending" };
  }

  const claim = await db.zeliSubscription.updateMany({
    where: {
      id: subscription.id,
      OR: [
        { refundStatus: null },
        { refundStatus: "failed" },
        {
          refundStatus: "pending",
          updatedAt: { lt: new Date(Date.now() - REFUND_RETRY_AFTER_MS) },
        },
      ],
    },
    data: { refundStatus: "pending", refundFailureReason: null },
  });
  if (claim.count === 0) {
    return { decision: "already_pending", reason: "refund_already_claimed" };
  }

  try {
    const refund = await refundTransaction(subscription.providerReference);
    const status =
      refund.status === "processed" ? "processed" : refund.status === "failed" ? "failed" : "pending";
    await db.zeliSubscription.update({
      where: { id: subscription.id },
      data: {
        refundStatus: status,
        refundReference: String(refund.id),
        refundedAt: status === "processed" ? new Date() : subscription.refundedAt,
        refundFailureReason: status === "failed" ? "Provider reported the refund as failed" : null,
        status: status === "processed" ? "refunded" : subscription.status,
      },
    });
    if (status === "failed") {
      await recordException({
        dedupeKey: `refund_failed:${subscription.providerReference}`,
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        reference: subscription.providerReference,
        kind: "refund_failed",
        detail: `Paystack reported refund ${refund.id} as failed. Reconcile manually.`,
        amount: Number(subscription.amount),
        currency: subscription.currency,
      });
      return { decision: "failed", reason: "refund_failed" };
    }
    if (status === "processed" && subscription.periodGranted) {
      await suspendEntitlementForRefund(subscription.tenantId, subscription.providerReference);
    }
    return {
      decision: status === "processed" ? "refunded" : "refund_requested",
      reason: status,
    };
  } catch (error) {
    await db.zeliSubscription.update({
      where: { id: subscription.id },
      data: {
        refundStatus: "failed",
        refundFailureReason:
          error instanceof Error ? error.message.slice(0, 200) : "refund request failed",
      },
    });
    await recordException({
      dedupeKey: `refund_failed:${subscription.providerReference}`,
      tenantId: subscription.tenantId,
      subscriptionId: subscription.id,
      reference: subscription.providerReference,
      kind: "refund_failed",
      detail:
        "The automatic refund could not be completed. The payment is recorded and requires reconciliation; no refund is reported as successful.",
      amount: Number(subscription.amount),
      currency: subscription.currency,
    });
    return { decision: "failed", reason: "refund_failed" };
  }
}

/**
 * Platform reconciliation entrypoint for a duplicate settlement or a refund
 * that previously failed. Safe to call repeatedly.
 */
export async function retryZeliPaymentRefund(input: {
  subscriptionId: string;
  reason: string;
  actorId: string | null;
  tenantId: string | null;
}): Promise<{ decision: RefundOutcome["decision"]; reason: string }> {
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    throw new SubscriptionError("Enter a reason of at least 10 characters.", "invalid_reason");
  }
  return requestProviderRefund(input);
}

/* ------------------------------------------------------------------------- *
 * Webhook
 * ------------------------------------------------------------------------- */

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
    refunded_at?: string | null;
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

function canonicalEventId(eventType: string, data: PaystackWebhookBody["data"], rawBody: string): string {
  if (data?.id != null) return `paystack:${eventType}:${data.id}`;
  if (eventType === "charge.success" && data?.reference) {
    // Same identity as verifyAndFulfil when the provider omits the numeric id,
    // so the webhook and the callback cannot both extend the period.
    return `paystack:charge.success:ref:${data.reference}`;
  }
  return `paystack:${eventType}:${createHash("sha256").update(rawBody).digest("hex")}`;
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
  const eventId = canonicalEventId(eventType, data, rawBody);

  if (eventType === "charge.success") {
    if (!subscription) {
      const claim = await claimPaymentEvent({
        eventId,
        eventType,
        reference: reference || null,
        subscriptionId: null,
        tenantId: null,
      });
      if (claim === "claimed") {
        await finishEvent(eventId, "ignored", "unknown_reference");
      }
      return { ok: true, status: 200, decision: "ignored" };
    }
    const result = await fulfilPaidSubscription({
      reference,
      eventId,
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
    return {
      ok: result.decision !== "failed" && result.decision !== "exception",
      status: result.decision === "failed" || result.decision === "exception" ? 500 : 200,
      decision: result.decision,
    };
  }

  const claim = await claimPaymentEvent({
    eventId,
    eventType,
    reference: reference || null,
    subscriptionId: subscription?.id ?? null,
    tenantId: subscription?.tenantId ?? null,
  });
  if (claim === "duplicate") {
    return { ok: true, status: 200, decision: "ignored" };
  }
  if (claim === "in_progress") {
    return { ok: true, status: 200, decision: "ignored" };
  }

  if (!subscription) {
    await finishEvent(eventId, "ignored", "unknown_reference");
    return { ok: true, status: 200, decision: "ignored" };
  }

  const supported = new Set([
    "charge.failed",
    "refund.processed",
    "refund.pending",
    "refund.failed",
    "subscription.create",
    "subscription.disable",
    "subscription.not_renew",
    "invoice.payment_failed",
  ]);
  if (!supported.has(eventType)) {
    await finishEvent(eventId, "ignored", "unsupported_event");
    return { ok: true, status: 200, decision: "ignored" };
  }

  try {
    await db.$transaction(async (tx) => {
      if (eventType === "charge.failed") {
        await tx.zeliSubscription.updateMany({
          where: { id: subscription.id, status: { in: ["pending", "past_due"] } },
          data: {
            status: "failed",
            pendingKey: null,
            failureReason: "Payment failed at provider",
          },
        });
      } else if (eventType === "refund.processed" || eventType === "refund.pending") {
        const fresh = await tx.zeliSubscription.findUniqueOrThrow({
          where: { id: subscription.id },
        });
        const processed = eventType === "refund.processed";
        await tx.zeliSubscription.update({
          where: { id: subscription.id },
          data: {
            refundStatus: processed ? "processed" : "pending",
            refundedAt: processed ? new Date() : fresh.refundedAt,
            status: processed ? "refunded" : fresh.status,
          },
        });
        if (processed && fresh.periodGranted) {
          const entitlement = await tx.zeliEntitlement.findUnique({
            where: {
              tenantId_featureKey: {
                tenantId: subscription.tenantId,
                featureKey: "zeli_analytics",
              },
            },
          });
          if (entitlement && entitlement.status !== "suspended") {
            await tx.zeliEntitlement.update({
              where: { id: entitlement.id },
              data: {
                status: "suspended",
                suspendedAt: new Date(),
                reason: "Subscription refunded; access suspended pending review",
              },
            });
            await tx.zeliEntitlementEvent.create({
              data: {
                entitlementId: entitlement.id,
                tenantId: subscription.tenantId,
                action: "refund_suspended",
                previousStatus: entitlement.status,
                status: "suspended",
                reason: `Paystack refund for ${reference}`,
                actorType: "payment_provider",
              },
            });
          }
        }
      } else if (eventType === "refund.failed") {
        await tx.zeliSubscription.update({
          where: { id: subscription.id },
          data: {
            refundStatus: "failed",
            refundFailureReason: "Provider reported the refund as failed",
          },
        });
      } else if (eventType === "subscription.create") {
        await tx.zeliSubscription.updateMany({
          where: { id: subscription.id },
          data: {
            providerSubscriptionCode: data.subscription_code ?? null,
            providerCustomerCode:
              data.customer?.customer_code ?? subscription.providerCustomerCode,
          },
        });
      } else if (eventType === "subscription.disable" || eventType === "subscription.not_renew") {
        await tx.zeliSubscription.updateMany({
          where: { id: subscription.id },
          data: { cancelAtPeriodEnd: true, cancelledAt: new Date() },
        });
      } else if (eventType === "invoice.payment_failed") {
        await tx.zeliSubscription.updateMany({
          where: { id: subscription.id, status: { in: ["active", "past_due"] } },
          data: { status: "past_due", failureReason: "Renewal invoice failed" },
        });
      }
    });

    if (eventType === "refund.failed") {
      await recordException({
        dedupeKey: `refund_failed:${reference}`,
        tenantId: subscription.tenantId,
        subscriptionId: subscription.id,
        reference,
        kind: "refund_failed",
        detail: "Paystack reported the refund as failed. Reconcile manually.",
        amount: Number(subscription.amount),
        currency: subscription.currency,
      });
    }

    await finishEvent(
      eventId,
      "processed",
      eventType || "processed"
    );
    return { ok: true, status: 200, decision: "processed" };
  } catch (error) {
    await finishEvent(eventId, "failed", "processing_failure");
    if (process.env.NODE_ENV !== "test") {
      console.error("zeli_webhook_processing_failed", {
        eventType,
        error: error instanceof Error ? error.name : "unknown",
      });
    }
    return { ok: false, status: 500, decision: "processing_failure" };
  }
}

/** Verify a callback/server reconciliation without trusting the redirect. */
export async function verifyAndFulfil(reference: string, source: string): Promise<FulfilResult> {
  const transaction = await verifyTransaction(reference);
  const eventId =
    transaction.id != null
      ? `paystack:charge.success:${transaction.id}`
      : `paystack:charge.success:ref:${reference}`;
  return fulfilPaidSubscription({
    reference,
    eventId,
    eventType: "charge.success",
    transaction,
  });
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

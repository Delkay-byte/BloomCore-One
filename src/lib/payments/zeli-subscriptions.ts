import { randomBytes, createHash } from "crypto";
import { db } from "@/lib/db";
import type { TenantContext } from "@/lib/tenant";
import {
  assertLiveChargePermitted,
  chargeMobileMoney,
  initializeTransaction,
  lookupTransaction,
  paystackReadyForCheckout,
  paystackConfigured,
  refundTransaction,
  submitChargeOtp,
  verifyTransaction,
  verifyWebhookRequest,
  MOBILE_MONEY_PROVIDERS,
  PaystackError,
  type MobileMoneyProvider,
  type PaystackTransaction,
} from "./paystack";
import { getZeliEntitlement } from "@/lib/zeli/entitlements";
import { assertZeliAvailable } from "@/lib/zeli/availability";
import { normalizeGhanaPhone } from "@/lib/utils";
import { effectiveMonthlyPrice, consumeFoundingPeriod } from "@/lib/pricing/founding";
import { logSecurityEvent } from "@/lib/security/log";
import {
  attemptMessage,
  canReplaceReference,
  claimChargeAttempt,
  findChargeAttempt,
  isChargeRequiredAction,
  isOpenAttempt,
  recordAttemptOutcome,
  settleOpenAttempt,
  type ChargeRequiredAction,
} from "@/lib/payments/charge-attempts";
import { sanitizeProviderMessage } from "./paystack";
import { liveBlockedExplanation } from "./live-readiness";
import {
  HOSTED_CHECKOUT_CHANNELS,
  isTrustedCheckoutUrl,
} from "./checkout-url";
import {
  queuePlatformPaymentEmailDelivery,
  recordPlatformPaymentNotification,
} from "@/lib/notifications/platform-payments";

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

/** Ghana mobile money wants the local 0XXXXXXXXX form, as Paystack documents. */
function normalizeMobileMoneyPhone(input: string): string | null {
  const candidates = normalizeGhanaPhone(String(input ?? "").trim());
  return candidates.find((value) => /^0\d{9}$/.test(value)) ?? null;
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

/**
 * Origin of the request currently being served, for the local live-payment
 * guard. Returns null outside a request (tests, background jobs), where the
 * configured SITE_URL is used instead.
 */
async function requestOrigin(): Promise<string | null> {
  try {
    const { headers } = await import("next/headers");
    const headerBag = await headers();
    const origin = headerBag.get("origin");
    if (origin) return origin;
    const host = headerBag.get("x-forwarded-host") ?? headerBag.get("host");
    if (!host) return null;
    const proto =
      headerBag.get("x-forwarded-proto") ??
      (/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host) ? "http" : "https");
    return `${proto}://${host}`;
  } catch {
    return null;
  }
}

/**
 * Refuse a genuine live charge unless this process is the designated local
 * test setup. A test key is unaffected, and a hosted deployment keeps its
 * normal behaviour. No secret is ever logged: only sanitized reason codes.
 */
async function assertLiveChargeEnvironment(input: {
  userId: string;
  tenantId: string;
  tenantCode: string | null;
}): Promise<void> {
  try {
    assertLiveChargePermitted({
      origin: await requestOrigin(),
      tenantId: input.tenantId,
      tenantCode: input.tenantCode,
    });
  } catch (error) {
    if (error instanceof PaystackError) {
      logSecurityEvent({
        event: "payment.live_test_blocked",
        outcome: "blocked",
        actorType: "user",
        actorId: input.userId,
        tenantId: input.tenantId,
        reason: error.code.slice(0, 120),
      });
      // Name the actual missing condition instead of one generic sentence. The
      // text comes from a fixed table, so no credential or provider payload can
      // ever reach the page or the log.
      throw new SubscriptionError(liveBlockedExplanation(error.code), "live_test_blocked");
    }
    throw error;
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
interface PreparedCheckout {
  plan: { id: string; code: string; price: unknown; currency: string; billingInterval: string };
  email: string;
  reference: string;
  createdId: string;
  /** Effective price for this period (founding or standard). */
  amount: number;
  foundingAllocationId: string | null;
  standardAmount: number;
}

/**
 * Shared validation and pending-row creation for every provider flow (hosted
 * checkout and direct Ghana mobile money). The price always comes from the
 * database; nothing here accepts an amount from the browser.
 */
async function preparePendingSubscription(
  ctx: TenantContext,
  planCode: string,
  channel: "hosted" | "mobile_money" = "hosted"
): Promise<PreparedCheckout> {
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
  if (activeSubscription && activeSubscription.planId === plan.id) {
    // Same plan: a second checkout would be a duplicate. A different plan is an
    // intentional package change and is allowed to extend from the live period.
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

  // A live key may only be used here when this is the designated local test
  // setup. Checked before any pending row is created, so a blocked attempt
  // leaves no payable intent behind.
  await assertLiveChargeEnvironment({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    tenantCode: tenant?.code ?? null,
  });

  // A payable intent for the same plan and term is reused verbatim. Its
  // reference has already been shown to the owner and may already carry a
  // provider charge, so replacing it here would silently invalidate both.
  const billingTerm = plan.billingInterval === "year" ? "annual" : "monthly";
  const payable = await db.zeliSubscription.findFirst({
    where: {
      tenantId: ctx.tenantId,
      planId: plan.id,
      billingTerm,
      status: { in: ["pending", "pending_payment"] },
      paidAt: null,
    },
    orderBy: { createdAt: "desc" },
  });
  if (payable) {
    return {
      plan,
      email,
      reference: payable.providerReference,
      createdId: payable.id,
      amount: Number(payable.amount),
      foundingAllocationId: payable.foundingAllocationId,
      standardAmount: Number(payable.standardAmount ?? plan.price),
    };
  }

  // Reference prefix records the flow, so the webhook can require provider
  // verification for direct mobile money charges. References are ours.
  const reference = `${
    channel === "mobile_money" ? "ZELIM" : "ZELI"
  }-${ctx.tenantId.slice(0, 8)}-${randomBytes(8).toString("hex")}`;
  const pendingKey = `${ctx.tenantId}:${plan.id}`;
  const effective = await effectiveMonthlyPrice({
    tenantId: ctx.tenantId,
    plan: { id: plan.id, code: plan.code, billingInterval: plan.billingInterval, price: plan.price, foundingPrice: plan.foundingPrice },
  });
  const amount = Number(effective.amount);
  const standardAmount = Number(plan.price);
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
          amount,
          currency: plan.currency,
          billingTerm: plan.billingInterval === "year" ? "annual" : "monthly",
          foundingAllocationId: effective.allocationId,
          standardAmount,
          periodStart: null,
          periodEnd: null,
          pendingKey,
        },
      });
    }, { timeout: 20000, maxWait: 10000 });
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SubscriptionError(
        "A checkout for this package is already in progress. Complete it or try again in a few minutes.",
        "checkout_in_progress"
      );
    }
    throw error;
  }

  return {
    plan,
    email,
    reference,
    createdId: created.id,
    amount,
    foundingAllocationId: effective.allocationId,
    standardAmount,
  };
}

async function failPendingCheckout(id: string, reason: string): Promise<void> {
  await db.zeliSubscription.updateMany({
    where: { id, status: "pending" },
    data: {
      status: "failed",
      pendingKey: null,
      failureReason: reason.slice(0, 200),
    },
  });
}

/** Start a hosted-checkout payment for a tenant administrator. */
export async function createZeliCheckout(
  ctx: TenantContext,
  planCode: string
): Promise<HostedCheckout> {
  const { plan, email, reference, createdId, amount } = await preparePendingSubscription(ctx, planCode);

  try {
    return await initializeHostedCheckout({
      subscription: {
        id: createdId,
        providerReference: reference,
        amount,
        currency: plan.currency,
        plan: { code: plan.code },
      },
      tenantId: ctx.tenantId,
      email,
      amount,
    });
  } catch (error) {
    // Only retire the payable row when no provider attempt is still open. An
    // unresolved or legacy attempt must remain payable for reconciliation.
    const current = await db.zeliSubscription.findUnique({
      where: { id: createdId },
      select: { providerReference: true },
    });
    const attempt = current ? await findChargeAttempt(current.providerReference) : null;
    if (!attempt || !isOpenAttempt(attempt.state)) {
      await failPendingCheckout(
        createdId,
        error instanceof Error ? error.message : "initialization failed"
      );
    }
    if (error instanceof SubscriptionError) throw error;
    throw new SubscriptionError(
      "Payment checkout could not be started. Please try again.",
      "initialization_failed"
    );
  }
}

export interface HostedCheckout {
  reference: string;
  authorizationUrl: string;
  status: "pending";
  requiredAction: "checkout";
  message: string;
}

const HOSTED_CHECKOUT_MESSAGE =
  "Complete the payment in the Paystack checkout tab, then return here and check the payment status.";

/**
 * Reopen an already-initialised checkout instead of creating a second one.
 *
 * Paystack authorisation URLs are transaction-specific and remain usable while
 * the transaction is open. Returning the stored URL is the only safe answer for
 * a pending attempt: re-initialising the same reference is refused by Paystack,
 * and a concurrent click must never produce another transaction.
 */
function reusableHostedCheckout(attempt: {
  reference: string;
  state: string;
  requiredAction: string | null;
  checkoutUrl: string | null;
}): HostedCheckout | null {
  if (
    attempt.state === "pending" &&
    attempt.requiredAction === "checkout" &&
    attempt.checkoutUrl &&
    isTrustedCheckoutUrl(attempt.checkoutUrl)
  ) {
    return {
      reference: attempt.reference,
      authorizationUrl: attempt.checkoutUrl,
      status: "pending",
      requiredAction: "checkout",
      message: HOSTED_CHECKOUT_MESSAGE,
    };
  }
  return null;
}

/**
 * Start (or safely reopen) one Paystack hosted checkout for an existing
 * payable subscription.
 *
 * The charge-attempt row is the single authority: it is claimed atomically
 * before the provider is contacted, it stores the trusted checkout URL, and it
 * blocks any second initialisation while the transaction is open. A reference
 * is rotated only after the previous attempt is definitively closed.
 */
async function initializeHostedCheckout(input: {
  subscription: {
    id: string;
    providerReference: string;
    amount: unknown;
    currency: string;
    plan: { code: string };
  };
  tenantId: string;
  email: string;
  amount: number;
}): Promise<HostedCheckout> {
  let reference = input.subscription.providerReference;
  const existing = await findChargeAttempt(reference);
  if (existing) {
    if (existing.state === "succeeded") {
      throw new SubscriptionError("This payment is already confirmed.", "already_active");
    }
    const reusable = reusableHostedCheckout(existing);
    if (reusable) return reusable;
    if (!canReplaceReference(existing.state)) {
      // `pending` here is a legacy direct-charge attempt (OTP or phone prompt).
      // It is never re-initialised as hosted; the owner finishes or reconciles
      // that existing authorisation instead.
      throw new SubscriptionError(attemptMessage(existing), "charge_unresolved");
    }
    const rotated = await rotateProviderReference(input.subscription.id, reference);
    if (!rotated) {
      const current = await db.zeliSubscription.findUnique({
        where: { id: input.subscription.id },
        select: { providerReference: true },
      });
      const attempt = current ? await findChargeAttempt(current.providerReference) : null;
      if (attempt) {
        const reuse = reusableHostedCheckout(attempt);
        if (reuse) return reuse;
      }
      throw new SubscriptionError(
        attempt
          ? attemptMessage(attempt)
          : "The payment reference changed. Reopen billing and try again.",
        "charge_unresolved"
      );
    }
    reference = rotated;
  }

  const claim = await claimChargeAttempt({
    reference,
    tenantId: input.tenantId,
    subscriptionId: input.subscription.id,
    method: "hosted",
    amount: input.amount,
    currency: input.subscription.currency,
    requiredAction: "checkout",
  });
  if (!claim.claimed) {
    const reuse = reusableHostedCheckout(claim.attempt);
    if (reuse) return reuse;
    throw new SubscriptionError(attemptMessage(claim.attempt), "charge_unresolved");
  }

  try {
    const initialized = await initializeTransaction({
      email: input.email,
      amountSubunit: amountSubunit(input.amount),
      currency: input.subscription.currency,
      reference,
      callbackUrl: `${baseUrl()}/checkout/return?reference=${encodeURIComponent(reference)}`,
      channels: [...HOSTED_CHECKOUT_CHANNELS],
      metadata: {
        zeli_subscription_id: input.subscription.id,
        plan_code: input.subscription.plan.code,
      },
    });
    if (initialized.reference !== reference) {
      await recordAttemptOutcome(claim.attempt.id, {
        state: "unresolved",
        reason: "provider returned a different reference",
      });
      throw new SubscriptionError(
        "Payment provider returned a different reference.",
        "reference_mismatch"
      );
    }
    await recordAttemptOutcome(claim.attempt.id, {
      state: "pending",
      requiredAction: "checkout",
      checkoutUrl: initialized.authorizationUrl,
      providerHttpStatus: 200,
      reason: HOSTED_CHECKOUT_MESSAGE,
    });
    return {
      reference,
      authorizationUrl: initialized.authorizationUrl,
      status: "pending",
      requiredAction: "checkout",
      message: HOSTED_CHECKOUT_MESSAGE,
    };
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;
    if (error instanceof PaystackError) {
      const safe = error.safeMessage ?? sanitizeProviderMessage(error.message);
      if (error.failureKind === "rejected") {
        await recordAttemptOutcome(claim.attempt.id, {
          state: "rejected",
          providerHttpStatus: error.providerStatus ?? null,
          providerCode: error.providerCode ?? null,
          reason: safe,
        });
        throw new SubscriptionError(
          safe
            ? `Paystack did not accept this checkout: ${safe} No money was taken.`
            : "Paystack did not accept this checkout. No money was taken.",
          "charge_rejected"
        );
      }
    }
    await recordAttemptOutcome(claim.attempt.id, {
      state: "unresolved",
      reason: "could not confirm whether the checkout was created",
    });
    throw new SubscriptionError(
      "We could not confirm whether Paystack opened the checkout. Do not pay again. Use Check payment status first.",
      "charge_unresolved"
    );
  }
}

/**
 * Pay a subscription that was created by controlled provisioning.
 *
 * Provisioning stores the approved plan, term and effective amount on a
 * `pending_payment` row. This function reuses that row (and its unique
 * reference) instead of creating a second checkout, so a business can never
 * end up with two live subscriptions for the same approval.
 */
/**
 * Start a direct Ghana mobile money charge for a subscription that already
 * exists.
 *
 * The subscription row and its reference are never recreated here. The
 * charge-attempt ledger is the gate: it allows exactly one in-flight provider
 * call per reference, remembers an accepted prompt, and refuses to call the
 * provider again while an outcome is unknown. A definite rejection may be
 * retried on the same reference; a failed, pending or successful charge needs
 * reconciliation or a fresh intent.
 */
async function initiateMobileMoneyCharge(input: {
  subscription: {
    id: string;
    providerReference: string;
    amount: unknown;
    currency: string;
    plan: { code: string };
  };
  tenantId: string;
  email: string;
  phone: string;
  provider: MobileMoneyProvider;
}): Promise<MobileMoneyCheckout> {
  const amount = Number(input.subscription.amount);
  let reference = input.subscription.providerReference;

  /**
   * A reference that already carries an attempt is never charged blindly.
   *
   *   pending      → return the prompt that is already on the phone
   *   initiating   → another request owns it
   *   unresolved   → reconcile first
   *   succeeded    → nothing left to pay
   *   rejected     → retry only after proving Paystack holds no transaction
   *   failed       → keep the subscription, rotate to a fresh reference
   */
  const previous = await findChargeAttempt(reference);
  if (previous) {
    if (previous.state === "pending") {
      return pendingCheckout(reference, previous);
    }
    if (previous.state === "succeeded") {
      throw new SubscriptionError("This payment is already confirmed.", "already_active");
    }
    if (previous.state === "initiating" || previous.state === "unresolved") {
      throw new SubscriptionError(attemptMessage(previous), "charge_unresolved");
    }
    if (previous.state === "rejected") {
      let transactionExists = false;
      try {
        transactionExists = (await lookupTransaction(reference)).found;
      } catch {
        await recordAttemptOutcome(previous.id, {
          state: "unresolved",
          reason: "could not confirm the rejected attempt",
        });
        throw new SubscriptionError(
          "We could not confirm the previous attempt with Paystack. Do not pay again. Use Check payment status first.",
          "charge_unresolved"
        );
      }
      if (transactionExists) {
        // The provider holds a transaction for a reference we thought was
        // refused. Reconcile it; never charge it again.
        await recordAttemptOutcome(previous.id, {
          state: "unresolved",
          reason: "provider has a transaction for this reference",
        });
        throw new SubscriptionError(
          "A Paystack transaction already exists for this reference. Use Check payment status instead of paying again.",
          "charge_unresolved"
        );
      }
      // No transaction: the refusal is confirmed, so the same reference may be
      // retried under the ledger's atomic re-claim.
    }
    if (previous.state === "failed") {
      const rotated = await rotateProviderReference(input.subscription.id, reference);
      if (!rotated) {
        // Another request rotated first, or the intent is no longer payable.
        const current = await db.zeliSubscription.findUnique({
          where: { id: input.subscription.id },
          select: { providerReference: true },
        });
        reference = current?.providerReference ?? reference;
        const attempt = await findChargeAttempt(reference);
        if (attempt?.state === "pending") {
          return pendingCheckout(reference, attempt);
        }
        throw new SubscriptionError(
          attempt
            ? attemptMessage(attempt)
            : "The payment reference changed. Reopen billing and try again.",
          "charge_unresolved"
        );
      }
      reference = rotated;
    }
  }

  const claim = await claimChargeAttempt({
    reference,
    tenantId: input.tenantId,
    subscriptionId: input.subscription.id,
    method: "mobile_money",
    network: input.provider,
    amount,
    currency: input.subscription.currency,
  });

  if (!claim.claimed) {
    // A concurrent request won the claim. Return its state; never charge again.
    const attempt = claim.attempt;
    if (attempt.state === "pending") {
      return pendingCheckout(reference, attempt);
    }
    if (attempt.state === "succeeded") {
      throw new SubscriptionError("This payment is already confirmed.", "already_active");
    }
    throw new SubscriptionError(attemptMessage(attempt), "charge_unresolved");
  }

  const attemptId = claim.attempt.id;
  try {
    const charge = await chargeMobileMoney({
      email: input.email,
      amountSubunit: amountSubunit(amount),
      currency: "GHS",
      phone: input.phone,
      provider: input.provider,
      reference,
      metadata: {
        zeli_subscription_id: input.subscription.id,
        plan_code: input.subscription.plan.code,
        channel: "mobile_money",
      },
    });
    if (charge.reference !== reference) {
      await recordAttemptOutcome(attemptId, {
        state: "unresolved",
        reason: "provider returned a different reference",
      });
      throw new SubscriptionError(
        "Payment provider returned a different reference.",
        "reference_mismatch"
      );
    }
    if (charge.status === "failed") {
      await recordAttemptOutcome(attemptId, {
        state: "failed",
        providerHttpStatus: 200,
        reason: charge.message ? sanitizeProviderMessage(charge.message) : "charge declined",
      });
      await recordChargeFailure(input.subscription.id, "The mobile money charge was declined");
      throw new SubscriptionError(
        "The mobile money charge was declined. No payment was taken.",
        "charge_failed"
      );
    }
    await recordAttemptOutcome(attemptId, {
      state: "pending",
      requiredAction: requiredActionForChargeStatus(charge.status),
      providerHttpStatus: 200,
      reason:
        charge.displayText ||
        charge.message ||
        (charge.status === "send_otp"
          ? "Paystack sent a verification code to your phone. Enter it here to finish the payment."
          : "Approve the payment prompt on your phone, then check the payment status."),
    });
    return {
      reference,
      status: charge.status,
      displayText: charge.displayText,
      message: charge.message,
      requiredAction: requiredActionForChargeStatus(charge.status),
    };
  } catch (error) {
    if (error instanceof SubscriptionError) throw error;

    if (error instanceof PaystackError) {
      const providerStatus = error.providerStatus ?? null;
      const providerCode = error.providerCode ?? null;
      const safe = error.safeMessage ?? sanitizeProviderMessage(error.message);

      if (error.failureKind === "rejected") {
        // The provider refused the request and created no charge. Keep the
        // intent payable so the same reference can be used after the input is
        // corrected; never silently replace it.
        await recordAttemptOutcome(attemptId, {
          state: "rejected",
          providerHttpStatus: providerStatus,
          providerCode,
          reason: safe,
        });
        await recordChargeFailure(
          input.subscription.id,
          safe ? `Paystack refused the charge: ${safe}` : "Paystack refused the charge"
        );
        logSecurityEvent({
          event: "payment.charge_rejected",
          outcome: "blocked",
          actorType: "user",
          tenantId: input.tenantId,
          reason: providerCode ?? error.code,
          detail: `http:${providerStatus ?? 0} ref:${reference.slice(0, 18)}`,
        });
        throw new SubscriptionError(
          safe
            ? `Paystack did not accept this mobile money charge: ${safe} No money was taken.`
            : "Paystack did not accept this mobile money charge. No money was taken.",
          "charge_rejected"
        );
      }

      // Timeout, 5xx, throttling or a broken response: Paystack may or may not
      // hold a charge. Never retry blindly, never create a new reference.
      await recordAttemptOutcome(attemptId, {
        state: "unresolved",
        providerHttpStatus: providerStatus,
        providerCode,
        reason: safe,
      });
      logSecurityEvent({
        event: "payment.charge_unresolved",
        outcome: "failure",
        actorType: "user",
        tenantId: input.tenantId,
        reason: providerCode ?? error.code,
        detail: `http:${providerStatus ?? 0} ref:${reference.slice(0, 18)}`,
      });
      throw new SubscriptionError(
        "We could not confirm whether Paystack received this payment request. Do not pay again. Use Check payment status and MaaCash will reconcile it first.",
        "charge_unresolved"
      );
    }

    await recordAttemptOutcome(attemptId, {
      state: "unresolved",
      reason: "unexpected error while starting the charge",
    });
    throw new SubscriptionError(
      "We could not confirm whether Paystack received this payment request. Do not pay again. Use Check payment status and MaaCash will reconcile it first.",
      "charge_unresolved"
    );
  }
}

/**
 * Move a definitively failed intent to a fresh reference.
 *
 * The subscription row, its package, amount and audit trail are preserved; only
 * the provider reference changes, because a reference that Paystack has already
 * declined cannot be charged again. The old `ZeliChargeAttempt` row stays as
 * history. The conditional update makes the rotation atomic, so two concurrent
 * retries cannot both rotate.
 */
async function rotateProviderReference(
  subscriptionId: string,
  expectedReference: string
): Promise<string | null> {
  const row = await db.zeliSubscription.findUnique({
    where: { id: subscriptionId },
    select: { tenantId: true, providerReference: true },
  });
  if (!row || row.providerReference !== expectedReference) return null;

  for (let attempt = 0; attempt < 3; attempt += 1) {
    const next = `ZELIM-${row.tenantId.slice(0, 8)}-${randomBytes(8).toString("hex")}`;
    const updated = await db.zeliSubscription
      .updateMany({
        where: {
          id: subscriptionId,
          providerReference: expectedReference,
          status: { in: ["pending", "pending_payment"] },
          paidAt: null,
        },
        data: { providerReference: next, failureReason: null },
      })
      .catch(() => ({ count: 0 }));
    if (updated.count === 1) return next;
    // A concurrent rotation or reference collision: re-read and give up cleanly.
    const current = await db.zeliSubscription.findUnique({
      where: { id: subscriptionId },
      select: { providerReference: true },
    });
    if (!current || current.providerReference !== expectedReference) return null;
  }
  return null;
}

/** Record why an attempt could not proceed, without making the intent unusable. */
async function recordChargeFailure(subscriptionId: string, reason: string): Promise<void> {
  await db.zeliSubscription.updateMany({
    where: { id: subscriptionId, status: { in: ["pending", "pending_payment"] }, paidAt: null },
    data: { failureReason: reason.slice(0, 200) },
  });
}

/**
 * Pay a subscription that was created by controlled provisioning.
 *
 * Provisioning stores the approved plan, term and effective amount on a
 * `pending_payment` row. This function reuses that row (and its unique
 * reference) instead of creating a second checkout, so a business can never
 * end up with two live subscriptions for the same approval.
 */
export async function payProvisionedSubscription(
  ctx: TenantContext,
  subscriptionId: string,
  input:
    | { method: "hosted" }
    | { method: "mobile_money"; phone: string; provider: MobileMoneyProvider }
): Promise<{
  reference: string;
  authorizationUrl?: string;
  status?: string;
  displayText?: string | null;
  message?: string | null;
  requiredAction?: ChargeRequiredAction | null;
}> {
  if (ctx.role !== "admin") {
    throw new SubscriptionError("Only a business administrator can pay for a subscription.", "forbidden");
  }
  if (!paystackReadyForCheckout()) {
    throw new SubscriptionError("Subscription checkout is not available yet.", "provider_not_configured");
  }
  const subscription = await db.zeliSubscription.findFirst({
    where: {
      id: subscriptionId,
      tenantId: ctx.tenantId,
      status: { in: ["pending_payment", "pending"] },
      paidAt: null,
    },
    include: { plan: true },
  });
  if (!subscription) {
    throw new SubscriptionError(
      "This payment request is no longer available. Open Billing to see the current amount.",
      "not_payable"
    );
  }
  const admin = await db.user.findUnique({
    where: { id: ctx.userId },
    select: { email: true },
  });
  const email = admin?.email || subscription.providerCustomerCode || "";
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    throw new SubscriptionError("A billing contact email is required.", "missing_email");
  }
  const tenant = await db.businessTenant.findUnique({
    where: { id: ctx.tenantId },
    select: { code: true },
  });
  await assertLiveChargeEnvironment({
    userId: ctx.userId,
    tenantId: ctx.tenantId,
    tenantCode: tenant?.code ?? null,
  });
  const amount = Number(subscription.amount);

  if (input.method === "hosted") {
    // The only new customer checkout path: Paystack's hosted page owns the
    // method choice, the mobile-money number, OTP/PIN and card/bank transfer.
    return initializeHostedCheckout({
      subscription,
      tenantId: ctx.tenantId,
      email,
      amount,
    });
  }

  const phone = normalizeMobileMoneyPhone(input.phone);
  if (!phone) throw new SubscriptionError("Enter a valid Ghana mobile money number.", "invalid_phone");
  if (String(subscription.currency).toUpperCase() !== "GHS") {
    throw new SubscriptionError("Mobile money is only available for GHS packages.", "invalid_currency");
  }

  return initiateMobileMoneyCharge({
    subscription,
    tenantId: ctx.tenantId,
    email,
    phone,
    provider: input.provider,
  });
}

/* ------------------------------------------------------------------------- *
 * Ghana mobile money (direct charge)
 * ------------------------------------------------------------------------- */

export interface MobileMoneyCheckout {
  reference: string;
  /** Provider status from the charge attempt, e.g. `pay_offline`. Never paid. */
  status: string;
  /** Paystack's instruction text for the customer's phone. */
  displayText: string | null;
  message: string | null;
  /** What the customer must still do. `otp` opens the verification form. */
  requiredAction: ChargeRequiredAction | null;
}

/** Classify a provider charge status into the next customer action. */
function requiredActionForChargeStatus(status: string): ChargeRequiredAction {
  if (status === "send_otp") return "otp";
  if (status === "pay_offline" || status === "pending") return "phone_prompt";
  // `send_birthday`, `send_address`, `send_phone` and anything unknown need the
  // provider's own instruction text; MaaCash never guesses an input form.
  return "offline";
}

/** Reopen an attempt that is already waiting without calling the provider. */
function pendingCheckout(
  reference: string,
  attempt: { reason: string | null; requiredAction: string | null; state: string }
): MobileMoneyCheckout {
  const requiredAction = isChargeRequiredAction(attempt.requiredAction)
    ? attempt.requiredAction
    : null;
  return {
    reference,
    status: requiredAction === "otp" ? "send_otp" : "pay_offline",
    displayText: attempt.reason,
    requiredAction,
    message:
      attempt.reason ||
      (requiredAction === "otp"
        ? "Paystack sent a verification code to your phone. Enter it here to finish the payment."
        : "A mobile money prompt is waiting on your phone. Approve it, then check the payment status."),
  };
}

/** How long a pending charge may stay unexplained before reconciliation closes it. */
const CHARGE_RECONCILE_GRACE_MS = 5 * 60 * 1000;

/**
 * How long an attempt that Paystack explicitly asked the customer to authorise
 * (OTP, phone prompt or secure checkout) is protected from being closed just
 * because a read-only verify calls the unfinished transaction `abandoned`.
 * Without this, the first automatic status check would destroy a live OTP
 * window. After the window the normal failure rules apply again.
 */
const AUTHORISATION_WINDOW_MS = 15 * 60 * 1000;

/**
 * A hosted checkout is a full page the customer may leave open while they
 * fetch a card or approve a bank transfer, so it gets a longer protection
 * window than a code prompt. Paystack keeps reporting an unpaid checkout as
 * `abandoned`; that label alone is not a failure.
 */
const HOSTED_CHECKOUT_WINDOW_MS = 60 * 60 * 1000;

/**
 * Start a Ghana mobile money charge for a package chosen online. The customer
 * authorises on their phone, so nothing here marks the subscription paid:
 * activation only happens through the verified `charge.success` event or a
 * server-side verification.
 */
export async function startZeliMobileMoneyCharge(
  ctx: TenantContext,
  planCode: string,
  input: { phone: string; provider: MobileMoneyProvider }
): Promise<MobileMoneyCheckout> {
  const phone = normalizeMobileMoneyPhone(input.phone);
  if (!phone) {
    throw new SubscriptionError("Enter a valid Ghana mobile money number.", "invalid_phone");
  }
  if (!(input.provider in MOBILE_MONEY_PROVIDERS)) {
    throw new SubscriptionError("Choose MTN, ATMoney/Airtel Money or Telecel.", "invalid_provider");
  }
  const { plan, email, reference, createdId, amount } = await preparePendingSubscription(
    ctx,
    planCode,
    "mobile_money"
  );
  if (String(plan.currency).toUpperCase() !== "GHS") {
    await failPendingCheckout(createdId, "mobile money requires GHS pricing");
    throw new SubscriptionError(
      "Mobile money is only available for GHS packages.",
      "invalid_currency"
    );
  }

  return initiateMobileMoneyCharge({
    subscription: {
      id: createdId,
      providerReference: reference,
      amount,
      currency: plan.currency,
      plan: { code: plan.code },
    },
    tenantId: ctx.tenantId,
    email,
    phone,
    provider: input.provider,
  });
}

export interface PaymentReconciliation {
  status: "pending" | "success" | "failed" | "ignored" | "unresolved";
  message: string;
  state?: string;
}

/**
 * Read-only reconciliation of a payment reference against Paystack.
 *
 * Sends no charge and creates no intent. It settles an uncertain attempt when
 * the provider can answer, activates on a verified success, and only closes a
 * pending attempt as abandoned when Paystack confirms it holds no transaction
 * and the grace window has passed.
 */
async function reconcileReference(reference: string): Promise<PaymentReconciliation> {
  // Reconcile is also the retry pump for internal "payment received" email. A
  // previously undelivered message is attempted again here, without ever
  // delaying or changing the reconciliation result.
  queuePlatformPaymentEmailDelivery();

  const subscription = await db.zeliSubscription.findFirst({
    where: { providerReference: reference },
    select: {
      id: true,
      status: true,
      paidAt: true,
      amount: true,
      currency: true,
      tenantId: true,
    },
  });
  const attempt = await findChargeAttempt(reference);

  if (subscription?.paidAt) {
    if (attempt && attempt.state !== "succeeded") {
      await settleOpenAttempt(attempt.id, { state: "succeeded", reason: "already paid" });
    }
    return { status: "success", message: "Payment already confirmed.", state: "succeeded" };
  }
  if (!subscription) {
    return { status: "ignored", message: "Payment not found." };
  }

  let lookup: { found: boolean; transaction: PaystackTransaction | null };
  try {
    lookup = await lookupTransaction(reference);
  } catch {
    // We could not ask. That is not proof of anything; keep the attempt open.
    if (attempt && isOpenAttempt(attempt.state)) {
      await settleOpenAttempt(attempt.id, {
        state: "unresolved",
        reason: "provider verification unavailable",
      });
    }
    return {
      status: "unresolved",
      message:
        "Paystack could not be reached to confirm this payment. Nothing new was charged. Try Check payment status again shortly.",
      state: "unresolved",
    };
  }

  if (!lookup.found || !lookup.transaction) {
    if (attempt && isOpenAttempt(attempt.state)) {
      const age = Date.now() - attempt.updatedAt.getTime();
      if (age >= CHARGE_RECONCILE_GRACE_MS) {
        await settleOpenAttempt(attempt.id, {
          state: "abandoned",
          reason: "provider has no transaction for this reference",
        });
        return {
          status: "failed",
          message:
            "Paystack has no charge for this reference, so no money moved. You can start a new payment.",
          state: "abandoned",
        };
      }
      return {
        status: "pending",
        message:
          "Paystack has no transaction for this reference yet. If you approved a prompt, wait a moment and check again. Nothing new was charged.",
        state: "unresolved",
      };
    }
    return {
      status: "pending",
      message: "Paystack has no transaction for this reference yet. Nothing was charged.",
      state: attempt?.state,
    };
  }

  const transaction = lookup.transaction;
  const eventId =
    transaction.id != null
      ? `paystack:charge.success:${transaction.id}`
      : `paystack:charge.success:ref:${reference}`;

  if (transaction.status === "success") {
    const result = await fulfilPaidSubscription({
      reference,
      eventId,
      eventType: "charge.success",
      transaction,
    });
    if (attempt) {
      await settleOpenAttempt(attempt.id, {
        state: "succeeded",
        providerHttpStatus: 200,
        reason: "verified by provider",
      });
    }
    if (result.decision === "failed" || result.decision === "exception") {
      return {
        status: "failed",
        message:
          "The payment could not be matched to this package. Contact support before paying again.",
        state: "succeeded",
      };
    }
    return {
      status: "success",
      message: "Payment confirmed. Your subscription is active.",
      state: "succeeded",
    };
  }

  if (
    transaction.status === "failed" ||
    transaction.status === "reversed" ||
    transaction.status === "abandoned"
  ) {
    const authorisationWindow =
      attempt?.requiredAction === "checkout"
        ? HOSTED_CHECKOUT_WINDOW_MS
        : AUTHORISATION_WINDOW_MS;
    const authorising =
      transaction.status === "abandoned" &&
      attempt &&
      attempt.state === "pending" &&
      attempt.requiredAction != null &&
      Date.now() - attempt.updatedAt.getTime() < authorisationWindow;
    if (authorising) {
      // Paystack reports an unfinished charge as `abandoned` while it is still
      // waiting for the customer. Keep the attempt open so the code form and
      // the phone prompt remain usable; nothing is charged by checking.
      return {
        status: "pending",
        message:
          attempt.requiredAction === "otp"
            ? "Paystack is still waiting for the verification code on this payment. Enter the code, or check again shortly. Nothing was charged by this check."
            : attempt.requiredAction === "checkout"
              ? "Paystack has not completed this checkout yet. Reopen the same checkout and finish there, or check again shortly. Nothing was charged by this check."
              : "Paystack has not confirmed this payment yet. Follow the instruction on your phone, then check again. Nothing was charged by this check.",
        state: "pending",
      };
    }
    if (attempt) {
      await settleOpenAttempt(attempt.id, {
        state: "failed",
        providerHttpStatus: 200,
        reason: `provider status ${transaction.status}`,
      });
    }
    await recordChargeFailure(subscription.id, `Paystack reported ${transaction.status}`);
    return {
      status: "failed",
      message: "The payment was not completed. No charge was applied. You can try again.",
      state: "failed",
    };
  }

  if (attempt) {
    await settleOpenAttempt(attempt.id, {
      state: "pending",
      providerHttpStatus: 200,
      reason: "awaiting provider confirmation",
    });
  }
  return {
    status: "pending",
    message:
      "Waiting for the mobile money authorisation. Approve the prompt on your phone, then check again.",
    state: "pending",
  };
}

/**
 * Customer-initiated status check for a mobile money charge.
 *
 * Paystack asks merchants to verify when no webhook arrives within the 180
 * second authorisation window. Activation stays idempotent because the same
 * canonical event id is used as the webhook path.
 */
export async function checkZeliMobileMoneyStatus(
  ctx: TenantContext,
  reference: string
): Promise<{
  status: "pending" | "success" | "failed" | "ignored";
  message: string;
  decision?: string;
}> {
  if (ctx.role !== "admin") {
    throw new SubscriptionError("Only a business administrator can check a payment.", "forbidden");
  }
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(reference)) {
    throw new SubscriptionError("Invalid payment reference.", "invalid_reference");
  }
  const subscription = await db.zeliSubscription.findFirst({
    where: { providerReference: reference, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!subscription) {
    throw new SubscriptionError("Payment not found.", "not_found");
  }
  const result = await reconcileReference(reference);
  return {
    status: result.status === "unresolved" ? "pending" : result.status,
    message: result.message,
    decision: result.state,
  };
}

/**
 * Explicit reconciliation action for an uncertain attempt. Read-only against
 * the provider: it never starts a charge.
 */
export async function reconcileZeliPayment(
  ctx: TenantContext,
  reference: string
): Promise<PaymentReconciliation> {
  if (ctx.role !== "admin") {
    throw new SubscriptionError("Only a business administrator can reconcile a payment.", "forbidden");
  }
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(reference)) {
    throw new SubscriptionError("Invalid payment reference.", "invalid_reference");
  }
  const owned = await db.zeliSubscription.findFirst({
    where: { providerReference: reference, tenantId: ctx.tenantId },
    select: { id: true },
  });
  if (!owned) throw new SubscriptionError("Payment not found.", "not_found");
  return reconcileReference(reference);
}

/** Remove the submitted code from anything that could be shown or logged. */
function scrubOtp(value: string | null | undefined, otp: string): string | null {
  if (!value) return null;
  return sanitizeProviderMessage(value.split(otp).join("[code]"));
}

export interface OtpSubmission {
  status: "success" | "pending" | "requires_action" | "failed";
  message: string;
  /** Provider instruction to show next to the form. Never contains the code. */
  displayText?: string | null;
  requiredAction?: ChargeRequiredAction | null;
}

/**
 * Submit the one-time code Paystack sent to the customer's phone.
 *
 * This never starts a charge and never creates a reference. It only advances an
 * existing attempt that the provider explicitly put into `send_otp`. The code
 * is transient: it is validated, forwarded once and never stored, hashed or
 * logged. Activation still goes through the same verified, exactly-once
 * `fulfilPaidSubscription` path as the webhook and status check.
 */
export async function submitZeliChargeOtp(
  ctx: TenantContext,
  reference: string,
  otp: string
): Promise<OtpSubmission> {
  if (ctx.role !== "admin") {
    throw new SubscriptionError("Only a business administrator can finish a payment.", "forbidden");
  }
  if (!/^[A-Za-z0-9._=-]{6,120}$/.test(reference)) {
    throw new SubscriptionError("Invalid payment reference.", "invalid_reference");
  }
  if (!/^\d{4,10}$/.test(otp)) {
    throw new SubscriptionError(
      "Enter the verification code Paystack sent to your phone.",
      "invalid_otp"
    );
  }

  const subscription = await db.zeliSubscription.findFirst({
    where: { providerReference: reference, tenantId: ctx.tenantId },
    select: { id: true, status: true, paidAt: true, amount: true, currency: true },
  });
  if (!subscription) throw new SubscriptionError("Payment not found.", "not_found");
  if (subscription.paidAt) {
    return { status: "success", message: "Payment already confirmed." };
  }
  if (!["pending", "pending_payment"].includes(subscription.status)) {
    throw new SubscriptionError(
      "This payment is no longer open. Open Billing to see the current amount.",
      "not_payable"
    );
  }

  const attempt = await findChargeAttempt(reference);
  if (
    !attempt ||
    attempt.tenantId !== ctx.tenantId ||
    attempt.subscriptionId !== subscription.id
  ) {
    throw new SubscriptionError("Payment not found.", "not_found");
  }
  if (!(attempt.state === "pending" && attempt.requiredAction === "otp")) {
    throw new SubscriptionError(
      "This payment is not waiting for a verification code. Use Check payment status to see what it needs next.",
      "otp_not_expected"
    );
  }

  let charge;
  try {
    charge = await submitChargeOtp({ reference, otp });
  } catch (error) {
    if (error instanceof PaystackError) {
      const safe = scrubOtp(error.safeMessage ?? error.message, otp);
      if (error.failureKind === "rejected") {
        // The code was refused. The attempt stays open so the customer can
        // retype it; nothing is closed and no second charge is created.
        logSecurityEvent({
          event: "payment.otp_rejected",
          outcome: "blocked",
          actorType: "user",
          tenantId: ctx.tenantId,
          reason: error.providerCode ?? error.code,
          detail: `http:${error.providerStatus ?? 0} ref:${reference.slice(0, 18)}`,
        });
        throw new SubscriptionError(
          safe
            ? `That verification code was not accepted: ${safe}`
            : "That verification code was not accepted. Check the code Paystack sent and try again.",
          "otp_invalid"
        );
      }
      await settleOpenAttempt(attempt.id, {
        state: "unresolved",
        reason: "could not confirm the verification code with Paystack",
      });
      logSecurityEvent({
        event: "payment.otp_unresolved",
        outcome: "failure",
        actorType: "user",
        tenantId: ctx.tenantId,
        reason: error.providerCode ?? error.code,
        detail: `http:${error.providerStatus ?? 0} ref:${reference.slice(0, 18)}`,
      });
      throw new SubscriptionError(
        "We could not confirm the verification code with Paystack. Do not pay again. Use Check payment status so MaaCash can reconcile this payment.",
        "charge_unresolved"
      );
    }
    await settleOpenAttempt(attempt.id, {
      state: "unresolved",
      reason: "unexpected error while submitting the verification code",
    });
    throw new SubscriptionError(
      "We could not confirm the verification code with Paystack. Do not pay again. Use Check payment status so MaaCash can reconcile this payment.",
      "charge_unresolved"
    );
  }

  if (charge.reference !== reference) {
    await settleOpenAttempt(attempt.id, {
      state: "unresolved",
      reason: "provider returned a different reference",
    });
    throw new SubscriptionError(
      "Payment provider returned a different reference. Do not pay again. Use Check payment status.",
      "charge_unresolved"
    );
  }

  if (charge.status === "success") {
    // The code is accepted. Confirm the settlement server-side before any
    // access is granted; a success status alone is not an activation.
    let transaction: PaystackTransaction;
    try {
      transaction = await verifyTransaction(reference);
    } catch {
      await settleOpenAttempt(attempt.id, {
        state: "pending",
        reason: "Paystack accepted the code; confirming the payment.",
      });
      return {
        status: "pending",
        message:
          "Paystack accepted the code and MaaCash is confirming the payment. Do not pay again; use Check payment status in a moment.",
        requiredAction: null,
      };
    }
    if (transaction.status === "success") {
      const eventId =
        transaction.id != null
          ? `paystack:charge.success:${transaction.id}`
          : `paystack:charge.success:ref:${reference}`;
      const result = await fulfilPaidSubscription({
        reference,
        eventId,
        eventType: "charge.success",
        transaction,
      });
      if (result.decision === "failed" || result.decision === "exception") {
        await settleOpenAttempt(attempt.id, {
          state: "unresolved",
          reason: "verified payment could not be applied",
        });
        return {
          status: "pending",
          message:
            "Paystack confirms the payment, but MaaCash could not apply it yet. Do not pay again. Contact support with your payment reference.",
          requiredAction: null,
        };
      }
      await settleOpenAttempt(attempt.id, {
        state: "succeeded",
        providerHttpStatus: 200,
        reason: "verified by provider after verification code",
      });
      return {
        status: "success",
        message:
          result.decision === "processed" || result.decision === "ignored"
            ? "Payment confirmed. Your subscription is active."
            : "Payment confirmed.",
        requiredAction: null,
      };
    }
    await settleOpenAttempt(attempt.id, {
      state: "pending",
      requiredAction: "phone_prompt",
      reason: "waiting for provider confirmation",
    });
    return {
      status: "pending",
      message:
        "Paystack accepted the code but has not confirmed the payment yet. Do not pay again; use Check payment status shortly.",
      requiredAction: "phone_prompt",
    };
  }

  if (charge.status === "failed") {
    await settleOpenAttempt(attempt.id, {
      state: "failed",
      providerHttpStatus: 200,
      reason: "verification code was not accepted by the provider",
    });
    await recordChargeFailure(subscription.id, "The payment authorisation failed");
    return {
      status: "failed",
      message:
        "The payment was not completed and no money was taken. You can start a new payment attempt.",
      requiredAction: null,
    };
  }

  const displayText = scrubOtp(charge.displayText, otp);
  const providerMessage = scrubOtp(charge.message, otp);

  if (charge.status === "send_otp") {
    const reason =
      displayText ||
      providerMessage ||
      "Paystack sent a verification code to your phone. Enter it here to finish the payment.";
    await settleOpenAttempt(attempt.id, {
      state: "pending",
      requiredAction: "otp",
      providerHttpStatus: 200,
      reason,
    });
    return {
      status: "requires_action",
      message: reason,
      displayText: reason,
      requiredAction: "otp",
    };
  }

  if (charge.status === "pay_offline" || charge.status === "pending") {
    const reason =
      displayText || providerMessage || "Approve the payment prompt on your phone, then check the payment status.";
    await settleOpenAttempt(attempt.id, {
      state: "pending",
      requiredAction: "phone_prompt",
      providerHttpStatus: 200,
      reason,
    });
    return {
      status: "pending",
      message: reason,
      displayText: reason,
      requiredAction: "phone_prompt",
    };
  }

  // `send_birthday`, `send_address`, `send_phone` or an unknown state: keep the
  // attempt open and show the provider's own instruction. MaaCash never invents
  // an input form for a state it does not implement.
  const reason =
    displayText ||
    providerMessage ||
    "Paystack needs one more step before this payment can finish. Follow the instruction Paystack sent to your phone, then check the payment status.";
  await settleOpenAttempt(attempt.id, {
    state: "pending",
    requiredAction: "offline",
    providerHttpStatus: 200,
    reason,
  });
  return {
    status: "requires_action",
    message: reason,
    displayText: reason,
    requiredAction: "offline",
  };
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
    include: { plan: true, tenant: { select: { name: true, code: true } } },
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
        include: {
          plan: true,
          tenant: { select: { name: true, code: true } },
        },
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
          graceEndsAt: null,
          reminderStage: null,
          providerCustomerCode:
            input.transaction.customerCode ?? fresh.providerCustomerCode,
        },
      });

      // A verified monthly payment consumes exactly one founding period. The
      // conditional update in consumeFoundingPeriod keeps a duplicate webhook
      // from burning two periods, and the fourth renewal reverts to standard
      // pricing because the allocation becomes exhausted.
      if (fresh.foundingAllocationId && fresh.billingTerm !== "annual") {
        await consumeFoundingPeriod(tx, fresh.foundingAllocationId);
      }

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
      // The in-app platform alert and its email outbox row are written in the
      // same transaction as the activation. A payment can therefore never be
      // activated silently, and a duplicate event cannot create a second one.
      await recordPlatformPaymentNotification(tx, {
        tenantId: fresh.tenantId,
        tenantName: fresh.tenant.name,
        tenantCode: fresh.tenant.code,
        planName: fresh.plan.name,
        billingTerm: fresh.billingTerm === "annual" ? "annual" : "monthly",
        amount: Number(fresh.amount),
        currency: fresh.currency,
        reference: fresh.providerReference,
        paidAt: verifiedPaidAt.toISOString(),
        periodEnd: periodEnd.toISOString(),
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

  // Activation is already durable. Email delivery is best-effort and never
  // awaited here, so neither the webhook nor a status check waits on Resend.
  if (outcome.kind === "processed") {
    queuePlatformPaymentEmailDelivery();
  }

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
  legacySignature: string | null,
  paystackSignatureHeader: string | null = null
): Promise<{ ok: boolean; status: number; decision: string }> {
  const verification = verifyWebhookRequest(rawBody, {
    legacySignature,
    paystackSignature: paystackSignatureHeader,
  });
  if (!verification.ok) {
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

  // Paystack's endpoint ping is a signed reachability check, not a payment.
  // Acknowledge it, record a safe diagnostic row and change nothing else.
  if (eventType === "ping") {
    const pingId = canonicalEventId("ping", data, rawBody);
    const claim = await claimPaymentEvent({
      eventId: pingId,
      eventType: "ping",
      reference: null,
      subscriptionId: null,
      tenantId: null,
    });
    if (claim === "claimed") await finishEvent(pingId, "processed", "signed_ping");
    return { ok: true, status: 200, decision: "ping" };
  }
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

    // A signed webhook proves origin, not settlement. Direct mobile money
    // charges carry the ZELIM prefix, so they require an authoritative
    // server-side verification: the provider's answer decides the status and
    // the amount. Hosted-checkout payments keep the verified-webhook path and
    // are reconciled through the return callback and platform reconciliation.
    const requiresProviderVerification = reference.startsWith("ZELIM-");

    let transaction: PaystackTransaction = {
      status: String(data.status ?? "success"),
      reference,
      amount: Number(data.amount ?? 0),
      currency: String(data.currency ?? ""),
      paidAt: data.paid_at ?? null,
      customerCode: data.customer?.customer_code ?? null,
      metadata: webhookMetadata(data.metadata),
      id: typeof data.id === "number" ? data.id : null,
    };

    if (requiresProviderVerification && paystackConfigured()) {
      try {
        transaction = await verifyTransaction(reference);
      } catch {
        // No activation without provider confirmation; Paystack retries.
        await finishEvent(eventId, "failed", "verification_unavailable");
        return { ok: false, status: 500, decision: "verification_unavailable" };
      }
    }

    const result = await fulfilPaidSubscription({
      reference,
      eventId,
      eventType,
      transaction,
    });
    if (result.decision === "processed" || result.decision === "ignored") {
      // The provider confirmed the payment, so any open ledger row for this
      // reference is settled. A duplicate event changes nothing.
      const attempt = await findChargeAttempt(reference);
      if (attempt && isOpenAttempt(attempt.state)) {
        await settleOpenAttempt(attempt.id, {
          state: "succeeded",
          providerHttpStatus: 200,
          reason: "verified by provider webhook",
        });
      }
    }
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
  const result = await fulfilPaidSubscription({
    reference,
    eventId,
    eventType: "charge.success",
    transaction,
  });
  if (
    result.decision === "processed" ||
    (result.decision === "ignored" &&
      (result.reason === "duplicate_reference" || result.reason === "duplicate_event"))
  ) {
    // The callback and the webhook share this settlement, so whichever arrives
    // second cannot reopen a checkout that Paystack already confirmed.
    const attempt = await findChargeAttempt(reference);
    if (attempt && isOpenAttempt(attempt.state)) {
      await settleOpenAttempt(attempt.id, {
        state: "succeeded",
        providerHttpStatus: 200,
        reason: `verified by provider (${source})`,
      });
    }
  }
  return result;
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

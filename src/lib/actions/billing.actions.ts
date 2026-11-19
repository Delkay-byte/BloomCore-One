"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import { paystackReadyForCheckout } from "@/lib/payments/paystack";
import {
  checkZeliMobileMoneyStatus,
  reconcileZeliPayment,
  createZeliCheckout,
  payProvisionedSubscription,
  startZeliMobileMoneyCharge,
  SubscriptionError,
} from "@/lib/payments/zeli-subscriptions";
import { effectiveMonthlyPrice, foundingRemaining } from "@/lib/pricing/founding";
import { zeliUsageSummary } from "@/lib/zeli/usage";
import type { MobileMoneyProvider } from "@/lib/payments/paystack";
import {
  findChargeAttempt,
  isChargeRequiredAction,
  isOpenAttempt,
} from "@/lib/payments/charge-attempts";
import {
  currentRequestOrigin,
  customerPaymentMessage,
  liveCheckoutReadiness,
} from "@/lib/payments/live-readiness";
import {
  isHostedCheckoutChannel,
  isTrustedCheckoutUrl,
  type HostedCheckoutChannel,
} from "@/lib/payments/checkout-url";
import { supportedCheckoutChannels } from "@/lib/payments/checkout-channels";

/**
 * Business owner subscription and billing.
 *
 * Only a tenant administrator can read or change billing. Amounts come from
 * the catalogue and the stored subscription, never from the browser. A payment
 * is only ever an instruction to the provider: activation happens through the
 * verified webhook or the server-side reconciliation.
 */

export interface BillingHistoryRow {
  id: string;
  reference: string;
  planName: string;
  status: string;
  amount: number;
  currency: string;
  billingTerm: string;
  periodStart: string | null;
  periodEnd: string | null;
  paidAt: string | null;
  createdAt: string;
  foundingApplied: boolean;
  refundStatus: string | null;
}

export interface BillingOverview {
  tenantName: string;
  plan: {
    code: string;
    name: string;
    billingInterval: string;
    price: number;
    locationLimit: number | null;
    staffLimit: number | null;
    usageAllowance: number | null;
    supportLevel: string | null;
  } | null;
  status: string;
  lifecycle: "pending_payment" | "active" | "grace_period" | "suspended" | "ended";
  billingTerm: string;
  periodStart: string | null;
  periodEnd: string | null;
  graceEndsAt: string | null;
  nextAmount: number | null;
  standardAmount: number | null;
  amountDueNow: number | null;
  payableSubscriptionId: string | null;
  founding: {
    active: boolean;
    remainingPeriods: number;
    periodsUsed: number;
    periodsGranted: number;
    monthlyPrice: number | null;
    standardPrice: number | null;
    status: string;
  } | null;
  entitlements: { locations: number; staff: number };
  zeli: Awaited<ReturnType<typeof zeliUsageSummary>>;
  history: BillingHistoryRow[];
  /**
   * Server-side answer to "can this workspace start a checkout now?". The
   * detailed readiness reason stays on the server; the browser receives only
   * this boolean so key mode and local test configuration are never exposed.
   */
  paymentsAvailable: boolean;
  /** Reference of the pending payment the owner is about to authorise. */
  payableReference: string | null;
  /**
   * What the open attempt still needs from the owner. `otp` reopens the
   * verification form after a reload; it never contains the code itself.
   */
  payableAction: {
    reference: string;
    requiredAction: "otp" | "phone_prompt" | "offline" | "checkout";
    displayText: string | null;
    /** Trusted Paystack URL for reopening an open hosted checkout. */
    checkoutUrl: string | null;
    /** Method bound when the open checkout was initialised, when known. */
    channel: HostedCheckoutChannel | null;
  } | null;
  /** Methods this account and currency may request from Paystack. */
  checkoutChannels: HostedCheckoutChannel[];
  availablePlans: {
    code: string;
    name: string;
    billingInterval: string;
    price: number;
    foundingPrice: number | null;
    locationLimit: number | null;
    staffLimit: number | null;
    usageAllowance: number | null;
    supportLevel: string | null;
  }[];
  /** True only while a founding allocation still has discounted periods left. */
  foundingEligible: boolean;
  /** Current subscription id, for scheduling a package change. */
  subscriptionId: string | null;
  scheduled: {
    planCode: string;
    planName: string;
    billingTerm: string;
    price: number;
    at: string;
  } | null;
}

export async function getBillingOverview(): Promise<BillingOverview> {
  const ctx = await requireTenantAdmin();
  const [subscriptions, founding, locations, staff, zeli, plans] = await Promise.all([
    db.zeliSubscription.findMany({
      where: { tenantId: ctx.tenantId },
      orderBy: { createdAt: "desc" },
      take: 25,
      include: { plan: true },
    }),
    db.foundingAllocation.findUnique({ where: { tenantId: ctx.tenantId }, include: { plan: true } }),
    db.location.count({ where: { tenantId: ctx.tenantId } }),
    db.user.count({ where: { tenantId: ctx.tenantId, role: "worker", status: "active" } }),
    zeliUsageSummary(ctx.tenantId),
    db.zeliPlan.findMany({
      where: { status: "active" },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        code: true,
        name: true,
        billingInterval: true,
        price: true,
        foundingPrice: true,
        locationLimit: true,
        staffLimit: true,
        usageAllowance: true,
        supportLevel: true,
      },
    }),
  ]);

  const current =
    subscriptions.find((row) => ["active", "grace_period", "suspended", "pending_payment", "pending"].includes(row.status)) ??
    null;
  const plan = current?.plan ?? null;
  const now = new Date();
  const lifecycle: BillingOverview["lifecycle"] = !current
    ? "ended"
    : current.status === "pending_payment" || current.status === "pending"
      ? "pending_payment"
      : current.status === "suspended"
        ? "suspended"
        : current.status === "grace_period"
          ? "grace_period"
          : current.periodEnd && current.periodEnd.getTime() <= now.getTime()
            ? "grace_period"
            : "active";

  let nextAmount: number | null = null;
  if (plan) {
    if (plan.billingInterval === "month") {
      const effective = await effectiveMonthlyPrice({
        tenantId: ctx.tenantId,
        plan: {
          id: plan.id,
          code: plan.code,
          billingInterval: plan.billingInterval,
          price: plan.price,
          foundingPrice: plan.foundingPrice,
        },
      });
      nextAmount = Number(effective.amount);
    } else {
      nextAmount = Number(plan.price);
    }
  }

  const payable = current && ["pending_payment", "pending"].includes(current.status) ? current : null;
  const scheduledPlan = current?.scheduledPlanCode
    ? plans.find((row) => row.code === current.scheduledPlanCode)
    : undefined;

  // Readiness is decided for this tenant, on this request's origin, with the
  // same guard the charge path uses. It never trusts a browser-supplied value.
  const readiness = liveCheckoutReadiness({
    tenantId: ctx.tenantId,
    tenantCode: ctx.tenantCode ?? null,
    origin: (await currentRequestOrigin()) ?? process.env.SITE_URL ?? null,
  });

  // The open attempt is the only source of truth for what the owner must do
  // next. Older attempts were written before `requiredAction` existed, so a
  // missing value is reported as "no action" rather than guessed.
  const payableAttempt = payable?.providerReference
    ? await findChargeAttempt(payable.providerReference)
    : null;
  const payableAction =
    payableAttempt &&
    payableAttempt.state === "pending" &&
    isChargeRequiredAction(payableAttempt.requiredAction)
      ? {
          reference: payableAttempt.reference,
          requiredAction: payableAttempt.requiredAction,
          displayText: payableAttempt.reason,
          checkoutUrl:
            payableAttempt.requiredAction === "checkout" &&
            payableAttempt.checkoutUrl &&
            isTrustedCheckoutUrl(payableAttempt.checkoutUrl)
              ? payableAttempt.checkoutUrl
              : null,
          channel: isHostedCheckoutChannel(payableAttempt.checkoutChannel)
            ? payableAttempt.checkoutChannel
            : null,
        }
      : null;

  return {
    tenantName: ctx.tenantName,
    plan: plan
      ? {
          code: plan.code,
          name: plan.name,
          billingInterval: plan.billingInterval,
          price: Number(plan.price),
          locationLimit: plan.locationLimit,
          staffLimit: plan.staffLimit,
          usageAllowance: plan.usageAllowance,
          supportLevel: plan.supportLevel,
        }
      : null,
    status: current?.status ?? "none",
    lifecycle,
    billingTerm: current?.billingTerm === "annual" ? "annual" : "monthly",
    periodStart: current?.periodStart?.toISOString() ?? null,
    periodEnd: current?.periodEnd?.toISOString() ?? null,
    graceEndsAt: current?.graceEndsAt?.toISOString() ?? null,
    nextAmount,
    standardAmount: current?.standardAmount != null ? Number(current.standardAmount) : plan ? Number(plan.price) : null,
    amountDueNow: payable ? Number(payable.amount) : null,
    payableSubscriptionId: payable?.id ?? null,
    founding: founding
      ? {
          active: founding.status === "active",
          remainingPeriods: foundingRemaining(founding),
          periodsUsed: founding.periodsUsed,
          periodsGranted: founding.periodsGranted,
          monthlyPrice: Number(founding.monthlyPrice),
          standardPrice: Number(founding.standardPrice),
          status: founding.status,
        }
      : null,
    entitlements: { locations, staff },
    zeli,
    // A configured test key may still exercise checkout locally, but a live
    // key must pass the same readiness decision as the charge path. No key
    // mode, guard reason or allowlist detail is serialized to the browser.
    paymentsAvailable:
      paystackReadyForCheckout() &&
      (readiness.enabled || readiness.keyMode === "test"),
    payableReference: payable?.providerReference ?? null,
    payableAction,
    checkoutChannels: supportedCheckoutChannels(
      String(payable?.currency ?? current?.currency ?? plan?.currency ?? "GHS")
    ),
    availablePlans: plans.map((row) => ({
      ...row,
      price: Number(row.price),
      foundingPrice: row.foundingPrice == null ? null : Number(row.foundingPrice),
    })),
    foundingEligible: Boolean(
      founding && founding.status === "active" && foundingRemaining(founding) > 0
    ),
    subscriptionId: current?.id ?? null,
    scheduled:
      scheduledPlan && current?.scheduledBillingTerm
        ? {
            planCode: scheduledPlan.code,
            planName: scheduledPlan.name,
            billingTerm: current.scheduledBillingTerm,
            price: Number(scheduledPlan.price),
            at: (current.scheduledAt ?? current.createdAt).toISOString(),
          }
        : null,
    history: subscriptions.map((row) => ({
      id: row.id,
      reference: row.providerReference,
      planName: row.plan.name,
      status: row.status,
      amount: Number(row.amount),
      currency: row.currency,
      billingTerm: row.billingTerm,
      periodStart: row.periodStart?.toISOString() ?? null,
      periodEnd: row.periodEnd?.toISOString() ?? null,
      paidAt: row.paidAt?.toISOString() ?? null,
      createdAt: row.createdAt.toISOString(),
      foundingApplied: row.foundingAllocationId != null,
      refundStatus: row.refundStatus,
    })),
  };
}

export type BillingPaymentResult =
  | { ok: true; reference: string; authorizationUrl?: string; status?: string; displayText?: string | null; message?: string | null; channel?: string | null }
  | {
      ok: false;
      error: string;
      /** `unresolved` means do not retry: reconcile first. */
      state?: "rejected" | "unresolved" | "closed";
    };

export async function startBillingPaymentAction(input:
  | { subscriptionId: string; method: "hosted"; channel?: HostedCheckoutChannel }
  | { subscriptionId: string; method: "mobile_money"; phone: string; provider: MobileMoneyProvider }
  | { planCode: string; method: "hosted"; channel?: HostedCheckoutChannel }
  | { planCode: string; method: "mobile_money"; phone: string; provider: MobileMoneyProvider }
): Promise<BillingPaymentResult> {
  const ctx = await requireTenantAdmin();
  try {
    if ("subscriptionId" in input) {
      const result = await payProvisionedSubscription(ctx, input.subscriptionId, input as never);
      revalidatePath("/admin/billing");
      return { ok: true, ...result };
    }
    if (input.method === "hosted") {
      const result = await createZeliCheckout(ctx, input.planCode, input.channel);
      revalidatePath("/admin/billing");
      return { ok: true, ...result };
    }
    const result = await startZeliMobileMoneyCharge(ctx, input.planCode, {
      phone: input.phone,
      provider: input.provider,
    });
    revalidatePath("/admin/billing");
    return { ok: true, ...result };
  } catch (error) {
    if (error instanceof SubscriptionError) {
      const state =
        error.code === "charge_unresolved"
          ? ("unresolved" as const)
          : error.code === "charge_rejected"
            ? ("rejected" as const)
            : error.code === "attempt_closed" || error.code === "already_active"
              ? ("closed" as const)
              : undefined;
      return { ok: false, error: customerPaymentMessage(error), state };
    }
    return { ok: false, error: "The payment could not be started. No money was taken." };
  }
}

/**
 * Reconcile an uncertain payment against Paystack without starting a charge.
 * Safe to call repeatedly.
 */
export async function reconcileBillingPaymentAction(reference: string): Promise<{
  status: "pending" | "success" | "failed" | "ignored" | "unresolved";
  message: string;
}> {
  const ctx = await requireTenantAdmin();
  try {
    const result = await reconcileZeliPayment(ctx, reference);
    if (result.status === "success") revalidatePath("/admin/billing");
    return { status: result.status, message: result.message };
  } catch {
    return {
      status: "unresolved",
      message: "We could not reconcile this payment yet. Nothing new was charged.",
    };
  }
}

export async function checkBillingPaymentAction(reference: string): Promise<{
  status: "pending" | "success" | "failed" | "ignored";
  message: string;
  requiredAction?: "otp" | "phone_prompt" | "offline" | "checkout" | null;
  displayText?: string | null;
}> {
  const ctx = await requireTenantAdmin();
  try {
    const result = await checkZeliMobileMoneyStatus(ctx, reference);
    if (result.status === "success") revalidatePath("/admin/billing");
    // A status check can reveal that the provider is now waiting for a code
    // (for example after a page reload). Hand the UI the action, never a code.
    const attempt = await findChargeAttempt(reference);
    const requiredAction =
      attempt &&
      attempt.state === "pending" &&
      isChargeRequiredAction(attempt.requiredAction)
        ? attempt.requiredAction
        : null;
    return {
      status: result.status,
      message: result.message,
      requiredAction,
      displayText: requiredAction ? attempt?.reason ?? null : null,
    };
  } catch (error) {
    if (error instanceof SubscriptionError) {
      return { status: "pending", message: error.message };
    }
    return { status: "pending", message: "We could not check the payment yet. Please try again." };
  }
}

/* ------------------------------------------------------------------------- *
 * Package selection and package changes
 * ------------------------------------------------------------------------- */

export interface PlanChangeResult {
  ok: boolean;
  error?: string;
  /** Set when the persisted usage does not fit the target package. */
  conflict?: {
    planName: string;
    locations: number;
    locationLimit: number | null;
    staff: number;
    staffLimit: number | null;
  };
  scheduled?: { planName: string; price: number; billingTerm: string };
  /** Pending subscription created or replaced by the selection. */
  subscriptionId?: string;
  amount?: number;
  /** Existing provider reference of the payable intent. */
  reference?: string;
  /** True when an existing payable intent was returned unchanged. */
  reused?: boolean;
  /** True when a package change needs an explicit confirmation first. */
  needsConfirmation?: boolean;
  existing?: {
    planName: string;
    billingTerm: string;
    amount: number;
    reference: string;
  };
}

async function loadPublicPlan(planCode: string) {
  const plan = await db.zeliPlan.findUnique({ where: { code: planCode } });
  if (!plan || plan.status !== "active" || !plan.isPublic) {
    throw new SubscriptionError("This package is not available.", "plan_unavailable");
  }
  return plan;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/**
 * Select a package for a business that has not paid yet.
 *
 * The reference shown to the owner is treated as part of the payment intent:
 *
 *   * Selecting the package that is already pending returns the existing row,
 *     reference and amount untouched. Refreshing, reopening checkout or
 *     pressing Continue to payment can therefore never invalidate a reference.
 *   * Selecting a different package never expires an intent silently. The
 *     caller must pass `confirmReplace`, and a replacement is refused while a
 *     provider charge for the current intent is pending, successful, failed or
 *     of unknown outcome.
 *   * Creation is idempotent under concurrency: the unique pending key decides
 *     the winner, and the loser returns the winner's intent.
 */
export async function selectPackageAction(input: {
  planCode: string;
  confirmReplace?: boolean;
}): Promise<PlanChangeResult> {
  const ctx = await requireTenantAdmin();
  try {
    const plan = await loadPublicPlan(input.planCode);
    const billingTerm = plan.billingInterval === "year" ? "annual" : "monthly";

    const pending = await db.zeliSubscription.findMany({
      where: {
        tenantId: ctx.tenantId,
        status: { in: ["pending", "pending_payment"] },
        paidAt: null,
      },
      include: { plan: true },
      orderBy: { createdAt: "desc" },
    });

    const same = pending.find(
      (row) => row.planId === plan.id && row.billingTerm === billingTerm
    );
    if (same) {
      return {
        ok: true,
        subscriptionId: same.id,
        amount: Number(same.amount),
        reference: same.providerReference,
        reused: true,
      };
    }

    if (pending.length > 0) {
      const attempts = await db.zeliChargeAttempt.findMany({
        where: { reference: { in: pending.map((row) => row.providerReference) } },
        select: { reference: true, state: true },
      });
      // Only an attempt whose charge could still exist blocks replacement. A
      // definitively failed attempt is retried on a fresh reference instead.
      const blocked = attempts.find((attempt) => isOpenAttempt(attempt.state));
      if (blocked) {
        return {
          ok: false,
          error:
            "A payment attempt for the current package still has to be confirmed. Check the payment status before changing packages.",
        };
      }
      if (!input.confirmReplace) {
        const current = pending[0];
        return {
          ok: false,
          needsConfirmation: true,
          existing: {
            planName: current.plan.name,
            billingTerm: current.billingTerm,
            amount: Number(current.amount),
            reference: current.providerReference,
          },
        };
      }
    }

    const effective = await effectiveMonthlyPrice({
      tenantId: ctx.tenantId,
      plan: {
        id: plan.id,
        code: plan.code,
        billingInterval: plan.billingInterval,
        price: plan.price,
        foundingPrice: plan.foundingPrice,
      },
    });
    const amount = Number(effective.amount);
    const standardAmount = Number(plan.price);
    const reference = `ZELI-${ctx.tenantId.slice(0, 8)}-${randomBytes(8).toString("hex")}`;

    try {
      const createdId = await db.$transaction(async (tx) => {
        if (pending.length > 0) {
          await tx.zeliSubscription.updateMany({
            where: { id: { in: pending.map((row) => row.id) } },
            data: {
              status: "expired",
              pendingKey: null,
              failureReason: "Replaced by the owner before payment",
            },
          });
        }
        const created = await tx.zeliSubscription.create({
          data: {
            tenantId: ctx.tenantId,
            planId: plan.id,
            status: "pending_payment",
            provider: "paystack",
            providerReference: reference,
            amount,
            currency: plan.currency,
            billingTerm,
            foundingAllocationId: effective.allocationId,
            standardAmount,
            periodStart: null,
            periodEnd: null,
            pendingKey: `${ctx.tenantId}:${plan.id}`,
          },
          select: { id: true },
        });
        return created.id;
      });
      revalidatePath("/admin/billing");
      return { ok: true, subscriptionId: createdId, amount, reference, reused: false };
    } catch (error) {
      if (isUniqueViolation(error)) {
        // A concurrent selection created the intent first. Return that one
        // rather than creating a second payable reference.
        const winner = await db.zeliSubscription.findFirst({
          where: {
            tenantId: ctx.tenantId,
            planId: plan.id,
            billingTerm,
            status: { in: ["pending", "pending_payment"] },
            paidAt: null,
          },
          orderBy: { createdAt: "desc" },
        });
        if (winner) {
          return {
            ok: true,
            subscriptionId: winner.id,
            amount: Number(winner.amount),
            reference: winner.providerReference,
            reused: true,
          };
        }
        return {
          ok: false,
          error: "A checkout for this package is already being created. Try again in a moment.",
        };
      }
      throw error;
    }
  } catch (error) {
    if (error instanceof SubscriptionError) return { ok: false, error: error.message };
    return { ok: false, error: "The package could not be selected. Please try again." };
  }
}

export async function schedulePlanChangeAction(input: { planCode: string }): Promise<PlanChangeResult> {
  const ctx = await requireTenantAdmin();
  try {
    const plan = await loadPublicPlan(input.planCode);
    const subscription = await db.zeliSubscription.findFirst({
      where: { tenantId: ctx.tenantId, status: { in: ["active", "grace_period"] } },
      orderBy: { createdAt: "desc" },
    });
    if (!subscription) {
      return { ok: false, error: "There is no active subscription to change." };
    }
    const [locations, staff] = await Promise.all([
      db.location.count({ where: { tenantId: ctx.tenantId, status: "active" } }),
      db.user.count({ where: { tenantId: ctx.tenantId, role: "worker", status: "active" } }),
    ]);
    const exceedsLocations = plan.locationLimit !== null && locations > plan.locationLimit;
    const exceedsStaff = plan.staffLimit !== null && staff > plan.staffLimit;
    if (exceedsLocations || exceedsStaff) {
      return {
        ok: false,
        error:
          `This business already has ${locations} active location${locations === 1 ? "" : "s"} and ` +
          `${staff} active staff account${staff === 1 ? "" : "s"}. ` +
          `${plan.name} allows ${plan.locationLimit ?? "unlimited"} location${plan.locationLimit === 1 ? "" : "s"} and ` +
          `${plan.staffLimit ?? "unlimited"} staff. Nothing was deleted or disabled. ` +
          `Choose a package that fits, or reduce usage before scheduling the change.`,
        conflict: {
          planName: plan.name,
          locations,
          locationLimit: plan.locationLimit,
          staff,
          staffLimit: plan.staffLimit,
        },
      };
    }
    const billingTerm = plan.billingInterval === "year" ? "annual" : "monthly";
    await db.zeliSubscription.update({
      where: { id: subscription.id },
      data: {
        scheduledPlanCode: plan.code,
        scheduledBillingTerm: billingTerm,
        scheduledAt: new Date(),
      },
    });
    revalidatePath("/admin/billing");
    return {
      ok: true,
      scheduled: { planName: plan.name, price: Number(plan.price), billingTerm },
    };
  } catch (error) {
    if (error instanceof SubscriptionError) return { ok: false, error: error.message };
    return { ok: false, error: "The package change could not be scheduled." };
  }
}

export async function cancelScheduledPlanChangeAction(): Promise<{ ok: boolean; error?: string }> {
  const ctx = await requireTenantAdmin();
  const subscription = await db.zeliSubscription.findFirst({
    where: { tenantId: ctx.tenantId, scheduledPlanCode: { not: null } },
    orderBy: { createdAt: "desc" },
  });
  if (!subscription) return { ok: true };
  await db.zeliSubscription.update({
    where: { id: subscription.id },
    data: { scheduledPlanCode: null, scheduledBillingTerm: null, scheduledAt: null },
  });
  revalidatePath("/admin/billing");
  return { ok: true };
}

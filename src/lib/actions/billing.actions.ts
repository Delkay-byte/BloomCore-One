"use server";

import { revalidatePath } from "next/cache";
import { randomBytes } from "node:crypto";
import { db } from "@/lib/db";
import { requireTenantAdmin } from "@/lib/tenant";
import {
  checkZeliMobileMoneyStatus,
  createZeliCheckout,
  payProvisionedSubscription,
  startZeliMobileMoneyCharge,
  SubscriptionError,
} from "@/lib/payments/zeli-subscriptions";
import { effectiveMonthlyPrice, foundingRemaining } from "@/lib/pricing/founding";
import { zeliUsageSummary } from "@/lib/zeli/usage";
import type { MobileMoneyProvider } from "@/lib/payments/paystack";

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
  providerReady: boolean;
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
    providerReady: process.env.PAYSTACK_MODE === "live" || process.env.PAYSTACK_ENABLED === "true",
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
  | { ok: true; reference: string; authorizationUrl?: string; status?: string; displayText?: string | null; message?: string | null }
  | { ok: false; error: string };

export async function startBillingPaymentAction(input:
  | { subscriptionId: string; method: "hosted" }
  | { subscriptionId: string; method: "mobile_money"; phone: string; provider: MobileMoneyProvider }
  | { planCode: string; method: "hosted" }
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
      const result = await createZeliCheckout(ctx, input.planCode);
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
    if (error instanceof SubscriptionError) return { ok: false, error: error.message };
    return { ok: false, error: "The payment could not be started. No money was taken." };
  }
}

export async function checkBillingPaymentAction(reference: string): Promise<{
  status: "pending" | "success" | "failed" | "ignored";
  message: string;
}> {
  const ctx = await requireTenantAdmin();
  try {
    const result = await checkZeliMobileMoneyStatus(ctx, reference);
    if (result.status === "success") revalidatePath("/admin/billing");
    return { status: result.status, message: result.message };
  } catch {
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
}

async function loadPublicPlan(planCode: string) {
  const plan = await db.zeliPlan.findUnique({ where: { code: planCode } });
  if (!plan || plan.status !== "active" || !plan.isPublic) {
    throw new SubscriptionError("This package is not available.", "plan_unavailable");
  }
  return plan;
}

/**
 * Select or change the package of an unpaid subscription.
 *
 * Obsolete pending intents are expired first so a previously selected package
 * can never be charged after the owner has changed their mind. A new pending
 * row is created with a new reference; nothing is charged here.
 */
export async function selectPackageAction(input: { planCode: string }): Promise<PlanChangeResult> {
  const ctx = await requireTenantAdmin();
  try {
    const plan = await loadPublicPlan(input.planCode);
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
    const billingTerm = plan.billingInterval === "year" ? "annual" : "monthly";
    const reference = `ZELI-${ctx.tenantId.slice(0, 8)}-${randomBytes(8).toString("hex")}`;

    const createdId = await db.$transaction(async (tx) => {
      const previous = await tx.zeliSubscription.findMany({
        where: { tenantId: ctx.tenantId, status: { in: ["pending", "pending_payment"] } },
        select: { id: true, status: true },
      });
      const wasProvisioned = previous.some((row) => row.status === "pending_payment");
      await tx.zeliSubscription.updateMany({
        where: { id: { in: previous.map((row) => row.id) } },
        data: {
          status: "expired",
          pendingKey: null,
          failureReason: "Package changed before payment",
        },
      });
      const created = await tx.zeliSubscription.create({
        data: {
          tenantId: ctx.tenantId,
          planId: plan.id,
          status: wasProvisioned || previous.length === 0 ? "pending_payment" : "pending",
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
    return { ok: true, subscriptionId: createdId, amount };
  } catch (error) {
    if (error instanceof SubscriptionError) return { ok: false, error: error.message };
    return { ok: false, error: "The package could not be selected. Please try again." };
  }
}

/**
 * Schedule a package change for an already-active subscription.
 *
 * The paid period is never repriced or prorated. The persisted usage is checked
 * against the target package first, and a conflict is reported with the numbers
 * instead of silently disabling or deleting locations or staff.
 */
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

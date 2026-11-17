"use server";

import { revalidatePath } from "next/cache";
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
    locationLimit: number | null;
    staffLimit: number | null;
    usageAllowance: number | null;
  }[];
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
    db.user.count({ where: { tenantId: ctx.tenantId, status: "active" } }),
    zeliUsageSummary(ctx.tenantId),
    db.zeliPlan.findMany({
      where: { status: "active" },
      orderBy: [{ sortOrder: "asc" }, { code: "asc" }],
      select: {
        code: true,
        name: true,
        billingInterval: true,
        price: true,
        locationLimit: true,
        staffLimit: true,
        usageAllowance: true,
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
    availablePlans: plans.map((row) => ({ ...row, price: Number(row.price) })),
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

/**
 * Fixtures for the paid AI Investigation package.
 *
 * A package is only usable when a *verified* payment exists and a Super Admin has
 * activated it, so every test that needs the feature has to build both. Keeping the
 * construction in one place makes it hard to accidentally assert access from a
 * half-built state.
 */

import { prisma } from "./setup";
import { AI_INVESTIGATION_ADDON } from "@/lib/zeli/investigation/entitlement";

let counter = 0;

export interface PaidPackageOptions {
  price?: number;
  allowance?: number | null;
  planStatus?: "draft" | "active";
  subscriptionStatus?: string;
  paid?: boolean;
  periodEnd?: Date;
  amount?: number;
}

/** Create (or reuse) the AI Investigation package in the catalogue. */
export async function configureAiPackage(options: PaidPackageOptions = {}) {
  const price = options.price ?? 150;
  return prisma.zeliPlan.upsert({
    where: { code: "ai-investigation" },
    create: {
      code: "ai-investigation",
      name: "AI Investigation",
      description: "Dedicated AI investigation package.",
      billingInterval: "month",
      price,
      currency: "GHS",
      usageAllowance: options.allowance === undefined ? 25 : options.allowance,
      addonKey: AI_INVESTIGATION_ADDON,
      zeliIncluded: false,
      status: options.planStatus ?? "active",
      isPublic: false,
    },
    update: {
      price,
      usageAllowance: options.allowance === undefined ? 25 : options.allowance,
      addonKey: AI_INVESTIGATION_ADDON,
      status: options.planStatus ?? "active",
    },
  });
}

/**
 * Create a package subscription.
 *
 * `paid: true` writes `paidAt`, which is what the real fulfilment path writes only
 * after the provider amount, currency and reference matched. A test that sets it is
 * asserting "the provider confirmed this", never inventing a payment.
 */
export async function createAiSubscription(
  tenantId: string,
  options: PaidPackageOptions = {}
) {
  counter += 1;
  const plan = await configureAiPackage(options);
  const now = new Date();
  return prisma.zeliSubscription.create({
    data: {
      tenantId,
      planId: plan.id,
      status: options.subscriptionStatus ?? "active",
      provider: "paystack",
      providerReference: `AI-TEST-${Date.now()}-${counter}`,
      amount: options.amount ?? plan.price,
      currency: "GHS",
      paidAt: options.paid === false ? null : now,
      periodStart: now,
      periodEnd:
        options.periodEnd ??
        new Date(now.getTime() + 30 * 86_400_000),
      billingTerm: "monthly",
    },
  });
}

/** Write the Super Admin activation row directly, for feature tests. */
export async function activateAiPackage(
  tenantId: string,
  options: { status?: "active" | "revoked"; expiresAt?: Date; subscriptionId?: string } = {}
) {
  const subscription =
    options.subscriptionId ??
    (await prisma.zeliSubscription.findFirstOrThrow({
      where: { tenantId, paidAt: { not: null }, plan: { addonKey: AI_INVESTIGATION_ADDON } },
      orderBy: { paidAt: "desc" },
    })).id;
  const row = await prisma.zeliSubscription.findUniqueOrThrow({ where: { id: subscription } });
  return prisma.aiInvestigationEntitlement.upsert({
    where: { tenantId },
    create: {
      tenantId,
      status: options.status ?? "active",
      subscriptionId: row.id,
      planId: row.planId,
      planCode: "ai-investigation",
      activatedById: "fixture-platform-admin",
      activatedByEmail: "operator@bloomcore.test",
      activatedAt: new Date(),
      expiresAt: options.expiresAt ?? row.periodEnd ?? new Date(Date.now() + 30 * 86_400_000),
      reason: "Test fixture: verified paid package activated by a platform operator.",
    },
    update: {
      status: options.status ?? "active",
      subscriptionId: row.id,
      planId: row.planId,
      expiresAt: options.expiresAt ?? row.periodEnd ?? new Date(Date.now() + 30 * 86_400_000),
      revokedAt: options.status === "revoked" ? new Date() : null,
      revokeReason: options.status === "revoked" ? "Test fixture revoke." : null,
    },
  });
}

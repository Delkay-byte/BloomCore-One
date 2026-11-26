"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  AI_INVESTIGATION_ADDON,
  AI_INVESTIGATION_CODE_APPROVED,
  AI_INVESTIGATION_DEFAULT_MONTHLY_LIMIT,
} from "@/lib/zeli/investigation/entitlement";
import { ADDON_PAYMENT_ACTOR_ID } from "@/lib/payments/zeli-subscriptions";

/**
 * Platform control of the AI Investigation package.
 *
 * The owner approved external processing of real financial evidence, but only for a
 * business that has genuinely paid for the dedicated package *and* has been activated
 * by a Super Admin. This module is the only writer of that activation.
 *
 * Controls, in order:
 *   - a platform session (never a tenant session);
 *   - a rate limit on administrative changes;
 *   - a mandatory reason;
 *   - a paid, provider-verified, current subscription for an `ai_investigation` plan;
 *   - an immutable platform audit row for every activation, revocation and change.
 *
 * A tenant administrator cannot reach any of these functions: they require a
 * platform session, which a tenant session cannot produce.
 */

export interface AiInvestigationAdminResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
}

export interface EligibleBusinessRow {
  tenantId: string;
  tenantCode: string;
  tenantName: string;
  tenantStatus: string;
  planCode: string | null;
  planName: string | null;
  planPrice: number | null;
  planCurrency: string | null;
  billingInterval: string | null;
  allowance: number | null;
  subscriptionStatus: string | null;
  paidAt: string | null;
  periodEnd: string | null;
  paymentConfirmed: boolean;
  paymentCurrent: boolean;
  activationStatus: "active" | "revoked" | "none";
  activatedAt: string | null;
  activatedByEmail: string | null;
  expiresAt: string | null;
  revokeReason: string | null;
  usedThisMonth: number;
  /** What the platform still has to do, in words. */
  nextStep: string;
}

export interface AiInvestigationAdminState {
  codeApproved: boolean;
  addonKey: string;
  packages: Array<{
    id: string;
    code: string;
    name: string;
    price: number;
    currency: string;
    billingInterval: string;
    allowance: number | null;
    status: string;
  }>;
  businesses: EligibleBusinessRow[];
}

function money(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? Math.round(parsed * 100) / 100 : null;
}

function period(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

async function requirePlatformRead() {
  const session = await getPlatformAdminOrNull();
  if (!session) throw new Error("Not authenticated");
  if (session.forcePasswordReset) throw new Error("Password change required");
  return session;
}

async function requirePlatformWrite() {
  const session = await requirePlatformRead();
  const rate = await consumeRateLimit(
    "platform.ai_investigation",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) throw new Error("Too many changes. Try again later.");
  return session;
}

/**
 * The eligibility board: which businesses have an AI Investigation package, whether
 * the payment is genuinely confirmed, and what the platform still has to do.
 */
export async function getAiInvestigationAdminState(): Promise<
  AiInvestigationAdminResponse<AiInvestigationAdminState>
> {
  try {
    await requirePlatformRead();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Not authenticated" };
  }

  const now = new Date();
  const [packages, subscriptions, activations, usages] = await Promise.all([
    db.zeliPlan.findMany({
      where: { addonKey: AI_INVESTIGATION_ADDON },
      orderBy: { createdAt: "asc" },
    }),
    db.zeliSubscription.findMany({
      where: { plan: { addonKey: AI_INVESTIGATION_ADDON }, paidAt: { not: null } },
      orderBy: { paidAt: "desc" },
      include: { plan: true, tenant: { select: { id: true, code: true, name: true, status: true } } },
    }),
    db.aiInvestigationEntitlement.findMany(),
    db.aiInvestigationUsage.findMany({ where: { period: period(now) } }),
  ]);

  const activationByTenant = new Map(activations.map((row) => [row.tenantId, row]));
  const usageByTenant = new Map(usages.map((row) => [row.tenantId, row.requests]));

  // One row per business: its most recent paid package subscription.
  const latestByTenant = new Map<string, (typeof subscriptions)[number]>();
  for (const row of subscriptions) {
    if (!latestByTenant.has(row.tenantId)) latestByTenant.set(row.tenantId, row);
  }

  const businesses: EligibleBusinessRow[] = [];
  for (const row of latestByTenant.values()) {
    const activation = activationByTenant.get(row.tenantId);
    const paymentConfirmed = row.paidAt !== null;
    const paymentCurrent =
      paymentConfirmed &&
      row.status === "active" &&
      Boolean(row.periodEnd && row.periodEnd.getTime() > now.getTime());
    const activationStatus: "active" | "revoked" | "none" = activation
      ? activation.status === "active"
        ? "active"
        : "revoked"
      : "none";
    businesses.push({
      tenantId: row.tenantId,
      tenantCode: row.tenant.code,
      tenantName: row.tenant.name,
      tenantStatus: row.tenant.status,
      planCode: row.plan.code,
      planName: row.plan.name,
      planPrice: money(row.plan.price),
      planCurrency: row.plan.currency,
      billingInterval: row.plan.billingInterval,
      allowance: row.plan.usageAllowance,
      subscriptionStatus: row.status,
      paidAt: row.paidAt ? row.paidAt.toISOString() : null,
      periodEnd: row.periodEnd ? row.periodEnd.toISOString() : null,
      paymentConfirmed,
      paymentCurrent,
      activationStatus,
      activatedAt: activation ? activation.activatedAt.toISOString() : null,
      activatedByEmail: activation ? activation.activatedByEmail : null,
      expiresAt: activation ? activation.expiresAt.toISOString() : null,
      revokeReason: activation ? activation.revokeReason : null,
      usedThisMonth: usageByTenant.get(row.tenantId) ?? 0,
      // Activation is automatic once the provider confirms payment, so a confirmed
      // payment with no activation means the automatic path did not complete.
      // Manual activation exists for exactly that case, and it is audited.
      nextStep: !paymentCurrent
        ? "The paid period has ended or the subscription is not active. No activation is possible."
        : activationStatus === "active"
          ? activation?.activatedById === ADDON_PAYMENT_ACTOR_ID
            ? "Active, activated automatically by the verified payment. Revoke to withdraw access immediately."
            : "Active. Revoke to withdraw access immediately."
          : activationStatus === "revoked"
            ? "Revoked by a Super Admin. A new verified payment reactivates it."
            : "Payment confirmed but not activated. Activation is automatic; check the payment event before correcting it here.",
    });
  }

  return {
    success: true,
    data: {
      codeApproved: AI_INVESTIGATION_CODE_APPROVED,
      addonKey: AI_INVESTIGATION_ADDON,
      packages: packages.map((row) => ({
        id: row.id,
        code: row.code,
        name: row.name,
        price: money(row.price) ?? 0,
        currency: row.currency,
        billingInterval: row.billingInterval,
        allowance: row.usageAllowance,
        status: row.status,
      })),
      businesses,
    },
  };
}

/**
 * Activate the package for one business.
 *
 * Refusals are explicit: no paid subscription, an unconfirmed payment, an expired
 * period, an inactive business, or a missing reason. The activation copies the
 * current period end, so it cannot outlive the payment it depends on, and the live
 * check still reads the subscription.
 */
export async function activateAiInvestigation(input: {
  tenantId: string;
  reason: string;
}): Promise<AiInvestigationAdminResponse> {
  let session;
  try {
    session = await requirePlatformWrite();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Not authenticated" };
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  if (!AI_INVESTIGATION_CODE_APPROVED) {
    return { success: false, error: "External AI investigation is not approved for this deployment." };
  }

  const now = new Date();
  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, code: true, name: true, status: true },
  });
  if (!tenant) return { success: false, error: "That business was not found." };
  if (tenant.status !== "ACTIVE") {
    return { success: false, error: "This business is not active." };
  }

  const subscription = await db.zeliSubscription.findFirst({
    where: {
      tenantId: tenant.id,
      paidAt: { not: null },
      plan: { addonKey: AI_INVESTIGATION_ADDON },
    },
    orderBy: { paidAt: "desc" },
    include: { plan: true },
  });
  if (!subscription || !subscription.paidAt) {
    return {
      success: false,
      error:
        "No confirmed payment for the AI Investigation package was found. A payment must be verified by the provider first.",
    };
  }
  if (subscription.status !== "active") {
    return {
      success: false,
      error: `The package subscription is ${subscription.status.replace(/_/g, " ")}, so it cannot be activated.`,
    };
  }
  if (!subscription.periodEnd || subscription.periodEnd.getTime() <= now.getTime()) {
    return {
      success: false,
      error: "The paid period for this package has ended. Renew it before activating.",
    };
  }

  try {
    await db.$transaction(async (tx) => {
      const existing = await tx.aiInvestigationEntitlement.findUnique({
        where: { tenantId: tenant.id },
      });
      await tx.aiInvestigationEntitlement.upsert({
        where: { tenantId: tenant.id },
        create: {
          tenantId: tenant.id,
          status: "active",
          subscriptionId: subscription.id,
          planId: subscription.planId,
          planCode: subscription.plan.code,
          activatedById: session.adminId,
          activatedByEmail: session.email,
          activatedAt: now,
          expiresAt: subscription.periodEnd!,
          reason,
        },
        update: {
          status: "active",
          subscriptionId: subscription.id,
          planId: subscription.planId,
          planCode: subscription.plan.code,
          activatedById: session.adminId,
          activatedByEmail: session.email,
          activatedAt: now,
          expiresAt: subscription.periodEnd!,
          reason,
          revokedById: null,
          revokedByEmail: null,
          revokedAt: null,
          revokeReason: null,
        },
      });
      await tx.platformAuditLog.create({
        data: {
          actorId: session.adminId,
          actorEmail: session.email,
          action: existing ? "ai_investigation.reactivated" : "ai_investigation.activated",
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "ai_investigation_entitlement",
          entityId: tenant.id,
          reason,
          details: JSON.stringify({
            business: tenant.name,
            planCode: subscription.plan.code,
            subscriptionId: subscription.id,
            providerReference: subscription.providerReference,
            paidAt: subscription.paidAt ? subscription.paidAt.toISOString() : null,
            expiresAt: subscription.periodEnd ? subscription.periodEnd.toISOString() : null,
            previousStatus: existing?.status ?? null,
            timestamp: now.toISOString(),
            financialMutation: false,
          }),
        },
      });
    });
    return { success: true };
  } catch {
    return { success: false, error: "The activation could not be saved." };
  }
}

/** Revoke an activation. Access stops on the next request, not at a cache expiry. */
export async function revokeAiInvestigation(input: {
  tenantId: string;
  reason: string;
}): Promise<AiInvestigationAdminResponse> {
  let session;
  try {
    session = await requirePlatformWrite();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Not authenticated" };
  }

  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }

  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: { id: true, code: true, name: true },
  });
  if (!tenant) return { success: false, error: "That business was not found." };
  const existing = await db.aiInvestigationEntitlement.findUnique({
    where: { tenantId: tenant.id },
  });
  if (!existing) return { success: false, error: "This business has no activation to revoke." };
  if (existing.status !== "active") {
    return { success: false, error: "This activation is already revoked." };
  }

  try {
    const now = new Date();
    await db.$transaction(async (tx) => {
      await tx.aiInvestigationEntitlement.update({
        where: { tenantId: tenant.id },
        data: {
          status: "revoked",
          revokedById: session.adminId,
          revokedByEmail: session.email,
          revokedAt: now,
          revokeReason: reason,
        },
      });
      await tx.platformAuditLog.create({
        data: {
          actorId: session.adminId,
          actorEmail: session.email,
          action: "ai_investigation.revoked",
          tenantId: tenant.id,
          tenantCode: tenant.code,
          entityType: "ai_investigation_entitlement",
          entityId: tenant.id,
          reason,
          details: JSON.stringify({
            business: tenant.name,
            planCode: existing.planCode,
            previousStatus: existing.status,
            timestamp: now.toISOString(),
            financialMutation: false,
          }),
        },
      });
    });
    return { success: true };
  } catch {
    return { success: false, error: "The revocation could not be saved." };
  }
}

/**
 * The package catalogue entry for AI Investigation.
 *
 * The price is supplied by the Super Admin who configures the package: this action
 * never invents one, and it refuses a zero or missing price so an unpaid package
 * cannot exist.
 */
export async function configureAiInvestigationPackage(input: {
  code: string;
  name: string;
  price: number;
  billingInterval: "month" | "year";
  allowance: number | null;
  status: "draft" | "active";
  reason: string;
}): Promise<AiInvestigationAdminResponse<{ id: string }>> {
  let session;
  try {
    session = await requirePlatformWrite();
  } catch (error) {
    return { success: false, error: error instanceof Error ? error.message : "Not authenticated" };
  }

  const code = (input.code ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,40}$/.test(code)) {
    return { success: false, error: "Use a package code of 3-40 letters, digits, dashes or underscores." };
  }
  const name = (input.name ?? "").trim();
  if (name.length < 3 || name.length > 80) {
    return { success: false, error: "Enter a package name of 3-80 characters." };
  }
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0) {
    return { success: false, error: "Enter the price the platform has approved. It cannot be zero." };
  }
  if (!["month", "year"].includes(input.billingInterval)) {
    return { success: false, error: "Choose monthly or annual billing." };
  }
  const allowance =
    input.allowance === null || input.allowance === undefined
      ? AI_INVESTIGATION_DEFAULT_MONTHLY_LIMIT
      : Math.round(Number(input.allowance));
  if (!Number.isFinite(allowance) || allowance < 1 || allowance > 10_000) {
    return { success: false, error: "The monthly allowance must be between 1 and 10000." };
  }
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }

  try {
    const created = await db.$transaction(async (tx) => {
      const plan = await tx.zeliPlan.upsert({
        where: { code },
        create: {
          code,
          name,
          description: "Dedicated AI Investigation package: external explanation of anomaly findings.",
          billingInterval: input.billingInterval,
          price,
          currency: "GHS",
          features: JSON.stringify([
            "External AI explanation of anomaly findings",
            "Evidence pack with citations",
            "Human review before any draft is relied on",
          ]),
          usageAllowance: allowance,
          addonKey: AI_INVESTIGATION_ADDON,
          zeliIncluded: false,
          status: input.status,
          isPublic: false,
          createdById: session.adminId,
          updatedById: session.adminId,
        },
        update: {
          name,
          billingInterval: input.billingInterval,
          price,
          usageAllowance: allowance,
          addonKey: AI_INVESTIGATION_ADDON,
          status: input.status,
          updatedById: session.adminId,
        },
        select: { id: true },
      });
      await tx.platformAuditLog.create({
        data: {
          actorId: session.adminId,
          actorEmail: session.email,
          action: "ai_investigation.package_configured",
          entityType: "zeli_plan",
          entityId: plan.id,
          reason,
          details: JSON.stringify({
            code,
            name,
            price,
            billingInterval: input.billingInterval,
            allowance,
            status: input.status,
            timestamp: new Date().toISOString(),
          }),
        },
      });
      return plan;
    });
    return { success: true, data: { id: created.id } };
  } catch {
    return { success: false, error: "The package could not be saved." };
  }
}

"use server";

import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { requirePlatformPage } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import { provisionBusiness, type ProvisionResult } from "@/lib/platform/provisioning";
import { assignFoundingAllocation, foundingSlots, FOUNDING_PERIODS } from "@/lib/pricing/founding";
import { createNotification } from "@/lib/notifications/notifications";

/**
 * Platform Super Admin provisioning actions.
 *
 * Only a platform session may call these. A public enquiry never becomes an
 * active tenant by itself: conversion requires an explicit operator action,
 * creates a PENDING_PAYMENT tenant and leaves activation to a verified payment.
 */

export interface ProvisioningPlanOption {
  code: string;
  name: string;
  billingInterval: string;
  price: number;
  foundingPrice: number | null;
  locationLimit: number | null;
  staffLimit: number | null;
  usageAllowance: number | null;
  supportLevel: string | null;
}

export async function getProvisioningOptions(): Promise<{
  plans: ProvisioningPlanOption[];
  founding: { capacity: number; used: number; remaining: number };
}> {
  await requirePlatformPage();
  const plans = await db.zeliPlan.findMany({
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
  });
  const slots = await foundingSlots();
  return {
    plans: plans.map((plan) => ({
      ...plan,
      price: Number(plan.price),
      foundingPrice: plan.foundingPrice == null ? null : Number(plan.foundingPrice),
    })),
    founding: { capacity: slots.capacity, used: slots.used, remaining: slots.remaining },
  };
}

export async function provisionBusinessAction(input: {
  name: string;
  legalName?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  momoEnabled: boolean;
  susuEnabled: boolean;
  adminFullName: string;
  adminEmail: string;
  adminPhone?: string;
  planCode: string;
  foundingOptIn: boolean;
  enquiryId?: string | null;
}): Promise<ProvisionResult> {
  const session = await requirePlatformPage();
  const limit = await consumeRateLimit(
    "platform:provision",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!limit.allowed) {
    return { ok: false, error: "Too many provisioning requests. Please wait and try again." };
  }

  const result = await provisionBusiness({
    ...input,
    actorId: session.adminId,
    actorEmail: session.email,
  });
  if (!result.ok) return result;

  const auditBase = {
    actorId: session.adminId,
    actorEmail: session.email,
    tenantId: result.tenantId,
    tenantCode: result.tenantCode,
  };
  await createPlatformAuditLog({
    ...auditBase,
    action: "platform.tenant_provisioned",
    entityType: "BusinessTenant",
    entityId: result.tenantId,
    details: {
      planCode: result.planCode,
      billingTerm: result.billingTerm,
      amount: result.amount,
      foundingSlot: result.foundingSlot,
      enquiryId: input.enquiryId ?? null,
      status: "PENDING_PAYMENT",
    },
    reason: "Controlled commercial provisioning",
  });
  await createPlatformAuditLog({
    ...auditBase,
    action: "platform.tenant_admin_provisioned",
    entityType: "User",
    entityId: result.adminUserId,
    details: { adminEmail: result.adminEmail, credential: "one-time" },
  });
  await createPlatformAuditLog({
    ...auditBase,
    action: "platform.plan_assigned",
    entityType: "ZeliSubscription",
    entityId: result.subscriptionId,
    details: {
      planCode: result.planCode,
      billingTerm: result.billingTerm,
      amount: result.amount,
      standardAmount: result.standardAmount,
      reference: result.paymentReference,
    },
  });
  if (result.foundingSlot != null) {
    await createPlatformAuditLog({
      ...auditBase,
      action: "platform.founding_slot_assigned",
      entityType: "FoundingAllocation",
      entityId: result.tenantId,
      details: { slot: result.foundingSlot, periods: FOUNDING_PERIODS },
    });
  }
  if (input.enquiryId) {
    await createPlatformAuditLog({
      ...auditBase,
      action: "platform.enquiry_converted",
      entityType: "account_enquiry",
      entityId: input.enquiryId,
      details: { tenantCode: result.tenantCode },
    });
  }

  await createNotification({
    audience: "platform",
    kind: "system",
    severity: "info",
    title: `Business provisioned: ${result.tenantCode}`,
    body: `${input.name} was created in pending payment on the ${result.planName} package. The first administrator must sign in and complete payment.`,
    href: "/platform/billing",
    dedupeKey: `platform:provisioned:${result.tenantId}`,
  });

  revalidatePath("/platform/enquiries");
  revalidatePath("/platform/billing");
  revalidatePath("/platform/tenants");
  revalidatePath("/platform/dashboard");
  return result;
}

/**
 * Assign (or re-assign) a package to an existing tenant without charging or
 * suspending anyone. Creates a pending_payment subscription that the tenant
 * administrator settles from Billing. Audited.
 */
export async function assignPackageToTenantAction(input: {
  tenantId: string;
  planCode: string;
  foundingOptIn: boolean;
}): Promise<{ ok: true; amount: number; reference: string } | { ok: false; error: string }> {
  const session = await requirePlatformPage();
  const limit = await consumeRateLimit(
    "platform:assign-plan",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!limit.allowed) return { ok: false, error: "Too many requests. Please wait and try again." };

  const tenant = await db.businessTenant.findUnique({ where: { id: input.tenantId } });
  if (!tenant) return { ok: false, error: "Business not found." };
  const plan = await db.zeliPlan.findUnique({ where: { code: input.planCode } });
  if (!plan || plan.status !== "active") return { ok: false, error: "Choose an active package." };

  const active = await db.zeliSubscription.findFirst({
    where: { tenantId: tenant.id, status: { in: ["active", "grace_period", "suspended"] } },
  });
  if (active) {
    return {
      ok: false,
      error:
        "This business already has a subscription record. Use Billing to renew or change package instead of re-assigning.",
    };
  }

  try {
    const created = await db.$transaction(async (tx) => {
      let foundingId: string | null = null;
      let amount = plan.price;
      if (input.foundingOptIn) {
        const assignment = await assignFoundingAllocation({
          tenantId: tenant.id,
          plan: {
            id: plan.id,
            code: plan.code,
            billingInterval: plan.billingInterval,
            price: plan.price,
            foundingPrice: plan.foundingPrice,
          },
          actorId: session.adminId,
          client: tx,
        });
        if (!assignment.ok) throw new Error("founding_unavailable");
        foundingId = assignment.allocationId;
        amount = plan.foundingPrice!;
      }
      const reference = `PROV-${tenant.id.slice(0, 8)}-${Date.now().toString(36)}`;
      const subscription = await tx.zeliSubscription.create({
        data: {
          tenantId: tenant.id,
          planId: plan.id,
          status: "pending_payment",
          provider: "paystack",
          providerReference: reference,
          amount,
          currency: plan.currency,
          billingTerm: plan.billingInterval === "year" ? "annual" : "monthly",
          foundingAllocationId: foundingId,
          standardAmount: plan.price,
        },
      });
      return { subscription, amount };
    });

    await createPlatformAuditLog({
      actorId: session.adminId,
      actorEmail: session.email,
      action: "platform.plan_assigned",
      tenantId: tenant.id,
      tenantCode: tenant.code,
      entityType: "ZeliSubscription",
      entityId: created.subscription.id,
      details: {
        planCode: plan.code,
        amount: Number(created.amount),
        founding: input.foundingOptIn,
      },
      reason: "Existing-tenant package assignment (no charge)",
    });
    revalidatePath("/platform/billing");
    return { ok: true, amount: Number(created.amount), reference: created.subscription.providerReference };
  } catch (error) {
    if (error instanceof Error && error.message === "founding_unavailable") {
      return { ok: false, error: "No founding slot is available for this package." };
    }
    return { ok: false, error: "Package assignment failed. No records were changed." };
  }
}

export interface TenantMappingRow {
  tenantId: string;
  code: string;
  name: string;
  status: string;
  locations: number;
  staff: number;
  modules: string[];
  recommendedPlan: string;
  subscriptionStatus: string;
  entitlement: string;
  differences: string[];
}

/** Read-only mapping of existing businesses to the commercial catalogue. */
export async function getTenantMapping(): Promise<TenantMappingRow[]> {
  await requirePlatformPage();
  const tenants = await db.businessTenant.findMany({
    orderBy: { createdAt: "asc" },
    select: {
      id: true,
      code: true,
      name: true,
      status: true,
      momoEnabled: true,
      susuEnabled: true,
      _count: { select: { locations: true, users: true } },
      zeliSubscriptions: {
        orderBy: { createdAt: "desc" },
        take: 1,
        select: { status: true, plan: { select: { name: true } } },
      },
      zeliEntitlements: { where: { featureKey: "zeli_analytics" }, take: 1, select: { status: true } },
    },
  });
  const plans = await db.zeliPlan.findMany({
    where: { status: "active", billingInterval: "month" },
    orderBy: { sortOrder: "asc" },
    select: { code: true, name: true, locationLimit: true, staffLimit: true },
  });

  return tenants.map((tenant) => {
    const locations = tenant._count.locations;
    const staff = tenant._count.users;
    const recommended =
      [...plans].reverse().find((plan) => (plan.locationLimit ?? 0) >= locations) ?? plans[plans.length - 1];
    const subscription = tenant.zeliSubscriptions[0] ?? null;
    const differences: string[] = [];
    if (recommended?.locationLimit != null && locations > recommended.locationLimit) {
      differences.push(`${locations} locations exceed the ${recommended.name} limit of ${recommended.locationLimit}`);
    }
    if (recommended?.staffLimit != null && staff > recommended.staffLimit) {
      differences.push(`${staff} staff exceed the ${recommended.name} limit of ${recommended.staffLimit}`);
    }
    return {
      tenantId: tenant.id,
      code: tenant.code,
      name: tenant.name,
      status: tenant.status,
      locations,
      staff,
      modules: [tenant.momoEnabled ? "MoMo" : null, tenant.susuEnabled ? "Susu" : null].filter(Boolean) as string[],
      recommendedPlan: recommended?.name ?? "Starter",
      subscriptionStatus: subscription ? `${subscription.plan.name} (${subscription.status})` : "No subscription",
      entitlement: tenant.zeliEntitlements[0]?.status ?? "none",
      differences,
    };
  });
}

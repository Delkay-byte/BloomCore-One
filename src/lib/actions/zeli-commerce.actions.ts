"use server";

import { db } from "@/lib/db";
import { getPlatformAdminOrNull } from "@/lib/platform-auth";
import { createPlatformAuditLog } from "@/lib/platform-audit";
import { consumeRateLimit } from "@/lib/security/rate-limit";
import { RATE_LIMITS } from "@/lib/security/config";
import {
  reconcileZeliSubscription,
  retryZeliPaymentRefund,
} from "@/lib/payments/zeli-subscriptions";
import { paystackReadyForCheckout } from "@/lib/payments/paystack";

/**
 * Platform commerce administration. Every mutation requires a platform
 * session, a mandatory reason and an audit event. The catalogue is the only
 * source of prices; checkout never accepts an amount from the browser.
 */

export interface CommerceResponse<T = unknown> {
  success: boolean;
  error?: string;
  data?: T;
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
    "platform.zeli.commerce",
    session.adminId,
    RATE_LIMITS.adminSensitive
  );
  if (!rate.allowed) throw new Error("Too many changes. Try again later.");
  return session;
}

async function audit(
  session: { adminId: string; email: string },
  action: string,
  params: { reason: string; entityId?: string; details?: Record<string, unknown> }
) {
  await createPlatformAuditLog({
    actorId: session.adminId,
    actorEmail: session.email,
    action,
    entityType: "zeli_commerce",
    entityId: params.entityId ?? null,
    reason: params.reason,
    details: params.details ?? null,
  });
}

export interface PlatformZeliPlan {
  id: string;
  code: string;
  name: string;
  description: string | null;
  billingInterval: string;
  price: number;
  currency: string;
  features: string[];
  usageAllowance: number | null;
  trialDays: number;
  providerPlanCode: string | null;
  status: string;
  isPublic: boolean;
  sortOrder: number;
}

export async function listZeliPlansForPlatform(): Promise<PlatformZeliPlan[]> {
  await requirePlatformRead();
  const rows = await db.zeliPlan.findMany({
    orderBy: [{ sortOrder: "asc" }, { createdAt: "asc" }],
  });
  return rows.map((row) => ({
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    billingInterval: row.billingInterval,
    price: Number(row.price),
    currency: row.currency,
    features: row.features ? (JSON.parse(row.features) as string[]) : [],
    usageAllowance: row.usageAllowance,
    trialDays: row.trialDays,
    providerPlanCode: row.providerPlanCode,
    status: row.status,
    isPublic: row.isPublic,
    sortOrder: row.sortOrder,
  }));
}

export async function upsertZeliPlan(input: {
  id?: string;
  code: string;
  name: string;
  description?: string;
  billingInterval: string;
  price: number;
  currency: string;
  features?: string[];
  usageAllowance?: number | null;
  trialDays?: number;
  providerPlanCode?: string | null;
  status: string;
  isPublic: boolean;
  reason: string;
}): Promise<CommerceResponse<{ id: string }>> {
  const session = await requirePlatformWrite();
  const reason = (input.reason ?? "").trim();
  if (reason.length < 10 || reason.length > 500) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  const code = String(input.code ?? "").trim().toLowerCase();
  if (!/^[a-z0-9][a-z0-9_-]{2,60}$/.test(code)) {
    return { success: false, error: "Use a code of 3–61 letters, digits, - or _." };
  }
  const name = String(input.name ?? "").trim();
  if (name.length < 2 || name.length > 80) {
    return { success: false, error: "Enter a package name." };
  }
  if (!["month", "year"].includes(input.billingInterval)) {
    return { success: false, error: "Billing interval must be month or year." };
  }
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0 || price > 10_000_000) {
    return { success: false, error: "Enter an approved price greater than zero." };
  }
  const currency = String(input.currency ?? "").trim().toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) {
    return { success: false, error: "Enter a three-letter currency code." };
  }
  if (!["draft", "active", "archived"].includes(input.status)) {
    return { success: false, error: "Unknown package status." };
  }
  const features = Array.isArray(input.features)
    ? input.features.map((value) => String(value).trim()).filter(Boolean).slice(0, 12)
    : [];
  const usageAllowance =
    input.usageAllowance == null ? null : Math.max(1, Math.min(1000, Math.floor(Number(input.usageAllowance))));
  const trialDays = Math.max(0, Math.min(90, Math.floor(Number(input.trialDays ?? 0))));
  const providerPlanCode = input.providerPlanCode
    ? String(input.providerPlanCode).trim().slice(0, 80)
    : null;

  try {
    const row = await db.zeliPlan.upsert({
      where: input.id ? { id: input.id } : { code },
      create: {
        code,
        name,
        description: input.description?.trim().slice(0, 300) || null,
        billingInterval: input.billingInterval,
        price,
        currency,
        features: JSON.stringify(features),
        usageAllowance,
        trialDays,
        providerPlanCode,
        status: input.status,
        isPublic: Boolean(input.isPublic),
        createdById: session.adminId,
        updatedById: session.adminId,
      },
      update: {
        code,
        name,
        description: input.description?.trim().slice(0, 300) || null,
        billingInterval: input.billingInterval,
        price,
        currency,
        features: JSON.stringify(features),
        usageAllowance,
        trialDays,
        providerPlanCode,
        status: input.status,
        isPublic: Boolean(input.isPublic),
        updatedById: session.adminId,
      },
    });
    await audit(session, input.id ? "zeli.plan_updated" : "zeli.plan_created", {
      reason,
      entityId: row.id,
      details: { code, price, currency, interval: input.billingInterval, status: input.status },
    });
    return { success: true, data: { id: row.id } };
  } catch {
    return { success: false, error: "The package could not be saved." };
  }
}

export interface PlatformSubscriptionRow {
  id: string;
  tenantCode: string;
  tenantName: string;
  planName: string;
  provider: string;
  status: string;
  amount: number;
  currency: string;
  periodEnd: string | null;
  reference: string;
  cancelAtPeriodEnd: boolean;
  createdAt: string;
}

export async function listZeliSubscriptions(search?: string): Promise<PlatformSubscriptionRow[]> {
  await requirePlatformRead();
  const query = (search ?? "").trim().slice(0, 80);
  const rows = await db.zeliSubscription.findMany({
    where: query
      ? {
          OR: [
            { tenant: { name: { contains: query } } },
            { tenant: { code: { contains: query } } },
            { providerReference: { contains: query } },
          ],
        }
      : undefined,
    orderBy: { createdAt: "desc" },
    take: 50,
    include: { tenant: { select: { code: true, name: true } }, plan: { select: { name: true } } },
  });
  return rows.map((row) => ({
    id: row.id,
    tenantCode: row.tenant.code,
    tenantName: row.tenant.name,
    planName: row.plan.name,
    provider: row.provider,
    status: row.status,
    amount: Number(row.amount),
    currency: row.currency,
    periodEnd: row.periodEnd?.toISOString() ?? null,
    reference: row.providerReference,
    cancelAtPeriodEnd: row.cancelAtPeriodEnd,
    createdAt: row.createdAt.toISOString(),
  }));
}

export async function getZeliCommerceOverview(): Promise<{
  subscriptions: { total: number; active: number; pending: number; expired: number; cancelled: number; failed: number; refunded: number; superseded: number };
  revenue: { collected: number; currency: string; reliable: boolean };
  packages: Array<{ name: string; count: number }>;
  providerConfigured: boolean;
  openExceptions: number;
}> {
  await requirePlatformRead();
  const [rows, openExceptions] = await Promise.all([
    db.zeliSubscription.findMany({
      select: { status: true, amount: true, currency: true, plan: { select: { name: true } } },
      take: 5000,
    }),
    db.zeliPaymentException.count({ where: { status: "open" } }),
  ]);
  const count = (status: string) => rows.filter((row) => row.status === status).length;
  const activePaid = rows.filter(
    (row) => row.status === "active" || row.status === "expired" || row.status === "cancelled"
  );
  const currency = activePaid[0]?.currency ?? "GHS";
  const collected = activePaid
    .filter((row) => row.currency === currency)
    .reduce((sum, row) => sum + Number(row.amount), 0);
  const packageMap = new Map<string, number>();
  for (const row of rows) {
    packageMap.set(row.plan.name, (packageMap.get(row.plan.name) ?? 0) + 1);
  }
  return {
    subscriptions: {
      total: rows.length,
      active: count("active"),
      pending: count("pending"),
      expired: count("expired"),
      cancelled: count("cancelled"),
      failed: count("failed"),
      refunded: count("refunded"),
      superseded: count("superseded"),
    },
    revenue: {
      collected: Math.round(collected * 100) / 100,
      currency,
      reliable: false,
    },
    packages: Array.from(packageMap.entries()).map(([name, countValue]) => ({
      name,
      count: countValue,
    })),
    providerConfigured: paystackReadyForCheckout(),
    openExceptions,
  };
}

export async function reconcileZeliSubscriptionAction(
  subscriptionId: string,
  reason: string
): Promise<CommerceResponse<{ decision: string }>> {
  const session = await requirePlatformWrite();
  const cleanReason = (reason ?? "").trim();
  if (cleanReason.length < 10) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  try {
    const result = await reconcileZeliSubscription(subscriptionId);
    await audit(session, "zeli.subscription_reconciled", {
      reason: cleanReason,
      entityId: subscriptionId,
      details: { decision: result.decision },
    });
    return { success: true, data: result };
  } catch {
    return { success: false, error: "Reconciliation failed. Check the provider configuration." };
  }
}

export interface PlatformPaymentExceptionRow {
  id: string;
  subscriptionId: string | null;
  tenantCode: string | null;
  reference: string | null;
  kind: string;
  status: string;
  amount: number | null;
  currency: string | null;
  detail: string;
  createdAt: string;
}

/** Visible, auditable queue of payments that need a human decision. */
export async function listZeliPaymentExceptions(): Promise<PlatformPaymentExceptionRow[]> {
  await requirePlatformRead();
  const rows = await db.zeliPaymentException.findMany({
    orderBy: [{ status: "asc" }, { createdAt: "desc" }],
    take: 50,
  });
  const tenantIds = Array.from(
    new Set(rows.map((row) => row.tenantId).filter((value): value is string => Boolean(value)))
  );
  const tenants = tenantIds.length
    ? await db.businessTenant.findMany({
        where: { id: { in: tenantIds } },
        select: { id: true, code: true },
      })
    : [];
  const codes = new Map(tenants.map((tenant) => [tenant.id, tenant.code]));
  return rows.map((row) => ({
    id: row.id,
    subscriptionId: row.subscriptionId,
    tenantCode: row.tenantId ? codes.get(row.tenantId) ?? null : null,
    reference: row.reference,
    kind: row.kind,
    status: row.status,
    amount: row.amount == null ? null : Number(row.amount),
    currency: row.currency,
    detail: row.detail,
    createdAt: row.createdAt.toISOString(),
  }));
}

/**
 * Retry a failed or stuck refund. The provider result is the only success
 * signal; a repeated call for an already processed refund makes no request.
 */
export async function retryZeliRefundAction(
  subscriptionId: string,
  reason: string
): Promise<CommerceResponse<{ decision: string }>> {
  const session = await requirePlatformWrite();
  const cleanReason = (reason ?? "").trim();
  if (cleanReason.length < 10) {
    return { success: false, error: "Enter a reason of at least 10 characters." };
  }
  try {
    const result = await retryZeliPaymentRefund({
      subscriptionId,
      reason: cleanReason,
      actorId: session.adminId,
      tenantId: null,
    });
    await audit(session, "zeli.payment_refund_retried", {
      reason: cleanReason,
      entityId: subscriptionId,
      details: { decision: result.decision, providerReason: result.reason },
    });
    return { success: true, data: { decision: result.decision } };
  } catch {
    return {
      success: false,
      error: "The refund could not be retried. The existing exception remains open.",
    };
  }
}

export async function resolveZeliPaymentExceptionAction(
  exceptionId: string,
  note: string
): Promise<CommerceResponse> {
  const session = await requirePlatformWrite();
  const clean = (note ?? "").trim();
  if (clean.length < 10) {
    return { success: false, error: "Enter a resolution note of at least 10 characters." };
  }
  const updated = await db.zeliPaymentException.updateMany({
    where: { id: exceptionId, status: "open" },
    data: {
      status: "resolved",
      resolutionNote: clean,
      resolvedById: session.adminId,
      resolvedAt: new Date(),
    },
  });
  if (updated.count === 0) {
    return { success: false, error: "That exception is not open." };
  }
  await audit(session, "zeli.payment_exception_resolved", {
    reason: clean,
    entityId: exceptionId,
  });
  return { success: true };
}

/**
 * Subscription lifecycle, reminders and pending-payment reconciliation.
 *
 * pending_payment -> active -> grace_period -> suspended
 *
 * The lifecycle is derived from the verified payment period, never from a
 * browser redirect or a customer claim. Grace is five calendar days. Reminders
 * are durable (notification + e-mail + reminderStage on the subscription), so
 * restarting the service cannot double-send or skip a stage.
 */

import { db } from "@/lib/db";
import { appBaseUrl, sendTransactionalEmail } from "@/lib/email/resend";
import { createNotification } from "@/lib/notifications/notifications";
import { fulfilPaidSubscription } from "@/lib/payments/zeli-subscriptions";
import { paystackConfigured, verifyTransaction } from "@/lib/payments/paystack";

export const GRACE_DAYS = 5;
export const RENEWAL_REMINDER_DAYS = [7, 3, 1] as const;
const DAY_MS = 24 * 60 * 60 * 1000;

export type SubscriptionLifecycle = "pending_payment" | "active" | "grace_period" | "suspended" | "ended";

/** Pure classification used by dashboards and tests. */
export function lifecycleOf(
  subscription: { status: string; periodEnd: Date | null; graceEndsAt: Date | null },
  now: Date = new Date()
): SubscriptionLifecycle {
  if (subscription.status === "pending_payment" || subscription.status === "pending") {
    return "pending_payment";
  }
  if (subscription.status === "suspended") return "suspended";
  if (subscription.status === "grace_period") return "grace_period";
  if (subscription.status !== "active") return "ended";
  if (!subscription.periodEnd) return "active";
  if (subscription.periodEnd.getTime() > now.getTime()) return "active";
  const graceEnd = subscription.graceEndsAt ?? new Date(subscription.periodEnd.getTime() + GRACE_DAYS * DAY_MS);
  return graceEnd.getTime() > now.getTime() ? "grace_period" : "suspended";
}

export function daysBetween(from: Date, to: Date): number {
  return Math.ceil((to.getTime() - from.getTime()) / DAY_MS);
}

async function notifyTenant(input: {
  tenantId: string;
  severity: "critical" | "attention" | "info";
  title: string;
  body: string;
  href: string;
  dedupeKey: string;
  emailSubject?: string;
}) {
  const tenant = await db.businessTenant.findUnique({
    where: { id: input.tenantId },
    select: {
      name: true,
      contactEmail: true,
      primaryAdminUserId: true,
    },
  });
  if (!tenant) return;
  await createNotification({
    tenantId: input.tenantId,
    audience: "tenant",
    kind: "system",
    severity: input.severity,
    title: input.title,
    body: input.body,
    href: input.href,
    dedupeKey: input.dedupeKey,
  });

  const admin = tenant.primaryAdminUserId
    ? await db.user.findUnique({
        where: { id: tenant.primaryAdminUserId },
        select: { email: true },
      })
    : null;
  const to = admin?.email ?? tenant.contactEmail;
  if (!to) return;
  const link = `${appBaseUrl()}${input.href}`;
  await sendTransactionalEmail({
    to,
    subject: input.emailSubject ?? input.title,
    text: `${input.body}\n\nOpen MaaCash: ${link}`,
    html: `<p>${escapeHtml(input.body)}</p><p><a href="${link}">Open MaaCash</a></p>`,
    tag: "subscription-lifecycle",
  }).catch(() => undefined);
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export interface LifecycleResult {
  reminded: number;
  graced: number;
  suspended: number;
  reactivated: number;
}

/**
 * Apply the approved lifecycle rules. Safe to run repeatedly; every mutation
 * is conditional on the previous state, so a concurrent run cannot double-apply.
 */
export async function runBillingLifecycle(now: Date = new Date()): Promise<LifecycleResult> {
  const result: LifecycleResult = { reminded: 0, graced: 0, suspended: 0, reactivated: 0 };

  // 1. Renewal reminders before expiry (7, 3, 1 days).
  const upcoming = await db.zeliSubscription.findMany({
    where: {
      status: "active",
      periodEnd: { gt: now, lte: new Date(now.getTime() + 8 * DAY_MS) },
    },
    select: { id: true, tenantId: true, periodEnd: true, reminderStage: true, plan: { select: { name: true } } },
    take: 200,
  });
  for (const subscription of upcoming) {
    const days = daysBetween(now, subscription.periodEnd!);
    const stage = RENEWAL_REMINDER_DAYS.find((candidate) => candidate === days);
    if (!stage) continue;
    const stageKey = String(stage);
    if (subscription.reminderStage === stageKey) continue;
    const claimed = await db.zeliSubscription.updateMany({
      where: {
        id: subscription.id,
        OR: [{ reminderStage: null }, { reminderStage: { not: stageKey } }],
      },
      data: { reminderStage: stageKey },
    });
    if (claimed.count === 0) continue;
    await notifyTenant({
      tenantId: subscription.tenantId,
      severity: stage <= 1 ? "attention" : "info",
      title: `Your ${subscription.plan.name} plan renews in ${stage} day${stage === 1 ? "" : "s"}`,
      body: `Your subscription period ends on ${subscription.periodEnd!.toISOString().slice(0, 10)}. Renew from Billing to keep full access. Nothing is charged automatically.`,
      href: "/admin/billing",
      dedupeKey: `billing:renewal:${subscription.id}:${stageKey}`,
    });
    result.reminded += 1;
  }

  // 2. Expiry -> five-day grace period.
  const expiring = await db.zeliSubscription.findMany({
    where: { status: "active", periodEnd: { lte: now }, graceEndsAt: null },
    select: { id: true, tenantId: true, periodEnd: true },
    take: 200,
  });
  for (const subscription of expiring) {
    const graceEndsAt = new Date(subscription.periodEnd!.getTime() + GRACE_DAYS * DAY_MS);
    const claimed = await db.zeliSubscription.updateMany({
      where: { id: subscription.id, status: "active", graceEndsAt: null },
      data: { status: "grace_period", graceEndsAt, reminderStage: "grace" },
    });
    if (claimed.count === 0) continue;
    await notifyTenant({
      tenantId: subscription.tenantId,
      severity: "attention",
      title: "Your subscription has reached the end of its period",
      body: `You have ${GRACE_DAYS} days of grace access until ${graceEndsAt.toISOString().slice(0, 10)}. Renew from Billing to avoid interruption.`,
      href: "/admin/billing",
      dedupeKey: `billing:grace:${subscription.id}`,
    });
    result.graced += 1;
  }

  // 3. Grace reminders (3 and 1 days before suspension).
  const inGrace = await db.zeliSubscription.findMany({
    where: { status: "grace_period", graceEndsAt: { gt: now, lte: new Date(now.getTime() + 4 * DAY_MS) } },
    select: { id: true, tenantId: true, graceEndsAt: true },
    take: 200,
  });
  for (const subscription of inGrace) {
    const days = daysBetween(now, subscription.graceEndsAt!);
    if (days !== 3 && days !== 1) continue;
    const stageKey = `grace-${days}`;
    const claimed = await db.zeliSubscription.updateMany({
      where: {
        id: subscription.id,
        OR: [{ reminderStage: null }, { reminderStage: { not: stageKey } }],
      },
      data: { reminderStage: stageKey },
    });
    if (claimed.count === 0) continue;
    await notifyTenant({
      tenantId: subscription.tenantId,
      severity: "critical",
      title: `Access is suspended in ${days} day${days === 1 ? "" : "s"}`,
      body: `Grace access ends on ${subscription.graceEndsAt!.toISOString().slice(0, 10)}. Renew from Billing to keep using MaaCash and Zeli. Your data is never deleted.`,
      href: "/admin/billing",
      dedupeKey: `billing:suspend-soon:${subscription.id}:${days}`,
    });
    result.reminded += 1;
  }

  // 4. Grace exhausted -> suspended (billing access stays available).
  const exhausted = await db.zeliSubscription.findMany({
    where: { status: "grace_period", graceEndsAt: { lte: now } },
    select: { id: true, tenantId: true },
    take: 200,
  });
  for (const subscription of exhausted) {
    const claimed = await db.zeliSubscription.updateMany({
      where: { id: subscription.id, status: "grace_period" },
      data: { status: "suspended", reminderStage: "suspended" },
    });
    if (claimed.count === 0) continue;
    await db.zeliEntitlement.updateMany({
      where: { tenantId: subscription.tenantId, featureKey: "zeli_analytics" },
      data: {
        status: "suspended",
        suspendedAt: now,
        reason: "Subscription grace period ended; renew to restore access",
      },
    });
    await notifyTenant({
      tenantId: subscription.tenantId,
      severity: "critical",
      title: "Your subscription is suspended",
      body: "Your grace period has ended and business features are paused. Sign in and renew from Billing to restore access immediately. No data has been deleted.",
      href: "/admin/billing",
      dedupeKey: `billing:suspended:${subscription.id}`,
    });
    result.suspended += 1;
  }

  // 5. Repair: a verified payment may already exist for a suspended account.
  const suspended = await db.zeliSubscription.findMany({
    where: { status: "suspended", paidAt: { not: null } },
    select: { id: true, tenantId: true, periodEnd: true },
    take: 50,
  });
  for (const subscription of suspended) {
    if (subscription.periodEnd && subscription.periodEnd.getTime() > now.getTime()) {
      const claimed = await db.zeliSubscription.updateMany({
        where: { id: subscription.id, status: "suspended" },
        data: { status: "active", graceEndsAt: null, reminderStage: null },
      });
      if (claimed.count > 0) result.reactivated += 1;
    }
  }

  return result;
}

export interface ReconciliationResult {
  checked: number;
  activated: number;
  pending: number;
  failed: number;
}

/**
 * Bounded server-side reconciliation of pending references. Only provider
 * answers can activate a subscription; ambiguous or failed charges are left
 * alone. Every success uses the deterministic `reconcile:<reference>` event id,
 * so a concurrent webhook and this sweep cannot activate twice.
 */
export async function reconcilePendingPayments(now: Date = new Date()): Promise<ReconciliationResult> {
  const result: ReconciliationResult = { checked: 0, activated: 0, pending: 0, failed: 0 };
  if (!paystackConfigured()) return result;

  const cutoff = new Date(now.getTime() - 2 * 60 * 1000);
  const pending = await db.zeliSubscription.findMany({
    where: {
      status: { in: ["pending_payment", "pending"] },
      paidAt: null,
      createdAt: { lt: cutoff },
    },
    select: { id: true, providerReference: true, tenantId: true },
    orderBy: { createdAt: "asc" },
    take: 10,
  });

  for (const subscription of pending) {
    if (!/^(ZELI|ZELIM|PROV)-/.test(subscription.providerReference)) continue;
    result.checked += 1;
    let transaction;
    try {
      transaction = await verifyTransaction(subscription.providerReference);
    } catch {
      result.pending += 1;
      continue;
    }
    if (transaction.status !== "success") {
      result.pending += 1;
      continue;
    }
    const outcome = await fulfilPaidSubscription({
      reference: subscription.providerReference,
      eventId: `reconcile:${subscription.providerReference}`,
      eventType: "charge.success.reconciled",
      transaction,
    });
    if (outcome.decision === "processed" || outcome.decision === "ignored") {
      result.activated += 1;
    } else if (outcome.decision === "failed" || outcome.decision === "exception") {
      result.failed += 1;
    } else {
      result.pending += 1;
    }
  }
  return result;
}

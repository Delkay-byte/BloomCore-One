/**
 * Subscription access is a business state, not an authentication state.
 *
 * A package that is awaiting payment, expired, failed or suspended must never
 * be presented as a lost login. This module is the single server-side
 * classification used by login, the administrators’ layout gate and the
 * paid-operations guard. It reads only the authenticated tenant id; a browser
 * cannot choose its own state.
 */

import { db } from "@/lib/db";

export type SubscriptionAccessReason =
  | "active"
  | "grace_period"
  | "pending_payment"
  | "expired"
  | "failed"
  | "cancelled"
  | "refunded"
  | "past_due"
  | "suspended"
  | "none"
  | "tenant_unavailable";

export interface SubscriptionAccess {
  reason: SubscriptionAccessReason;
  /** True when money operations may proceed. */
  operable: boolean;
  /** True when the owner has something to do in Billing & Plan. */
  billingRequired: boolean;
  /** Safe, user-facing summary. No provider, tenant or payment details. */
  headline: string;
  detail: string;
  /** Safe date for a grace-period message, when one applies. */
  graceEndsAt: Date | null;
}

const ACTIVE = new Set(["active"]);
const GRACE = new Set(["grace_period"]);
const PENDING = new Set(["pending_payment", "pending"]);
const FAILED = new Set(["failed", "past_due"]);
const CANCELLED = new Set(["cancelled"]);
const REFUNDED = new Set(["refunded"]);
const SUSPENDED = new Set(["suspended"]);

function graceEndFor(subscription: {
  periodEnd: Date | null;
  graceEndsAt: Date | null;
}): Date | null {
  if (subscription.graceEndsAt) return subscription.graceEndsAt;
  if (!subscription.periodEnd) return null;
  // The approved grace window is five calendar days.
  return new Date(subscription.periodEnd.getTime() + 5 * 24 * 60 * 60 * 1000);
}

function result(
  reason: SubscriptionAccessReason,
  options: {
    operable: boolean;
    billingRequired?: boolean;
    headline: string;
    detail: string;
    graceEndsAt?: Date | null;
  }
): SubscriptionAccess {
  return {
    reason,
    operable: options.operable,
    billingRequired: options.billingRequired ?? !options.operable,
    headline: options.headline,
    detail: options.detail,
    graceEndsAt: options.graceEndsAt ?? null,
  };
}

/**
 * Resolve the current package state for one authenticated tenant.
 *
 * Legacy businesses with no subscription rows at all remain grandfathered:
 * they keep operating without a package, as they did before billing existed.
 * A newly provisioned business is different — its tenant status is
 * PENDING_PAYMENT, and it must choose and pay for a package first.
 */
export async function resolveSubscriptionAccess(
  tenantId: string,
  now: Date = new Date()
): Promise<SubscriptionAccess> {
  const [tenant, subscriptions] = await Promise.all([
    db.businessTenant.findUnique({
      where: { id: tenantId },
      select: { status: true },
    }),
    db.zeliSubscription.findMany({
      where: { tenantId },
      orderBy: { createdAt: "desc" },
      select: {
        status: true,
        periodEnd: true,
        graceEndsAt: true,
        plan: { select: { name: true } },
      },
    }),
  ]);

  if (!tenant || (tenant.status !== "ACTIVE" && tenant.status !== "PENDING_PAYMENT")) {
    return result("tenant_unavailable", {
      operable: false,
      headline: "Business workspace unavailable",
      detail:
        "This business workspace is not open for operations. Contact your platform administrator.",
    });
  }

  const nowMs = now.getTime();
  const active = subscriptions.find(
    (subscription) =>
      ACTIVE.has(subscription.status) &&
      (!subscription.periodEnd || subscription.periodEnd.getTime() > nowMs)
  );
  if (active) {
    return result("active", {
      operable: true,
      headline: "Package active",
      detail: active.plan?.name
        ? `${active.plan.name} is active. Money operations are available.`
        : "Your package is active. Money operations are available.",
    });
  }

  const grace = subscriptions.find((subscription) => {
    const end = graceEndFor(subscription);
    if (!end || end.getTime() <= nowMs) return false;
    if (GRACE.has(subscription.status)) return true;
    return (
      ACTIVE.has(subscription.status) &&
      Boolean(subscription.periodEnd) &&
      subscription.periodEnd!.getTime() <= nowMs
    );
  });
  if (grace) {
    const end = graceEndFor(grace);
    return result("grace_period", {
      operable: true,
      headline: "Renewal grace period",
      detail:
        "Your paid period has ended but operations remain available during the renewal grace period. Complete renewal in Billing & Plan.",
      graceEndsAt: end,
    });
  }

  const pending = subscriptions.find((subscription) => PENDING.has(subscription.status));
  if (pending) {
    return result("pending_payment", {
      operable: false,
      headline: "Package payment outstanding",
      detail:
        "Your business has a package waiting for payment. Open Billing & Plan to complete it; your records remain safe.",
    });
  }

  const failed = subscriptions.find((subscription) => FAILED.has(subscription.status));
  if (failed) {
    return result(failed.status === "past_due" ? "past_due" : "failed", {
      operable: false,
      headline: "Package payment did not complete",
      detail:
        "The last package payment did not complete. Open Billing & Plan to retry it; your records remain safe.",
    });
  }

  const suspended = subscriptions.find((subscription) => SUSPENDED.has(subscription.status));
  if (suspended) {
    return result("suspended", {
      operable: false,
      headline: "Package suspended",
      detail:
        "This package is suspended. Review Billing & Plan or contact support; your records remain safe.",
    });
  }

  const cancelled = subscriptions.find((subscription) => CANCELLED.has(subscription.status));
  if (cancelled) {
    return result("cancelled", {
      operable: false,
      headline: "Package ended",
      detail:
        "This package has ended. Choose a package in Billing & Plan to resume money operations.",
    });
  }

  const refunded = subscriptions.find((subscription) => REFUNDED.has(subscription.status));
  if (refunded) {
    return result("refunded", {
      operable: false,
      headline: "Package payment refunded",
      detail:
        "The package payment was refunded, so money operations are paused. Choose a package in Billing & Plan to resume.",
    });
  }

  // An active business with historical rows but no currently usable package
  // has an ended package. A business with no rows at all is grandfathered.
  if (subscriptions.length > 0) {
    return result("expired", {
      operable: false,
      headline: "Package period ended",
      detail:
        "Your last package period has ended. Existing records remain safe; open Billing & Plan to renew.",
    });
  }

  if (tenant.status === "PENDING_PAYMENT") {
    return result("pending_payment", {
      operable: false,
      headline: "Choose a package",
      detail:
        "Your business is set up but has no package yet. Open Billing & Plan to choose one; your records remain safe.",
    });
  }

  return result("none", {
    operable: true,
    billingRequired: false,
    headline: "No package required",
    detail:
      "This business predates package billing and continues to operate without a package record.",
  });
}

/** Build the safe Billing & Plan destination for a blocked state. */
export function billingHref(reason: SubscriptionAccessReason): string {
  return `/admin/billing?payment=required&state=${encodeURIComponent(reason)}`;
}

/**
 * Who may use external AI investigation, and why.
 *
 * The owner approved external processing of real financial evidence for the
 * dedicated paid package only. That approval is not a switch on its own: a request
 * is allowed only when every one of these is true, checked from the database on the
 * request itself rather than from anything the browser sends or the app cached:
 *
 *   1. the deployment approval constant is present;
 *   2. the operator kill switch is off;
 *   3. the business is active;
 *   4. a paid AI Investigation package subscription exists, is active, has a
 *      provider-verified paid timestamp, and its period has not ended;
 *   5. a Super Admin activated the package for that business, and has not revoked it;
 *   6. the requesting role may use investigation;
 *   7. the monthly allowance has not been used up.
 *
 * Tenant administrators can read their own status. They cannot activate.
 */

import { db } from "@/lib/db";

/** The add-on key on `ZeliPlan`. One package, one key. */
export const AI_INVESTIGATION_ADDON = "ai_investigation";

/** Roles that may use the investigation feature at all. */
export const AI_INVESTIGATION_ROLES = ["admin"] as const;

/**
 * Owner approval for the narrow investigation path.
 *
 * This is deliberately separate from `PRODUCTION_PROVIDER_APPROVED` (broad
 * aggregate production processing) and from `PRODUCTION_CONVERSATION_APPROVED`
 * (general external conversation). Changing this constant cannot enable either of
 * those, and it cannot enable anything by itself: the per-tenant gates below are
 * still required.
 */
export const AI_INVESTIGATION_CODE_APPROVED = true;

/** A safety limit for a package that has no allowance configured yet. */
export const AI_INVESTIGATION_DEFAULT_MONTHLY_LIMIT = 50;

export type AiInvestigationDenial =
  | "approval_missing"
  | "operator_disabled"
  | "tenant_unavailable"
  | "role_not_permitted"
  | "no_package"
  | "payment_unconfirmed"
  | "payment_not_current"
  | "activation_missing"
  | "activation_revoked"
  | "activation_expired"
  | "quota_exceeded";

export type AiInvestigationState = "active" | "payment_pending" | "not_activated" | "denied";

export interface AiInvestigationAccess {
  allowed: boolean;
  reason: AiInvestigationDenial | null;
  /** Plain-language statement a tenant administrator can act on. */
  guidance: string;
  state: AiInvestigationState;
  planCode: string | null;
  planName: string | null;
  paymentConfirmed: boolean;
  paymentEndsAt: string | null;
  activationStatus: "active" | "revoked" | "none";
  activatedAt: string | null;
  expiresAt: string | null;
  allowance: number | null;
  used: number;
  remaining: number | null;
}

export interface AiInvestigationInputs {
  codeApproved: boolean;
  operatorDisabled: boolean;
  tenantStatus: string;
  role: string;
  plan: { code: string; name: string; addonKey: string | null; usageAllowance: number | null } | null;
  subscription: {
    status: string;
    paidAt: Date | null;
    periodEnd: Date | null;
    amountConfirmed: boolean;
  } | null;
  activation: { status: string; expiresAt: Date } | null;
  usage: { requests: number } | null;
  now?: Date;
}

function deny(
  reason: AiInvestigationDenial,
  guidance: string,
  partial: Partial<AiInvestigationAccess> = {}
): AiInvestigationAccess {
  return {
    allowed: false,
    reason,
    guidance,
    state: "denied",
    planCode: null,
    planName: null,
    paymentConfirmed: false,
    paymentEndsAt: null,
    activationStatus: "none",
    activatedAt: null,
    expiresAt: null,
    allowance: null,
    used: 0,
    remaining: null,
    ...partial,
  };
}

const ACTIVATION_GUIDANCE =
  "A Super Admin must activate the AI Investigation package for this business after the payment is confirmed.";

/**
 * Pure access decision, so every denial can be tested without a database.
 *
 * Order matters for the message a person sees: a missing package is a sales
 * problem, an unconfirmed payment is a billing problem, and a missing activation is
 * a platform problem. The first failing gate explains the situation.
 */
export function evaluateAiInvestigationAccess(
  input: AiInvestigationInputs
): AiInvestigationAccess {
  const now = input.now ?? new Date();
  // A package with no configured allowance still has a finite budget, so "unset"
  // can never become "unlimited".
  const allowance = input.plan?.usageAllowance ?? AI_INVESTIGATION_DEFAULT_MONTHLY_LIMIT;
  const used = input.usage?.requests ?? 0;
  const remaining = allowance === null ? null : Math.max(0, allowance - used);

  if (!input.codeApproved) {
    return deny(
      "approval_missing",
      "External AI investigation is not approved for this deployment."
    );
  }
  if (input.operatorDisabled) {
    return deny(
      "operator_disabled",
      "AI investigation is switched off for this deployment by the operator."
    );
  }
  if (input.tenantStatus !== "ACTIVE") {
    return deny("tenant_unavailable", "This business is not active.");
  }
  if (!(AI_INVESTIGATION_ROLES as readonly string[]).includes(input.role)) {
    return deny("role_not_permitted", "Your role cannot use AI investigation.");
  }
  if (!input.plan || input.plan.addonKey !== AI_INVESTIGATION_ADDON) {
    return deny(
      "no_package",
      "The AI Investigation package has not been purchased for this business."
    );
  }

  const plan = input.plan;
  const subscription = input.subscription;
  const base: Partial<AiInvestigationAccess> = {
    planCode: plan.code,
    planName: plan.name,
    allowance,
    used,
    remaining,
  };

  if (!subscription || !subscription.paidAt || !subscription.amountConfirmed) {
    return deny(
      "payment_unconfirmed",
      "Payment for the AI Investigation package has not been confirmed by the payment provider.",
      { ...base, state: "payment_pending", activationStatus: input.activation ? "active" : "none" }
    );
  }
  if (subscription.status !== "active") {
    return deny(
      "payment_not_current",
      `The AI Investigation package subscription is ${subscription.status.replace(/_/g, " ")}, so it is not current.`,
      { ...base, state: "payment_pending", paymentConfirmed: true }
    );
  }
  if (!subscription.periodEnd || subscription.periodEnd.getTime() <= now.getTime()) {
    return deny(
      "payment_not_current",
      "The paid period for the AI Investigation package has ended. Renew it to keep the feature.",
      {
        ...base,
        state: "payment_pending",
        paymentConfirmed: true,
        paymentEndsAt: subscription.periodEnd ? subscription.periodEnd.toISOString() : null,
      }
    );
  }

  const paymentFields: Partial<AiInvestigationAccess> = {
    ...base,
    paymentConfirmed: true,
    paymentEndsAt: subscription.periodEnd.toISOString(),
  };

  if (!input.activation) {
    return deny("activation_missing", ACTIVATION_GUIDANCE, {
      ...paymentFields,
      state: "not_activated",
      activationStatus: "none",
    });
  }
  if (input.activation.status !== "active") {
    return deny(
      "activation_revoked",
      "A Super Admin revoked the AI Investigation activation for this business.",
      { ...paymentFields, state: "not_activated", activationStatus: "revoked" }
    );
  }
  if (input.activation.expiresAt.getTime() <= now.getTime()) {
    return deny(
      "activation_expired",
      "The AI Investigation activation has expired. A Super Admin must activate it again.",
      {
        ...paymentFields,
        state: "not_activated",
        activationStatus: "active",
        expiresAt: input.activation.expiresAt.toISOString(),
      }
    );
  }
  if (remaining !== null && remaining <= 0) {
    return deny(
      "quota_exceeded",
      "This business has used its AI Investigation allowance for this month.",
      {
        ...paymentFields,
        state: "active",
        activationStatus: "active",
        expiresAt: input.activation.expiresAt.toISOString(),
      }
    );
  }

  return {
    allowed: true,
    reason: null,
    guidance: "The AI Investigation package is active for this business.",
    state: "active",
    planCode: plan.code,
    planName: plan.name,
    paymentConfirmed: true,
    paymentEndsAt: subscription.periodEnd.toISOString(),
    activationStatus: "active",
    activatedAt: null,
    expiresAt: input.activation.expiresAt.toISOString(),
    allowance,
    used,
    remaining,
  };
}

export function usagePeriod(now = new Date()): string {
  return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}`;
}

/**
 * Read the live state for one business.
 *
 * Nothing is cached and nothing is trusted from the caller: the plan, subscription,
 * activation and usage are read on this request. The Super Admin activation is the
 * row written by the platform action, and a revoked row denies immediately.
 */
export async function resolveAiInvestigationAccess(
  tenantId: string,
  role: string,
  options: { operatorDisabled: boolean }
): Promise<AiInvestigationAccess> {
  const now = new Date();
  const [tenant, subscription, activation, usage] = await Promise.all([
    db.businessTenant.findUnique({ where: { id: tenantId }, select: { status: true } }),
    db.zeliSubscription.findFirst({
      where: {
        tenantId,
        paidAt: { not: null },
        plan: { addonKey: AI_INVESTIGATION_ADDON },
      },
      orderBy: { paidAt: "desc" },
      include: { plan: true },
    }),
    db.aiInvestigationEntitlement.findUnique({ where: { tenantId } }),
    db.aiInvestigationUsage.findUnique({
      where: { tenantId_period: { tenantId, period: usagePeriod(now) } },
      select: { requests: true },
    }),
  ]);

  return evaluateAiInvestigationAccess({
    codeApproved: AI_INVESTIGATION_CODE_APPROVED,
    operatorDisabled: options.operatorDisabled,
    tenantStatus: tenant?.status ?? "UNKNOWN",
    role,
    plan: subscription
      ? {
          code: subscription.plan.code,
          name: subscription.plan.name,
          addonKey: subscription.plan.addonKey,
          usageAllowance: subscription.plan.usageAllowance,
        }
      : null,
    subscription: subscription
      ? {
          status: subscription.status,
          paidAt: subscription.paidAt,
          periodEnd: subscription.periodEnd,
          // `fulfilPaidSubscription` sets paidAt only after the provider amount,
          // currency and reference matched, so a paidAt row is confirmed.
          amountConfirmed: subscription.paidAt !== null,
        }
      : null,
    activation: activation
      ? { status: activation.status, expiresAt: activation.expiresAt }
      : null,
    usage,
    now,
  });
}

/**
 * Count one external generation against the monthly allowance.
 *
 * The counter is created at the allowance limit so a package with no configured
 * allowance still has a finite budget.
 */
export async function consumeAiInvestigationAllowance(
  tenantId: string,
  limit: number
): Promise<{ used: number; limit: number }> {
  const period = usagePeriod();
  const row = await db.aiInvestigationUsage.upsert({
    where: { tenantId_period: { tenantId, period } },
    create: { tenantId, period, requests: 1, limit },
    update: { requests: { increment: 1 }, limit },
    select: { requests: true, limit: true },
  });
  return { used: row.requests, limit: row.limit };
}

/**
 * Who may use external conversational AI, and why.
 *
 * The owner approved external conversation for **paid** MaaCash businesses. That
 * approval is a code constant, but it is not the entitlement: a business also has to
 * hold a paid, current subscription whose package includes Zeli, and it has to be
 * inside the monthly allowance that package carries.
 *
 * This is deliberately separate from `src/lib/zeli/investigation/entitlement.ts`:
 *
 *   * conversation is included in the ordinary paid packages and is metered by the
 *     package's monthly Zeli allowance;
 *   * investigation is a separately purchased add-on with its own activation.
 *
 * One must never grant the other. A business that buys only the investigation add-on
 * has no conversation entitlement, and a business on a paid package has no
 * investigation entitlement.
 *
 * A free business keeps the local, rules-based Zeli. It is only external processing
 * that is refused, and the refusal names the package requirement so an owner knows
 * what to do.
 */

import { db } from "@/lib/db";
import { ZELI_FALLBACK_MONTHLY_ALLOWANCE, usagePeriodKey } from "@/lib/zeli/usage";

/** Bumped when the entitlement rules below change. Recorded in diagnostics. */
export const CONVERSATION_ENTITLEMENT_VERSION = "2026-12-conv-ent.1";

export type ConversationDenial =
  | "no_subscription"
  | "addon_only"
  | "payment_pending"
  | "subscription_suspended"
  | "subscription_inactive"
  | "payment_unconfirmed"
  | "period_ended"
  | "not_included"
  | "quota_exhausted";

export type ConversationEntitlementState =
  | "active"
  | "payment_pending"
  | "lapsed"
  | "denied";

export interface ConversationEntitlement {
  allowed: boolean;
  reason: ConversationDenial | null;
  /** A sentence an owner can act on, never a bare code. */
  guidance: string;
  state: ConversationEntitlementState;
  planCode: string | null;
  planName: string | null;
  allowance: number | null;
  used: number;
  remaining: number | null;
  period: string;
  periodEnd: string | null;
}

export interface ConversationEntitlementInputs {
  subscription: {
    status: string;
    paidAt: Date | null;
    periodEnd: Date | null;
    plan: {
      code: string;
      name: string;
      zeliIncluded: boolean;
      usageAllowance: number | null;
      addonKey: string | null;
    } | null;
  } | null;
  usage: { requests: number } | null;
  now?: Date;
}

const PURCHASE_GUIDANCE =
  "Zeli conversations are included with a paid MaaCash package. Choose a package from Billing to use Zeli with an external assistant; the local assistant keeps working meanwhile.";

function deny(
  reason: ConversationDenial,
  guidance: string,
  state: ConversationEntitlementState,
  partial: Partial<ConversationEntitlement> = {}
): ConversationEntitlement {
  return {
    allowed: false,
    reason,
    guidance,
    state,
    planCode: null,
    planName: null,
    allowance: null,
    used: 0,
    remaining: null,
    period: usagePeriodKey(partial.periodEnd ? new Date(partial.periodEnd) : new Date()),
    periodEnd: null,
    ...partial,
  };
}

/**
 * Pure decision, so every refusal is testable without a database.
 *
 * Order matters for the message a person sees: no package is a sales problem, an
 * unpaid package is a billing problem, and an exhausted allowance is a usage problem.
 */
export function evaluateConversationEntitlement(
  input: ConversationEntitlementInputs
): ConversationEntitlement {
  const now = input.now ?? new Date();
  const period = usagePeriodKey(now);
  const subscription = input.subscription;

  if (!subscription || !subscription.plan) {
    return deny("no_subscription", PURCHASE_GUIDANCE, "denied", { period });
  }

  const plan = subscription.plan;
  const used = input.usage?.requests ?? 0;
  const allowance = plan.usageAllowance ?? ZELI_FALLBACK_MONTHLY_ALLOWANCE;
  const remaining = Math.max(0, allowance - used);
  const periodEnd = subscription.periodEnd ? subscription.periodEnd.toISOString() : null;
  const base: Partial<ConversationEntitlement> = {
    planCode: plan.code,
    planName: plan.name,
    allowance,
    used,
    remaining,
    period,
    periodEnd,
  };

  // A plan that exists only to sell the investigation add-on never includes
  // conversation, however its flags are set.
  if (plan.addonKey) {
    return deny(
      "addon_only",
      "This is an add-on package, not a MaaCash business package, so it does not include Zeli conversations.",
      "denied",
      { ...base, planCode: plan.code, planName: plan.name, allowance: null, remaining: null }
    );
  }

  if (subscription.status === "pending_payment" || subscription.status === "pending") {
    return deny(
      "payment_pending",
      "Complete your package payment to use Zeli conversations with an external assistant. Your data is safe and nothing was charged.",
      "payment_pending",
      base
    );
  }

  if (subscription.status === "suspended") {
    return deny(
      "subscription_suspended",
      "Zeli conversations are paused because the subscription is suspended. Renew from Billing to restore them.",
      "lapsed",
      base
    );
  }

  if (!["active", "grace_period", "past_due"].includes(subscription.status)) {
    return deny(
      "subscription_inactive",
      "Zeli conversations need an active package. Choose a package from Billing to continue.",
      "lapsed",
      base
    );
  }

  if (!subscription.paidAt) {
    return deny(
      "payment_unconfirmed",
      "The payment provider has not confirmed this package yet, so Zeli conversations stay off until it does.",
      "payment_pending",
      base
    );
  }

  if (subscription.periodEnd && subscription.periodEnd.getTime() <= now.getTime()) {
    return deny(
      "period_ended",
      "The paid period for this package has ended. Renew it to keep Zeli conversations.",
      "lapsed",
      base
    );
  }

  if (!plan.zeliIncluded) {
    return deny(
      "not_included",
      "This package does not include Zeli. Choose a package that includes it to use conversations.",
      "denied",
      base
    );
  }

  if (remaining <= 0) {
    return deny(
      "quota_exhausted",
      `This business has used all ${allowance} Zeli requests included this month. The allowance resets on the first day of next month.`,
      "active",
      base
    );
  }

  return {
    allowed: true,
    reason: null,
    guidance: `Zeli conversations are included with ${plan.name}: ${remaining} of ${allowance} requests left this month.`,
    state: "active",
    planCode: plan.code,
    planName: plan.name,
    allowance,
    used,
    remaining,
    period,
    periodEnd,
  };
}

/**
 * Read the live state for one business.
 *
 * Nothing is cached and nothing comes from the client: the subscription, its plan and
 * the usage counter are read on this request, so a cancelled, refunded or lapsed
 * package stops conversation on the next turn rather than at some later expiry.
 */
export async function resolveConversationEntitlement(
  tenantId: string | null | undefined,
  now: Date = new Date()
): Promise<ConversationEntitlement> {
  if (!tenantId) {
    return deny("no_subscription", PURCHASE_GUIDANCE, "denied", { period: usagePeriodKey(now) });
  }

  const [subscription, addonOnly, usage] = await Promise.all([
    db.zeliSubscription.findFirst({
      where: {
        tenantId,
        // An add-on purchase must not be mistaken for a business package.
        plan: { addonKey: null },
      },
      orderBy: [{ paidAt: "desc" }, { createdAt: "desc" }],
      select: {
        status: true,
        paidAt: true,
        periodEnd: true,
        plan: {
          select: {
            code: true,
            name: true,
            zeliIncluded: true,
            usageAllowance: true,
            addonKey: true,
          },
        },
      },
    }),
    db.zeliSubscription.findFirst({
      where: { tenantId, plan: { addonKey: { not: null } } },
      orderBy: { createdAt: "desc" },
      select: { id: true },
    }),
    db.zeliUsagePeriod.findUnique({
      where: { tenantId_period: { tenantId, period: usagePeriodKey(now) } },
      select: { requests: true },
    }),
  ]);

  // A business that has bought only the investigation add-on gets the precise
  // refusal, not the generic "no package" one.
  if (!subscription && addonOnly) {
    return deny(
      "addon_only",
      "This business has bought an add-on only. Add-ons do not include Zeli conversations; a paid MaaCash package is required.",
      "denied",
      { period: usagePeriodKey(now) }
    );
  }

  return evaluateConversationEntitlement({ subscription, usage, now });
}

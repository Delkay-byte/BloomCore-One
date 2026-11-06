import { db } from "@/lib/db";

/**
 * Zeli lifecycle expiry sweep.
 *
 * Two records can grant Zeli Analytics: a paid subscription (period) and an
 * entitlement (access window). The sweep closes lapsed records without
 * touching history: entitlement events are append-only, and repeated runs must
 * be safe.
 *
 * Every status change is a conditional `updateMany` on the state that was read.
 * A renewal that extends `periodEnd` / `expiresAt` between the read and the
 * write therefore wins: the condition no longer matches and zero rows change.
 * The sweep counts those lost races as `skipped` instead of forcing the write.
 */

export interface ZeliExpiryResult {
  /** Subscriptions moved to cancelled/expired in this run. */
  subscriptions: number;
  /** Entitlements moved to expired, with a history event, in this run. */
  entitlements: number;
  /** Candidates that another writer changed first. */
  skipped: number;
}

const ZELI_ANALYTICS_FEATURE = "zeli_analytics";

export async function expireZeliLifecycle(now: Date = new Date()): Promise<ZeliExpiryResult> {
  let subscriptions = 0;
  let entitlements = 0;
  let skipped = 0;

  // 1. Subscriptions whose paid period has ended.
  const dueSubscriptions = await db.zeliSubscription.findMany({
    where: { status: "active", periodEnd: { not: null, lte: now } },
    select: { id: true, cancelAtPeriodEnd: true },
  });

  for (const candidate of dueSubscriptions) {
    const updated = await db.zeliSubscription.updateMany({
      where: {
        id: candidate.id,
        status: "active",
        periodEnd: { lte: now },
      },
      data: {
        status: candidate.cancelAtPeriodEnd ? "cancelled" : "expired",
        // A lapsed subscription can never be pending, but a stale key would
        // block future checkouts and must not survive the sweep.
        pendingKey: null,
      },
    });
    if (updated.count === 1) {
      subscriptions += 1;
    } else {
      skipped += 1;
    }
  }

  // 2. Entitlements whose access window has ended. Manual entitlements without
  // an expiry date have `expiresAt = null` and are excluded by the filter.
  const dueEntitlements = await db.zeliEntitlement.findMany({
    where: { status: "active", expiresAt: { not: null, lte: now } },
    select: { id: true, tenantId: true, featureKey: true, expiresAt: true },
  });

  for (const candidate of dueEntitlements) {
    const expiresAt = candidate.expiresAt;
    if (!expiresAt) continue;
    const expiredAt = expiresAt.toISOString();

    // Status change and history event land together, and the event is written
    // only when this run actually performed the transition. That makes a
    // repeated sweep idempotent: it matches zero rows and appends nothing.
    const changed = await db.$transaction(async (tx) => {
      const updated = await tx.zeliEntitlement.updateMany({
        where: {
          id: candidate.id,
          status: "active",
          expiresAt: { lte: now },
        },
        data: {
          status: "expired",
          reason: `Access expired at ${expiredAt}`,
        },
      });
      if (updated.count !== 1) return false;

      await tx.zeliEntitlementEvent.create({
        data: {
          entitlementId: candidate.id,
          tenantId: candidate.tenantId,
          featureKey: candidate.featureKey || ZELI_ANALYTICS_FEATURE,
          action: "expired",
          previousStatus: "active",
          status: "expired",
          reason: `Entitlement expired at ${expiredAt}`,
          actorType: "system",
          expiresAt,
        },
      });
      return true;
    });

    if (changed) {
      entitlements += 1;
    } else {
      skipped += 1;
    }
  }

  return { subscriptions, entitlements, skipped };
}

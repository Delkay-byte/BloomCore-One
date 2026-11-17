import { db } from "@/lib/db";

/**
 * Package limits are enforced on the server for every create path. A tenant
 * without a subscription is grandfathered: MaaCash must never lock an existing
 * business out of records it already owns because a catalogue was introduced
 * later. Only a tenant with a live (active or grace) subscription is measured
 * against its plan.
 */
export type PackageLimitKind = "locations" | "staff";

export interface PackageLimitResult {
  allowed: boolean;
  limit: number | null;
  current: number;
  used: number;
  reason?: "limit_reached" | "subscription_suspended";
  message?: string;
}

export async function packageLimitFor(
  tenantId: string,
  kind: PackageLimitKind
): Promise<{ limit: number | null; current: number; suspended: boolean }> {
  const subscription = await db.zeliSubscription.findFirst({
    where: { tenantId, status: { in: ["active", "grace_period", "suspended"] } },
    orderBy: { createdAt: "desc" },
    select: {
      status: true,
      plan: { select: { locationLimit: true, staffLimit: true } },
    },
  });

  const [current, suspended] = await Promise.all([
    kind === "locations"
      ? db.location.count({ where: { tenantId, status: "active" } })
      : db.user.count({ where: { tenantId, role: "worker", status: "active" } }),
    Promise.resolve(subscription?.status === "suspended"),
  ]);

  if (!subscription?.plan) {
    return { limit: null, current, suspended };
  }
  return {
    limit: kind === "locations" ? subscription.plan.locationLimit : subscription.plan.staffLimit,
    current,
    suspended,
  };
}

export async function checkPackageLimit(
  tenantId: string,
  kind: PackageLimitKind
): Promise<PackageLimitResult> {
  const { limit, current, suspended } = await packageLimitFor(tenantId, kind);
  const noun = kind === "locations" ? "location" : "staff account";

  if (suspended) {
    return {
      allowed: false,
      limit,
      current,
      used: current,
      reason: "subscription_suspended",
      message: `This business is suspended. Renew the package to add a ${noun}.`,
    };
  }
  if (limit === null) {
    return { allowed: true, limit, current, used: current };
  }
  if (current >= limit) {
    return {
      allowed: false,
      limit,
      current,
      used: current,
      reason: "limit_reached",
      message: `Your package allows ${limit} active ${noun}${limit === 1 ? "" : "s"}. Upgrade the package to add another.`,
    };
  }
  return { allowed: true, limit, current, used: current };
}

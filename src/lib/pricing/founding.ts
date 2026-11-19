/**
 * Founding-customer allocation.
 *
 * The owner approved five founding businesses. Each receives the founding
 * monthly price for three consecutive paid monthly periods; the fourth
 * renewal returns to the standard price. Annual billing never combines with
 * the offer. Allocation is Platform Super Admin only, atomic (unique slot),
 * audited, and never resets through a package or account change.
 */

import { db } from "@/lib/db";
import type { Prisma } from "@prisma/client";

export const FOUNDING_MAX_BUSINESSES = 5;
export const FOUNDING_PERIODS = 3;

/**
 * Owner-approved internal policy. These values are never imported by a public
 * page or a client component; public pricing intentionally shows standard
 * prices only.
 */
export const FOUNDING_PROMOTION = {
  maxBusinesses: FOUNDING_MAX_BUSINESSES,
  discountedPeriods: FOUNDING_PERIODS,
  terms:
    "Founding price for the first three monthly periods only. Standard pricing applies from the fourth renewal. Limited to five eligible businesses.",
  annualEligible: false,
} as const;

/** Approved founding monthly prices, used by allocation/accounting checks. */
export const APPROVED_FOUNDING_PRICES = {
  starter: 79,
  business: 149,
  "multi-branch": 225,
} as const;

export interface FoundingPlanLike {
  id: string;
  code: string;
  billingInterval: string;
  price: Prisma.Decimal | number | string;
  foundingPrice: Prisma.Decimal | number | string | null;
}

export type FoundingAssignmentResult =
  | { ok: true; allocationId: string; slot: number }
  | { ok: false; reason: "not_eligible" | "already_allocated" | "capacity_reached" | "inactive" };

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { code?: string }).code === "P2002"
  );
}

/** Remaining discounted periods on an allocation. */
export function foundingRemaining(allocation: {
  periodsGranted: number;
  periodsUsed: number;
  status: string;
}): number {
  if (allocation.status !== "active") return 0;
  return Math.max(0, allocation.periodsGranted - allocation.periodsUsed);
}

/**
 * Assign the next free founding slot.
 *
 * Concurrency: the unique index on `slot` is the guarantee. Two simultaneous
 * assignments can compute the same slot, but only one insert succeeds; the
 * losers retry the next slot, and all five candidates see "capacity_reached"
 * once the slots are taken.
 */
export async function assignFoundingAllocation(input: {
  tenantId: string;
  plan: FoundingPlanLike;
  actorId: string;
  /** Reason is stored by the caller's platform audit entry. */
  client?: Prisma.TransactionClient | typeof db;
}): Promise<FoundingAssignmentResult> {
  const client = input.client ?? db;
  if (input.plan.billingInterval.toLowerCase() !== "month") return { ok: false, reason: "not_eligible" };
  if (input.plan.foundingPrice == null) return { ok: false, reason: "not_eligible" };

  const existing = await client.foundingAllocation.findUnique({ where: { tenantId: input.tenantId } });
  if (existing && existing.status !== "revoked") return { ok: false, reason: "already_allocated" };

  for (let slot = 1; slot <= FOUNDING_MAX_BUSINESSES; slot += 1) {
    const taken = await client.foundingAllocation.findUnique({ where: { slot } });
    if (taken) continue;
    try {
      const created = await client.foundingAllocation.upsert({
        where: { tenantId: input.tenantId },
        create: {
          tenantId: input.tenantId,
          planId: input.plan.id,
          slot,
          monthlyPrice: input.plan.foundingPrice,
          standardPrice: input.plan.price,
          periodsGranted: FOUNDING_PERIODS,
          periodsUsed: 0,
          status: "active",
          assignedById: input.actorId,
        },
        // A revoked allocation may be re-issued once, keeping its consumed
        // periods: the discount never restarts.
        update: {
          planId: input.plan.id,
          slot,
          monthlyPrice: input.plan.foundingPrice,
          standardPrice: input.plan.price,
          status: "active",
          assignedById: input.actorId,
          revokedAt: null,
          revokedById: null,
          revokeReason: null,
        },
      });
      return { ok: true, allocationId: created.id, slot: created.slot };
    } catch (error) {
      if (isUniqueViolation(error)) continue;
      throw error;
    }
  }
  return { ok: false, reason: "capacity_reached" };
}

export async function revokeFoundingAllocation(input: {
  tenantId: string;
  actorId: string;
  reason: string;
}): Promise<boolean> {
  const updated = await db.foundingAllocation.updateMany({
    where: { tenantId: input.tenantId, status: { in: ["active", "exhausted"] } },
    data: {
      status: "revoked",
      revokedAt: new Date(),
      revokedById: input.actorId,
      revokeReason: input.reason.slice(0, 300),
    },
  });
  return updated.count > 0;
}

/** Effective price for the next monthly period of this plan. */
export async function effectiveMonthlyPrice(input: {
  tenantId: string;
  plan: FoundingPlanLike;
}): Promise<{
  amount: Prisma.Decimal;
  source: "founding" | "standard";
  allocationId: string | null;
  remainingPeriods: number;
}> {
  const allocation = await db.foundingAllocation.findUnique({
    where: { tenantId: input.tenantId },
  });
  const eligible =
    input.plan.billingInterval.toLowerCase() === "month" &&
    allocation !== null &&
    allocation.status === "active" &&
    allocation.planId === input.plan.id &&
    foundingRemaining(allocation) > 0 &&
    allocation.monthlyPrice != null;

  if (eligible) {
    return {
      amount: allocation.monthlyPrice,
      source: "founding",
      allocationId: allocation.id,
      remainingPeriods: foundingRemaining(allocation),
    };
  }
  return {
    amount: allocation && allocation.planId === input.plan.id ? allocation.standardPrice : (input.plan.price as Prisma.Decimal),
    source: "standard",
    allocationId: null,
    remainingPeriods: allocation ? foundingRemaining(allocation) : 0,
  };
}

/**
 * Consume one discounted period after a verified monthly payment. Conditional
 * on `periodsUsed < periodsGranted`, so a duplicate webhook can never burn two.
 */
export async function consumeFoundingPeriod(
  tx: Prisma.TransactionClient,
  allocationId: string
): Promise<void> {
  const updated = await tx.foundingAllocation.updateMany({
    where: { id: allocationId, status: "active", periodsUsed: { lt: FOUNDING_PERIODS } },
    data: { periodsUsed: { increment: 1 } },
  });
  if (updated.count === 0) return;
  await tx.foundingAllocation.updateMany({
    where: { id: allocationId, periodsUsed: { gte: FOUNDING_PERIODS } },
    data: { status: "exhausted" },
  });
}

/**
 * Public availability of the founding programme.
 *
 * Every allocation row permanently occupies its unique slot, including an
 * exhausted or revoked one, because `assignFoundingAllocation` checks slot
 * occupancy before inserting. Counting rows (not only active rows) therefore
 * matches what the allocator will actually accept and keeps operator/backend
 * reporting truthful. It is never called by a public page.
 */
export async function foundingAvailability(): Promise<{
  capacity: number;
  allocated: number;
  remaining: number;
  available: boolean;
}> {
  const allocated = await db.foundingAllocation.count();
  const remaining = Math.max(0, FOUNDING_MAX_BUSINESSES - allocated);
  return {
    capacity: FOUNDING_MAX_BUSINESSES,
    allocated,
    remaining,
    available: remaining > 0,
  };
}

/** Slots for the platform dashboard. */
export async function foundingSlots() {
  const rows = await db.foundingAllocation.findMany({
    orderBy: { slot: "asc" },
    include: { tenant: { select: { id: true, code: true, name: true } }, plan: { select: { code: true, name: true } } },
  });
  return {
    capacity: FOUNDING_MAX_BUSINESSES,
    used: rows.length,
    remaining: Math.max(0, FOUNDING_MAX_BUSINESSES - rows.length),
    rows,
  };
}

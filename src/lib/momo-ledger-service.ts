/**
 * Database-facing helpers for the MoMo ledger.
 *
 * Kept separate from the server actions so the daily-account workflow and the
 * ledger screens share exactly one implementation of "what does this day add
 * up to" and "what opening position can be carried".
 */

import { db } from "./db";
import { resolveStoredDifference } from "./momo-reconciliation";
import {
  decideOpeningCarryForward,
  summariseLedger,
  type LedgerSummary,
  type OpeningCarryForward,
} from "./momo-ledger";

export interface PriorClosing {
  accountId: string;
  businessDate: Date;
  status: string;
  closingCash: number;
  closingMomoFloat: number;
  differenceStatus: "balanced" | "positive" | "shortage";
}

/** Most recent earlier account for a location, regardless of its state. */
export async function latestPriorDailyAccount(input: {
  tenantId: string;
  locationId: string;
  businessDate: Date;
  excludeAccountId?: string;
}): Promise<PriorClosing | null> {
  const prior = await db.dailyAccount.findFirst({
    where: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      businessDate: { lt: input.businessDate },
      ...(input.excludeAccountId ? { id: { not: input.excludeAccountId } } : {}),
    },
    orderBy: { businessDate: "desc" },
    select: {
      id: true,
      businessDate: true,
      status: true,
      closingCash: true,
      closingMomoFloat: true,
      calculatedDifference: true,
      differenceStatus: true,
      calculatedMomoVariance: true,
      calculatedCashVariance: true,
    },
  });
  if (!prior) return null;
  const difference = resolveStoredDifference(prior);
  return {
    accountId: prior.id,
    businessDate: prior.businessDate,
    status: prior.status,
    closingCash: Number(prior.closingCash),
    closingMomoFloat: Number(prior.closingMomoFloat),
    differenceStatus: difference.status,
  };
}

/**
 * The opening position a new day may carry.
 *
 * Only a reviewed, balanced previous close is carried. A submitted but
 * unreviewed day, or a reviewed day with an unresolved shortage/surplus, is
 * reported with an explicit reason so the worker knows an explanation is
 * required rather than silently inheriting an unapproved figure.
 */
export async function resolveOpeningCarryForward(input: {
  tenantId: string;
  locationId: string;
  businessDate: Date;
  excludeAccountId?: string;
}): Promise<OpeningCarryForward> {
  const prior = await latestPriorDailyAccount(input);
  if (!prior) return decideOpeningCarryForward(null, null);
  return decideOpeningCarryForward(
    {
      id: prior.accountId,
      businessDate: prior.businessDate,
      status: prior.status,
      closingCash: prior.closingCash,
      closingMomoFloat: prior.closingMomoFloat,
    },
    { status: prior.differenceStatus }
  );
}

/** Effective ledger rows and their derived totals for one daily account. */
export async function ledgerSummaryForAccount(
  dailyAccountId: string,
  tenantId: string
): Promise<LedgerSummary> {
  const rows = await db.momoTransaction.findMany({
    where: { dailyAccountId, tenantId },
    select: { type: true, amount: true, commissionAmount: true, status: true },
  });
  return summariseLedger(rows);
}

/** Effective totals for any set of ledger filters within one tenant. */
export async function ledgerSummaryForFilters(where: {
  tenantId: string;
  locationId?: string;
  workerId?: string;
  businessDate?: { gte?: Date; lte?: Date };
}): Promise<LedgerSummary> {
  const rows = await db.momoTransaction.findMany({
    where: {
      tenantId: where.tenantId,
      ...(where.locationId ? { locationId: where.locationId } : {}),
      ...(where.workerId ? { workerId: where.workerId } : {}),
      ...(where.businessDate ? { businessDate: where.businessDate } : {}),
    },
    select: { type: true, amount: true, commissionAmount: true, status: true },
  });
  return summariseLedger(rows);
}

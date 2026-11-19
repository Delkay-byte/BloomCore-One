/**
 * Database helpers for shifts and handovers.
 *
 * A shift opening may be carried only from an earlier shift that is fully
 * closed with no unresolved handover variance. A shift is never added into the
 * daily account's financial totals.
 */

import { db } from "./db";
import type { Prisma } from "@prisma/client";
import { decideShiftOpeningCarry, type ShiftOpeningCarry } from "./shifts";

type DbClient = typeof db | Prisma.TransactionClient;

export async function resolveShiftOpeningCarry(input: {
  client?: DbClient;
  tenantId: string;
  locationId: string;
  businessDate: Date;
  excludeShiftId?: string;
}): Promise<ShiftOpeningCarry> {
  const client = input.client ?? db;
  const prior = await client.shift.findFirst({
    where: {
      tenantId: input.tenantId,
      locationId: input.locationId,
      businessDate: input.businessDate,
      ...(input.excludeShiftId ? { id: { not: input.excludeShiftId } } : {}),
    },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      name: true,
      label: true,
      status: true,
      closingCash: true,
      closingMomoFloat: true,
      handovers: { select: { status: true } },
    },
  });
  if (!prior) return decideShiftOpeningCarry(null);

  const openVariance = prior.handovers.some(
    (handover) =>
      handover.status === "variance_open" || handover.status === "awaiting_receipt"
  );

  return decideShiftOpeningCarry({
    id: prior.id,
    label: prior.label ?? prior.name,
    status: prior.status,
    closingCash: prior.closingCash,
    closingMomoFloat: prior.closingMomoFloat,
    openVariance,
  });
}

export interface ShiftSummaryRow {
  id: string;
  reference: string;
  name: string;
  label: string;
  status: string;
  assignedUserId: string;
  assignedUserName: string | null;
  openingCash: number;
  openingMomoFloat: number;
  openingSource: string;
  closingCash: number | null;
  closingMomoFloat: number | null;
  handoverStatus: string | null;
  cashVariance: number | null;
  floatVariance: number | null;
  openedAt: string | null;
  closedAt: string | null;
}

export interface DailyAccountShiftAggregate {
  accountId: string;
  shiftCount: number;
  openShiftCount: number;
  awaitingHandoverCount: number;
  varianceCount: number;
  closedCount: number;
  totalCashVariance: number;
  totalFloatVariance: number;
  shifts: ShiftSummaryRow[];
  /** Shifts are snapshots; their balances are never summed into the close. */
  note: string;
}

/**
 * Aggregate the shifts attached to one daily account.
 *
 * Deliberately no sum of opening/closing cash or float: that would double count
 * money that the same daily account already reconciles. Only counts and
 * variance totals are aggregated.
 */
export async function shiftAggregateForDailyAccount(
  accountId: string,
  tenantId: string
): Promise<DailyAccountShiftAggregate> {
  const shifts = await db.shift.findMany({
    where: { dailyAccountId: accountId, tenantId },
    include: {
      handovers: { orderBy: { createdAt: "desc" }, take: 1 },
    },
    orderBy: { createdAt: "asc" },
  });

  const userIds = Array.from(new Set(shifts.map((shift) => shift.assignedUserId)));
  const users =
    userIds.length > 0
      ? await db.user.findMany({
          where: { tenantId, id: { in: userIds } },
          select: { id: true, fullName: true },
        })
      : [];
  const names = new Map(users.map((user) => [user.id, user.fullName]));

  const rows: ShiftSummaryRow[] = shifts.map((shift) => {
    const handover = shift.handovers[0] ?? null;
    return {
      id: shift.id,
      reference: shift.reference,
      name: shift.name,
      label: shift.label ?? shift.name,
      status: shift.status,
      assignedUserId: shift.assignedUserId,
      assignedUserName: names.get(shift.assignedUserId) ?? null,
      openingCash: Number(shift.openingCash),
      openingMomoFloat: Number(shift.openingMomoFloat),
      openingSource: shift.openingSource,
      closingCash: shift.closingCash === null ? null : Number(shift.closingCash),
      closingMomoFloat:
        shift.closingMomoFloat === null ? null : Number(shift.closingMomoFloat),
      handoverStatus: handover?.status ?? null,
      cashVariance:
        handover?.cashVariance === null || handover?.cashVariance === undefined
          ? null
          : Number(handover.cashVariance),
      floatVariance:
        handover?.floatVariance === null || handover?.floatVariance === undefined
          ? null
          : Number(handover.floatVariance),
      openedAt: shift.openedAt?.toISOString() ?? null,
      closedAt: shift.closedAt?.toISOString() ?? null,
    };
  });

  return {
    accountId,
    shiftCount: rows.length,
    openShiftCount: rows.filter((row) => row.status === "open").length,
    awaitingHandoverCount: rows.filter((row) => row.status === "awaiting_handover").length,
    varianceCount: rows.filter((row) => row.status === "variance_open").length,
    closedCount: rows.filter((row) => row.status === "closed").length,
    totalCashVariance: rows.reduce((sum, row) => sum + (row.cashVariance ?? 0), 0),
    totalFloatVariance: rows.reduce((sum, row) => sum + (row.floatVariance ?? 0), 0),
    shifts: rows,
    note:
      "Shift records are accountability snapshots. Their balances are shown for employee accountability and are never added into the daily account totals.",
  };
}

"use server";

import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import {
  buildPerformanceReport,
  comparePerformance,
  previousPerformancePeriod,
  resolvePerformancePeriod,
  type PerformanceAccountRow,
  type PerformanceDelta,
  type PerformanceLedgerRow,
  type PerformanceReport,
  type PerformanceShiftRow,
  type PerformanceTransferRow,
} from "@/lib/performance-report";

export interface PerformanceReportResponse {
  current: PerformanceReport;
  previous: PerformanceReport;
  comparison: PerformanceDelta[];
  locations: Array<{ id: string; name: string }>;
}

function dayKey(value: Date | string): string {
  return new Date(value).toISOString().slice(0, 10);
}

function inRange(value: Date | string, from: string, to: string): boolean {
  const day = dayKey(value);
  return day >= from && day <= to;
}

/**
 * Management performance for the authenticated business only.
 *
 * Financial totals come from submitted/reviewed daily accounts. Ledger,
 * transfers and shifts contribute operating counts and risk flags, never a
 * second revenue total.
 */
export async function getPerformanceReport(filters?: {
  from?: string;
  to?: string;
  locationId?: string;
}): Promise<PerformanceReportResponse> {
  const ctx = await requireTenantAdminMomo();
  const period = resolvePerformancePeriod(filters?.from, filters?.to);
  const previousPeriod = previousPerformancePeriod(period);
  const rangeStart = previousPeriod.from;
  const rangeEnd = period.to;

  const locationWhere = {
    tenantId: ctx.tenantId,
    status: "active",
    ...(filters?.locationId ? { id: filters.locationId } : {}),
  };

  const [locations, accounts, ledger, transfers, shifts] = await Promise.all([
    db.location.findMany({
      where: locationWhere,
      select: { id: true, name: true },
      orderBy: { name: "asc" },
    }),
    db.dailyAccount.findMany({
      where: {
        tenantId: ctx.tenantId,
        businessDate: {
          gte: new Date(`${rangeStart}T00:00:00.000Z`),
          lte: new Date(`${rangeEnd}T23:59:59.999Z`),
        },
        ...(filters?.locationId ? { locationId: filters.locationId } : {}),
      },
      select: {
        id: true,
        businessDate: true,
        locationId: true,
        status: true,
        ledgerMode: true,
        commission: true,
        otherIncome: true,
        debtsCollected: true,
        totalExpenses: true,
        totalCashIn: true,
        totalCashOut: true,
        totalAirtimeSold: true,
        calculatedDifference: true,
      },
    }),
    db.momoTransaction.findMany({
      where: {
        tenantId: ctx.tenantId,
        businessDate: {
          gte: new Date(`${rangeStart}T00:00:00.000Z`),
          lte: new Date(`${rangeEnd}T23:59:59.999Z`),
        },
        ...(filters?.locationId ? { locationId: filters.locationId } : {}),
      },
      select: {
        id: true,
        type: true,
        status: true,
        businessDate: true,
        locationId: true,
        dailyAccountId: true,
      },
    }),
    db.branchTransfer.findMany({
      where: {
        tenantId: ctx.tenantId,
        createdAt: {
          gte: new Date(`${rangeStart}T00:00:00.000Z`),
          lte: new Date(`${rangeEnd}T23:59:59.999Z`),
        },
        ...(filters?.locationId
          ? {
              OR: [
                { sourceLocationId: filters.locationId },
                { destinationLocationId: filters.locationId },
              ],
            }
          : {}),
      },
      select: {
        id: true,
        status: true,
        amount: true,
        createdAt: true,
        sourceLocationId: true,
      },
    }),
    db.shift.findMany({
      where: {
        tenantId: ctx.tenantId,
        businessDate: {
          gte: new Date(`${rangeStart}T00:00:00.000Z`),
          lte: new Date(`${rangeEnd}T23:59:59.999Z`),
        },
        ...(filters?.locationId ? { locationId: filters.locationId } : {}),
      },
      select: {
        id: true,
        businessDate: true,
        locationId: true,
        handovers: { select: { cashVariance: true, floatVariance: true } },
      },
    }),
  ]);

  const accountRows: PerformanceAccountRow[] = accounts;
  const ledgerRows: PerformanceLedgerRow[] = ledger;
  const transferRows: PerformanceTransferRow[] = transfers;
  const shiftRows: PerformanceShiftRow[] = shifts.map((shift) => ({
    id: shift.id,
    status: "recorded",
    businessDate: shift.businessDate,
    locationId: shift.locationId,
    cashVariance: shift.handovers.reduce(
      (sum, row) => sum + Number(row.cashVariance ?? 0),
      0
    ),
    floatVariance: shift.handovers.reduce(
      (sum, row) => sum + Number(row.floatVariance ?? 0),
      0
    ),
  }));

  const current = buildPerformanceReport({
    ...period,
    locations,
    accounts: accountRows.filter((row) => inRange(row.businessDate, period.from, period.to)),
    ledger: ledgerRows.filter((row) => inRange(row.businessDate, period.from, period.to)),
    transfers: transferRows.filter((row) =>
      inRange(row.createdAt, period.from, period.to)
    ),
    shifts: shiftRows.filter((row) => inRange(row.businessDate, period.from, period.to)),
  });

  const previous = buildPerformanceReport({
    ...previousPeriod,
    locations,
    accounts: accountRows.filter((row) =>
      inRange(row.businessDate, previousPeriod.from, previousPeriod.to)
    ),
    ledger: ledgerRows.filter((row) =>
      inRange(row.businessDate, previousPeriod.from, previousPeriod.to)
    ),
    transfers: transferRows.filter((row) =>
      inRange(row.createdAt, previousPeriod.from, previousPeriod.to)
    ),
    shifts: shiftRows.filter((row) =>
      inRange(row.businessDate, previousPeriod.from, previousPeriod.to)
    ),
  });

  return {
    current,
    previous,
    comparison: comparePerformance(current, previous),
    locations,
  };
}

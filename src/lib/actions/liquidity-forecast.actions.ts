"use server";

import { z } from "zod";
import { db } from "@/lib/db";
import { requireTenantAdminMomo } from "@/lib/tenant";
import {
  MAX_HISTORY_DAYS,
  forecastBranchLiquidity,
  nextForecastDate,
  type DailyLiquidityPoint,
  type LiquidityForecast,
} from "@/lib/liquidity-forecast";

/**
 * Forecast a branch's float need from its own recorded days.
 *
 * Read-only by design: the action reads, the pure module forecasts, and the result is a
 * suggestion. There is no code path here that creates a transfer, a request or a
 * reservation, which is why the module's `autoTransfer` can be a literal false rather
 * than a promise.
 */

const inputSchema = z.object({
  locationId: z.string().min(1).max(64),
  targetDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
  serviceLevel: z.number().min(0.5).max(0.99).optional(),
});

export interface BranchForecastResult {
  locationId: string;
  locationName: string;
  forecast: LiquidityForecast;
  /** Days of history found for this branch. */
  historyDays: number;
  /** True when the branch has no recorded days yet. */
  empty: boolean;
}

export async function getBranchLiquidityForecast(
  input: unknown
): Promise<{ success: true; data: BranchForecastResult } | { success: false; error: string }> {
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) return { success: false, error: "Invalid forecast request." };

  const ctx = await requireTenantAdminMomo();
  const { locationId, serviceLevel } = parsed.data;

  const location = await db.location.findFirst({
    where: { id: locationId, tenantId: ctx.tenantId },
    select: { id: true, name: true },
  });
  if (!location) return { success: false, error: "Branch not found." };

  const since = new Date();
  since.setUTCDate(since.getUTCDate() - MAX_HISTORY_DAYS);

  const transactions = await db.momoTransaction.findMany({
    where: {
      tenantId: ctx.tenantId,
      locationId,
      businessDate: { gte: since },
      status: { not: "reversed" },
    },
    select: { businessDate: true, type: true, direction: true, amount: true },
  });

  // One point per business day. Float paid out to customers is cash out; float taken
  // back in is cash in. Everything else (commission, airtime, expenses) does not move
  // the float the branch has to hold.
  const perDay = new Map<string, DailyLiquidityPoint>();
  for (const row of transactions) {
    const businessDate = row.businessDate.toISOString().slice(0, 10);
    const point =
      perDay.get(businessDate) ??
      ({ businessDate, outflowMinor: 0, inflowMinor: 0 } satisfies DailyLiquidityPoint);
    const amountMinor = Math.round(Number(row.amount) * 100);
    if (!Number.isFinite(amountMinor) || amountMinor < 0) continue;
    if (row.type === "cash_out") point.outflowMinor += amountMinor;
    else if (row.type === "cash_in") point.inflowMinor += amountMinor;
    else continue;
    perDay.set(businessDate, point);
  }

  const points = [...perDay.values()];
  const todayIso = new Date().toISOString().slice(0, 10);
  const targetDate = parsed.data.targetDate ?? nextForecastDate(points, todayIso);

  const forecast = forecastBranchLiquidity(points, targetDate, { serviceLevel });

  return {
    success: true,
    data: {
      locationId: location.id,
      locationName: location.name,
      forecast,
      historyDays: points.length,
      empty: points.length === 0,
    },
  };
}

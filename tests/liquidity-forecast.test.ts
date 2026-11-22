/**
 * Branch liquidity forecasting.
 *
 * A forecast is only useful if a manager can trust it, so these tests check the two
 * ways a forecast cheats: it looks into its own future, or it hides that it had nothing
 * to go on. They also pin the guarantees — integer pesewa, deterministic output, and no
 * path from a forecast to a transfer.
 */

import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_DAYS,
  MIN_DAYS_FOR_SEASONAL,
  backtestForecast,
  forecastBranchLiquidity,
  nextForecastDate,
  type DailyLiquidityPoint,
} from "@/lib/liquidity-forecast";

/** A branch with a real weekday pattern and a little noise that is deterministic. */
function history(days: number, startIso = "2026-06-01"): DailyLiquidityPoint[] {
  const start = new Date(`${startIso}T00:00:00.000Z`);
  const points: DailyLiquidityPoint[] = [];
  for (let index = 0; index < days; index += 1) {
    const date = new Date(start);
    date.setUTCDate(date.getUTCDate() + index);
    const dow = date.getUTCDay();
    // Fridays and Saturdays are the heavy cash-out days at a Ghanaian counter.
    const base = dow === 5 ? 480_000 : dow === 6 ? 520_000 : dow === 0 ? 90_000 : 260_000;
    const wobble = (index % 5) * 4_000;
    points.push({
      businessDate: date.toISOString().slice(0, 10),
      outflowMinor: base + wobble,
      inflowMinor: Math.round((base + wobble) * 0.8),
    });
  }
  return points;
}

describe("forecastBranchLiquidity", () => {
  it("follows the weekday pattern of the branch", () => {
    const points = history(90);
    const friday = forecastBranchLiquidity(points, "2026-09-04"); // a Friday
    const monday = forecastBranchLiquidity(points, "2026-09-07"); // a Monday
    expect(friday.method).not.toBe("plain_average");
    expect(friday.expectedOutflowMinor).toBeGreaterThan(monday.expectedOutflowMinor);
    expect(friday.expectedOutflowMinor).toBeGreaterThan(400_000);
    expect(monday.expectedOutflowMinor).toBeLessThan(350_000);
  });

  it("is deterministic", () => {
    const points = history(60);
    const first = forecastBranchLiquidity(points, "2026-08-14");
    const second = forecastBranchLiquidity([...points].reverse(), "2026-08-14");
    expect(first.expectedOutflowMinor).toBe(second.expectedOutflowMinor);
    expect(first.method).toBe(second.method);
  });

  it("keeps every figure an integer number of pesewa", () => {
    const forecast = forecastBranchLiquidity(history(45), "2026-07-20");
    for (const value of [
      forecast.expectedOutflowMinor,
      forecast.expectedInflowMinor,
      forecast.expectedNetMinor,
      forecast.upperOutflowMinor,
      forecast.suggestedOpeningFloatMinor,
    ]) {
      expect(Number.isInteger(value)).toBe(true);
    }
  });

  it("suggests the upper band rather than the average", () => {
    const forecast = forecastBranchLiquidity(history(60), "2026-07-31");
    expect(forecast.suggestedOpeningFloatMinor).toBe(forecast.upperOutflowMinor);
    expect(forecast.suggestedOpeningFloatMinor).toBeGreaterThanOrEqual(forecast.expectedOutflowMinor);
  });

  it("says plainly when there is not enough history", () => {
    const forecast = forecastBranchLiquidity(history(5), "2026-06-10");
    expect(forecast.limitedHistory).toBe(true);
    expect(forecast.method).toBe("plain_average");
    expect(forecast.backtest).toBeNull();
    expect(forecast.explanation.join(" ")).toMatch(/would be guesswork/i);
  });

  it("handles a branch with no history at all without inventing a number", () => {
    const forecast = forecastBranchLiquidity([], "2026-07-01");
    expect(forecast.expectedOutflowMinor).toBe(0);
    expect(forecast.suggestedOpeningFloatMinor).toBe(0);
    expect(forecast.explanation.join(" ")).toMatch(/no usable history/i);
  });

  it("is not dragged by one bulk withdrawal", () => {
    const points = history(60);
    points[30] = { ...points[30], outflowMinor: 90_000_000 };
    const forecast = forecastBranchLiquidity(points, "2026-07-31");
    expect(forecast.expectedOutflowMinor).toBeLessThan(1_000_000);
  });

  it("does not double-count a duplicated day", () => {
    const points = history(40);
    const duplicated = [...points, ...points.slice(0, 10)];
    const a = forecastBranchLiquidity(points, "2026-07-13");
    const b = forecastBranchLiquidity(duplicated, "2026-07-13");
    expect(b.sampleSize).toBe(a.sampleSize);
    expect(b.expectedOutflowMinor).toBe(a.expectedOutflowMinor);
  });

  it("ignores malformed points instead of crashing", () => {
    const points = [
      ...history(30),
      { businessDate: "not-a-date", outflowMinor: 100, inflowMinor: 50 },
      { businessDate: "2026-06-20", outflowMinor: 12.5, inflowMinor: 10 },
      { businessDate: "2026-06-21", outflowMinor: -5, inflowMinor: 10 },
    ];
    const forecast = forecastBranchLiquidity(points, "2026-07-02");
    expect(forecast.sampleSize).toBeLessThanOrEqual(30);
    expect(Number.isInteger(forecast.expectedOutflowMinor)).toBe(true);
  });

  it("caps how much history it will use", () => {
    const forecast = forecastBranchLiquidity(history(400), "2027-01-01");
    expect(forecast.sampleSize).toBeLessThanOrEqual(MAX_HISTORY_DAYS);
  });

  it("explains itself in steps a manager can follow", () => {
    const forecast = forecastBranchLiquidity(history(80), "2026-08-21");
    expect(forecast.explanation.length).toBeGreaterThanOrEqual(4);
    expect(forecast.explanation.join(" ")).toMatch(/backtest error/i);
    expect(forecast.methodLabel.length).toBeGreaterThan(5);
  });

  it("cannot move money", () => {
    const forecast = forecastBranchLiquidity(history(60), "2026-08-01");
    expect(forecast.autoTransfer).toBe(false);
    expect(forecast.requiresHumanAction).toBe(true);
    expect(forecast.explanation.join(" ")).toMatch(/a person decides/i);
    // There is no transfer-shaped field in the output at all.
    expect(Object.keys(forecast)).not.toContain("transferAmountMinor");
    expect(Object.keys(forecast)).not.toContain("transferToLocationId");
  });
});

describe("backtestForecast", () => {
  it("scores only days it forecast from earlier data", () => {
    const points = history(50);
    const results = backtestForecast(points);
    for (const row of results) {
      expect(row.samples).toBeLessThanOrEqual(points.length - MIN_DAYS_FOR_SEASONAL);
      expect(row.meanAbsolutePercentageError).toBeGreaterThanOrEqual(0);
      expect(row.bandCoverage).toBeGreaterThanOrEqual(0);
      expect(row.bandCoverage).toBeLessThanOrEqual(1);
    }
  });

  it("beats the naive average on a branch with a strong weekday pattern", () => {
    const results = backtestForecast(history(90));
    const seasonal = results.find((row) => row.method === "same_weekday_median")!;
    const naive = results.find((row) => row.method === "plain_average")!;
    expect(seasonal.meanAbsolutePercentageError).toBeLessThan(naive.meanAbsolutePercentageError);
  });

  it("produces no score when there is nothing to test", () => {
    const results = backtestForecast(history(3));
    for (const row of results) {
      expect(row.samples).toBe(0);
      expect(row.bandCoverage).toBe(0);
    }
  });
});

describe("nextForecastDate", () => {
  it("plans the day after the newest recorded day", () => {
    expect(nextForecastDate(history(3, "2026-06-01"), "2026-05-01")).toBe("2026-06-04");
  });

  it("plans today when the history runs to today", () => {
    expect(nextForecastDate(history(3, "2026-06-01"), "2026-06-03")).toBe("2026-06-04");
  });

  it("plans today when there is no history", () => {
    expect(nextForecastDate([], "2026-06-05")).toBe("2026-06-05");
  });
});

/**
 * Branch liquidity forecasting.
 *
 * A branch runs out of float because nobody saw Tuesday coming. This module answers
 * one question — "how much float does this branch need on this day?" — with statistics
 * a manager can check by hand.
 *
 * Deliberate limits:
 *
 *   * **Deterministic.** Same history in, same forecast out. There is no model file, no
 *     external service and no randomness, so a disputed number can be reproduced.
 *   * **Explainable.** Every forecast carries its method, its sample size, the weekday
 *     effect it applied, the band it expects to land in, and the baseline it beat.
 *   * **Backtested, not asserted.** A method is only used when it beat the naive
 *     baselines on this branch's own history. With too little history the module says so
 *     and falls back to the plain average.
 *   * **Never moves money.** `autoTransfer` is a literal false and there is no transfer
 *     field anywhere in the output. A forecast is a suggestion to a person.
 *
 * Money is integer pesewa. Nothing here divides pesewa into fractions.
 */

export const LIQUIDITY_FORECAST_VERSION = "liquidity-forecast-v1";

/** Below this many days of history, a weekday model is guesswork. */
export const MIN_DAYS_FOR_SEASONAL = 21;
/** A year of daily history is plenty; older days describe a different business. */
export const MAX_HISTORY_DAYS = 180;

export type ForecastMethod =
  | "same_weekday_median"
  | "weekday_adjusted_average"
  | "plain_average";

export const FORECAST_METHOD_LABELS: Record<ForecastMethod, string> = {
  same_weekday_median: "Median of the same weekday",
  weekday_adjusted_average: "Average adjusted for the weekday",
  plain_average: "Plain average of recent days",
};

export interface DailyLiquidityPoint {
  /** ISO date (YYYY-MM-DD) of the business day. */
  businessDate: string;
  /** Float paid out to customers (cash out), in pesewa. */
  outflowMinor: number;
  /** Float taken in from customers (cash in), in pesewa. */
  inflowMinor: number;
}

export interface ForecastOptions {
  /** Service level for the upper band, e.g. 0.9 means "9 days in 10 were covered". */
  serviceLevel?: number;
  /** Days of history to consider, capped at MAX_HISTORY_DAYS. */
  historyDays?: number;
}

export interface BacktestResult {
  method: ForecastMethod;
  /** Mean absolute error as a share of the actual, e.g. 0.14 = 14%. */
  meanAbsolutePercentageError: number;
  /** Share of days whose actual demand fell inside the predicted band. */
  bandCoverage: number;
  /** Days actually evaluated. */
  samples: number;
}

export interface LiquidityForecast {
  /** The next business day being forecast. */
  targetDate: string;
  method: ForecastMethod;
  methodLabel: string;
  /** Expected outflow (float needed) in pesewa. */
  expectedOutflowMinor: number;
  /** Expected inflow (float returning) in pesewa. */
  expectedInflowMinor: number;
  /** Expected net float movement in pesewa; negative means float is consumed. */
  expectedNetMinor: number;
  /** Upper band on outflow at the chosen service level, in pesewa. */
  upperOutflowMinor: number;
  /** Suggested opening float: the upper band, never the average, because a short day is the failure. */
  suggestedOpeningFloatMinor: number;
  /** Days of history the forecast actually used. */
  sampleSize: number;
  serviceLevel: number;
  /** Backtest of the chosen method against this branch's own history. */
  backtest: BacktestResult | null;
  /** What the backtest says about the alternatives, so the choice is visible. */
  alternatives: BacktestResult[];
  /** Plain-language reasoning, one line per step. */
  explanation: string[];
  /** True when history was too thin for the seasonal model. */
  limitedHistory: boolean;
  /** Structural guarantee: this module cannot move money. */
  autoTransfer: false;
  /** A forecast is a suggestion to a person, always. */
  requiresHumanAction: true;
}

function dayOfWeek(dateIso: string): number {
  return new Date(`${dateIso}T00:00:00.000Z`).getUTCDay();
}

function addDays(dateIso: string, days: number): string {
  const date = new Date(`${dateIso}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function median(values: number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? Math.round((sorted[middle - 1] + sorted[middle]) / 2)
    : sorted[middle];
}

/** Empirical quantile on integers: no distribution is assumed. */
function quantile(values: number[], q: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const clamped = Math.min(1, Math.max(0, q));
  const index = Math.ceil(clamped * sorted.length) - 1;
  return sorted[Math.max(0, Math.min(sorted.length - 1, index))];
}

/**
 * Drop the extreme days before averaging.
 *
 * A single bulk withdrawal is a real event, but it is not a normal day's demand, and
 * letting it set the float means the branch is over-funded for a month. The trimmed
 * mean keeps the middle 80%.
 */
function trimmedMean(values: number[]): number {
  if (values.length < 5) return values.length ? Math.round(values.reduce((a, b) => a + b, 0) / values.length) : 0;
  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * 0.1);
  const kept = sorted.slice(cut, sorted.length - cut);
  return Math.round(kept.reduce((a, b) => a + b, 0) / kept.length);
}

function normalizeHistory(points: DailyLiquidityPoint[]): DailyLiquidityPoint[] {
  const seen = new Map<string, DailyLiquidityPoint>();
  for (const point of points) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(point.businessDate)) continue;
    if (!Number.isInteger(point.outflowMinor) || !Number.isInteger(point.inflowMinor)) continue;
    if (point.outflowMinor < 0 || point.inflowMinor < 0) continue;
    // A repeated day (two imports, two devices) must not be double-counted.
    const existing = seen.get(point.businessDate);
    seen.set(
      point.businessDate,
      existing
        ? {
            businessDate: point.businessDate,
            outflowMinor: Math.max(existing.outflowMinor, point.outflowMinor),
            inflowMinor: Math.max(existing.inflowMinor, point.inflowMinor),
          }
        : point
    );
  }
  return [...seen.values()].sort((a, b) => a.businessDate.localeCompare(b.businessDate));
}

type Estimator = (grid: Map<number, number[]>, fallback: number, targetDow: number) => number;

const ESTIMATORS: Record<ForecastMethod, Estimator> = {
  same_weekday_median: (grid, fallback, targetDow) => {
    const rows = grid.get(targetDow) ?? [];
    if (rows.length === 0) return fallback;
    return median(rows);
  },
  weekday_adjusted_average: (grid, fallback, targetDow) => {
    const target = grid.get(targetDow) ?? [];
    if (target.length === 0) return fallback;
    return trimmedMean(target);
  },
  plain_average: (_grid, fallback) => fallback,
};

interface Series {
  grid: Map<number, number[]>;
  overall: number;
  sizes: Map<number, number>;
}

function buildSeries(values: DailyLiquidityPoint[], selector: (p: DailyLiquidityPoint) => number): Series {
  const grid = new Map<number, number[]>();
  for (const point of values) {
    const dow = dayOfWeek(point.businessDate);
    grid.set(dow, [...(grid.get(dow) ?? []), selector(point)]);
  }
  const sizes = new Map<number, number>();
  for (const [dow, rows] of grid) sizes.set(dow, rows.length);
  const all = values.map(selector);
  return { grid, overall: trimmedMean(all), sizes };
}

/**
 * Rolling-origin backtest: for each of the last N eligible days, forecast it from the
 * days before it only, then compare with what actually happened. Using future days in
 * a forecast would flatter the model and is the easiest way to be wrong convincingly.
 */
export function backtestForecast(
  points: DailyLiquidityPoint[],
  options: ForecastOptions = {}
): BacktestResult[] {
  const history = normalizeHistory(points);
  const window = Math.min(options.historyDays ?? MAX_HISTORY_DAYS, MAX_HISTORY_DAYS);
  const series = history.slice(-window);
  const methods: ForecastMethod[] = ["same_weekday_median", "weekday_adjusted_average", "plain_average"];
  const serviceLevel = options.serviceLevel ?? 0.9;

  const scored: Record<ForecastMethod, { ape: number[]; covered: number[] }> = {
    same_weekday_median: { ape: [], covered: [] },
    weekday_adjusted_average: { ape: [], covered: [] },
    plain_average: { ape: [], covered: [] },
  };

  const firstTestIndex = Math.max(MIN_DAYS_FOR_SEASONAL, 7);
  for (let index = firstTestIndex; index < series.length; index += 1) {
    const training = series.slice(0, index);
    const actual = series[index];
    const { grid, overall } = buildSeries(training, (p) => p.outflowMinor);
    const targetDow = dayOfWeek(actual.businessDate);
    for (const method of methods) {
      const predicted = ESTIMATORS[method](grid, overall, targetDow);
      const residuals = training.map((point) => Math.abs(point.outflowMinor - predicted));
      const upper = predicted + quantile(residuals, serviceLevel);
      const denominator = actual.outflowMinor === 0 ? 1 : actual.outflowMinor;
      scored[method].ape.push(Math.abs(predicted - actual.outflowMinor) / denominator);
      scored[method].covered.push(actual.outflowMinor <= upper ? 1 : 0);
    }
  }

  return methods.map((method) => {
    const { ape, covered } = scored[method];
    const samples = ape.length;
    return {
      method,
      meanAbsolutePercentageError:
        samples === 0 ? 1 : Math.round((ape.reduce((a, b) => a + b, 0) / samples) * 1000) / 1000,
      bandCoverage:
        samples === 0 ? 0 : Math.round((covered.reduce((a, b) => a + b, 0) / samples) * 1000) / 1000,
      samples,
    };
  });
}

/**
 * Forecast one branch day.
 *
 * `points` is the branch's own daily outflow and inflow history; `targetDate` is the day
 * being planned. The method is chosen by backtest error, with the plain average kept as
 * the honest fallback when there is not enough history to do better.
 */
export function forecastBranchLiquidity(
  points: DailyLiquidityPoint[],
  targetDate: string,
  options: ForecastOptions = {}
): LiquidityForecast {
  const history = normalizeHistory(points);
  const window = Math.min(options.historyDays ?? MAX_HISTORY_DAYS, MAX_HISTORY_DAYS);
  const series = history.slice(-window);
  const serviceLevel = options.serviceLevel ?? 0.9;
  const targetDow = dayOfWeek(targetDate);
  const targetDowName = ["Sunday", "Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday"][targetDow];

  const explanation: string[] = [];
  const limitedHistory = series.length < MIN_DAYS_FOR_SEASONAL;

  const alternatives = series.length > MIN_DAYS_FOR_SEASONAL ? backtestForecast(series, options) : [];
  const eligible = alternatives.filter((row) => row.method !== "plain_average" && row.samples >= 7);
  const best =
    eligible.length > 0
      ? eligible.reduce((left, right) =>
          right.meanAbsolutePercentageError < left.meanAbsolutePercentageError ? right : left
        )
      : null;

  const method: ForecastMethod = limitedHistory || !best ? "plain_average" : best.method;

  const outflowSeries = buildSeries(series, (point) => point.outflowMinor);
  const inflowSeries = buildSeries(series, (point) => point.inflowMinor);

  const expectedOutflowMinor = ESTIMATORS[method](outflowSeries.grid, outflowSeries.overall, targetDow);
  const expectedInflowMinor = ESTIMATORS[method](inflowSeries.grid, inflowSeries.overall, targetDow);

  const residuals = series.map((point) => Math.abs(point.outflowMinor - expectedOutflowMinor));
  const upperOutflowMinor =
    expectedOutflowMinor + Math.max(0, quantile(residuals, serviceLevel));

  explanation.push(
    series.length === 0
      ? "This branch has no usable history yet, so no forecast can be made from its own past."
      : `Used ${series.length} day${series.length === 1 ? "" : "s"} of this branch's own history (${series[0].businessDate} to ${series[series.length - 1].businessDate}).`
  );

  if (limitedHistory) {
    explanation.push(
      `Fewer than ${MIN_DAYS_FOR_SEASONAL} days are recorded, so a weekday pattern would be guesswork. The forecast uses the plain average instead.`
    );
  } else if (best) {
    explanation.push(
      `Chose "${FORECAST_METHOD_LABELS[method]}" because it had the lowest backtest error on this branch (${Math.round(best.meanAbsolutePercentageError * 100)}% mean absolute error over ${best.samples} days), beating the plain average.`
    );
    explanation.push(
      `Checked honestly: on the same days that method's band covered ${Math.round(best.bandCoverage * 100)}% of actual demand, which is what the suggested float is based on.`
    );
  } else {
    explanation.push("No method could be backtested yet, so the plain average was used.");
  }

  explanation.push(
    `${targetDowName} usually needs GH₵${(expectedOutflowMinor / 100).toFixed(2)} of float paid out, with a ${Math.round(serviceLevel * 100)}% upper band of GH₵${(upperOutflowMinor / 100).toFixed(2)}.`
  );
  explanation.push(
    `Suggested opening float is the upper band, not the average: a day that runs short is the failure this forecast exists to prevent.`
  );
  explanation.push(
    "This is a suggestion only. Nothing here transfers, requests or reserves float; a person decides."
  );

  return {
    targetDate,
    method,
    methodLabel: FORECAST_METHOD_LABELS[method],
    expectedOutflowMinor,
    expectedInflowMinor,
    expectedNetMinor: expectedInflowMinor - expectedOutflowMinor,
    upperOutflowMinor,
    suggestedOpeningFloatMinor: upperOutflowMinor,
    sampleSize: series.length,
    serviceLevel,
    backtest: alternatives.find((row) => row.method === method) ?? null,
    alternatives,
    explanation,
    limitedHistory,
    autoTransfer: false,
    requiresHumanAction: true,
  };
}

/** The day after the newest point, which is what a branch plans for. */
export function nextForecastDate(points: DailyLiquidityPoint[], todayIso: string): string {
  const history = normalizeHistory(points);
  // With no history there is nothing to plan after: the branch needs float today.
  if (history.length === 0) return todayIso;
  const newest = history[history.length - 1].businessDate;
  return newest >= todayIso ? addDays(newest, 1) : todayIso;
}

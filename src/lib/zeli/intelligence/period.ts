/**
 * Reporting-period resolution for Zeli Business Intelligence.
 *
 * All boundaries are UTC and half-open: [start, endExclusive). The server is
 * the only place that turns a filter into dates. A browser string that is not
 * an approved preset or a valid bounded custom range is rejected rather than
 * silently widened to "all time".
 */

export const PERIOD_PRESETS = [
  "today",
  "yesterday",
  "this_week",
  "previous_week",
  "this_month",
  "previous_month",
  "this_quarter",
  "custom",
] as const;

export type PeriodPreset = (typeof PERIOD_PRESETS)[number];

export interface DateRange {
  start: Date;
  endExclusive: Date;
}

export interface ResolvedPeriod extends DateRange {
  preset: PeriodPreset;
  label: string;
  days: number;
  previous: DateRange & { label: string };
  isCustom: boolean;
}

export class PeriodValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PeriodValidationError";
  }
}

export const MAX_CUSTOM_DAYS = 366;

function utcStartOfDay(date: Date): Date {
  return new Date(
    Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate())
  );
}

function addDays(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function startOfWeek(date: Date): Date {
  // Monday-based ISO week.
  const day = utcStartOfDay(date);
  const isoDay = day.getUTCDay() === 0 ? 7 : day.getUTCDay();
  return addDays(day, -(isoDay - 1));
}

function startOfMonth(date: Date): Date {
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1));
}

function startOfQuarter(date: Date): Date {
  const month = Math.floor(date.getUTCMonth() / 3) * 3;
  return new Date(Date.UTC(date.getUTCFullYear(), month, 1));
}

function daysBetween(start: Date, endExclusive: Date): number {
  return Math.max(0, Math.round((endExclusive.getTime() - start.getTime()) / 86_400_000));
}

export function parseDateOnly(value: string, field: string): Date {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    throw new PeriodValidationError(`${field} must be a date in YYYY-MM-DD format.`);
  }
  const parsed = new Date(`${value}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== value) {
    throw new PeriodValidationError(`${field} is not a valid calendar date.`);
  }
  return parsed;
}

/**
 * Resolve one of the approved presets. `now` is injectable for deterministic
 * tests; production always uses the server clock.
 */
export function resolvePeriod(
  preset: string | undefined,
  options: { from?: string; to?: string; now?: Date } = {}
): ResolvedPeriod {
  const chosen = (preset ?? "this_month") as PeriodPreset;
  if (!PERIOD_PRESETS.includes(chosen)) {
    throw new PeriodValidationError("Unknown reporting period.");
  }
  const now = options.now ?? new Date();
  const today = utcStartOfDay(now);

  let start: Date;
  let endExclusive: Date;
  let label: string;

  switch (chosen) {
    case "today":
      start = today;
      endExclusive = addDays(today, 1);
      label = "Today";
      break;
    case "yesterday":
      start = addDays(today, -1);
      endExclusive = today;
      label = "Yesterday";
      break;
    case "this_week": {
      start = startOfWeek(now);
      endExclusive = addDays(start, 7);
      label = "This week";
      break;
    }
    case "previous_week": {
      const thisWeek = startOfWeek(now);
      start = addDays(thisWeek, -7);
      endExclusive = thisWeek;
      label = "Previous week";
      break;
    }
    case "this_month": {
      start = startOfMonth(now);
      endExclusive = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1));
      label = "This month";
      break;
    }
    case "previous_month": {
      start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - 1, 1));
      endExclusive = startOfMonth(now);
      label = "Previous month";
      break;
    }
    case "this_quarter": {
      start = startOfQuarter(now);
      const quarterStartMonth = start.getUTCMonth();
      endExclusive = new Date(Date.UTC(start.getUTCFullYear(), quarterStartMonth + 3, 1));
      label = "This quarter";
      break;
    }
    case "custom": {
      if (!options.from || !options.to) {
        throw new PeriodValidationError("A custom range needs both a start and an end date.");
      }
      start = parseDateOnly(options.from, "Start date");
      const endDay = parseDateOnly(options.to, "End date");
      endExclusive = addDays(endDay, 1);
      if (endExclusive.getTime() <= start.getTime()) {
        throw new PeriodValidationError("The end date must be on or after the start date.");
      }
      if (daysBetween(start, endExclusive) > MAX_CUSTOM_DAYS) {
        throw new PeriodValidationError("A custom range cannot exceed 366 days.");
      }
      if (endExclusive.getTime() > addDays(today, 1).getTime()) {
        throw new PeriodValidationError("A reporting period cannot end in the future.");
      }
      label = `${options.from} to ${options.to}`;
      break;
    }
    default:
      throw new PeriodValidationError("Unknown reporting period.");
  }

  const days = daysBetween(start, endExclusive);
  let previousStart = addDays(start, -days);
  let previousEnd = start;
  let previousLabel = `Previous ${days} day${days === 1 ? "" : "s"}`;
  if (chosen === "today") {
    previousStart = addDays(start, -1);
    previousEnd = start;
    previousLabel = "Yesterday";
  } else if (chosen === "yesterday") {
    previousStart = addDays(start, -1);
    previousEnd = start;
    previousLabel = "The day before";
  } else if (chosen === "this_week") {
    previousStart = addDays(start, -7);
    previousEnd = start;
    previousLabel = "Previous week";
  } else if (chosen === "previous_week") {
    previousStart = addDays(start, -7);
    previousEnd = start;
    previousLabel = "The week before";
  } else if (chosen === "this_month") {
    previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    previousEnd = start;
    previousLabel = "Previous month";
  } else if (chosen === "previous_month") {
    previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 1, 1));
    previousEnd = start;
    previousLabel = "The month before";
  } else if (chosen === "this_quarter") {
    previousStart = new Date(Date.UTC(start.getUTCFullYear(), start.getUTCMonth() - 3, 1));
    previousEnd = start;
    previousLabel = "Previous quarter";
  }
  return {
    preset: chosen,
    start,
    endExclusive,
    label,
    days,
    isCustom: chosen === "custom",
    previous: {
      start: previousStart,
      endExclusive: previousEnd,
      label: previousLabel,
    },
  };
}

/** Inclusive list of YYYY-MM-DD buckets covered by a range. */
export function enumerateDays(range: DateRange): string[] {
  const days: string[] = [];
  let cursor = utcStartOfDay(range.start);
  while (cursor.getTime() < range.endExclusive.getTime()) {
    days.push(cursor.toISOString().slice(0, 10));
    cursor = addDays(cursor, 1);
  }
  return days;
}

export function periodLabel(range: DateRange): string {
  const start = range.start.toISOString().slice(0, 10);
  const end = new Date(range.endExclusive.getTime() - 1).toISOString().slice(0, 10);
  return start === end ? start : `${start} to ${end}`;
}

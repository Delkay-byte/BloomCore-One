/**
 * Ghana public-holiday calendar for statutory deadlines.
 *
 * Fixed holidays are taken from the Public Holidays Act, 2001 (Act 601) as
 * amended. Good Friday and Easter Monday are computed from the Easter date.
 * Farmers Day is the first Friday in December. When a fixed holiday falls on a
 * weekend, the following Monday is treated as the observed holiday, which is
 * the gazetted practice and is favourable to the data subject.
 *
 * Eid al-Fitr and Eid al-Adha are movable and depend on the gazetted dates.
 * They are never guessed here. The owner or privacy administrator loads the gazetted dates through
 * GHANA_EXTRA_PUBLIC_HOLIDAYS as YYYY-MM-DD:Name entries; the calendar version
 * changes whenever that list changes.
 */

const FIXED = [
  { month: 1, day: 1, name: "New Year Day" },
  { month: 1, day: 7, name: "Constitution Day" },
  { month: 3, day: 6, name: "Independence Day" },
  { month: 5, day: 1, name: "May Day" },
  { month: 7, day: 1, name: "Republic Day" },
  { month: 8, day: 4, name: "Founders Day" },
  { month: 9, day: 21, name: "Kwame Nkrumah Memorial Day" },
  { month: 12, day: 25, name: "Christmas Day" },
  { month: 12, day: 26, name: "Boxing Day" },
] as const;

export const GHANA_HOLIDAY_CALENDAR_VERSION_BASE = "gh-act601-2026.1";

function key(date: Date): string {
  return date.toISOString().slice(0, 10);
}

/** Gregorian Easter Sunday (Meeus/Jones/Butcher algorithm). */
function easterSunday(year: number): Date {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return new Date(Date.UTC(year, month - 1, day));
}

function shift(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

function firstFridayOfDecember(year: number): Date {
  const first = new Date(Date.UTC(year, 11, 1));
  const offset = (5 - first.getUTCDay() + 7) % 7;
  return new Date(Date.UTC(year, 11, 1 + offset));
}

function extraHolidays(): Map<string, string> {
  const map = new Map<string, string>();
  const raw = process.env.GHANA_EXTRA_PUBLIC_HOLIDAYS?.trim();
  if (!raw) return map;
  for (const entry of raw.split(",")) {
    const [date, ...name] = entry.split(":");
    if (!/^\d{4}-\d{2}-\d{2}$/.test(date.trim())) continue;
    map.set(date.trim(), (name.join(":").trim() || "Gazetted public holiday"));
  }
  return map;
}

/** Holidays for one calendar year, keyed YYYY-MM-DD. */
export function ghanaHolidaysForYear(year: number): Map<string, string> {
  const map = new Map<string, string>();
  const add = (date: Date, name: string) => {
    const k = key(date);
    if (!map.has(k)) map.set(k, name);
  };
  for (const holiday of FIXED) {
    add(new Date(Date.UTC(year, holiday.month - 1, holiday.day)), holiday.name);
  }
  const easter = easterSunday(year);
  add(shift(easter, -2), "Good Friday");
  add(shift(easter, 1), "Easter Monday");
  add(firstFridayOfDecember(year), "Farmers Day");
  // Observed Monday when a fixed holiday falls on a weekend.
  for (const holiday of FIXED) {
    const date = new Date(Date.UTC(year, holiday.month - 1, holiday.day));
    const day = date.getUTCDay();
    if (day === 6) add(shift(date, 2), holiday.name + " (observed)");
    if (day === 0) add(shift(date, 1), holiday.name + " (observed)");
  }
  for (const [date, name] of extraHolidays()) {
    if (date.startsWith(String(year))) map.set(date, name);
  }
  return map;
}

export function ghanaHolidayName(date: Date): string | null {
  return ghanaHolidaysForYear(date.getUTCFullYear()).get(key(date)) ?? null;
}

export function isGhanaPublicHoliday(date: Date): boolean {
  return ghanaHolidayName(date) !== null;
}

export function ghanaHolidayCalendarVersion(): string {
  const extra = process.env.GHANA_EXTRA_PUBLIC_HOLIDAYS?.trim();
  if (!extra) return GHANA_HOLIDAY_CALENDAR_VERSION_BASE;
  // Stable, non-secret fingerprint of the extra gazetted dates.
  let hash = 0;
  for (let index = 0; index < extra.length; index += 1) {
    hash = (hash * 31 + extra.charCodeAt(index)) | 0;
  }
  return GHANA_HOLIDAY_CALENDAR_VERSION_BASE + "+gazette-" + Math.abs(hash).toString(36);
}

export interface GhanaHolidayEntry {
  date: string;
  name: string;
}

export function ghanaHolidayCalendar(year: number): GhanaHolidayEntry[] {
  return Array.from(ghanaHolidaysForYear(year).entries())
    .map(([date, name]) => ({ date, name }))
    .sort((left, right) => left.date.localeCompare(right.date));
}

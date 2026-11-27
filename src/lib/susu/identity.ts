/**
 * Pure identity helpers shared by every customer surface.
 *
 * This module has NO database import on purpose: the import wizard and the
 * onboarding form are client components, and they must be able to reuse the
 * exact comparison rules the server uses without dragging the Prisma client
 * into the browser bundle. Everything here is deterministic and side-effect
 * free; the writes live in `onboarding.ts`.
 */

/** How a customer or account entered MaaCash. */
export type OnboardingChannel = "office" | "field" | "import" | "legacy";

export const ONBOARDING_CHANNELS: readonly OnboardingChannel[] = [
  "office",
  "field",
  "import",
  "legacy",
];

/**
 * Input bounds.
 *
 * These are validation limits, not business policy knobs. They exist so a
 * malformed or hostile payload cannot write an unbounded string into the
 * database, and so an obvious typo (GH₵ 40,000 a day for a market trader) is
 * rejected before money is ever recorded.
 */
export const ONBOARDING_LIMITS = {
  nameMin: 2,
  nameMax: 120,
  phoneMax: 32,
  addressMax: 240,
  notesMax: 500,
  externalReferenceMax: 64,
  /** Smallest meaningful daily contribution in cedis. */
  dailyContributionMin: 0.01,
  /** Ceiling that catches a misplaced decimal point before it becomes a rate. */
  dailyContributionMax: 100_000,
  cardFeeMin: 0,
  cardFeeMax: 10_000,
  /** Longest source cell MaaCash will keep as evidence for one row. */
  rawRowMax: 1_000,
} as const;

/**
 * Collapse a person's name to a comparison key.
 *
 * Used only for duplicate detection, never for storage or display. It folds
 * case, diacritics, punctuation and repeated whitespace so "Ama  Mensah" and
 * "ama mensah" compare equal. It does NOT transliterate or spell-correct, so
 * two genuinely different spellings stay different — the system must never
 * silently merge two people because their names look similar.
 */
export function personNameKey(name: string | null | undefined): string {
  if (!name) return "";
  return name
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Reduce a Ghanaian phone number to its nine-digit national significant part.
 *
 * "0241234567", "+233 24 123 4567" and "233241234567" all become "241234567".
 * Returns "" when the value cannot represent a phone number, which callers
 * treat as "no phone" rather than as a mismatch.
 */
export function phoneKey(phone: string | null | undefined): string {
  if (!phone) return "";
  const digits = phone.replace(/[^\d]/g, "");
  if (digits.length === 12 && digits.startsWith("233")) return digits.slice(3);
  if (digits.length === 11 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 10 && digits.startsWith("0")) return digits.slice(1);
  if (digits.length === 9) return digits;
  return digits.length > 9 ? digits.slice(-9) : digits;
}

/** Comparison key for a business's own reference (trimmed, upper-cased, no spaces). */
export function referenceKey(reference: string | null | undefined): string {
  if (!reference) return "";
  return reference.replace(/\s+/g, "").toUpperCase();
}

/** Comparison key for an e-mail address. */
export function emailKey(email: string | null | undefined): string {
  if (!email) return "";
  return email.trim().toLowerCase();
}

/**
 * True when a value looks like a real e-mail address.
 *
 * Deliberately conservative: a migration must not reject a valid address
 * because of an exotic-but-legal form, and must not accept a cell that is
 * obviously prose.
 */
export function looksLikeEmail(value: string): boolean {
  if (value.length > 254) return false;
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(value);
}

/**
 * Trim and length-limit a free-text value.
 *
 * Control characters are removed (a spreadsheet cell can contain them and they
 * corrupt CSV exports and logs). Returns null for an empty result so the
 * database stores a real absence rather than "".
 */
export function cleanText(value: unknown, maxLength: number): string | null {
  if (value === null || value === undefined) return null;
  const text = String(value)
    .replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  return text.length > maxLength ? text.slice(0, maxLength).trim() : text;
}

/**
 * Parse a money cell into a whole-cedi-safe number.
 *
 * Accepts "20", "20.00", "GH₵ 20.00" and "20,00". Rejects negatives, more than
 * two decimal places (a rate with half a pesewa in it means the source is
 * wrong) and prices above the onboarding ceiling.
 */
export function parseMoneyCell(
  value: unknown,
  min: number,
  max: number
): { ok: true; amount: number } | { ok: false; reason: string } {
  if (value === null || value === undefined) {
    return { ok: false, reason: "Missing amount" };
  }
  let raw = String(value)
    .replace(/[^\d.,-]/g, "")
    .trim();
  // "20,00" and "1,250" mean different things in different books. A comma with
  // exactly two digits after it and no dot is a decimal comma; anything else is
  // a thousands separator.
  if (raw.includes(",") && raw.includes(".")) raw = raw.replace(/,/g, "");
  else if (/,[0-9]{2}$/.test(raw)) raw = raw.replace(",", ".");
  else raw = raw.replace(/,/g, "");
  if (!raw) return { ok: false, reason: "Not a number" };
  const amount = Number(raw);
  if (!Number.isFinite(amount)) return { ok: false, reason: "Not a number" };
  if (amount < min) {
    return { ok: false, reason: "Amount is below the minimum allowed" };
  }
  if (amount > max) {
    return { ok: false, reason: "Amount is above the maximum allowed" };
  }
  // Reject a third decimal place: "20.005" means the source is wrong, and
  // silently rounding someone's agreed rate is not acceptable.
  const cents = amount * 100;
  if (Math.abs(cents - Math.round(cents)) > 1e-6) {
    return { ok: false, reason: "Amount has more than two decimal places" };
  }
  return { ok: true, amount: Math.round(cents) / 100 };
}

/** Format a validated amount for a Decimal column without float artefacts. */
export function moneyString(amount: number): string {
  return amount.toFixed(2);
}

/**
 * True when an imported account number can be reused verbatim as the canonical
 * MaaCash account number.
 *
 * The rule is intentionally strict. The account number is printed on cards and
 * used by the customer portal login flow, so it must be short, unambiguous and
 * cannot contain characters that break a CSV round-trip or a URL. Anything
 * rejected keeps its original value in `externalAccountReference` and receives
 * a canonical `BIK-S-######` number instead — nothing is lost.
 */
export function reusableAccountNumber(value: string | null | undefined): boolean {
  if (!value) return false;
  const trimmed = value.trim();
  if (trimmed.length < 4 || trimmed.length > 24) return false;
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(trimmed)) return false;
  // Reserved shape: canonical identifiers are allocated by the system and must
  // never be claimed from a spreadsheet.
  if (/^BIK-[CS]-\d{6}$/i.test(trimmed)) return false;
  return true;
}

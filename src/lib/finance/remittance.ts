/**
 * Remittance money rules (SEC-06).
 *
 * A collector hands over cash; the amount must be an exact money value. Kept in
 * a plain module (not a `"use server"` file) so the rules are unit-testable and
 * cannot be reached as a server action.
 */

export const MAX_REMITTANCE_AMOUNT = 1_000_000;

export type RemittanceValidation =
  | { ok: true; value: number }
  | { ok: false; error: string };

/**
 * Accepts only a finite, positive, at-most-two-decimal amount within the
 * approved maximum. Strings, NaN, Infinity, negatives, zero and extra
 * precision are rejected rather than coerced.
 */
export function validateRemittanceAmount(input: unknown): RemittanceValidation {
  if (typeof input !== "number" || !Number.isFinite(input)) {
    return { ok: false, error: "Enter a valid remitted amount" };
  }
  if (input <= 0) {
    return { ok: false, error: "Remitted amount must be greater than 0" };
  }
  if (input > MAX_REMITTANCE_AMOUNT) {
    return { ok: false, error: "Remitted amount exceeds the allowed maximum" };
  }
  // Compare in pesewas to avoid float drift in the decimals check.
  const pesewas = input * 100;
  if (Math.abs(pesewas - Math.round(pesewas)) > 1e-6) {
    return { ok: false, error: "Remitted amount cannot have more than two decimals" };
  }
  return { ok: true, value: Math.round(pesewas) / 100 };
}

/**
 * Expected cash handover for a collector: contributions recorded since the last
 * active remittance, excluding reversed ones.
 */
export function expectedRemittanceAmount(
  contributions: { amount: unknown; reversedAt: Date | null }[]
): number {
  const total = contributions
    .filter((row) => row.reversedAt === null)
    .reduce((sum, row) => sum + Number(row.amount), 0);
  return Math.round(total * 100) / 100;
}

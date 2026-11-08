/**
 * One public customer identifier: the Account Number.
 *
 * The canonical value is the existing, server-generated `Customer.customerId`
 * (BIK-C-XXXXXX). It is globally unique, already printed on customer cards and
 * receipts, and already used by the customer portal sign-in. Susu account rows
 * keep their internal `accountId` for relationships, but it is not presented as
 * a second customer-facing number.
 */

export const ACCOUNT_NUMBER_LABEL = "Account Number";

// Generated values are BIK-C-XXXXXX. The prefix check also accepts legacy
// imported identifiers so they remain usable without losing uniqueness.
const ACCOUNT_NUMBER_PATTERN = /^BIK-C-[A-Z0-9-]+$/;

/** Normalize user input without changing the stored canonical value. */
export function normalizeAccountNumber(value: string): string {
  return value.trim().toUpperCase().replace(/\s+/g, "");
}

export function isAccountNumber(value: string): boolean {
  return ACCOUNT_NUMBER_PATTERN.test(normalizeAccountNumber(value));
}

export const SHARED_PHONE_MESSAGE =
  "This phone number is linked to more than one customer account. Please sign in using your Account Number.";

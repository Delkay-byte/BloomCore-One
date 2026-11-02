/**
 * Central account/location status policy.
 *
 * Only the two documented states exist, and the only permitted transitions are
 * active ↔ inactive. Arbitrary strings previously reached the database and
 * silently deauthorised accounts.
 */

export const ACCOUNT_STATUSES = ["active", "inactive"] as const;
export type AccountStatus = (typeof ACCOUNT_STATUSES)[number];

export function isAccountStatus(value: unknown): value is AccountStatus {
  return value === "active" || value === "inactive";
}

export function canTransitionStatus(
  from: string,
  to: AccountStatus
): boolean {
  if (from === to) return true;
  if (from === "active" && to === "inactive") return true;
  if (from === "inactive" && to === "active") return true;
  return false;
}

/** Validate the requested status and transition, returning a message on denial. */
export function validateStatusTransition(
  from: string,
  requested: unknown
): { ok: true; status: AccountStatus } | { ok: false; error: string } {
  if (!isAccountStatus(requested)) {
    return { ok: false, error: "Invalid status value" };
  }
  if (!canTransitionStatus(from, requested)) {
    return { ok: false, error: "This status change is not permitted" };
  }
  return { ok: true, status: requested };
}

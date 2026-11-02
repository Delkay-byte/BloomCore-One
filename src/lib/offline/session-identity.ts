/**
 * Pure session-identity decision used by the cross-tab guard.
 *
 * Kept free of React/Next imports so the behaviour can be tested directly.
 */
export type IdentityChange = "initial" | "same" | "changed";

export function classifyIdentityChange(
  previous: string | null,
  current: string
): IdentityChange {
  if (!previous) return "initial";
  return previous === current ? "same" : "changed";
}

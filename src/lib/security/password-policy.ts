/**
 * Authoritative password policy for MaaCash account credentials.
 *
 * The backend calls `validatePasswordPolicy` before every password write.
 * The frontend imports the individual requirement checks only to render the
 * live checklist; it is never the enforcement boundary.
 */

export const PASSWORD_MIN_LENGTH = 12;

export interface PasswordRequirement {
  id: "length" | "uppercase" | "lowercase" | "number" | "symbol";
  label: string;
  test: (password: string) => boolean;
}

export const PASSWORD_REQUIREMENTS: PasswordRequirement[] = [
  {
    id: "length",
    label: `At least ${PASSWORD_MIN_LENGTH} characters`,
    test: (password) => password.length >= PASSWORD_MIN_LENGTH,
  },
  {
    id: "uppercase",
    label: "At least one uppercase letter",
    test: (password) => /[A-Z]/.test(password),
  },
  {
    id: "lowercase",
    label: "At least one lowercase letter",
    test: (password) => /[a-z]/.test(password),
  },
  {
    id: "number",
    label: "At least one number",
    test: (password) => /[0-9]/.test(password),
  },
  {
    id: "symbol",
    label: "At least one symbol",
    test: (password) => /[^A-Za-z0-9]/.test(password),
  },
];

export function unmetPasswordRequirements(password: string): PasswordRequirement[] {
  return PASSWORD_REQUIREMENTS.filter((requirement) => !requirement.test(password));
}

/** Return the first policy failure, or null when the password is compliant. */
export function validatePasswordPolicy(password: string): string | null {
  if (typeof password !== "string" || password.length === 0) {
    return "Password is required";
  }
  // Do not silently truncate. Reject absurd lengths instead, before hashing.
  if (password.length > 256) {
    return "Password must be 256 characters or fewer";
  }
  const unmet = unmetPasswordRequirements(password);
  if (unmet.length === 0) return null;
  return `Password does not meet the requirements: ${unmet
    .map((requirement) => requirement.label.toLowerCase())
    .join(", ")}.`;
}

/** True when the stored policy version means the account still needs the upgrade. */
export function needsPasswordPolicyUpgrade(
  version: number | null | undefined,
  forcePasswordReset: boolean | null | undefined
): boolean {
  return forcePasswordReset === true || (version ?? 0) < 1;
}

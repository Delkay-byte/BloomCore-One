/**
 * Check if an error is a Next.js redirect error (from `redirect()` in Server Actions).
 * These must be re-thrown so the router handles the redirect.
 */
export function isRedirectError(err: unknown): boolean {
  return (
    err instanceof Error &&
    "digest" in err &&
    typeof (err as { digest: unknown }).digest === "string" &&
    (err as { digest: string }).digest.startsWith("NEXT_REDIRECT")
  );
}

/**
 * Extract the internal destination from a Next.js redirect control-flow error.
 *
 * A server action can redirect for a business reason (Billing & Plan, a denied
 * role, an expired session). Treating every redirect as "go to /login" turns a
 * package restriction into an apparent logout. Only same-origin absolute paths
 * are returned; anything else must fall back to the caller's safe default.
 */
export function redirectPathFromError(err: unknown): string | null {
  if (!isRedirectError(err)) return null;
  const digest = (err as { digest: string }).digest;
  const target = digest.split(";")[2] ?? "";
  if (!target.startsWith("/") || target.startsWith("//")) return null;
  return target;
}

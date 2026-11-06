/**
 * ============================================================================
 * PUBLIC MARKETING ROUTES
 * ============================================================================
 *
 * The MaaCash marketing site is public. Everything else keeps the access
 * control it already had.
 *
 * This module is deliberately dependency-free: src/middleware.ts runs it on the
 * Edge runtime before any application code, and tests/public-routes.test.ts
 * checks it without booting Next.js.
 *
 * Rules
 *   * Exact match for "/".
 *   * Sub-paths of a marketing route are public too (for example a future
 *     /features/momo), but only on a segment boundary — "/featuresecret" is
 *     NOT public.
 *   * Nothing in the application (admin, worker, collector, customer,
 *     platform, settings, select-workspace, api) is listed here, so those
 *     routes keep their existing guards.
 */

export const PUBLIC_MARKETING_ROUTES = [
  "/",
  "/features",
  "/solutions",
  "/about",
  "/contact",
  "/privacy",
  "/terms",
] as const;

export function isPublicMarketingRoute(pathname: string): boolean {
  if (pathname === "/") return true;

  return PUBLIC_MARKETING_ROUTES.some((route) => {
    if (route === "/") return false;
    return pathname === route || pathname.startsWith(`${route}/`);
  });
}

/**
 * Per-tab session transport constants.
 *
 * A browser cookie is shared by every tab in the same profile, so it cannot
 * identify a tab. The authenticated session handle travels in a custom request
 * header that is injected by the tab-scoped service worker. The page never
 * controls this header: the worker removes any value supplied by page script
 * and writes its own per-tab value.
 *
 * Server code must read only this header. Cookies are kept solely for the
 * pre-migration compatibility window (explicitly enabled in tests), never in
 * production.
 */
export const TAB_SESSION_HEADER = "x-bloomcore-tab-session";

/** Non-secret client identifier, for diagnostics only. Never an authorization input. */
export const TAB_CLIENT_HEADER = "x-bloomcore-tab-client";

/** Header used by the worker to report the session transport version. */
export const TAB_SESSION_VERSION_HEADER = "x-bloomcore-tab-version";

export const TAB_SESSION_TRANSPORT_VERSION = "1";

/**
 * Test-only migration bridge. It lets pre-existing unit tests seed a cookie
 * while the production path is header-only. Never set this in a deployed
 * environment; the default is strict header authentication.
 */
export function allowLegacyCookieSessions(): boolean {
  // Double gate: the flag alone is not enough outside tests. A production
  // environment with the variable set by mistake still uses headers only.
  return (
    process.env.NODE_ENV === "test" &&
    process.env.ALLOW_LEGACY_COOKIE_SESSIONS === "1"
  );
}

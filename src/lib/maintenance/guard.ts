/**
 * Release maintenance guard.
 *
 * A controlled, environment-driven switch that fails closed and runs before any
 * authentication, session or route handler logic. It exists for the narrow
 * production window between a schema migration and the deployment of the
 * application version that understands the new schema.
 *
 * Semantics:
 *   MAINTENANCE_MODE unset or empty        -> off   (normal application)
 *   MAINTENANCE_MODE in OFF_VALUES         -> off
 *   MAINTENANCE_MODE in ON_VALUES          -> on
 *   MAINTENANCE_MODE set to anything else  -> on    (fail closed)
 *
 * While on, every path is refused with 503 except the health/readiness probes
 * Render needs in order to deploy, plus immutable static assets.
 *
 * This module deliberately has no dependency on Next.js so it can be unit
 * tested directly. The middleware builds the HTTP response from these helpers.
 */

export type MaintenanceState = "on" | "off";

const ON_VALUES = new Set(["true", "1", "on", "yes", "enabled"]);
const OFF_VALUES = new Set(["false", "0", "off", "no", "disabled"]);

/** Paths that must stay reachable while maintenance is on. */
export const MAINTENANCE_EXEMPT_PATHS: readonly string[] = [
  "/api/health",
  "/api/health/ready",
];

export const MAINTENANCE_RETRY_AFTER_SECONDS = 300;

/**
 * Resolve the guard state from an environment value.
 * An unrecognised non-empty value is treated as ON so a typo cannot silently
 * re-open authentication during a maintenance window.
 */
export function resolveMaintenanceState(raw: string | undefined): MaintenanceState {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "") return "off";
  if (OFF_VALUES.has(value)) return "off";
  if (ON_VALUES.has(value)) return "on";
  return "on";
}

/** Current guard state from the process environment. */
export function maintenanceState(): MaintenanceState {
  return resolveMaintenanceState(process.env.MAINTENANCE_MODE);
}

/**
 * Canonicalise a request path before any decision is made, so alternate
 * encodings, duplicate slashes, dot segments and trailing slashes cannot be
 * used to dodge the guard.
 */
export function normalizeRequestPath(pathname: string): string {
  let path = (pathname ?? "").split("?")[0].split("#")[0].replace(/\\/g, "/");
  try {
    path = decodeURIComponent(path);
  } catch {
    // Keep the raw value; an undecodable path is simply not exempt.
  }
  const segments: string[] = [];
  for (const segment of path.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      segments.pop();
      continue;
    }
    segments.push(segment);
  }
  return "/" + segments.join("/");
}

/**
 * True when the path must remain served while maintenance is on.
 * Everything not listed here is blocked, so an unlisted route can never be
 * reached by mistake.
 */
export function isMaintenanceExempt(pathname: string): boolean {
  const path = normalizeRequestPath(pathname).toLowerCase();
  if (MAINTENANCE_EXEMPT_PATHS.includes(path)) return true;
  if (path === "/_next/static" || path.startsWith("/_next/static/")) return true;
  if (path === "/_next/image" || path.startsWith("/_next/image/")) return true;
  if (path === "/favicon.ico") return true;
  return false;
}

/** True when this request must be refused with the maintenance response. */
export function isMaintenanceBlocked(
  pathname: string,
  state: MaintenanceState
): boolean {
  if (state === "off") return false;
  return !isMaintenanceExempt(pathname);
}

export const MAINTENANCE_MESSAGE =
  "MaaCash is temporarily unavailable while a scheduled security upgrade completes. Please try again in a few minutes.";

/** Minimal, dependency-free maintenance page. No external resources. */
export const MAINTENANCE_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>MaaCash - Scheduled maintenance</title>
<style>
body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;background:#0b1120;color:#e2e8f0;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:32rem;padding:2rem;text-align:center}
h1{font-size:1.25rem;margin:0 0 .75rem}
p{margin:0;line-height:1.6;color:#94a3b8}
</style>
</head>
<body>
<main>
<h1>MaaCash is briefly unavailable</h1>
<p>${MAINTENANCE_MESSAGE}</p>
</main>
</body>
</html>`;

/** Standard headers for every maintenance response. */
export function maintenanceHeaders(): Record<string, string> {
  return {
    "Retry-After": String(MAINTENANCE_RETRY_AFTER_SECONDS),
    "Cache-Control": "no-store, max-age=0",
    "Content-Security-Policy":
      "default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
    "X-Content-Type-Options": "nosniff",
  };
}

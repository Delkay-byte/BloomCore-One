/**
 * ============================================================================
 * LOCAL-ONLY LIVE PAYMENT GUARD
 * ============================================================================
 *
 * A live Paystack key can move real money. On a developer machine that must be
 * an explicit, deliberate decision, never an accident caused by copying a
 * production key into a local `.env`.
 *
 * This module is the single source of truth for that decision:
 *
 *   * In production (a hosted deployment) a live key behaves exactly as before.
 *   * Anywhere else, a live key is refused unless the owner opts in with
 *     `PAYSTACK_LOCAL_LIVE_TEST=true` AND every remaining condition holds.
 *
 * The check is derived from the environment on every call. Nothing here is
 * cached, nothing is accepted from the browser, and the API key prefix stays
 * the authoritative mode signal — a flag can never turn a test key into a live
 * one or the reverse.
 *
 * The guard deliberately does NOT relax authentication, MFA, billing-role
 * authorisation, subscription rules or payment verification. It only decides
 * whether the provider may be asked to move real money from this process.
 */

export type PaystackKeyMode = "live" | "test" | "unknown";

export interface LocalLiveTestEnvironment {
  /** `sk_live_…`, `sk_test_…` or unknown, taken from the key prefix. */
  keyMode: PaystackKeyMode;
  /** `NODE_ENV` of the running process. */
  nodeEnv: string;
  /** `PAYSTACK_LOCAL_LIVE_TEST` — the owner's explicit opt-in. */
  localLiveTest: string | undefined;
  /** `PAYSTACK_ENABLED`. */
  enabled: string | undefined;
  /** `PAYSTACK_CURRENCY`. Mobile money is GHS only. */
  currency: string | undefined;
  /** Origin of the request being served, when known. */
  origin: string | null;
  /** Configured public site URL (SITE_URL / NEXT_PUBLIC_SITE_URL). */
  siteUrl: string | null;
  /** Database connection string. Never logged. */
  databaseUrl: string | null;
  /** Tenant that would be charged. */
  tenantId: string | null;
  /** Public code of that tenant, e.g. `DEMO-001`. */
  tenantCode: string | null;
  /** `PAYSTACK_LOCAL_TEST_TENANT`: the only tenant allowed to pay live locally. */
  designatedTenant: string | null;
}

export interface LocalLiveTestDecision {
  allowed: boolean;
  /** Sanitized reason codes; safe for logs and for the operator. */
  reasons: string[];
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);
/** Hosts that only ever appear in a hosted deployment. */
const HOSTED_ENV_MARKERS = [
  "RENDER",
  "RENDER_SERVICE_ID",
  "RENDER_EXTERNAL_HOSTNAME",
  "VERCEL",
  "VERCEL_ENV",
  "FLY_APP_NAME",
  "RAILWAY_ENVIRONMENT",
  "DYNO",
];

/** True when the process is a hosted deployment, not a developer machine. */
export function hostedDeployment(env: NodeJS.ProcessEnv = process.env): boolean {
  return HOSTED_ENV_MARKERS.some((name) => Boolean(env[name]));
}

/** True for an approved local loopback origin such as `http://localhost:3100`. */
export function isLoopbackOrigin(value: string | null | undefined): boolean {
  if (!value) return false;
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return false;
    return LOOPBACK_HOSTS.has(url.hostname.toLowerCase());
  } catch {
    return false;
  }
}

/**
 * An isolated developer database: a SQLite file, or PostgreSQL on loopback.
 * Anything else (Neon, Render, a remote host) is refused by name pattern
 * first, so a production URL can never be treated as local.
 */
export function isLocalDatabaseUrl(value: string | null | undefined): boolean {
  if (!value) return false;
  const url = value.trim();
  if (/^file:/i.test(url)) return true;
  if (!/^postgres(ql)?:\/\//i.test(url)) return false;
  if (/(neon\.tech|render\.com|supabase\.co|amazonaws\.com|azure\.com|googleapis\.com)/i.test(url)) {
    return false;
  }
  try {
    const parsed = new URL(url);
    return LOOPBACK_HOSTS.has(parsed.hostname.toLowerCase());
  } catch {
    return false;
  }
}

function isOn(value: string | undefined): boolean {
  return (value ?? "").trim().toLowerCase() === "true";
}

/**
 * Whether a live key used by this process must pass the local-live guard.
 *
 * A hosted deployment is ordinary production commerce and keeps its existing
 * behaviour. Everything else — a loopback origin, an unknown origin on a
 * developer machine — is local and must opt in.
 */
export function requiresLocalLiveGuard(
  origin: string | null,
  env: NodeJS.ProcessEnv = process.env
): boolean {
  if (hostedDeployment(env)) return false;
  if (isLoopbackOrigin(origin)) return true;
  if (isLoopbackOrigin(env.SITE_URL) || isLoopbackOrigin(env.NEXT_PUBLIC_SITE_URL)) return true;
  // A production build served on a real https origin without any hosted
  // marker keeps the normal production contract. Anything else is local.
  return env.NODE_ENV !== "production";
}

/**
 * Decide whether a genuine live charge may be started.
 *
 * Every condition is required. The list is intentionally sequential and each
 * failure has its own code so the operator can see exactly what is missing
 * without ever reading a secret.
 */
export function evaluateLocalLiveTest(
  environment: LocalLiveTestEnvironment
): LocalLiveTestDecision {
  const reasons: string[] = [];

  if (environment.keyMode !== "live") reasons.push("key_not_live");
  if (!isOn(environment.localLiveTest)) reasons.push("local_live_test_not_enabled");
  if (environment.nodeEnv !== "development") reasons.push("not_development");
  if (hostedDeployment()) reasons.push("hosted_deployment");
  if (!isOn(environment.enabled)) reasons.push("payments_disabled");
  if ((environment.currency ?? "").trim().toUpperCase() !== "GHS") {
    reasons.push("currency_not_ghs");
  }
  if (!isLoopbackOrigin(environment.origin) && !isLoopbackOrigin(environment.siteUrl)) {
    reasons.push("origin_not_loopback");
  }
  if (!isLocalDatabaseUrl(environment.databaseUrl)) reasons.push("database_not_local");

  const designated = (environment.designatedTenant ?? "").trim();
  if (!designated) {
    reasons.push("no_designated_tenant");
  } else if (
    environment.tenantId !== designated &&
    environment.tenantCode !== designated
  ) {
    reasons.push("tenant_not_designated");
  }

  return { allowed: reasons.length === 0, reasons };
}

/** Read the guard inputs from the environment, without any request context. */
export function localLiveTestEnvironment(
  overrides: Partial<LocalLiveTestEnvironment> = {}
): LocalLiveTestEnvironment {
  const env = process.env;
  return {
    keyMode: "unknown",
    nodeEnv: env.NODE_ENV ?? "",
    localLiveTest: env.PAYSTACK_LOCAL_LIVE_TEST,
    enabled: env.PAYSTACK_ENABLED,
    currency: env.PAYSTACK_CURRENCY,
    origin: null,
    siteUrl: env.SITE_URL ?? env.NEXT_PUBLIC_SITE_URL ?? null,
    databaseUrl: env.DATABASE_URL ?? null,
    tenantId: null,
    tenantCode: null,
    designatedTenant: env.PAYSTACK_LOCAL_TEST_TENANT ?? null,
    ...overrides,
  };
}

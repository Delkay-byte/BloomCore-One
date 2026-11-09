/**
 * ============================================================================
 * PUBLIC SITE CONFIGURATION — MaaCash
 * ============================================================================
 *
 * One place for everything the public marketing site and the application
 * metadata need. Nothing here is a secret, and nothing here invents a fact the
 * business has not supplied.
 *
 * SITE_URL
 *   The canonical public origin. Production on Render defaults to
 *   https://maacash.bloomcoretech.com; local development defaults to
 *   http://localhost:3000. Set SITE_URL (server-side) or NEXT_PUBLIC_SITE_URL
 *   to override either default. The sitemap, Open Graph URLs and metadata base
 *   all follow this value. Canonical <link> tags are suppressed on local and
 *   staging deployments so they never claim to be the public production home.
 *
 *   The old primary Render hostname remains operational as a transition
 *   address. It is listed in LEGACY_PUBLIC_HOSTNAMES and receives a visible
 *   migration notice; it is not redirected, because offline IndexedDB records
 *   and cookies are origin-scoped and must be synchronized before it can
 *   retire.
 *
 * CONTACT_EMAIL / CONTACT_PHONE
 *   The public enquiry channel. No verified BloomCore Technologies business
 *   email or telephone number exists in this repository, so both are unset by
 *   default. While they are unset the /contact page states plainly that the
 *   enquiry channel is not published yet and lists exactly what the owner must
 *   supply — it never pretends an enquiry was sent.
 */

export const PRODUCT_NAME = "MaaCash";
export const COMPANY_NAME = "BloomCore Technologies";
export const PRODUCT_TAGLINE = "One platform. Clearer control.";
export const PRODUCT_DESCRIPTOR =
  "Mobile Money, Susu & Multi-Branch Financial Operations Platform";
export const PRODUCT_POSITIONING =
  "MaaCash brings mobile money, Susu collections, multi-branch operations and financial records together in one connected platform.";
export const COMPANY_LOCATION = "Ghana";
export const FIRST_TENANT_NAME = "BIK Prestige Enterprise";
export const FIRST_TENANT_CODE = "BIK-HQ-001";

/** Official public origin for MaaCash. */
export const CANONICAL_PRODUCTION_URL = "https://maacash.bloomcoretech.com";
export const CANONICAL_PRODUCTION_HOSTNAME = "maacash.bloomcoretech.com";

/**
 * Old production origin kept reachable during the domain transition.
 *
 * Offline financial records, cookies and service-worker caches are scoped to
 * the origin that created them. This host stays live until the owner confirms
 * outstanding records have synchronized; never add a blanket redirect here.
 *
 * `bloomcore-one.onrender.com` was retired with its duplicate Render service.
 * The `bloomcore-one` identifiers in JWT audiences and the OIDC product slug
 * are internal contracts and are intentionally not renamed.
 */
export const LEGACY_PUBLIC_HOSTNAMES = ["maacash.onrender.com"] as const;

const LOCAL_DEVELOPMENT_URL = "http://localhost:3000";
const STAGING_DEPLOYMENT_URL = "https://bloomcore-one-staging.onrender.com";

function readEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/**
 * True on the dedicated staging deployment (APP_ENV=STAGING).
 *
 * Staging social metadata may use the staging origin so previews do not point
 * at production, but staging must never be indexed or declare a canonical URL.
 */
export const IS_STAGING_DEPLOYMENT =
  (process.env.APP_ENV ?? "").trim().toUpperCase() === "STAGING";

/**
 * True on a Render-hosted deployment. Render sets RENDER=true and
 * RENDER_SERVICE_ID. This distinguishes a hosted production process from a
 * local `next start`, whose public origin must stay local.
 */
export const IS_RENDER_DEPLOYMENT =
  process.env.RENDER === "true" || Boolean(process.env.RENDER_SERVICE_ID);

function defaultSiteUrl(): string {
  if (IS_STAGING_DEPLOYMENT) return STAGING_DEPLOYMENT_URL;
  // A production build served by Render is the public deployment even if the
  // dashboard value is missing; the canonical origin is the safe default.
  if (IS_RENDER_DEPLOYMENT) return CANONICAL_PRODUCTION_URL;
  return LOCAL_DEVELOPMENT_URL;
}

const configuredSiteUrl =
  readEnv(process.env.SITE_URL) ?? readEnv(process.env.NEXT_PUBLIC_SITE_URL);

/** Configured public origin, or the environment-appropriate default. */
export const SITE_URL = (configuredSiteUrl ?? defaultSiteUrl()).replace(
  /\/+$/,
  ""
);

/**
 * True for local development, where the origin must not claim to be the
 * canonical public home. Render and staging deployments are never provisional.
 */
export const SITE_URL_IS_PROVISIONAL =
  !configuredSiteUrl && !IS_RENDER_DEPLOYMENT && !IS_STAGING_DEPLOYMENT;

/** Normalize a Host or X-Forwarded-Host value to a bare lowercase hostname. */
export function normalizeHostname(
  value: string | null | undefined
): string | null {
  const raw = value?.split(",")[0]?.trim().toLowerCase();
  if (!raw) return null;
  try {
    return new URL(raw.includes("://") ? raw : `https://${raw}`).hostname.toLowerCase();
  } catch {
    return null;
  }
}

/** True when a request hostname is one of the old MaaCash public origins. */
export function isLegacyPublicHostname(
  value: string | null | undefined
): boolean {
  const hostname = normalizeHostname(value);
  if (!hostname) return false;
  return (LEGACY_PUBLIC_HOSTNAMES as readonly string[]).includes(hostname);
}

/**
 * Show the migration notice only on a hosted Render deployment that is still
 * serving one of the old origins. Staging and the canonical domain stay clean.
 */
export function shouldShowLegacyHostNotice(
  value: string | null | undefined
): boolean {
  return (
    IS_RENDER_DEPLOYMENT &&
    !IS_STAGING_DEPLOYMENT &&
    isLegacyPublicHostname(value)
  );
}

/** Public enquiry email. Null until the owner supplies one. */
export const CONTACT_EMAIL = readEnv(process.env.CONTACT_EMAIL);

/** Public enquiry telephone number. Null until the owner supplies one. */
export const CONTACT_PHONE = readEnv(process.env.CONTACT_PHONE);

export const CONTACT_CONFIGURED = Boolean(CONTACT_EMAIL || CONTACT_PHONE);

/** The public pages that make up the marketing site. */
export const PUBLIC_ROUTES = [
  { path: "/", label: "Home" },
  { path: "/features", label: "Features" },
  { path: "/solutions", label: "Who We Serve" },
  { path: "/about", label: "About" },
  { path: "/contact", label: "Contact" },
] as const;

export const LEGAL_ROUTES = [
  { path: "/privacy", label: "Privacy Policy" },
  { path: "/terms", label: "Terms of Service" },
] as const;

/** Sign-in entry points. These are existing routes; do not rename them. */
export const BUSINESS_LOGIN_PATH = "/login";
export const ALL_ACCESS_PATH = "/access";
export const PLATFORM_LOGIN_PATH = "/platform/login";

/** Builds an absolute URL for metadata. */
export function absoluteUrl(path: string): string {
  return `${SITE_URL}${path.startsWith("/") ? path : `/${path}`}`;
}

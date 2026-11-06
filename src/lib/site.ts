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
 *   The current deployment origin. Until BloomCore Technologies confirms the
 *   final public domain, this is the temporary Render hostname. Set SITE_URL
 *   (server-side) or NEXT_PUBLIC_SITE_URL to the real domain when it exists —
 *   the sitemap, Open Graph URLs and metadata base all follow it. Canonical
 *   <link> tags are only emitted when a domain is configured, so this
 *   deployment never claims to be the canonical home of the brand.
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

const TEMPORARY_DEPLOYMENT_URL =
  "https://bloomcore-one.onrender.com";

function readEnv(value: string | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

/** Configured public origin, or the current temporary deployment origin. */
export const SITE_URL = (
  readEnv(process.env.SITE_URL) ??
  readEnv(process.env.NEXT_PUBLIC_SITE_URL) ??
  TEMPORARY_DEPLOYMENT_URL
).replace(/\/+$/, "");

/** True while the origin above is the temporary hosting URL, not a real domain. */
export const SITE_URL_IS_PROVISIONAL =
  !readEnv(process.env.SITE_URL) && !readEnv(process.env.NEXT_PUBLIC_SITE_URL);

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

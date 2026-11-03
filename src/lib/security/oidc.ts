import { createHash, createHmac, randomBytes, timingSafeEqual } from "crypto";
import {
  createRemoteJWKSet,
  customFetch,
  decodeJwt,
  jwtVerify,
} from "jose";
import { db } from "../db";
import {
  createPlatformAuditLog,
  PLATFORM_AUDIT_ACTIONS,
} from "../platform-audit";
import { decryptSecret, encryptSecret } from "./crypto";

/**
 * ============================================================================
 * PLATFORM OIDC SSO — BloomCore Identity (Control Center / Authentik)
 * ============================================================================
 *
 * Node-runtime only. NOTHING in this module may be imported by middleware
 * (Edge runtime) or by a client component.
 *
 * Design (docs/SSO-INTEGRATION.md):
 *   * Authorization Code + PKCE (S256). State, nonce and verifier travel in a
 *     short-lived HMAC-protected cookie scoped to /platform/login/sso; the
 *     cookie is deleted at the callback, which makes every flow single-use.
 *   * The ID token is validated against the IdP's JWKS: exact issuer match,
 *     aud == client_id, exp/iat leeway 30s, nonce single-use (bound to the
 *     flow cookie that was just consumed).
 *   * Authorisation is delegated to the Control Center linking registry:
 *     resolve → none | pending | verified. A local PlatformOidcLink row is the
 *     product-side mirror; it is created only via `verified` or after the
 *     administrator proves their CURRENT local password (`pending`).
 *   * The native platform session is minted through setPlatformSession(), so
 *     the token claims, cookie and SessionRecord registry are byte-identical
 *     to a local login. Nothing about the platform boundary changes except the
 *     credential presentation.
 *   * Feature-flagged by PLATFORM_OIDC_ENABLED; default OFF = zero change.
 */

export const PRODUCT_SLUG = "bloomcore-one";

export const OIDC_FLOW_COOKIE = "bik-platform-oidc-flow";
/** Flow + attempt lifetime. Short on purpose. */
export const OIDC_FLOW_TTL_SECONDS = 600;
export const OIDC_CLOCK_TOLERANCE_SECONDS = 30;

const DISCOVERY_CACHE_MS = 5 * 60 * 1000;

export interface OidcConfig {
  enabled: boolean;
  issuer: string;
  clientId: string;
  clientSecret: string;
  ccBase: string;
  ccApiKey: string;
  scopes: string[];
  complete: boolean;
}

/** Read the (env-prefixed) SSO configuration on every call so tests and ops can toggle it. */
export function getOidcConfig(): OidcConfig {
  const enabled =
    ["1", "true", "yes", "on"].includes(
      (process.env.PLATFORM_OIDC_ENABLED ?? "").trim().toLowerCase()
    ) === true;
  const issuer = (process.env.PLATFORM_OIDC_ISSUER ?? "").trim();
  const clientId = (process.env.PLATFORM_OIDC_CLIENT_ID ?? "").trim();
  const clientSecret = (process.env.PLATFORM_OIDC_CLIENT_SECRET ?? "").trim();
  const ccBase = (process.env.PLATFORM_OIDC_CC_BASE ?? "").trim().replace(/\/+$/, "");
  const ccApiKey = (process.env.PLATFORM_OIDC_CC_API_KEY ?? "").trim();
  const scopes = (process.env.PLATFORM_OIDC_SCOPES ?? "openid email profile")
    .split(" ")
    .map((s) => s.trim())
    .filter(Boolean);
  return {
    enabled,
    issuer,
    clientId,
    clientSecret,
    ccBase,
    ccApiKey,
    scopes,
    complete: Boolean(issuer && clientId && clientSecret && ccBase && ccApiKey),
  };
}

export function oidcEnabled(): boolean {
  const config = getOidcConfig();
  return config.enabled && config.complete;
}

/**
 * The redirect URI registered with the Identity Provider. Defaults to the
 * request origin; override with PLATFORM_OIDC_REDIRECT_URI when the app sits
 * behind a proxy that rewrites the Host header.
 */
export function ssoRedirectUri(requestOrigin: string): string {
  return (
    process.env.PLATFORM_OIDC_REDIRECT_URI?.trim() ||
    `${requestOrigin}/platform/login/sso/callback`
  );
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

export interface OidcDiscovery {
  authorization_endpoint: string;
  token_endpoint: string;
  jwks_uri: string;
  revocation_endpoint?: string;
  issuer: string;
}

let discoveryCache: { value: OidcDiscovery; fetchedAt: number } | null = null;

export function issuerUrl(issuer: string): string {
  return issuer.endsWith("/") ? issuer : `${issuer}/`;
}

export async function fetchDiscovery(
  issuer: string,
  fetchImpl: typeof fetch = fetch
): Promise<OidcDiscovery> {
  if (discoveryCache && Date.now() - discoveryCache.fetchedAt < DISCOVERY_CACHE_MS) {
    return discoveryCache.value;
  }
  const url = `${issuerUrl(issuer)}.well-known/openid-configuration`;
  const res = await fetchImpl(url, { cache: "no-store" });
  if (!res.ok) throw new Error(`OIDC discovery failed (${res.status})`);
  const doc = (await res.json()) as OidcDiscovery;
  // Exact issuer match on discovery itself (mixed-IdP downgrade guard).
  if (doc.issuer !== issuer && doc.issuer !== issuerUrl(issuer)) {
    throw new Error("OIDC discovery issuer mismatch");
  }
  discoveryCache = { value: doc, fetchedAt: Date.now() };
  return doc;
}

export function clearDiscoveryCache(): void {
  discoveryCache = null;
}

// ---------------------------------------------------------------------------
// Flow cookie — HMAC-protected, single-use, scoped to /platform/login/sso
// ---------------------------------------------------------------------------

export interface OidcFlow {
  state: string;
  nonce: string;
  verifier: string;
  iat: number;
}

/** Server-only HMAC key derived from JWT_SECRET (never the secret itself). */
function flowKey(): Uint8Array {
  const base = process.env.JWT_SECRET;
  if (!base) throw new Error("JWT_SECRET is required for the OIDC flow cookie");
  return new Uint8Array(
    createHash("sha256").update(`${base}:platform-oidc-flow`).digest()
  );
}

export function signOidcBlob(payload: object): string {
  const body = Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
  const sig = createHmac("sha256", flowKey()).update(body).digest("base64url");
  return `${body}.${sig}`;
}

export function verifyOidcBlob<T>(blob: string | undefined | null): T | null {
  if (!blob) return null;
  const dot = blob.lastIndexOf(".");
  if (dot <= 0) return null;
  const body = blob.slice(0, dot);
  const sig = blob.slice(dot + 1);
  const expected = createHmac("sha256", flowKey()).update(body).digest("base64url");
  const a = Buffer.from(sig);
  const b = Buffer.from(expected);
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  try {
    return JSON.parse(Buffer.from(body, "base64url").toString("utf8")) as T;
  } catch {
    return null;
  }
}

export function newOidcFlow(): OidcFlow {
  return {
    state: randomBytes(24).toString("base64url"),
    nonce: randomBytes(24).toString("base64url"),
    verifier: randomBytes(48).toString("base64url"),
    iat: Math.floor(Date.now() / 1000),
  };
}

export function pkceChallenge(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function flowExpired(flow: OidcFlow, now = Math.floor(Date.now() / 1000)): boolean {
  return now - flow.iat > OIDC_FLOW_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// Pending-link attempt token (confirm-password step)
// ---------------------------------------------------------------------------

export interface OidcAttempt {
  sub: string; // IdP subject from the Control Center resolve response
  idpEmail: string; // email asserted by the IdP
  ccEmail: string | null; // Control Center identity email
  issuer: string;
  iat: number;
  jti: string;
}

export function newOidcAttempt(input: Omit<OidcAttempt, "iat" | "jti">): OidcAttempt {
  return {
    ...input,
    iat: Math.floor(Date.now() / 1000),
    jti: randomBytes(16).toString("base64url"),
  };
}

export function attemptExpired(
  attempt: OidcAttempt,
  now = Math.floor(Date.now() / 1000)
): boolean {
  return now - attempt.iat > OIDC_FLOW_TTL_SECONDS;
}

// ---------------------------------------------------------------------------
// ID token validation (RS/PS/ES against the IdP JWKS)
// ---------------------------------------------------------------------------

const ALLOWED_ALGS = ["RS256", "RS384", "RS512", "ES256", "ES384", "PS256"];

export interface IdTokenClaims {
  iss?: string;
  aud?: string | string[];
  sub?: string;
  exp?: number;
  iat?: number;
  nonce?: string;
  email?: string;
  email_verified?: boolean;
  amr?: string | string[];
  azp?: string;
  [key: string]: unknown;
}

export type IdTokenFailure =
  | "malformed"
  | "signature"
  | "issuer"
  | "audience"
  | "expired"
  | "nonce"
  | "email";

export type IdTokenResult =
  | { ok: true; claims: IdTokenClaims }
  | { ok: false; reason: IdTokenFailure };

export async function validateIdToken(
  idToken: string,
  jwksUri: string,
  expected: { issuer: string; clientId: string; nonce?: string },
  fetchImpl: typeof fetch = fetch
): Promise<IdTokenResult> {
  const jwks = createRemoteJWKSet(new URL(jwksUri), {
    [customFetch]: fetchImpl as never,
  });
  try {
    const { payload } = await jwtVerify(idToken, jwks, {
      issuer: expected.issuer,
      audience: expected.clientId,
      clockTolerance: OIDC_CLOCK_TOLERANCE_SECONDS,
      algorithms: ALLOWED_ALGS,
    });
    const claims = payload as unknown as IdTokenClaims;
    if (!claims.sub) return { ok: false, reason: "malformed" };
    if (expected.nonce && claims.nonce !== expected.nonce) {
      return { ok: false, reason: "nonce" };
    }
    if (claims.email_verified === false || !claims.email) {
      if (process.env.PLATFORM_OIDC_DEBUG) {
        console.error(
          "[SSO DEBUG] id token missing/ unverified email:",
          Object.keys(claims),
          { email: claims.email, email_verified: claims.email_verified, sub: claims.sub }
        );
      }
      return { ok: false, reason: "email" };
    }
    return { ok: true, claims };
  } catch (error) {
    const code = (error as { code?: string })?.code;
    if (code === "ERR_JWT_EXPIRED") return { ok: false, reason: "expired" };
    if (code === "ERR_JWS_SIGNATURE_VERIFICATION_FAILED") {
      return { ok: false, reason: "signature" };
    }
    if (code === "ERR_JWT_CLAIM_VALIDATION_FAILED") {
      // Distinguish wrong issuer from wrong audience by decoding the claims
      // (signature was already proven valid at this point).
      try {
        const decoded = decodeJwt(idToken) as IdTokenClaims;
        if (decoded.iss !== expected.issuer) return { ok: false, reason: "issuer" };
        return { ok: false, reason: "audience" };
      } catch {
        return { ok: false, reason: "malformed" };
      }
    }
    if (process.env.PLATFORM_OIDC_DEBUG) {
      const { decodeProtectedHeader } = await import("jose");
      console.error(
        "[SSO DEBUG] id token validation failed:",
        error,
        "header:",
        decodeProtectedHeader(idToken)
      );
    }
    return { ok: false, reason: "malformed" };
  }
}

/** Normalised amr array from an ID token (string or array form). */
export function idpAmr(claims: IdTokenClaims): string[] {
  if (Array.isArray(claims.amr)) return claims.amr.map(String);
  if (typeof claims.amr === "string") return [claims.amr];
  return [];
}

/**
 * Does the IdP-attested amr contain a second factor? Matches TOTP/WebAuthn/
 * recovery-style methods; "password"/"pwd" alone never counts.
 */
export function amrHasSecondFactor(amr: string[]): boolean {
  return amr.some((method) =>
    /(^|[_-])(mfa|otp|totp|webauthn|fido|recovery)([_-]|$)/i.test(method)
  );
}

// ---------------------------------------------------------------------------
// Token exchange
// ---------------------------------------------------------------------------

export interface TokenResponse {
  id_token: string;
  access_token?: string;
  refresh_token?: string;
  token_type?: string;
  expires_in?: number;
}

export async function exchangeCode(
  discovery: OidcDiscovery,
  config: OidcConfig,
  params: {
    code: string;
    redirectUri: string;
    verifier: string;
  },
  fetchImpl: typeof fetch = fetch
): Promise<TokenResponse | null> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: params.redirectUri,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: params.verifier,
  });
  try {
    const res = await fetchImpl(discovery.token_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
      cache: "no-store",
    });
    if (!res.ok) return null;
    return (await res.json()) as TokenResponse;
  } catch {
    return null;
  }
}

export function authorizeUrl(
  discovery: OidcDiscovery,
  config: OidcConfig,
  flow: OidcFlow,
  redirectUri: string
): string {
  const url = new URL(discovery.authorization_endpoint);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", redirectUri);
  url.searchParams.set("scope", config.scopes.join(" "));
  url.searchParams.set("state", flow.state);
  url.searchParams.set("nonce", flow.nonce);
  url.searchParams.set("code_challenge", pkceChallenge(flow.verifier));
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

// ---------------------------------------------------------------------------
// Control Center linking client
// ---------------------------------------------------------------------------

export type LinkStatus = "none" | "pending" | "verified";

export interface ResolveResult {
  status: LinkStatus;
  identity_sub: string | null;
  email: string | null;
}

export async function resolveLinking(
  config: OidcConfig,
  email: string,
  fetchImpl: typeof fetch = fetch
): Promise<ResolveResult | null> {
  try {
    const url = `${config.ccBase}/api/v1/products/${PRODUCT_SLUG}/linking/resolve?email=${encodeURIComponent(email)}`;
    const res = await fetchImpl(url, {
      headers: { "x-product-key": config.ccApiKey },
      cache: "no-store",
    });
    if (!res.ok) return null;
    const data = (await res.json()) as Record<string, unknown>;
    const status = data.status;
    if (status !== "none" && status !== "pending" && status !== "verified") return null;
    return {
      status,
      identity_sub: typeof data.identity_sub === "string" ? data.identity_sub : null,
      email: typeof data.email === "string" ? data.email : null,
    };
  } catch {
    return null;
  }
}

/**
 * Build the HMAC-SHA256 linking proof expected by the Control Center
 * (POST /api/v1/products/bloomcore-one/linking/confirm with {payload, signature}).
 * The signature covers the EXACT payload bytes.
 */
export function buildLinkingProof(
  config: OidcConfig,
  proof: { identitySub: string; ccEmail: string; productAdminEmail: string }
): { payload: string; signature: string } {
  const payload = JSON.stringify({
    product: PRODUCT_SLUG,
    identity_sub: proof.identitySub,
    email: proof.ccEmail,
    product_admin_email: proof.productAdminEmail,
    ts: Math.floor(Date.now() / 1000),
  });
  const signature = createHmac("sha256", config.ccApiKey)
    .update(payload, "utf8")
    .digest("hex");
  return { payload, signature };
}

export async function confirmLinking(
  config: OidcConfig,
  proof: { identitySub: string; ccEmail: string; productAdminEmail: string },
  fetchImpl: typeof fetch = fetch
): Promise<boolean> {
  try {
    const body = buildLinkingProof(config, proof);
    const res = await fetchImpl(
      `${config.ccBase}/api/v1/products/${PRODUCT_SLUG}/linking/confirm`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
        cache: "no-store",
      }
    );
    return res.ok;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// SSO session companions (refresh token for central logout revocation)
// ---------------------------------------------------------------------------

export async function storeSsoRefreshToken(
  jti: string,
  platformAdminId: string,
  refreshToken: string | undefined,
  expiresAt: Date
): Promise<void> {
  await db.platformOidcSession.create({
    data: {
      id: jti,
      platformAdminId,
      refreshTokenEnc: refreshToken ? encryptSecret(refreshToken) : null,
      expiresAt,
    },
  });
}

/** Best-effort revocation of the IdP refresh token for a logged-out SSO session. */
export async function revokeIdpRefreshToken(
  jti: string,
  fetchImpl: typeof fetch = fetch
): Promise<void> {
  try {
    const row = await db.platformOidcSession.findUnique({ where: { id: jti } });
    if (!row) return;
    await db.platformOidcSession.delete({ where: { id: jti } }).catch(() => undefined);
    const refreshToken = row.refreshTokenEnc ? decryptSecret(row.refreshTokenEnc) : null;
    if (!refreshToken) return;
    const config = getOidcConfig();
    if (!oidcEnabled()) return;
    const discovery = await fetchDiscovery(config.issuer, fetchImpl);
    if (!discovery.revocation_endpoint) return;
    await fetchImpl(discovery.revocation_endpoint, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        token: refreshToken,
        client_id: config.clientId,
        client_secret: config.clientSecret,
      }),
      cache: "no-store",
    });
  } catch {
    // Best effort: local logout already succeeded; central revocation must
    // never block or fail the platform logout.
  }
}

// ---------------------------------------------------------------------------
// Audit helpers
// ---------------------------------------------------------------------------

export async function auditSsoEvent(
  action:
    | typeof PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_START
    | typeof PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_SUCCESS
    | typeof PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_DENIED
    | typeof PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_CREATED
    | typeof PLATFORM_AUDIT_ACTIONS.PLATFORM_SSO_LINK_FAILED,
  params: {
    actorId?: string | null;
    actorEmail?: string | null;
    entityType?: string | null;
    entityId?: string | null;
    details?: Record<string, unknown> | null;
    reason?: string | null;
    ipAddress?: string | null;
  } = {}
): Promise<void> {
  await createPlatformAuditLog({
    action,
    entityType: "platform_sso",
    ...params,
  });
}

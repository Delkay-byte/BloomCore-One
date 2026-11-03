/**
 * BIK Prestige Enterprise — Platform OIDC SSO tests.
 *
 * Covers:
 *   * ID token validation against a synthetic RSA JWKS (signature, issuer,
 *     audience, expiry, nonce, email)
 *   * Flow cookie HMAC integrity
 *   * Callback flows against a fake IdP + fake Control Center:
 *       verified link → native session + SessionRecord + refresh companion
 *       unlinked      → denied, no session
 *       pending       → confirm flow (password proof) → link + signed CC proof
 *       pwd-only amr with MFA_ENFORCEMENT=enforce → denied
 *   * Local platform login keeps working alongside SSO
 */

import {
  describe,
  it,
  expect,
  beforeAll,
  afterAll,
  beforeEach,
  afterEach,
  vi,
} from "vitest";
import { SignJWT, exportJWK, generateKeyPair } from "jose";
import { createHmac } from "crypto";
import bcrypt from "bcryptjs";
import { prisma, cleanDatabase } from "./setup";

const { mockCookieStore } = vi.hoisted(() => ({
  mockCookieStore: new Map<string, string>(),
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: (name: string) =>
      mockCookieStore.has(name)
        ? { name, value: mockCookieStore.get(name)! }
        : undefined,
    set: (name: string, value: string) => {
      mockCookieStore.set(name, value);
    },
    delete: (name: string) => {
      mockCookieStore.delete(name);
    },
  }),
  headers: async () => ({ get: () => null }),
}));

vi.mock("next/navigation", () => ({
  redirect: (path: string) => {
    throw new Error(`REDIRECT:${path}`);
  },
}));

import { GET as callbackGet } from "@/app/platform/login/sso/callback/route";
import { GET as startGet } from "@/app/platform/login/sso/start/route";
import { confirmPlatformSsoLink } from "@/app/platform/login/sso/confirm/actions";
import {
  OIDC_FLOW_COOKIE,
  getOidcConfig,
  newOidcFlow,
  signOidcBlob,
  verifyOidcBlob,
  validateIdToken,
  amrHasSecondFactor,
  clearDiscoveryCache,
  type OidcAttempt,
  type OidcFlow,
} from "@/lib/security/oidc";
import {
  getPlatformSession,
  verifyPlatformToken,
  PLATFORM_COOKIE,
} from "@/lib/platform-auth";

// ---------------------------------------------------------------------------
// Fake IdP / Control Center
// ---------------------------------------------------------------------------

const ISSUER = "http://localhost:9000/application/o/bloomcore-one/";
const CLIENT_ID = "bloomcore-one-sso";
const CLIENT_SECRET = "test-client-secret";
const CC_BASE = "http://cc.test";
const CC_API_KEY = "cc-product-key-for-tests-0123456789abcdef";

const { privateKey, publicKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const { privateKey: otherPrivateKey } = await generateKeyPair("RS256", {
  extractable: true,
});
const publicJwk = {
  kid: "test-key",
  alg: "RS256",
  use: "sig",
  ...(await exportJWK(publicKey)),
};
const JWKS = { keys: [publicJwk] };

const DISCOVERY = {
  issuer: ISSUER,
  authorization_endpoint: `${ISSUER}authorize/`,
  token_endpoint: `${ISSUER}token/`,
  jwks_uri: `${ISSUER}jwks/`,
  revocation_endpoint: `${ISSUER}revoke/`,
};

let ccResolveResponse: Record<string, unknown> = { status: "none" };
let ccResolveCalls: string[] = [];
let ccConfirmCalls: { payload: string; signature: string }[] = [];
let tokenEndpointCalls: URLSearchParams[] = [];
let idTokenFactory: (() => Promise<string>) | null = null;

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

const fetchMock = vi.fn(
  async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.endsWith(".well-known/openid-configuration")) {
      return jsonResponse(DISCOVERY);
    }
    if (url === DISCOVERY.jwks_uri) {
      return jsonResponse(JWKS);
    }
    if (url === DISCOVERY.token_endpoint) {
      const raw = init?.body;
      const form =
        typeof raw === "string"
          ? new URLSearchParams(raw)
          : (raw as URLSearchParams);
      tokenEndpointCalls.push(form);
      if (idTokenFactory) {
        return jsonResponse({
          id_token: await idTokenFactory(),
          refresh_token: "rt-123456",
          access_token: "at-1",
        });
      }
      return jsonResponse({ error: "server_error" }, 500);
    }
    if (
      url.startsWith(
        `${CC_BASE}/api/v1/products/bloomcore-one/linking/resolve`
      )
    ) {
      ccResolveCalls.push(url);
      return jsonResponse(ccResolveResponse);
    }
    if (url === `${CC_BASE}/api/v1/products/bloomcore-one/linking/confirm`) {
      const parsed = JSON.parse(String(init?.body)) as {
        payload: string;
        signature: string;
      };
      ccConfirmCalls.push(parsed);
      return jsonResponse({ status: "verified" });
    }
    if (url === DISCOVERY.revocation_endpoint) {
      return jsonResponse({}, 200);
    }
    return new Response("not found", { status: 404 });
  }
);

const now = Math.floor(Date.now() / 1000);

async function mintIdToken(claims: Record<string, unknown>): Promise<string> {
  return new SignJWT({
    iss: ISSUER,
    aud: CLIENT_ID,
    iat: now,
    exp: now + 300,
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "test-key" })
    .setIssuedAt(now)
    .setExpirationTime(`${5}m`)
    .sign(privateKey);
}

let adminCounter = 0;
async function createPlatformAdmin(
  options: { email?: string; status?: string; password?: string } = {}
) {
  adminCounter++;
  return prisma.platformSuperAdmin.create({
    data: {
      email: options.email ?? `owner-${adminCounter}-${Date.now()}@bloomcore.test`,
      fullName: "BloomCore Owner",
      passwordHash: await bcrypt.hash(options.password ?? "SuperPass123", 10),
      status: options.status ?? "active",
    },
  });
}

async function createLink(adminId: string, sub: string) {
  return prisma.platformOidcLink.create({
    data: {
      platformAdminId: adminId,
      issuer: ISSUER,
      idpSub: sub,
      linkedVia: "cc_verified",
      createdBy: adminId,
    },
  });
}

/** Run the start route, plant the flow cookie, return (response, flow). */
async function runStart(): Promise<{ response: Response; flow: OidcFlow }> {
  const response = await startGet(
    new Request("http://localhost:3100/platform/login/sso/start")
  );
  const setCookie = response.headers.get("set-cookie") ?? "";
  const value = setCookie.split(";")[0]?.split("=").slice(1).join("=");
  const flow = verifyOidcBlob<OidcFlow>(value);
  if (value && flow) mockCookieStore.set(OIDC_FLOW_COOKIE, value);
  return { response, flow: flow! };
}

/** Drive the callback as if the IdP redirected back with `code`. */
async function runCallback(code = "auth-code-1"): Promise<Response> {
  const flowValue = mockCookieStore.get(OIDC_FLOW_COOKIE)!;
  const flow = verifyOidcBlob<OidcFlow>(flowValue)!;
  const request = new Request(
    `http://localhost:3100/platform/login/sso/callback?code=${code}&state=${flow.state}`
  );
  // Default ID token unless a test installed its own factory; always bound to
  // the flow nonce so validation passes.
  const previousFactory = idTokenFactory;
  idTokenFactory = () =>
    previousFactory
      ? previousFactory()
      : mintIdToken({
          sub: "idp-sub-1",
          email: "owner@bloomcore.test",
          email_verified: true,
          amr: ["password"],
          nonce: flow.nonce,
        });
  try {
    return await callbackGet(request);
  } finally {
    idTokenFactory = null;
  }
}

function redirectTarget(response: Response): string {
  return new Headers(response.headers).get("location") ?? "";
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

beforeAll(() => {
  process.env.PLATFORM_OIDC_ENABLED = "true";
  process.env.PLATFORM_OIDC_ISSUER = ISSUER;
  process.env.PLATFORM_OIDC_CLIENT_ID = CLIENT_ID;
  process.env.PLATFORM_OIDC_CLIENT_SECRET = CLIENT_SECRET;
  process.env.PLATFORM_OIDC_CC_BASE = CC_BASE;
  process.env.PLATFORM_OIDC_CC_API_KEY = CC_API_KEY;
  process.env.RATE_LIMIT_HMAC_SECRET ??= "test-rate-limit-key-not-for-prod-32b";
  process.env.MFA_ENCRYPTION_KEY ??= "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
});

afterAll(() => {
  delete process.env.PLATFORM_OIDC_ENABLED;
  delete process.env.PLATFORM_OIDC_ISSUER;
  delete process.env.PLATFORM_OIDC_CLIENT_ID;
  delete process.env.PLATFORM_OIDC_CLIENT_SECRET;
  delete process.env.PLATFORM_OIDC_CC_BASE;
  delete process.env.PLATFORM_OIDC_CC_API_KEY;
});

describe("Platform OIDC SSO", () => {
  beforeEach(async () => {
    mockCookieStore.clear();
    await cleanDatabase();
    clearDiscoveryCache();
    vi.stubGlobal("fetch", fetchMock);
    ccResolveResponse = { status: "none" };
    ccResolveCalls = [];
    ccConfirmCalls = [];
    tokenEndpointCalls = [];
  });

  afterEach(() => {
    delete process.env.MFA_ENFORCEMENT;
  });

  // ---------------------------------------------------------- ID token ----
  describe("ID token validation", () => {
    const validate = (token: string, nonce?: string) =>
      validateIdToken(token, DISCOVERY.jwks_uri, {
        issuer: ISSUER,
        clientId: CLIENT_ID,
        nonce,
      });

    it("accepts a valid token", async () => {
      const token = await mintIdToken({
        sub: "sub-1",
        email: "owner@bloomcore.test",
        email_verified: true,
        nonce: "n-1",
      });
      const result = await validate(token, "n-1");
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.claims.sub).toBe("sub-1");
        expect(result.claims.email).toBe("owner@bloomcore.test");
      }
    });

    it("rejects a token signed by an unknown key", async () => {
      const token = await new SignJWT({
        sub: "sub-1",
        email: "owner@bloomcore.test",
      })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt(now)
        .setExpirationTime("5m")
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .sign(otherPrivateKey);
      const result = await validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("signature");
    });

    it("rejects a wrong issuer", async () => {
      const token = await new SignJWT({ sub: "sub-1", email: "e@x.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt(now)
        .setExpirationTime("5m")
        .setIssuer("http://evil.example/")
        .setAudience(CLIENT_ID)
        .sign(privateKey);
      const result = await validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("issuer");
    });

    it("rejects a wrong audience", async () => {
      const token = await new SignJWT({ sub: "sub-1", email: "e@x.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt(now)
        .setExpirationTime("5m")
        .setIssuer(ISSUER)
        .setAudience("another-client")
        .sign(privateKey);
      const result = await validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("audience");
    });

    it("rejects an expired token", async () => {
      const token = await new SignJWT({ sub: "sub-1", email: "e@x.test" })
        .setProtectedHeader({ alg: "RS256", kid: "test-key" })
        .setIssuedAt(now - 3600)
        .setExpirationTime(now - 1800)
        .setIssuer(ISSUER)
        .setAudience(CLIENT_ID)
        .sign(privateKey);
      const result = await validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("expired");
    });

    it("rejects a nonce mismatch", async () => {
      const token = await mintIdToken({
        sub: "sub-1",
        email: "e@x.test",
        nonce: "expected",
      });
      const result = await validate(token, "different");
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("nonce");
    });

    it("rejects an unverified email", async () => {
      const token = await mintIdToken({
        sub: "sub-1",
        email: "e@x.test",
        email_verified: false,
      });
      const result = await validate(token);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.reason).toBe("email");
    });

    it("classifies amr second factors", () => {
      expect(amrHasSecondFactor(["password"])).toBe(false);
      expect(amrHasSecondFactor(["pwd"])).toBe(false);
      expect(amrHasSecondFactor(["password", "mfa"])).toBe(true);
      expect(amrHasSecondFactor(["mfa_totp"])).toBe(true);
      expect(amrHasSecondFactor(["webauthn"])).toBe(true);
    });
  });

  // ------------------------------------------------------------ flow cookie
  it("rejects a tampered flow cookie", () => {
    const flow = newOidcFlow();
    const blob = signOidcBlob(flow);
    expect(verifyOidcBlob<OidcFlow>(blob)).toMatchObject({ state: flow.state });
    const tampered = `${blob.slice(0, -4)}AAAA`;
    expect(verifyOidcBlob<OidcFlow>(tampered)).toBeNull();
    expect(verifyOidcBlob<OidcFlow>("garbage")).toBeNull();
  });

  // --------------------------------------------------------------- flag off
  it("returns 404 when the feature flag is off", async () => {
    process.env.PLATFORM_OIDC_ENABLED = "false";
    try {
      const start = await startGet(
        new Request("http://localhost:3100/platform/login/sso/start")
      );
      expect(start.status).toBe(404);
      const cb = await callbackGet(
        new Request("http://localhost:3100/platform/login/sso/callback?code=x&state=y")
      );
      expect(cb.status).toBe(404);
    } finally {
      process.env.PLATFORM_OIDC_ENABLED = "true";
    }
  });

  // ---------------------------------------------------------- start route
  it("start redirects 303 to the IdP with PKCE and sets the flow cookie", async () => {
    const { response, flow } = await runStart();
    expect(response.status).toBe(303);
    const target = redirectTarget(response);
    expect(target.startsWith(DISCOVERY.authorization_endpoint)).toBe(true);
    const url = new URL(target);
    expect(url.searchParams.get("client_id")).toBe(CLIENT_ID);
    expect(url.searchParams.get("code_challenge_method")).toBe("S256");
    expect(url.searchParams.get("state")).toBe(flow.state);
    expect(url.searchParams.get("nonce")).toBe(flow.nonce);
    expect(url.searchParams.get("redirect_uri")).toBe(
      "http://localhost:3100/platform/login/sso/callback"
    );
    const audit = await prisma.platformAuditLog.findFirst({
      where: { action: "platform.sso_start" },
    });
    expect(audit).not.toBeNull();
  });

  // -------------------------------------------------- verified link path ---
  it("mints a native platform session for a verified link", async () => {
    const admin = await createPlatformAdmin({ email: "owner@bloomcore.test" });
    await createLink(admin.id, "idp-sub-1");
    ccResolveResponse = {
      status: "verified",
      identity_sub: "idp-sub-1",
      email: "owner@bloomcore.test",
    };

    await runStart();
    const response = await runCallback();

    expect(response.status).toBe(303);
    expect(redirectTarget(response)).toBe("http://localhost:3100/platform/dashboard");
    expect(tokenEndpointCalls).toHaveLength(1);

    // Native session: exact existing claims, DB-registered, resolvable.
    const token = mockCookieStore.get(PLATFORM_COOKIE);
    expect(token).toBeTruthy();
    const payload = await verifyPlatformToken(token!);
    expect(payload?.kind).toBe("platform");
    expect(payload?.adminId).toBe(admin.id);
    expect(payload?.tokenUse).toBe("platform");
    expect(payload?.amr).toBe("pwd");
    expect(payload?.idpAmr).toEqual(["password"]);

    const session = await getPlatformSession();
    expect(session?.adminId).toBe(admin.id);

    const record = await prisma.sessionRecord.findUnique({
      where: { id: payload!.jti! },
    });
    expect(record?.subjectType).toBe("platform");
    expect(record?.revokedAt).toBeNull();

    const companion = await prisma.platformOidcSession.findUnique({
      where: { id: payload!.jti! },
    });
    expect(companion?.refreshTokenEnc).toContain(":");

    const success = await prisma.platformAuditLog.findFirst({
      where: { action: "platform.sso_success" },
    });
    expect(success?.actorEmail).toBe("owner@bloomcore.test");
  });

  it("maps an IdP second factor to pwd+mfa and survives MFA enforcement", async () => {
    const admin = await createPlatformAdmin({ email: "owner@bloomcore.test" });
    await createLink(admin.id, "idp-sub-1");
    ccResolveResponse = {
      status: "verified",
      identity_sub: "idp-sub-1",
      email: "owner@bloomcore.test",
    };
    process.env.MFA_ENFORCEMENT = "enforce";
    idTokenFactory = async () => {
      const flowValue = mockCookieStore.get(OIDC_FLOW_COOKIE)!;
      const flow = verifyOidcBlob<OidcFlow>(flowValue)!;
      return mintIdToken({
        sub: "idp-sub-1",
        email: "owner@bloomcore.test",
        email_verified: true,
        amr: ["password", "mfa"],
        nonce: flow.nonce,
      });
    };

    await runStart();
    const response = await runCallback();

    expect(redirectTarget(response)).toBe("http://localhost:3100/platform/dashboard");
    const payload = await verifyPlatformToken(mockCookieStore.get(PLATFORM_COOKIE)!);
    expect(payload?.amr).toBe("pwd+mfa");
    const session = await getPlatformSession();
    expect(session?.adminId).toBe(admin.id);
  });

  it("denies a password-only IdP session while MFA_ENFORCEMENT=enforce", async () => {
    const admin = await createPlatformAdmin({ email: "owner@bloomcore.test" });
    await createLink(admin.id, "idp-sub-1");
    ccResolveResponse = {
      status: "verified",
      identity_sub: "idp-sub-1",
      email: "owner@bloomcore.test",
    };
    process.env.MFA_ENFORCEMENT = "enforce";

    await runStart();
    const response = await runCallback();

    expect(redirectTarget(response)).toBe(
      "http://localhost:3100/platform/login?error=sso_mfa_required"
    );
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);
    const denied = await prisma.platformAuditLog.findFirst({
      where: { action: "platform.sso_denied", reason: "mfa_required" },
    });
    expect(denied).not.toBeNull();
  });

  // ---------------------------------------------------- unlinked (none) ----
  it("denies an unlinked identity without creating a session", async () => {
    await createPlatformAdmin({ email: "owner@bloomcore.test" });
    ccResolveResponse = { status: "none" };

    await runStart();
    const response = await runCallback();

    expect(redirectTarget(response)).toBe(
      "http://localhost:3100/platform/login?error=sso_not_authorised"
    );
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);
    expect(await prisma.sessionRecord.count()).toBe(0);
    const denied = await prisma.platformAuditLog.findFirst({
      where: { action: "platform.sso_denied", reason: "not_authorised" },
    });
    expect(denied?.actorEmail).toBe("owner@bloomcore.test");
  });

  it("denies a suspended platform administrator on a verified link", async () => {
    const admin = await createPlatformAdmin({
      email: "owner@bloomcore.test",
      status: "inactive",
    });
    await createLink(admin.id, "idp-sub-1");
    ccResolveResponse = {
      status: "verified",
      identity_sub: "idp-sub-1",
      email: "owner@bloomcore.test",
    };

    await runStart();
    const response = await runCallback();
    expect(redirectTarget(response)).toBe(
      "http://localhost:3100/platform/login?error=sso_not_authorised"
    );
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);
  });

  // ------------------------------------------------------- pending path ----
  it("routes a pending association to the confirm step", async () => {
    await createPlatformAdmin({ email: "owner@bloomcore.test" });
    ccResolveResponse = {
      status: "pending",
      identity_sub: "cc-sub-77",
      email: "owner@bloomcore.test",
    };

    await runStart();
    const response = await runCallback();

    const target = new URL(redirectTarget(response));
    expect(target.pathname).toBe("/platform/login/sso/confirm");
    const attempt = verifyOidcBlob<OidcAttempt>(target.searchParams.get("attempt"));
    expect(attempt?.sub).toBe("cc-sub-77");
    expect(attempt?.idpEmail).toBe("owner@bloomcore.test");
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);
  });

  it("confirm creates the link and sends a valid HMAC proof to the Control Center", async () => {
    const admin = await createPlatformAdmin({ email: "owner@bloomcore.test" });
    const attemptToken = signOidcBlob({
      sub: "cc-sub-77",
      idpEmail: "owner@bloomcore.test",
      ccEmail: "owner@bloomcore.test",
      issuer: ISSUER,
      iat: now,
      jti: "attempt-1",
    } satisfies OidcAttempt);

    const formData = new FormData();
    formData.set("attempt", attemptToken);
    formData.set("password", "SuperPass123");

    await expect(confirmPlatformSsoLink(formData)).rejects.toThrow(
      "REDIRECT:/platform/login?notice=sso_linked"
    );

    const link = await prisma.platformOidcLink.findUnique({
      where: { idpSub: "cc-sub-77" },
    });
    expect(link?.platformAdminId).toBe(admin.id);
    expect(link?.linkedVia).toBe("local_credential_proof");

    expect(ccConfirmCalls).toHaveLength(1);
    const { payload, signature } = ccConfirmCalls[0];
    const expected = createHmac("sha256", CC_API_KEY).update(payload, "utf8").digest("hex");
    expect(signature).toBe(expected);
    const proof = JSON.parse(payload);
    expect(proof.product).toBe("bloomcore-one");
    expect(proof.identity_sub).toBe("cc-sub-77");
    expect(proof.product_admin_email).toBe("owner@bloomcore.test");

    const created = await prisma.platformAuditLog.findFirst({
      where: { action: "platform.sso_link_created" },
    });
    expect(created?.actorEmail).toBe("owner@bloomcore.test");
  });

  it("confirm rejects a wrong password without linking", async () => {
    await createPlatformAdmin({ email: "owner@bloomcore.test" });
    const attemptToken = signOidcBlob({
      sub: "cc-sub-77",
      idpEmail: "owner@bloomcore.test",
      ccEmail: "owner@bloomcore.test",
      issuer: ISSUER,
      iat: now,
      jti: "attempt-2",
    } satisfies OidcAttempt);

    const formData = new FormData();
    formData.set("attempt", attemptToken);
    formData.set("password", "WrongPass1");

    await expect(confirmPlatformSsoLink(formData)).rejects.toThrow(
      /error=bad_password/
    );
    expect(await prisma.platformOidcLink.count()).toBe(0);
    expect(ccConfirmCalls).toHaveLength(0);
    const failed = await prisma.platformAuditLog.findFirst({
      where: { action: "platform.sso_link_failed", reason: "bad_password" },
    });
    expect(failed).not.toBeNull();
  });

  it("confirm rejects an IdP email with no matching local administrator", async () => {
    await createPlatformAdmin({ email: "someone-else@bloomcore.test" });
    const attemptToken = signOidcBlob({
      sub: "cc-sub-78",
      idpEmail: "intruder@bloomcore.test",
      ccEmail: "intruder@bloomcore.test",
      issuer: ISSUER,
      iat: now,
      jti: "attempt-3",
    } satisfies OidcAttempt);

    const formData = new FormData();
    formData.set("attempt", attemptToken);
    formData.set("password", "SuperPass123");

    await expect(confirmPlatformSsoLink(formData)).rejects.toThrow(
      "REDIRECT:/platform/login?error=sso_not_authorised"
    );
    expect(await prisma.platformOidcLink.count()).toBe(0);
  });

  it("confirm refuses an expired attempt token", async () => {
    await createPlatformAdmin({ email: "owner@bloomcore.test" });
    const attemptToken = signOidcBlob({
      sub: "cc-sub-79",
      idpEmail: "owner@bloomcore.test",
      ccEmail: "owner@bloomcore.test",
      issuer: ISSUER,
      iat: now - 3600,
      jti: "attempt-4",
    } satisfies OidcAttempt);

    const formData = new FormData();
    formData.set("attempt", attemptToken);
    formData.set("password", "SuperPass123");

    await expect(confirmPlatformSsoLink(formData)).rejects.toThrow(
      "REDIRECT:/platform/login?error=sso_attempt_expired"
    );
    expect(await prisma.platformOidcLink.count()).toBe(0);
  });

  // -------------------------------------------------------------- replay ---
  it("rejects a callback whose state does not match the flow", async () => {
    await createPlatformAdmin({ email: "owner@bloomcore.test" });
    ccResolveResponse = {
      status: "verified",
      identity_sub: "idp-sub-1",
      email: "owner@bloomcore.test",
    };
    await runStart();
    const request = new Request(
      "http://localhost:3100/platform/login/sso/callback?code=x&state=wrong-state"
    );
    const response = await callbackGet(request);
    expect(redirectTarget(response)).toBe(
      "http://localhost:3100/platform/login?error=sso_failed"
    );
    expect(mockCookieStore.has(PLATFORM_COOKIE)).toBe(false);
    expect(tokenEndpointCalls).toHaveLength(0);
  });

  it("rejects a tampered (unsigned) flow cookie at the callback", async () => {
    mockCookieStore.set(OIDC_FLOW_COOKIE, "bogus.sig");
    const response = await callbackGet(
      new Request(
        "http://localhost:3100/platform/login/sso/callback?code=x&state=y"
      )
    );
    expect(redirectTarget(response)).toBe(
      "http://localhost:3100/platform/login?error=sso_failed"
    );
  });

  // ------------------------------------------------- local login regress ---
  it("local platform login still works alongside a linked SSO account", async () => {
    const admin = await createPlatformAdmin({ email: "owner@bloomcore.test" });
    await createLink(admin.id, "idp-sub-1");

    // Direct session mint (the same path the local login action uses).
    const { setPlatformSession } = await import("@/lib/platform-auth");
    await setPlatformSession({
      adminId: admin.id,
      email: admin.email,
      fullName: admin.fullName,
      forcePasswordReset: false,
      tokenVersion: admin.tokenVersion,
      amr: "pwd",
    });
    const session = await getPlatformSession();
    expect(session?.email).toBe("owner@bloomcore.test");

    const credentials = await prisma.platformSuperAdmin.findUnique({
      where: { email: admin.email },
    });
    expect(
      await bcrypt.compare("SuperPass123", credentials!.passwordHash)
    ).toBe(true);
  });

  it("exposes a complete config reader", () => {
    const config = getOidcConfig();
    expect(config.enabled).toBe(true);
    expect(config.issuer).toBe(ISSUER);
    expect(config.complete).toBe(true);
  });
});

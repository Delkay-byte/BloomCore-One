import { afterEach, describe, expect, it, vi } from "vitest";
import {
  evaluateLocalLiveTest,
  liveTestAllowlist,
  parseTenantAllowlist,
  type LocalLiveTestEnvironment,
} from "@/lib/payments/local-live-test";
import {
  liveBlockedExplanation,
  liveCheckoutReadiness,
} from "@/lib/payments/live-readiness";
import { assertLiveChargePermitted, PaystackError } from "@/lib/payments/paystack";

/**
 * Local live-payment eligibility.
 *
 * Jane D Wholes is the approved local test workspace. These tests pin the
 * allowlist behaviour: her exact tenant id passes, every other tenant stays
 * blocked, and no other safeguard can be skipped by being on the list.
 */

const JANE_TENANT_ID = "cmwm8sr6i000bs4uaut0z7d4s";
const JANE_TENANT_CODE = "BT-6WSTJ8";
const OTHER_TENANT_ID = "cmwm7e9w00004guahl1f4717";
const LOOOPBACK = "http://localhost:3100";

function environment(overrides: Partial<LocalLiveTestEnvironment> = {}): LocalLiveTestEnvironment {
  return {
    keyMode: "live",
    nodeEnv: "development",
    localLiveTest: "true",
    enabled: "true",
    currency: "GHS",
    origin: LOOOPBACK,
    siteUrl: LOOOPBACK,
    databaseUrl: "file:./demo-verify.db",
    tenantId: JANE_TENANT_ID,
    tenantCode: JANE_TENANT_CODE,
    allowedTenants: [JANE_TENANT_ID, "LOCAL-LIVE-01"],
    designatedTenant: null,
    ...overrides,
  };
}

function stubLocalLive(overrides: Record<string, string | null> = {}): void {
  vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example_value");
  vi.stubEnv("PAYSTACK_ENABLED", "true");
  vi.stubEnv("PAYSTACK_CURRENCY", "GHS");
  vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
  vi.stubEnv("NODE_ENV", "development");
  vi.stubEnv("SITE_URL", LOOOPBACK);
  vi.stubEnv("DATABASE_URL", "file:./demo-verify.db");
  vi.stubEnv("PAYSTACK_LOCAL_LIVE_ALLOWED_TENANT_IDS", `${JANE_TENANT_ID},LOCAL-LIVE-01`);
  vi.stubEnv("PAYSTACK_LOCAL_TEST_TENANT", "");
  for (const [key, value] of Object.entries(overrides)) {
    vi.stubEnv(key, value ?? "");
  }
}

function refusalCode(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PaystackError) return error.code;
    throw error;
  }
  return "no_error";
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("allowlist parsing", () => {
  it("accepts comma, semicolon and whitespace separated identifiers", () => {
    expect(parseTenantAllowlist("a,b;c d")).toEqual(["a", "b", "c", "d"]);
  });

  it("trims, deduplicates and drops empty entries", () => {
    expect(parseTenantAllowlist(" a , ,a,, b ")).toEqual(["a", "b"]);
    expect(parseTenantAllowlist(null, undefined, [])).toEqual([]);
  });

  it("merges the new allowlist with the legacy single tenant variable", () => {
    stubLocalLive({ PAYSTACK_LOCAL_TEST_TENANT: "LOCAL-LIVE-01" });
    const list = liveTestAllowlist();
    expect(list).toContain(JANE_TENANT_ID);
    expect(list).toContain("LOCAL-LIVE-01");
  });

  it("keeps identifiers case-sensitive so a display name can never match", () => {
    expect(parseTenantAllowlist("Jane D Wholes")).toEqual(["Jane", "D", "Wholes"]);
    const decision = evaluateLocalLiveTest(
      environment({ allowedTenants: ["Jane D Wholes"], tenantId: JANE_TENANT_ID, tenantCode: JANE_TENANT_CODE })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("tenant_not_designated");
  });
});

describe("the local live decision with an allowlist", () => {
  it("allows Jane D Wholes by exact tenant id", () => {
    expect(evaluateLocalLiveTest(environment())).toEqual({ allowed: true, reasons: [] });
  });

  it("allows every explicitly listed local test tenant", () => {
    const second = "cmwm8sr6i000bs4uaut0z7d99";
    expect(
      evaluateLocalLiveTest(
        environment({ tenantId: second, tenantCode: "BT-SECOND", allowedTenants: [JANE_TENANT_ID, second] })
      ).allowed
    ).toBe(true);
  });

  it("keeps LOCAL-LIVE-01 working through the legacy variable", () => {
    const decision = evaluateLocalLiveTest(
      environment({
        tenantId: OTHER_TENANT_ID,
        tenantCode: "LOCAL-LIVE-01",
        allowedTenants: null,
        designatedTenant: "LOCAL-LIVE-01",
      })
    );
    expect(decision.allowed).toBe(true);
  });

  it("blocks a tenant that is not on the allowlist", () => {
    const decision = evaluateLocalLiveTest(
      environment({ tenantId: "cmwm73943000670ua98bqh10q", tenantCode: "DEMO-001" })
    );
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("tenant_not_designated");
  });

  it("blocks everybody when no allowlist is configured", () => {
    const decision = evaluateLocalLiveTest(
      environment({ allowedTenants: null, designatedTenant: null })
    );
    expect(decision.reasons).toContain("no_designated_tenant");
  });

  it("still requires a development process", () => {
    expect(evaluateLocalLiveTest(environment({ nodeEnv: "production" })).reasons).toContain(
      "not_development"
    );
    expect(evaluateLocalLiveTest(environment({ nodeEnv: "staging" })).reasons).toContain(
      "not_development"
    );
    expect(evaluateLocalLiveTest(environment({ nodeEnv: "test" })).reasons).toContain(
      "not_development"
    );
  });

  it("still refuses a hosted deployment marker", () => {
    vi.stubEnv("RENDER", "true");
    expect(evaluateLocalLiveTest(environment()).reasons).toContain("hosted_deployment");
  });

  it("still requires the explicit opt-in", () => {
    expect(evaluateLocalLiveTest(environment({ localLiveTest: undefined })).reasons).toContain(
      "local_live_test_not_enabled"
    );
    expect(evaluateLocalLiveTest(environment({ localLiveTest: "false" })).reasons).toContain(
      "local_live_test_not_enabled"
    );
  });

  it("still requires an isolated local database", () => {
    for (const databaseUrl of [
      "postgresql://u:p@ep-cool-1.neon.tech/db",
      "postgresql://u:p@dpg-abc.render.com/db",
      "postgresql://u:p@db.example.com/db",
      null,
    ]) {
      expect(evaluateLocalLiveTest(environment({ databaseUrl })).reasons).toContain(
        "database_not_local"
      );
    }
  });

  it("still requires loopback, GHS and an enabled provider", () => {
    expect(
      evaluateLocalLiveTest(environment({ origin: "https://maacash.bloomcoretech.com", siteUrl: null })).reasons
    ).toContain("origin_not_loopback");
    expect(evaluateLocalLiveTest(environment({ currency: "NGN" })).reasons).toContain(
      "currency_not_ghs"
    );
    expect(evaluateLocalLiveTest(environment({ enabled: "false" })).reasons).toContain(
      "payments_disabled"
    );
  });

  it("still refuses a test or unknown key", () => {
    expect(evaluateLocalLiveTest(environment({ keyMode: "test" })).reasons).toContain("key_not_live");
    expect(evaluateLocalLiveTest(environment({ keyMode: "unknown" })).reasons).toContain(
      "key_not_live"
    );
  });
});

describe("readiness reported to the billing page", () => {
  it("reports live checkout available for Jane D Wholes", () => {
    stubLocalLive();
    const readiness = liveCheckoutReadiness({
      tenantId: JANE_TENANT_ID,
      tenantCode: JANE_TENANT_CODE,
      origin: LOOOPBACK,
    });
    expect(readiness.enabled).toBe(true);
    expect(readiness.code).toBe("live_ready");
    expect(readiness.workspaceApproved).toBe(true);
    expect(readiness.message).toMatch(/checkout is available/i);
    expect(readiness.keyMode).toBe("live");
  });

  it("reports the workspace approval problem for a non-allowlisted tenant", () => {
    stubLocalLive();
    const readiness = liveCheckoutReadiness({
      tenantId: OTHER_TENANT_ID,
      tenantCode: "LOCAL-LIVE-01-NOT",
      origin: LOOOPBACK,
    });
    expect(readiness.enabled).toBe(false);
    expect(readiness.code).toBe("workspace_not_approved");
    expect(readiness.workspaceApproved).toBe(false);
    expect(readiness.message).toMatch(/not approved/i);
  });

  it("names a test key instead of pretending live is on", () => {
    stubLocalLive({ PAYSTACK_SECRET_KEY: "sk_test_example_value" });
    const readiness = liveCheckoutReadiness({
      tenantId: JANE_TENANT_ID,
      tenantCode: JANE_TENANT_CODE,
      origin: LOOOPBACK,
    });
    expect(readiness.enabled).toBe(false);
    expect(readiness.code).toBe("test_key");
    expect(readiness.message).toMatch(/test key/i);
  });

  it("names an invalid key", () => {
    stubLocalLive({ PAYSTACK_SECRET_KEY: "pk_live_looking_value" });
    expect(
      liveCheckoutReadiness({ tenantId: JANE_TENANT_ID, tenantCode: JANE_TENANT_CODE, origin: LOOOPBACK }).code
    ).toBe("key_invalid");
  });

  it("names a missing key", () => {
    stubLocalLive({ PAYSTACK_SECRET_KEY: null });
    expect(
      liveCheckoutReadiness({ tenantId: JANE_TENANT_ID, tenantCode: JANE_TENANT_CODE, origin: LOOOPBACK }).code
    ).toBe("not_configured");
  });

  it("names a disabled opt-in, a hosted marker and a shared database", () => {
    stubLocalLive({ PAYSTACK_LOCAL_LIVE_TEST: "false" });
    expect(
      liveCheckoutReadiness({ tenantId: JANE_TENANT_ID, tenantCode: JANE_TENANT_CODE, origin: LOOOPBACK }).code
    ).toBe("local_live_not_enabled");

    vi.unstubAllEnvs();
    stubLocalLive({ NODE_ENV: "production" });
    expect(
      liveCheckoutReadiness({ tenantId: JANE_TENANT_ID, tenantCode: JANE_TENANT_CODE, origin: LOOOPBACK }).code
    ).toBe("not_development");

    vi.unstubAllEnvs();
    stubLocalLive({ DATABASE_URL: "postgresql://u:p@ep-cool-1.neon.tech/db" });
    expect(
      liveCheckoutReadiness({ tenantId: JANE_TENANT_ID, tenantCode: JANE_TENANT_CODE, origin: LOOOPBACK }).code
    ).toBe("database_not_isolated");
  });
});

describe("per-charge guard and its explanation", () => {
  it("allows Jane D Wholes with the full local configuration", () => {
    stubLocalLive();
    expect(() =>
      assertLiveChargePermitted({
        origin: LOOOPBACK,
        tenantId: JANE_TENANT_ID,
        tenantCode: JANE_TENANT_CODE,
      })
    ).not.toThrow();
  });

  it("refuses a non-allowlisted tenant before any charge exists", () => {
    stubLocalLive();
    expect(
      refusalCode(() =>
        assertLiveChargePermitted({
          origin: LOOOPBACK,
          tenantId: OTHER_TENANT_ID,
          tenantCode: "BT-OTHER",
        })
      )
    ).toContain("tenant_not_designated");
  });

  it("refuses production and staging even for an allowlisted tenant", () => {
    for (const nodeEnv of ["production", "staging"]) {
      vi.unstubAllEnvs();
      stubLocalLive({ NODE_ENV: nodeEnv });
      expect(
        refusalCode(() =>
          assertLiveChargePermitted({
            origin: LOOOPBACK,
            tenantId: JANE_TENANT_ID,
            tenantCode: JANE_TENANT_CODE,
          })
        )
      ).toContain("not_development");
    }
  });

  it("leaves hosted production commerce unchanged", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example_value");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RENDER", "true");
    expect(() =>
      assertLiveChargePermitted({
        origin: "https://maacash.bloomcoretech.com",
        tenantId: JANE_TENANT_ID,
        tenantCode: JANE_TENANT_CODE,
      })
    ).not.toThrow();
  });

  it("explains the actual blocker without exposing a credential", () => {
    const base = "Live payments are not enabled for this workspace in this environment.";
    const tenant = liveBlockedExplanation(
      "live_test_blocked:tenant_not_designated"
    );
    expect(tenant).toContain(base);
    expect(tenant).toMatch(/not approved/i);

    const database = liveBlockedExplanation("live_test_blocked:database_not_local");
    expect(database).toMatch(/isolated local database/i);

    const optIn = liveBlockedExplanation("live_test_blocked:local_live_test_not_enabled");
    expect(optIn).toMatch(/PAYSTACK_LOCAL_LIVE_TEST/);

    expect(database).not.toMatch(/sk_live_|sk_test_/);
    expect(optIn).not.toMatch(/sk_live_|sk_test_/);
  });
});

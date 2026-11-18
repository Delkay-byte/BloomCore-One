import { describe, expect, it, vi, afterEach } from "vitest";
import {
  evaluateLocalLiveTest,
  hostedDeployment,
  isLocalDatabaseUrl,
  isLoopbackOrigin,
  localLiveTestEnvironment,
  requiresLocalLiveGuard,
  type LocalLiveTestEnvironment,
} from "@/lib/payments/local-live-test";
import {
  assertLiveChargePermitted,
  PaystackError,
  paystackReadyForCheckout,
} from "@/lib/payments/paystack";

function refusalCode(fn: () => void): string {
  try {
    fn();
  } catch (error) {
    if (error instanceof PaystackError) return error.code;
    throw error;
  }
  return "no_error";
}

/**
 * The local live-payment guard is the only thing standing between a copied
 * production key and a real charge from a developer machine. These tests fix
 * the decision table in place.
 */

const LIVE_TENANT = "tenant-live-01";

function environment(overrides: Partial<LocalLiveTestEnvironment> = {}): LocalLiveTestEnvironment {
  return {
    keyMode: "live",
    nodeEnv: "development",
    localLiveTest: "true",
    enabled: "true",
    currency: "GHS",
    origin: "http://localhost:3100",
    siteUrl: "http://localhost:3100",
    databaseUrl: "file:./demo.db",
    tenantId: LIVE_TENANT,
    tenantCode: "LOCAL-LIVE-01",
    designatedTenant: "LOCAL-LIVE-01",
    ...overrides,
  };
}

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("loopback and database classification", () => {
  it("recognises loopback origins only", () => {
    expect(isLoopbackOrigin("http://localhost:3100")).toBe(true);
    expect(isLoopbackOrigin("http://127.0.0.1:3000")).toBe(true);
    expect(isLoopbackOrigin("http://[::1]:3000")).toBe(true);
    expect(isLoopbackOrigin("https://maacash.bloomcoretech.com")).toBe(false);
    expect(isLoopbackOrigin("http://localhost.evil.example")).toBe(false);
    expect(isLoopbackOrigin("not a url")).toBe(false);
    expect(isLoopbackOrigin(null)).toBe(false);
  });

  it("accepts only an isolated local database", () => {
    expect(isLocalDatabaseUrl("file:./demo.db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://u:p@127.0.0.1:55434/maacash_test")).toBe(true);
    expect(isLocalDatabaseUrl("postgres://u:p@localhost:5432/db")).toBe(true);
    expect(isLocalDatabaseUrl("postgresql://u:p@ep-cool-1.neon.tech/db")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://u:p@dpg-abc.render.com/db")).toBe(false);
    expect(isLocalDatabaseUrl("postgresql://u:p@db.example.com/db")).toBe(false);
    expect(isLocalDatabaseUrl(null)).toBe(false);
  });

  it("detects hosted deployments", () => {
    expect(hostedDeployment({ RENDER: "true" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(hostedDeployment({ VERCEL: "1" } as unknown as NodeJS.ProcessEnv)).toBe(true);
    expect(hostedDeployment({} as unknown as NodeJS.ProcessEnv)).toBe(false);
  });
});

describe("when the local guard applies", () => {
  it("always applies to a loopback origin", () => {
    expect(requiresLocalLiveGuard("http://localhost:3100", { NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)).toBe(true);
  });

  it("does not apply to a hosted deployment", () => {
    expect(
      requiresLocalLiveGuard(null, { RENDER: "true", NODE_ENV: "production" } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });

  it("does not apply to a production build on a public origin", () => {
    expect(
      requiresLocalLiveGuard("https://maacash.bloomcoretech.com", {
        NODE_ENV: "production",
      } as unknown as NodeJS.ProcessEnv)
    ).toBe(false);
  });
});

describe("local live decision", () => {
  it("allows only the fully designated local setup", () => {
    expect(evaluateLocalLiveTest(environment())).toEqual({ allowed: true, reasons: [] });
  });

  it("refuses a missing opt-in", () => {
    const decision = evaluateLocalLiveTest(environment({ localLiveTest: undefined }));
    expect(decision.allowed).toBe(false);
    expect(decision.reasons).toContain("local_live_test_not_enabled");
  });

  it("refuses a production process", () => {
    expect(evaluateLocalLiveTest(environment({ nodeEnv: "production" })).reasons).toContain(
      "not_development"
    );
  });

  it("refuses a test or unknown key", () => {
    expect(evaluateLocalLiveTest(environment({ keyMode: "test" })).reasons).toContain("key_not_live");
    expect(evaluateLocalLiveTest(environment({ keyMode: "unknown" })).reasons).toContain("key_not_live");
  });

  it("refuses a paid provider that is switched off", () => {
    expect(evaluateLocalLiveTest(environment({ enabled: "false" })).reasons).toContain(
      "payments_disabled"
    );
  });

  it("refuses a non-GHS currency", () => {
    expect(evaluateLocalLiveTest(environment({ currency: "NGN" })).reasons).toContain(
      "currency_not_ghs"
    );
  });

  it("refuses a public origin", () => {
    const decision = evaluateLocalLiveTest(
      environment({ origin: "https://maacash.bloomcoretech.com", siteUrl: null })
    );
    expect(decision.reasons).toContain("origin_not_loopback");
  });

  it("refuses a hosted database", () => {
    const decision = evaluateLocalLiveTest(
      environment({ databaseUrl: "postgresql://u:p@ep-cool-1.neon.tech/db" })
    );
    expect(decision.reasons).toContain("database_not_local");
  });

  it("refuses an undesignated tenant", () => {
    expect(evaluateLocalLiveTest(environment({ designatedTenant: null })).reasons).toContain(
      "no_designated_tenant"
    );
    expect(
      evaluateLocalLiveTest(environment({ tenantId: "other", tenantCode: "OTHER-01" })).reasons
    ).toContain("tenant_not_designated");
  });

  it("accepts the designated tenant by id or by code", () => {
    expect(
      evaluateLocalLiveTest(environment({ designatedTenant: LIVE_TENANT })).allowed
    ).toBe(true);
    expect(
      evaluateLocalLiveTest(environment({ designatedTenant: "LOCAL-LIVE-01" })).allowed
    ).toBe(true);
  });

  it("reads the flag and tenant name from the environment", () => {
    vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
    vi.stubEnv("PAYSTACK_LOCAL_TEST_TENANT", "LOCAL-LIVE-01");
    vi.stubEnv("PAYSTACK_ENABLED", "true");
    vi.stubEnv("PAYSTACK_CURRENCY", "GHS");
    vi.stubEnv("DATABASE_URL", "file:./demo.db");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    const settings = localLiveTestEnvironment({ keyMode: "live" });
    expect(settings.localLiveTest).toBe("true");
    expect(settings.designatedTenant).toBe("LOCAL-LIVE-01");
    expect(settings.siteUrl).toBe("http://localhost:3100");
  });
});

describe("checkout availability with a live key", () => {
  it("stays closed on a developer machine without the opt-in", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("NODE_ENV", "development");
    expect(paystackReadyForCheckout()).toBe(false);
  });

  it("opens on a developer machine with the opt-in in development", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
    expect(paystackReadyForCheckout()).toBe(true);
  });

  it("never opens with an unrecognised key prefix", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "pk_live_looking_value");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
    expect(paystackReadyForCheckout()).toBe(false);
  });

  it("keeps production live behaviour unchanged", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("SITE_URL", "https://maacash.bloomcoretech.com");
    vi.stubEnv("NODE_ENV", "production");
    expect(paystackReadyForCheckout()).toBe(true);
  });
});

describe("per-charge guard", () => {
  it("does nothing for a test key", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_test_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    expect(() =>
      assertLiveChargePermitted({ origin: "http://localhost:3100", tenantId: LIVE_TENANT, tenantCode: null })
    ).not.toThrow();
  });

  it("refuses a live key on a developer machine without the opt-in", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("DATABASE_URL", "file:./demo.db");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYSTACK_ENABLED", "true");
    vi.stubEnv("PAYSTACK_CURRENCY", "GHS");
    vi.stubEnv("PAYSTACK_LOCAL_TEST_TENANT", "LOCAL-LIVE-01");
    expect(
      refusalCode(() =>
        assertLiveChargePermitted({
          origin: "http://localhost:3100",
          tenantId: LIVE_TENANT,
          tenantCode: "LOCAL-LIVE-01",
        })
      )
    ).toContain("local_live_test_not_enabled");
  });

  it("refuses a live key for a tenant that is not designated", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("DATABASE_URL", "file:./demo.db");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
    vi.stubEnv("PAYSTACK_ENABLED", "true");
    vi.stubEnv("PAYSTACK_CURRENCY", "GHS");
    vi.stubEnv("PAYSTACK_LOCAL_TEST_TENANT", "SOMEONE-ELSE");
    expect(
      refusalCode(() =>
        assertLiveChargePermitted({
          origin: "http://localhost:3100",
          tenantId: LIVE_TENANT,
          tenantCode: "LOCAL-LIVE-01",
        })
      )
    ).toContain("tenant_not_designated");
  });

  it("allows the fully designated local setup", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("SITE_URL", "http://localhost:3100");
    vi.stubEnv("DATABASE_URL", "file:./demo.db");
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("PAYSTACK_LOCAL_LIVE_TEST", "true");
    vi.stubEnv("PAYSTACK_ENABLED", "true");
    vi.stubEnv("PAYSTACK_CURRENCY", "GHS");
    vi.stubEnv("PAYSTACK_LOCAL_TEST_TENANT", "LOCAL-LIVE-01");
    expect(() =>
      assertLiveChargePermitted({
        origin: "http://localhost:3100",
        tenantId: LIVE_TENANT,
        tenantCode: "LOCAL-LIVE-01",
      })
    ).not.toThrow();
  });

  it("does not apply to a hosted production request", () => {
    vi.stubEnv("PAYSTACK_SECRET_KEY", "sk_live_example");
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("RENDER", "true");
    expect(() =>
      assertLiveChargePermitted({
        origin: "https://maacash.bloomcoretech.com",
        tenantId: "any-tenant",
        tenantCode: "ANY",
      })
    ).not.toThrow();
  });
});

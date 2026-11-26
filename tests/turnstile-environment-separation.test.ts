/**
 * Turnstile credentials must be environment-scoped: deterministic Cloudflare
 * test keys are allowed in local tests but rejected in a production runtime.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  assertTurnstileEnvironmentSeparation,
  turnstileConfig,
} from "@/lib/security/config";

afterEach(() => vi.unstubAllEnvs());

describe("Turnstile environment separation", () => {
  it("accepts test credentials in a test runtime", () => {
    vi.stubEnv("NODE_ENV", "test");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "1x0000000000000000000000000000000AA");
    expect(() => assertTurnstileEnvironmentSeparation()).not.toThrow();
    expect(turnstileConfig().siteKey).toBe("1x00000000000000000000AA");
  });

  it("rejects a Cloudflare test site key in a production runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "1x00000000000000000000AA");
    expect(() => assertTurnstileEnvironmentSeparation()).toThrow(/test credentials/i);
  });

  it("rejects a Cloudflare test secret in a production runtime", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "2x0000000000000000000000000000000AB");
    expect(() => assertTurnstileEnvironmentSeparation()).toThrow(/test credentials/i);
  });

  it("does not reject non-test production credentials", () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("NEXT_PUBLIC_TURNSTILE_SITE_KEY", "0 production-site-key value");
    vi.stubEnv("TURNSTILE_SECRET_KEY", "production-secret-not-a-test-key");
    expect(() => assertTurnstileEnvironmentSeparation()).not.toThrow();
  });
});

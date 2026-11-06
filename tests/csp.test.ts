import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { buildCsp } from "@/lib/security/csp";

describe("content security policy", () => {
  it("uses a nonce and strict-dynamic for scripts", () => {
    const csp = buildCsp("test-nonce", false);
    const script = csp.split(";").find((part) => part.trim().startsWith("script-src"));
    expect(script).toContain("'nonce-test-nonce'");
    expect(script).toContain("'strict-dynamic'");
    expect(script).not.toContain("'unsafe-inline'");
    expect(script).not.toContain("'unsafe-eval'");
  });

  it("locks down framing, objects, base and forms", () => {
    const csp = buildCsp("n", false);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(csp).toContain("worker-src 'self' blob:");
  });

  it("keeps unsafe-eval out of production but allows it in development", () => {
    expect(buildCsp("n", true)).toContain("'unsafe-eval'");
    expect(buildCsp("n", false)).not.toContain("'unsafe-eval'");
  });

  it("is emitted by middleware, not the static config", () => {
    const config = readFileSync(
      path.join(process.cwd(), "next.config.ts"),
      "utf8"
    );
    expect(config).not.toMatch(/key:\s*["']Content-Security-Policy["']/);
    const middleware = readFileSync(
      path.join(process.cwd(), "src/middleware.ts"),
      "utf8"
    );
    expect(middleware).toContain("buildCsp");
    expect(middleware).toContain('requestHeaders.set("x-nonce"');
  });
});

import { readFileSync } from "fs";
import path from "path";
import { NextRequest } from "next/server";
import { afterEach, describe, expect, it } from "vitest";
import {
  MAINTENANCE_RETRY_AFTER_SECONDS,
  isMaintenanceBlocked,
  isMaintenanceExempt,
  maintenanceHeaders,
  normalizeRequestPath,
  resolveMaintenanceState,
} from "@/lib/maintenance/guard";
import { middleware } from "@/middleware";

const ORIGINAL = process.env.MAINTENANCE_MODE;

function setMode(value: string | undefined) {
  if (value === undefined) delete process.env.MAINTENANCE_MODE;
  else process.env.MAINTENANCE_MODE = value;
}

function request(pathname: string, init: { method?: string; accept?: string } = {}) {
  return new NextRequest(new URL(`http://localhost:3000${pathname}`), {
    method: init.method ?? "GET",
    headers: init.accept ? { accept: init.accept } : undefined,
  });
}

afterEach(() => {
  if (ORIGINAL === undefined) delete process.env.MAINTENANCE_MODE;
  else process.env.MAINTENANCE_MODE = ORIGINAL;
});

describe("maintenance state resolution", () => {
  it("is off when the variable is absent or empty", () => {
    expect(resolveMaintenanceState(undefined)).toBe("off");
    expect(resolveMaintenanceState("")).toBe("off");
    expect(resolveMaintenanceState("   ")).toBe("off");
  });

  it("recognises explicit on and off values case-insensitively", () => {
    for (const value of ["true", "1", "on", "yes", "enabled", " TRUE "]) {
      expect(resolveMaintenanceState(value)).toBe("on");
    }
    for (const value of ["false", "0", "off", "no", "disabled", " FALSE "]) {
      expect(resolveMaintenanceState(value)).toBe("off");
    }
  });

  it("fails closed for an unrecognised non-empty value", () => {
    expect(resolveMaintenanceState("banana")).toBe("on");
    expect(resolveMaintenanceState("maint")).toBe("on");
    expect(resolveMaintenanceState("2")).toBe("on");
  });
});

describe("path normalization", () => {
  it("collapses duplicate slashes, dot segments and trailing slashes", () => {
    expect(normalizeRequestPath("//api//health//")).toBe("/api/health");
    expect(normalizeRequestPath("/api/./health")).toBe("/api/health");
    expect(normalizeRequestPath("/api/health/../login")).toBe("/api/login");
    expect(normalizeRequestPath("/%2e%2e/login")).toBe("/login");
    expect(normalizeRequestPath("/login?next=/api/health")).toBe("/login");
    expect(normalizeRequestPath("/login#health")).toBe("/login");
    expect(normalizeRequestPath("\\api\\health")).toBe("/api/health");
  });
});

describe("exemption matrix", () => {
  it("keeps health, readiness and static assets reachable", () => {
    for (const path of [
      "/api/health",
      "/api/health/ready",
      "/API/HEALTH",
      "/api/health/",
      "//api//health//",
      "/_next/static/chunk.js",
      "/_next/image",
      "/favicon.ico",
    ]) {
      expect(isMaintenanceExempt(path)).toBe(true);
    }
  });

  it("blocks every authentication, business and integration path", () => {
    for (const path of [
      "/",
      "/login",
      "/admin/login",
      "/platform/login",
      "/customer/login",
      "/verify-email",
      "/forgot-password",
      "/reset-password",
      "/password-upgrade",
      "/change-password",
      "/admin/dashboard",
      "/worker/dashboard",
      "/collector/dashboard",
      "/customer/dashboard",
      "/api/auth/session",
      "/api/auth/mfa",
      "/api/auth/tab/assertion",
      "/api/offline/sync-contribution",
      "/api/offline/enroll",
      "/api/payments/paystack/webhook",
      "/api/admin/devices",
      "/platform/login/sso/callback",
      "/api/health/../login",
      "/api/health%00/login",
    ]) {
      expect(isMaintenanceExempt(path)).toBe(false);
      expect(isMaintenanceBlocked(path, "on")).toBe(true);
    }
  });

  it("never blocks anything while the guard is off", () => {
    expect(isMaintenanceBlocked("/login", "off")).toBe(false);
    expect(isMaintenanceBlocked("/admin/dashboard", "off")).toBe(false);
    expect(isMaintenanceBlocked("/api/payments/paystack/webhook", "off")).toBe(false);
  });
});

describe("middleware enforcement", () => {
  it("serves 503 with the documented headers for a blocked page", async () => {
    setMode("true");
    const response = await middleware(request("/login"));
    expect(response.status).toBe(503);
    expect(response.headers.get("Retry-After")).toBe(
      String(MAINTENANCE_RETRY_AFTER_SECONDS)
    );
    expect(response.headers.get("Cache-Control")).toContain("no-store");
    expect(response.headers.get("Content-Type")).toContain("text/html");
    const body = await response.text();
    expect(body).toContain("MaaCash is briefly unavailable");
    expect(body).not.toContain("JWT_SECRET");
  });

  it("returns JSON for API and JSON-preferred callers", async () => {
    setMode("on");
    const api = await middleware(request("/api/auth/session"));
    expect(api.status).toBe(503);
    expect(api.headers.get("Content-Type")).toContain("application/json");
    const payload = JSON.parse(await api.text());
    expect(payload.maintenance).toBe(true);

    const negotiated = await middleware(
      request("/admin/login", { accept: "application/json" })
    );
    expect(negotiated.status).toBe(503);
    expect(negotiated.headers.get("Content-Type")).toContain("application/json");
  });

  it("blocks webhooks, server actions and alternate methods", async () => {
    setMode("true");
    for (const [pathname, method] of [
      ["/api/payments/paystack/webhook", "POST"],
      ["/login", "POST"],
      ["/admin/dashboard", "HEAD"],
      ["/api/offline/sync-contribution", "PUT"],
    ] as const) {
      const response = await middleware(request(pathname, { method }));
      expect(response.status).toBe(503);
    }
  });

  it("keeps the health endpoints operational", async () => {
    setMode("true");
    for (const path of ["/api/health", "/api/health/ready"]) {
      const response = await middleware(request(path));
      expect(response.status).not.toBe(503);
    }
  });

  it("does not block the application when the guard is unset or off", async () => {
    setMode(undefined);
    expect((await middleware(request("/login"))).status).not.toBe(503);
    setMode("false");
    expect((await middleware(request("/api/auth/session"))).status).not.toBe(503);
  });

  it("fails closed when the variable is set to an unrecognised value", async () => {
    setMode("maint");
    expect((await middleware(request("/login"))).status).toBe(503);
  });
});

describe("middleware ordering", () => {
  const source = readFileSync(path.join(process.cwd(), "src", "middleware.ts"), "utf8");

  it("evaluates the guard before CSP, session resolution and route rules", () => {
    const guardIndex = source.indexOf("isMaintenanceBlocked(pathname, maintenanceState())");
    expect(guardIndex).toBeGreaterThan(-1);

    for (const later of [
      "const nonce = crypto.randomUUID();",
      "const platformClaims = await resolveClaims(request, PLATFORM_COOKIE);",
      "if (isPublicMarketingRoute(pathname))",
      "const redirectTo = (path: string)",
    ]) {
      const index = source.indexOf(later);
      expect(index).toBeGreaterThan(guardIndex);
    }
  });

  it("keeps the guard in the middleware bundle rather than a route handler", () => {
    expect(source).toContain('from "@/lib/maintenance/guard"');
  });
});

describe("response headers", () => {
  it("declares no-store, retry-after and a locked-down CSP", () => {
    const headers = maintenanceHeaders();
    expect(headers["Cache-Control"]).toContain("no-store");
    expect(headers["Retry-After"]).toBe(String(MAINTENANCE_RETRY_AFTER_SECONDS));
    expect(headers["Content-Security-Policy"]).toContain("default-src 'none'");
    expect(headers["Content-Type"]).toBeUndefined();
  });
});

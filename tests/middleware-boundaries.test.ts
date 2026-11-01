/**
 * ============================================================================
 * MIDDLEWARE BOUNDARY — REGRESSION TESTS
 * ============================================================================
 *
 * The marketing site made the root route public. That must not have weakened
 * any authentication boundary, so this file exercises the middleware directly
 * with real request objects.
 *
 * Covered:
 * - The public marketing pages pass through with no cookie at all.
 * - Every protected operational page still redirects an anonymous visitor.
 * - A forged or tampered cookie is rejected.
 * - A platform session cannot reach tenant routes, and a tenant session cannot
 *   reach platform routes.
 * - The customer portal keeps its own separate guard.
 */

import { describe, it, expect } from "vitest";
import { NextRequest } from "next/server";
import { middleware } from "../src/middleware";
import { createToken } from "@/lib/auth";

function request(pathname: string, cookies: Record<string, string> = {}) {
  const url = new URL(`http://localhost:3000${pathname}`);
  const req = new NextRequest(url);
  for (const [name, value] of Object.entries(cookies)) {
    req.cookies.set(name, value);
  }
  return req;
}

function location(res: Response): string | null {
  return res.headers.get("location");
}

describe("Public marketing pages", () => {
  const publicPages = [
    "/",
    "/features",
    "/solutions",
    "/about",
    "/contact",
    "/privacy",
    "/terms",
  ];

  it("serves every public page without a session", async () => {
    for (const page of publicPages) {
      const res = await middleware(request(page));
      expect(res.status).toBe(200);
      expect(location(res)).toBeNull();
    }
  });

  it("serves the root page even when a visitor carries a forged cookie", async () => {
    const res = await middleware(
      request("/", { "bik-admin-session": "not-a-real-token" })
    );
    expect(res.status).toBe(200);
    expect(location(res)).toBeNull();
  });
});

describe("Anonymous access to protected pages", () => {
  const protectedPages = [
    "/admin/dashboard",
    "/admin/workers",
    "/susu/admin",
    "/worker/dashboard",
    "/collector/dashboard",
    "/customer/dashboard",
    "/platform/dashboard",
    "/settings",
    "/change-password",
  ];

  it("redirects an anonymous visitor to a sign-in page", async () => {
    for (const page of protectedPages) {
      const res = await middleware(request(page));
      expect(res.status).toBe(307);
      expect(location(res)).not.toBeNull();
    }
  });
});

describe("Forged cookies", () => {
  it("rejects a tampered tenant cookie on a tenant route", async () => {
    const res = await middleware(
      request("/admin/dashboard", { "bik-admin-session": "forged.value.here" })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/login");
  });

  it("rejects a tampered platform cookie on a platform route", async () => {
    const res = await middleware(
      request("/platform/dashboard", { "bik-platform-session": "forged.value.here" })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/platform/login");
  });
});

describe("Platform and tenant sessions stay separate", () => {
  it("lets a valid platform session reach the platform dashboard", async () => {
    const token = await createToken({
      userId: "platform-admin-1",
      email: "operator@example.com",
      role: "super_admin",
      kind: "platform",
      adminId: "platform-admin-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);

    const res = await middleware(
      request("/platform/dashboard", { "bik-platform-session": token })
    );
    expect(res.status).toBe(200);
  });

  it("does not let a platform session act as a tenant user", async () => {
    const token = await createToken({
      userId: "platform-admin-1",
      email: "operator@example.com",
      role: "super_admin",
      kind: "platform",
      adminId: "platform-admin-1",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);

    const res = await middleware(
      request("/admin/dashboard", { "bik-platform-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/login");
  });

  it("does not let a tenant admin session reach the platform dashboard", async () => {
    const token = await createToken({
      userId: "tenant-admin-1",
      email: "admin@example.com",
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);

    const res = await middleware(
      request("/platform/dashboard", { "bik-admin-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/platform/login");
  });
});

describe("Workspace entry point", () => {
  it("sends an anonymous visitor to the sign-in page", async () => {
    const res = await middleware(request("/workspace"));
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/login");
  });

  it("sends a signed-in tenant administrator to their dashboard", async () => {
    const token = await createToken({
      userId: "tenant-admin-2",
      email: "admin@example.com",
      role: "admin",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);

    const res = await middleware(
      request("/workspace", { "bik-admin-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/admin/dashboard");
  });

  it("sends a signed-in customer to the customer dashboard", async () => {
    const token = await createToken({
      userId: "customer-2",
      email: "customer@example.com",
      role: "customer",
      modules: ["customer"],
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);

    const res = await middleware(
      request("/workspace", { "bik-customer-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/customer/dashboard");
  });

  it("sends a signed-in platform operator to the platform dashboard", async () => {
    const token = await createToken({
      userId: "platform-admin-2",
      email: "operator@example.com",
      role: "super_admin",
      kind: "platform",
      adminId: "platform-admin-2",
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);

    const res = await middleware(
      request("/workspace", { "bik-platform-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/platform/dashboard");
  });

  it("never exposes workspace content — every outcome is a redirect", async () => {
    const anonymous = await middleware(request("/workspace"));
    expect(anonymous.status).toBe(307);
  });
});

describe("Existing sign-in routes stay reachable", () => {
  const signInPages = [
    "/login",
    "/access",
    "/admin/login",
    "/platform/login",
    "/customer/login",
    "/forgot-password",
    "/reset-password",
  ];

  it("does not redirect a visitor away from a sign-in page", async () => {
    for (const page of signInPages) {
      const res = await middleware(request(page));
      expect(res.status).toBe(200);
    }
  });
});

describe("Forced first-login password change", () => {
  async function tenantToken(
    role: "admin" | "worker" | "collector" | "customer",
    forcePasswordReset: boolean
  ) {
    return createToken({
      userId: `${role}-1`,
      email: `${role}@example.com`,
      fullName: `${role} user`,
      role,
      modules: role === "customer" ? ["customer"] : [role === "worker" ? "momo" : "susu"],
      forcePasswordReset,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);
  }

  async function platformToken(forcePasswordReset: boolean) {
    return createToken({
      userId: "platform-admin-1",
      email: "operator@example.com",
      role: "super_admin",
      kind: "platform",
      adminId: "platform-admin-1",
      forcePasswordReset,
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 3600,
      lastActivityAt: Math.floor(Date.now() / 1000),
    } as never);
  }

  it("sends a forced administrator to the standalone admin screen", async () => {
    const token = await tenantToken("admin", true);
    const res = await middleware(
      request("/admin/settings?tab=password", { "bik-admin-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/admin/first-login");
  });

  it("sends a forced MoMo agent to the standalone worker screen", async () => {
    const token = await tenantToken("worker", true);
    const res = await middleware(
      request("/worker/settings?tab=password", { "bik-worker-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/worker/first-login");
  });

  it("sends a forced Susu collector to the standalone collector screen", async () => {
    const token = await tenantToken("collector", true);
    const res = await middleware(
      request("/collector/dashboard", { "bik-collector-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/collector/first-login");
  });

  it("sends a forced customer to the standalone customer screen", async () => {
    const token = await tenantToken("customer", true);
    const res = await middleware(
      request("/customer/dashboard", { "bik-customer-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/customer/first-login");
  });

  it("sends a forced platform operator to the standalone platform screen", async () => {
    const token = await platformToken(true);
    for (const page of ["/platform/dashboard", "/platform/settings?tab=password"]) {
      const res = await middleware(
        request(page, { "bik-platform-session": token })
      );
      expect(res.status).toBe(307);
      expect(location(res)).toContain("/platform/first-login");
    }
  });

  it("does not loop the platform login through the console layout", async () => {
    const token = await platformToken(true);
    const login = await middleware(
      request("/platform/login", { "bik-platform-session": token })
    );
    expect(login.status).toBe(307);
    expect(location(login)).toContain("/platform/first-login");

    const screen = await middleware(
      request("/platform/first-login", { "bik-platform-session": token })
    );
    expect(screen.status).toBe(200);
  });

  it("allows every forced role to reach only its own first-login screen", async () => {
    const cases = [
      ["/admin/first-login", "bik-admin-session", await tenantToken("admin", true)],
      ["/worker/first-login", "bik-worker-session", await tenantToken("worker", true)],
      ["/collector/first-login", "bik-collector-session", await tenantToken("collector", true)],
      ["/customer/first-login", "bik-customer-session", await tenantToken("customer", true)],
    ] as const;

    for (const [page, cookie, token] of cases) {
      const res = await middleware(request(page, { [cookie]: token }));
      expect(res.status).toBe(200);
    }
  });

  it("sends an already-changed session away from every first-login screen", async () => {
    const cases = [
      ["/admin/first-login", "bik-admin-session", await tenantToken("admin", false), "/admin/dashboard"],
      ["/worker/first-login", "bik-worker-session", await tenantToken("worker", false), "/worker/dashboard"],
      ["/collector/first-login", "bik-collector-session", await tenantToken("collector", false), "/collector/dashboard"],
      ["/customer/first-login", "bik-customer-session", await tenantToken("customer", false), "/customer/dashboard"],
      ["/platform/first-login", "bik-platform-session", await platformToken(false), "/platform/dashboard"],
    ] as const;

    for (const [page, cookie, token, destination] of cases) {
      const res = await middleware(request(page, { [cookie]: token }));
      expect(res.status).toBe(307);
      expect(location(res)).toContain(destination);
    }
  });

  it("sends a forced workspace entry to the role's first-login screen", async () => {
    const token = await tenantToken("admin", true);
    const res = await middleware(
      request("/workspace", { "bik-admin-session": token })
    );
    expect(res.status).toBe(307);
    expect(location(res)).toContain("/admin/first-login");
  });
});

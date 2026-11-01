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

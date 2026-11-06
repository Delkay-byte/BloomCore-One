/**
 * ============================================================================
 * PUBLIC MARKETING ROUTES — REGRESSION TESTS
 * ============================================================================
 *
 * The MaaCash marketing site is public. Every other route keeps the
 * access control it already had. These tests pin that boundary so a later
 * change cannot silently widen it.
 *
 * Covered:
 * - The exact public route list.
 * - Segment-boundary matching ("/features" is public, "/featuresecret" is not).
 * - No authenticated application route is public.
 * - The brand configuration never names the tenant as the product.
 */

import { describe, it, expect } from "vitest";
import {
  PUBLIC_MARKETING_ROUTES,
  isPublicMarketingRoute,
} from "@/lib/public-routes";
import {
  COMPANY_NAME,
  FIRST_TENANT_CODE,
  FIRST_TENANT_NAME,
  PRODUCT_DESCRIPTOR,
  PRODUCT_NAME,
  PRODUCT_TAGLINE,
} from "@/lib/site";

describe("Public marketing route list", () => {
  it("covers exactly the documented public pages", () => {
    expect([...PUBLIC_MARKETING_ROUTES]).toEqual([
      "/",
      "/features",
      "/solutions",
      "/about",
      "/contact",
      "/privacy",
      "/terms",
    ]);
  });

  it("makes every public marketing page reachable without a session", () => {
    for (const route of PUBLIC_MARKETING_ROUTES) {
      expect(isPublicMarketingRoute(route)).toBe(true);
    }
  });
});

describe("Public marketing route matching", () => {
  it("matches sub-paths of a public route on a segment boundary", () => {
    expect(isPublicMarketingRoute("/features/momo")).toBe(true);
    expect(isPublicMarketingRoute("/contact/enterprise")).toBe(true);
  });

  it("does not match a route that merely shares a prefix", () => {
    expect(isPublicMarketingRoute("/featuresecret")).toBe(false);
    expect(isPublicMarketingRoute("/contacted")).toBe(false);
    expect(isPublicMarketingRoute("/privacypolicy")).toBe(false);
    expect(isPublicMarketingRoute("/terms-and-conditions")).toBe(false);
  });

  it("does not match the root as a prefix of other paths", () => {
    expect(isPublicMarketingRoute("/anything-else")).toBe(false);
  });
});

describe("Authenticated application routes stay protected", () => {
  const protectedRoutes = [
    "/admin",
    "/admin/dashboard",
    "/admin/login",
    "/api/health",
    "/api/auth/me",
    "/collector",
    "/collector/dashboard",
    "/customer",
    "/customer/dashboard",
    "/customer/login",
    "/platform",
    "/platform/login",
    "/platform/dashboard",
    "/select-workspace",
    "/settings",
    "/susu/admin",
    "/worker",
    "/worker/dashboard",
    "/login",
    "/access",
    "/forgot-password",
    "/reset-password",
    "/change-password",
  ];

  it("never treats an application route as public", () => {
    for (const route of protectedRoutes) {
      expect(isPublicMarketingRoute(route)).toBe(false);
    }
  });
});

describe("Brand identity configuration", () => {
  it("names the product MaaCash", () => {
    expect(PRODUCT_NAME).toBe("MaaCash");
    expect(PRODUCT_TAGLINE).toBe("One platform. Clearer control.");
    expect(PRODUCT_DESCRIPTOR).toBe(
      "Mobile Money, Susu & Multi-Branch Financial Operations Platform"
    );
  });

  it("names the parent business BloomCore Technologies", () => {
    expect(COMPANY_NAME).toBe("BloomCore Technologies");
  });

  it("keeps the first tenant as its own business identity", () => {
    expect(FIRST_TENANT_NAME).toBe("BIK Prestige Enterprise");
    expect(FIRST_TENANT_CODE).toBe("BIK-HQ-001");
  });

  it("does not use the tenant name as the product name", () => {
    expect(PRODUCT_NAME).not.toContain("BIK");
    expect(PRODUCT_NAME).not.toContain("Prestige");
  });
});

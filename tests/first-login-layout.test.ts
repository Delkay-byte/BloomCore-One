/**
 * FIRST-LOGIN LAYOUT BOUNDARY — REGRESSION TEST
 *
 * A person with a one-time password has not entered a workspace yet. The
 * forced password-change screen must therefore render without the tenant
 * sidebar, worker/collector header, customer portal header or platform console
 * shell. Each of those shells lives in a route group; the first-login page sits
 * outside it, exactly like the login page.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

const app = join(process.cwd(), "src", "app");

function exists(...segments: string[]) {
  return existsSync(join(app, ...segments));
}

describe("First-login routes render outside workspace shells", () => {
  it("keeps the administrator first-login page outside the admin workspace group", () => {
    expect(exists("admin", "first-login", "page.tsx")).toBe(true);
    expect(exists("admin", "(workspace)", "first-login")).toBe(false);
    expect(exists("admin", "layout.tsx")).toBe(false);
  });

  it("keeps the MoMo agent first-login page outside the worker group", () => {
    expect(exists("worker", "first-login", "page.tsx")).toBe(true);
    expect(exists("worker", "(workspace)", "first-login")).toBe(false);
    expect(exists("worker", "layout.tsx")).toBe(false);
    expect(exists("worker", "(workspace)", "layout.tsx")).toBe(true);
  });

  it("keeps the Susu collector first-login page outside the collector group", () => {
    expect(exists("collector", "first-login", "page.tsx")).toBe(true);
    expect(exists("collector", "(workspace)", "first-login")).toBe(false);
    expect(exists("collector", "layout.tsx")).toBe(false);
    expect(exists("collector", "(workspace)", "layout.tsx")).toBe(true);
  });

  it("keeps the customer first-login and login pages outside the portal group", () => {
    expect(exists("customer", "first-login", "page.tsx")).toBe(true);
    expect(exists("customer", "(portal)", "first-login")).toBe(false);
    expect(exists("customer", "layout.tsx")).toBe(false);
    expect(exists("customer", "(portal)", "layout.tsx")).toBe(true);
    expect(exists("customer", "login", "page.tsx")).toBe(true);
    expect(exists("customer", "(portal)", "login")).toBe(false);
  });

  it("keeps the platform first-login page outside the console group", () => {
    expect(exists("platform", "first-login", "page.tsx")).toBe(true);
    expect(exists("platform", "(console)", "first-login")).toBe(false);
  });
});

import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function exists(relative: string): boolean {
  return existsSync(path.join(process.cwd(), relative));
}

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("production rendering regressions", () => {
  it("does not wrap statically prerendered pages in a route loading shell", () => {
    // A root or group loading.tsx around a static client page was rendered as
    // a static skeleton with the real content hidden; production navigation
    // never replaced it. Per-page skeleton states handle client data loads.
    expect(exists("src/app/loading.tsx")).toBe(false);
    expect(exists("src/app/admin/(workspace)/loading.tsx")).toBe(false);
    expect(exists("src/app/susu/admin/loading.tsx")).toBe(false);
    expect(exists("src/app/collector/(workspace)/loading.tsx")).toBe(false);
    expect(exists("src/app/customer/(portal)/loading.tsx")).toBe(false);
    expect(exists("src/app/worker/(workspace)/loading.tsx")).toBe(false);
    expect(exists("src/app/platform/(console)/loading.tsx")).toBe(false);
    expect(exists("src/app/settings/loading.tsx")).toBe(false);
  });

  it("keeps the dynamic customer detail loading skeleton", () => {
    expect(exists("src/app/susu/admin/customers/[id]/loading.tsx")).toBe(true);
  });

  it("wraps useSearchParams in a Suspense boundary on the customer login redirect", () => {
    const page = source("src/app/customer/login/page.tsx");
    expect(page).toContain("Suspense");
    expect(page).toContain("CustomerLoginRedirect");
  });
});

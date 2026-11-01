/**
 * ADMIN LOGIN — LAYOUT BOUNDARY REGRESSION TEST
 *
 * The tenant workspace shell (sidebar, mobile header, sign-out control) must
 * never wrap the public administrator sign-in page. A layout at
 * `src/app/admin/layout.tsx` would apply to every `/admin/*` route, including
 * `/admin/login`; the shell therefore lives in the `(workspace)` route group.
 */

import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import { join } from "node:path";

const adminRoot = join(process.cwd(), "src", "app", "admin");

describe("Admin login layout scope", () => {
  it("does not put a layout above the admin login route", () => {
    expect(existsSync(join(adminRoot, "layout.tsx"))).toBe(false);
  });

  it("keeps the workspace shell inside the protected route group", () => {
    expect(existsSync(join(adminRoot, "(workspace)", "layout.tsx"))).toBe(true);
  });

  it("keeps the login page outside the workspace route group", () => {
    expect(existsSync(join(adminRoot, "login", "page.tsx"))).toBe(true);
    expect(existsSync(join(adminRoot, "(workspace)", "login"))).toBe(false);
  });
});

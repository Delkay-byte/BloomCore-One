import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function source(relative: string): string {
  return readFileSync(path.join(process.cwd(), relative), "utf8");
}

describe("login feedback", () => {
  it("renders one inline error instead of a banner plus a popup", () => {
    for (const file of [
      "src/app/admin/login/AdminLoginForm.tsx",
      "src/app/login/UnifiedLoginClient.tsx",
    ]) {
      const form = source(file);
      expect(form).toMatch(/<Notice\s+type="error"[^>]*popup=\{false\}/);
    }
  });

  it("explains a stale page instead of reporting an unexpected error", () => {
    for (const file of [
      "src/app/admin/login/AdminLoginForm.tsx",
      "src/app/login/UnifiedLoginClient.tsx",
    ]) {
      const form = source(file);
      expect(form).toContain("staleLoginMessage");
      expect(form).toContain("Failed to find Server Action");
      expect(form).toContain("Reload the page and sign in again");
    }
  });
});

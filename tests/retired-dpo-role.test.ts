/**
 * Regression guard: the retired dpo role/alias must not authorise any current
 * privacy operation. Historical audit labels may remain immutable.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

const read = (relative: string) =>
  readFileSync(path.join(process.cwd(), relative), "utf8");

describe("retired dpo alias has no active authority", () => {
  it("does not accept the alias in the privacy-authority check", () => {
    const source = read("src/lib/actions/risk-governance.actions.ts");
    expect(source).not.toContain('role === "privacy_admin" || role === "dpo"');
    expect(source).toContain('return role === "privacy_admin";');
  });

  it("does not treat the alias as an administrator in privacy UI", () => {
    const client = read("src/components/PrivacyReviewClient.tsx");
    expect(client).not.toContain('role === "dpo"');
    const platform = read("src/app/platform/(console)/risk-access/page.tsx");
    expect(platform).not.toContain('grant.role === "privacy_admin" || grant.role === "dpo"');
  });

  it("only allows the two neutral roles when granting access", () => {
    const source = read("src/lib/actions/risk-organisation.actions.ts");
    expect(source).toContain('z.enum(["privacy_admin", "privacy_reviewer"])');
    expect(source).not.toContain('z.enum(["privacy_admin", "privacy_reviewer", "dpo"])');
  });

  it("does not define a dpo account, login, sign-off or approval route", () => {
    for (const file of [
      "src/lib/actions/onboarding-notice.actions.ts",
      "src/lib/actions/risk-governance.actions.ts",
      "src/lib/actions/provisioning.actions.ts",
    ]) {
      const source = read(file);
      expect(source).not.toMatch(/requireDpo|dpoApproval|dpoSignoff|dpoReview/i);
    }
  });
});

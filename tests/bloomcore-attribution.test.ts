import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");

describe("BloomCore attribution", () => {
  it("uses the official https link and safe new-tab attributes", () => {
    const source = readFileSync(
      path.join(ROOT, "src", "components", "brand", "BloomCoreAttribution.tsx"),
      "utf8"
    );
    expect(source).toContain('href="https://bloomcoretech.com"');
    expect(source).toContain('target="_blank"');
    expect(source).toContain('rel="noopener noreferrer"');
    expect(source).toContain("Powered by BloomCore Technologies");
  });

  it("is reused by every shell and standalone attribution footer", () => {
    const files = [
      "src/components/AppShell.tsx",
      "src/app/collector/(workspace)/CollectorShell.tsx",
      "src/app/customer/(portal)/CustomerShell.tsx",
      "src/app/worker/(workspace)/WorkerShell.tsx",
      "src/app/platform/PlatformShell.tsx",
      "src/app/login/UnifiedLoginClient.tsx",
      "src/app/zeli/page.tsx",
      "src/app/admin/login/AdminLoginForm.tsx",
      "src/app/platform/login/PlatformLoginForm.tsx",
      "src/app/platform/login/sso/confirm/page.tsx",
      "src/app/customer/forgot-password/page.tsx",
      "src/app/select-workspace/page.tsx",
      "src/app/access/page.tsx",
      "src/components/FirstLoginPasswordForm.tsx",
      "src/components/marketing/MarketingFooter.tsx",
    ];
    for (const file of files) {
      const source = readFileSync(path.join(ROOT, file), "utf8");
      expect(source, file).toContain("BloomCoreAttribution");
      expect(source, file).not.toContain("Built by BloomCore Technologies");
    }
  });
});

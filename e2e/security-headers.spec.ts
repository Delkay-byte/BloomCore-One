import { expect, test } from "@playwright/test";
import { loginAdmin } from "./helpers";

test.describe("security headers", () => {
  test("login response carries an enforced nonce CSP and no unsafe-inline script", async ({
    page,
  }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) {
        violations.push(message.text());
      }
    });

    const response = await page.goto("/admin/login");
    expect(response?.status()).toBe(200);
    const headers = response!.headers();
    const csp = headers["content-security-policy"] ?? "";
    expect(csp).toContain("script-src 'self'");
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    expect(csp).not.toContain("'unsafe-eval'");
    expect(csp).toContain("upgrade-insecure-requests");
    expect(headers["x-frame-options"]).toBe("DENY");
    expect(headers["x-content-type-options"]).toBe("nosniff");
    expect(headers["referrer-policy"]).toBe("strict-origin-when-cross-origin");
    expect(headers["strict-transport-security"]).toContain("max-age=");

    const nonce = csp.match(/'nonce-([^']+)'/)?.[1];
    expect(nonce).toBeTruthy();
    // React strips nonce attributes from the hydrated DOM, so assert against
    // the raw response body, not page.content().
    const html = await response!.text();
    expect(html).toContain(`nonce="${nonce}"`);
    expect(violations).toEqual([]);
  });

  test("authenticated dashboard has no CSP violations", async ({ page }) => {
    const violations: string[] = [];
    page.on("console", (message) => {
      if (/content security policy/i.test(message.text())) {
        violations.push(message.text());
      }
    });
    await loginAdmin(page);
    const response = await page.goto("/admin/dashboard");
    expect(response?.status()).toBe(200);
    const csp = response!.headers()["content-security-policy"] ?? "";
    expect(csp).toContain("'strict-dynamic'");
    expect(csp).not.toMatch(/script-src[^;]*'unsafe-inline'/);
    await expect(page).toHaveURL(/\/admin\/dashboard/);
    await expect(page.getByRole("heading", { name: /Good / })).toBeVisible();
    expect(violations).toEqual([]);
  });
});

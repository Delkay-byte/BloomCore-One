import { expect, test } from "@playwright/test";
import { loginPlatform } from "./helpers";

test.describe("Platform Zeli control centre", () => {
  test.beforeEach(async ({ page }) => {
    await loginPlatform(page);
  });

  test("shows provider hard-off status and aggregated adoption", async ({ page }) => {
    await page.goto("/platform/zeli");
    await expect(page.getByTestId("platform-zeli")).toBeVisible();
    await expect(
      page.getByText("External AI processing is currently disabled.", { exact: false }).first()
    ).toBeVisible();
    await expect(page.getByText("DeepSeek", { exact: false }).first()).toBeVisible();
    await expect(page.getByText("Disabled by policy")).toBeVisible();
    await expect(page.getByText("Never granted", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: /Enable DeepSeek/i })).toHaveCount(0);
  });

  test("grants, audits and revokes an entitlement with a mandatory reason", async ({ page }) => {
    await page.goto("/platform/zeli");
    const row = page.getByRole("row", { name: /E2E Bloom Business B/ });
    await row.getByRole("button", { name: /Manage/ }).click();
    await expect(page.getByTestId("zeli-entitlement-panel")).toBeVisible();
    await expect(page.getByText("No Zeli Analytics entitlement exists.")).toBeVisible();

    await page.getByTestId("zeli-entitlement-panel").locator("textarea").first().fill("Approved paid pilot pending owner sign-off");
    await page.getByRole("button", { name: "Grant entitlement" }).click();
    await expect(page.getByText("Entitlement granted recorded.")).toBeVisible();
    await expect(page.getByText("granted", { exact: true }).first()).toBeVisible();

    const history = page.getByTestId("zeli-entitlement-panel");
    await expect(history.getByText("approved paid pilot", { exact: false })).toBeVisible();

    page.once("dialog", (dialog) => dialog.accept());
    await page.getByTestId("zeli-entitlement-panel").locator("textarea").first().fill("Pilot ended and access must close immediately");
    await page.getByRole("button", { name: "Revoke" }).click();
    await expect(page.getByText("Entitlement revoke recorded.")).toBeVisible();
    await expect(history.getByText("revoked", { exact: true }).first()).toBeVisible();
  });

  test("does not expose tenant financial records on the platform page", async ({ page }) => {
    await page.goto("/platform/zeli");
    await expect(page.getByText("GH₵500.00")).toHaveCount(0);
    await expect(page.getByText("E2E Customer A")).toHaveCount(0);
    await expect(page.getByText("E2E-S-001")).toHaveCount(0);
  });
});

test.describe("Platform Zeli commerce and provider controls", () => {
  test.beforeEach(async ({ page }) => {
    await loginPlatform(page);
  });

  test("creates an owner-configured package with a reason", async ({ page }) => {
    await page.goto("/platform/zeli");
    const commerce = page.getByTestId("zeli-commerce");
    await commerce.getByLabel("Code", { exact: true }).fill("e2e-monthly");
    await commerce.getByLabel("Name").fill("E2E Monthly");
    await commerce.getByLabel("Price").fill("149");
    await commerce.getByRole("textbox", { name: "Reason (required)", exact: false }).fill(
      "E2E owner-approved package price"
    );
    await commerce.getByRole("button", { name: "Save package" }).click();
    await expect(page.getByText("Package saved.", { exact: false })).toBeVisible();
    await expect(page.getByRole("cell", { name: /E2E Monthly/ })).toBeVisible();
  });

  test("emergency stop requires a reason and overrides provider state", async ({ page }) => {
    await page.goto("/platform/zeli");
    const panel = page.getByTestId("provider-control");
    await panel.locator("textarea").first().fill("E2E immediate external AI stop");
    await panel.getByRole("button", { name: "Emergency stop", exact: true }).click();
    await expect(panel.getByText("Provider control updated.")).toBeVisible();
    await expect(panel.getByText("ACTIVE")).toBeVisible();
  });

  test("unsubscribed tenant sees an honest checkout configuration state", async ({ page }) => {
    await page.context().clearCookies();
    await page.goto("/admin/login");
    await page.locator("#email").fill("e2e-admin-c@test.local");
    await page.locator("#password").fill("E2ePass123!");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/admin\/dashboard/);
    await page.evaluate(() => sessionStorage.setItem("bik-tab-session", "1"));
    await page.goto("/admin/zeli-analytics/upgrade");
    await expect(page.getByText("Analytics is not enabled for this business")).toBeVisible();
    await expect(page.getByText("Subscription checkout is not configured yet.", { exact: false })).toBeVisible();
  });
});

test.describe("Global Zeli availability master switch", () => {
  test("disables all tenant Zeli surfaces and re-enables them", async ({ page }) => {
    await loginPlatform(page);
    await page.goto("/platform/zeli");
    const panel = page.getByTestId("zeli-availability");
    await expect(panel.getByText("Global Zeli Availability")).toBeVisible();
    await panel.locator("textarea").fill("E2E entire Zeli maintenance window");
    page.once("dialog", (dialog) => dialog.accept());
    await panel.getByRole("button", { name: "Disable Zeli" }).click();
    await expect(panel.getByText("ZELI OFF")).toBeVisible();

    // Tenant-facing surfaces are unavailable while platform controls remain.
    await page.context().clearCookies();
    await page.goto("/admin/login");
    await page.locator("#email").fill("e2e-admin-a@test.local");
    await page.locator("#password").fill("E2ePass123!");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/admin\/dashboard/);
    await page.evaluate(() => sessionStorage.setItem("bik-tab-session", "1"));
    await page.goto("/zeli");
    await expect(page.getByText("Zeli is temporarily unavailable")).toBeVisible();
    await page.goto("/admin/zeli-analytics");
    await expect(page.getByText("Zeli is temporarily unavailable")).toBeVisible();
    const exportResponse = await page.request.get("/api/zeli/analytics/export?period=this_month");
    expect(exportResponse.status()).toBe(503);

    // Platform admin can still access controls and restore service.
    await page.context().clearCookies();
    await page.goto("/platform/login");
    await page.locator("#email").fill("e2e-platform@test.local");
    await page.locator("#password").fill("E2ePass123!");
    await page.getByRole("button", { name: "Sign In" }).click();
    await page.waitForURL(/\/platform\/dashboard/);
    await page.goto("/platform/zeli");
    const panelAgain = page.getByTestId("zeli-availability");
    await expect(panelAgain.getByText("ZELI OFF")).toBeVisible();
    await panelAgain.locator("textarea").fill("E2E maintenance complete and verified");
    page.once("dialog", (dialog) => dialog.accept());
    await panelAgain.getByRole("button", { name: "Enable Zeli" }).click();
    await expect(panelAgain.getByText("ZELI ON")).toBeVisible();
  });
});
